-- Event lifecycle: an event can be paused and resumed while it runs, and every status change is kept in a history.
-- Additive: two CHECK constraints are only widened, new columns are nullable/defaulted, no row is changed or removed.

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN ('draft','open','ongoing','paused','completed','cancelled'));
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reason text,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_by uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS status_changed_by uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;

-- Match states the live console needs. Games the event pauses are flagged so resume only restores those.
ALTER TABLE fixtures DROP CONSTRAINT IF EXISTS fixtures_status_check;
ALTER TABLE fixtures ADD CONSTRAINT fixtures_status_check
  CHECK (status IN ('scheduled','live','paused','completed','cancelled','postponed','abandoned'));
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS paused_by_event boolean NOT NULL DEFAULT false;

-- Who moved the event from one status to another, when and why. Written by a trigger so no code path can skip it.
CREATE TABLE IF NOT EXISTS event_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  from_status text,
  to_status   text NOT NULL,
  actor_id    uuid REFERENCES users,
  reason      text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_status_history_event ON event_status_history (event_id, at);

CREATE OR REPLACE FUNCTION log_event_status() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO event_status_history(event_id, from_status, to_status, actor_id, reason)
    VALUES (NEW.id, OLD.status, NEW.status,
            CASE WHEN NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at THEN NEW.status_changed_by END,
            CASE WHEN NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at THEN NEW.status_reason END);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS events_status_log ON events;
CREATE TRIGGER events_status_log AFTER UPDATE OF status ON events FOR EACH ROW EXECUTE FUNCTION log_event_status();
