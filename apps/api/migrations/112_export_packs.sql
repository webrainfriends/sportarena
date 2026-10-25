-- Athlete season / career export packs (#332). Additive only: three new tables; no existing row, column or table is changed or removed.
-- A pack is a FROZEN, hash-stamped snapshot of what one person may see about one athlete for a calendar season or the whole career
-- (matches, results, goals, awards, career timeline, permitted coaching reports and an evidence summary). Private notes, health and wellness
-- data, contact details and date of birth are never part of a pack. Everything is read from the canonical tables at creation time; nothing
-- is copied back. The athlete (or a young person's verified guardian) builds packs for themselves; a coach gets one only through a revocable,
-- versioned share, and every later read/download of any pack re-checks the live relationship, consent and share.
-- Rollback = deploy the previous code: nothing else reads these tables and the data stays.
CREATE TABLE IF NOT EXISTS export_pack_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   uuid NOT NULL REFERENCES users,
  recipient_id uuid NOT NULL REFERENCES users,
  scope_kind   text NOT NULL CHECK (scope_kind IN ('season','career')),
  season_year  integer CHECK (season_year BETWEEN 1950 AND 2200),
  sport_id     uuid REFERENCES sports,
  sections     text[] NOT NULL CHECK (cardinality(sections) BETWEEN 1 AND 7 AND sections <@ ARRAY['matches','results','goals','awards','career','reports','evidence']),
  expires_at   timestamptz NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id <> recipient_id),
  CHECK ((scope_kind = 'season') = (season_year IS NOT NULL))
);
-- one live share per athlete and coach: a repeated create can never fork the permissions
CREATE UNIQUE INDEX IF NOT EXISTS export_pack_shares_live ON export_pack_shares (athlete_id, recipient_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS export_pack_shares_recipient ON export_pack_shares (recipient_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS export_pack_shares_athlete ON export_pack_shares (athlete_id, created_at DESC);

CREATE TABLE IF NOT EXISTS export_packs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES users,
  created_by      uuid NOT NULL REFERENCES users,
  share_id        uuid REFERENCES export_pack_shares,        -- set when a coach made it from a share
  scope_kind      text NOT NULL CHECK (scope_kind IN ('season','career')),
  season_year     integer CHECK (season_year BETWEEN 1950 AND 2200),
  sport_id        uuid REFERENCES sports,
  sections        text[] NOT NULL,
  report_ids      uuid[] NOT NULL DEFAULT '{}',
  snapshot        jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  client_key      text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 80),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_kind = 'season') = (season_year IS NOT NULL))
);
-- a retried request with the same key returns the original pack instead of a second one
CREATE UNIQUE INDEX IF NOT EXISTS export_packs_key ON export_packs (created_by, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS export_packs_athlete ON export_packs (athlete_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS export_packs_creator ON export_packs (created_by, created_at DESC, id);

CREATE OR REPLACE FUNCTION export_packs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'export_packs are immutable: create a new pack instead'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS export_packs_immutable ON export_packs;
CREATE TRIGGER export_packs_immutable BEFORE UPDATE OR DELETE ON export_packs FOR EACH ROW EXECUTE FUNCTION export_packs_immutable();

-- append-only history the athlete (and guardian) can read: who was given what, every edit, every revoke, every view and download
CREATE TABLE IF NOT EXISTS export_pack_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id uuid NOT NULL REFERENCES users,
  actor_id   uuid REFERENCES users,
  share_id   uuid REFERENCES export_pack_shares,
  pack_id    uuid REFERENCES export_packs,
  action     text NOT NULL CHECK (action IN ('granted','updated','revoked','expired','created','viewed','csv','pdf')),
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS export_pack_events_athlete ON export_pack_events (athlete_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS export_pack_events_share ON export_pack_events (share_id, created_at DESC);
CREATE INDEX IF NOT EXISTS export_pack_events_pack ON export_pack_events (pack_id, created_at DESC);
CREATE OR REPLACE FUNCTION export_pack_events_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'export_pack_events are append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS export_pack_events_append_only ON export_pack_events;
CREATE TRIGGER export_pack_events_append_only BEFORE UPDATE OR DELETE ON export_pack_events FOR EACH ROW EXECUTE FUNCTION export_pack_events_append_only();
