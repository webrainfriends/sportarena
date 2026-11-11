-- Para-sport Officials Workflow & Accessibility (#1027, R29). Additive only: five new tables, no changes to existing schema.
-- Officials see competition-facing class codes from para_outcomes ONLY — never para_cases, para_evidence or the medical classifier workflow.
-- Sensitive fields (cert references, assistive-device detail) use field-level encryption via src/crypto.js.

-- 1. official_para_requirements: federation- or platform-defined training requirements per sport and officiating level.
--    An archived requirement is never deleted; it is soft-removed so historical completions remain valid.
CREATE TABLE IF NOT EXISTS official_para_requirements (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id     uuid        NOT NULL REFERENCES sports,
  body_id      uuid        REFERENCES governing_bodies,  -- NULL = platform-wide default
  level        text        NOT NULL DEFAULT 'entry' CHECK (level IN ('entry','intermediate','elite','international')),
  kind         text        NOT NULL CHECK (kind IN ('course','certification','experience','assessment','background_check')),
  title        text        NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  description  text        CHECK (description IS NULL OR length(description) <= 2000),
  provider     text        CHECK (provider IS NULL OR length(provider) <= 200),
  source_ref   text        CHECK (source_ref IS NULL OR length(source_ref) <= 500),
  valid_months int         CHECK (valid_months IS NULL OR valid_months BETWEEN 1 AND 240),
  mandatory    boolean     NOT NULL DEFAULT true,
  archived_at  timestamptz,
  created_by   uuid        NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS off_para_req_sport  ON official_para_requirements (sport_id, level) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS off_para_req_body   ON official_para_requirements (body_id)         WHERE archived_at IS NULL;

-- 2. official_para_completions: official's evidence of completing a requirement.
--    cert_ref_enc stores the encrypted certificate reference — never plaintext.
--    One live completion row per (requirement, official): a re-upload replaces the existing row (soft-delete old, insert new).
CREATE TABLE IF NOT EXISTS official_para_completions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid        NOT NULL REFERENCES official_para_requirements,
  official_id    uuid        NOT NULL REFERENCES users,
  completed_on   date        NOT NULL,
  expires_on     date,
  cert_ref_enc   text,                                      -- AES-256-GCM via crypto.js
  verified_by    uuid        REFERENCES users,
  verified_at    timestamptz,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','verified','rejected','expired')),
  rejection_note text        CHECK (rejection_note IS NULL OR length(rejection_note) <= 1000),
  notes          text        CHECK (notes IS NULL OR length(notes) <= 1000),
  superseded_by  uuid        REFERENCES official_para_completions, -- soft-replace chain
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR expires_on >= completed_on)
);
CREATE INDEX IF NOT EXISTS off_para_comp_official ON official_para_completions (official_id, status);
CREATE INDEX IF NOT EXISTS off_para_comp_req      ON official_para_completions (requirement_id, official_id);

-- 3. official_assistive_needs: official's declared assistive device or communication needs for match-day.
--    One row per official, upserted on save. needs jsonb array: [{kind, detail_enc, severity, notes}].
--    detail_enc is encrypted; kind is never a diagnosis.
CREATE TABLE IF NOT EXISTS official_assistive_needs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id  uuid        NOT NULL REFERENCES users UNIQUE,
  prefs        jsonb       NOT NULL DEFAULT '{}',  -- {large_targets, high_contrast, screen_reader, hearing_loop, haptic_alerts, written_comms}
  needs        jsonb       NOT NULL DEFAULT '[]',  -- [{kind, detail_enc, severity, notes}]
  updated_by   uuid        NOT NULL REFERENCES users,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 4. para_fixture_procedures: sport-adapted procedure overrides set by the organiser for a specific fixture.
--    The canonical procedure is derived from the sport slug; this table holds per-fixture amendments only.
CREATE TABLE IF NOT EXISTS para_fixture_procedures (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id   uuid        NOT NULL REFERENCES fixtures UNIQUE,
  sport_id     uuid        NOT NULL REFERENCES sports,
  overrides    jsonb       NOT NULL DEFAULT '{}',
  -- {time_extensions, substitution_limits, signal_protocols, communication_notes, equipment_notes, other}
  set_by       uuid        NOT NULL REFERENCES users,
  set_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_fix_proc_fixture ON para_fixture_procedures (fixture_id);

-- 5. para_official_incidents: classification protests and equipment non-conformance filed by officials.
--    These are operational reports forwarded to the governing body as Cases — NEVER classification evidence.
--    description must be operational (CLINICAL guard enforced in the capability layer).
CREATE TABLE IF NOT EXISTS para_official_incidents (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id   uuid        NOT NULL REFERENCES fixtures,
  filed_by     uuid        NOT NULL REFERENCES users,
  kind         text        NOT NULL
               CHECK (kind IN ('classification_protest','equipment_non_conformance','procedure_breach','guide_pairing','other')),
  description  text        NOT NULL CHECK (length(description) BETWEEN 10 AND 2000),
  athlete_id   uuid        REFERENCES users,   -- if applicable; never medical detail
  class_code   text        CHECK (class_code IS NULL OR length(class_code) <= 20),
  case_id      uuid        REFERENCES cases,   -- populated once a Cases record is created
  status       text        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','under_review','resolved','dismissed')),
  resolved_by  uuid        REFERENCES users,
  resolved_at  timestamptz,
  resolution   text        CHECK (resolution IS NULL OR length(resolution) <= 2000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_off_inc_fixture ON para_official_incidents (fixture_id, status);
CREATE INDEX IF NOT EXISTS para_off_inc_filed   ON para_official_incidents (filed_by, created_at DESC);
