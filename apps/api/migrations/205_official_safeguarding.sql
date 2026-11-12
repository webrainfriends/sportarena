-- Official Safety & Safeguarding Escalation — Issue #1029 (REF-R31)
-- Additive only: new tables, new column on fixture_officials. No DROP / TRUNCATE / data deletion.
-- Pattern: academy_safeguarding (#784, migration 185). Rollback: deploy previous build; new tables are ignored.

-- ── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'official_sg_case_type') THEN
    CREATE TYPE official_sg_case_type AS ENUM (
      'abuse', 'harassment', 'bullying', 'coercion', 'discrimination', 'other'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'official_sg_risk_level') THEN
    CREATE TYPE official_sg_risk_level AS ENUM (
      'low', 'medium', 'high', 'immediate'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'official_sg_case_status') THEN
    CREATE TYPE official_sg_case_status AS ENUM (
      'received', 'in_triage', 'assigned', 'active',
      'escalated', 'referred', 'awaiting_closure', 'closed'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'official_sg_action_kind') THEN
    CREATE TYPE official_sg_action_kind AS ENUM (
      'acknowledge', 'assign', 'escalate', 'refer_external',
      'request_info', 'add_note', 'close'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'official_sg_outcome') THEN
    CREATE TYPE official_sg_outcome AS ENUM (
      'upheld', 'partially_upheld', 'not_upheld',
      'no_further_action', 'referred_external', 'withdrawn'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'official_sg_wb_status') THEN
    CREATE TYPE official_sg_wb_status AS ENUM (
      'requested', 'confirmed', 'declined'
    );
  END IF;
END $$;

-- ── Per-organisation safeguarding policy ─────────────────────────────────────
-- One live row per organisation; configure response deadlines, anonymous reporting and mandatory-reporting law.

