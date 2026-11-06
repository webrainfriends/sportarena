-- Guardian-initiated managed child profiles (gaps audit, feature 3).
-- Additive only. Extends users table with nullable columns (DEFAULT means no existing rows break).

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_managed boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS managed_by_guardian_id uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Kit sizes stored encrypted
CREATE TABLE IF NOT EXISTS user_kit_sizes (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  shirt_size_enc text,
  shorts_size_enc text,
  boot_size_enc text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Emergency medical card data (shown to first aid only via QR)
CREATE TABLE IF NOT EXISTS user_medical_cards (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  blood_type text CHECK (blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
  allergies text[] NOT NULL DEFAULT '{}',
  conditions_enc text,
  medications_enc text,
  gp_name_enc text,
  gp_phone_enc text,
  emergency_contact_name_enc text NOT NULL DEFAULT '',
  emergency_contact_phone_enc text NOT NULL DEFAULT '',
  emergency_contact_relation text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Academic schedule (for clash-check)
CREATE TABLE IF NOT EXISTS user_academic_schedules (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  school_name_enc text,
  schedule_enc text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Claim tokens for managed->independent transition
CREATE TABLE IF NOT EXISTS managed_account_claim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'base64'),
  contact_enc text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Biometrics (sport science - optional, encrypted)
CREATE TABLE IF NOT EXISTS user_biometrics (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  height_cm_enc text,
  weight_kg_enc text,
  wingspan_cm_enc text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
