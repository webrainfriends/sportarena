-- Player career & membership timeline (issue #311). Additive only: new tables, one new column, an idempotent backfill. Nothing is dropped or rewritten.
-- Canonical teams / organisations / sports / org_seasons stay authoritative; sport_profiles.club stays as the legacy display value.

CREATE TABLE IF NOT EXISTS career_memberships (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users,
  sport_id            uuid NOT NULL REFERENCES sports,
  team_id             uuid REFERENCES teams,
  organisation_id     uuid REFERENCES organisations,
  club_name           text CHECK (club_name IS NULL OR length(club_name) BETWEEN 2 AND 120),   -- only for a club that is not on the platform ("unlisted")
  org_season_id       uuid REFERENCES org_seasons,
  season_label        text CHECK (season_label IS NULL OR length(season_label) BETWEEN 2 AND 40),
  starts_on           date NOT NULL,
  ends_on             date,
  position            text CHECK (position IS NULL OR length(position) BETWEEN 1 AND 60),
  competition_level   text NOT NULL DEFAULT 'club' CHECK (competition_level IN ('grassroots','school','club','academy','regional','national','international','professional')),
  jersey_no           int CHECK (jersey_no IS NULL OR jersey_no BETWEEN 0 AND 999),
  source              text NOT NULL DEFAULT 'self' CHECK (source IN ('self','roster','staff','backfill')),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  verified_by         uuid REFERENCES users,
  verified_at         timestamptz,
  review_note         text CHECK (review_note IS NULL OR length(review_note) <= 500),
  row_version         int NOT NULL DEFAULT 1,
  idempotency_key     text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  created_by          uuid REFERENCES users,
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (team_id IS NOT NULL OR organisation_id IS NOT NULL OR club_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS career_memberships_user ON career_memberships (user_id, starts_on DESC, id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS career_memberships_team ON career_memberships (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS career_memberships_org ON career_memberships (organisation_id) WHERE organisation_id IS NOT NULL;
-- the same stint is never recorded twice (retries and double-taps are caught by the idempotency key; this catches a re-typed duplicate)
CREATE UNIQUE INDEX IF NOT EXISTS career_memberships_no_dupe ON career_memberships
  (user_id, sport_id, coalesce(team_id, organisation_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(coalesce(club_name, '')), starts_on) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS career_memberships_idem ON career_memberships (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- at most one open stint per roster team (the roster hook re-opens a new stint on re-join)
CREATE UNIQUE INDEX IF NOT EXISTS career_memberships_one_open_roster ON career_memberships (user_id, team_id) WHERE source = 'roster' AND ends_on IS NULL AND archived_at IS NULL;

-- Every create / correction / verification / archive keeps a snapshot, so corrections and former values are never lost.
CREATE TABLE IF NOT EXISTS career_membership_revisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES career_memberships,
  row_version   int NOT NULL,
  action        text NOT NULL CHECK (action IN ('created','corrected','ended','verification_requested','verified','rejected','archived','restored','roster_opened','roster_closed','backfilled')),
  snapshot      jsonb NOT NULL,
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_id      uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS career_membership_revisions_m ON career_membership_revisions (membership_id, created_at, id);

-- Affiliation evidence: the reference (letter number, registration id, link) is encrypted; decrypting it is audit-logged.
CREATE TABLE IF NOT EXISTS career_membership_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES career_memberships,
  kind          text NOT NULL CHECK (kind IN ('club_letter','registration_card','roster_listing','competition_record','other')),
  label         text CHECK (label IS NULL OR length(label) <= 120),
  reference_enc text NOT NULL,
  added_by      uuid REFERENCES users,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS career_membership_evidence_m ON career_membership_evidence (membership_id, created_at);

-- Passport links may include the career timeline (off unless the athlete turns it on).
ALTER TABLE passport_links ADD COLUMN IF NOT EXISTS show_career boolean NOT NULL DEFAULT false;

-- Backfill (idempotent): current/left roster rows and the legacy club text become unverified stints. Existing data is read, never changed.
INSERT INTO career_memberships(user_id, sport_id, team_id, starts_on, ends_on, position, jersey_no, source, created_by)
SELECT m.user_id, t.sport_id, m.team_id, m.joined_at::date, CASE WHEN m.status = 'left' THEN greatest(m.joined_at::date, current_date) END, m.position, m.jersey_no, 'roster', m.user_id
  FROM team_members m JOIN teams t ON t.id = m.team_id
 WHERE m.role IN ('captain','player') AND t.kind = 'master'
   AND NOT EXISTS (SELECT 1 FROM career_memberships c WHERE c.user_id = m.user_id AND c.team_id = m.team_id)
ON CONFLICT DO NOTHING;

INSERT INTO career_memberships(user_id, sport_id, club_name, starts_on, position, jersey_no, source, created_by)
SELECT p.user_id, p.sport_id, trim(p.club), p.created_at::date, p.position, p.jersey_no, 'backfill', p.user_id
  FROM sport_profiles p
 WHERE p.club IS NOT NULL AND length(trim(p.club)) >= 2
   AND NOT EXISTS (SELECT 1 FROM career_memberships c WHERE c.user_id = p.user_id AND c.sport_id = p.sport_id AND lower(coalesce(c.club_name, '')) = lower(trim(p.club)))
   AND NOT EXISTS (SELECT 1 FROM career_memberships c JOIN teams t ON t.id = c.team_id WHERE c.user_id = p.user_id AND c.sport_id = p.sport_id AND lower(t.name) = lower(trim(p.club)))
ON CONFLICT DO NOTHING;

INSERT INTO career_membership_revisions(membership_id, row_version, action, snapshot, actor_id)
SELECT c.id, c.row_version, 'backfilled', to_jsonb(c), NULL FROM career_memberships c
 WHERE c.source IN ('roster','backfill') AND NOT EXISTS (SELECT 1 FROM career_membership_revisions r WHERE r.membership_id = c.id);
