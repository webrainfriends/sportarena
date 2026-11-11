-- Federation credential & disciplinary API reconciliation (#1026 / REF-R28).
-- Additive only: CREATE TABLE IF NOT EXISTS, ALTER TABLE ... ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- Builds on: governing_bodies, fed_licences, fed_licence_types, disc_sanctions, gov_cases, users, sports,
--            external_identities (identity matching — no name-based merges).

-- ------------------------------------------------------------------ connector registry
-- Platform-approved connection to an external federation credential API or file export.
-- No data flows until status='approved'.
CREATE TABLE IF NOT EXISTS fed_credential_connectors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id          uuid NOT NULL REFERENCES governing_bodies,
  sport_id         uuid REFERENCES sports,
  holder_role      text NOT NULL DEFAULT 'official'
                   CHECK (holder_role IN ('athlete','coach','official','administrator','other')),
  adapter          text NOT NULL CHECK (adapter IN ('api_json','api_xml','api_csv','file_import')),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  endpoint_url     text CHECK (length(endpoint_url) <= 500),
  secret_enc       text,                    -- API token, field-level encrypted; never returned to clients
  mapping          jsonb NOT NULL DEFAULT '{}',  -- {"external_grade_label": "platform_grade_slug"}
  sync_schedule    text CHECK (length(sync_schedule) <= 60), -- cron-like; null = manual only
  sync_ttl_hours   int  NOT NULL DEFAULT 24 CHECK (sync_ttl_hours BETWEEN 1 AND 8760),
  backoff_until    timestamptz,
  backoff_count    int  NOT NULL DEFAULT 0,
  last_sync_at     timestamptz,
  last_sync_status text CHECK (last_sync_status IN ('ok','partial','failed')),
  last_sync_error  text CHECK (length(last_sync_error) <= 2000),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','suspended','archived')),
  decided_at       timestamptz,
  decision_note    text CHECK (length(decision_note) <= 500),
  decided_by       uuid REFERENCES users,
  created_by       uuid NOT NULL REFERENCES users,
  row_version      int  NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  CONSTRAINT fed_cc_api_needs_url CHECK (adapter = 'file_import' OR endpoint_url IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS fed_cc_name ON fed_credential_connectors (body_id, name) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS fed_cc_body ON fed_credential_connectors (body_id);
CREATE INDEX IF NOT EXISTS fed_cc_status ON fed_credential_connectors (status) WHERE status IN ('pending','approved');

-- ------------------------------------------------------------------ credential import batches
CREATE TABLE IF NOT EXISTS fed_credential_import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id    uuid NOT NULL REFERENCES fed_credential_connectors,
  mode            text NOT NULL CHECK (mode IN ('api_pull','file_upload')),
  status          text NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','ok','partial','failed')),
  total_records   int,
  created_count   int NOT NULL DEFAULT 0,
  updated_count   int NOT NULL DEFAULT 0,
  unchanged_count int NOT NULL DEFAULT 0,
  conflict_count  int NOT NULL DEFAULT 0,
  failed_count    int NOT NULL DEFAULT 0,
  errors          jsonb,
  file_sha256     text CHECK (length(file_sha256) = 64), -- hex SHA-256 for file dedup
  started_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Prevent re-processing the same file for the same connector
CREATE UNIQUE INDEX IF NOT EXISTS fed_cib_sha256
  ON fed_credential_import_batches (connector_id, file_sha256) WHERE file_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS fed_cib_connector ON fed_credential_import_batches (connector_id, created_at DESC);

-- ------------------------------------------------------------------ staged credential records
-- Records live here, pending human review, before any touch of fed_licences.
CREATE TABLE IF NOT EXISTS fed_staged_credentials (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid NOT NULL REFERENCES fed_credential_import_batches,
  connector_id         uuid NOT NULL REFERENCES fed_credential_connectors,
  external_ref         text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 200),
  raw_payload          jsonb NOT NULL,
  holder_name_enc      text,               -- encrypted; cleared once matched
  external_identifier  text,               -- e.g. federation reg number, for external_identities lookup
  matched_user_id      uuid REFERENCES users,
  match_confidence     text CHECK (match_confidence IN ('confirmed','probable','unmatched')),
  -- Mapped licence fields
  licence_type_id      uuid REFERENCES fed_licence_types,
  external_grade       text CHECK (length(external_grade) <= 60),
  mapped_grade         text CHECK (length(mapped_grade) <= 60),
  issued_on            date,
  expires_on           date,
  external_standing    text CHECK (length(external_standing) <= 40),
  mapped_standing      text CHECK (mapped_standing IN ('active','suspended','expired','revoked')),
  restrictions         jsonb NOT NULL DEFAULT '[]',
  -- Review state
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','matched','conflict','accepted','rejected','disputed','manual_review')),
  conflict_type        text CHECK (conflict_type IN ('grade_mismatch','standing_conflict','duplicate','unknown_grade','identity_ambiguous','expiry_conflict')),
  conflict_detail      jsonb,
  existing_licence_id  uuid REFERENCES fed_licences,
  reviewed_by          uuid REFERENCES users,
  reviewed_at          timestamptz,
  review_note          text CHECK (length(review_note) <= 500),
  -- Dispute tracking
  disputed_by          uuid REFERENCES users,
  disputed_at          timestamptz,
  dispute_reason_enc   text,               -- field-level encrypted
  dispute_case_id      uuid REFERENCES gov_cases,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, external_ref),
  CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX IF NOT EXISTS fed_sc_connector_status ON fed_staged_credentials (connector_id, status);
CREATE INDEX IF NOT EXISTS fed_sc_matched_user ON fed_staged_credentials (matched_user_id) WHERE matched_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fed_sc_conflict ON fed_staged_credentials (connector_id) WHERE status = 'conflict';

-- ------------------------------------------------------------------ disciplinary import batches
CREATE TABLE IF NOT EXISTS fed_disciplinary_import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id    uuid NOT NULL REFERENCES fed_credential_connectors,
  mode            text NOT NULL CHECK (mode IN ('api_pull','file_upload')),
  status          text NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','ok','partial','failed')),
  total_records   int,
  created_count   int NOT NULL DEFAULT 0,
  conflict_count  int NOT NULL DEFAULT 0,
  failed_count    int NOT NULL DEFAULT 0,
  errors          jsonb,
  file_sha256     text CHECK (length(file_sha256) = 64),
  started_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fed_dib_sha256
  ON fed_disciplinary_import_batches (connector_id, file_sha256) WHERE file_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS fed_dib_connector ON fed_disciplinary_import_batches (connector_id, created_at DESC);

-- ------------------------------------------------------------------ staged disciplinary records
-- Records live here pending review before any touch of gov_cases / disc_sanctions.
CREATE TABLE IF NOT EXISTS fed_staged_disciplinary (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id               uuid NOT NULL REFERENCES fed_disciplinary_import_batches,
  connector_id           uuid NOT NULL REFERENCES fed_credential_connectors,
  external_ref           text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 200),
  raw_payload            jsonb NOT NULL,
  matched_user_id        uuid REFERENCES users,
  match_confidence       text CHECK (match_confidence IN ('confirmed','probable','unmatched')),
  -- Mapped discipline fields
  external_kind          text CHECK (length(external_kind) <= 80),
  mapped_kind            text CHECK (mapped_kind IN ('discipline','appeal','eligibility_dispute','protest','licence_issue','waiver')),
  external_sanction_kind text CHECK (length(external_sanction_kind) <= 80),
  mapped_sanction_kind   text CHECK (mapped_sanction_kind IN ('warning','match_suspension','date_suspension','competition_ban','role_suspension','fine','points_deduction','other')),
  incident_date          date,
  decided_date           date,
  outcome                text CHECK (length(outcome) <= 40),
  sanction_detail        jsonb,
  -- Review state
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','matched','conflict','accepted','rejected','disputed','manual_review')),
  conflict_type          text CHECK (conflict_type IN ('outcome_conflict','sanction_mismatch','duplicate','unknown_category','identity_ambiguous')),
  conflict_detail        jsonb,
  existing_case_id       uuid REFERENCES gov_cases,
  existing_sanction_id   uuid REFERENCES disc_sanctions,
  reviewed_by            uuid REFERENCES users,
  reviewed_at            timestamptz,
  review_note            text CHECK (length(review_note) <= 500),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, external_ref)
);
CREATE INDEX IF NOT EXISTS fed_sd_connector_status ON fed_staged_disciplinary (connector_id, status);
CREATE INDEX IF NOT EXISTS fed_sd_matched_user ON fed_staged_disciplinary (matched_user_id) WHERE matched_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fed_sd_conflict ON fed_staged_disciplinary (connector_id) WHERE status = 'conflict';

