-- Para-sport Classification & Eligibility (#488). Additive only: new tables, no changes to existing data.
-- An administrative sporting classification, NOT a diagnosis. The competition-facing outcome (para_outcomes) is kept apart from the sensitive
-- workflow (para_cases, para_case_panel, para_evidence, para_appeals), which only assigned classifiers/reviewers and the athlete/guardian can read.
-- Nothing here is ever deleted: rows are superseded, retired or closed; history is append-only.

-- 1. Governed, versioned classification definitions (per governing body + sport/discipline). A published version is immutable.
CREATE TABLE IF NOT EXISTS para_class_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id        uuid NOT NULL REFERENCES governing_bodies,
  sport_id       uuid NOT NULL REFERENCES sports,
  discipline     text NOT NULL DEFAULT '' CHECK (length(discipline) <= 60),
  version        int  NOT NULL CHECK (version >= 1),
  title          text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  source_ref     text NOT NULL CHECK (length(source_ref) BETWEEN 2 AND 500),   -- the governing document / rulebook this version transcribes
  effective_from date NOT NULL,
  effective_to   date,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  panel_size     int  NOT NULL DEFAULT 1 CHECK (panel_size BETWEEN 1 AND 7),   -- classifiers who must independently agree (per the governing process)
  review_rule    text NOT NULL DEFAULT 'none' CHECK (review_rule IN ('none','fixed_term','review_required')),
  review_months  int CHECK (review_months IS NULL OR review_months BETWEEN 1 AND 240),
  appeal_days    int NOT NULL DEFAULT 14 CHECK (appeal_days BETWEEN 1 AND 365),
  created_by     uuid NOT NULL REFERENCES users,
  published_by   uuid REFERENCES users,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (body_id, sport_id, discipline, version)
);
CREATE INDEX IF NOT EXISTS para_class_versions_sport ON para_class_versions (sport_id, status);

CREATE TABLE IF NOT EXISTS para_classes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id   uuid NOT NULL REFERENCES para_class_versions,
  code         text NOT NULL CHECK (length(code) BETWEEN 1 AND 20),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  events       text[] NOT NULL DEFAULT '{}',        -- event/discipline applicability within the sport
  categories   text[] NOT NULL DEFAULT '{}',        -- competition categories it applies to
  status_rules text CHECK (status_rules IS NULL OR length(status_rules) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, code)
);

CREATE OR REPLACE FUNCTION para_published_guard() RETURNS trigger AS $$
DECLARE v para_class_versions;
BEGIN
  IF TG_TABLE_NAME = 'para_class_versions' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'classification versions are never deleted' USING ERRCODE = 'check_violation'; END IF;
    IF OLD.status <> 'draft' AND (NEW.body_id <> OLD.body_id OR NEW.sport_id <> OLD.sport_id OR NEW.discipline <> OLD.discipline OR NEW.version <> OLD.version OR NEW.title <> OLD.title
       OR NEW.source_ref <> OLD.source_ref OR NEW.effective_from <> OLD.effective_from OR NEW.panel_size <> OLD.panel_size OR NEW.review_rule <> OLD.review_rule
       OR NEW.review_months IS DISTINCT FROM OLD.review_months OR NEW.appeal_days <> OLD.appeal_days) THEN
      RAISE EXCEPTION 'a published classification version is immutable; publish a new version' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN RAISE EXCEPTION 'a retired version stays retired' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN SELECT * INTO v FROM para_class_versions WHERE id = OLD.version_id; ELSE SELECT * INTO v FROM para_class_versions WHERE id = COALESCE(NEW.version_id, OLD.version_id); END IF;
  IF v.status <> 'draft' THEN RAISE EXCEPTION 'classes of a published version are immutable' USING ERRCODE = 'check_violation'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS para_class_versions_guard ON para_class_versions;
CREATE TRIGGER para_class_versions_guard BEFORE UPDATE OR DELETE ON para_class_versions FOR EACH ROW EXECUTE FUNCTION para_published_guard();
DROP TRIGGER IF EXISTS para_classes_guard ON para_classes;
CREATE TRIGGER para_classes_guard BEFORE INSERT OR UPDATE OR DELETE ON para_classes FOR EACH ROW EXECUTE FUNCTION para_published_guard();

