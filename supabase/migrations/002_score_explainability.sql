-- ==============================================================================
-- DesignRadar Migration: 002_score_explainability.sql
-- Adds Phase 5 score explainability columns to linkedin_posts.
--
-- relevance_score alone does not record *why* a post scored what it did. These
-- columns keep the deterministic reasoning (PROJECT_SPEC §14) so a score can be
-- audited later without re-running the scorer.
--
--   score_explain   TEXT   — human-readable signal lines, e.g.
--                             "seniority: +30 (Senior)"
--   score_breakdown JSONB  — structured per-signal detail for querying
--
-- Both are nullable: posts written before this migration have no breakdown.
-- ==============================================================================

ALTER TABLE linkedin_posts
    ADD COLUMN IF NOT EXISTS score_explain TEXT,
    ADD COLUMN IF NOT EXISTS score_breakdown JSONB;

COMMENT ON COLUMN linkedin_posts.score_explain IS
    'Human-readable Phase 5 scoring rationale (§14), one signal per line.';

COMMENT ON COLUMN linkedin_posts.score_breakdown IS
    'Structured Phase 5 signal breakdown: [{signal, points, matched, capped}] (§14).';

-- Digest queries filter on status and unread state together; a composite index
-- avoids scanning every stale or already-notified post.
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_status_notified
    ON linkedin_posts(status, is_notified)
    WHERE is_notified = false;