-- ------------------------------------------------------------------ reconciliation audit log (append-only)
CREATE TABLE IF NOT EXISTS fed_reconciliation_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('staged_credential','staged_disciplinary','connector','batch')),
  subject_id   uuid NOT NULL,
  action       text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  actor_id     uuid REFERENCES users,
  detail       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fed_re_subject ON fed_reconciliation_events (subject_type, subject_id, created_at);

-- Append-only guard (matches fed_events_append_only pattern)
CREATE OR REPLACE FUNCTION fed_reconciliation_events_guard()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fed_reconciliation_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS fed_reconciliation_events_no_upd ON fed_reconciliation_events;
CREATE TRIGGER fed_reconciliation_events_no_upd
  BEFORE UPDATE OR DELETE ON fed_reconciliation_events
  FOR EACH ROW EXECUTE FUNCTION fed_reconciliation_events_guard();

-- ------------------------------------------------------------------ additive columns on existing tables

-- fed_licences: provenance for imported licences
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS external_ref        text CHECK (length(external_ref) <= 200);
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS connector_id        uuid REFERENCES fed_credential_connectors;
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS provenance_batch_id uuid REFERENCES fed_credential_import_batches;
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS last_synced_at      timestamptz;
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS sync_status         text
  CHECK (sync_status IN ('in_sync','conflict','stale','manual'));

-- disc_sanctions: provenance for imported sanctions
ALTER TABLE disc_sanctions ADD COLUMN IF NOT EXISTS external_ref        text CHECK (length(external_ref) <= 200);
ALTER TABLE disc_sanctions ADD COLUMN IF NOT EXISTS connector_id        uuid REFERENCES fed_credential_connectors;
ALTER TABLE disc_sanctions ADD COLUMN IF NOT EXISTS provenance_batch_id uuid REFERENCES fed_disciplinary_import_batches;

-- gov_cases: external reference for imported disciplinary records
ALTER TABLE gov_cases ADD COLUMN IF NOT EXISTS external_ref  text CHECK (length(external_ref) <= 200);
ALTER TABLE gov_cases ADD COLUMN IF NOT EXISTS connector_id  uuid REFERENCES fed_credential_connectors;

-- ------------------------------------------------------------------ provenance indexes
CREATE INDEX IF NOT EXISTS fed_licences_connector
  ON fed_licences (connector_id) WHERE connector_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fed_licences_external_ref
  ON fed_licences (connector_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS disc_sanctions_connector
  ON disc_sanctions (connector_id) WHERE connector_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gov_cases_connector
  ON gov_cases (connector_id) WHERE connector_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gov_cases_needs_review
  ON gov_cases (needs_review, updated_at DESC) WHERE needs_review = true;