-- 2. Classifier credentials. Nobody becomes a classifier through another role or a clinical credential: only a row here, live and in scope.
CREATE TABLE IF NOT EXISTS para_classifiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users,
  body_id       uuid NOT NULL REFERENCES governing_bodies,   -- issuing body
  sport_id      uuid NOT NULL REFERENCES sports,
  discipline    text NOT NULL DEFAULT '' CHECK (length(discipline) <= 60),
  class_codes   text[] NOT NULL DEFAULT '{}',                -- empty = every class of the sport/discipline
  jurisdiction  text CHECK (jurisdiction IS NULL OR length(jurisdiction) <= 60),
  grade         text NOT NULL CHECK (length(grade) BETWEEN 1 AND 60),
  credential_no_enc text,
  issued_on     date NOT NULL,
  expires_on    date NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  granted_by    uuid NOT NULL REFERENCES users,
  ended_by      uuid REFERENCES users,
  ended_reason  text CHECK (ended_reason IS NULL OR length(ended_reason) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on >= issued_on)
);
CREATE INDEX IF NOT EXISTS para_classifiers_user ON para_classifiers (user_id, status);

-- 3. Classification cases (administrative workflow only; no diagnosis fields).
CREATE TABLE IF NOT EXISTS para_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL REFERENCES users,
  body_id       uuid NOT NULL REFERENCES governing_bodies,    -- responsible classification authority
  sport_id      uuid NOT NULL REFERENCES sports,
  discipline    text NOT NULL DEFAULT '' CHECK (length(discipline) <= 60),
  version_id    uuid NOT NULL REFERENCES para_class_versions, -- the definition in force when the case opened
  requested_context text NOT NULL DEFAULT 'initial' CHECK (requested_context IN ('initial','review','reassessment','international')),
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','evidence_review','assessment_scheduled','assessment_completed','panel_review','decision_issued','incomplete','withdrawn','closed')),
  appointment_on timestamptz,
  appointment_ref_enc text,
  note_enc      text,                                         -- administrative note from the requester
  initiated_by  uuid NOT NULL REFERENCES users,
  initiated_for text NOT NULL DEFAULT 'athlete' CHECK (initiated_for IN ('athlete','guardian','federation')),
  outcome_id    uuid,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_cases_athlete ON para_cases (athlete_id, created_at DESC);
CREATE INDEX IF NOT EXISTS para_cases_queue ON para_cases (body_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS para_cases_one_open ON para_cases (athlete_id, sport_id, discipline)
  WHERE status NOT IN ('decision_issued','incomplete','withdrawn','closed');

CREATE TABLE IF NOT EXISTS para_case_panel (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES para_cases,
  classifier_id uuid NOT NULL REFERENCES para_classifiers,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member','observer')),
  decision_class_code text,                                   -- independent recommendation; null until given
  decision_status text CHECK (decision_status IS NULL OR decision_status IN ('confirmed','review_required','temporary','not_eligible','other')),
  decided_at    timestamptz,
  assigned_by   uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, classifier_id)
);

