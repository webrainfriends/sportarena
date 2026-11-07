-- Academy OS P0 / Gap 04: safeguarding & welfare case orchestration (#784).
-- Additive only: nothing is dropped, truncated, rewritten or cascaded. It extends academy_safety_events (#788) and the compliance module (#595);
-- a case is opened FROM a safety event (event_id) and never copies compliance or attendance data. Rollback: deploy the previous build, the new tables are ignored.

-- Designated safeguarding officers, optionally tied to one campus (org_units, #781). tier 1 = campus officer, 2 = academy lead officer, 3 = leadership liaison.
CREATE TABLE IF NOT EXISTS academy_sg_officers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  unit_id         uuid REFERENCES org_units,               -- null = every campus of the academy
  tier            smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 3),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  appointed_by    uuid NOT NULL REFERENCES users,
  appointed_at    timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ended_by        uuid REFERENCES users,
  end_reason      text CHECK (end_reason IS NULL OR length(end_reason) <= 300)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_sg_officers_live ON academy_sg_officers (organisation_id, user_id, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status='active';
CREATE INDEX IF NOT EXISTS academy_sg_officers_org ON academy_sg_officers (organisation_id, status, tier);

-- Per-academy rules: response deadlines (hours) by risk and the communication boundaries. One live row per academy; a change retires the old row.
CREATE TABLE IF NOT EXISTS academy_sg_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  version         int NOT NULL,
  ack_hours       jsonb NOT NULL DEFAULT '{"low":48,"medium":24,"high":4,"critical":1}',
  review_hours    jsonb NOT NULL DEFAULT '{"low":168,"medium":72,"high":24,"critical":8}',
  escalate_after_hours jsonb NOT NULL DEFAULT '{"low":240,"medium":96,"high":24,"critical":4}',
  retention_years smallint NOT NULL DEFAULT 7 CHECK (retention_years BETWEEN 1 AND 50),
  require_guardian_copy boolean NOT NULL DEFAULT true,        -- every staff message to an under-18 copies a verified guardian
  allow_private_channels boolean NOT NULL DEFAULT false,      -- one-to-one staff/athlete channels outside the academy channel
  quiet_from      time,
  quiet_to        time,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_sg_policies_live ON academy_sg_policies (organisation_id) WHERE retired_at IS NULL;

-- Mandatory-reporting configuration by jurisdiction and incident type. It only SURFACES the rule for a human; it never decides or sends anything.
CREATE TABLE IF NOT EXISTS academy_sg_report_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  jurisdiction    text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  incident_type   text NOT NULL CHECK (incident_type IN ('welfare','conduct','online','injury_neglect','pickup','other')),
  authority_label text NOT NULL CHECK (length(authority_label) BETWEEN 2 AND 120),
  notify_within_hours int CHECK (notify_within_hours IS NULL OR notify_within_hours BETWEEN 1 AND 720),
  guidance        text CHECK (guidance IS NULL OR length(guidance) <= 1000),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_sg_report_rules_live ON academy_sg_report_rules (organisation_id, jurisdiction, incident_type) WHERE retired_at IS NULL;

CREATE SEQUENCE IF NOT EXISTS academy_sg_case_seq;
CREATE TABLE IF NOT EXISTS academy_sg_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  case_no         text NOT NULL,
  event_id        uuid REFERENCES academy_safety_events,
  athlete_id      uuid NOT NULL REFERENCES users,
  unit_id         uuid REFERENCES org_units,               -- campus
  category        text NOT NULL CHECK (category IN ('welfare','conduct','online','injury_neglect','pickup','other')),
  risk            text NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high','critical')),
  status          text NOT NULL DEFAULT 'received' CHECK (status IN ('received','assessment','action','review','closed')),
  tier            smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 3),
  assignee_id     uuid REFERENCES users,
  conflicted_user_id uuid REFERENCES users,                -- the staff member the concern is about: never sees it, never assigned
  jurisdiction    text CHECK (jurisdiction IS NULL OR jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  summary_enc     text,
  outcome_enc     text,
  close_reason    text CHECK (close_reason IN ('resolved','no_further_action','referred','monitoring_ended')),
  reporting_state text NOT NULL DEFAULT 'not_assessed' CHECK (reporting_state IN ('not_assessed','needs_human_review','decision_recorded')),
  ack_due_at      timestamptz NOT NULL,
  acknowledged_at timestamptz,
  review_due_at   timestamptz NOT NULL,
  escalate_due_at timestamptz NOT NULL,
  retention_until date,
  opened_by       uuid NOT NULL REFERENCES users,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_by       uuid REFERENCES users,
  closed_at       timestamptz,
  row_version     int NOT NULL DEFAULT 1,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  CHECK (assignee_id IS NULL OR conflicted_user_id IS NULL OR assignee_id <> conflicted_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_sg_cases_no ON academy_sg_cases (case_no);
CREATE UNIQUE INDEX IF NOT EXISTS academy_sg_cases_idem ON academy_sg_cases (organisation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academy_sg_cases_event ON academy_sg_cases (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS academy_sg_cases_org ON academy_sg_cases (organisation_id, status, risk, opened_at DESC);
CREATE INDEX IF NOT EXISTS academy_sg_cases_assignee ON academy_sg_cases (assignee_id, status) WHERE assignee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS academy_sg_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES academy_sg_cases,
  kind        text NOT NULL CHECK (kind IN ('risk_review','guardian_contact','referral','training_or_checks','monitoring','report_review','other')),
  owner_id    uuid REFERENCES users,
  due_at      timestamptz,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  note_enc    text,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz,
  done_by     uuid REFERENCES users
);
CREATE INDEX IF NOT EXISTS academy_sg_actions_case ON academy_sg_actions (case_id, status, due_at);

-- Evidence is a reference to a record that already lives elsewhere (compliance file, safety event) or a https link; the content is never copied here.
CREATE TABLE IF NOT EXISTS academy_sg_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES academy_sg_cases,
  kind        text NOT NULL CHECK (kind IN ('compliance_file','safety_event','link')),
  ref_id      uuid,
  label_enc   text NOT NULL,
  url_enc     text,
  added_by    uuid NOT NULL REFERENCES users,
  added_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_sg_evidence_case ON academy_sg_evidence (case_id);

-- The human decision on a reporting obligation. The platform never reports to an authority.
CREATE TABLE IF NOT EXISTS academy_sg_report_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES academy_sg_cases,
  rule_id       uuid REFERENCES academy_sg_report_rules,
  decision      text NOT NULL CHECK (decision IN ('reported','not_required','deferred')),
  rationale_enc text NOT NULL,
  decided_by    uuid NOT NULL REFERENCES users,
  decided_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_sg_report_decisions_case ON academy_sg_report_decisions (case_id, decided_at);

-- Append-only audit of everything that happens to a case, including every read.
CREATE TABLE IF NOT EXISTS academy_sg_case_log (
  id         bigserial PRIMARY KEY,
  case_id    uuid NOT NULL REFERENCES academy_sg_cases,
  kind       text NOT NULL,
  actor_id   uuid REFERENCES users,
  detail     text CHECK (detail IS NULL OR length(detail) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_sg_case_log_case ON academy_sg_case_log (case_id, created_at);
DROP TRIGGER IF EXISTS academy_sg_case_log_guard ON academy_sg_case_log;
CREATE TRIGGER academy_sg_case_log_guard BEFORE UPDATE OR DELETE ON academy_sg_case_log FOR EACH ROW EXECUTE FUNCTION youth_history_guard();
