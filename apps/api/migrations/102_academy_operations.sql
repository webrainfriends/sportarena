-- Academy OS 2/3 (#394): session scheduling, staff rostering, session attendance, time tracking and compensation as an operations
-- layer over organisations / cohorts / programmes / enrolments / venue bookings. Additive only: nothing is dropped, rewritten or cascaded.
-- Rollback = deploy the previous code; the new tables are inert without it.

-- a generic "staff" member: access comes only from the scoped permission set on their engagement, never from the role itself
DO $$ DECLARE n text; BEGIN
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid = 'organisation_members'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%role%' LOOP
    EXECUTE format('ALTER TABLE organisation_members DROP CONSTRAINT %I', n);
  END LOOP;
END $$;
ALTER TABLE organisation_members ADD CONSTRAINT organisation_members_role_check
  CHECK (role IN ('owner','admin','coach','finance','manager','evaluator','legal','approver','auditor','staff'));

-- organisation-scoped engagement details that cannot live on the global profile (no second person profile)
CREATE TABLE IF NOT EXISTS org_staff_engagements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  job_title       text NOT NULL CHECK (length(job_title) BETWEEN 2 AND 80),
  template        text NOT NULL DEFAULT 'custom',
  engagement_type text NOT NULL DEFAULT 'employee' CHECK (engagement_type IN ('employee','contractor','volunteer')),
  staff_ref       text CHECK (staff_ref IS NULL OR length(staff_ref) <= 40),
  state           text NOT NULL DEFAULT 'active' CHECK (state IN ('active','leave','suspended','ended')),
  starts_on       date,
  ends_on         date,
  manager_id      uuid REFERENCES users,
  permissions     text[] NOT NULL DEFAULT '{}',          -- schedule, attendance, timesheets, payroll, roster, safeguarding
  scope_sports    text[] NOT NULL DEFAULT '{}',          -- empty = every sport
  scope_cohort_ids uuid[] NOT NULL DEFAULT '{}',         -- empty = every cohort
  required_credentials text[] NOT NULL DEFAULT '{}',     -- e.g. coach_badge (read from the canonical verification badges)
  notes_enc       text,                                  -- HR notes, encrypted; only owner/admin
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

-- cohort-level operational rules (programme intent -> session defaults)
ALTER TABLE org_cohorts ADD COLUMN IF NOT EXISTS min_coaches int CHECK (min_coaches IS NULL OR min_coaches >= 0);
ALTER TABLE org_cohorts ADD COLUMN IF NOT EXISTS max_ratio int CHECK (max_ratio IS NULL OR max_ratio > 0);   -- athletes per coach
ALTER TABLE org_cohorts ADD COLUMN IF NOT EXISTS lead_credential_required boolean NOT NULL DEFAULT false;
ALTER TABLE org_cohorts ADD COLUMN IF NOT EXISTS enforce_staffing boolean NOT NULL DEFAULT false;               -- hard block only when explicitly configured

-- one scheduled occurrence of a cohort: who / when / where (never a training plan)
CREATE TABLE IF NOT EXISTS academy_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  cohort_id       uuid NOT NULL REFERENCES org_cohorts,
  programme_id    uuid REFERENCES academy_programmes,
  season_id       uuid REFERENCES org_seasons,
  sport           text,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  delivery_type   text NOT NULL DEFAULT 'training' CHECK (delivery_type IN ('training','assessment','trial','workshop','camp','classroom','match_prep','makeup','other')),
  timezone        text NOT NULL DEFAULT 'UTC',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  capacity        int CHECK (capacity IS NULL OR capacity > 0),
  min_coaches     int NOT NULL DEFAULT 1 CHECK (min_coaches >= 0),
  max_ratio       int CHECK (max_ratio IS NULL OR max_ratio > 0),
  lead_credential_required boolean NOT NULL DEFAULT false,
  enforce_staffing boolean NOT NULL DEFAULT false,
  duty_roles      text[] NOT NULL DEFAULT '{}',           -- operational cover required, e.g. first_aid, safeguarding
  self_checkin    boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled','completed')),
  cancel_reason   text,
  makeup_for      uuid REFERENCES academy_sessions,
  source_type     text, source_id text,                    -- optional team / event / fixture context
  generation_key  text,
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS academy_sessions_org_time ON academy_sessions (organisation_id, starts_at, id);
CREATE INDEX IF NOT EXISTS academy_sessions_cohort ON academy_sessions (cohort_id, starts_at);
-- one live session per cohort and start: regenerating a timetable can never duplicate it
CREATE UNIQUE INDEX IF NOT EXISTS academy_sessions_live ON academy_sessions (cohort_id, starts_at) WHERE status <> 'cancelled';

-- bulk generation runs, for idempotent replays
CREATE TABLE IF NOT EXISTS academy_generation_runs (
  organisation_id uuid NOT NULL REFERENCES organisations,
  idempotency_key text NOT NULL,
  cohort_id       uuid NOT NULL REFERENCES org_cohorts,
  result          jsonb NOT NULL,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, idempotency_key)
);

