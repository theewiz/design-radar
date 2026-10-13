import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scorePost,
  scorePosts,
  scoreSeniority,
  scoreHiringSignal,
  scoreRecruiter,
  scoreLocation,
  scoreDomain,
  buildScoringCorpus,
  matchDomains,
  isEligibleOpportunity,
  resolvePriority,
  SCORE_WEIGHTS,
  SENIORITY_TOP_TIER,
  SENIORITY_FOUNDING,
  SENIORITY_UNSCORED,
  RELEVANT_DOMAINS,
  DOMAIN_GROUPS,
  HIRING_TERMS,
  QUALIFICATION_METHODS,
  PRIORITY_LEVELS,
  LOCATION_CAP,
  MAX_SCORE,
  DEFAULT_MIN_RELEVANCE_SCORE,
} from '../src/ai/score.js';

/**
 * Builds a Phase 4 classification result with sensible defaults.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function classification(overrides = {}) {
  return {
    is_recruiting_post: true,
    is_product_design_role: true,
    job_title: 'Senior Product Designer',
    seniority: 'Senior',
    company_name: 'AcmePay',
    author_name: null,
    is_hiring_manager_or_recruiter: true,
    location: null,
    remote_status: 'Remote',
    application_url: null,
    confidence: 0.9,
    reason: 'test',
    ...overrides,
  };
}

describe('Phase 5 — Deterministic Relevance Scoring', () => {
  // ─── Scenario 1 ─────────────────────────────────────────────────────────────

  describe('Scenario 1 — high-quality Senior Product Designer, fintech, remote', () => {
    const candidate = {
      title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
      snippet:
        'AcmePay is hiring a Senior Product Designer for our Global Payments Infrastructure team. Fully remote across Europe and the UK.',
    };

    it('scores 95 and qualifies', () => {
      const result = scorePost(
        classification({
          job_title: 'Senior Product Designer',
          seniority: 'Senior',
          company_name: 'AcmePay',
          is_hiring_manager_or_recruiter: true,
          location: 'Europe and UK',
          remote_status: 'Remote',
        }),
        { candidate }
      );

      assert.equal(result.score, 95);
      assert.equal(result.rawScore, 95);
      assert.equal(result.eligible, true);
      assert.equal(result.status, 'qualified');
      assert.equal(result.priority, PRIORITY_LEVELS.HIGH);
    });

    it('awards each expected signal exactly once', () => {
      const result = scorePost(classification({ location: 'Europe and UK' }), { candidate });
      const bySignal = Object.fromEntries(
        result.breakdown.map((b) => [b.signal, b.points])
      );

      assert.equal(bySignal.seniority, 30);
      assert.equal(bySignal.hiring_language, 20);
      assert.equal(bySignal.recruiter_identified, 10);
      assert.equal(bySignal.location_arrangement, 25);
      assert.equal(bySignal.domain_match, 10);
    });

    it('caps the location subtotal at 25 rather than summing every region', () => {
      // Remote(15) + Global(15) + Europe(10) + UK(10) = 50 raw, capped to 25.
      const result = scorePost(
        classification({ location: 'Global — Europe, UK', remote_status: 'Remote' }),
        { candidate }
      );

      const location = result.breakdown.find((b) => b.signal === 'location_arrangement');
      assert.equal(location.points, LOCATION_CAP);
      assert.equal(location.capped, true);
      assert.equal(result.score, 95);
    });

    it('produces an explainable breakdown', () => {
      const result = scorePost(classification({ location: 'Europe and UK' }), { candidate });
      assert.ok(result.explain.some((line) => line.includes('seniority: +30 (Senior)')));
      assert.ok(result.explain.some((line) => line.includes('hiring_language: +20')));
      assert.ok(result.explain.some((line) => line.includes('domain_match: +10')));
    });
  });

  // ─── Scenario 2 ─────────────────────────────────────────────────────────────

  describe('Scenario 2 — Senior Product Designer with unknown location', () => {
    const candidate = {
      title: 'Northwind is hiring a Senior Product Designer',
      snippet: 'Northwind is hiring a Senior Product Designer to join our design team.',
    };

    it('reaches exactly the 60 threshold from seniority, hiring, and recruiter', () => {
      const result = scorePost(
        classification({
          job_title: 'Senior Product Designer',
          seniority: 'Senior',
          company_name: 'Northwind',
          location: null,
          remote_status: 'Unknown',
        }),
        { candidate }
      );

      assert.equal(result.score, 60);
      assert.equal(result.eligible, true, 'exactly at the threshold is high priority');
      assert.equal(result.priority, PRIORITY_LEVELS.HIGH);
      assert.equal(DEFAULT_MIN_RELEVANCE_SCORE, 60);
    });

    it('does not award location points for unknown geography', () => {
      const result = scorePost(
        classification({ location: null, remote_status: 'Unknown' }),
        { candidate }
      );

      const location = result.breakdown.find((b) => b.signal === 'location_arrangement');
      assert.equal(location.points, 0);
      assert.deepEqual(location.matched, []);
    });

    it('drops 10 points but stays eligible when the recruiter is unknown', () => {
      const withRecruiter = scorePost(classification({ remote_status: 'Unknown' }), { candidate });
      const withoutRecruiter = scorePost(
        classification({ is_hiring_manager_or_recruiter: null, remote_status: 'Unknown' }),
        { candidate }
      );

      assert.equal(withRecruiter.score, 60);
      assert.equal(withoutRecruiter.score, 50);
      // The score fell below the priority threshold, which changes the band and
      // nothing else: the post is still a recruiting Product Design opportunity.
      assert.equal(withoutRecruiter.eligible, true);
      assert.equal(withoutRecruiter.priority, PRIORITY_LEVELS.STANDARD);
    });

    it('sits exactly on the threshold: seniority + hiring + recruiter is enough', () => {
      // 30 + 20 + 10 = 60, with no geography and no domain signal at all.
      const result = scorePost(
        classification({
          location: null,
          remote_status: 'Unknown',
          company_name: 'Generic Corp',
          is_hiring_manager_or_recruiter: true,
        }),
        { candidate: { title: 'We are hiring a Senior Product Designer', snippet: 'Join our team.' } }
      );

      assert.equal(result.score, 60);
      assert.equal(result.eligible, true);
    });

    it('falls to standard priority once the recruiter signal is also absent', () => {
      const result = scorePost(
        classification({
          location: null,
          remote_status: 'Unknown',
          company_name: 'Generic Corp',
          is_hiring_manager_or_recruiter: null,
        }),
        { candidate: { title: 'We are hiring a Senior Product Designer', snippet: 'Join our team.' } }
      );

      assert.equal(result.score, 50);
      assert.equal(result.eligible, true);
      assert.equal(result.status, 'qualified');
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
    });
  });

  // ─── Scenario 3 ─────────────────────────────────────────────────────────────

  describe('Scenario 3 — Lead Product Designer in an unrelated industry', () => {
    it('qualifies on seniority and arrangement despite no domain match', () => {
      const candidate = {
        title: 'GourmetBistro on LinkedIn: We are hiring a Lead Product Designer',
        snippet:
          'GourmetBistro is hiring a Lead Product Designer to redesign our restaurant booking experience. Remote.',
      };

      const result = scorePost(
        classification({
          job_title: 'Lead Product Designer',
          seniority: 'Lead',
          company_name: 'GourmetBistro',
          location: null,
          remote_status: 'Remote',
        }),
        { candidate }
      );

      const domain = result.breakdown.find((b) => b.signal === 'domain_match');
      assert.equal(domain.points, 0, 'no relevant domain in an unrelated industry');
      assert.equal(result.score, 75); // 30 + 20 + 10 + 15
      assert.equal(result.eligible, true);
    });

    it('treats a food-company name as no domain signal', () => {
      const candidate = {
        title: 'We are hiring a Lead Product Designer',
        snippet: 'GourmetBistro is a restaurant reservations company. Remote.',
      };

      const result = scorePost(
        classification({ seniority: 'Lead', company_name: 'GourmetBistro', remote_status: 'Remote' }),
        { candidate }
      );

      assert.equal(result.breakdown.find((b) => b.signal === 'domain_match').points, 0);
    });
  });

  // ─── Scenario 4 ─────────────────────────────────────────────────────────────

  describe('Scenario 4 — Junior Product Designer', () => {
    const candidate = {
      title: 'StartupXYZ is hiring a Junior Product Designer',
      snippet:
        'StartupXYZ is hiring a Junior Product Designer for our fintech onboarding flows. Remote.',
    };

    it('fails the role gate outright, because the profile excludes junior seats', () => {
      const result = scorePost(
        classification({
          job_title: 'Junior Product Designer',
          seniority: 'Junior',
          company_name: 'StartupXYZ',
          remote_status: 'Remote',
        }),
        { candidate }
      );

      // No signal is even evaluated: a junior seat is out of scope (§16), not a
      // weak match to be delivered at low priority.
      assert.equal(result.eligible, false);
      assert.equal(result.score, 0);
      assert.equal(result.rawScore, 0);
      assert.equal(result.status, 'irrelevant');
      assert.equal(result.priority, null);
      assert.deepEqual(result.breakdown, []);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.NONE);
      assert.match(result.explain[0], /junior product design role/i);
    });

    it('records the exclusion rather than a low score', () => {
      const result = scorePost(
        classification({ seniority: 'Junior', job_title: 'Junior Product Designer' }),
        { candidate }
      );

      assert.equal(result.eligible, false);
      assert.equal(result.qualificationReason, null);
    });

    it('scores Mid and Unknown identically to Junior on the seniority signal', () => {
      // Mid and Unknown award no seniority points on their own. The profile role
      // policy (`resolveProfileSeniority`) is what lifts them, and it runs in the
      // orchestrator before scoring — so this module still scores them as 0.
      const base = { job_title: 'Product Designer', remote_status: 'Unknown' };

      for (const level of ['Mid', 'Unknown']) {
        const result = scorePost(
          classification({ ...base, seniority: level }),
          { candidate: { title: 'We are hiring a Product Designer', snippet: 'Join our team.' } }
        );
        assert.equal(
          result.breakdown.find((b) => b.signal === 'seniority').points,
          0,
          `${level} should award no seniority points`
        );
      }
    });

    it('scores an unlevelled product design title at the full seniority weight', () => {
      // After the profile policy resolves a flat "Product Designer" to Senior.
      const result = scorePost(
        classification({
          seniority: 'Senior',
          job_title: 'Product Designer',
          company_name: 'StartupXYZ',
          remote_status: 'Remote',
        }),
        { candidate }
      );

      // 30 seniority + 20 hiring + 10 recruiter + 15 remote + 10 domain = 85.
      assert.equal(result.score, 85);
      assert.equal(result.eligible, true);
      assert.equal(result.priority, PRIORITY_LEVELS.HIGH);
      assert.ok(SENIORITY_UNSCORED.includes('Junior'));
    });
  });

  // ─── Scenario 5 ─────────────────────────────────────────────────────────────

  describe('Scenario 5 — Graphic Designer', () => {
    const candidate = {
      title: 'PixelForge on LinkedIn: We are hiring a Graphic Designer',
      snippet:
        'PixelForge is hiring a Graphic Designer for brand assets and print collateral. On-site in Lagos.',
    };

    it('scores 0 via the role gate', () => {
      const result = scorePost(
        classification({
          is_product_design_role: false,
          job_title: 'Graphic Designer',
          seniority: null,
          company_name: 'PixelForge',
          location: 'Lagos',
          remote_status: 'On-site',
          is_hiring_manager_or_recruiter: true,
        }),
        { candidate }
      );

      assert.equal(result.score, 0);
      assert.equal(result.rawScore, 0);
      assert.equal(result.eligible, false);
      assert.equal(result.status, 'irrelevant');
      assert.equal(result.priority, null);
      assert.deepEqual(result.breakdown, []);
    });

    it('explains that the role gate caused the zero', () => {
      const result = scorePost(
        classification({ is_product_design_role: false, job_title: 'Graphic Designer' }),
        { candidate }
      );

      assert.match(result.explain[0], /role gate/);
      assert.match(result.explain[0], /not a product design role/);
    });

    it('scores 0 for a discussion post that is not recruiting', () => {
      const result = scorePost(
        classification({
          is_recruiting_post: false,
          is_product_design_role: false,
          seniority: 'Senior',
          remote_status: 'Remote',
        }),
        { candidate: { title: 'Design systems thoughts', snippet: 'No role here.' } }
      );

      assert.equal(result.score, 0);
      assert.match(result.explain[0], /not a recruiting post/);
    });

    it('scores 0 for a Senior design role that is not a recruiting post', () => {
      // is_product_design_role true, but the post is not advertising a vacancy.
      const result = scorePost(
        classification({
          is_recruiting_post: false,
          is_product_design_role: true,
          seniority: 'Senior',
          remote_status: 'Remote',
        }),
        { candidate: { title: 'Celebrating our design team', snippet: 'Proud of our designers.' } }
      );

      assert.equal(result.score, 0);
      assert.equal(result.eligible, false);
    });

    it('gates on strict true, so a missing flag is not treated as true', () => {
      const result = scorePost(
        classification({ is_recruiting_post: undefined, is_product_design_role: true }),
        { candidate }
      );

      assert.equal(result.eligible, false);
      assert.equal(result.score, 0);
    });
  });

  // ─── Scenario 6 ─────────────────────────────────────────────────────────────

  describe('Scenario 6 — Founding Designer at an AI startup', () => {
    const candidate = {
      title: 'AICorp is hiring a Founding Product Designer',
      snippet:
        'AICorp is hiring a Founding Product Designer to build 0 to 1 AI developer tools. Remote-first, work from anywhere.',
    };

    it('scores 93 and qualifies', () => {
      const result = scorePost(
        classification({
          job_title: 'Founding Product Designer',
          seniority: 'Founding',
          company_name: 'AICorp',
          is_hiring_manager_or_recruiter: true,
          location: 'Worldwide',
          remote_status: 'Remote',
        }),
        { candidate }
      );

      // 28 founding + 20 hiring + 10 recruiter + 25 location (capped) + 10 domain
      assert.equal(result.score, 93);
      assert.equal(result.eligible, true);
    });

    it('awards 28 for founding, not the 30 top-tier value', () => {
      const seniority = scoreSeniority('Founding');
      assert.equal(seniority.points, 28);
      assert.equal(seniority.points, SCORE_WEIGHTS.SENIORITY_FOUNDING);
      assert.ok(!SENIORITY_TOP_TIER.includes('Founding'));
    });

    it('scores founding 2 points below the top seniority tier on identical signals', () => {
      const founding = scorePost(
        classification({ seniority: 'Founding', job_title: 'Founding Product Designer' }),
        { candidate }
      );
      const senior = scorePost(
        classification({ seniority: 'Senior', job_title: 'Senior Product Designer' }),
        { candidate }
      );

      assert.equal(founding.score, senior.score - 2);
    });

    it('matches the AI domain on a developer-tools AI post', () => {
      const domain = scoreDomain('we build ai developer tools for agentic workflows');
      assert.equal(domain.points, 10);
      assert.ok(domain.matched);
    });
  });

  // ─── Seniority Signal ───────────────────────────────────────────────────────

  describe('Seniority Signal', () => {
    it('awards 30 to every top-tier value', () => {
      for (const level of SENIORITY_TOP_TIER) {
        assert.equal(scoreSeniority(level).points, 30, level);
      }
    });

    it('awards 28 to founding', () => {
      for (const level of SENIORITY_FOUNDING) {
        assert.equal(scoreSeniority(level).points, 28, level);
      }
    });

    it('awards 0 to unscored levels', () => {
      for (const level of SENIORITY_UNSCORED) {
        assert.equal(scoreSeniority(level).points, 0, level);
      }
    });

    it('awards 0 for null, undefined, or unrecognized seniority', () => {
      for (const level of [null, undefined, '', 'Grandmaster', 42, {}]) {
        assert.equal(scoreSeniority(level).points, 0, String(level));
      }
    });

    it('is case-insensitive', () => {
      assert.equal(scoreSeniority('principal').points, 30);
      assert.equal(scoreSeniority('FOUNDING').points, 28);
    });

    it('is non-cumulative across the whole call, never summed', () => {
      const result = scorePost(
        classification({ seniority: 'Head' }),
        { candidate: { title: 'Head of Product Designer', snippet: 'We are hiring. Founding experience preferred.' } }
      );

      const seniority = result.breakdown.find((b) => b.signal === 'seniority');
      assert.equal(seniority.points, 30);
    });
  });

  // ─── Hiring Signal ──────────────────────────────────────────────────────────

  describe('Explicit Hiring Signal', () => {
    it('awards 20 when a hiring term is present', () => {
      for (const term of HIRING_TERMS) {
        const result = scoreHiringSignal(term);
        assert.equal(result.points, 20, term);
      }
    });

    it('awards 0 with no hiring term', () => {
      assert.equal(scoreHiringSignal('a post about design systems and tokens').points, 0);
    });

    it('scores independently of the is_recruiting_post flag', () => {
      // The AI says recruiting, but the verb did not survive truncation.
      const result = scorePost(
        classification({ seniority: 'Senior', remote_status: 'Remote', is_hiring_manager_or_recruiter: true }),
        { candidate: { title: 'Senior Product Designer — Acme', snippet: 'New opening on our team.' } }
      );

      assert.equal(result.eligible, true);
      assert.equal(result.breakdown.find((b) => b.signal === 'hiring_language').points, 0);
    });
  });

  // ─── Recruiter Signal ───────────────────────────────────────────────────────

  describe('Recruiter Identification Signal', () => {
    it('awards 10 only for an explicit true', () => {
      assert.equal(scoreRecruiter(true).points, 10);
    });

    it('awards 0 for null, false, or missing values', () => {
      for (const value of [null, false, undefined, 'true', 1]) {
        assert.equal(scoreRecruiter(value).points, 0, String(value));
      }
    });
  });

  // ─── Location Signal ────────────────────────────────────────────────────────

  describe('Location / Arrangement Signal', () => {
    it('awards 15 for remote', () => {
      const result = scoreLocation({ remote_status: 'Remote', location: null });
      assert.equal(result.points, 15);
    });

    it('awards nothing for hybrid or on-site', () => {
      assert.equal(scoreLocation({ remote_status: 'Hybrid' }).points, 0);
      assert.equal(scoreLocation({ remote_status: 'On-site' }).points, 0);
      assert.equal(scoreLocation({ remote_status: 'Unknown' }).points, 0);
    });

    it('awards regional points from the location field', () => {
      assert.equal(scoreLocation({ location: 'Europe' }).points, 10);
      assert.equal(scoreLocation({ location: 'UK' }).points, 10);
      assert.equal(scoreLocation({ location: 'US' }).points, 10);
      assert.equal(scoreLocation({ location: 'Worldwide' }).points, 15);
    });

    it('recognizes aliases without adding points', () => {
      assert.equal(scoreLocation({ location: 'EMEA' }).points, 10);
      assert.equal(scoreLocation({ location: 'United Kingdom' }).points, 10);
      assert.equal(scoreLocation({ location: 'United States' }).points, 10);
    });

    it('recognizes every explicit geographic variant', () => {
      const cases = [
        ['United States', SCORE_WEIGHTS.US],
        ['USA', SCORE_WEIGHTS.US],
        ['U.S.', SCORE_WEIGHTS.US],
        ['US', SCORE_WEIGHTS.US],
        ['New York, US', SCORE_WEIGHTS.US],
        ['United Kingdom', SCORE_WEIGHTS.UK],
        ['UK', SCORE_WEIGHTS.UK],
        ['London, UK', SCORE_WEIGHTS.UK],
        ['Europe', SCORE_WEIGHTS.EUROPE],
        ['European', SCORE_WEIGHTS.EUROPE],
        ['EMEA', SCORE_WEIGHTS.EUROPE],
        ['Worldwide', SCORE_WEIGHTS.GLOBAL],
        ['Global', SCORE_WEIGHTS.GLOBAL],
        ['Anywhere', SCORE_WEIGHTS.GLOBAL],
      ];

      for (const [location, expected] of cases) {
        assert.equal(scoreLocation({ location }).points, expected, location);
      }
    });

    it('reads geography only from the classified job location, never from post text', () => {
      // A company address or a post that merely mentions a country is not
      // evidence that the role is open there, so the corpus is never consulted.
      const result = scorePost(
        classification({ location: null, remote_status: 'On-site' }),
        {
          candidate: {
            title: 'Senior Product Designer at Acme',
            snippet: 'Acme is headquartered in the United States and is global, with teams worldwide.',
          },
        }
      );

      const location = result.breakdown.find((b) => b.signal === 'location_arrangement');
      assert.equal(location.points, 0);
    });

    it('caps the subtotal at 25', () => {
      const result = scoreLocation({
        remote_status: 'Remote',
        location: 'Worldwide, Europe, UK and US',
      });
      assert.equal(result.points, LOCATION_CAP);
      assert.equal(result.capped, true);
    });

    it('awards 0 when both location and remote status are absent', () => {
      assert.equal(scoreLocation({}).points, 0);
      assert.equal(scoreLocation({ location: null, remote_status: null }).points, 0);
    });
  });

  // ─── Word Boundary Safety ───────────────────────────────────────────────────

  describe('Word Boundary Matching', () => {
    it('does not match "AI" inside ordinary words', () => {
      for (const text of [
        'he said the chair was in place',
        'this is an amazing product',
        'again we tried',
        'the campaign email landed',
      ]) {
        assert.equal(scoreDomain(text).points, 0, `"${text}" should not match the AI domain`);
      }
    });

    it('does not match "US" inside ordinary words', () => {
      for (const location of ['Industry', 'Because', 'Focus', 'Campus', 'Trust']) {
        assert.equal(scoreLocation({ location }).points, 0, `"${location}" should not match US`);
      }
    });

    it('does not match "UK" inside ordinary words', () => {
      assert.equal(scoreLocation({ location: 'Fukuoka' }).points, 0);
    });

    it('still matches AI when used as a standalone word', () => {
      for (const text of ['AI company', 'we build ai tooling', 'role at AI Lab']) {
        assert.equal(scoreDomain(text).points, 10, `"${text}" should match`);
      }
    });

    it('handles multi-word domains on word boundaries', () => {
      assert.equal(scoreDomain('we build financial infrastructure tools').points, 10);
      assert.equal(scoreDomain('digital assets custody').points, 10);
      assert.equal(scoreDomain('design tools for developers').points, 10);
    });

    it('is case-insensitive', () => {
      assert.equal(scoreDomain('FINTECH payments').points, 10);
      assert.equal(scoreLocation({ location: 'EUROPE' }).points, 10);
    });
  });

  // ─── Domain Signal ──────────────────────────────────────────────────────────

  describe('Relevant Domain Signal', () => {
    it('awards 10 for each canonical domain', () => {
      for (const domain of RELEVANT_DOMAINS) {
        assert.equal(scoreDomain(`we are a ${domain} company`).points, 10, domain);
      }
    });

    it('is capped at 10 even with many domain matches', () => {
      const result = scoreDomain('fintech payments blockchain web3 crypto compliance ai saas');
      assert.equal(result.points, 10);
    });

    it('awards 0 for unrelated industries', () => {
      assert.equal(scoreDomain('we sell kitchen equipment and garden furniture').points, 0);
    });

    it('scans the company name as well as the post text', () => {
      const result = scorePost(
        classification({ seniority: 'Senior', company_name: 'Fintech Labs', remote_status: 'Remote' }),
        { candidate: { title: 'Hiring a Senior Product Designer', snippet: 'Great opportunity.' } }
      );

      assert.equal(result.breakdown.find((b) => b.signal === 'domain_match').points, 10);
    });

    it('does not match a domain name glued inside a longer identifier', () => {
      // "ChAIRcraft" must not satisfy the AI domain via the "ai" substring.
      const result = scoreDomain('we build chAIRcraft models');
      assert.equal(result.points, 0);
    });

    it('tolerates null fields when building the corpus', () => {
      const corpus = buildScoringCorpus(classification({ company_name: null, job_title: null }), {
        title: null,
        snippet: 'We are hiring a fintech senior product designer',
      });

      assert.match(corpus, /fintech/);
      assert.equal(buildScoringCorpus(null, {}), '');
      assert.equal(buildScoringCorpus({}, {}), '');
    });
  });

  // ─── Clamping and Thresholds ────────────────────────────────────────────────

  describe('Score Clamping and Thresholds', () => {
    it('never exceeds 100 even when every signal fires', () => {
      const result = scorePost(
        classification({
          seniority: 'Head',
          is_hiring_manager_or_recruiter: true,
          location: 'Worldwide, Europe, UK, US',
          remote_status: 'Remote',
        }),
        {
          candidate: {
            title: 'Head of Product Designer',
            snippet: 'We are hiring. Fintech payments compliance AI web3 blockchain enterprise software.',
          },
        }
      );

      assert.ok(result.score <= MAX_SCORE);
      assert.equal(result.score, 95);
    });

    it('never returns a negative score', () => {
      const result = scorePost(classification({ seniority: 'Junior', remote_status: 'On-site' }), {
        candidate: { title: 'Junior Product Designer', snippet: 'nothing relevant' },
      });

      assert.ok(result.score >= 0);
    });

    it('honours a custom priority threshold without changing the score', () => {
      const classification_ = classification({ location: 'UK', remote_status: 'On-site' });
      const candidate = {
        title: 'We are hiring a Senior Product Designer',
        snippet: 'Fintech company, UK remote.',
      };

      const relaxed = scorePost(classification_, { candidate, minScore: 10 });
      const strict = scorePost(classification_, { candidate, minScore: 99 });

      // The threshold moves the label, never the eligibility decision.
      assert.equal(relaxed.priority, PRIORITY_LEVELS.HIGH);
      assert.equal(strict.priority, PRIORITY_LEVELS.STANDARD);
      assert.equal(relaxed.eligible, true);
      assert.equal(strict.eligible, true);
      assert.equal(relaxed.score, strict.score);
    });

    it('cannot be widened by the threshold to admit a non-product-design post', () => {
      // A threshold below zero would label every scored post high priority if it
      // were a gate; it must not resurrect a gate failure either.
      const result = scorePost(
        classification({
          seniority: 'Senior',
          job_title: 'Senior Product Manager',
          is_product_design_role: false,
          remote_status: 'On-site',
        }),
        { candidate: { title: 'Senior Product Manager wanted', snippet: 'Fintech, UK.' }, minScore: 0 }
      );

      assert.equal(result.eligible, false);
      assert.equal(result.score, 0);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.NONE);
      assert.equal(result.priority, null);
    });

    it('is deterministic: identical input yields an identical score', () => {
      const classification_ = classification({ location: 'Europe', remote_status: 'Remote' });
      const candidate = {
        title: 'We are hiring a Senior Product Designer',
        snippet: 'Fintech, remote Europe.',
      };

      const first = scorePost(classification_, { candidate });
      const second = scorePost(classification_, { candidate });

      assert.deepEqual(first, second);
    });

    it('does not read any score from the classification object', () => {
      // A model-supplied score must have no effect on the computed value.
      const clean = scorePost(classification(), {
        candidate: { title: 'We are hiring a Senior Product Designer', snippet: 'Fintech remote.' },
      });
      const tampered = scorePost(classification({ score: 100, relevance_score: 100 }), {
        candidate: { title: 'We are hiring a Senior Product Designer', snippet: 'Fintech remote.' },
      });

      assert.equal(clean.score, tampered.score);
    });

    it('throws a TypeError for a missing classification', () => {
      assert.throws(() => scorePost(null), TypeError);
      assert.throws(() => scorePost(undefined), /requires a classification/);
    });
  });

  // ─── Batch Scoring ──────────────────────────────────────────────────────────

  describe('Batch Scoring', () => {
    it('scores every entry and summarizes the distribution', () => {
      const batch = scorePosts([
        {
          // 30 seniority + 20 hiring + 10 recruiter + 25 location + 10 domain = 95
          classification: classification({ location: 'Europe', remote_status: 'Remote' }),
          candidate: { title: 'We are hiring a Senior Product Designer', snippet: 'Fintech remote Europe.' },
        },
        {
          // Role gate: 0 — junior seats are excluded by the profile (§16)
          classification: classification({ seniority: 'Junior', remote_status: 'Remote' }),
          candidate: { title: 'Hiring a Junior Product Designer', snippet: 'Fintech remote.' },
        },
        {
          // Role gate: 0
          classification: classification({ is_product_design_role: false, job_title: 'Graphic Designer' }),
          candidate: { title: 'Hiring a Graphic Designer', snippet: 'Brand assets.' },
        },
      ]);

      assert.equal(batch.results.length, 3);
      assert.deepEqual(batch.results.map((r) => r.score), [95, 0, 0]);
      assert.equal(batch.eligible, 1);
      assert.equal(batch.ineligible, 2, 'the junior role is out of scope, not a weak match');
      assert.equal(batch.highPriority, 1);
      assert.equal(batch.standardPriority, 0);
      assert.equal(batch.scoreDistribution['80-100'], 1);
      assert.equal(batch.scoreDistribution['40-59'], 0);
      assert.equal(batch.scoreDistribution['0-19'], 2);
    });

    it('returns an empty summary for no entries', () => {
      const batch = scorePosts([]);
      assert.deepEqual(batch.results, []);
      assert.equal(batch.eligible, 0);
      assert.equal(batch.ineligible, 0);
    });

    it('tolerates a non-array input', () => {
      const batch = scorePosts(null);
      assert.deepEqual(batch.results, []);
    });
  });

  // ─── Domain Synonyms (§15) ───────────────────────────────────────────────────

  describe('Domain Synonym Matching', () => {
    it('recognizes vocabulary variants a candidate would actually write', () => {
      const cases = [
        ['we build machine learning models', 'ai'],
        ['our team works on artificial intelligence', 'ai'],
        ['generative ai tooling for designers', 'ai'],
        ['agentic ai platform', 'ai'],
        ['banking infrastructure team', 'financialInfrastructure'],
        ['financial rails and settlement', 'financialInfrastructure'],
        ['payment rails for merchants', 'payments'],
        ['cross-border payments product', 'payments'],
        ['we run a payment platform', 'payments'],
        ['developer platform experience', 'developerTools'],
        ['developer infrastructure team', 'developerTools'],
        ['design tokens and component library', 'designSystems'],
        ['maintaining our design system', 'designSystems'],
        ['tokenization of digital assets', 'web3'],
        ['virtual assets custody', 'web3'],
        ['cryptocurrency exchange product', 'web3'],
        ['regulatory software for banks', 'regtech'],
        ['financial compliance tooling', 'compliance'],
        ['data platform for analysts', 'dataHeavyProducts'],
        ['data-intensive dashboards', 'dataHeavyProducts'],
        ['saas billing product', 'b2bSaaS'],
        ['enterprise platform team', 'enterpriseSoftware'],
      ];

      for (const [text, group] of cases) {
        const match = matchDomains(text);
        assert.ok(match, `expected a domain match in: ${text}`);
        assert.equal(match.group, group, text);
        assert.equal(scoreDomain(text).points, SCORE_WEIGHTS.DOMAIN_MATCH, text);
      }
    });

    it('reports the most specific phrase when a shorter one also matches', () => {
      // "banking infrastructure" contains "banking", but the longer phrase is
      // the one the post is actually about.
      const match = matchDomains('joining our banking infrastructure team');
      assert.equal(match.group, 'financialInfrastructure');
      assert.equal(match.term, 'banking infrastructure');
    });

    it('still awards a flat 10 however many groups match', () => {
      const noisy = 'ai fintech payments blockchain web3 compliance saas regtech sdk design tokens';
      assert.equal(scoreDomain(noisy).points, SCORE_WEIGHTS.DOMAIN_MATCH);
    });

    it('does not award the signal for generic nouns on their own', () => {
      // These words appear in almost every product post, so as standalone terms
      // they would disable the signal entirely.
      for (const generic of [
        'we build software',
        'a technology company',
        'our product team',
        'an innovative platform',
        'digital transformation',
        'we ship software products',
      ]) {
        assert.equal(scoreDomain(generic).points, 0, generic);
      }
    });

    it('keeps every canonical §15 domain in a group', () => {
      const allTerms = Object.values(DOMAIN_GROUPS).flat();
      for (const domain of RELEVANT_DOMAINS) {
        assert.ok(allTerms.includes(domain), `${domain} must remain in DOMAIN_GROUPS`);
      }
    });

    it('reports no match for an empty or non-string corpus', () => {
      assert.equal(matchDomains(''), null);
      assert.equal(matchDomains(undefined), null);
      assert.equal(matchDomains(null), null);
    });
  });

  // ─── Eligibility Gate (§14 rule 1) ───────────────────────────────────────────

  describe('Eligibility Gate', () => {
    const eligible = (overrides = {}) =>
      isEligibleOpportunity(classification({ ...overrides }));

    it('accepts a recruiting product design post at every non-junior seniority level', () => {
      for (const level of [...SENIORITY_TOP_TIER, ...SENIORITY_FOUNDING, 'Mid', 'Unknown']) {
        assert.equal(eligible({ seniority: level }), true, level);
      }
    });

    it('excludes a junior product design post, which is out of scope rather than weak', () => {
      assert.equal(eligible({ seniority: 'Junior', job_title: 'Junior Product Designer' }), false);
    });

    it('does not read geography or remote status', () => {
      for (const overrides of [
        { seniority: 'Mid', remote_status: 'On-site', location: 'Lagos' },
        { seniority: null, remote_status: null, location: null },
      ]) {
        assert.equal(eligible(overrides), true, JSON.stringify(overrides));
      }
    });

    it('rejects a post that is not recruiting', () => {
      assert.equal(eligible({ is_recruiting_post: false }), false);
      assert.equal(eligible({ is_recruiting_post: null }), false);
    });

    it('rejects a post the classifier marked as not a product design role', () => {
      assert.equal(
        eligible({ is_product_design_role: false, job_title: 'Senior Product Manager' }),
        false
      );
      // The classifier's flag is authoritative; a hand-edited title cannot
      // widen the gate.
      assert.equal(eligible({ job_title: 'Senior Product Manager' }), true);
    });

    it('requires both flags to be exactly true', () => {
      for (const overrides of [
        { is_product_design_role: null },
        { is_recruiting_post: null },
        { is_recruiting_post: 'true', is_product_design_role: true },
        { is_recruiting_post: true, is_product_design_role: 1 },
        { is_recruiting_post: true, is_product_design_role: 'true' },
      ]) {
        assert.equal(eligible(overrides), false, JSON.stringify(overrides));
      }
    });

    it('tolerates missing or malformed input', () => {
      assert.equal(isEligibleOpportunity(null), false);
      assert.equal(isEligibleOpportunity(undefined), false);
      assert.equal(isEligibleOpportunity({}), false);
      assert.equal(isEligibleOpportunity('recruiting product design'), false);
    });
  });

  // ─── Priority Bands (§14) ────────────────────────────────────────────────────

  describe('Priority Bands', () => {
    it('places a score at the threshold in the high band', () => {
      assert.equal(resolvePriority(60, 60), PRIORITY_LEVELS.HIGH);
      assert.equal(resolvePriority(61, 60), PRIORITY_LEVELS.HIGH);
    });

    it('places a score one point below the threshold in the standard band', () => {
      assert.equal(resolvePriority(59, 60), PRIORITY_LEVELS.STANDARD);
      assert.equal(resolvePriority(0, 60), PRIORITY_LEVELS.STANDARD);
    });

    it('honours a custom threshold', () => {
      assert.equal(resolvePriority(45, 10), PRIORITY_LEVELS.HIGH);
      assert.equal(resolvePriority(99, 99), PRIORITY_LEVELS.HIGH);
    });
  });

  describe('Eligibility and Priority', () => {
    const thinSnippet = { title: 'Senior Product Designer', snippet: 'Remote.' };

    it('keeps a Senior + Remote post below the threshold without touching the score', () => {
      // 30 seniority + 15 remote = 45. Eligibility already passed, so the post is
      // qualified; the score stays at what the signals actually earned and the
      // band reports the weak match.
      const result = scorePost(
        classification({
          seniority: 'Senior',
          remote_status: 'Remote',
          is_hiring_manager_or_recruiter: false,
          location: null,
        }),
        { candidate: thinSnippet }
      );

      assert.equal(result.score, 45);
      assert.equal(result.eligible, true);
      assert.equal(result.status, 'qualified');
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY);
      assert.match(result.qualificationReason, /standard priority: score 45 < 60/);
    });

    it('makes the qualification visible in the explain array', () => {
      const result = scorePost(
        classification({ seniority: 'Lead', remote_status: 'Remote', is_hiring_manager_or_recruiter: false }),
        { candidate: thinSnippet }
      );

      const line = result.explain.find((l) => l.startsWith(QUALIFICATION_METHODS.ELIGIBILITY));
      assert.ok(line, 'qualification must appear in score_explain');
      assert.match(line, /qualified/);
      assert.equal(result.score, 45);
    });

    it('qualifies every non-junior seniority level through the gate', () => {
      for (const level of [...SENIORITY_TOP_TIER, ...SENIORITY_FOUNDING, 'Mid', 'Unknown']) {
        const result = scorePost(
          classification({
            seniority: level,
            remote_status: 'Remote',
            is_hiring_manager_or_recruiter: false,
            location: null,
          }),
          { candidate: thinSnippet }
        );

        assert.equal(result.eligible, true, level);
        assert.equal(result.status, 'qualified', level);
        assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY, level);
      }
    });

    it('keeps a junior post out of the gate and records the exclusion', () => {
      const result = scorePost(
        classification({
          seniority: 'Junior',
          job_title: 'Junior Product Designer',
          remote_status: 'Remote',
          is_hiring_manager_or_recruiter: false,
          location: null,
        }),
        { candidate: thinSnippet }
      );

      assert.equal(result.eligible, false);
      assert.equal(result.status, 'irrelevant');
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.NONE);
      assert.match(result.explain[0], /junior/i);
    });

    it('reports a strong post as high priority', () => {
      const result = scorePost(
        classification({ seniority: 'Senior', remote_status: 'Remote', location: 'Europe' }),
        {
          candidate: {
            title: 'We are hiring a Senior Product Designer',
            snippet: 'Fintech company, remote across Europe.',
          },
        }
      );

      // 30 seniority + 20 hiring + 10 recruiter + 25 location + 10 domain = 95.
      assert.equal(result.score, 95);
      assert.equal(result.eligible, true);
      assert.equal(result.priority, PRIORITY_LEVELS.HIGH);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY);
      assert.match(result.qualificationReason, /high priority: score 95 >= 60/);
    });

    it('qualifies a Senior post with no remote signal', () => {
      const result = scorePost(
        classification({
          seniority: 'Senior',
          remote_status: 'Unknown',
          location: null,
          is_hiring_manager_or_recruiter: false,
        }),
        { candidate: { title: 'Senior Product Designer', snippet: 'We are hiring.' } }
      );

      // 50 is below the threshold, which is now only a label.
      assert.equal(result.score, 50);
      assert.equal(result.eligible, true);
      assert.equal(result.status, 'qualified');
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY);
    });

    it('never widens the gate for a non-recruiting or non-design post', () => {
      const notRecruiting = scorePost(
        classification({
          seniority: 'Senior',
          remote_status: 'Remote',
          is_recruiting_post: false,
          is_hiring_manager_or_recruiter: false,
        }),
        { candidate: thinSnippet }
      );
      const notDesign = scorePost(
        classification({
          seniority: 'Senior',
          remote_status: 'Remote',
          job_title: 'Senior Product Manager',
          is_product_design_role: false,
          is_hiring_manager_or_recruiter: false,
        }),
        { candidate: thinSnippet }
      );

      for (const result of [notRecruiting, notDesign]) {
        assert.equal(result.score, 0);
        assert.equal(result.eligible, false);
        assert.equal(result.priority, null);
        assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.NONE);
      }
    });

    it('keeps a thin Mid post as a low-priority opportunity', () => {
      const result = scorePost(
        classification({
          seniority: 'Mid',
          job_title: 'Product Designer',
          remote_status: 'Remote',
          is_hiring_manager_or_recruiter: false,
          location: null,
        }),
        { candidate: thinSnippet }
      );

      // 0 seniority + 15 remote = 15. That is the weakest honest score available,
      // and the post is still a real opening.
      assert.equal(result.score, 15);
      assert.equal(result.eligible, true);
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
    });

    it('keeps the default threshold at 60', () => {
      assert.equal(DEFAULT_MIN_RELEVANCE_SCORE, 60);

      const result = scorePost(
        classification({
          seniority: 'Senior',
          remote_status: 'Remote',
          is_hiring_manager_or_recruiter: false,
          location: null,
        }),
        { candidate: thinSnippet }
      );
      assert.equal(result.threshold, 60);
      assert.equal(result.eligible, true);
    });

    it('returns the same shape on every path', () => {
      const gateFailure = scorePost(classification({ is_recruiting_post: false }));
      const thinMatch = scorePost(
        classification({ remote_status: 'Remote', is_hiring_manager_or_recruiter: false })
      );
      const strongMatch = scorePost(classification({ location: 'Europe' }));

      for (const result of [gateFailure, thinMatch, strongMatch]) {
        for (const key of [
          'score',
          'rawScore',
          'eligible',
          'status',
          'threshold',
          'priority',
          'qualificationMethod',
          'qualificationReason',
          'breakdown',
          'explain',
        ]) {
          assert.ok(key in result, `missing ${key}`);
        }
      }
    });

    it('counts eligible posts and priority bands in a batch', () => {
      const batch = scorePosts([
        {
          classification: classification({
            seniority: 'Senior',
            remote_status: 'Remote',
            is_hiring_manager_or_recruiter: false,
            location: null,
          }),
          candidate: thinSnippet,
        },
        {
          classification: classification({
            seniority: 'Junior',
            job_title: 'Junior Product Designer',
            remote_status: 'Remote',
            is_hiring_manager_or_recruiter: false,
            location: null,
          }),
          candidate: thinSnippet,
        },
        {
          classification: classification({
            is_product_design_role: false,
            job_title: 'Graphic Designer',
          }),
          candidate: thinSnippet,
        },
      ]);

      assert.deepEqual(batch.results.map((r) => r.score), [45, 0, 0]);
      assert.equal(batch.eligible, 1);
      assert.equal(batch.ineligible, 2);
      assert.equal(batch.highPriority, 0);
      assert.equal(batch.standardPriority, 1);
    });
  });

  // ─── Worked Examples (§18) ───────────────────────────────────────────────────

  describe('Qualification Examples', () => {
    /**
     * Scores a post described only by its title and snippet, so each example
     * reads like the LinkedIn text that produced it.
     *
     * @param {string} title
     * @param {string} snippet
     * @param {object} overrides Classification overrides.
     * @param {object} [options] scorePost options.
     */
    function evaluate(title, snippet, overrides = {}, options = {}) {
      return scorePost(classification({ location: null, is_hiring_manager_or_recruiter: false, ...overrides }), {
        candidate: { title, snippet },
        ...options,
      });
    }

    it('Example A — Senior + hiring, no remote signal, qualifies as standard priority at 50', () => {
      const result = evaluate('Senior Product Designer', 'We are hiring.', { remote_status: 'Unknown' });

      assert.equal(result.score, 50);
      assert.equal(result.eligible, true);
      assert.equal(result.status, 'qualified');
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
    });

    it('Example B — Senior + Remote qualifies and stores 45', () => {
      const result = evaluate('Senior Product Designer', 'Remote', { seniority: 'Senior', remote_status: 'Remote' });

      assert.equal(result.score, 45);
      assert.equal(result.eligible, true);
      assert.equal(result.status, 'qualified');
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY);
    });

    it('Example C — Senior + Remote + hiring reaches high priority at 65', () => {
      const result = evaluate('Senior Product Designer', "Remote. We're hiring.", {
        seniority: 'Senior',
        remote_status: 'Remote',
      });

      assert.equal(result.score, 65);
      assert.equal(result.eligible, true);
      assert.equal(result.priority, PRIORITY_LEVELS.HIGH);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY);
    });

    it('Example D — Senior + payments with no remote signal qualifies at 40', () => {
      const result = evaluate('Senior Product Designer', 'Payments company', {
        seniority: 'Senior',
        remote_status: 'Unknown',
      });

      assert.equal(result.score, 40);
      assert.equal(result.eligible, true);
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
    });

    it('Example E — Senior + Remote + payments qualifies at 55', () => {
      const result = evaluate('Senior Product Designer', 'Remote. Payments.', {
        seniority: 'Senior',
        remote_status: 'Remote',
      });

      assert.equal(result.score, 55);
      assert.equal(result.eligible, true);
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
    });

    it('Example F — Senior + hiring + banking infrastructure reaches high priority at 60', () => {
      const result = evaluate(
        'Senior Product Designer',
        "Looking for a designer to join our banking infrastructure team. We're hiring.",
        { seniority: 'Senior', remote_status: 'On-site' }
      );

      assert.equal(result.score, 60);
      assert.equal(result.eligible, true);
      assert.equal(result.priority, PRIORITY_LEVELS.HIGH);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY);
    });

    it('Example G — Junior + Remote + hiring is excluded by the role gate', () => {
      const result = evaluate('Junior Product Designer', "Remote. We're hiring.", {
        seniority: 'Junior',
        job_title: 'Junior Product Designer',
        remote_status: 'Remote',
      });

      // Junior is out of scope (§16), so no signal is evaluated at all. Firing
      // every other signal cannot bring it back: the gate, not the score, is the
      // reason, and it holds however strong the rest of the post looks.
      assert.equal(result.score, 0);
      assert.equal(result.eligible, false);
      assert.equal(result.status, 'irrelevant');
      assert.equal(result.priority, null);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.NONE);

      const strong = evaluate(
        'Junior Product Designer',
        "Remote. We're hiring for our fintech team in Europe.",
        {
          seniority: 'Junior',
          job_title: 'Junior Product Designer',
          remote_status: 'Remote',
          is_hiring_manager_or_recruiter: true,
          location: 'Europe',
        }
      );
      assert.equal(strong.score, 0);
      assert.equal(strong.eligible, false);
    });

    it('Example H — Senior Product Manager is stopped by the role gate', () => {
      const result = evaluate('Senior Product Manager', "Remote. We're hiring.", {
        seniority: 'Senior',
        job_title: 'Senior Product Manager',
        remote_status: 'Remote',
        is_product_design_role: false,
      });

      assert.equal(result.score, 0);
      assert.equal(result.eligible, false);
      assert.equal(result.priority, null);
      assert.equal(result.status, 'irrelevant');
    });
  });

  // ─── Movement Regression (§20) ───────────────────────────────────────────────

  describe('Movement Regression', () => {
    const movement = {
      title: 'Movement is hiring a Senior Product Designer',
      snippet: 'Looking for a designer to join our team.',
    };

    it('keeps the 50-point post, as standard priority rather than irrelevant', () => {
      // The post that used to score 50 and be stored as irrelevant is now
      // retained. The score is unchanged, so nothing downstream that reads the
      // number has to be reconciled — only its effect on status changed.
      const result = scorePost(
        classification({
          seniority: 'Senior',
          remote_status: 'Unknown',
          location: null,
          is_hiring_manager_or_recruiter: false,
        }),
        { candidate: movement }
      );

      assert.equal(result.score, 50);
      assert.equal(result.eligible, true);
      assert.equal(result.status, 'qualified');
      assert.equal(result.priority, PRIORITY_LEVELS.STANDARD);
      assert.equal(result.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY);
      assert.match(result.qualificationReason, /score 50 < 60/);
    });

    it('promotes the same post to high priority once Remote is reported', () => {
      const withRemote = scorePost(
        classification({
          seniority: 'Senior',
          remote_status: 'Remote',
          location: null,
          is_hiring_manager_or_recruiter: false,
        }),
        { candidate: movement }
      );

      // 30 seniority + 20 hiring + 15 remote = 65.
      assert.equal(withRemote.score, 65);
      assert.equal(withRemote.status, 'qualified');
      assert.equal(withRemote.priority, PRIORITY_LEVELS.HIGH);

      // With the truncated snippet — no hiring verb surviving — the same post
      // falls to 45 and is still qualified, as standard priority.
      const truncated = scorePost(
        classification({
          seniority: 'Senior',
          remote_status: 'Remote',
          location: null,
          is_hiring_manager_or_recruiter: false,
        }),
        { candidate: { title: 'Senior Product Designer', snippet: 'Remote.' } }
      );

      assert.equal(truncated.score, 45);
      assert.equal(truncated.status, 'qualified');
      assert.equal(truncated.priority, PRIORITY_LEVELS.STANDARD);
      assert.equal(truncated.qualificationMethod, QUALIFICATION_METHODS.ELIGIBILITY);
    });
  });
});
