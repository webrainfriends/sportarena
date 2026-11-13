BEGIN;
CREATE TABLE IF NOT EXISTS physio_flareup_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid REFERENCES users(id),
  treatment_plan_id uuid REFERENCES treatment_plans(id),
  reported_at timestamptz NOT NULL DEFAULT now(),
  pain_scale integer CHECK (pain_scale BETWEEN 0 AND 10),
  region text,
  description_enc text NOT NULL,
  triggers_enc text,
  action_taken text,
  resolved_at timestamptz,
  resolution_notes_enc text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS physio_flareup_patient_idx ON physio_flareup_reports(patient_id);
CREATE INDEX IF NOT EXISTS physio_flareup_provider_idx ON physio_flareup_reports(provider_id) WHERE provider_id IS NOT NULL;
COMMIT;
