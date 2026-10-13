-- ==============================================================================
-- DesignRadar Migration: 003_notification_delivery.sql
-- Adds Phase 7 delivery columns to the notifications table.
--
-- The Phase 1 table can record that a digest was sent, but not *why a send
-- failed*. A failed delivery is the case that matters most: it is the reason
-- posts are deliberately left unsent so a later run retries them, and without a
-- normalized error_type that distinction is invisible in the audit trail.
--
--   error_type            TEXT — normalized provider error code, e.g.
--                             'authentication', 'rate_limit', 'malformed_response'.
--                             Never contains credentials.
--
-- The existing columns are reused as-is: provider, provider_message_id, status
-- ('sent' | 'failed'), error_message, sent_at, created_at.
-- ==============================================================================

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS error_type TEXT;

COMMENT ON COLUMN notifications.error_type IS
    'Normalized Phase 7 provider error code (NOTIFICATION_ERRORS in src/notifications/result.js).';

COMMENT ON COLUMN notifications.status IS
    'Delivery outcome: ''sent'' only after a provider confirmed acceptance, ''failed'' otherwise.';

COMMENT ON COLUMN notifications.error_message IS
    'Human-readable failure detail. Truncated and credential-scrubbed before storage.';

-- Duplicate protection asks "was this exact set of posts already delivered?".
-- A GIN index over the UUID array keeps that containment check off a table scan.
-- It is an all-of match, not any-of: a digest sharing one post with an earlier
-- digest still has posts the user has never seen.
CREATE INDEX IF NOT EXISTS idx_notifications_post_ids
    ON notifications USING GIN (post_ids);
