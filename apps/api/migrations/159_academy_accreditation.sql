-- Academy accreditation, audits and corrective-action governance (#806).
-- Additive only: new tables, nothing existing is altered. Evidence is linked BY REFERENCE to the compliance engine (comp_records) and credentials,
-- so no evidence data is copied here. Free text is encrypted (*_enc). Nothing is deleted: frameworks are archived, evidence links are soft-ended,
-- and the decision trail is append-only (any UPDATE or DELETE is refused).

CREATE TABLE IF NOT EXISTS academy_accreditation_frameworks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  body_name       text NOT NULL CHECK (char_length(body_name) BETWEEN 2 AND 160),
  kind            text NOT NULL CHECK (kind IN ('coaching_standard','safeguarding','facility','licence','quality','welfare','other')),
  level           text CHECK (level IS NULL OR char_length(level) <= 60),
  owner_id        uuid REFERENCES users,
  cycle_months    smallint NOT NULL DEFAULT 12 CHECK (cycle_months IN (6,12,24,36,60)),
  next_due_on     date,
  expires_on      date,
  remind_days     smallint NOT NULL DEFAULT 60 CHECK (remind_days BETWEEN 7 AND 365),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','suspended','archived')),
  notes_enc       text,
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX IF NOT EXISTS academy_accr_frameworks_org ON academy_accreditation_frameworks (organisation_id, status);

-- What the framework requires. A requirement may point at an existing compliance requirement (comp_requirements) so its state is read from there.
CREATE TABLE IF NOT EXISTS academy_accreditation_requirements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_id        uuid NOT NULL REFERENCES academy_accreditation_frameworks,
  sequence            smallint NOT NULL DEFAULT 0,
  title               text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 160),
  evidence_kind       text NOT NULL CHECK (evidence_kind IN ('coach_credentials','compliance_record','policy','facility','insurance','curriculum','other')),
  required            boolean NOT NULL DEFAULT true,
  comp_requirement_id uuid REFERENCES comp_requirements,
  created_at          timestamptz NOT NULL DEFAULT now(),
  retired_at          timestamptz
);
CREATE INDEX IF NOT EXISTS academy_accr_reqs_framework ON academy_accreditation_requirements (framework_id, sequence) WHERE retired_at IS NULL;

-- Evidence is a pointer to a compliance record or a credential, never a copy. Ending a link keeps the row.
CREATE TABLE IF NOT EXISTS academy_accreditation_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_id    uuid NOT NULL REFERENCES academy_accreditation_frameworks,
  requirement_id  uuid NOT NULL REFERENCES academy_accreditation_requirements,
  comp_record_id  uuid REFERENCES comp_records,
  credential_id   uuid REFERENCES credentials,
  linked_by       uuid NOT NULL REFERENCES users,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ended_by        uuid REFERENCES users,
  CHECK ((comp_record_id IS NOT NULL)::int + (credential_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_accr_evidence_record ON academy_accreditation_evidence (requirement_id, comp_record_id) WHERE ended_at IS NULL AND comp_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academy_accr_evidence_credential ON academy_accreditation_evidence (requirement_id, credential_id) WHERE ended_at IS NULL AND credential_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS academy_audits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  framework_id    uuid NOT NULL REFERENCES academy_accreditation_frameworks,
  kind            text NOT NULL CHECK (kind IN ('on_site','document_review','remote')),
  scheduled_on    date NOT NULL,
  starts_at       time,
  ends_at         time,
  venue_name      text CHECK (venue_name IS NULL OR char_length(venue_name) <= 160),
  scope           text[] NOT NULL DEFAULT '{}',
  inspector_id    uuid REFERENCES users,
  inspector_name  text CHECK (inspector_name IS NULL OR char_length(inspector_name) <= 160),
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','findings_issued','resubmitted','closed','cancelled')),
  score           smallint CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  decision        text CHECK (decision IS NULL OR decision IN ('pass','conditional_pass','fail')),
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  resubmit_by     date,
  summary_enc     text,
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_audits_org ON academy_audits (organisation_id, scheduled_on DESC);
CREATE INDEX IF NOT EXISTS academy_audits_framework ON academy_audits (framework_id, scheduled_on DESC);
CREATE INDEX IF NOT EXISTS academy_audits_inspector ON academy_audits (inspector_id) WHERE inspector_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS academy_audit_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id        uuid NOT NULL REFERENCES academy_audits,
  organisation_id uuid NOT NULL REFERENCES organisations,
  ref             text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('high','medium','low','observation')),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 200),
  detail_enc      text,
  requirement_id  uuid REFERENCES academy_accreditation_requirements,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','accepted_risk')),
  resolved_by     uuid REFERENCES users,
  resolved_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_id, ref)
);
CREATE INDEX IF NOT EXISTS academy_audit_findings_org ON academy_audit_findings (organisation_id, status);

CREATE TABLE IF NOT EXISTS academy_audit_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id      uuid NOT NULL REFERENCES academy_audit_findings,
  organisation_id uuid NOT NULL REFERENCES organisations,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 200),
  owner_id        uuid REFERENCES users,
  due_on          date,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  note_enc        text,
  done_by         uuid REFERENCES users,
  done_at         timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_audit_actions_org ON academy_audit_actions (organisation_id, status, due_on);

-- The decision trail: append-only.
CREATE TABLE IF NOT EXISTS academy_accreditation_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  framework_id    uuid REFERENCES academy_accreditation_frameworks,
  audit_id        uuid REFERENCES academy_audits,
  finding_id      uuid REFERENCES academy_audit_findings,
  kind            text NOT NULL,
  actor_id        uuid REFERENCES users,
  data            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_accr_events_framework ON academy_accreditation_events (framework_id, created_at DESC);
CREATE INDEX IF NOT EXISTS academy_accr_events_audit ON academy_accreditation_events (audit_id, created_at DESC);

CREATE OR REPLACE FUNCTION academy_accreditation_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'academy_accreditation_events is append-only'; END $$;
DROP TRIGGER IF EXISTS academy_accreditation_events_guard ON academy_accreditation_events;
CREATE TRIGGER academy_accreditation_events_guard BEFORE UPDATE OR DELETE ON academy_accreditation_events FOR EACH ROW EXECUTE FUNCTION academy_accreditation_events_guard();
