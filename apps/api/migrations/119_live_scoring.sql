-- Sport-specific live scoring engine (#500). Additive: nothing is dropped, rewritten or narrowed.
--  * match_events stay the authoritative log. A correction never edits or deletes an event: it voids the old one and records a
--    replacement that points back at it (supersedes_id) and keeps its place in the game (position_seq), with the authority it came from.
--  * match_event_revisions is an append-only audit of every void/correction (who, as what, why, before/after).
--  * fixture_scorer_leases is an advisory "who is scoring" hint for the UI; the database row lock stays the authority.
--  * session_events is the same append-only live log for heats, finals and field flights (athletics, swimming …).

ALTER TABLE match_events
  ADD COLUMN IF NOT EXISTS supersedes_id    uuid REFERENCES match_events(id),
  ADD COLUMN IF NOT EXISTS position_seq     int,
  ADD COLUMN IF NOT EXISTS source_authority text CHECK (source_authority IS NULL OR source_authority IN ('organiser','official','admin'));
CREATE INDEX IF NOT EXISTS match_events_supersedes ON match_events (supersedes_id) WHERE supersedes_id IS NOT NULL;

-- The facts of an event are never edited and an event is never deleted; only its void marks may change.
CREATE OR REPLACE FUNCTION match_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'match events are never deleted; void them with a reason'; END IF;
  IF NEW.fixture_id IS DISTINCT FROM OLD.fixture_id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.side IS DISTINCT FROM OLD.side OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.period IS DISTINCT FROM OLD.period OR NEW.clock_seconds IS DISTINCT FROM OLD.clock_seconds OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.position_seq IS DISTINCT FROM OLD.position_seq THEN
    RAISE EXCEPTION 'a recorded match event cannot be edited; void it and record a correction';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS match_event_guard ON match_events;
CREATE TRIGGER match_event_guard BEFORE UPDATE OR DELETE ON match_events FOR EACH ROW EXECUTE FUNCTION match_event_guard();

CREATE TABLE IF NOT EXISTS match_event_revisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id     uuid NOT NULL REFERENCES fixtures,
  match_event_id uuid NOT NULL REFERENCES match_events(id),
  replacement_id uuid REFERENCES match_events(id),
  action         text NOT NULL CHECK (action IN ('void','correct')),
  authority      text NOT NULL CHECK (authority IN ('organiser','official','admin')),
  reason         text NOT NULL,
  before         jsonb NOT NULL,
  after          jsonb,
  actor_id       uuid NOT NULL REFERENCES users,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_event_revisions_fixture ON match_event_revisions (fixture_id, at);
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'this history is append-only'; END $$;
DROP TRIGGER IF EXISTS match_event_revisions_append_only ON match_event_revisions;
CREATE TRIGGER match_event_revisions_append_only BEFORE UPDATE OR DELETE ON match_event_revisions FOR EACH ROW EXECUTE FUNCTION append_only();

CREATE TABLE IF NOT EXISTS fixture_scorer_leases (
  fixture_id uuid PRIMARY KEY REFERENCES fixtures,
  user_id    uuid NOT NULL REFERENCES users,
  device     text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES event_sessions,
  event_id      uuid NOT NULL REFERENCES events,
  seq           int  NOT NULL,
  client_key    text,
  kind          text NOT NULL CHECK (kind IN ('status','start','lane','split','finish','attempt','judge_score','entry_status')),
  entry_id      uuid REFERENCES event_session_entries,
  payload       jsonb NOT NULL DEFAULT '{}',
  source_authority text CHECK (source_authority IS NULL OR source_authority IN ('organiser','official','admin')),
  recorded_by   uuid NOT NULL REFERENCES users,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  voided_by     uuid REFERENCES users,
  void_reason   text,
  UNIQUE (session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS session_events_client_key ON session_events (session_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_events_event ON session_events (event_id);
CREATE OR REPLACE FUNCTION session_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'session events are never deleted; void them with a reason'; END IF;
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.entry_id IS DISTINCT FROM OLD.entry_id OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by THEN
    RAISE EXCEPTION 'a recorded session event cannot be edited; void it and record it again';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS session_event_guard ON session_events;
CREATE TRIGGER session_event_guard BEFORE UPDATE OR DELETE ON session_events FOR EACH ROW EXECUTE FUNCTION session_event_guard();

-- How live marks add up and who goes through, pinned by the organiser for a discipline: aggregate (best | sum | panel), lower_is_better,
-- drop_extremes, qualifiers_per_session + wildcards (heats), cut_after_round + cut_to (field). The live session view uses this and the sport's
-- family default; Q/q and the field cut show only from here. NULL = nothing pinned (the family default applies, no progression is shown).
ALTER TABLE event_disciplines ADD COLUMN IF NOT EXISTS live_rules jsonb;

-- A session whose official result was recorded again after it was completed is shown publicly as corrected. NULL = never corrected.
ALTER TABLE event_sessions ADD COLUMN IF NOT EXISTS corrected_at timestamptz;
