BEGIN;
CREATE TABLE IF NOT EXISTS clinician_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('pain_spike','missed_sessions','symptom_deterioration','review_due','flareup_triggered','intake_flagged')),
  trigger_data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','acknowledged','actioned','resolved')),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  resolution_note text,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinician_alerts_dedupe
  ON clinician_alerts(provider_id, patient_id, kind, dedupe_key)
  WHERE status NOT IN ('resolved');
CREATE INDEX IF NOT EXISTS clinician_alerts_provider_new_idx ON clinician_alerts(provider_id) WHERE status = 'new';
COMMIT;
