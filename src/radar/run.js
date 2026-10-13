/**
 * Radar Orchestrator (Phase 8).
 *
 * The single coordinator for one complete run:
 *
 *   Discovery → Filtering → Classification → Scoring → Dedup → Persistence
 *   → Digest → Notification → Search-run statistics
 *
 * Every stage delegates to the module that owns its logic; this file only decides
 * the order, the counts, and what happens when a stage degrades. The rules that
 * keep a partial run useful live here:
 *
 *   - A failed search query is recorded and the remaining queries still run.
 *   - A failed classification excludes only that candidate.
 *   - A failed notification degrades the run and leaves every post unsent.
 *
 * Dependencies are injectable through `options.deps` so the orchestration can be
 * tested end to end without calling Serper, Gemini, Supabase, or a notification
 * provider. The defaults are the real modules.
 */

import { isDatabaseConfigured } from '../database/supabase.js';
import { filterCandidates } from '../search/index.js';
import { runDiscovery } from '../discovery/index.js';
import { classifyCandidates, meetsConfidenceThreshold, getGeminiSettings } from '../ai/classify.js';
import { DEFAULT_MIN_RELEVANCE_SCORE } from '../ai/score.js';
import { resolveProfileSeniority } from '../profile/role-policy.js';
import { evaluateCandidate, RECENCY_WINDOW_HOURS } from '../filtering/status.js';
import {
  createSearchRun,
  completeSearchRun,
  createPosts,
  findExistingUrls,
  findUrlCaseDrift,
  realignUrlCase,
} from '../database/posts.js';
import {
  assertNotificationSettings,
  describeNotificationSettings,
  resolveNotificationSettings,
} from '../notifications/index.js';
import { runDigest, notifyDigest } from '../notifications/pipeline.js';
import { logger } from '../utils/logger.js';
import { getEnv } from '../utils/env.js';

/**
 * The real collaborators, overridable one-for-one via `options.deps`.
 */
const DEFAULT_DEPS = {
  isDatabaseConfigured,
  filterCandidates,
  runDiscovery,
  classifyCandidates,
  meetsConfidenceThreshold,
  evaluateCandidate,
  getGeminiSettings,
  findExistingUrls,
  findUrlCaseDrift,
  realignUrlCase,
  createPosts,
  createSearchRun,
  completeSearchRun,
  resolveNotificationSettings,
  describeNotificationSettings,
  assertNotificationSettings,
  runDigest,
  notifyDigest,
};

/**
 * Execution modes for a radar run (Phase 9).
 *
 * Production splits the daily work in two because discovery and delivery have
 * different cadences: posts are found every 4 hours but the digest is delivered
 * once a day at a fixed local time. Running the full pipeline on the 4-hour
 * schedule would therefore send six digests a day.
 *
 *   'full'      — discovery, then digest and delivery. The historical behaviour,
 *                 and the default, so `runRadar()` and `npm run radar` are
 *                 unchanged for local use.
 *   'discovery' — steps 1-6 only. Qualified posts are persisted and left in the
 *                 queue for the daily digest. Never notifies.
 *   'digest'    — Phase 6 + 7 only, over posts already stored. Never searches,
 *                 so it cannot widen coverage or add candidates on its own.
 */
export const RADAR_MODES = Object.freeze({
  FULL: 'full',
  DISCOVERY: 'discovery',
  DIGEST: 'digest',
});

/**
 * Normalizes the requested mode into the two independent decisions the
 * orchestrator actually needs.
 *
 * `options.digest` is honoured as well as `options.mode` so the existing
 * `runRadar({ digest: false })` scan-only call keeps working unchanged.
 *
 * @param {Object} [options]
 * @param {string} [options.mode] 'full' (default), 'discovery', or 'digest'.
 * @param {boolean} [options.digest=false] Legacy flag; `false` suppresses delivery.
 * @returns {{ mode: string, runDiscovery: boolean, runNotification: boolean }}
 * @throws {Error} When `mode` is not one of the supported values. A scheduled job
 *   that silently fell back to the full pipeline would send six digests a day.
 */
