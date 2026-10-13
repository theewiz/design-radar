-- ==============================================================================
-- DesignRadar Migration: 004_notification_provider_ntfy.sql
-- Makes Phase 7 delivery state provider-neutral. ntfy is the only provider.
--
-- Migration 001 named the digest-sent flag after a provider before one was
-- chosen. The column answers a transport-agnostic question — "has this post
-- already been delivered in a digest?" — so only the name is wrong. It is
-- renamed rather than dropped so no already-delivered post can be re-sent: the
-- digest filter and the duplicate guard both read this flag, and dropping it
-- would silently reset that state.
--
--   sent_to_<legacy provider> → sent_to_digest  BOOLEAN NOT NULL DEFAULT false
--   idx_linkedin_posts_sent_to_<legacy provider> → idx_linkedin_posts_sent_to_digest
--
-- is_notified / notified_at / notification_channel are unchanged: they were
-- already provider-neutral, and notification_channel now records 'ntfy'.
-- ==============================================================================

DO $$
DECLARE
    legacy_column text;
BEGIN
    -- Locate the legacy provider-specific flag by shape, not by hard-coded name:
    -- the delivered-state boolean that is_notified already duplicates.
    SELECT column_name INTO legacy_column
    FROM information_schema.columns
    WHERE table_name = 'linkedin_posts'
      AND column_name IN ('sent_to_whatsapp', 'sent_to_messenger', 'sent_to_telegram')
    ORDER BY column_name
    LIMIT 1;

    IF legacy_column IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE linkedin_posts RENAME COLUMN %I TO sent_to_digest',
            legacy_column
        );

        COMMENT ON COLUMN linkedin_posts.sent_to_digest IS
            'True once this post has been delivered in a digest by any notification provider.';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_linkedin_posts_sent_to_digest
    ON linkedin_posts(sent_to_digest);

-- A publication default is not safe to touch here: renaming the column already
-- carries every stored value across, and rewriting is_notified could promote a
-- post that was recorded but never marked as delivered.
