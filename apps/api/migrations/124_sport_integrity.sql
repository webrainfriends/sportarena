-- Sport Integrity & Anti-Doping Administration (#489). Additive only: new tables, and the federation role check is WIDENED (never narrowed).
-- SportArena is not a laboratory, a medical record or an investigator. Every anti-doping row is an ADMINISTRATIVE REFERENCE to an authoritative
-- source (value exactly as supplied, with provenance and revisions). There is deliberately no column for analytical values, diagnosis, medication or
-- rationale, and no score. Rows are superseded, tombstoned or appended, never rewritten or deleted.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governing_body_roles_role_check') THEN
    ALTER TABLE governing_body_roles DROP CONSTRAINT governing_body_roles_role_check;
  END IF;
  ALTER TABLE governing_body_roles ADD CONSTRAINT governing_body_roles_role_check
    CHECK (role IN ('registrar','licensing','sanctioner','secretary','compliance','auditor','integrity'));
END $$;

ALTER TABLE governing_bodies ADD COLUMN IF NOT EXISTS integrity_seq int NOT NULL DEFAULT 0;

-- ---- categories: what governed matters a body handles, how long each step may take, and what the body calls each state
CREATE TABLE int_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  kind          text NOT NULL CHECK (kind IN ('anti_doping','match_integrity','betting_conflict','accreditation_fraud','other')),
  label         text NOT NULL CHECK (length(label) BETWEEN 2 AND 80),
  response_days int NOT NULL DEFAULT 14 CHECK (response_days BETWEEN 1 AND 365),
  decision_days int NOT NULL DEFAULT 30 CHECK (decision_days BETWEEN 1 AND 730),
  state_labels  jsonb NOT NULL DEFAULT '{}',
  policy_ref    text CHECK (policy_ref IS NULL OR length(policy_ref) <= 200),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX int_categories_label ON int_categories (body_id, lower(label)) WHERE status = 'active';

-- ---- sources: who may be treated as authoritative. Manual entry is always its own, unverified source.
CREATE TABLE int_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  designation   text NOT NULL CHECK (designation IN ('authoritative','verified_reference','manual')),
  integration   text NOT NULL DEFAULT 'none' CHECK (integration IN ('none','blocked_awaiting_credentials')),
  note          text CHECK (note IS NULL OR length(note) <= 500),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX int_sources_name ON int_sources (body_id, lower(name)) WHERE status = 'active';

-- ---- cases
CREATE TABLE int_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id         uuid NOT NULL REFERENCES governing_bodies,
  category_id     uuid NOT NULL REFERENCES int_categories,
  case_no         text NOT NULL UNIQUE,
  subject_id      uuid NOT NULL REFERENCES users,
  sport_id        uuid REFERENCES sports,
  status          text NOT NULL DEFAULT 'received' CHECK (status IN ('received','under_review','response_due','decision_pending','decided','closed','suspended','deferred','withdrawn')),
  prior_status    text,
  summary_enc     text NOT NULL,
  source_label    text CHECK (source_label IS NULL OR length(source_label) <= 200),
  response_due_on date,
  decision_due_on date,
  notice_sent_at  timestamptz,
  row_version     int NOT NULL DEFAULT 1,
  opened_by       uuid NOT NULL REFERENCES users,
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX int_cases_body ON int_cases (body_id, status, created_at DESC);
CREATE INDEX int_cases_subject ON int_cases (subject_id);

-- the subject's own response, and any panel member given need-to-know access to one case (revocable)
CREATE TABLE int_case_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES int_cases,
  author_id  uuid NOT NULL REFERENCES users,
  kind       text NOT NULL CHECK (kind IN ('response','notice')),
  body_enc   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE int_case_access (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES int_cases,
  user_id    uuid NOT NULL REFERENCES users,
  role       text NOT NULL CHECK (role IN ('panel','reviewer')),
  granted_by uuid NOT NULL REFERENCES users,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX int_case_access_live ON int_case_access (case_id, user_id) WHERE revoked_at IS NULL;

-- immutable history for everything integrity
CREATE TABLE int_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id      uuid NOT NULL REFERENCES governing_bodies,
  case_id      uuid REFERENCES int_cases,
  subject_type text NOT NULL CHECK (subject_type IN ('case','test_reference','custody','exemption','decision','appeal','education','declaration','source','category')),
  subject_id   uuid NOT NULL,
  action       text NOT NULL,
  from_status  text,
  to_status    text,
  actor_id     uuid REFERENCES users,
  reason       text,
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX int_events_subject ON int_events (subject_type, subject_id, created_at);
CREATE INDEX int_events_case ON int_events (case_id, created_at);
CREATE FUNCTION int_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER int_events_append_only BEFORE UPDATE OR DELETE ON int_events FOR EACH ROW EXECUTE FUNCTION int_append_only();

-- ---- testing references: what an authorised anti-doping organisation supplied, verbatim. No analytical values. No inference.
CREATE TABLE int_test_refs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id          uuid NOT NULL REFERENCES governing_bodies,
  case_id          uuid REFERENCES int_cases,
  subject_id       uuid NOT NULL REFERENCES users,
  source_id        uuid NOT NULL REFERENCES int_sources,
  external_ref_enc text NOT NULL,
  external_ref_idx text NOT NULL,
  revision         int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  testing_authority text CHECK (testing_authority IS NULL OR length(testing_authority) <= 120),
  collected_at     timestamptz,
  context          text NOT NULL DEFAULT 'unspecified' CHECK (context IN ('in_competition','out_of_competition','unspecified')),
  sample_type      text CHECK (sample_type IS NULL OR length(sample_type) <= 60),
  external_status  text NOT NULL CHECK (length(external_status) BETWEEN 1 AND 120),
  result_category  text CHECK (result_category IS NULL OR length(result_category) <= 120),
  verification     text NOT NULL CHECK (verification IN ('source_authoritative','source_verified','unverified','reviewed')),
  reviewed_by      uuid REFERENCES users,
  reviewed_at      timestamptz,
  payload_hash     text NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  source_sent_at   timestamptz,
  superseded_at    timestamptz,
  tombstoned_at    timestamptz,
  tombstone_reason text CHECK (tombstone_reason IS NULL OR length(tombstone_reason) <= 300),
  recorded_by      uuid NOT NULL REFERENCES users
);
-- replay of the same source record at the same revision is the same logical record
CREATE UNIQUE INDEX int_test_refs_revision ON int_test_refs (source_id, external_ref_idx, revision);
CREATE INDEX int_test_refs_subject ON int_test_refs (body_id, subject_id) WHERE superseded_at IS NULL;

-- append-only administrative handoffs, with the source's own immutable identifier
CREATE TABLE int_custody_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_ref_id   uuid NOT NULL REFERENCES int_test_refs,
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  step          text NOT NULL CHECK (length(step) BETWEEN 2 AND 120),
  actor_label   text NOT NULL CHECK (length(actor_label) BETWEEN 2 AND 120),
  occurred_at   timestamptz NOT NULL,
  external_id   text CHECK (external_id IS NULL OR length(external_id) <= 120),
  source_id     uuid NOT NULL REFERENCES int_sources,
  recorded_by   uuid NOT NULL REFERENCES users,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX int_custody_once ON int_custody_events (test_ref_id, external_id) WHERE external_id IS NOT NULL;
CREATE TRIGGER int_custody_append_only BEFORE UPDATE OR DELETE ON int_custody_events FOR EACH ROW EXECUTE FUNCTION int_append_only();

-- ---- therapeutic-use exemption: the minimum operational projection. Diagnosis, medication and clinical papers stay with the authority / Health.
CREATE TABLE int_exemptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id          uuid NOT NULL REFERENCES governing_bodies,
  subject_id       uuid NOT NULL REFERENCES users,
  source_id        uuid NOT NULL REFERENCES int_sources,
  external_ref_enc text NOT NULL,
  external_ref_idx text NOT NULL,
  revision         int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  issuing_authority text NOT NULL CHECK (length(issuing_authority) BETWEEN 2 AND 120),
  external_status  text NOT NULL CHECK (length(external_status) BETWEEN 1 AND 120),
  valid_from       date,
  valid_until      date,
  scope_note       text CHECK (scope_note IS NULL OR length(scope_note) <= 200),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  verification     text NOT NULL CHECK (verification IN ('source_authoritative','source_verified','unverified','reviewed')),
  payload_hash     text NOT NULL,
  superseded_at    timestamptz,
  tombstoned_at    timestamptz,
  recorded_by      uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);
