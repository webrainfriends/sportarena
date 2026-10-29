-- Global Compliance, Policy & Evidence Engine (issue #568). Additive only: nothing is dropped, rewritten or deleted.
-- One reusable engine for procurement, event permits, federation eligibility, accreditation, youth safeguarding and privacy rules.
-- Rules are DATA (a jurisdiction pack is a set of rules, never a code fork). Federation policies stay in fed_policies (#68) and are read
-- by the engine as "federation mandated" rules; supplier credentials, licences and guardian consent stay where they are and are read live.
-- Rule versions, decisions and reviewed evidence are immutable: history is retained so any past decision can be explained with the rule
-- text that was in force.

CREATE OR REPLACE FUNCTION cmp_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = '23000'; END $$;

-- ---- the rule: a stable identity that versions hang from
CREATE TABLE cmp_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  scope_kind      text NOT NULL CHECK (scope_kind IN ('platform','organisation')),
  organisation_id uuid REFERENCES organisations,
  domains         text[] NOT NULL CHECK (cardinality(domains) BETWEEN 1 AND 7
                    AND domains <@ ARRAY['procurement','event_permit','federation_eligibility','accreditation','youth_safeguarding','privacy','general']),
  topic           text NOT NULL CHECK (topic ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),   -- rules of one topic compete; different topics add up
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_kind = 'platform') = (organisation_id IS NULL))
);
CREATE UNIQUE INDEX cmp_rules_key ON cmp_rules (key);
CREATE INDEX cmp_rules_org ON cmp_rules (organisation_id) WHERE organisation_id IS NOT NULL;

-- ---- an immutable version of a rule
CREATE TABLE cmp_rule_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid NOT NULL REFERENCES cmp_rules,
  version         int  NOT NULL CHECK (version >= 1),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','withdrawn')),
  repeals         boolean NOT NULL DEFAULT false,           -- an approved repeal ends the rule from its effective date
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  summary         text CHECK (summary IS NULL OR length(summary) <= 1500),
  classification  text NOT NULL CHECK (classification IN ('legal_mandatory','regulatory','federation_mandated','organisation_policy','contractual','recommended_standard')),
  country         text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  region          text CHECK (region IS NULL OR length(region) BETWEEN 1 AND 80),
  municipality    text CHECK (municipality IS NULL OR length(municipality) BETWEEN 1 AND 80),
  applies         jsonb NOT NULL DEFAULT '{}',              -- { federation_ids, event_ids, organisation_ids, venue_ids, event_types, sports, roles, min_age, max_age }
  effective_from  date NOT NULL,
  effective_to    date,
  source_title    text CHECK (source_title IS NULL OR length(source_title) <= 200),
  source_url      text CHECK (source_url IS NULL OR source_url ~ '^https://'),
  pack_code       text CHECK (pack_code IS NULL OR pack_code ~ '^[A-Za-z0-9._-]{2,40}$'),
  approval_owner  text NOT NULL CHECK (length(approval_owner) BETWEEN 3 AND 140),
  requirements    jsonb NOT NULL DEFAULT '[]',              -- [{ key, kind, label, holder, warn_days, max_age_days }]
  waivable        boolean NOT NULL DEFAULT false,
  change_note     text CHECK (change_note IS NULL OR length(change_note) <= 500),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid REFERENCES users,
  approved_at     timestamptz,
  self_approved   boolean NOT NULL DEFAULT false,
  UNIQUE (rule_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (NOT (waivable AND classification IN ('legal_mandatory','regulatory')))   -- a law or regulation is never waived by a person
);
CREATE INDEX cmp_rule_versions_live ON cmp_rule_versions (rule_id, effective_from) WHERE status = 'approved';

-- A version's content never changes. Only draft -> approved / withdrawn is allowed, and only the status and approval stamp move.
CREATE OR REPLACE FUNCTION cmp_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'rule versions are never deleted' USING ERRCODE = '23000'; END IF;
  IF OLD.status <> 'draft' OR NEW.status NOT IN ('approved','withdrawn')
     OR (to_jsonb(NEW) - 'status' - 'approved_by' - 'approved_at' - 'self_approved') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'approved_by' - 'approved_at' - 'self_approved') THEN
    RAISE EXCEPTION 'a rule version is immutable; publish a new version instead' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cmp_rule_versions_guard BEFORE UPDATE OR DELETE ON cmp_rule_versions FOR EACH ROW EXECUTE FUNCTION cmp_version_guard();
CREATE TRIGGER cmp_rules_no_delete BEFORE DELETE ON cmp_rules FOR EACH ROW EXECUTE FUNCTION cmp_append_only();

