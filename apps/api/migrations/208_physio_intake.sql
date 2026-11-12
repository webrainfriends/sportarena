BEGIN;
CREATE TABLE IF NOT EXISTS physio_intake_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES appointments(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  chief_complaint_enc text,
  pain_scale integer CHECK (pain_scale BETWEEN 0 AND 10),
  pain_locations jsonb NOT NULL DEFAULT '[]',
  onset_date date,
  mechanism text,
  aggravating_factors_enc text,
  relieving_factors_enc text,
  previous_treatment_enc text,
  medications_enc text,
  red_flags jsonb NOT NULL DEFAULT '[]',
  functional_goals_enc text,
  sport text,
  training_load_hrs_week numeric(4,1),
  consent_given boolean NOT NULL DEFAULT false,
  consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS physio_intake_forms_patient_idx ON physio_intake_forms(patient_id);
CREATE INDEX IF NOT EXISTS physio_intake_forms_provider_idx ON physio_intake_forms(provider_id);
COMMIT;
