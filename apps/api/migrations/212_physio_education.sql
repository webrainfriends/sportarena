BEGIN;
CREATE TABLE IF NOT EXISTS physio_education_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  body_enc text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  tags jsonb NOT NULL DEFAULT '[]',
  media_urls jsonb NOT NULL DEFAULT '[]',
  is_public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS physio_education_items_provider_idx ON physio_education_items(provider_id);

CREATE TABLE IF NOT EXISTS physio_education_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES physio_education_items(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS physio_edu_assign_patient_idx ON physio_education_assignments(patient_id);
CREATE INDEX IF NOT EXISTS physio_edu_assign_item_idx ON physio_education_assignments(item_id);
COMMIT;
