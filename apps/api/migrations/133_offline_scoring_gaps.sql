-- Offline scoring, remaining gaps (#637). Additive: nothing is dropped, rewritten or narrowed; every column is nullable.
--  * occurred_at on match_events / session_events: when the official really pressed the button on a device that sent it later
--    (bounded by the server to the last 24 h, never in the future). recorded_at stays the server's own time.
--  * client_key on a void: a void sent twice after a lost reply acts once (match: on the append-only revision row; session: on the event).
ALTER TABLE match_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS void_client_key text;
ALTER TABLE match_event_revisions ADD COLUMN IF NOT EXISTS client_key text;
CREATE UNIQUE INDEX IF NOT EXISTS match_event_revisions_client_key ON match_event_revisions (fixture_id, client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS session_events_void_client_key ON session_events (session_id, void_client_key) WHERE void_client_key IS NOT NULL;

-- A recorded event's time is a fact like the rest of it: occurred_at may be set at insert, never edited.
CREATE OR REPLACE FUNCTION match_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'match events are never deleted; void them with a reason'; END IF;
  IF NEW.fixture_id IS DISTINCT FROM OLD.fixture_id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.side IS DISTINCT FROM OLD.side OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.period IS DISTINCT FROM OLD.period OR NEW.clock_seconds IS DISTINCT FROM OLD.clock_seconds OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.position_seq IS DISTINCT FROM OLD.position_seq
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'a recorded match event cannot be edited; void it and record a correction';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION session_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'session events are never deleted; void them with a reason'; END IF;
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.entry_id IS DISTINCT FROM OLD.entry_id OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'a recorded session event cannot be edited; void it and record it again';
  END IF;
  RETURN NEW;
END $$;