-- append-only change history (reschedules, cancellations, venue and status changes)
CREATE TABLE IF NOT EXISTS academy_session_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES academy_sessions,
  kind        text NOT NULL,
  actor_id    uuid REFERENCES users,
  reason      text,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS academy_session_changes_session ON academy_session_changes (session_id, created_at);

-- staff on a session. Coaches/staff are users + organisation members; nothing is copied.
CREATE TABLE IF NOT EXISTS academy_session_staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES academy_sessions,
  user_id     uuid NOT NULL REFERENCES users,
  role        text NOT NULL DEFAULT 'assistant' CHECK (role IN ('lead','assistant','duty')),
  duty_label  text CHECK (duty_label IS NULL OR length(duty_label) <= 40),     -- first_aid, registration, safeguarding ...
  status      text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','confirmed','declined','removed')),
  assigned_by uuid REFERENCES users,
  replaced_for uuid REFERENCES users,
  responded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_session_staff_live ON academy_session_staff (session_id, user_id) WHERE status IN ('assigned','confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS academy_session_staff_one_lead ON academy_session_staff (session_id) WHERE role = 'lead' AND status IN ('assigned','confirmed');
CREATE INDEX IF NOT EXISTS academy_session_staff_user ON academy_session_staff (user_id, status);

-- availability, exceptions and leave
CREATE TABLE IF NOT EXISTS academy_staff_availability (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  kind            text NOT NULL CHECK (kind IN ('weekly','exception','time_off')),
  weekday         int CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  start_min       int CHECK (start_min IS NULL OR start_min BETWEEN 0 AND 1439),
  end_min         int CHECK (end_min IS NULL OR end_min BETWEEN 1 AND 1440),
  on_date         date,
  ends_on         date,
  reason          text CHECK (reason IS NULL OR length(reason) <= 300),
  status          text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_min IS NULL OR start_min IS NULL OR end_min > start_min)
);
CREATE INDEX IF NOT EXISTS academy_staff_availability_user ON academy_staff_availability (organisation_id, user_id, kind, status);

-- cover and swap requests (a replacement is a normal assignment; this records the request and decision)
CREATE TABLE IF NOT EXISTS academy_cover_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES academy_sessions,
  requester_id uuid NOT NULL REFERENCES users,
  kind        text NOT NULL DEFAULT 'cover' CHECK (kind IN ('cover','swap')),
  swap_with   uuid REFERENCES users,
  reason      text CHECK (reason IS NULL OR length(reason) <= 300),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','declined','cancelled')),
  cover_user_id uuid REFERENCES users,
  decided_by  uuid REFERENCES users,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_cover_open ON academy_cover_requests (session_id, requester_id) WHERE status = 'open';

