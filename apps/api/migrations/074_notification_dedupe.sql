-- Idempotent business notifications: a retried request or a notify.retry job re-using the same dedupe_key for the same
-- recipient yields one logical notification. Additive and nullable; existing rows are untouched.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