CREATE UNIQUE INDEX int_exemptions_revision ON int_exemptions (source_id, external_ref_idx, revision);

-- ---- decisions: exact decision/reference/source, effective scope; an amendment, appeal outcome or reversal is a NEW row that supersedes the old
CREATE TABLE int_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        uuid NOT NULL REFERENCES int_cases,
  body_id        uuid NOT NULL REFERENCES governing_bodies,
  seq            int NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('initial','amendment','appeal_outcome','reversal')),
  made_by        text NOT NULL CHECK (made_by IN ('external_body','internal_panel')),
  authority_label text NOT NULL CHECK (length(authority_label) BETWEEN 2 AND 160),
  decision_ref_enc text NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('no_finding','finding_recorded','no_further_action','withdrawn_by_authority','other')),
  outcome_text_enc text,
  effective_from date,
  effective_to   date,
  scope_note     text CHECK (scope_note IS NULL OR length(scope_note) <= 300),
  sporting_sanction boolean NOT NULL DEFAULT false,
  handoff_status text NOT NULL DEFAULT 'not_applicable' CHECK (handoff_status IN ('not_applicable','delivered_to_eligibility','lifted')),
  supersedes_id  uuid REFERENCES int_decisions,
  superseded_at  timestamptz,
  recorded_by    uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, seq),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