-- Sensitive medical / functional evidence. Encrypted, only specifically authorised reviewers read it; every read is audited.
CREATE TABLE IF NOT EXISTS para_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES para_cases,
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  reference_enc text,                                         -- external-authority reference (number / https link)
  file_name     text, content_type text, size_bytes int, sha256 text, file_enc text,
  added_by      uuid NOT NULL REFERENCES users,
  retired_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (reference_enc IS NOT NULL OR file_enc IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS para_evidence_case ON para_evidence (case_id) WHERE retired_at IS NULL;

-- 4. Competition-facing outcome: the minimum a competition may see. A new outcome supersedes the old prospectively; old rows stay for reproducing history.
CREATE TABLE IF NOT EXISTS para_outcomes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL REFERENCES users,
  sport_id      uuid NOT NULL REFERENCES sports,
  discipline    text NOT NULL DEFAULT '' CHECK (length(discipline) <= 60),
  version_id    uuid NOT NULL REFERENCES para_class_versions,
  case_id       uuid REFERENCES para_cases,
  appeal_id     uuid,
  class_code    text,
  status        text NOT NULL CHECK (status IN ('confirmed','review_required','temporary','not_eligible','other')),
  effective_from date NOT NULL,
  review_by     date,
  expires_on    date,
  authority_id  uuid NOT NULL REFERENCES governing_bodies,
  decision_ref  text NOT NULL CHECK (length(decision_ref) BETWEEN 2 AND 60),
  external_ref_id uuid,
  supersedes_id uuid REFERENCES para_outcomes,
  superseded_at timestamptz,
  issued_by     uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('not_eligible','other') OR class_code IS NOT NULL),
  CHECK (review_by IS NULL OR review_by >= effective_from),
  CHECK (expires_on IS NULL OR expires_on >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS para_outcomes_one_live ON para_outcomes (athlete_id, sport_id, discipline) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS para_outcomes_athlete ON para_outcomes (athlete_id, sport_id, created_at DESC);

-- 5. Review / protest / appeal. One open request per decision; grounds are encrypted.
CREATE TABLE IF NOT EXISTS para_appeals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome_id    uuid NOT NULL REFERENCES para_outcomes,
  kind          text NOT NULL CHECK (kind IN ('review','protest','appeal')),
  grounds_enc   text NOT NULL,
  lodged_by     uuid NOT NULL REFERENCES users,
  deadline_on   date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','dismissed','withdrawn')),
  reviewer_id   uuid REFERENCES para_classifiers,
  ruling_enc    text,
  ruled_by      uuid REFERENCES users,
  ruled_at      timestamptz,
  resulting_outcome_id uuid REFERENCES para_outcomes,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS para_appeals_one_open ON para_appeals (outcome_id) WHERE status = 'open';

-- 6. External authority reference (reference-only: no automatic feed; the signed exchange is #483). Matched by stable id, never by name.
CREATE TABLE IF NOT EXISTS para_external_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL REFERENCES users,
  sport_id      uuid NOT NULL REFERENCES sports,
  discipline    text NOT NULL DEFAULT '' CHECK (length(discipline) <= 60),
  source_body_id uuid NOT NULL REFERENCES governing_bodies,
  external_id_idx text NOT NULL,                              -- blind index of the authority's stable id (idempotent replay)
  external_id_enc text NOT NULL,
  class_code    text NOT NULL,
  class_status  text NOT NULL CHECK (class_status IN ('confirmed','review_required','temporary','not_eligible','other')),
  effective_from date NOT NULL,
  review_by     date,
  provenance    text NOT NULL CHECK (length(provenance) BETWEEN 2 AND 300),
  status        text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified','rejected')),
  recorded_by   uuid NOT NULL REFERENCES users,
  verified_by   uuid REFERENCES users,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (verified_by IS NULL OR verified_by <> recorded_by),   -- a second officer verifies
  UNIQUE (source_body_id, external_id_idx)
);

-- 7. Append-only history for every step.
CREATE TABLE IF NOT EXISTS para_history (
  id          bigserial PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('version','classifier','case','outcome','appeal','external_ref')),
  subject_id  uuid NOT NULL,
  athlete_id  uuid,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  actor_id    uuid REFERENCES users,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_history_subject ON para_history (subject_type, subject_id, id);

CREATE OR REPLACE FUNCTION para_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'classification history is append-only' USING ERRCODE = 'check_violation'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS para_history_guard ON para_history;
CREATE TRIGGER para_history_guard BEFORE UPDATE OR DELETE ON para_history FOR EACH ROW EXECUTE FUNCTION para_append_only();

-- Outcomes keep their decision fields forever; only the supersede stamp may change.
CREATE OR REPLACE FUNCTION para_outcome_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'classification outcomes are never deleted' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.athlete_id <> OLD.athlete_id OR NEW.sport_id <> OLD.sport_id OR NEW.version_id <> OLD.version_id OR NEW.class_code IS DISTINCT FROM OLD.class_code OR NEW.status <> OLD.status
     OR NEW.effective_from <> OLD.effective_from OR NEW.review_by IS DISTINCT FROM OLD.review_by OR NEW.expires_on IS DISTINCT FROM OLD.expires_on OR NEW.decision_ref <> OLD.decision_ref
     OR NEW.authority_id <> OLD.authority_id OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'a classification outcome is immutable; issue a new one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS para_outcomes_guard ON para_outcomes;
CREATE TRIGGER para_outcomes_guard BEFORE UPDATE OR DELETE ON para_outcomes FOR EACH ROW EXECUTE FUNCTION para_outcome_guard();
