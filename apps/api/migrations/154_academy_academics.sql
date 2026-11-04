-- Academy OS P0 / Gap 03 (#783): Academics & school integration. Additive only: new tables, one widened CHECK (youth consent purpose). Nothing is dropped,
-- rewritten, narrowed or cascaded. Rollback = stop using the capabilities (or `DROP TABLE` the nine new tables in a scratch environment); no existing table
-- depends on them, and an academy that never links a school simply has none of these rows.
--
-- What is NOT stored here: institutions (a school is an `organisations` row of kind school / college / university, referenced by id), athletes (`users`),
-- sessions (`academy_sessions`), enrolments (`org_enrolments`), guardians/consent (`guardian_links`, `youth_consents`), sport attendance (`academy_attendance`).

-- A young person's guardian can allow the academy to handle school information (its own purpose, never implied by participation or coaching consent).
ALTER TABLE youth_consents DROP CONSTRAINT IF EXISTS youth_consents_purpose_check;
ALTER TABLE youth_consents ADD CONSTRAINT youth_consents_purpose_check
  CHECK (purpose IN ('participation','medical','media','contact','coaching','recruitment','recruitment_sharing','calendar_sharing','academic'));

-- Per-academy rules (all configurable; defaults are a starting point, not a claim about any jurisdiction's attendance law).
CREATE TABLE IF NOT EXISTS academy_academic_settings (
  organisation_id        uuid PRIMARY KEY REFERENCES organisations,
  attendance_threshold_pct int NOT NULL DEFAULT 90 CHECK (attendance_threshold_pct BETWEEN 50 AND 100),
  unauthorised_limit     int NOT NULL DEFAULT 3 CHECK (unauthorised_limit BETWEEN 0 AND 60),
  exam_buffer_min        int NOT NULL DEFAULT 60 CHECK (exam_buffer_min BETWEEN 0 AND 720),   -- no sport session this long before / after an exam
  snapshot_cadence_days  int NOT NULL DEFAULT 120 CHECK (snapshot_cadence_days BETWEEN 7 AND 400),
  updated_by             uuid REFERENCES users,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Configurable grading frameworks (letter grades, percentages, points, bands). Immutable: an edit is a new version, and a snapshot embeds the version it used.
CREATE TABLE IF NOT EXISTS academy_academic_frameworks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  key             text NOT NULL CHECK (key ~ '^[a-z0-9_]{2,40}$'),
  version         int NOT NULL DEFAULT 1,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind            text NOT NULL CHECK (kind IN ('letter','percent','points','band')),
  scale           jsonb NOT NULL,                                -- letter/band: { grades: ['A*','A',...] best first }; percent/points: { min, max }
  pass_mark       text CHECK (pass_mark IS NULL OR length(pass_mark) <= 12),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, key, version)
);

-- An athlete's link to a verified external school, per academy enrolment. The school is the canonical organisation; nothing about it is copied.
CREATE TABLE IF NOT EXISTS academy_school_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  enrolment_id    uuid NOT NULL REFERENCES org_enrolments,
  athlete_id      uuid NOT NULL REFERENCES users,
  school_org_id   uuid NOT NULL REFERENCES organisations,
  provision       text NOT NULL DEFAULT 'partner_school' CHECK (provision IN ('partner_school','on_site','online','tutoring_provider')),
  year_group      text CHECK (year_group IS NULL OR length(year_group) <= 30),
  student_ref_enc text,                                         -- the school's own student reference (personal data: encrypted)
  liaison_user_id uuid REFERENCES users,                        -- a member of the school organisation who coordinates with the academy
  import_authorised boolean NOT NULL DEFAULT false,             -- the academy allows the school (an active member of it) to submit records through the partner API
  starts_on       date NOT NULL DEFAULT current_date,
  ends_on         date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  end_reason      text CHECK (end_reason IS NULL OR length(end_reason) <= 200),
  created_by      uuid NOT NULL REFERENCES users,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_school_links_live ON academy_school_links (enrolment_id, school_org_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS academy_school_links_org ON academy_school_links (organisation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS academy_school_links_athlete ON academy_school_links (athlete_id);
CREATE INDEX IF NOT EXISTS academy_school_links_school ON academy_school_links (school_org_id, status);

-- What the athlete / verified guardian lets the academy see. Two independent levels; revoking keeps the row and hides the data at once.
--   schedule: school timetable, exam times, school attendance summary and the clashes derived from them
--   progress: attainment snapshots (grades) for the academy's educational roles
CREATE TABLE IF NOT EXISTS academy_academic_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  level           text NOT NULL CHECK (level IN ('schedule','progress')),
  granted_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_academic_shares_live ON academy_academic_shares (organisation_id, athlete_id, level) WHERE revoked_at IS NULL;

-- The school day, lessons, exams, tutoring and study blocks. `once` blocks have absolute times; `weekly` blocks repeat on a weekday between valid_from and
-- valid_to in the block's own time zone, skipping skip_dates (holidays, half-terms). The subject / label is personal text: encrypted, shown to educational roles only.
CREATE TABLE IF NOT EXISTS academy_school_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  link_id         uuid NOT NULL REFERENCES academy_school_links,
  athlete_id      uuid NOT NULL REFERENCES users,
  kind            text NOT NULL CHECK (kind IN ('school_day','lesson','exam','tutoring','study_hall','school_event')),
  label_enc       text,
  recurrence      text NOT NULL CHECK (recurrence IN ('once','weekly')),
  starts_at       timestamptz, ends_at timestamptz,
  weekday         int CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  start_time      time, end_time time,
  valid_from      date, valid_to date,
  skip_dates      date[] NOT NULL DEFAULT '{}',
  timezone        text NOT NULL DEFAULT 'UTC',
  source          text NOT NULL CHECK (source IN ('school_confirmed','manual_verified','partner_import')),
  source_ref      text CHECK (source_ref IS NULL OR length(source_ref) <= 120),
  recorded_by     uuid NOT NULL REFERENCES users,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason   text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 200),
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((recurrence = 'once' AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at)
      OR (recurrence = 'weekly' AND weekday IS NOT NULL AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time AND valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_to >= valid_from))
);
CREATE INDEX IF NOT EXISTS academy_school_blocks_athlete ON academy_school_blocks (athlete_id, status, starts_at);
CREATE INDEX IF NOT EXISTS academy_school_blocks_link ON academy_school_blocks (link_id, status);

-- A decision about one athlete's clash with one session: the athlete is excused from the sport session (school comes first). Append-only record of who and why.
CREATE TABLE IF NOT EXISTS academy_clash_resolutions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  session_id      uuid NOT NULL REFERENCES academy_sessions,
  athlete_id      uuid NOT NULL REFERENCES users,
  block_id        uuid NOT NULL REFERENCES academy_school_blocks,
  resolution      text NOT NULL DEFAULT 'excused' CHECK (resolution IN ('excused')),
  note            text CHECK (note IS NULL OR length(note) <= 200),
  resolved_by     uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, athlete_id, block_id)
);

