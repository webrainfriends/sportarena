-- Settlement schedules: keep the sweep's recent failures on the schedule row (the process sweep logs a failed run here and skips to the next schedule).
-- Additive and idempotent.
ALTER TABLE settlement_schedules ADD COLUMN IF NOT EXISTS error_log jsonb NOT NULL DEFAULT '[]'::jsonb;