CREATE TABLE IF NOT EXISTS official_sg_policies (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organisations(id),
  version                 int  NOT NULL DEFAULT 1,
  allow_anonymous         bool NOT NULL DEFAULT false,
  mandatory_reporting_law text,                        -- e.g. 'UK KCSIE 2023' or NULL
  retention_years         smallint NOT NULL DEFAULT 7 CHECK (retention_years BETWEEN 1 AND 50),
  -- response deadline hours by risk level
  ack_hours               jsonb NOT NULL DEFAULT '{"low":48,"medium":24,"high":4,"immediate":1}',
  review_hours            jsonb NOT NULL DEFAULT '{"low":168,"medium":72,"high":24,"immediate":8}',
  created_by              uuid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  retired_at              timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS official_sg_policies_live
  ON official_sg_policies (org_id) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_osgp_org ON official_sg_policies (org_id);

-- ── Designated welfare officers ───────────────────────────────────────────────
-- tier 1 = welfare officer, 2 = lead welfare officer, 3 = welfare liaison.
-- Ends are soft; last active officer cannot be ended while cases are open.

CREATE TABLE IF NOT EXISTS official_welfare_officers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organisations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  tier            smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 3),
  contact_channel text,                -- e.g. phone number or email (stored unencrypted for quick access)
  appointed_by    uuid NOT NULL REFERENCES users(id),
  appointed_at    timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ended_by        uuid REFERENCES users(id),
  end_reason      text CHECK (end_reason IS NULL OR length(end_reason) <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS official_welfare_officers_live
  ON official_welfare_officers (org_id, user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_owo_org ON official_welfare_officers (org_id, ended_at NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_owo_user ON official_welfare_officers (user_id, ended_at NULLS LAST);

-- ── Core safeguarding cases ───────────────────────────────────────────────────
-- reporter_id is NULL for anonymous cases.  narrative_enc is AES-256-GCM via src/crypto.js.

CREATE TABLE IF NOT EXISTS official_sg_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no         bigserial NOT NULL,  -- human-readable "OSG-XXXXX" sequence number
  org_id          uuid NOT NULL REFERENCES organisations(id),
  fixture_id      uuid REFERENCES fixtures(id),
  reporter_id     uuid REFERENCES users(id),  -- NULL = anonymous
  subject_id      uuid REFERENCES users(id),  -- person the concern is about (may be same as reporter)
  case_type       official_sg_case_type  NOT NULL,
  risk_level      official_sg_risk_level NOT NULL,
  status          official_sg_case_status NOT NULL DEFAULT 'received',
  outcome         official_sg_outcome,
  narrative_enc   text NOT NULL,       -- encrypt(narrative, 'official_sg_cases.narrative')
  outcome_note_enc text,               -- encrypt(note, 'official_sg_cases.outcome_note')
  assigned_to     uuid REFERENCES users(id),
  mandatory_reporting_decision text,
  raised_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  CONSTRAINT outcome_when_closed CHECK (status <> 'closed' OR outcome IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_osgc_org      ON official_sg_cases (org_id, status);
CREATE INDEX IF NOT EXISTS idx_osgc_reporter ON official_sg_cases (reporter_id) WHERE reporter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_osgc_fixture  ON official_sg_cases (fixture_id)  WHERE fixture_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_osgc_assigned ON official_sg_cases (assigned_to) WHERE assigned_to IS NOT NULL;

-- ── SHA-256 chained append-only audit log ────────────────────────────────────

CREATE TABLE IF NOT EXISTS official_sg_case_log (
  id          bigserial PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES official_sg_cases(id),
  seq         int  NOT NULL,
  event       text NOT NULL,          -- e.g. 'created', 'read_narrative', 'action:acknowledge'
  actor_id    uuid REFERENCES users(id),
  detail      jsonb NOT NULL DEFAULT '{}',
  hash        text NOT NULL,          -- sha256 of (prev_hash || case_id || seq || event || actor || detail)
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_osgcl_seq ON official_sg_case_log (case_id, seq);

-- ── Workflow actions ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS official_sg_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES official_sg_cases(id),
  kind        official_sg_action_kind NOT NULL,
  actor_id    uuid NOT NULL REFERENCES users(id),
  note_enc    text,                   -- encrypt(note, 'official_sg_actions.note')
  assigned_to uuid REFERENCES users(id),
  outcome     official_sg_outcome,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osga_case ON official_sg_actions (case_id, created_at);

-- ── Evidence attachments ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS official_sg_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES official_sg_cases(id),
  file_key    text NOT NULL,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  visibility  text NOT NULL DEFAULT 'welfare_officer'
                CHECK (visibility IN ('author', 'welfare_officer', 'federation')),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osge_case ON official_sg_evidence (case_id);

-- ── Immediate in-match safety flags ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS official_sg_safety_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id  uuid NOT NULL REFERENCES fixtures(id),
  raised_by   uuid NOT NULL REFERENCES users(id),
  note        text,
  cleared_at  timestamptz,
  cleared_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osgsf_fixture ON official_sg_safety_flags (fixture_id, cleared_at NULLS LAST);

-- ── Anonymous reporter tokens ─────────────────────────────────────────────────
-- Only the salted SHA-256 hash of the token is stored; the token itself is returned once and never persisted.

CREATE TABLE IF NOT EXISTS official_sg_anon_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES official_sg_cases(id),
  token_hash  text NOT NULL UNIQUE,  -- sha256(uuid_token)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osgat_case ON official_sg_anon_tokens (case_id);

-- ── Whistleblower protection records ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS official_sg_whistleblower (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES official_sg_cases(id),
  requested_by    uuid REFERENCES users(id),  -- NULL = anonymous token request
  anon_token_hash text,                        -- token hash when anonymous
  basis           text,
  status          official_sg_wb_status NOT NULL DEFAULT 'requested',
  confirmed_by    uuid REFERENCES users(id),
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osgwb_case ON official_sg_whistleblower (case_id);

-- ── Additive column on fixture_officials ─────────────────────────────────────

ALTER TABLE fixture_officials
  ADD COLUMN IF NOT EXISTS sg_flag_raised boolean NOT NULL DEFAULT false;