-- School attendance summaries per period. Append-only: a correction is a new row; the latest row for a link and period is the current figure.
CREATE TABLE IF NOT EXISTS academy_school_attendance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid NOT NULL REFERENCES organisations,
  link_id           uuid NOT NULL REFERENCES academy_school_links,
  athlete_id        uuid NOT NULL REFERENCES users,
  period_from       date NOT NULL, period_to date NOT NULL,
  sessions_possible int NOT NULL CHECK (sessions_possible BETWEEN 1 AND 500),
  present           int NOT NULL CHECK (present >= 0),
  authorised_absence int NOT NULL DEFAULT 0 CHECK (authorised_absence >= 0),
  unauthorised_absence int NOT NULL DEFAULT 0 CHECK (unauthorised_absence >= 0),
  late              int NOT NULL DEFAULT 0 CHECK (late >= 0),
  source            text NOT NULL CHECK (source IN ('school_confirmed','manual_verified','partner_import')),
  source_ref        text CHECK (source_ref IS NULL OR length(source_ref) <= 120),
  recorded_by       uuid NOT NULL REFERENCES users,
  supersedes        uuid REFERENCES academy_school_attendance,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  CHECK (present + authorised_absence + unauthorised_absence <= sessions_possible)
);
CREATE INDEX IF NOT EXISTS academy_school_attendance_link ON academy_school_attendance (link_id, period_from DESC, created_at DESC);