export function resolveRunMode(options = {}) {
  const requested = options.mode ?? RADAR_MODES.FULL;

  if (!Object.values(RADAR_MODES).includes(requested)) {
    throw new Error(
      `Unsupported radar mode "${requested}". Expected one of: ${Object.values(RADAR_MODES).join(', ')}.`
    );
  }

  // `digest: false` is the pre-Phase-9 way to request a scan-only run, and
  // `npm run scan` still uses it.
  const wantsDelivery = options.digest === false ? false : requested !== RADAR_MODES.DISCOVERY;

  return {
    mode: requested,
    // A digest-only run reads stored posts, so it must not also search.
    runDiscovery: requested !== RADAR_MODES.DIGEST,
    runNotification: wantsDelivery,
  };
}

/**
 * Main application runner (Phase 5 — Relevance Scoring, through Phase 9 scheduling).
 *
 * @param {Object} [options]
 * @param {string} [options.mode='full'] 'full', 'discovery', or 'digest'. See RADAR_MODES.
 * @param {boolean} [options.digest=true] Continue into Phase 6 (digest generation)
 *   and Phase 7 (notification delivery) once the scan completes. `false` is
 *   equivalent to `mode: 'discovery'`.
 * @param {Object} [options.env] Environment source for configuration reads. Defaults to the current runtime environment.
 * @param {Object} [options.deps] Per-module overrides for the collaborators listed
 *   in DEFAULT_DEPS. Used by the integration tests; production runs use the defaults.
 * @returns {Promise<object>} Run summary, including the `success` contract fields
 *   and the per-stage detail behind them.
 */
