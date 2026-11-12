BEGIN;
CREATE TABLE IF NOT EXISTS physio_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  treatment_plan_id uuid REFERENCES treatment_plans(id),
  reminder_type text NOT NULL DEFAULT 'exercise',
  message_enc text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  acknowledged_at timestamptz,
  recurrence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS physio_reminders_patient_idx ON physio_reminders(patient_id);
CREATE INDEX IF NOT EXISTS physio_reminders_provider_idx ON physio_reminders(provider_id);
CREATE INDEX IF NOT EXISTS physio_reminders_scheduled_idx ON physio_reminders(scheduled_for) WHERE sent_at IS NULL AND archived_at IS NULL;
COMMIT;
