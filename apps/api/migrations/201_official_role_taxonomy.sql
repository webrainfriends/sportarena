-- REF-R30: Expanded sport official role taxonomy and rule-driven crew templates (#1028).
-- Additive only — no drops, no data loss. All new tables, plus additive ALTER TABLE
-- statements to extend the role CHECK constraints on fixture_officials and event_crew_requirements.

-- ── (a) Extend role enum on fixture_officials ──────────────────────────────
ALTER TABLE fixture_officials DROP CONSTRAINT IF EXISTS fixture_officials_role_check;
ALTER TABLE fixture_officials ADD CONSTRAINT fixture_officials_role_check
  CHECK (role IN (
    'referee','umpire','linesman','scorer',
    'video_assistant_referee','fourth_official','reserve_assistant_referee',
    'shot_clock_operator','timekeeper','goal_line_official','technical_official',
    'chair_umpire','match_commissioner','technical_delegate','starter','marshal'
  ));

-- ── (b) Extend role enum on event_crew_requirements ───────────────────────
ALTER TABLE event_crew_requirements DROP CONSTRAINT IF EXISTS event_crew_requirements_role_check;
ALTER TABLE event_crew_requirements ADD CONSTRAINT event_crew_requirements_role_check
  CHECK (role IN (
    'referee','umpire','linesman','scorer',
    'video_assistant_referee','fourth_official','reserve_assistant_referee',
    'shot_clock_operator','timekeeper','goal_line_official','technical_official',
    'chair_umpire','match_commissioner','technical_delegate','starter','marshal'
  ));

-- ── (c) Sport official role definitions ───────────────────────────────────
-- One row per role per sport per governing body. sport_id may be NULL for cross-sport roles.
-- display_name_translations carries translated names keyed by IETF tag e.g. {"ta":"நடுவர்"}.
-- requires_credentials is [{kind, label, required}].
-- duties and permissions are plain text arrays serialised as jsonb.
CREATE TABLE IF NOT EXISTS sport_official_role_definitions (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id                    uuid        REFERENCES sports(id),
  sport_code                  text        NOT NULL,
  role_key                    text        NOT NULL,
  display_name                text        NOT NULL,
  display_name_translations   jsonb       NOT NULL DEFAULT '{}',
  family                      text        NOT NULL CHECK (family IN (
                                'match_official','video_official','technical_official',
                                'administrative_official','safety_official','support_official'
                              )),
  min_count                   integer     NOT NULL DEFAULT 1 CHECK (min_count BETWEEN 0 AND 20),
  max_count                   integer     NOT NULL DEFAULT 1 CHECK (max_count BETWEEN 1 AND 20),
  mandatory                   boolean     NOT NULL DEFAULT true,
  requires_credentials        jsonb       NOT NULL DEFAULT '[]',
  min_grade                   text,
  min_grade_rank              integer,
  duties                      jsonb       NOT NULL DEFAULT '[]',
  permissions                 jsonb       NOT NULL DEFAULT '[]',
  governing_body              text,
  source                      text,
  source_version              text,
  rule_pack_id                uuid        REFERENCES rule_packs(id),
  effective_from              date,
  effective_to                date,
  status                      text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','archived')),
  created_by                  uuid        REFERENCES users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  archived_at                 timestamptz,
  CHECK (max_count >= min_count),
  UNIQUE (sport_code, role_key, governing_body)
);
CREATE INDEX IF NOT EXISTS sport_official_role_sport  ON sport_official_role_definitions(sport_code, status);
CREATE INDEX IF NOT EXISTS sport_official_role_family ON sport_official_role_definitions(family, status);

-- ── (d) Crew templates ────────────────────────────────────────────────────
-- Versioned bundle per sport/format/level. Once published, the content is frozen via
-- content_hash (SHA-256 of the serialised slots). Archived only — never hard-deleted.
CREATE TABLE IF NOT EXISTS crew_templates (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id         uuid        REFERENCES sports(id),
  sport_code       text        NOT NULL,
  match_format     text        NOT NULL DEFAULT 'standard',
  level            text        NOT NULL DEFAULT 'club'
                     CHECK (level IN ('club','domestic','national','international','youth','para')),
  governing_body   text        NOT NULL,
  name             text        NOT NULL,
  description      text,
  rule_pack_id     uuid        REFERENCES rule_packs(id),
  rule_pack_version text,
  status           text        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','published','archived')),
  published_at     timestamptz,
  published_by     uuid        REFERENCES users(id),
  content_hash     text,
  source           text,
  source_ref       text,
  created_by       uuid        REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);
CREATE INDEX IF NOT EXISTS crew_template_sport  ON crew_templates(sport_code, status);
CREATE INDEX IF NOT EXISTS crew_template_level  ON crew_templates(level, status);

-- ── (e) Crew template slots ───────────────────────────────────────────────
-- Each slot is one role with its count, mandatory flag, qualification requirements, duties and
-- permissions. Slots are owned by a template and cannot be deleted once the template is published.
CREATE TABLE IF NOT EXISTS crew_template_slots (
  id                   uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id          uuid     NOT NULL REFERENCES crew_templates(id) ON DELETE RESTRICT,
  role_key             text     NOT NULL,
  display_name         text     NOT NULL,
  family               text     NOT NULL,
  min_count            integer  NOT NULL DEFAULT 1 CHECK (min_count BETWEEN 0 AND 20),
  max_count            integer  NOT NULL DEFAULT 1 CHECK (max_count BETWEEN 1 AND 20),
  mandatory            boolean  NOT NULL DEFAULT true,
  min_grade            text,
  min_grade_rank       integer,
  requires_credentials jsonb    NOT NULL DEFAULT '[]',
  duties               jsonb    NOT NULL DEFAULT '[]',
  permissions          jsonb    NOT NULL DEFAULT '[]',
  position_order       integer  NOT NULL DEFAULT 0,
  CHECK (max_count >= min_count)
);
CREATE INDEX IF NOT EXISTS crew_template_slot_template ON crew_template_slots(template_id, position_order);

-- ── (f) Crew template application audit ──────────────────────────────────
-- Append-only record of every time an organiser applied a template to an event.
CREATE TABLE IF NOT EXISTS event_crew_template_applications (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid        NOT NULL REFERENCES events(id),
  template_id   uuid        NOT NULL REFERENCES crew_templates(id),
  applied_by    uuid        NOT NULL REFERENCES users(id),
  applied_at    timestamptz NOT NULL DEFAULT now(),
  override_note text
);
CREATE INDEX IF NOT EXISTS crew_tpl_app_event ON event_crew_template_applications(event_id, applied_at DESC);