export async function runRadar(options = {}) {
  const deps = { ...DEFAULT_DEPS, ...(options.deps ?? {}) };
  const env = options.env ?? getEnv();
  const { mode, runDiscovery: shouldDiscover, runNotification } = resolveRunMode(options);

  // Single reference time for the whole run, so every recency comparison in this
  // execution uses the same "now" and stays reproducible (§18).
  const runStartedAt = new Date();

  console.log('----------------------------------------------------');
  console.log('🎨 DesignRadar — Personal Job Intelligence System');
  console.log(`   Status: Phase 9 (Edge Function + Cron) — mode: ${mode}`);
  console.log('----------------------------------------------------');

  const dbReady = deps.isDatabaseConfigured();
  const provider = env.SEARCH_PROVIDER || 'serper';
  const hasSearchKey = Boolean(env.SEARCH_API_KEY);
  const hasGeminiKey = Boolean(env.GEMINI_API_KEY);

  // Resolved once so the banner reports exactly what classification will use.
  const geminiSettings = deps.getGeminiSettings({}, env);

  // Same for the notifier: resolved and validated once, before any work starts,
  // so an unusable provider fails fast instead of after a full scan.
  const notificationSettings = deps.resolveNotificationSettings({}, env);
  const notification = deps.describeNotificationSettings(notificationSettings);

  const minRelevanceScore = Number.parseInt(
    env.MIN_RELEVANCE_SCORE || String(DEFAULT_MIN_RELEVANCE_SCORE),
    10
  );

  // Single source of truth for both the planned search_run.query_count and the
  // queries discovery actually executes, so the two can never drift apart.
  // Defaults to 8 across all configured sources, overridable via QUERY_BUDGET.
  const queryBudget = options.queryBudget ?? Number.parseInt(env.QUERY_BUDGET ?? '8', 10);

  // Fixed validity window: posts up to a week old are valid, anything older is
  // stale. Deliberately not configurable so no environment value can let an old
  // opening qualify.
  const recencyWindowHours = RECENCY_WINDOW_HOURS;

  console.log(`[Config] Database configured: ${dbReady ? 'YES' : 'NO (Check .env)'}`);
  console.log(`[Config] Search Provider:    ${provider} (API Key: ${hasSearchKey ? 'Configured' : 'Missing'})`);
  console.log(`[Config] Gemini Model:       ${geminiSettings.model} (API Key: ${hasGeminiKey ? 'Configured' : 'Missing'})`);
  console.log(
    `[Config] Gemini Requests:     concurrency ${geminiSettings.concurrency}, ` +
    `max retries ${geminiSettings.maxRetries}, backoff ${geminiSettings.initialRetryDelayMs}ms, ` +
    `timeout ${geminiSettings.timeoutMs}ms`
  );
  console.log(`[Config] Notifier Provider:  ${notification.provider} (Recipient: ${notification.recipient})`);
  if (notification.provider === 'ntfy') {
    // The topic and server are printed because they are needed to tell "sent to
    // the wrong place" apart from "not sent at all". The token is presence only.
    console.log(
      `[Config] ntfy Server:         ${notification.ntfy.baseUrl} ` +
        `(Topic: ${notification.ntfy.topic}, Token: ${notification.ntfy.token})`
    );
  }
  console.log(`[Config] Mark Mock As Sent: ${notification.markMockAsSent ? 'YES' : 'NO (preview only)'}`);
  console.log(`[Config] Timezone:           ${env.TIMEZONE || 'Africa/Lagos'}`);

  // A digest is delivered at the end of the run, so an unusable notifier has to
  // fail here — not after minutes of scanning and Gemini spend. The banner above
  // still prints, so the operator sees which variable is missing. Discovery mode
  // is exempt: it never notifies, so a missing ntfy variable must not block it.
  if (runNotification) {
    deps.assertNotificationSettings(notificationSettings);
  }
  console.log(
    `[Config] Priority Threshold: ${minRelevanceScore} (MIN_RELEVANCE_SCORE — ranks qualified posts, ` +
    `does not gate them)`
  );
  console.log(`[Config] Recency Window:     ${recencyWindowHours}h (fixed; older than this is stale)`);
  console.log('----------------------------------------------------');

  // If running in development without a live search key, fall back to mock
  const activeProvider = hasSearchKey ? provider : 'mock';
  if (!hasSearchKey && provider !== 'mock') {
    logger.warn(`No SEARCH_API_KEY found for "${provider}". Falling back to "mock" provider for demonstration.`);
  }

  // ─── Step 1: Create search run record ─────────────────────────────────
  let searchRun = null;
  if (dbReady) {
    try {
      searchRun = await deps.createSearchRun({ queryCount: queryBudget });
      logger.info('Search run record created', { runId: searchRun.id });
    } catch (err) {
      logger.error('Failed to create search run record, continuing without tracking', { error: err.message });
    }
  }

  // ─── Step 2: Run Discovery ────────────────────────────────────────────
  // Skipped in digest mode: that run exists to deliver posts an earlier
  // discovery already stored, so searching here would spend provider quota and
  // could widen coverage at a moment that is only meant to notify.
  let discovery = {
    candidates: [],
    queries: [],
    failedQueries: [],
    metrics: { successfulQueries: 0 },
  };

  if (shouldDiscover) {
    discovery = await deps.runDiscovery({
      provider: activeProvider,
      queryBudget,
    });
  } else {
    console.log('Discovery:        SKIPPED (mode: digest — delivering stored posts).');
  }

  // Per-query failures are isolated by the search batch, so they are collected
  // here for the run summary instead of aborting the scan. `failedQueries` is
  // optional so a discovery implementation that predates Phase 8 still works.
  const failedQueries = discovery.failedQueries ?? [];
  const queriesAttempted = discovery.queries.length;
  const queriesSucceeded = discovery.metrics?.successfulQueries ?? queriesAttempted - failedQueries.length;

  console.log('----------------------------------------------------');
  console.log(
    shouldDiscover
      ? `Discovery Results: Found ${discovery.candidates.length} unique job opportunities across ${queriesAttempted} queries.`
      : 'Discovery Results: Not run in this mode.'
  );
  if (failedQueries.length > 0) {
    console.log(`Search Warnings:   ${failedQueries.length} of ${queriesAttempted} queries failed; results from the rest were kept.`);
  }

  // ─── Step 3: Keyword Filtering ────────────────────────────────────────
  const { passed, rejected } = deps.filterCandidates(discovery.candidates);

  console.log(`Keyword Filter:   ${passed.length} passed, ${rejected.length} rejected.`);
  for (const r of rejected) {
    logger.debug('Rejected candidate', { url: r.candidate.url, reason: r.reason });
  }

  // ─── Step 4: AI Classification ─────────────────────────────────────────
  // Classification runs before persistence so that the stored record carries
  // the structured fields from §11. Scoring (Phase 5) consumes these later.
  let classificationResult = {
    results: [],
    succeeded: 0,
    failed: 0,
    totalUsage: null,
    failureReasons: {},
    infrastructureFailure: false,
  };
  let classified = [];
  let classificationSkipped = null;
  // Posts whose seniority the profile role policy resolved to Senior, i.e. an
  // unlevelled or mid product design title. Reported so the run summary shows
  // how much of the batch arrived without a level marker.
  let profileElevations = 0;

  if (!hasGeminiKey) {
    classificationSkipped = 'GEMINI_API_KEY not configured';
    console.log(`AI Classification: SKIPPED (${classificationSkipped}).`);
  } else if (passed.length === 0) {
    classificationSkipped = 'no candidates to classify';
    console.log('AI Classification: No candidates to classify.');
  } else {
    // Concurrency, retries, and delays come from GEMINI_* configuration; at the
    // default of 1 these run one at a time.
    classificationResult = await deps.classifyCandidates(passed);

    // A candidate that failed to classify contributes no fields and so cannot
    // reach scoring or persistence. Dropping it here is what keeps one bad
    // candidate from failing the batch.
    //
    // The profile role policy is applied to each classification exactly once,
    // here, so the seniority that is scored is the seniority that is stored. The
    // model keeps reporting what the post literally says (Mid or Unknown for an
    // unlevelled "Product Designer"); the policy resolves that to the profile's
    // level, and a Junior role is left alone so the eligibility gate can reject
    // it.
    classified = classificationResult.results
      .filter((r) => r.ok && r.classification)
      .map((r) => {
        const resolved = resolveProfileSeniority(r.classification);
        if (resolved.applied) {
          profileElevations++;
        }
        return { ...resolved.classification, linkedin_url: r.url };
      });

    const belowThreshold = classificationResult.results.filter(
      (r) => r.ok && r.classification && !deps.meetsConfidenceThreshold(r.classification)
    );

    console.log(
      `AI Classification: ${classificationResult.succeeded} classified, ${classificationResult.failed} failed, ` +
      `${belowThreshold.length} below confidence threshold.`
    );

    if (profileElevations > 0) {
      console.log(
        `Role Policy:       ${profileElevations} unlevelled or mid product design title(s) treated as Senior.`
      );
    }

    if (classificationResult.failed > 0) {
      const reasons = Object.entries(classificationResult.failureReasons)
        .map(([code, count]) => `${code} (${count})`)
        .join(', ');
      console.log(`Classification Failures: ${reasons}.`);
    }

    if (classificationResult.totalUsage?.total_tokens) {
      console.log(`Token Usage:       ${classificationResult.totalUsage.total_tokens} total.`);
    }
  }

  // ─── Step 5: Eligibility + Relevance Scoring + Recency Status ─────────────
  // The relevance score is computed from the Phase 4 classification only. The
  // model never supplies a score, so the same input always produces the same
  // result (§14). Eligibility — is this a recruiting product design post at all —
  // is decided by the role gate, and the score only labels priority (§14 rule 1).
  // Recency (§18) then decides the final status, which is why a six-month-old
  // opening is stored as 'stale' and never reaches a digest.
  const scoredByUrl = new Map();
  let scoringResult = {
    scored: 0,
    eligible: 0,
    highPriority: 0,
    standardPriority: 0,
    stale: 0,
    lowConfidence: 0,
    unverifiedTimestamps: 0,
    gateFailures: 0,
  };

  if (classified.length === 0) {
    console.log('Relevance Scoring: SKIPPED (no classified candidates).');
  } else {
    const candidateByUrl = new Map(passed.map((c) => [c.url, c]));

    for (const ai of classified) {
      const candidate = candidateByUrl.get(ai.linkedin_url) || null;

      const evaluation = deps.evaluateCandidate(ai, {
        candidate,
        publishedAt: candidate?.publishedAt ?? null,
        minScore: minRelevanceScore,
        now: runStartedAt,
      });

      scoredByUrl.set(ai.linkedin_url, {
        classification: ai,
        // Provider timestamps are only stored once normalized to a real date, so
        // relative strings like "3 days ago" cannot reach the timestamptz column.
        published_at: evaluation.recency.iso,
        relevance_score: evaluation.score,
        status: evaluation.status,
        score_explain: evaluation.explanation.explain.join('\n'),
        score_breakdown: evaluation.explanation,
      });

      scoringResult.scored++;
      if (!evaluation.eligible) {
        scoringResult.gateFailures++;
      } else if (evaluation.status === 'stale') {
        // Eligible but too old to deliver. Counted as stale rather than eligible,
        // so that `eligible === highPriority + standardPriority` always holds and
        // the log cannot read as if a stale post was delivered.
        scoringResult.stale++;
      } else if (evaluation.status === 'low_confidence') {
        scoringResult.lowConfidence++;
      } else {
        scoringResult.eligible++;
        if (evaluation.priority === 'high') {
          scoringResult.highPriority++;
        } else if (evaluation.priority === 'standard') {
          scoringResult.standardPriority++;
        }
      }

      if (evaluation.recency.state === 'unverified') scoringResult.unverifiedTimestamps++;

      logger.debug('Evaluated post', {
        url: ai.linkedin_url,
        score: evaluation.score,
        priority: evaluation.priority,
        status: evaluation.status,
        recency: evaluation.recency.state,
        reason: evaluation.reason,
      });
    }

    console.log(
      `Relevance Scoring: ${scoringResult.scored} scored — ` +
      `${scoringResult.eligible} eligible, ` +
      `${scoringResult.highPriority} high-priority, ` +
      `${scoringResult.standardPriority} standard-priority, ` +
      `${scoringResult.stale} stale, ` +
      `${scoringResult.lowConfidence} low confidence, ` +
      `${scoringResult.gateFailures} role-gate failures.`
    );

    if (scoringResult.unverifiedTimestamps > 0) {
      console.log(
        `Recency:          ${scoringResult.unverifiedTimestamps} posts had no reliable timestamp ` +
        `(treated as unverified per §18, not fabricated).`
      );
    }
  }

  // ─── Step 6: Database Dedup + Persistence ─────────────────────────────
  // Only classified posts are persisted. Persisting an unscored post would burn
  // its URL against future dedup (§9) without it ever being evaluated.
  let persistenceResult = { created: 0, skipped: 0, errors: 0 };

  if (dbReady && passed.length > 0) {
    // Check which URLs already exist (primary dedup per §9)
    const urls = passed.map((c) => c.url);
    const existingUrls = await deps.findExistingUrls(urls);
    const newCandidates = passed.filter(
      (c) => !existingUrls.has(c.url) && scoredByUrl.has(c.url)
    );
    const unclassifiedNew = passed.filter(
      (c) => !existingUrls.has(c.url) && !scoredByUrl.has(c.url)
    ).length;

    // Rows written before path case was preserved hold a URL that was never
    // published. Those posts now count as duplicates and are never rewritten, so
    // a discovered URL that differs only by case is used to repair the stored one.
    // This is the only chance to fix them: discovery sees each post once.
    try {
      const drift = await deps.findUrlCaseDrift(urls);
      if (drift.length > 0) {
        const repaired = await deps.realignUrlCase(drift);
        if (repaired > 0) {
          console.log(`Database Dedup:   Repaired ${repaired} stored URL(s) to the published casing.`);
        }
      }
    } catch (err) {
      // Cosmetic repair only — never fail a run over a stale link.
      logger.error('Stored URL case repair failed', { error: err.message });
    }

    console.log(
      `Database Dedup:   ${existingUrls.size} already in DB, ${newCandidates.length} new, ` +
      `${unclassifiedNew} skipped (not classified).`
    );

    const postRecords = newCandidates.map((c) => {
      const scored = scoredByUrl.get(c.url);

      return {
        linkedin_url: c.url,
        search_run_id: searchRun?.id ?? null,
        source_provider: activeProvider,
        source_query: c.source_query ?? null,
        post_text: c.snippet ?? null,
        // Only a normalized ISO date reaches the timestamptz column (§18); the
        // raw provider value is never stored, so "3 days ago" cannot leak in.
        published_at: scored.published_at ?? null,
        job_title: scored.classification.job_title,
        seniority: scored.classification.seniority,
        company_name: scored.classification.company_name,
        author_name: scored.classification.author_name,
        location: scored.classification.location,
        remote_status: scored.classification.remote_status,
        application_url: scored.classification.application_url,
        is_hiring_manager_or_recruiter: scored.classification.is_hiring_manager_or_recruiter,
        is_recruiting_post: scored.classification.is_recruiting_post,
        is_product_design_role: scored.classification.is_product_design_role,
        confidence: scored.classification.confidence,
        classification_reason: scored.classification.reason,
        // Phase 5 output (§14, §17) plus explainability (migration 002).
        relevance_score: scored.relevance_score,
        status: scored.status,
        score_explain: scored.score_explain,
        score_breakdown: scored.score_breakdown,
      };
    });

    persistenceResult = await deps.createPosts(postRecords);

    console.log(`Persistence:      ${persistenceResult.created} new posts saved, ${persistenceResult.skipped} skipped, ${persistenceResult.errors} errors.`);
  } else if (!dbReady) {
    console.log('Database Dedup:   SKIPPED (database not configured).');
    console.log('Persistence:      SKIPPED (database not configured).');
  } else {
    console.log('Persistence:      No candidates to persist after filtering.');
  }

  // ─── Run status ───────────────────────────────────────────────────────
  // The pipeline only counts as operational when classification actually ran.
  // "0 classified because Gemini was unavailable" is not the same as "0 posts
  // matched", and reporting them identically hides a broken dependency.
  //
  // In digest mode there is no discovery pipeline to summarise, so this status is
  // replaced after delivery with one that describes what actually happened.
  let pipelineStatus = derivePipelineStatus({
    dbReady,
    passedCount: passed.length,
    classificationSkipped,
    classificationResult,
    scoringResult,
    persistenceResult,
    failedQueryCount: failedQueries.length,
  });

  if (shouldDiscover) {
    console.log('----------------------------------------------------');
    console.log(`Phase 5 Status: ${pipelineStatus.status}`);
    console.log(`Reason: ${pipelineStatus.reason}`);

    if (pipelineStatus.status === 'OPERATIONAL') {
      console.log('Discovery → Classification → Relevance Scoring → Dedup → Persistence all executed.');
    }
  }

  // ─── Step 7: Digest Generation → Notification Provider (Phases 6 + 7) ──
  // Discovery mode stops here: it persists qualified posts and leaves them in the
  // queue for the daily digest. `npm run scan` uses the same path via
  // `digest: false`.
  let digest = null;
  let delivery = null;

  if (runNotification) {
    try {
      // Phase 6 renders the digest; Phase 7 prints and delivers it, so the
      // preview is suppressed here to avoid showing the same text twice. `env` is
      // forwarded so the lookback window and provider resolve from the same
      // source as the rest of the run.
      digest = await deps.runDigest({ preview: false, env });
      delivery = await deps.notifyDigest({ digest, notificationSettings });
    } catch (err) {
      // The scan already succeeded and its rows are persisted, so a delivery
      // failure degrades the run rather than discarding it. Posts stay unsent,
      // so the next run retries them.
      logger.error('Digest generation or delivery failed after a successful scan', {
        error: err.message,
      });
      console.log(`Digest/notification skipped: ${err.message}`);
    }
  }

  // ─── Run summary ──────────────────────────────────────────────────────
  // `success` is true when the pipeline did not fail. A skipped delivery — an
  // empty digest, or posts a previous notification already covered — is not a
  // failure: there was nothing to send. Only an attempted send that failed
  // degrades the run, and even then the posts stay unsent for the next run.
  const notificationSent = delivery?.success === true;
  const notificationFailed = delivery?.attempted === true && delivery.success === false;

  // A digest run is judged on delivery, not on a discovery pipeline it never ran.
  if (!shouldDiscover) {
    pipelineStatus = deriveDigestRunStatus({ dbReady, delivery, digest });
    console.log('----------------------------------------------------');
    console.log(`Digest Run Status: ${pipelineStatus.status}`);
    console.log(`Reason: ${pipelineStatus.reason}`);
  }

  const success = pipelineStatus.status !== 'FAILED' && !notificationFailed;

  // Search results and unique URLs coincide by construction: the search layer
  // normalizes and deduplicates URLs before they reach this stage. Recomputed
  // rather than assumed, so a future search layer that stops deduplicating shows
  // up here instead of silently inflating the candidate count.
  const searchResults = discovery.candidates.length;
  const uniqueResults = new Set(discovery.candidates.map((c) => c.url)).size;

  // ─── Step 8: Record search-run statistics ──────────────────────────────
  // Recorded after delivery so the row describes the whole run. Statistics the
  // table has no column for — successful and failed queries, unique URLs,
  // classified posts, and the notification result — are logged below instead of
  // forcing new columns onto the schema; only the notification's effect on the
  // run's own status is stored, because that column already exists for it.
  if (searchRun) {
    const recordedStatus = notificationFailed || pipelineStatus.status === 'FAILED'
      ? 'failed'
      : pipelineStatus.status === 'PARTIAL'
        ? 'partial'
        : 'completed';

    const errorMessage = notificationFailed
      ? `Notification failed (${delivery.errorType}): ${delivery.error}`
      : pipelineStatus.status === 'FAILED'
        ? pipelineStatus.reason
        : undefined;

    try {
      await deps.completeSearchRun(searchRun.id, {
        resultCount: searchResults,
        candidateCount: passed.length,
        newPostCount: persistenceResult.created,
        matchedPostCount: scoringResult.eligible,
        status: recordedStatus,
        errorMessage,
      });
    } catch (err) {
      logger.error('Failed to complete search run record', { error: err.message });
    }
  }

  logger.info('Radar run complete', {
    mode,
    success,
    queriesAttempted,
    queriesSucceeded,
    queriesFailed: failedQueries.length,
    failedQueries: failedQueries.map((f) => f.query),
    searchResults,
    uniqueResults,
    candidates: passed.length,
    classified: classificationResult.succeeded,
    qualified: scoringResult.eligible,
    saved: persistenceResult.created,
    notificationSent,
  });

  return {
    // ── Run contract ──
    success,
    // Which Phase 9 execution mode produced this summary.
    mode,
    queriesRun: queriesAttempted,
    searchResults,
    uniqueResults,
    candidates: passed.length,
    classified: classificationResult.succeeded,
    qualified: scoringResult.eligible,
    notificationSent,
    // ── Detail behind the contract ──
    ok: success,
    phase: delivery ? 7 : digest ? 6 : 5,
    status: pipelineStatus.status,
    statusReason: pipelineStatus.reason,
    dbReady,
    minRelevanceScore,
    recencyWindowHours,
    geminiSettings,
    runStartedAt: runStartedAt.toISOString(),
    search: {
      provider: activeProvider,
      queriesAttempted,
      queriesSucceeded,
      queriesFailed: failedQueries.length,
      failedQueries,
    },
    discovery,
    filtering: { passed: passed.length, rejected: rejected.length },
    classification: {
      succeeded: classificationResult.succeeded,
      failed: classificationResult.failed,
      totalUsage: classificationResult.totalUsage,
      failureReasons: classificationResult.failureReasons,
      infrastructureFailure: classificationResult.infrastructureFailure,
      skipped: classificationSkipped,
    },
    scoring: scoringResult,
    persistence: persistenceResult,
    digest: digest
      ? {
          source: digest.source,
          mock: digest.mock,
          empty: digest.empty,
          stats: digest.stats,
        }
      : null,
    notification: delivery,
  };
}

