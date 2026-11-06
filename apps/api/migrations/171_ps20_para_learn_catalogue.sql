-- PS-20: Para-sport Learn & Study content catalogue (#850)
-- Additive only — no DROP, TRUNCATE or ON DELETE CASCADE on user data.

-- ── A. Learning paths: one per sport × level × publisher ──────────────────────
CREATE TABLE IF NOT EXISTS para_learn_paths (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id         uuid NOT NULL REFERENCES sports(id),
  slug             text NOT NULL,
  level_key        text NOT NULL CHECK (level_key IN ('beginner','intermediate','advanced')),
  title            text NOT NULL,
  summary          text,
  publisher_org_id uuid REFERENCES organisations(id),  -- NULL = platform-published
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  row_version      int  NOT NULL DEFAULT 1,
  UNIQUE (sport_id, level_key, publisher_org_id)
);

CREATE INDEX IF NOT EXISTS idx_plp_sport ON para_learn_paths(sport_id);
CREATE INDEX IF NOT EXISTS idx_plp_slug  ON para_learn_paths(slug);

-- ── B. Path versions with editorial approval ───────────────────────────────────
CREATE TABLE IF NOT EXISTS para_learn_path_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path_id             uuid NOT NULL REFERENCES para_learn_paths(id),
  version             int  NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','approved','published','retired')),
  objectives          jsonb NOT NULL DEFAULT '[]',       -- [{text}]
  estimated_minutes   int,
  source_attribution  jsonb NOT NULL DEFAULT '{}',       -- {title, owner, licence, source_url}
  copyright_note      text,
  created_by          uuid NOT NULL REFERENCES users(id),
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path_id, version)
);

-- Only one draft per path at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_plpv_draft
  ON para_learn_path_versions(path_id) WHERE status = 'draft';

-- Immutability: published/retired versions cannot be changed
CREATE OR REPLACE FUNCTION para_learn_path_versions_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'para_learn_path_versions: published/retired versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS para_learn_path_versions_guard_trg ON para_learn_path_versions;
CREATE TRIGGER para_learn_path_versions_guard_trg
  BEFORE UPDATE ON para_learn_path_versions
  FOR EACH ROW EXECUTE FUNCTION para_learn_path_versions_guard();

-- ── C. Modules: accessible content blocks within a version ────────────────────
CREATE TABLE IF NOT EXISTS para_learn_modules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id          uuid NOT NULL REFERENCES para_learn_path_versions(id),
  position            int  NOT NULL DEFAULT 0,
  title               text NOT NULL,
  body_blocks         jsonb NOT NULL DEFAULT '[]',  -- [{type: heading|text|checklist|tip, text}]
  source_attribution  jsonb,                         -- overrides path-level when set
  caption_url         text,
  transcript_url      text,
  alt_text            text,
  audio_description   text,
  external_url        text,
  estimated_minutes   int,
  required            boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plm_version ON para_learn_modules(version_id, position);

-- ── D. Assessments: levelled check questions within a module ──────────────────
CREATE TABLE IF NOT EXISTS para_learn_assessments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id           uuid NOT NULL REFERENCES para_learn_modules(id),
  question            text NOT NULL,
  options             jsonb NOT NULL DEFAULT '[]',  -- [{label, is_correct}]
  plain_language_hint text,
  max_retakes         int  NOT NULL DEFAULT 3,       -- 0 = unlimited
  position            int  NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pla_module ON para_learn_assessments(module_id, position);

-- ── E. Athlete progress (append-only) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS para_learn_progress (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES users(id),
  path_id         uuid NOT NULL REFERENCES para_learn_paths(id),
  version_id      uuid NOT NULL REFERENCES para_learn_path_versions(id),
  module_id       uuid NOT NULL REFERENCES para_learn_modules(id),
  completed_at    timestamptz NOT NULL DEFAULT now(),
  assessment_id   uuid REFERENCES para_learn_assessments(id),
  answer_index    int,
  passed          boolean,
  attempt_number  int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plpr_athlete ON para_learn_progress(athlete_id, path_id);
CREATE INDEX IF NOT EXISTS idx_plpr_module  ON para_learn_progress(module_id);

-- ── F. Credential link: ties issued badge to completed path ──────────────────
CREATE TABLE IF NOT EXISTS para_learn_credential_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL REFERENCES users(id),
  path_id       uuid NOT NULL REFERENCES para_learn_paths(id),
  version_id    uuid NOT NULL REFERENCES para_learn_path_versions(id),
  credential_id uuid NOT NULL REFERENCES credentials(id),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (athlete_id, path_id)
);

-- ── G. Institution publisher gate ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS para_learn_publisher_orgs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  sport_id        uuid REFERENCES sports(id),   -- NULL = all para sports
  approved_by     uuid NOT NULL REFERENCES users(id),
  approved_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  UNIQUE (organisation_id, sport_id)
);
