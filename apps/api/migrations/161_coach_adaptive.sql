-- Adaptive coaching expertise & credential discovery (#837). Additive and idempotent: nothing is dropped, narrowed or rewritten.
-- A coach opts in; disciplines come from the governed catalogue in src/inclusion.js. "Verified" is never stored on the coach: it is derived live
-- from an approved, unexpired, un-revoked verification case, so expiry and revocation downgrade the display immediately.
ALTER TABLE coach_profiles ADD COLUMN IF NOT EXISTS adaptive_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE coach_profiles ADD COLUMN IF NOT EXISTS adaptive_opt_in_at timestamptz;
ALTER TABLE coach_profiles ADD COLUMN IF NOT EXISTS adaptive_formats text[] NOT NULL DEFAULT '{}';
ALTER TABLE coach_profiles ADD COLUMN IF NOT EXISTS adaptive_comm text[] NOT NULL DEFAULT '{}';

-- Credential detail on the existing verification case (issuer, scope, validity): no parallel credential entity, no extra identity.
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS issuing_authority text;
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS credential_title text;
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS scope_disciplines text[] NOT NULL DEFAULT '{}';
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS credential_expires_on date;

-- Self-declared expertise. Archived, never deleted. case_id optionally points at the verification case that backs it.
CREATE TABLE IF NOT EXISTS coach_adaptive_expertise (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES users,
  sport_id uuid NOT NULL REFERENCES sports,
  discipline text NOT NULL,
  years int CHECK (years IS NULL OR years BETWEEN 0 AND 80),
  training_enc text,
  case_id uuid REFERENCES verification_cases,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS coach_adaptive_expertise_live ON coach_adaptive_expertise (coach_id, sport_id, discipline) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS coach_adaptive_expertise_disc ON coach_adaptive_expertise (discipline) WHERE archived_at IS NULL;

-- Adjustments an athlete (or a verified guardian for a young person) chooses to share with the coach of one booking. Catalogue codes only,
-- an optional screened + encrypted note, an expiry, immediate revocation and a read log. Operational only: no diagnosis, no class.
CREATE TABLE IF NOT EXISTS coach_hire_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hire_id uuid NOT NULL REFERENCES coach_hires,
  athlete_id uuid NOT NULL REFERENCES users,
  need_keys text[] NOT NULL,
  note_enc text,
  granted_by uuid NOT NULL REFERENCES users,
  granted_as text NOT NULL CHECK (granted_as IN ('self','guardian')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_hire_adjustments_hire ON coach_hire_adjustments (hire_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS coach_hire_adjustment_reads (
  id bigserial PRIMARY KEY,
  adjustment_id uuid NOT NULL REFERENCES coach_hire_adjustments,
  reader_id uuid NOT NULL REFERENCES users,
  read_at timestamptz NOT NULL DEFAULT now()
);
