-- Academy OS P0 / Gap 03: Academics & school integration (#783). Additive only: nothing is altered, dropped or cascaded, and an academy that never
-- links a school has no rows here and behaves exactly as before.
--
-- A school is an ordinary organisation (kind school / college / university, already reviewed by the platform): academic_links POINTS an academy
-- enrolment at it and never copies the institution. Academic data is private by design:
--   * nothing flows until the athlete (or, for a minor, a verified guardian with consent authority) has granted it, per party, per scope, dated;
--   * grades and subject text are encrypted at rest and only ever read through the capabilities, which audit every read;
--   * there is no scout, recruiter or sponsor audience anywhere in this schema (the CHECKs below allow only the academy and the school).

CREATE TABLE IF NOT EXISTS academic_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,          -- the academy
  enrolment_id    uuid NOT NULL REFERENCES org_enrolments,
  athlete_id      uuid NOT NULL REFERENCES users,
  school_org_id   uuid NOT NULL REFERENCES organisations,          -- the canonical institution
  provider_kind   text NOT NULL DEFAULT 'school' CHECK (provider_kind IN ('school','college','tutoring','online_school')),
  curriculum      text CHECK (curriculum IS NULL OR curriculum IN ('cbse','icse','state_board','ib','igcse','a_level','us_high_school','spanish_eso','other')),
  year_group      text CHECK (year_group IS NULL OR length(year_group) <= 30),
  student_ref_enc text,                                            -- the school's own student number, encrypted
  liaison_user_id uuid REFERENCES users,                           -- the school's contact for this athlete (a member of the school organisation)
  starts_on       date NOT NULL DEFAULT CURRENT_DATE,
  ends_on         date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ended_by        uuid REFERENCES users,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS academic_links_live ON academic_links (enrolment_id, school_org_id, provider_kind) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS academic_links_org ON academic_links (organisation_id, status);
CREATE INDEX IF NOT EXISTS academic_links_school ON academic_links (school_org_id, status);
CREATE INDEX IF NOT EXISTS academic_links_athlete ON academic_links (athlete_id) WHERE status = 'active';

-- Who may see what, granted by the athlete (or a verified guardian), dated, never open-ended, revocable at any moment.
CREATE TABLE IF NOT EXISTS academic_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES users,
  party_org_id    uuid NOT NULL REFERENCES organisations,          -- the academy or the school the grant is for
  party_role      text NOT NULL CHECK (party_role IN ('academy','school')),
  scopes          text[] NOT NULL CHECK (scopes <@ ARRAY['timetable','attendance','attainment']::text[] AND cardinality(scopes) >= 1),
  detail          text NOT NULL DEFAULT 'summary' CHECK (detail IN ('summary','detail')),   -- summary: blocks / bands only; detail: subject-level (attainment)
  granted_by      uuid NOT NULL REFERENCES users,
  granted_as      text NOT NULL CHECK (granted_as IN ('athlete','guardian')),
  expires_on      date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS academic_consents_live ON academic_consents (athlete_id, party_org_id) WHERE revoked_at IS NULL;

-- The academic timetable: school-day blocks, exams, tutoring, school events. One-off (starts_at/ends_at) or weekly (weekdays + times + dates).
-- The subject / paper text is encrypted; staff without academic access see only the kind and the time.
CREATE TABLE IF NOT EXISTS academic_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id         uuid NOT NULL REFERENCES academic_links,
  kind            text NOT NULL CHECK (kind IN ('class_block','exam','tutoring','school_event','holiday','deadline')),
  title_enc       text,
  starts_at       timestamptz,
  ends_at         timestamptz,
  weekdays        int[],
  start_time      time,
  end_time        time,
  from_on         date,
  to_on           date,
  timezone        text NOT NULL DEFAULT 'UTC',
  high_stakes     boolean NOT NULL DEFAULT false,                  -- a board / final exam: never overridden by a sport session
  blocks_sport    boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  source          text NOT NULL DEFAULT 'manual_verified' CHECK (source IN ('manual_verified','partner_import','partner_api','athlete_entered')),
  source_org_id   uuid REFERENCES organisations,
  source_ref      text CHECK (source_ref IS NULL OR length(source_ref) <= 120),
  verified_by     uuid REFERENCES users,
  verified_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1,
  CHECK ((starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at AND weekdays IS NULL)
      OR (starts_at IS NULL AND weekdays IS NOT NULL AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time AND from_on IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS academic_items_link ON academic_items (link_id, status);
CREATE INDEX IF NOT EXISTS academic_items_when ON academic_items (starts_at) WHERE starts_at IS NOT NULL AND status = 'active';

-- Attendance at school as period SUMMARIES only (data minimisation: no day-by-day record is kept). A correction is a new version.
CREATE TABLE IF NOT EXISTS academic_attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id         uuid NOT NULL REFERENCES academic_links,
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  sessions_total  int NOT NULL CHECK (sessions_total >= 0),
  present         int NOT NULL CHECK (present >= 0),
  late            int NOT NULL DEFAULT 0 CHECK (late >= 0),
  authorised_absent   int NOT NULL DEFAULT 0 CHECK (authorised_absent >= 0),
  unauthorised_absent int NOT NULL DEFAULT 0 CHECK (unauthorised_absent >= 0),
  version         int NOT NULL DEFAULT 1,
  supersedes_id   uuid REFERENCES academic_attendance,
  source          text NOT NULL CHECK (source IN ('manual_verified','partner_import','partner_api','athlete_entered')),
  source_org_id   uuid REFERENCES organisations,
  source_ref      text CHECK (source_ref IS NULL OR length(source_ref) <= 120),
  verified_by     uuid REFERENCES users,
  verified_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  CHECK (present + authorised_absent + unauthorised_absent <= sessions_total)
);
CREATE INDEX IF NOT EXISTS academic_attendance_link ON academic_attendance (link_id, period_to DESC);

-- A framework is the academy's configurable way of reading progress (scale, subjects, thresholds); it does not hold any athlete's data.
CREATE TABLE IF NOT EXISTS academic_frameworks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  scale           text NOT NULL CHECK (scale IN ('percent','letter_a_e','numeric_1_9','numeric_1_7','gpa_4','cbse_grade','custom')),
  bands           jsonb NOT NULL DEFAULT '[]',                     -- custom scale labels, best first
  subjects        text[] NOT NULL DEFAULT '{}',
  watch_below     int,                                             -- thresholds on the scale's 0-100 normalised value used to suggest a progress band
  support_below   int,
  attendance_floor_pct int NOT NULL DEFAULT 90 CHECK (attendance_floor_pct BETWEEN 50 AND 100),
  version         int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academic_frameworks_name ON academic_frameworks (organisation_id, lower(name)) WHERE archived_at IS NULL;

-- Attainment snapshots: immutable versions with provenance. The subject-level values are encrypted; progress_band is the only signal that
-- ordinary staff may see, and only with a summary grant.
CREATE TABLE IF NOT EXISTS academic_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id         uuid NOT NULL REFERENCES academic_links,
  framework_id    uuid NOT NULL REFERENCES academic_frameworks,
  term_label      text NOT NULL CHECK (length(term_label) BETWEEN 2 AND 40),
  period_from     date,
  period_to       date,
  values_enc      text NOT NULL,
  progress_band   text NOT NULL CHECK (progress_band IN ('on_track','watch','support_needed')),
  version         int NOT NULL DEFAULT 1,
  supersedes_id   uuid REFERENCES academic_snapshots,
  source_kind     text NOT NULL CHECK (source_kind IN ('school_report','partner_import','partner_api','manual_verified','self_reported')),
  source_org_id   uuid REFERENCES organisations,
  source_ref      text CHECK (source_ref IS NULL OR length(source_ref) <= 120),
  reported_on     date,
  verified_by     uuid REFERENCES users,
  verified_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academic_snapshots_link ON academic_snapshots (link_id, term_label, version DESC);

-- Coordination between coach, school and guardian. Structured on purpose: reason codes and dates, never grades.
CREATE TABLE IF NOT EXISTS academic_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  link_id         uuid NOT NULL REFERENCES academic_links,
  kind            text NOT NULL CHECK (kind IN ('exam_clash','attendance_exception','coach_school_sync','guardian_meeting','tutoring','report_due','other')),
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  reason_code     text CHECK (reason_code IS NULL OR reason_code IN ('clash_with_exam','clash_with_class','low_attendance','unauthorised_absence','late_pattern','report_overdue','needs_support','other')),
  due_on          date,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  note_enc        text,
  source_type     text,
  source_id       uuid,
  dedupe_key      text,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  closed_by       uuid REFERENCES users,
  row_version     int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS academic_tasks_dedupe ON academic_tasks (organisation_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS academic_tasks_org ON academic_tasks (organisation_id, status, due_on);
CREATE TABLE IF NOT EXISTS academic_task_people (
  task_id uuid NOT NULL REFERENCES academic_tasks,
  user_id uuid NOT NULL REFERENCES users,
  role    text NOT NULL CHECK (role IN ('academic_lead','coach','school_liaison','guardian','athlete')),
  PRIMARY KEY (task_id, user_id, role)
);
CREATE TABLE IF NOT EXISTS academic_task_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES academic_tasks,
  author_id  uuid NOT NULL REFERENCES users,
  body_enc   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Staged partner / file imports: validated and previewed first, applied only when the school's own staff (or the academic lead for manual
-- verified entry) commit them. Rows keep only the columns the importer allows.
CREATE TABLE IF NOT EXISTS academic_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,          -- whose import this is (the academy, or the school)
  kind            text NOT NULL CHECK (kind IN ('timetable','attendance','snapshot')),
  source_org_id   uuid REFERENCES organisations,
  channel         text NOT NULL CHECK (channel IN ('file','api')),
  status          text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','applied','rejected')),
  rows_enc        text,                                            -- the staged rows, encrypted (they may hold grades); cleared when applied or rejected
  summary         jsonb NOT NULL DEFAULT '{}',
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS academic_imports_idem ON academic_imports (organisation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Every read of academic content is recorded; the athlete and their guardian can see who looked, when and for what.
CREATE TABLE IF NOT EXISTS academic_access_log (
  id              bigserial PRIMARY KEY,
  athlete_id      uuid NOT NULL REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  actor_id        uuid NOT NULL REFERENCES users,
  actor_side      text NOT NULL CHECK (actor_side IN ('academy','school','athlete','guardian')),
  scope           text NOT NULL,
  detail          text NOT NULL DEFAULT 'summary',
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academic_access_log_athlete ON academic_access_log (athlete_id, at DESC);

-- Permissions on an academy engagement are text[] validated in the capability (no CHECK to widen), so 'academics' and 'academics_detail' need no schema change.
