-- Sponsorship eligibility screening and application validation (#287). Purely additive and backwards-compatible.
-- A program's eligibility rules become immutable, numbered versions (the old program columns stay and are kept in step), every application
-- is screened against the version in force, and each screening is an append-only row (outcome, plain reasons, missing items, duplicate
-- flags) so a later rule change never rewrites an earlier decision. A manual exception is a separate, audited, soft-revocable record.
-- Existing programs get version 1 (their current rules); existing applications are NOT given an invented screening (outcome stays null =
-- "not screened"). Nothing is dropped, rewritten or deleted; no ON DELETE CASCADE.
-- Rollback = deploy the previous code; the new tables and nullable columns are simply unused.

CREATE TABLE IF NOT EXISTS sponsorship_eligibility_versions (
  program_id  uuid NOT NULL REFERENCES sponsorship_programs,
  version     int  NOT NULL CHECK (version > 0),
  rules       jsonb NOT NULL,            -- {target_types, sports, regions, verified_only, max_award_cents, duplicate_check, required_documents:[{key,label}]}
  sha256      text NOT NULL,
  note        text,
  created_by  uuid REFERENCES users,     -- null for the version-1 backfill
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, version)
);

ALTER TABLE sponsorship_programs ADD COLUMN IF NOT EXISTS eligibility_version int;

INSERT INTO sponsorship_eligibility_versions(program_id, version, rules, sha256, note)
SELECT p.id, 1,
       jsonb_build_object('target_types', coalesce(p.eligibility->'target_types', '[]'::jsonb), 'sports', to_jsonb(p.sports), 'regions', to_jsonb(p.regions),
                          'verified_only', coalesce((p.eligibility->>'verified_only')::boolean, false), 'max_award_cents', p.max_award_cents,
                          'duplicate_check', true, 'required_documents', '[]'::jsonb),
       encode(sha256(convert_to(p.id::text || ':1', 'UTF8')), 'hex'), 'Rules in force before versioning'
  FROM sponsorship_programs p
 WHERE NOT EXISTS (SELECT 1 FROM sponsorship_eligibility_versions v WHERE v.program_id = p.id);
UPDATE sponsorship_programs p SET eligibility_version = 1 WHERE eligibility_version IS NULL;

-- One row per screening run. Append-only: re-screening adds a row; the application points at the latest.
CREATE TABLE IF NOT EXISTS sponsorship_screenings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  program_id     uuid NOT NULL REFERENCES sponsorship_programs,
  rules_version  int  NOT NULL,
  rules_sha256   text NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('eligible','needs_info','ineligible','review')),
  reasons        jsonb NOT NULL DEFAULT '[]',       -- [{code, rule, status:'met'|'unmet'|'unknown', message}]
  missing        jsonb NOT NULL DEFAULT '[]',       -- [{kind:'document'|'data', key, label}]
  duplicate_flags jsonb NOT NULL DEFAULT '[]',      -- [{kind, application_id?, round_id?, note}] - a flag asks a human to look; it never rejects
  trigger        text NOT NULL CHECK (trigger IN ('submit','correction','manual','rules_changed')),
  run_by         uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_screenings_app ON sponsorship_screenings (application_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS sponsorship_screenings_program ON sponsorship_screenings (program_id, created_at, id);

ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS screening_id uuid REFERENCES sponsorship_screenings;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS screening_outcome text;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS screening_version int NOT NULL DEFAULT 0;   -- optimistic lock for screening/exception writes

-- A manual exception: who, with what authority, why (encrypted), until when. Revoked, never deleted. One live exception per application.
CREATE TABLE IF NOT EXISTS sponsorship_screening_exceptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  screening_id   uuid NOT NULL REFERENCES sponsorship_screenings,
  granted_by     uuid NOT NULL REFERENCES users,
  authority_role text NOT NULL,
  reason_enc     text NOT NULL,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_screening_exceptions_live ON sponsorship_screening_exceptions (application_id) WHERE revoked_at IS NULL;

-- Append-only trail of screening activity (its own table: sponsorship_application_events belongs to the forms feature).
CREATE TABLE IF NOT EXISTS sponsorship_screening_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  kind           text NOT NULL CHECK (kind IN ('screened','info_requested','exception_granted','exception_revoked')),
  actor_id       uuid REFERENCES users,
  data           jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_screening_events_app ON sponsorship_screening_events (application_id, created_at, id);
