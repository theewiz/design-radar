/**
 * DesignRadar entry point.
 *
 * The pipeline itself lives in `src/radar/`. This module keeps the historical
 * import surface working and owns the CLI argument handling:
 *
 *   node src/index.js           Full pipeline: scan → digest → notify
 *   node src/index.js --scan    Scan only, skipping digest and delivery
 *   node src/index.js --digest  Digest and delivery only, reusing stored posts
 */

import dotenv from 'dotenv';
import { isDatabaseConfigured } from './database/supabase.js';
import {
  normalizeLinkedInUrl,
  isLinkedInPostUrl,
  normalizeJobUrl,
  isJobPostingUrl,
  identifyJobSource,
  JOB_SOURCES,
  normalizeGreenhouseUrl,
  isGreenhouseJobUrl,
  normalizeAshbyUrl,
  isAshbyJobUrl,
  normalizeLeverUrl,
  isLeverJobUrl,
} from './utils/normalize-url.js';
import { sha256, createContentFingerprint } from './utils/hash.js';
import { logger } from './utils/logger.js';
import {
  searchWeb,
  searchWebBatch,
  generateSearchQueries,
  generateMultiSourceSearchQueries,
  generateSearchQueriesForSource,
  TARGET_DOMAINS,
  ALL_TARGET_DOMAINS,
  SOURCE_NAMES,
  ROLE_TERMS,
  BROAD_ROLE_TERM,
  HIRING_SIGNALS,
  DOMAIN_TERMS,
  filterCandidates,
  passesKeywordFilter,
} from './search/index.js';
import { runDiscovery } from './discovery/index.js';
import {
  resolveProfileSeniority,
  isConfidenceExemptRole,
  isJuniorRole,
  matchUnlevelledTitle,
  PROFILE_SENIORITY,
  UNLEVELLED_PRODUCT_DESIGN_TITLES,
} from './profile/role-policy.js';
import { classifyCandidates, meetsConfidenceThreshold, getGeminiSettings } from './ai/classify.js';
import { scorePost, DEFAULT_MIN_RELEVANCE_SCORE } from './ai/score.js';
import { generateDigest, resolveLookbackHours } from './notifications/digest.js';
import { buildMockPosts } from './notifications/mock-posts.js';
import {
  assertNotificationSettings,
  createNotifier,
  deliverDigest,
  describeNotificationSettings,
  resolveNotificationSettings,
} from './notifications/index.js';
import {
  evaluateCandidate,
  evaluateRecency,
  resolvePostStatus,
  parsePublishedAt,
  RECENCY_WINDOW_HOURS,
  RECENT_PIVOT_HOURS,
  isWithinValidityWindow,
} from './filtering/status.js';
import {
  createSearchRun,
  completeSearchRun,
  findPostByUrl,
  createPost,
  createPosts,
  buildPostRow,
  markPostAsSent,
  getUnsentPosts,
  getPostsFromLast24Hours,
  getDigestCandidates,
  postExistsByUrl,
  findExistingUrls,
} from './database/posts.js';
import { runRadar, derivePipelineStatus, deriveDigestRunStatus, resolveRunMode, RADAR_MODES } from './radar/index.js';
import { runDigest, notifyDigest, runDigestAndNotify } from './notifications/pipeline.js';

// Load environment configuration
dotenv.config();

export {
  // Database
  isDatabaseConfigured,
  createSearchRun,
  completeSearchRun,
  findPostByUrl,
  createPost,
  createPosts,
  buildPostRow,
  markPostAsSent,
  getUnsentPosts,
  getPostsFromLast24Hours,
  getDigestCandidates,
  postExistsByUrl,
  findExistingUrls,
  // Utilities
  normalizeLinkedInUrl,
  isLinkedInPostUrl,
  normalizeJobUrl,
  isJobPostingUrl,
  identifyJobSource,
  JOB_SOURCES,
  normalizeGreenhouseUrl,
  isGreenhouseJobUrl,
  normalizeAshbyUrl,
  isAshbyJobUrl,
  normalizeLeverUrl,
  isLeverJobUrl,
  sha256,
  createContentFingerprint,
  logger,
  // Search
  searchWeb,
  searchWebBatch,
  generateSearchQueries,
  generateMultiSourceSearchQueries,
  generateSearchQueriesForSource,
  TARGET_DOMAINS,
  ALL_TARGET_DOMAINS,
  SOURCE_NAMES,
  filterCandidates,
  passesKeywordFilter,
  // Discovery
  runDiscovery,
  // AI Classification
  classifyCandidates,
  meetsConfidenceThreshold,
  // AI Scoring
  scorePost,
  DEFAULT_MIN_RELEVANCE_SCORE,
  // Profile role policy
  resolveProfileSeniority,
  isConfidenceExemptRole,
  isJuniorRole,
  matchUnlevelledTitle,
  PROFILE_SENIORITY,
  UNLEVELLED_PRODUCT_DESIGN_TITLES,
  // AI Classification settings
  getGeminiSettings,
  // Recency + Status
  evaluateCandidate,
  evaluateRecency,
  resolvePostStatus,
  parsePublishedAt,
  RECENCY_WINDOW_HOURS,
  RECENT_PIVOT_HOURS,
  isWithinValidityWindow,
  // Constants
  ROLE_TERMS,
  BROAD_ROLE_TERM,
  HIRING_SIGNALS,
  DOMAIN_TERMS,
  // Digest + Notification (Phases 6 + 7)
  generateDigest,
  resolveLookbackHours,
  buildMockPosts,
  assertNotificationSettings,
  createNotifier,
  deliverDigest,
  describeNotificationSettings,
  resolveNotificationSettings,
  runDigest,
  notifyDigest,
  runDigestAndNotify,
  // Radar pipeline (Phase 8)
  runRadar,
  derivePipelineStatus,
  // Radar scheduling (Phase 9)
  deriveDigestRunStatus,
  resolveRunMode,
  RADAR_MODES,
};

// Execute when invoked directly from CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^[A-Za-z]:/, ''))) {
  const args = process.argv.slice(2);
  const wantsScanOnly = args.includes('--scan') || args.includes('scan');
  const wantsDigestOnly = args.includes('--digest') || args.includes('digest');

  const mode = wantsScanOnly
    ? { label: 'scan', run: () => runRadar({ digest: false }) }
    : wantsDigestOnly
      ? { label: 'digest', run: () => runDigestAndNotify() }
      : { label: 'full pipeline', run: () => runRadar() };

  mode
    .run()
    .then((result) => {
      if (wantsDigestOnly && result.empty) {
        logger.info(
          `No new qualified opportunities in the last ${result.stats.window_hours} hours.`
        );
      }
    })
    .catch((err) => {
      logger.error(`Fatal error running DesignRadar ${mode.label}:`, {
        error: err.message,
      });
      process.exit(1);
    });
}