-- planned non-session work (registration desk, programme coordination, safeguarding duty, event support). A venue duty shift (#90) is referenced,
-- never duplicated: source_type/source_id name the owning record when #90 projects its roster here.
CREATE TABLE IF NOT EXISTS academy_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  duty_label      text CHECK (duty_label IS NULL OR length(duty_label) <= 40),
  programme_id    uuid REFERENCES academy_programmes,
  timezone        text NOT NULL DEFAULT 'UTC',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','confirmed','declined','cancelled')),
  source_type     text, source_id text,
  responded_at    timestamptz,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS academy_shifts_user_time ON academy_shifts (user_id, starts_at);
CREATE INDEX IF NOT EXISTS academy_shifts_org_time ON academy_shifts (organisation_id, starts_at);

-- session-level athlete attendance; one row per session and athlete, corrections are logged
CREATE TABLE IF NOT EXISTS academy_attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES academy_sessions,
  user_id     uuid NOT NULL REFERENCES users,
  enrolment_id uuid REFERENCES org_enrolments,
  status      text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','present','late','left_early','absent','excused','not_held')),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('illness','family','travel','school','injury_non_clinical','other')),
  source      text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','bulk','qr','self','guardian','system')),
  guest       boolean NOT NULL DEFAULT false,            -- make-up / transfer attendee who is not in the cohort
  marked_by   uuid REFERENCES users,
  marked_at   timestamptz,
  arrived_at  timestamptz,
  left_at     timestamptz,
  venue_checkin_ref text,                                 -- reference only: facility arrival (#90) is a different fact
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (session_id, user_id)
);
CREATE TABLE IF NOT EXISTS academy_attendance_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES academy_sessions,
  user_id     uuid NOT NULL REFERENCES users,
  from_status text,
  to_status   text NOT NULL,
  source      text,
  idempotency_key text,
  actor_id    uuid REFERENCES users,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS academy_attendance_log_session ON academy_attendance_log (session_id, user_id, created_at);
-- the same scan/retry key can only ever be applied once
CREATE UNIQUE INDEX IF NOT EXISTS academy_attendance_log_idem ON academy_attendance_log (session_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- timesheets: worked time linked to canonical work (a session) or a non-session shift
CREATE TABLE IF NOT EXISTS academy_timesheets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  session_id      uuid REFERENCES academy_sessions,
  shift_id        uuid REFERENCES academy_shifts,
  kind            text NOT NULL DEFAULT 'session' CHECK (kind IN ('session','shift','manual')),
  label           text CHECK (label IS NULL OR length(label) <= 80),
  work_date       date NOT NULL,
  scheduled_start timestamptz,
  scheduled_end   timestamptz,
  clock_in        timestamptz,
  clock_out       timestamptz,
  break_min       int NOT NULL DEFAULT 0 CHECK (break_min >= 0),
  minutes         int CHECK (minutes IS NULL OR minutes >= 0),          -- worked, net of breaks (set on submit/adjust)
  role            text NOT NULL DEFAULT 'assistant',
  programme_id    uuid REFERENCES academy_programmes,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','approved','rejected')),
  payroll_run_id  uuid,
  idempotency_key text,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_timesheets_org ON academy_timesheets (organisation_id, status, work_date);
CREATE INDEX IF NOT EXISTS academy_timesheets_user ON academy_timesheets (user_id, work_date);
CREATE UNIQUE INDEX IF NOT EXISTS academy_timesheets_session_user ON academy_timesheets (session_id, user_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academy_timesheets_shift_user ON academy_timesheets (shift_id, user_id) WHERE shift_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academy_timesheets_idem ON academy_timesheets (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS academy_timesheet_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timesheet_id uuid NOT NULL REFERENCES academy_timesheets,
  action       text NOT NULL CHECK (action IN ('created','clock_in','clock_out','submitted','adjusted','approved','rejected','reopened')),
  actor_id     uuid REFERENCES users,
  reason       text,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS academy_timesheet_events_ts ON academy_timesheet_events (timesheet_id, created_at);

-- effective-dated compensation terms. A change is a new row; history is never rewritten.
CREATE TABLE IF NOT EXISTS academy_comp_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  role            text NOT NULL DEFAULT 'any' CHECK (role IN ('any','lead','assistant','duty')),
  programme_id    uuid REFERENCES academy_programmes,
  model           text NOT NULL CHECK (model IN ('hourly','per_session','day_rate','programme_fixed','volunteer')),
  rate_minor      bigint NOT NULL DEFAULT 0 CHECK (rate_minor >= 0),
  currency        text NOT NULL,
  overtime_bp     int NOT NULL DEFAULT 10000 CHECK (overtime_bp BETWEEN 10000 AND 40000),   -- 10000 = 1.0x; applies to hourly minutes beyond the scheduled time
  effective_from  date NOT NULL,
  note            text,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_comp_rules_version ON academy_comp_rules (organisation_id, user_id, role, coalesce(programme_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);

CREATE TABLE IF NOT EXISTS academy_pay_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  amount_minor    bigint NOT NULL CHECK (amount_minor <> 0),
  currency        text NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  on_date         date NOT NULL,
  payroll_run_id  uuid,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- a payroll run is an approved statement of academy compensation OBLIGATIONS for one period and currency; it moves no money
CREATE TABLE IF NOT EXISTS academy_payroll_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  currency        text NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','void')),
  idempotency_key text NOT NULL,
  total_minor     bigint NOT NULL DEFAULT 0,
  unpriced        jsonb NOT NULL DEFAULT '[]',            -- approved timesheets with no usable rule / another currency, listed not summed
  approved_by     uuid REFERENCES users,
  approved_at     timestamptz,
  exported_at     timestamptz,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1,
  UNIQUE (organisation_id, idempotency_key),
  CHECK (period_end >= period_start)
);
CREATE TABLE IF NOT EXISTS academy_payroll_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES academy_payroll_runs,
  user_id       uuid NOT NULL REFERENCES users,
  minutes       int NOT NULL DEFAULT 0,
  scheduled_minutes int NOT NULL DEFAULT 0,
  sessions      int NOT NULL DEFAULT 0,
  base_minor    bigint NOT NULL DEFAULT 0,
  adjustments_minor bigint NOT NULL DEFAULT 0,
  gross_minor   bigint NOT NULL DEFAULT 0,
  paid_minor    bigint NOT NULL DEFAULT 0,                -- only what a canonical record proves; none exists for staff pay yet, so 0
  detail        jsonb NOT NULL DEFAULT '[]',               -- per timesheet: rule id, version date, amount
  UNIQUE (run_id, user_id)
);

-- history is append-only
CREATE OR REPLACE FUNCTION academy_ops_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['academy_session_changes','academy_attendance_log','academy_timesheet_events','academy_comp_rules','academy_payroll_lines'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_ao', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION academy_ops_append_only()', t || '_ao', t);
  END LOOP;
END $$;

-- an approved run and the timesheets it covers are frozen
CREATE OR REPLACE FUNCTION academy_run_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' AND (NEW.status <> 'approved' OR NEW.total_minor <> OLD.total_minor OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end OR NEW.currency <> OLD.currency) THEN
    RAISE EXCEPTION 'an approved payroll run cannot be changed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION academy_timesheet_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.payroll_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM academy_payroll_runs r WHERE r.id = OLD.payroll_run_id AND r.status = 'approved')
     AND (NEW.minutes IS DISTINCT FROM OLD.minutes OR NEW.status <> OLD.status OR NEW.clock_in IS DISTINCT FROM OLD.clock_in OR NEW.clock_out IS DISTINCT FROM OLD.clock_out OR NEW.break_min <> OLD.break_min OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id) THEN
    RAISE EXCEPTION 'this timesheet is part of an approved payroll run';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS academy_payroll_runs_frozen ON academy_payroll_runs;
CREATE TRIGGER academy_payroll_runs_frozen BEFORE UPDATE ON academy_payroll_runs FOR EACH ROW EXECUTE FUNCTION academy_run_frozen();
DROP TRIGGER IF EXISTS academy_timesheets_frozen ON academy_timesheets;
CREATE TRIGGER academy_timesheets_frozen BEFORE UPDATE ON academy_timesheets FOR EACH ROW EXECUTE FUNCTION academy_timesheet_frozen();

-- venue holds for academy sessions use the canonical session -> booking link
DO $$ DECLARE n text; BEGIN
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid = 'session_venue_links'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%session_type%' LOOP
    EXECUTE format('ALTER TABLE session_venue_links DROP CONSTRAINT %I', n);
  END LOOP;
END $$;
ALTER TABLE session_venue_links ADD CONSTRAINT session_venue_links_session_type_check CHECK (session_type IN ('coach_hire','training_session','academy_session'));

-- Performance Studio can run an academy session as its source (it references, never copies, the roster and attendance)
DO $$ DECLARE n text; BEGIN
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid = 'coaching_session_records'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%source_type%' LOOP
    EXECUTE format('ALTER TABLE coaching_session_records DROP CONSTRAINT %I', n);
  END LOOP;
END $$;
ALTER TABLE coaching_session_records ADD CONSTRAINT coaching_session_records_source_type_check CHECK (source_type IN ('training_session','coach_hire','fixture','team_session','academy_session'));
