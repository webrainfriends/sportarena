-- Access approval: people who sign in with Google start as 'pending' (read-only) until the super admin approves them.
-- Every existing account is backfilled as 'approved' by the column default, so nobody loses access. Nothing is deleted.
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_status text NOT NULL DEFAULT 'approved' CHECK (access_status IN ('pending','approved','rejected'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_decided_by uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_decided_at timestamptz;
CREATE INDEX IF NOT EXISTS users_access_pending_idx ON users (created_at) WHERE access_status <> 'approved';
