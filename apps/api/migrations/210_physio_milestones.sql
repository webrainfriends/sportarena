BEGIN;
CREATE TABLE IF NOT EXISTS physio_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treatment_plan_id uuid REFERENCES treatment_plans(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  description_enc text,
  target_date date,
  achieved_at timestamptz,
  evidence_enc text,
  milestone_type text NOT NULL DEFAULT 'functional',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS physio_milestones_patient_idx ON physio_milestones(patient_id);
CREATE INDEX IF NOT EXISTS physio_milestones_plan_idx ON physio_milestones(treatment_plan_id);

CREATE TABLE IF NOT EXISTS physio_outcome_measures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  measure_type text NOT NULL,
  score numeric(6,2) NOT NULL,
  max_score numeric(6,2),
  notes_enc text,
  measured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS physio_outcome_measures_patient_idx ON physio_outcome_measures(patient_id);
COMMIT;