CREATE TABLE int_appeals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES int_cases,
  decision_id   uuid NOT NULL REFERENCES int_decisions,
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  lodged_by     uuid NOT NULL REFERENCES users,
  grounds_enc   text NOT NULL,
  status        text NOT NULL DEFAULT 'lodged' CHECK (status IN ('lodged','under_review','upheld','reduced','overturned','remitted','dismissed')),
  panel_label   text CHECK (panel_label IS NULL OR length(panel_label) <= 160),
  outcome_decision_id uuid REFERENCES int_decisions,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE UNIQUE INDEX int_appeals_open ON int_appeals (decision_id) WHERE status IN ('lodged','under_review');

-- ---- education: requirement + versions, per-person acknowledgement. Never a score.
CREATE TABLE int_education_requirements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id      uuid NOT NULL REFERENCES governing_bodies,
  title        text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  version      int NOT NULL DEFAULT 1 CHECK (version >= 1),
  programme_id uuid REFERENCES programmes,
  population   text NOT NULL DEFAULT 'named' CHECK (population IN ('named','licence_holders')),
  sport_id     uuid REFERENCES sports,
  valid_months int CHECK (valid_months IS NULL OR valid_months BETWEEN 1 AND 120),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE int_education_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL REFERENCES int_education_requirements,
  body_id        uuid NOT NULL REFERENCES governing_bodies,
  user_id        uuid NOT NULL REFERENCES users,
  version        int NOT NULL,
  status         text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','completed')),
  completed_on   date,
  evidence_ref   text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 200),
  expires_on     date,
  assigned_by    uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX int_education_one ON int_education_records (requirement_id, user_id, version);

-- ---- declarations: narrow, purpose-bound, retention-dated, visible only to the declarant and the body's integrity officers
CREATE TABLE int_declarations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id      uuid NOT NULL REFERENCES governing_bodies,
  user_id      uuid NOT NULL REFERENCES users,
  kind         text NOT NULL CHECK (kind IN ('conflict','betting_interest')),
  purpose      text NOT NULL CHECK (length(purpose) BETWEEN 5 AND 300),
  detail_enc   text NOT NULL,
  retain_until date NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE INDEX int_declarations_body ON int_declarations (body_id, status);

-- nothing integrity-related is ever deleted (rows are superseded, tombstoned or appended)
CREATE TRIGGER int_cases_no_delete BEFORE DELETE ON int_cases FOR EACH ROW EXECUTE FUNCTION int_append_only();
CREATE TRIGGER int_test_refs_no_delete BEFORE DELETE ON int_test_refs FOR EACH ROW EXECUTE FUNCTION int_append_only();
CREATE TRIGGER int_exemptions_no_delete BEFORE DELETE ON int_exemptions FOR EACH ROW EXECUTE FUNCTION int_append_only();
CREATE TRIGGER int_decisions_no_delete BEFORE DELETE ON int_decisions FOR EACH ROW EXECUTE FUNCTION int_append_only();
CREATE TRIGGER int_appeals_no_delete BEFORE DELETE ON int_appeals FOR EACH ROW EXECUTE FUNCTION int_append_only();
CREATE TRIGGER int_declarations_no_delete BEFORE DELETE ON int_declarations FOR EACH ROW EXECUTE FUNCTION int_append_only();
