-- Sports Disciplinary & Sanctions (issue #479). Additive only: new disc_* tables, one nullable column and one widened CHECK. No DROP / TRUNCATE / ON DELETE CASCADE.
-- A card is already a canonical match_events row and a report is already an official_reports row: cases REFERENCE them, they are never copied into a second incident log.
-- Decisions, sanctions, policy versions, events and attestations are append-only (history is superseded, never edited or deleted). Served matches are derived from fixtures, never stored.
-- Named disc_* on purpose: fed_sanctions is a governing body sanctioning an EVENT, int_* is the strictly need-to-know integrity domain; neither is reused or changed.

-- who sits on a competition's disciplinary panel (the organiser and org owners/admins already may act through canManageCompetition)
CREATE TABLE IF NOT EXISTS disc_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES comp_competitions,
  user_id        uuid NOT NULL REFERENCES users,
  role           text NOT NULL CHECK (role IN ('panel','secretary')),
  added_by       uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS disc_members_live ON disc_members (competition_id, user_id) WHERE ended_at IS NULL;

-- versioned policy: one per competition (season_id NULL = the competition default) with immutable versions
CREATE TABLE IF NOT EXISTS disc_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES comp_competitions,
  season_id      uuid REFERENCES comp_seasons,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS disc_policies_scope ON disc_policies (competition_id, COALESCE(season_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE IF NOT EXISTS disc_policy_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id    uuid NOT NULL REFERENCES disc_policies,
  version      int  NOT NULL CHECK (version >= 1),
  params       jsonb NOT NULL,
  note         text CHECK (note IS NULL OR length(note) <= 500),
  published_by uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);

CREATE TABLE IF NOT EXISTS disc_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no         text NOT NULL UNIQUE,
  competition_id  uuid NOT NULL REFERENCES comp_competitions,
  season_id       uuid NOT NULL REFERENCES comp_seasons,
  event_id        uuid NOT NULL REFERENCES events,
  sport_id        uuid NOT NULL REFERENCES sports,
  policy_version_id uuid REFERENCES disc_policy_versions,
  source_type     text NOT NULL CHECK (source_type IN ('match_event','official_report','manual_referral','threshold')),
  match_event_id  uuid REFERENCES match_events,
  official_report_id uuid REFERENCES official_reports,
  fixture_id      uuid REFERENCES fixtures,
  subject_kind    text NOT NULL CHECK (subject_kind IN ('player','team','coach','official')),
  subject_user_id uuid REFERENCES users,
  subject_team_id uuid REFERENCES teams,
  team_id         uuid REFERENCES teams,                  -- the team whose matches count toward a match suspension (the person's team at the time, or the subject team)
  category       text NOT NULL CHECK (length(category) BETWEEN 2 AND 60),
  status          text NOT NULL DEFAULT 'opened' CHECK (status IN ('opened','under_review','decided','closed','withdrawn')),
  interim_status  text NOT NULL DEFAULT 'none' CHECK (interim_status IN ('none','pending_review','interim_suspension')),
  interim_until   date,
  reevaluation    text CHECK (reevaluation IS NULL OR reevaluation IN ('flagged','reviewed')),
  summary_enc     text,                                     -- allegation / referral text (personal free text)
  notes_enc       text,                                     -- internal panel notes, never shown to the subject
  row_version     int NOT NULL DEFAULT 1,
  opened_by       uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_kind = 'team' AND subject_team_id IS NOT NULL) OR (subject_kind <> 'team' AND subject_user_id IS NOT NULL))
);
-- one card (or report) feeds one case per person: a retry or a second sweep never makes a duplicate
CREATE UNIQUE INDEX IF NOT EXISTS disc_cases_event_once ON disc_cases (match_event_id, subject_user_id) WHERE match_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS disc_cases_report_once ON disc_cases (official_report_id, subject_user_id) WHERE official_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS disc_cases_comp ON disc_cases (competition_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS disc_cases_subject ON disc_cases (subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS disc_cases_team ON disc_cases (subject_team_id) WHERE subject_team_id IS NOT NULL;
CREATE SEQUENCE IF NOT EXISTS disc_case_seq;

CREATE TABLE IF NOT EXISTS disc_evidence (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES disc_cases,
  appeal_id  uuid,
  kind       text NOT NULL CHECK (kind IN ('report','video','statement','document','other')),
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body_enc   text,
  sha256     text,
  added_by   uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disc_evidence_case ON disc_evidence (case_id);

CREATE TABLE IF NOT EXISTS disc_events (
  id         bigserial PRIMARY KEY,
  case_id    uuid NOT NULL REFERENCES disc_cases,
  action     text NOT NULL,
  actor_id   uuid REFERENCES users,
  from_status text,
  to_status  text,
  reason     text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disc_events_case ON disc_events (case_id, id);

-- a decision is immutable; an amendment / appeal outcome / reversal is a NEW row that supersedes the previous one
CREATE TABLE IF NOT EXISTS disc_decisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES disc_cases,
  kind         text NOT NULL CHECK (kind IN ('initial','amendment','appeal_outcome','reversal')),
  outcome      text NOT NULL CHECK (outcome IN ('upheld','dismissed','no_further_action')),
  authority    text NOT NULL CHECK (authority IN ('organiser','panel','appeal_panel','policy')),   -- 'policy' = the published automatic threshold applied by the platform
  policy_version_id uuid REFERENCES disc_policy_versions,
  reason_enc   text NOT NULL,
  automatic    boolean NOT NULL DEFAULT false,
  decided_by   uuid REFERENCES users,
  CHECK (automatic OR decided_by IS NOT NULL),
  supersedes_id uuid REFERENCES disc_decisions,
  superseded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS disc_decisions_one_live ON disc_decisions (case_id) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS disc_sanctions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   uuid NOT NULL REFERENCES disc_decisions,
  case_id       uuid NOT NULL REFERENCES disc_cases,
  kind          text NOT NULL CHECK (kind IN ('warning','match_suspension','date_suspension','competition_ban','role_suspension','fine','points_deduction','other')),
  scope         text NOT NULL DEFAULT 'competition' CHECK (scope IN ('competition','sport')),
  matches       int CHECK (matches IS NULL OR matches BETWEEN 1 AND 200),
  effective_from date,
  effective_to   date,
  amount_minor   bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  currency       text,
  points         int CHECK (points IS NULL OR points BETWEEN 1 AND 100),
  label          text CHECK (label IS NULL OR length(label) <= 120),
  team_charge_id uuid REFERENCES team_charges,
  comp_adjustment_id uuid REFERENCES comp_adjustments,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stayed','lifted','superseded')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disc_sanctions_case ON disc_sanctions (case_id);
CREATE INDEX IF NOT EXISTS disc_sanctions_active ON disc_sanctions (status, kind) WHERE status IN ('active','stayed');

CREATE TABLE IF NOT EXISTS disc_appeals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES disc_cases,
  decision_id uuid NOT NULL REFERENCES disc_decisions,
  lodged_by   uuid NOT NULL REFERENCES users,
  grounds_enc text NOT NULL,
  deadline_on date NOT NULL,
  stay        boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'lodged' CHECK (status IN ('lodged','under_review','upheld','reduced','overturned','remitted')),
  reviewer_id uuid REFERENCES users,
  outcome_decision_id uuid REFERENCES disc_decisions,
  outcome_note_enc text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS disc_appeals_open ON disc_appeals (decision_id) WHERE status IN ('lodged','under_review');

-- official verification of a person's standing, asked by an entitled organiser/official/academy and answered by an Official verifier. Attestation only: no sanction detail is ever stored here.
CREATE TABLE IF NOT EXISTS disc_verification_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no    text NOT NULL UNIQUE,
  requester_id  uuid NOT NULL REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  subject_user_id uuid NOT NULL REFERENCES users,
  sport_id      uuid NOT NULL REFERENCES sports,
  competition_id uuid REFERENCES comp_competitions,
  purpose       text NOT NULL CHECK (purpose IN ('event_entry','tournament_selection','academy_admission','official_appointment','other')),
  note_enc      text,
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_review','decided','withdrawn')),
  verifier_id   uuid REFERENCES users,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disc_vreq_queue ON disc_verification_requests (status, created_at);
CREATE INDEX IF NOT EXISTS disc_vreq_requester ON disc_verification_requests (requester_id, created_at DESC);
CREATE SEQUENCE IF NOT EXISTS disc_vreq_seq;
CREATE TABLE IF NOT EXISTS disc_attestations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES disc_verification_requests,
  result      text NOT NULL CHECK (result IN ('eligible','not_eligible','unable_to_verify')),
  as_of       date NOT NULL,
  valid_until date NOT NULL,
  issued_by   uuid NOT NULL REFERENCES users,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS disc_attest_live ON disc_attestations (request_id) WHERE revoked_at IS NULL;

-- history guards: decisions keep their facts; only the supersession mark may change. events / attestations never change except revocation.
CREATE OR REPLACE FUNCTION disc_decision_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Disciplinary decisions are never deleted'; END IF;
  IF NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.reason_enc IS DISTINCT FROM OLD.reason_enc OR NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
    RAISE EXCEPTION 'A disciplinary decision cannot be edited; record an amendment instead';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS disc_decision_guard ON disc_decisions;
CREATE TRIGGER disc_decision_guard BEFORE UPDATE OR DELETE ON disc_decisions FOR EACH ROW EXECUTE FUNCTION disc_decision_guard();
CREATE OR REPLACE FUNCTION disc_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'This history is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS disc_events_append_only ON disc_events;
CREATE TRIGGER disc_events_append_only BEFORE UPDATE OR DELETE ON disc_events FOR EACH ROW EXECUTE FUNCTION disc_append_only();
DROP TRIGGER IF EXISTS disc_policy_versions_append_only ON disc_policy_versions;
CREATE TRIGGER disc_policy_versions_append_only BEFORE UPDATE OR DELETE ON disc_policy_versions FOR EACH ROW EXECUTE FUNCTION disc_append_only();

-- points deductions are made THROUGH the competition adjustment mechanism; this is the traceable link back to the sanction (additive, nullable)
ALTER TABLE comp_adjustments ADD COLUMN IF NOT EXISTS disc_sanction_id uuid REFERENCES disc_sanctions;
-- fines are raised as ordinary team charges (canonical finance) of kind 'fine'
ALTER TABLE team_charge_batches DROP CONSTRAINT IF EXISTS team_charge_batches_kind_check;
ALTER TABLE team_charge_batches ADD CONSTRAINT team_charge_batches_kind_check CHECK (kind IN ('dues','season_fee','match_fee','expense','fine'));