/**
 * Derives the run status for a digest-only invocation (Phase 9).
 *
 * A digest run performs no discovery, so `derivePipelineStatus` has nothing real
 * to report — it would describe a pipeline that never executed. This judges the
 * run on what it actually did.
 *
 * An empty digest is not a failure: there were no eligible posts, so there was
 * nothing to send. A *failed* delivery is a failure, and its posts stay unsent
 * for the next scheduled run.
 *
 * @param {Object} params
 * @param {boolean} params.dbReady
 * @param {object | null} params.delivery Phase 7 result, or null if never attempted.
 * @param {object | null} params.digest Phase 6 result, or null.
 * @returns {{ status: 'OPERATIONAL' | 'PARTIAL' | 'FAILED', reason: string }}
 */
export function deriveDigestRunStatus({ dbReady, delivery, digest }) {
  if (!dbReady) {
    return {
      status: 'PARTIAL',
      reason: 'Database not configured — the digest could not load stored posts',
    };
  }

  if (delivery?.attempted === true && delivery.success === false) {
    return {
      status: 'FAILED',
      reason: `Notification failed (${delivery.errorType}): ${delivery.error}`,
    };
  }

  if (delivery?.skipped) {
    return {
      status: 'OPERATIONAL',
      reason: `Nothing to deliver (${String(delivery.reason ?? 'no eligible posts').replace(/_/g, ' ')})`,
    };
  }

  if (delivery?.success === true) {
    return {
      status: 'OPERATIONAL',
      reason: `Digest delivered to ${delivery.markedCount ?? 0} post(s)`,
    };
  }

  return {
    status: 'PARTIAL',
    reason: digest ? 'Digest generated but no delivery was attempted' : 'No digest was generated',
  };
}

