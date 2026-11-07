-- Team-level volunteer positions and applications (gaps audit, feature 1)
-- Additive only: new tables, no changes to existing tables.

CREATE TABLE IF NOT EXISTS team_volunteer_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id),
  created_by uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  description_enc text,
  role_category text NOT NULL CHECK (role_category IN ('general','check_in','coaching_assistant','first_aid','transport','admin')),
  shift_start timestamptz NOT NULL,
  shift_end timestamptz NOT NULL,
  capacity int NOT NULL DEFAULT 1,
  requirements_enc text,
  uniform_desc_enc text,
  meal_provided boolean NOT NULL DEFAULT false,
  location_enc text,
  briefing_url text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_volunteer_positions_team ON team_volunteer_positions(team_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS team_volunteer_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL REFERENCES team_volunteer_positions(id),
  applicant_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','withdrawn')),
  note_enc text,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  briefing_sent_at timestamptz,
  shirt_size text,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  hours_logged numeric(5,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(position_id, applicant_id)
);

CREATE INDEX IF NOT EXISTS team_volunteer_apps_position ON team_volunteer_applications(position_id);
CREATE INDEX IF NOT EXISTS team_volunteer_apps_applicant ON team_volunteer_applications(applicant_id);

CREATE TABLE IF NOT EXISTS team_volunteer_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES users(id),
  team_id uuid NOT NULL REFERENCES teams(id),
  position_id uuid NOT NULL REFERENCES team_volunteer_positions(id),
  hours numeric(5,2) NOT NULL,
  season_label text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
