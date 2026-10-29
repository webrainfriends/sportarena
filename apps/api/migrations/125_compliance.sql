-- Compliance, safeguarding & eligibility platform (#595). Additive only: nothing is dropped, rewritten or narrowed, and nothing here deletes data
-- (requirements and obligations are archived; records are superseded, revoked or withdrawn; the history is append-only).
--
--   comp_requirements  WHAT is required (a certificate, a background-check status, a declaration, a permit …), owned by a scope
--                      (platform | organisation | governing body | event). `method` says how it is satisfied: by evidence a person submits and a reviewer
--                      decides, by a self-declaration/acknowledgement, or LINKED to a canonical record that already exists (a platform verification,
--                      a federation licence, a supplier credential) which is read live and never copied.
--   comp_obligations   WHO must satisfy it, since when, how mandatory it is and what an unmet one blocks (contact with or access to young people, competition registration,
--                      accreditation). Rules are data; there is no module-specific compliance code.
--   comp_records       what a subject (person, organisation or event) has provided: status, validity, outcome (background checks keep only
--                      clear / not clear / pending) and encrypted reference / free text.
--   comp_waivers       an authorised, time-boxed exception with a reason; it never rewrites the record or the rule.
--   comp_events        append-only history.   comp_reminders  one row per reminder or escalation actually sent (idempotent sweeps).
--   comp_packs         an evidence pack for an authorised reviewer: a frozen, hashed summary (never references or free text) that expires and is read-audited.
CREATE TABLE IF NOT EXISTS comp_requirements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind      text NOT NULL CHECK (scope_kind IN ('platform','organisation','body','event')),
  scope_id        uuid,                                                   -- null only for the platform
  code            text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description     text CHECK (description IS NULL OR length(description) <= 1000),
  category        text NOT NULL CHECK (category IN ('qualification','background_check','safeguarding_training','safeguarding_acknowledgement','federation_requirement','event_permit','insurance','licence','declaration','conflict_of_interest','attestation','other')),
  subject_kind    text NOT NULL CHECK (subject_kind IN ('person','organisation','event')),
  method          text NOT NULL CHECK (method IN ('evidence','declaration','linked')),
  source          jsonb NOT NULL DEFAULT '{}',                            -- method = linked: { kind: 'verification' | 'federation_licence' | 'service_credential', ... }
  sensitive       boolean NOT NULL DEFAULT false,                         -- references are visible to the holder / guardian only; reviewers see the outcome
  requires_review boolean NOT NULL DEFAULT true,                          -- evidence is valid only after a reviewer approves it
  validity_days   integer CHECK (validity_days IS NULL OR validity_days BETWEEN 1 AND 3660),
  reminder_days   integer[] NOT NULL DEFAULT '{60,30,7}',
  grace_days      integer NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 180),
  escalate_after_days integer NOT NULL DEFAULT 7 CHECK (escalate_after_days BETWEEN 0 AND 180),
  statement       text CHECK (statement IS NULL OR length(statement) <= 4000),   -- declarations and acknowledgements: exactly what the person agrees to
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CHECK ((scope_kind = 'platform') = (scope_id IS NULL)),
  CHECK (method <> 'declaration' OR statement IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS comp_requirements_code ON comp_requirements (scope_kind, scope_id, code) NULLS NOT DISTINCT WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS comp_requirements_scope ON comp_requirements (scope_kind, scope_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS comp_requirement_versions (                   -- the wording and rules each version of a requirement had, so an old record can be explained
  requirement_id  uuid NOT NULL REFERENCES comp_requirements,
  version         integer NOT NULL,
  snapshot        jsonb NOT NULL,
  changed_by      uuid NOT NULL REFERENCES users,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requirement_id, version)
);

CREATE TABLE IF NOT EXISTS comp_obligations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES comp_requirements,
  roles           text[] NOT NULL DEFAULT '{}',                           -- roles / engagements / kinds it applies to; empty = everyone in the scope
  sport_id        uuid REFERENCES sports,
  youth_work      boolean NOT NULL DEFAULT false,                         -- only adults who lead, coach or manage young people in the scope
  mandatory       boolean NOT NULL DEFAULT true,
  consequences    text[] NOT NULL DEFAULT '{}' CHECK (consequences <@ ARRAY['youth_contact','youth_access','registration','accreditation']),
  starts_on       date NOT NULL DEFAULT current_date,
  ends_on         date,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX IF NOT EXISTS comp_obligations_req ON comp_obligations (requirement_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS comp_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES comp_requirements,
  requirement_version integer NOT NULL,
  subject_kind    text NOT NULL CHECK (subject_kind IN ('person','organisation','event')),
  subject_id      uuid NOT NULL,
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','valid','rejected','revoked','withdrawn','superseded')),
  outcome         text CHECK (outcome IS NULL OR outcome IN ('clear','not_clear','pending')),   -- background checks keep only this, never the underlying detail
  issued_on       date,
  expires_on      date,
  provider        text CHECK (provider IS NULL OR length(provider) <= 120),
  reference_enc   text,                                                   -- certificate / check / permit / policy number
  detail_enc      text,                                                   -- declared conflict or free text
  statement_version integer,
  submitted_by    uuid NOT NULL REFERENCES users,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  previous_id     uuid REFERENCES comp_records,                           -- a renewal points at the record it renews
  row_version     integer NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comp_records_subject ON comp_records (subject_kind, subject_id, requirement_id, status);
CREATE INDEX IF NOT EXISTS comp_records_queue ON comp_records (requirement_id, submitted_at) WHERE status = 'submitted';
CREATE INDEX IF NOT EXISTS comp_records_expiry ON comp_records (expires_on) WHERE status = 'valid' AND expires_on IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS comp_records_one_open ON comp_records (requirement_id, subject_kind, subject_id) WHERE status = 'submitted';

CREATE TABLE IF NOT EXISTS comp_waivers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES comp_requirements,
  subject_kind    text NOT NULL CHECK (subject_kind IN ('person','organisation','event')),
  subject_id      uuid NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  effective_from  date NOT NULL DEFAULT current_date,
  effective_to    date NOT NULL,
  granted_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users,
  CHECK (effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS comp_waivers_subject ON comp_waivers (requirement_id, subject_kind, subject_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS comp_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requirement_id  uuid REFERENCES comp_requirements,
  record_id       uuid REFERENCES comp_records,
  subject_kind    text,
  subject_id      uuid,
  actor_id        uuid REFERENCES users,
  action          text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',                            -- never a reference, a number or free text
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comp_events_subject ON comp_events (subject_kind, subject_id, at DESC);
CREATE INDEX IF NOT EXISTS comp_events_requirement ON comp_events (requirement_id, at DESC);

CREATE TABLE IF NOT EXISTS comp_reminders (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_id       uuid NOT NULL REFERENCES comp_records,
  stage           text NOT NULL,                                          -- 'before:30' | 'expired' | 'escalated'
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, stage)
);

CREATE TABLE IF NOT EXISTS comp_packs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind      text NOT NULL CHECK (scope_kind IN ('platform','organisation','body','event','person')),
  scope_id        uuid,
  purpose         text NOT NULL CHECK (length(purpose) BETWEEN 5 AND 300),
  recipient_id    uuid NOT NULL REFERENCES users,
  content         jsonb NOT NULL,
  sha256          text NOT NULL,
  generated_by    uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users
);
CREATE INDEX IF NOT EXISTS comp_packs_recipient ON comp_packs (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS comp_packs_scope ON comp_packs (scope_kind, scope_id, created_at DESC);
