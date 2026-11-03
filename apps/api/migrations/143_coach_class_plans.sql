-- Coach class plans: a coach plans each class session, shares the plan with the people who hold a seat, and tracks how they get on.
-- It reuses the coaching journal (a session record per class, plan versions, attendance, observations, summaries); the only new fact is
-- which plan version the coach chose to share. Additive only: nothing is dropped, narrowed or deleted.
ALTER TABLE coaching_session_records ADD COLUMN IF NOT EXISTS plan_shared_version int;
ALTER TABLE coaching_session_records ADD COLUMN IF NOT EXISTS plan_shared_at timestamptz;
ALTER TABLE coaching_session_records ADD COLUMN IF NOT EXISTS plan_shared_by uuid REFERENCES users(id);
