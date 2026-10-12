-- Append-only status history for health appointments and coaching hires (one shared table).
-- Rows are written by triggers on the two tables so no code path can skip them; the capability only tells the
-- trigger who acted and why through transaction-local settings (app.actor_id, app.reason_enc).
-- The reason is stored encrypted (it can mention health details). Additive: no existing row is changed.

CREATE TABLE IF NOT EXISTS engagement_status_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigserial NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('appointment','hire')),
  subject_id     uuid NOT NULL,
  from_status    text,
  to_status      text NOT NULL,
  actor_id       uuid REFERENCES users,          -- NULL = the system (expiry sweep) or a pre-history backfill
  reason_enc     text,
  payment_status text,
  backfilled     boolean NOT NULL DEFAULT false,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS engagement_status_history_subject ON engagement_status_history (kind, subject_id, at, seq);

CREATE OR REPLACE FUNCTION engagement_history_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'engagement_status_history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS engagement_history_no_change ON engagement_status_history;
CREATE TRIGGER engagement_history_no_change BEFORE UPDATE OR DELETE ON engagement_status_history
  FOR EACH ROW EXECUTE FUNCTION engagement_history_immutable();
DROP TRIGGER IF EXISTS engagement_history_no_truncate ON engagement_status_history;
CREATE TRIGGER engagement_history_no_truncate BEFORE TRUNCATE ON engagement_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION engagement_history_immutable();

CREATE OR REPLACE FUNCTION log_engagement_status() RETURNS trigger AS $$
DECLARE
  actor  uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  reason text := nullif(current_setting('app.reason_enc', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO engagement_status_history(kind, subject_id, from_status, to_status, actor_id, reason_enc, payment_status, at)
    VALUES (TG_ARGV[0], NEW.id, NULL, NEW.status,
            coalesce(actor, (to_jsonb(NEW) ->> 'athlete_id')::uuid, (to_jsonb(NEW) ->> 'hirer_id')::uuid), reason, NEW.payment_status, now());
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO engagement_status_history(kind, subject_id, from_status, to_status, actor_id, reason_enc, payment_status, at)
    VALUES (TG_ARGV[0], NEW.id, OLD.status, NEW.status, actor, reason, NEW.payment_status, now());
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_status_history ON appointments;
CREATE TRIGGER appointments_status_history AFTER INSERT OR UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION log_engagement_status('appointment');
DROP TRIGGER IF EXISTS coach_hires_status_history ON coach_hires;
CREATE TRIGGER coach_hires_status_history AFTER INSERT OR UPDATE OF status ON coach_hires
  FOR EACH ROW EXECUTE FUNCTION log_engagement_status('hire');

-- Existing rows get one initial entry carrying their current status so every timeline starts somewhere.
INSERT INTO engagement_status_history(kind, subject_id, from_status, to_status, actor_id, payment_status, backfilled, at)
SELECT 'appointment', a.id, NULL, a.status, NULL, a.payment_status, true, a.created_at FROM appointments a
 WHERE NOT EXISTS (SELECT 1 FROM engagement_status_history h WHERE h.kind='appointment' AND h.subject_id=a.id);
INSERT INTO engagement_status_history(kind, subject_id, from_status, to_status, actor_id, payment_status, backfilled, at)
SELECT 'hire', c.id, NULL, c.status, NULL, c.payment_status, true, c.created_at FROM coach_hires c
 WHERE NOT EXISTS (SELECT 1 FROM engagement_status_history h WHERE h.kind='hire' AND h.subject_id=c.id);
