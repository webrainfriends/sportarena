-- External verified league and federation history (#323). Additive only: new tables, new nullable columns, two CHECK lists widened. Nothing is dropped, rewritten or narrowed.
-- The career timeline (#311) stays the one place a player's history lives; this adds the approved sources that can confirm entries on it, the staged records they send,
-- the identity links that tie an outside person id to a player, and the provenance of every entry they touch.

-- A source is a league or federation whose records may confirm career entries. It must be approved by the platform team before anything it sends is used.
-- adapter 'api_json' = Gotmygame pulls the source's HTTPS feed; 'file_import' = the body's own staff upload an export (honest fallback, never labelled "live").
CREATE TABLE IF NOT EXISTS external_feed_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  kind             text NOT NULL CHECK (kind IN ('federation','league')),
  adapter          text NOT NULL CHECK (adapter IN ('api_json','file_import')),
  sport_id         uuid REFERENCES sports,                         -- null = several sports; each record then names its sport
  body_id          uuid REFERENCES governing_bodies,               -- the on-platform body whose staff run this source; null = platform team runs it
  endpoint_url     text CHECK (endpoint_url IS NULL OR length(endpoint_url) <= 500),
  secret_enc       text,                                           -- bearer token for the feed, encrypted; never returned
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended')),
  decided_by       uuid REFERENCES users,
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  cursor           text,
  last_sync_at     timestamptz,
  last_sync_status text CHECK (last_sync_status IS NULL OR last_sync_status IN ('ok','partial','failed')),
  last_sync_error  text CHECK (last_sync_error IS NULL OR length(last_sync_error) <= 300),
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid REFERENCES users,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (adapter <> 'api_json' OR endpoint_url IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS external_feed_sources_name ON external_feed_sources (lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS external_feed_sources_body ON external_feed_sources (body_id) WHERE body_id IS NOT NULL;

-- One row per pull or file import. The checksum makes a re-sent file a harmless replay.
CREATE TABLE IF NOT EXISTS external_history_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES external_feed_sources,
  mode        text NOT NULL CHECK (mode IN ('feed','file')),
  checksum    text,
  received    int NOT NULL DEFAULT 0,
  created     int NOT NULL DEFAULT 0,
  updated     int NOT NULL DEFAULT 0,
  unchanged   int NOT NULL DEFAULT 0,
  failed      int NOT NULL DEFAULT 0,
  errors      jsonb NOT NULL DEFAULT '[]',
  status      text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','partial','failed')),
  started_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS external_history_batches_checksum ON external_history_batches (source_id, checksum) WHERE checksum IS NOT NULL;
CREATE INDEX IF NOT EXISTS external_history_batches_source ON external_history_batches (source_id, created_at DESC);

-- Who an outside person id is on Gotmygame. A player (or guardian) claims it; the source's staff confirm it. Revoking keeps the row.
CREATE TABLE IF NOT EXISTS external_identities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users,
  source_id      uuid NOT NULL REFERENCES external_feed_sources,
  ref_idx        text NOT NULL,                                    -- blind index of the source's person id
  ref_enc        text NOT NULL,
  status         text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','confirmed','revoked')),
  claimed_by     uuid REFERENCES users,
  confirmed_by   uuid REFERENCES users,
  confirmed_at   timestamptz,
  revoked_at     timestamptz,
  row_version    int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- one live holder per outside id, one live link per player per source person id
CREATE UNIQUE INDEX IF NOT EXISTS external_identities_one_holder ON external_identities (source_id, ref_idx) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS external_identities_user ON external_identities (user_id) WHERE status <> 'revoked';

-- What the source sent, staged. Nothing here is shown on a timeline until a reviewer accepts it. Name / licence number are encrypted; the raw record is kept (encrypted).
CREATE TABLE IF NOT EXISTS external_history_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id        uuid NOT NULL REFERENCES external_feed_sources,
  external_ref     text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 120),
  person_ref_idx   text,
  person_ref_enc   text,
  person_name_enc  text,
  person_name_idx  text,                                           -- blind index of the normalised name, used only to suggest candidates to a reviewer
  licence_idx      text,
  licence_enc      text,
  sport_id         uuid NOT NULL REFERENCES sports,
  club_name        text NOT NULL CHECK (length(club_name) BETWEEN 2 AND 120),
  season_label     text CHECK (season_label IS NULL OR length(season_label) BETWEEN 2 AND 40),
  starts_on        date NOT NULL,
  ends_on          date,
  position         text CHECK (position IS NULL OR length(position) BETWEEN 1 AND 60),
  competition_level text CHECK (competition_level IS NULL OR competition_level IN ('grassroots','school','club','academy','regional','national','international','professional')),
  jersey_no        int CHECK (jersey_no IS NULL OR jersey_no BETWEEN 0 AND 999),
  withdrawn        boolean NOT NULL DEFAULT false,
  payload_hash     text NOT NULL,
  payload_enc      text NOT NULL,
  version          int NOT NULL DEFAULT 1,
  via              text NOT NULL CHECK (via IN ('feed','file')),
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','rejected','disputed','changed','withdrawn')),
  user_id          uuid REFERENCES users,                          -- who it is about, once resolved
  match_method     text CHECK (match_method IS NULL OR match_method IN ('identity','licence','manual')),
  membership_id    uuid REFERENCES career_memberships,
  decided_by       uuid REFERENCES users,
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  batch_id         uuid REFERENCES external_history_batches,
  row_version      int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
-- the same outside record is never staged twice: a re-delivery becomes a new version of this row
CREATE UNIQUE INDEX IF NOT EXISTS external_history_records_ref ON external_history_records (source_id, external_ref);
CREATE INDEX IF NOT EXISTS external_history_records_queue ON external_history_records (source_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS external_history_records_user ON external_history_records (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS external_history_records_person ON external_history_records (source_id, person_ref_idx) WHERE person_ref_idx IS NOT NULL;

-- Every delivery of a record, so a correction from the source never overwrites what was first received.
CREATE TABLE IF NOT EXISTS external_history_record_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id    uuid NOT NULL REFERENCES external_history_records,
  version      int NOT NULL,
  payload_hash text NOT NULL,
  payload_enc  text NOT NULL,
  batch_id     uuid REFERENCES external_history_batches,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, version)
);

-- The reviewer's club choice is remembered, so the next record from the same source for the same club resolves to the same team / organisation.
CREATE TABLE IF NOT EXISTS external_club_aliases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES external_feed_sources,
  alias           text NOT NULL,                                   -- lower-cased, whitespace-collapsed club name as the source writes it
  team_id         uuid REFERENCES teams,
  organisation_id uuid REFERENCES organisations,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((team_id IS NOT NULL) <> (organisation_id IS NOT NULL)),
  UNIQUE (source_id, alias)
);

-- Provenance on the timeline entry itself. NULL verified_via on a verified row means the club's own staff verified it (#311).
ALTER TABLE career_memberships ADD COLUMN IF NOT EXISTS external_record_id uuid REFERENCES external_history_records;
ALTER TABLE career_memberships ADD COLUMN IF NOT EXISTS verified_via text;
UPDATE career_memberships SET verified_via = 'club' WHERE verification_status = 'verified' AND verified_via IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS career_memberships_one_external ON career_memberships (external_record_id) WHERE external_record_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'career_memberships_verified_via_check') THEN
    ALTER TABLE career_memberships ADD CONSTRAINT career_memberships_verified_via_check CHECK (verified_via IS NULL OR verified_via IN ('club','external_feed','external_file'));
  END IF;
END $$;

-- Widen (never narrow) the two lists the new flow needs.
ALTER TABLE career_memberships DROP CONSTRAINT IF EXISTS career_memberships_source_check;
ALTER TABLE career_memberships ADD CONSTRAINT career_memberships_source_check CHECK (source IN ('self','roster','staff','backfill','external'));
ALTER TABLE career_membership_revisions DROP CONSTRAINT IF EXISTS career_membership_revisions_action_check;
ALTER TABLE career_membership_revisions ADD CONSTRAINT career_membership_revisions_action_check CHECK (action IN
  ('created','corrected','ended','verification_requested','verified','rejected','archived','restored','roster_opened','roster_closed','backfilled',
   'external_linked','external_merged','external_updated','external_disputed','external_withdrawn'));
