-- Player passport share links: an athlete-controlled, expiring, revocable link to a read-only athlete CV for coaches and scouts.
-- Additive. Only a hash of the secret is stored (the token is shown once). Revoking sets revoked_at; rows are never deleted.
CREATE TABLE IF NOT EXISTS passport_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users,
  token_hash     text NOT NULL UNIQUE,
  label          text,
  show_matches   boolean NOT NULL DEFAULT true,
  show_results   boolean NOT NULL DEFAULT true,
  show_awards    boolean NOT NULL DEFAULT true,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  view_count     integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS passport_links_user ON passport_links (user_id, created_at DESC);
