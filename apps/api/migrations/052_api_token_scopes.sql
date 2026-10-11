-- Scoped, expiring, resource-restricted API tokens (issue #60, gap 1a). Additive only.
-- Existing tokens are DELIBERATELY migrated to the visible legacy scope 'full' (they keep working exactly as before:
-- everything the owner may do). 'full' can never be requested for a new token and a token's scopes are never edited in place,
-- so a token can't be silently widened; to narrow it, revoke and create a new one.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT ARRAY['full']::text[];
-- New tokens must state their scopes; the safe default for a token created without any is read-only.
ALTER TABLE api_tokens ALTER COLUMN scopes SET DEFAULT ARRAY['read']::text[];
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- [{ "type": "venue|team|event|organisation", "id": "<uuid>" }]; empty = not resource-restricted.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS resources jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_scopes_known
  CHECK (scopes <@ ARRAY['read','write','payment','clinical','admin','full']::text[] AND cardinality(scopes) > 0);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id, created_at DESC);