-- ---- evidence the engine owns (permits, declarations, training, background-check status, approvals ...)
-- Licences, supplier credentials and guardian consent stay in their own tables and are read live; they are never copied here.
CREATE TABLE cmp_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_type       text NOT NULL CHECK (holder_type IN ('person','organisation','event','venue','tender','supplier_entity')),
  holder_id         uuid NOT NULL,
  context_event_id  uuid REFERENCES events,                 -- set: reviewed by that event's organiser and counted only there. NULL: platform-reviewed, counted everywhere
  kind              text NOT NULL CHECK (kind IN ('licence','permit','declaration','certificate','training','insurance','background_check','signed_document','approval')),
  requirement_key   text CHECK (requirement_key IS NULL OR requirement_key ~ '^[a-z0-9][a-z0-9._-]{1,59}$'),
  title             text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  issuer            text CHECK (issuer IS NULL OR length(issuer) <= 140),
  reference_enc     text,                                    -- licence / permit / certificate number: encrypted, shown only to the holder side and reviewers
  document_ref      text CHECK (document_ref IS NULL OR length(document_ref) <= 300),
  issued_on         date,
  valid_from        date,
  valid_to          date,
  status            text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected','revoked')),
  submitted_by      uuid NOT NULL REFERENCES users,
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_by       uuid REFERENCES users,
  reviewed_at       timestamptz,
  review_note_enc   text,
  verified_what     text CHECK (verified_what IS NULL OR length(verified_what) <= 300),   -- what the reviewer actually checked
  supersedes_id     uuid REFERENCES cmp_evidence,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX cmp_evidence_holder ON cmp_evidence (holder_type, holder_id, kind);
CREATE INDEX cmp_evidence_event ON cmp_evidence (context_event_id) WHERE context_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION cmp_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'evidence is never deleted' USING ERRCODE = '23000'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note_enc' - 'verified_what') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note_enc' - 'verified_what')
     OR (OLD.status IN ('rejected','revoked')) OR (OLD.status = 'verified' AND NEW.status <> 'revoked') THEN
    RAISE EXCEPTION 'submitted evidence is immutable; submit a replacement' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cmp_evidence_guard BEFORE UPDATE OR DELETE ON cmp_evidence FOR EACH ROW EXECUTE FUNCTION cmp_evidence_guard();

-- ---- exceptions: a named person waives one waivable rule for one holder, for a limited time, with a reason
CREATE TABLE cmp_exceptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id          uuid NOT NULL REFERENCES cmp_rules,
  holder_type      text NOT NULL CHECK (holder_type IN ('person','organisation','event','venue','tender','supplier_entity')),
  holder_id        uuid NOT NULL,
  context_event_id uuid REFERENCES events,
  reason_enc       text NOT NULL,
  granted_by       uuid NOT NULL REFERENCES users,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users,
  revoke_reason_enc text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from)
);
CREATE INDEX cmp_exceptions_holder ON cmp_exceptions (holder_type, holder_id, rule_id);
CREATE OR REPLACE FUNCTION cmp_exception_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'exceptions are never deleted' USING ERRCODE = '23000'; END IF;
  IF (to_jsonb(NEW) - 'revoked_at' - 'revoked_by' - 'revoke_reason_enc') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revoked_by' - 'revoke_reason_enc') OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'an exception can only be revoked' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cmp_exceptions_guard BEFORE UPDATE OR DELETE ON cmp_exceptions FOR EACH ROW EXECUTE FUNCTION cmp_exception_guard();

-- ---- every decision the engine took or enforced: rule versions, input facts, evidence and exceptions used, who and when
CREATE TABLE cmp_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain         text NOT NULL,
  subject_type   text NOT NULL,
  subject_id     uuid NOT NULL,
  context_event_id uuid,                                                   -- no FK on purpose: a refused attempt is logged on its own connection while the event row is locked
  trigger        text NOT NULL CHECK (length(trigger) BETWEEN 2 AND 60),   -- e.g. accreditation_approve, event_open, award_recommend, manual
  as_of          date NOT NULL,
  facts          jsonb NOT NULL,
  results        jsonb NOT NULL,                                          -- per rule: version id + number, outcome, status, requirement results, evidence ids, exceptions
  overall        text NOT NULL CHECK (overall IN ('compliant','expiring','pending','missing','exception','non_compliant','unknown','no_rules')),
  blocked        boolean NOT NULL,
  override_exception_ids uuid[] NOT NULL DEFAULT '{}',
  decided_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cmp_decisions_subject ON cmp_decisions (subject_type, subject_id, created_at DESC);
CREATE INDEX cmp_decisions_event ON cmp_decisions (context_event_id, created_at DESC) WHERE context_event_id IS NOT NULL;
CREATE TRIGGER cmp_decisions_append_only BEFORE UPDATE OR DELETE ON cmp_decisions FOR EACH ROW EXECUTE FUNCTION cmp_append_only();