-- Attainment / progress snapshots. Append-only and versioned per link and term; grades and comments are encrypted and every read is audit-logged.
-- standing is the educator's own overall judgement (not computed); visibility says whether the athlete / guardian also see this version.
CREATE TABLE IF NOT EXISTS academy_academic_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations,
  link_id            uuid NOT NULL REFERENCES academy_school_links,
  athlete_id         uuid NOT NULL REFERENCES users,
  term_label         text NOT NULL CHECK (length(term_label) BETWEEN 2 AND 40),
  period_from        date NOT NULL, period_to date NOT NULL,
  framework_id       uuid NOT NULL REFERENCES academy_academic_frameworks,
  framework_snapshot jsonb NOT NULL,
  entries_enc        text NOT NULL,
  comment_enc        text,
  standing           text NOT NULL CHECK (standing IN ('on_track','watch','concern')),
  visibility         text NOT NULL DEFAULT 'athlete_guardian' CHECK (visibility IN ('education_staff','athlete_guardian')),
  source             text NOT NULL CHECK (source IN ('school_report','partner_import','manual_verified')),
  source_ref         text CHECK (source_ref IS NULL OR length(source_ref) <= 120),
  source_date        date NOT NULL,
  version            int NOT NULL,
  supersedes         uuid REFERENCES academy_academic_snapshots,
  recorded_by        uuid NOT NULL REFERENCES users,
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  UNIQUE (link_id, term_label, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_academic_snapshots_idem ON academy_academic_snapshots (recorded_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS academy_academic_snapshots_athlete ON academy_academic_snapshots (organisation_id, athlete_id, created_at DESC);

-- Coordination tasks between coaches, the school, the guardian and the education team. They hold no grades: the title is a fixed kind, the note is encrypted
-- personal free text visible to the assignee and the education team.
CREATE TABLE IF NOT EXISTS academy_academic_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  link_id         uuid REFERENCES academy_school_links,
  kind            text NOT NULL CHECK (kind IN ('attendance_exception','exam_clash','coach_school_liaison','guardian_meeting','report_due','tutoring_support','other')),
  audience        text NOT NULL CHECK (audience IN ('coach','school','guardian','education')),
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  note_enc        text,
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_on          date,
  assignee_id     uuid REFERENCES users,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  source_type     text, source_id text,                         -- system-raised tasks point at the fact that caused them (deduplication)
  created_by      uuid REFERENCES users,
  completed_by    uuid REFERENCES users, completed_at timestamptz,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_academic_tasks_org ON academy_academic_tasks (organisation_id, status, due_on);
CREATE INDEX IF NOT EXISTS academy_academic_tasks_assignee ON academy_academic_tasks (assignee_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS academy_academic_tasks_source ON academy_academic_tasks (organisation_id, source_type, source_id) WHERE source_type IS NOT NULL AND status IN ('open','in_progress');

-- Replay protection for bulk imports (manual verified entry and the school's partner API).
CREATE TABLE IF NOT EXISTS academy_academic_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  submitted_by    uuid NOT NULL REFERENCES users,
  idempotency_key text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('manual','partner')),
  result          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, submitted_by, idempotency_key)
);

CREATE OR REPLACE FUNCTION academy_academics_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS academy_academic_snapshots_immutable ON academy_academic_snapshots;
CREATE TRIGGER academy_academic_snapshots_immutable BEFORE UPDATE OR DELETE ON academy_academic_snapshots FOR EACH ROW EXECUTE FUNCTION academy_academics_append_only();
DROP TRIGGER IF EXISTS academy_school_attendance_immutable ON academy_school_attendance;
CREATE TRIGGER academy_school_attendance_immutable BEFORE UPDATE OR DELETE ON academy_school_attendance FOR EACH ROW EXECUTE FUNCTION academy_academics_append_only();
DROP TRIGGER IF EXISTS academy_academic_frameworks_immutable ON academy_academic_frameworks;
CREATE TRIGGER academy_academic_frameworks_immutable BEFORE UPDATE OR DELETE ON academy_academic_frameworks FOR EACH ROW EXECUTE FUNCTION academy_academics_append_only();
DROP TRIGGER IF EXISTS academy_clash_resolutions_immutable ON academy_clash_resolutions;
CREATE TRIGGER academy_clash_resolutions_immutable BEFORE UPDATE OR DELETE ON academy_clash_resolutions FOR EACH ROW EXECUTE FUNCTION academy_academics_append_only();
