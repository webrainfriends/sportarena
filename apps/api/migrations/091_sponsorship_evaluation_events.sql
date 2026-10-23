-- Evaluation history gets its own table (#288). Migration 090 declared `sponsorship_application_events`, but the application-forms
-- migration (089) already owns a table of that name with a different shape (and a CHECK on `kind`), so 090's CREATE TABLE IF NOT EXISTS
-- was a no-op and evaluation events could not be written. Purely additive: nothing is dropped, rewritten or deleted, and 089's table
-- is not touched. Rollback = deploy the previous code (the new table is simply unused).
CREATE TABLE IF NOT EXISTS sponsorship_evaluation_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  kind           text NOT NULL,
  actor_id       uuid REFERENCES users,
  data           jsonb NOT NULL DEFAULT '{}',  -- never score values
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_evaluation_events_application ON sponsorship_evaluation_events (application_id, created_at, id);
