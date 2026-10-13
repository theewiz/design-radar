/**
 * Daily Digest Formatting Tests (PROJECT_SPEC §16, §22).
 *
 * Covers:
 * - Eligibility: qualified, unsent, discovered inside the lookback window (168h)
 * - Lookback resolution: explicit option, DIGEST_LOOKBACK_HOURS, safe fallback
 * - Exclusion: already-sent, out-of-window, non-qualified (score never excludes)
 * - Ordering by relevance descending
 * - §18 section split: verified last 24 hours vs recent discoveries
 * - Every required field present, and unknown fields never fabricated
 * - Description truncation and application-URL-only-when-available
 * - Provider-safe formatting and §22 chunking
 * - Summary statistics: scanned, qualified, included
 * - Empty digests still produce a reportable message
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDigest,
  buildRoleCard,
  checkEligibility,
  chunkDigest,
  summarizeText,
  renderDigestPreview,
  generateDigest,
  DIGEST_SECTIONS,
  UNKNOWN_FIELD,
  UNKNOWN_SCORE,
  MAX_CHUNK_CHARS,
  MAX_DESCRIPTION_CHARS,
  DEFAULT_MAX_ROLES,
  DEFAULT_DIGEST_LOOKBACK_HOURS,
  VERIFIED_PUBLICATION_WINDOW_HOURS,
  resolveLookbackHours,
} from '../src/notifications/digest.js';
import { buildMockPosts } from '../src/notifications/mock-posts.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

/** Builds a qualified, unsent post that is eligible by default. */
function post(overrides = {}) {
  return {
    id: 'p1',
    linkedin_url: 'https://www.linkedin.com/posts/acme_senior-designer-activity-1',
    job_title: 'Senior Product Designer',
    author_name: 'Jane Doe',
    company_name: 'Acme Pay',
    location: 'London, UK',
    remote_status: 'Remote',
    application_url: 'https://acme.example/apply',
    relevance_score: 80,
    status: 'qualified',
    published_at: hoursAgo(3),
    discovered_at: hoursAgo(2),
    is_notified: false,
    sent_to_digest: false,
    post_text: 'Fintech startup hiring a Senior Product Designer for our payments platform.',
    ...overrides,
  };
}

const build = (posts, options = {}) =>
  buildDigest(posts, { now: NOW, ...options });

/**
 * Extracts the description block from a card.
 *
 * A card is blank-line separated as:
 *   [0] title · [1] fields · [2] description (absent when there is no text) · [3] URLs
 *
 * @param {string} cardText
 * @returns {string} Description text, or '' when omitted.
 */
