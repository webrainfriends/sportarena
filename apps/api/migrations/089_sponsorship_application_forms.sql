-- Configurable sponsorship application forms (#286). Purely additive and backwards-compatible: a program can publish immutable versions of an
-- application form, a round is pinned to one version, and an application keeps the exact form version it was filled under together with
-- its answers, budget, references, uploads and a correction trail. Existing applications and rounds are untouched (a round without a form
-- keeps the original pitch + amount flow). Nothing is dropped, rewritten or deleted; no ON DELETE CASCADE; forms and files are hidden
-- (archived_at / removed_at), never deleted. Only a status CHECK and a partial index are replaced by wider equivalents (no data changes).
-- Rollback = deploy the previous code; the new tables and nullable columns are simply unused.

CREATE TABLE IF NOT EXISTS sponsorship_forms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES sponsorship_programs,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  created_by  uuid NOT NULL REFERENCES users,
  row_version int  NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_forms_program ON sponsorship_forms (program_id, created_at, id);

-- Append-only: a published version never changes, so an application can always be shown against the form it was filled under.
CREATE TABLE IF NOT EXISTS sponsorship_form_versions (
  form_id      uuid NOT NULL REFERENCES sponsorship_forms,
  version      int  NOT NULL CHECK (version > 0),
  definition   jsonb NOT NULL,
  sha256       text NOT NULL,
  published_by uuid NOT NULL REFERENCES users,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form_id, version)
);

ALTER TABLE sponsorship_rounds ADD COLUMN IF NOT EXISTS form_id uuid REFERENCES sponsorship_forms;
ALTER TABLE sponsorship_rounds ADD COLUMN IF NOT EXISTS form_version int;

CREATE SEQUENCE IF NOT EXISTS sponsorship_receipt_seq;

ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS form_id uuid REFERENCES sponsorship_forms;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS form_version int;               -- null = original pitch + amount application
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS confidential_enc text;           -- answers to fields marked confidential (encrypted)
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS budget jsonb;                    -- [{label, amount_cents}] in the program currency
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS refs_enc text;                   -- reference contacts (encrypted)
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS correction_idempotency_key text;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS receipt_no text;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS row_version int NOT NULL DEFAULT 1;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- A draft may not have an amount yet; every other status still must.
ALTER TABLE sponsorship_applications ALTER COLUMN requested_cents DROP NOT NULL;
ALTER TABLE sponsorship_applications DROP CONSTRAINT IF EXISTS sponsorship_applications_status_check;
ALTER TABLE sponsorship_applications ADD CONSTRAINT sponsorship_applications_status_check
  CHECK (status IN ('draft','submitted','returned','awarded','declined','withdrawn'));
ALTER TABLE sponsorship_applications DROP CONSTRAINT IF EXISTS sponsorship_applications_amount_present;
ALTER TABLE sponsorship_applications ADD CONSTRAINT sponsorship_applications_amount_present CHECK (status = 'draft' OR requested_cents IS NOT NULL);

-- one live application (or draft) per round and target
DROP INDEX IF EXISTS sponsorship_applications_live;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_applications_live ON sponsorship_applications (round_id, target_type, target_id) WHERE status IN ('draft','submitted','returned','awarded');
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_applications_idem ON sponsorship_applications (applicant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_applications_receipt ON sponsorship_applications (receipt_no) WHERE receipt_no IS NOT NULL;

-- Append-only trail of what happened to an application (submit, correction asked, correction made, withdrawal).
CREATE TABLE IF NOT EXISTS sponsorship_application_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  kind           text NOT NULL CHECK (kind IN ('submitted','correction_requested','corrected','withdrawn')),
  actor_id       uuid NOT NULL REFERENCES users,
  form_version   int,
  note           text,
  fields         text[] NOT NULL DEFAULT '{}',
  before         jsonb,                 -- previous non-confidential values of the changed fields (confidential values are never copied)
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_application_events_app ON sponsorship_application_events (application_id, created_at, id);

-- Uploads, kept encrypted on disk; scoped to one application and one form field. Only hidden, never deleted.
CREATE TABLE IF NOT EXISTS sponsorship_application_files (
  id             uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  field_key      text NOT NULL,
  uploaded_by    uuid NOT NULL REFERENCES users,
  content_type   text NOT NULL,
  file_name      text NOT NULL,
  original_name  text,
  size_bytes     int  NOT NULL CHECK (size_bytes > 0),
  sha256         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS sponsorship_application_files_app ON sponsorship_application_files (application_id, field_key, created_at, id);

-- Reusable applicant details, prefilled into any form field that names the same profile_key. Never submitted automatically.
CREATE TABLE IF NOT EXISTS sponsorship_applicant_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users,
  data_enc    text NOT NULL,
  row_version int NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
