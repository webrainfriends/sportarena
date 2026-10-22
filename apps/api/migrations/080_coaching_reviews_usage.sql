-- Coaching completion, part A (issue #269). Additive only.
-- When a session's review (summary) was first filed, so "time from session end to review" can be measured. Existing rows keep NULL (unknown).
ALTER TABLE coaching_session_records ADD COLUMN reviewed_at timestamptz;