/**
 * Derives the honest run status.
 *
 * @param {Object} params
 * @param {boolean} params.dbReady
 * @param {number} params.passedCount
 * @param {string | null} params.classificationSkipped
 * @param {Object} params.classificationResult
 * @param {Object} params.scoringResult
 * @param {Object} params.persistenceResult
 * @param {number} [params.failedQueryCount=0] Search queries that failed. Coverage
 *   is incomplete even when everything downstream succeeds, so a run that lost a
 *   query is PARTIAL rather than OPERATIONAL.
 * @returns {{ status: 'OPERATIONAL' | 'PARTIAL' | 'FAILED', reason: string }}
 */
export function derivePipelineStatus({
  dbReady,
  passedCount,
  classificationSkipped,
  classificationResult,
  scoringResult,
  persistenceResult,
  failedQueryCount = 0,
}) {
  const attempted = passedCount > 0 && classificationSkipped === null;

  if (attempted && classificationResult.succeeded === 0) {
    const reasons = Object.keys(classificationResult.failureReasons || {});
    return {
      status: 'FAILED',
      reason: `Gemini classification produced 0 classifications${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`,
    };
  }

  if (failedQueryCount > 0) {
    return {
      status: 'PARTIAL',
      reason: `${failedQueryCount} search ${failedQueryCount === 1 ? 'query' : 'queries'} failed`,
    };
  }

  if (attempted && classificationResult.failed > 0) {
    return {
      status: 'PARTIAL',
      reason: `${classificationResult.succeeded} classified, ${classificationResult.failed} failed`,
    };
  }

  if (classificationSkipped === 'no candidates to classify') {
    return { status: 'OPERATIONAL', reason: 'No candidates passed keyword filtering — nothing to classify' };
  }

  if (classificationSkipped) {
    return { status: 'PARTIAL', reason: `Classification skipped: ${classificationSkipped}` };
  }

  if (passedCount > 0 && scoringResult.scored === 0) {
    return { status: 'PARTIAL', reason: 'Classification succeeded but nothing reached scoring' };
  }

  if (!dbReady) {
    return { status: 'PARTIAL', reason: 'Database not configured — dedup and persistence were skipped' };
  }

  if (persistenceResult.errors > 0) {
    return { status: 'PARTIAL', reason: `${persistenceResult.errors} persistence errors` };
  }

  return {
    status: 'OPERATIONAL',
    reason: `${scoringResult.scored} scored, ${persistenceResult.created} new posts saved`,
  };
}