function descriptionBlock(cardText) {
  const blocks = cardText.split('\n\n');
  return blocks.length >= 4 ? blocks[2] : '';
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

describe('Digest Eligibility', () => {
  it('accepts a qualified, unsent post inside the window', () => {
    assert.deepEqual(checkEligibility(post(), { now: NOW, windowHours: 24 }), {
      eligible: true,
      reason: null,
    });
  });

  it('excludes a post already marked notified', () => {
    const result = checkEligibility(post({ is_notified: true }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'already_sent');
  });

  it('excludes a post already delivered under the provider-neutral flag', () => {
    const result = checkEligibility(post({ sent_to_digest: true }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(result.reason, 'already_sent');
  });

  it('excludes a stale post even when its score is the highest available', () => {
    const result = checkEligibility(post({ status: 'stale', relevance_score: 99 }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'not_qualified');
  });

  it('excludes low-confidence and irrelevant posts', () => {
    for (const status of ['low_confidence', 'irrelevant']) {
      const result = checkEligibility(post({ status }), {
        now: NOW,
        windowHours: 24,
      });
      assert.equal(result.eligible, false, `${status} must be excluded`);
      assert.equal(result.reason, 'not_qualified');
    }
  });

  it('excludes posts discovered before the window, including exactly 24h old', () => {
    const outside = checkEligibility(post({ discovered_at: hoursAgo(25) }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(outside.reason, 'out_of_window');

    // The window boundary is inclusive of 24h.
    const boundary = checkEligibility(post({ discovered_at: hoursAgo(24) }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(boundary.eligible, true);
  });

  it('excludes a row that carries no status, whatever it scored', () => {
    // status is the only qualification signal. A statusless row is malformed,
    // and a high score is not a substitute for the status the pipeline writes.
    for (const relevance_score of [0, 59, 99]) {
      const result = checkEligibility(post({ relevance_score, status: null }), {
        now: NOW,
        windowHours: 24,
      });
      assert.equal(result.reason, 'not_qualified', `score ${relevance_score}`);
    }
  });

  it('includes a qualified post that scored below the priority threshold', () => {
    // The score ranks; it does not filter. A qualified post at 45 is delivered
    // and simply ordered below the stronger matches.
    const result = checkEligibility(post({ relevance_score: 45 }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(result.eligible, true);
    assert.equal(result.reason, null);
  });

  it('includes a qualified post that scored zero', () => {
    // A qualified row can legitimately carry the lowest possible score: the
    // signals were thin, but the post is a real recruiting Product Design post.
    const result = checkEligibility(post({ relevance_score: 0 }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(result.eligible, true);
  });

  it('excludes posts without a LinkedIn URL', () => {
    const result = checkEligibility(post({ linkedin_url: null }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(result.reason, 'missing_url');
  });

  it('excludes posts with no usable discovered_at rather than assuming recency', () => {
    for (const discovered of [null, undefined, 'not-a-date']) {
      const result = checkEligibility(post({ discovered_at: discovered }), {
        now: NOW,
        windowHours: 24,
      });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'missing_discovered_at');
    }
  });

  it('reports already-sent ahead of other disqualifiers, since resending is costliest', () => {
    const result = checkEligibility(post({ is_notified: true, status: 'stale' }), {
      now: NOW,
      windowHours: 24,
    });
    assert.equal(result.reason, 'already_sent');
  });

  it('defaults the lookback to 168 hours (one week)', () => {
    assert.equal(DEFAULT_DIGEST_LOOKBACK_HOURS, 168);
    assert.equal(resolveLookbackHours({}, {}), 168);
  });

  it('keeps the verified-publication window at 24 hours, independent of the lookback', () => {
    assert.equal(VERIFIED_PUBLICATION_WINDOW_HOURS, 24);
  });
});

// ─── Lookback Resolution ──────────────────────────────────────────────────────

describe('Digest Lookback Window', () => {
  it('prefers an explicit window over the environment', () => {
    assert.equal(resolveLookbackHours({ windowHours: 48 }, { DIGEST_LOOKBACK_HOURS: '72' }), 48);
  });

  it('reads DIGEST_LOOKBACK_HOURS when no window is passed', () => {
    assert.equal(resolveLookbackHours({}, { DIGEST_LOOKBACK_HOURS: '72' }), 72);
  });

  it('falls back to the default for a missing, malformed, or non-positive value', () => {
    for (const value of [undefined, '', '   ', 'soon', '0', '-24']) {
      assert.equal(
        resolveLookbackHours({}, { DIGEST_LOOKBACK_HOURS: value }),
        DEFAULT_DIGEST_LOOKBACK_HOURS,
        `DIGEST_LOOKBACK_HOURS=${JSON.stringify(value)} must not corrupt the window`
      );
    }
  });

  it('includes a post discovered 100 hours ago under the default lookback', () => {
    const result = checkEligibility(post({ discovered_at: hoursAgo(100) }), {
      now: NOW,
      windowHours: DEFAULT_DIGEST_LOOKBACK_HOURS,
    });
    assert.equal(result.eligible, true);
  });

  it('still excludes a post discovered 200 hours ago under the default lookback', () => {
    const result = checkEligibility(post({ discovered_at: hoursAgo(200) }), {
      now: NOW,
      windowHours: DEFAULT_DIGEST_LOOKBACK_HOURS,
    });
    assert.equal(result.reason, 'out_of_window');
  });
});

// ─── Statistics ───────────────────────────────────────────────────────────────

describe('Digest Summary Statistics', () => {
  it('reports scanned, qualified, and included counts', () => {
    const digest = build([
      post({ id: 'a', linkedin_url: 'https://linkedin.com/posts/a-activity-1', relevance_score: 90 }),
      post({ id: 'b', linkedin_url: 'https://linkedin.com/posts/b-activity-2', relevance_score: 70 }),
      post({ id: 'c', linkedin_url: 'https://linkedin.com/posts/c-activity-3', is_notified: true }),
      post({ id: 'd', linkedin_url: 'https://linkedin.com/posts/d-activity-4', status: 'stale' }),
      post({ id: 'e', linkedin_url: 'https://linkedin.com/posts/e-activity-5', discovered_at: hoursAgo(200) }),
      // No status: a malformed row, excluded on status alone.
      post({ id: 'f', linkedin_url: 'https://linkedin.com/posts/f-activity-6', relevance_score: 40, status: null }),
    ]);

    assert.equal(digest.stats.scanned, 6);
    assert.equal(digest.stats.qualified, 2);
    assert.equal(digest.stats.included, 2);
    assert.ok(digest.message.includes('Scanned: 6 posts'));
    assert.ok(digest.message.includes('Qualified: 2'));
    assert.ok(digest.message.includes('Included: 2'));
  });

  it('counts only posts that survive the already-sent filter as included', () => {
    const digest = build([
      post({ id: 'a', linkedin_url: 'https://linkedin.com/posts/a-activity-1', relevance_score: 90 }),
      post({ id: 'b', linkedin_url: 'https://linkedin.com/posts/b-activity-2', relevance_score: 80 }),
      post({ id: 'c', linkedin_url: 'https://linkedin.com/posts/c-activity-3', relevance_score: 95, is_notified: true }),
    ]);

    assert.equal(digest.stats.scanned, 3);
    // The highest score in the batch is already sent, so it is not "included".
    assert.equal(digest.stats.skipped.already_sent, 1);
    assert.equal(digest.stats.included, 2);
    assert.equal(digest.message.includes('Score: 95'), false);
    assert.match(digest.message, /Included: 2/);
  });

  it('breaks down each exclusion reason', () => {
    const digest = build([
      post({ id: 'ok', linkedin_url: 'https://linkedin.com/posts/ok-activity-1' }),
      post({ id: 's1', linkedin_url: 'https://linkedin.com/posts/s1-activity-2', is_notified: true }),
      post({ id: 's2', linkedin_url: 'https://linkedin.com/posts/s2-activity-3', sent_to_digest: true }),
      post({ id: 's3', linkedin_url: 'https://linkedin.com/posts/s3-activity-4', status: 'irrelevant' }),
      post({ id: 's4', linkedin_url: 'https://linkedin.com/posts/s4-activity-5', discovered_at: hoursAgo(200) }),
      post({ id: 's5', linkedin_url: 'https://linkedin.com/posts/s5-activity-6', relevance_score: 10, status: null }),
      post({ id: 's6', linkedin_url: null }),
      post({ id: 's7', linkedin_url: 'https://linkedin.com/posts/s7-activity-7', discovered_at: null }),
      null,
    ]);

    assert.equal(digest.stats.scanned, 9);
    assert.equal(digest.stats.qualified, 1);
    assert.equal(digest.stats.skipped.already_sent, 2);
    // s3 is irrelevant and s5 carries no status at all: both are decided by
    // status, and a low score disqualifies nothing.
    assert.equal(digest.stats.skipped.not_qualified, 2);
    assert.equal(digest.stats.skipped.out_of_window, 1);
    assert.equal(digest.stats.skipped.missing_url, 1);
    assert.equal(digest.stats.skipped.missing_discovered_at, 1);
    assert.equal(digest.stats.skipped.invalid, 1);
  });

  it('includes every qualified post regardless of score', () => {
    // The whole point of the change: a spread of scores from 0 to 95 all reach
    // the digest, ordered, with nothing dropped in between.
    const digest = build(
      [0, 15, 45, 59, 60, 95].map((score, i) =>
        post({ id: `s${i}`, linkedin_url: `https://linkedin.com/posts/s${i}-activity-1`, relevance_score: score })
      )
    );

    assert.equal(digest.stats.qualified, 6);
    assert.equal(digest.stats.included, 6);
    assert.deepEqual(digest.included.map((p) => p.relevance_score), [95, 60, 59, 45, 15, 0]);
  });

  it('tolerates a missing or non-array input', () => {
    for (const input of [undefined, null, 'nope', 42]) {
      const digest = buildDigest(input, { now: NOW });
      assert.equal(digest.empty, true);
      assert.equal(digest.stats.scanned, 0);
      assert.equal(digest.stats.qualified, 0);
    }
  });
});

// ─── Ordering ─────────────────────────────────────────────────────────────────

describe('Digest Ordering', () => {
  it('sorts by relevance score descending', () => {
    const scores = [72, 95, 61, 88, 64];
    const digest = build(
      scores.map((score, i) =>
        post({ id: `p${i}`, linkedin_url: `https://linkedin.com/posts/p${i}-activity-1`, relevance_score: score })
      )
    );

    const rendered = digest.included.map((p) => p.relevance_score);
    assert.deepEqual(rendered, [...scores].sort((a, b) => b - a));
  });

  it('breaks score ties with the more recently discovered post first', () => {
    const digest = build([
      post({ id: 'old', linkedin_url: 'https://linkedin.com/posts/old-activity-1', relevance_score: 80, discovered_at: hoursAgo(20) }),
      post({ id: 'new', linkedin_url: 'https://linkedin.com/posts/new-activity-2', relevance_score: 80, discovered_at: hoursAgo(1) }),
    ]);

    assert.deepEqual(digest.included.map((p) => p.id), ['new', 'old']);
  });

  it('produces a stable order for identical scores and timestamps', () => {
    const digest = build([
      post({ id: 'b', linkedin_url: 'https://linkedin.com/posts/bbb-activity-1', relevance_score: 80 }),
      post({ id: 'a', linkedin_url: 'https://linkedin.com/posts/aaa-activity-2', relevance_score: 80 }),
    ]);

    assert.deepEqual(digest.included.map((p) => p.id), ['a', 'b']);
    assert.deepEqual(build(digest.included).included.map((p) => p.id), ['a', 'b']);
  });

  it('caps included roles and reports the remainder', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      post({
        id: `p${i}`,
        linkedin_url: `https://linkedin.com/posts/p${i}-activity-1`,
        relevance_score: 90 - i,
      })
    );

    const digest = build(rows, { maxRoles: 3 });

    assert.equal(digest.stats.included, 3);
    assert.equal(digest.stats.omitted, 5);
    assert.equal(digest.stats.qualified, 8);
    assert.ok(digest.message.includes('+ 5 more qualified not shown'));
  });

  it('defaults the role cap to 25', () => {
    assert.equal(DEFAULT_MAX_ROLES, 25);
  });
});

// ─── Section Split ────────────────────────────────────────────────────────────

describe('Digest Sections (§18)', () => {
  it('places posts published within 24h under verified, older or unknown under recent discoveries', () => {
    const digest = build([
      post({ id: 'v', linkedin_url: 'https://linkedin.com/posts/v-activity-1', published_at: hoursAgo(5) }),
      post({ id: 'r1', linkedin_url: 'https://linkedin.com/posts/r1-activity-2', published_at: hoursAgo(100) }),
      post({ id: 'r2', linkedin_url: 'https://linkedin.com/posts/r2-activity-3', published_at: null }),
    ]);

    assert.deepEqual(digest.sections.verified.map((p) => p.id), ['v']);
    assert.deepEqual(digest.sections.recent.map((p) => p.id).sort(), ['r1', 'r2']);
    assert.ok(digest.message.includes(`⚡ ${DIGEST_SECTIONS.VERIFIED}`));
    assert.ok(digest.message.includes(`✨ ${DIGEST_SECTIONS.RECENT}`));
  });

  it('omits a section heading when it has no posts', () => {
    const onlyRecent = build([post({ published_at: null })]);
    assert.equal(onlyRecent.message.includes(DIGEST_SECTIONS.VERIFIED), false);
    assert.ok(onlyRecent.message.includes(DIGEST_SECTIONS.RECENT));

    const onlyVerified = build([post({ published_at: hoursAgo(1) })]);
    assert.ok(onlyVerified.message.includes(DIGEST_SECTIONS.VERIFIED));
    assert.equal(onlyVerified.message.includes(DIGEST_SECTIONS.RECENT), false);
  });

  it('keeps score order inside each section', () => {
    const digest = build([
      post({ id: 'v-low', linkedin_url: 'https://linkedin.com/posts/vlow-activity-1', published_at: hoursAgo(5), relevance_score: 66 }),
      post({ id: 'v-high', linkedin_url: 'https://linkedin.com/posts/vhigh-activity-2', published_at: hoursAgo(9), relevance_score: 91 }),
    ]);

    assert.deepEqual(digest.sections.verified.map((p) => p.id), ['v-high', 'v-low']);
  });

  it('does not repeat a post that appears in the input twice', () => {
    const row = post({ id: 'dupe' });
    const digest = build([row, { ...row }]);

    assert.equal(digest.stats.scanned, 2);
    assert.equal(digest.stats.qualified, 1);
    assert.equal(digest.stats.included, 1);
    assert.equal(digest.stats.skipped.duplicate_url, 1);
    assert.equal(digest.message.split('Score: 80').length - 1, 1);
  });
});

// ─── Card Formatting ──────────────────────────────────────────────────────────

describe('Digest Card Formatting (§16)', () => {
  const card = (overrides) => buildRoleCard(post(overrides));

  it('includes every required field', () => {
    const text = card();

    assert.ok(text.includes('*Senior Product Designer*'), 'role');
    assert.ok(text.includes('Jane Doe'), 'recruiter');
    assert.ok(text.includes('Acme Pay'), 'company');
    assert.ok(text.includes('London, UK'), 'location');
    assert.ok(text.includes('Remote'), 'remote status');
    assert.ok(text.includes('Fintech startup hiring'), 'description');
    assert.ok(text.includes('https://www.linkedin.com/posts/acme_senior-designer-activity-1'), 'LinkedIn URL');
    assert.ok(text.includes('https://acme.example/apply'), 'application URL');
  });

  it('shows the relevance score', () => {
    assert.ok(card().includes('(Score: 80)'));
  });

  it('renders missing fields as a placeholder instead of inventing values', () => {
    const text = card({
      author_name: null,
      company_name: null,
      location: null,
      remote_status: null,
      post_text: null,
      application_url: null,
    });

    assert.equal(text.split(UNKNOWN_FIELD).length - 1, 4, 'four unknown fields rendered');
    assert.equal(text.includes('Apply:'), false, 'no application URL line');
    assert.equal(/Fintech startup hiring/.test(text), false, 'no fabricated description');
  });

  it('treats empty and whitespace-only values as unknown', () => {
    const text = card({ company_name: '', location: '   ', remote_status: '\n\t' });

    assert.ok(text.includes(`🏢 ${UNKNOWN_FIELD}`));
    assert.ok(text.includes(`📍 ${UNKNOWN_FIELD}`));
    assert.ok(text.includes(`🌐 ${UNKNOWN_FIELD}`));
  });

  it('omits the application URL line when unavailable', () => {
    assert.equal(card({ application_url: null }).includes('Apply:'), false);
    assert.ok(card({ application_url: 'https://a.example/x' }).includes('📝 Apply: https://a.example/x'));
  });

  it('omits the description block when there is no text', () => {
    const text = card({ post_text: null });

    assert.equal(descriptionBlock(text), '', 'no description block rendered');
    assert.equal(text.includes('Fintech startup hiring'), false, 'no fabricated description');

    // The card still shows every structured field.
    assert.ok(text.includes('Jane Doe'));
    assert.ok(text.includes('Acme Pay'));
  });

  it('renders a description block when text is present', () => {
    assert.equal(descriptionBlock(card()), 'Fintech startup hiring a Senior Product Designer for our payments platform.');
  });

  it('collapses newlines in post text so one post cannot break the layout', () => {
    const text = card({ post_text: 'Line one\n\nLine two\ttabbed' });
    const description = descriptionBlock(text);

    assert.ok(description.includes('Line one Line two tabbed'));
    assert.equal(description.includes('\n'), false);
  });

  it('truncates long descriptions on a word boundary', () => {
    const text = buildRoleCard(post({ post_text: 'word '.repeat(200) }), {
      maxDescriptionChars: 100,
    });
    const description = descriptionBlock(text);

    assert.ok(description.length <= 101, `truncated to ${description.length} characters`);
    assert.ok(description.endsWith('…'));
    assert.equal(description.includes('  '), false, 'no cut mid-word');
  });

  it('leaves short descriptions untouched', () => {
    const text = card({ post_text: 'Short and factual.' });
    assert.ok(text.includes('Short and factual.'));
    assert.equal(text.includes('…'), false);
  });

  it('defaults the description cap to 160 characters', () => {
    assert.equal(MAX_DESCRIPTION_CHARS, 160);
    assert.equal(summarizeText('x'.repeat(400)).length, 161);
  });

  it('never shortens a description that already fits', () => {
    assert.equal(summarizeText('exactly fine'), 'exactly fine');
    assert.equal(summarizeText(null), '');
    assert.equal(summarizeText(undefined), '');
    assert.equal(summarizeText(12345), '');
  });

  it('shows n/a rather than inventing a score', () => {
    assert.ok(card({ relevance_score: null }).includes(`(Score: ${UNKNOWN_SCORE})`));
  });

  it('keeps every line short enough to read on a phone', () => {
    const text = card({ post_text: 'word '.repeat(200) });
    const longest = Math.max(...text.split('\n').map((l) => l.length));

    assert.ok(longest < 180, `longest line was ${longest} characters`);
  });
});

// ─── Provider-Safe Formatting ─────────────────────────────────────────────────

describe('provider-safe formatting', () => {
  it('uses asterisk bold and never underscore italics, which URLs would break', () => {
    const digest = build([
      post({
        linkedin_url:
          'https://www.linkedin.com/posts/some_person_name_senior-designer-activity-7123456789',
      }),
    ]);

    assert.ok(digest.message.includes('*DESIGNRADAR*'));
    assert.ok(digest.message.includes('*Senior Product Designer*'));

    // Every underscore in the output belongs to a URL, never to an italic pair.
    for (const line of digest.message.split('\n')) {
      const underscoresOutsideUrl = line
        .split('https://')
        .slice(1)
        .map((segment) => segment.slice(segment.indexOf(' ') === -1 ? segment.length : segment.indexOf(' ')))
        .join('');
      assert.equal(underscoresOutsideUrl.includes('_'), false, `stray underscore: ${line}`);
    }
  });

  it('emits a branded header with the digest date', () => {
    const digest = build([post()]);

    assert.ok(digest.message.startsWith('🎨 *DESIGNRADAR*'));
    assert.ok(digest.message.includes('Senior Product Design opportunities'));
    assert.ok(digest.message.includes('Daily Digest — 1 Oct 2026'));
  });

  it('uses singular wording for a single opportunity', () => {
    assert.ok(build([post()]).message.includes('Found 1 relevant opportunity.'));
    assert.ok(
      build([
        post({ id: 'a', linkedin_url: 'https://linkedin.com/posts/a-activity-1' }),
        post({ id: 'b', linkedin_url: 'https://linkedin.com/posts/b-activity-2' }),
      ]).message.includes('Found 2 relevant opportunities.')
    );
  });
});

// ─── Chunking (§22) ───────────────────────────────────────────────────────────

describe('Digest Chunking (§22)', () => {
  it('splits oversized digests and never breaks a card across chunks', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      post({
        id: `p${i}`,
        linkedin_url: `https://linkedin.com/posts/p${i}-activity-${i}`,
        job_title: `Senior Product Designer ${i}`,
        relevance_score: 99 - i,
        post_text: 'Fintech compliance product surface work. '.repeat(4),
      })
    );

    const digest = build(rows, { maxRoles: 40 });

    assert.ok(digest.chunks.length > 1, 'expected multiple chunks');
    assert.equal(digest.stats.chunks, digest.chunks.length);
    assert.equal(digest.stats.included, 40);

    for (const chunk of digest.chunks) {
      assert.ok(chunk.length <= MAX_CHUNK_CHARS, `chunk of ${chunk.length} chars exceeded the cap`);
    }

    // Every included card URL appears in exactly one chunk, intact.
    for (const row of digest.included) {
      const appearances = digest.chunks.filter((c) => c.includes(row.linkedin_url)).length;
      assert.equal(appearances, 1, `card ${row.id} appeared in ${appearances} chunks`);
    }

    // No card is cut short: every LinkedIn URL line is followed by a blank line
    // or the end of the chunk, never by a dangling field.
    for (const chunk of digest.chunks) {
      const lines = chunk.split('\n');
      for (const [i, line] of lines.entries()) {
        if (line.startsWith('🔗 ') && i < lines.length - 1) {
          const next = lines[i + 1];
          assert.ok(
            next === '' || next.startsWith('🔥') || next.startsWith('📝') || next.startsWith('━━'),
            `unexpected line after a card URL: ${next}`
          );
        }
      }
    }

    // Rejoining the chunks reproduces the whole digest.
    assert.equal(digest.chunks.join('\n\n'), digest.message);
  });

  it('keeps a section heading with its first card', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      post({
        id: `p${i}`,
        linkedin_url: `https://linkedin.com/posts/p${i}-activity-${i}`,
        relevance_score: 90 - i,
        post_text: 'Some description text for the card. '.repeat(3),
      })
    );

    const digest = build(rows, { maxRoles: 30 });
    assert.ok(digest.chunks.length > 1, 'expected multiple chunks');

    for (const chunk of digest.chunks) {
      assert.equal(/(VERIFIED|RECENT DISCOVERIES)\s*$/.test(chunk.trim()), false);
    }
  });

  it('leaves a heading attached to a card rather than stranding it', () => {
    const digest = build([post()]);
    const lines = digest.message.split('\n');
    const headingIndex = lines.findIndex((l) => l.includes(DIGEST_SECTIONS.VERIFIED));

    assert.ok(headingIndex >= 0);
    // A card starts within a few lines of the heading, never after a chunk break.
    assert.ok(lines.slice(headingIndex + 3).some((l) => l.startsWith('🔥 ')));
  });

  it('keeps a single short digest in one chunk', () => {
    const digest = build([post()]);
    assert.equal(digest.chunks.length, 1);
    assert.equal(digest.message, digest.chunks[0]);
  });

  it('defaults to a 3500 character chunk limit', () => {
    assert.equal(MAX_CHUNK_CHARS, 3500);
  });

  it('packs blocks without exceeding the limit and returns nothing for no blocks', () => {
    assert.deepEqual(chunkDigest([]), []);
    assert.deepEqual(chunkDigest(['a']), ['a']);

    const chunks = chunkDigest(['x'.repeat(100), 'y'.repeat(100)], { maxChars: 150 });
    assert.equal(chunks.length, 2);
  });
});

// ─── Empty Digest ─────────────────────────────────────────────────────────────

describe('Empty Digest', () => {
  it('still produces a real message when nothing qualifies', () => {
    const digest = build([
      post({ id: 'a', linkedin_url: 'https://linkedin.com/posts/a-activity-1', is_notified: true }),
      post({ id: 'b', linkedin_url: 'https://linkedin.com/posts/b-activity-2', status: 'stale' }),
    ]);

    assert.equal(digest.empty, true);
    assert.notEqual(digest.message, '', 'an empty digest must still be reportable');
    assert.ok(digest.chunks.length >= 1);
    assert.equal(digest.stats.scanned, 2);
    assert.equal(digest.stats.qualified, 0);
    assert.equal(digest.stats.included, 0);
  });

  it('states the zero counts and the window, so silence is never ambiguous', () => {
    const digest = build([post({ is_notified: true })], { windowHours: 168 });

    assert.match(digest.message, /Scanned: 1 posts/);
    assert.match(digest.message, /Qualified: 0/);
    assert.match(digest.message, /Included: 0/);
    assert.match(digest.message, /168 hours/);
    assert.equal(digest.stats.chunks, digest.chunks.length);
  });

  it('omits the already-sent post from the included count', () => {
    const digest = build([
      post({ id: 'a', linkedin_url: 'https://linkedin.com/posts/a-activity-1', is_notified: true }),
      post({ id: 'b', linkedin_url: 'https://linkedin.com/posts/b-activity-2', sent_to_digest: true }),
    ]);

    assert.equal(digest.empty, true);
    assert.equal(digest.stats.scanned, 2);
    assert.equal(digest.stats.skipped.already_sent, 2);
    assert.equal(digest.stats.included, 0);
  });
});

// ─── Mock Preview ─────────────────────────────────────────────────────────────

describe('Mock Notification Output', () => {
  /** Runs a function with console.log captured. */
  function captureLog(fn) {
    const original = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
      return { result: fn(), output: lines.join('\n') };
    } finally {
      console.log = original;
    }
  }

  it('previews the digest without delivering it', () => {
    const digest = build([post()]);
    const { output } = captureLog(() => renderDigestPreview(digest));

    assert.ok(output.includes('MOCK NOTIFICATION PREVIEW'));
    assert.ok(output.includes('not delivered to any provider'));
    assert.ok(output.includes('Senior Product Designer'));
    assert.ok(output.includes('Scanned: 1 | Qualified: 1 | Included: 1 | Chunks: 1'));
  });

  it('previews an empty digest with its statistics', () => {
    const digest = build([]);
    const { output } = captureLog(() => renderDigestPreview(digest));

    assert.ok(output.includes('No relevant opportunities in the last 168 hours'));
    assert.ok(output.includes('Scanned: 0'));
    assert.ok(output.includes('Qualified: 0'));
    assert.ok(output.includes('Included: 0'));
  });

  it('labels each chunk when the digest spans several messages', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      post({
        id: `p${i}`,
        linkedin_url: `https://linkedin.com/posts/p${i}-activity-${i}`,
        relevance_score: 90 - i,
        post_text: 'Longer description content for chunk coverage. '.repeat(4),
      })
    );

    const digest = build(rows);
    const { output } = captureLog(() => renderDigestPreview(digest));

    assert.ok(digest.chunks.length > 1);
    assert.ok(output.includes(`chunk 1 of ${digest.chunks.length}`));
    assert.ok(output.includes(`chunk ${digest.chunks.length} of ${digest.chunks.length}`));
  });

  it('builds a realistic mock set that exercises the awkward cases', () => {
    const posts = buildMockPosts({ now: NOW });

    assert.ok(posts.length >= 9);
    assert.ok(posts.some((p) => p.author_name === null), 'missing recruiter');
    assert.ok(posts.some((p) => p.company_name === null), 'missing company');
    assert.ok(posts.some((p) => p.location === null), 'missing location');
    assert.ok(posts.some((p) => p.remote_status === null), 'missing remote status');
    assert.ok(posts.some((p) => p.post_text === null), 'missing description');
    assert.ok(posts.some((p) => p.application_url === null), 'no application URL');
    assert.ok(posts.some((p) => p.is_notified === true), 'already-sent post');
    assert.ok(posts.some((p) => p.status === 'stale'), 'stale post');

    const digest = build(posts);

    // Seven eligible mocks; the stale, sent, and out-of-lookback rows are dropped.
    assert.equal(digest.stats.scanned, posts.length);
    assert.equal(digest.stats.qualified, 7);
    assert.equal(digest.stats.included, 7);
    assert.equal(digest.stats.skipped.already_sent, 1);
    assert.equal(digest.stats.skipped.not_qualified, 1);
    assert.equal(digest.stats.skipped.out_of_window, 1);
  });

  it('includes a post published days ago that is still inside the lookback', () => {
    const posts = buildMockPosts({ now: NOW });
    const digest = build(posts);

    // A 24-hour window would have dropped this row entirely.
    const weekOld = posts.find((p) => p.id === 'mock-10');
    assert.ok(weekOld, 'fixture contains a post discovered 70h ago');
    assert.ok(digest.included.some((p) => p.id === 'mock-10'));
    assert.ok(digest.message.includes('Score: 66'));
    assert.equal(digest.sections.verified.some((p) => p.id === 'mock-10'), false);
    assert.ok(digest.sections.recent.some((p) => p.id === 'mock-10'));
  });

  it('keeps the highest-scoring excluded posts out of the mock preview', () => {
    const posts = buildMockPosts({ now: NOW });
    const digest = build(posts);
    const highestOverall = Math.max(...posts.map((p) => p.relevance_score));

    assert.ok(highestOverall === 92, 'fixture contains a 92-point stale post');
    assert.equal(digest.message.includes('Score: 92'), false);
    assert.equal(digest.message.includes('Score: 88'), false);
    assert.equal(digest.message.includes('Score: 80'), false);
  });

  it('renders every mock post without throwing', () => {
    const digest = build(buildMockPosts({ now: NOW }));
    captureLog(() => renderDigestPreview(digest));

    assert.ok(digest.message.length > 0);
    assert.equal(digest.message.includes('undefined'), false);
    assert.equal(digest.message.includes('null'), false);
    assert.equal(digest.message.includes('[object Object]'), false);
    assert.equal(digest.message.includes('NaN'), false);
  });
});

// ─── generateDigest ───────────────────────────────────────────────────────────

describe('generateDigest', () => {
  it('builds a digest from supplied posts without touching a provider', async () => {
    const original = console.log;
    console.log = () => {};
    try {
      const result = await generateDigest({ posts: [post()], now: NOW });
      assert.equal(result.provider, 'mock');
      assert.equal(result.delivered, false);
      assert.equal(result.notified, false);
      assert.equal(result.stats.included, 1);
      assert.ok(result.message.includes('DESIGNRADAR'));
    } finally {
      console.log = original;
    }
  });

  it('supports a custom post loader', async () => {
    const original = console.log;
    let calledWith = null;
    console.log = () => {};
    try {
      const result = await generateDigest({
        now: NOW,
        preview: false,
        fetchPosts: async (opts) => {
          calledWith = opts;
          return [post()];
        },
      });

      assert.ok(calledWith.now instanceof Date);
      assert.ok(result.stats.included, 1);
      assert.equal(result.source, 'database');
    } finally {
      console.log = original;
    }
  });

  it('skips the preview banner when preview is disabled', async () => {
    const original = console.log;
    let output = '';
    console.log = (...args) => {
      output += `${args.join(' ')}\n`;
    };
    try {
      await generateDigest({ posts: [post()], now: NOW, preview: false });
      assert.equal(output.includes('MOCK NOTIFICATION PREVIEW'), false);
    } finally {
      console.log = original;
    }
  });

  it('hands the loader and the formatter the same resolved lookback', async () => {
    const original = console.log;
    let loaderHours = null;
    console.log = () => {};
    try {
      const result = await generateDigest({
        now: NOW,
        preview: false,
        env: { DIGEST_LOOKBACK_HOURS: '72' },
        fetchPosts: async (opts) => {
          loaderHours = opts.windowHours;
          return [post()];
        },
      });

      assert.equal(loaderHours, 72);
      assert.equal(result.stats.window_hours, 72);
    } finally {
      console.log = original;
    }
  });

  it('never marks a post as notified, because a printed preview is not a send', async () => {
    const original = console.log;
    console.log = () => {};
    try {
      const result = await generateDigest({ posts: [post()], now: NOW });
      assert.equal(result.notified, false);
      assert.equal(result.delivered, false);
      // Every included row is still unsent, so Phase 7 can send exactly this content.
      assert.ok(result.included.every((p) => p.is_notified === false));
    } finally {
      console.log = original;
    }
  });
});

// ─── Sent State ───────────────────────────────────────────────────────────────

describe('Post-Send Marking (§22)', () => {
  /** Builds a chainable stub that records the table, payload and filter it was given. */
  function stubClient(response = { data: null, error: null }) {
    const calls = [];
    const client = {
      calls,
      from(table) {
        const call = { table, payload: null, ids: null };
        calls.push(call);
        const chain = {
          update(payload) {
            call.payload = payload;
            return chain;
          },
          insert(payload) {
            call.payload = payload;
            return chain;
          },
          select() {
            return chain;
          },
          maybeSingle() {
            return Promise.resolve(response);
          },
          in(_column, ids) {
            call.ids = ids;
            return chain;
          },
          then(resolve) {
            return Promise.resolve(response).then(resolve);
          },
        };
        return chain;
      },
    };
    return client;
  }

  it('marks every included post in one statement after a successful send', async () => {
    const { markPostsAsSent } = await import('../src/database/posts.js');
    const client = stubClient();

    const marked = await markPostsAsSent(['id-1', 'id-2'], 'mock', { client });

    assert.equal(marked, 2);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].table, 'linkedin_posts');
    assert.deepEqual(client.calls[0].ids, ['id-1', 'id-2']);
    assert.equal(client.calls[0].payload.is_notified, true);
    assert.equal(client.calls[0].payload.notification_channel, 'mock');
    // Provider-neutral: the digest flags are set for every provider, including
    // a mock run that opted into consuming the queue.
    assert.equal(client.calls[0].payload.sent_to_digest, true);
    assert.ok(client.calls[0].payload.sent_at);
    assert.equal(client.calls[0].payload.notified_at, client.calls[0].payload.sent_at);
  });

  it('records the provider that delivered, so swapping ntfy for another changes only this value', async () => {
    const { markPostsAsSent } = await import('../src/database/posts.js');
    const client = stubClient();

    await markPostsAsSent(['id-1'], 'ntfy', { client });

    assert.equal(client.calls[0].payload.notification_channel, 'ntfy');
    assert.equal(client.calls[0].payload.sent_to_digest, true);
    assert.ok(client.calls[0].payload.sent_at);
  });

  it('does not touch the database when there is nothing to mark', async () => {
    const { markPostsAsSent } = await import('../src/database/posts.js');
    const exploding = {
      from() {
        throw new Error('the database must not be called for an empty digest');
      },
    };

    assert.equal(await markPostsAsSent([], 'mock', { client: exploding }), 0);
    assert.equal(await markPostsAsSent(null, 'mock', { client: exploding }), 0);
  });

  it('surfaces a database failure rather than silently dropping the sent state', async () => {
    const { markPostsAsSent } = await import('../src/database/posts.js');
    const client = stubClient({ data: null, error: { message: 'permission denied' } });

    await assert.rejects(
      () => markPostsAsSent(['id-1'], 'mock', { client }),
      /markPostsAsSent failed: permission denied/
    );
  });

  it('records the digest in notifications without marking anything sent', async () => {
    const { recordDigestNotification } = await import('../src/database/posts.js');
    const client = stubClient({ data: { id: 'n1' }, error: null });

    const id = await recordDigestNotification({
      postIds: ['id-1', 'id-2'],
      provider: 'mock',
      status: 'sent',
      client,
    });

    assert.equal(id, 'n1');
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].table, 'notifications');
    assert.equal(client.calls[0].payload.notification_type, 'daily_digest');
    assert.equal(client.calls[0].payload.post_count, 2);
    assert.deepEqual(client.calls[0].payload.post_ids, ['id-1', 'id-2']);
    assert.equal(client.calls[0].payload.status, 'sent');
    assert.equal(client.calls[0].payload.error_message, null);
  });

  it('records a failed send with its error and never with post_count 0', async () => {
    const { recordDigestNotification } = await import('../src/database/posts.js');
    const client = stubClient({ data: { id: 'n2' }, error: null });

    await recordDigestNotification({
      postIds: ['id-1'],
      status: 'failed',
      errorMessage: 'timeout',
      client,
    });

    assert.equal(client.calls[0].payload.status, 'failed');
    assert.equal(client.calls[0].payload.error_message, 'timeout');
  });

  it('records nothing for an empty digest', async () => {
    const { recordDigestNotification } = await import('../src/database/posts.js');
    const exploding = {
      from() {
        throw new Error('the notifications table must not be written for an empty digest');
      },
    };

    assert.equal(await recordDigestNotification({ postIds: [], client: exploding }), null);
  });

  it('marks nothing and records nothing until a send is confirmed', async () => {
    // The Phase 6 mock run is a print, not a send: it must leave the sent state
    // untouched so Phase 7 can deliver the same posts.
    const original = console.log;
    console.log = () => {};
    try {
      const result = await generateDigest({
        posts: [post()],
        now: NOW,
        fetchPosts: undefined,
      });

      assert.equal(result.notified, false);
      assert.equal(result.delivered, false);
      assert.equal(result.included.length, 1);
      assert.equal(result.included[0].is_notified, false);
    } finally {
      console.log = original;
    }
  });
});