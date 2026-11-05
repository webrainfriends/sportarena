-- Academy content licensing follow-up (#804): licensed items used in the coaching workflow.
-- Additive only. Rollback = deploy the previous build, which ignores the column. A link to a session is never deleted: unlinking sets unlinked_at.
ALTER TABLE academy_content_uses ADD COLUMN IF NOT EXISTS unlinked_at timestamptz;
CREATE INDEX IF NOT EXISTS academy_content_uses_session ON academy_content_uses (session_id) WHERE session_id IS NOT NULL;
