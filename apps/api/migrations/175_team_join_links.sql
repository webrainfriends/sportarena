-- Instant team joining by shareable link or code (gaps audit, feature 4).
-- Additive only: new tables only.

CREATE TABLE IF NOT EXISTS team_join_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id),
  created_by uuid NOT NULL REFERENCES users(id),
  code text NOT NULL UNIQUE,
  mode text NOT NULL CHECK (mode IN ('open','request','role_specific')),
  role text NOT NULL DEFAULT 'player',
  max_uses int,
  used_count int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  age_min int,
  age_max int,
  guardian_required boolean NOT NULL DEFAULT false,
  federation_auto_register boolean NOT NULL DEFAULT false,
  federation_competition_id uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS team_join_links_code ON team_join_links(code) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS team_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES team_join_links(id),
  requester_id uuid NOT NULL REFERENCES users(id),
  managed_child_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  note_enc text,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(link_id, requester_id)
);

CREATE INDEX IF NOT EXISTS team_join_requests_link ON team_join_requests(link_id);
CREATE INDEX IF NOT EXISTS team_join_requests_requester ON team_join_requests(requester_id);

CREATE TABLE IF NOT EXISTS team_join_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES team_join_links(id),
  referrer_id uuid NOT NULL REFERENCES users(id),
  referred_id uuid NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now()
);
