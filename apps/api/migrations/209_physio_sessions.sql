BEGIN;
CREATE TABLE IF NOT EXISTS physio_session_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES appointments(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  session_date date NOT NULL,
  duration_min integer NOT NULL DEFAULT 30,
  subjective_enc text,
  objective_enc text,
  assessment_enc text,
  plan_enc text,
  techniques_used jsonb NOT NULL DEFAULT '[]',
  regions_treated jsonb NOT NULL DEFAULT '[]',
  pain_before integer CHECK (pain_before BETWEEN 0 AND 10),
  pain_after integer CHECK (pain_after BETWEEN 0 AND 10),
  functional_score_before numeric(4,1),
  functional_score_after numeric(4,1),
  home_program_given boolean NOT NULL DEFAULT false,
  follow_up_in_days integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS physio_session_logs_patient_idx ON physio_session_logs(patient_id);
CREATE INDEX IF NOT EXISTS physio_session_logs_provider_idx ON physio_session_logs(provider_id);
CREATE INDEX IF NOT EXISTS physio_session_logs_date_idx ON physio_session_logs(session_date);
COMMIT;
