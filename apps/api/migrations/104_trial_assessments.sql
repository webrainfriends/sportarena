-- Trials and athlete assessments (issue #315). Additive only: nothing is dropped, narrowed or rewritten.
-- A trial is an existing event (kind='trial'); a booking is an existing event_entries row (capacity + waitlist already live there).
-- Attendance, assessments, selection outcome and follow-up are separate facts keyed to that entry, so attending a trial never selects anyone.

-- Assessors are hired through the event console like any other crew: widen the role list (the old values stay valid).
ALTER TABLE event_staff_roles DROP CONSTRAINT IF EXISTS event_staff_roles_role_check;
ALTER TABLE event_staff_roles ADD CONSTRAINT event_staff_roles_role_check
  CHECK (role IN ('referee','umpire','linesman','scorer','doctor','physio','medic','volunteer','security','other','retail','catering','vendor','assessor'));

-- One current attendance mark per booking; every change is logged.
CREATE TABLE trial_attendance (
  entry_id    uuid PRIMARY KEY REFERENCES event_entries,
  event_id    uuid NOT NULL REFERENCES events,
  status      text NOT NULL CHECK (status IN ('present','late','left_early','absent','excused')),
  reason      text CHECK (length(reason) <= 300),
  marked_by   uuid NOT NULL REFERENCES users,
  marked_at   timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX trial_attendance_event ON trial_attendance (event_id);
CREATE TABLE trial_attendance_log (
  id        bigserial PRIMARY KEY,
  entry_id  uuid NOT NULL REFERENCES event_entries,
  from_status text,
  to_status text NOT NULL,
  reason    text,
  actor_id  uuid NOT NULL REFERENCES users,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trial_attendance_log_entry ON trial_attendance_log (entry_id, id);

-- A dated assessment by one assessor of one booking. The rubric dimensions are snapshotted so a score keeps the scale it was given under.
CREATE TABLE trial_assessments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  entry_id    uuid NOT NULL REFERENCES event_entries,
  athlete_id  uuid NOT NULL REFERENCES users,
  assessor_id uuid NOT NULL REFERENCES users,
  rubric_ref  text NOT NULL,                       -- 'standard:<key>' or 'coaching:<rubric id>'
  rubric_name text NOT NULL,
  rubric_version int,
  dimensions  jsonb NOT NULL,                      -- [{key,name,scale_min,scale_max,direction}]
  scores      jsonb NOT NULL,                      -- {dimension key: number}
  feedback    text CHECK (length(feedback) <= 2000),
  private_note text CHECK (length(private_note) <= 2000),   -- staff only, never shown to the player or guardian
  share       text NOT NULL DEFAULT 'after_outcome' CHECK (share IN ('after_outcome','now','private')),
  client_key  text,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (entry_id, assessor_id)
);
CREATE UNIQUE INDEX trial_assessments_client_key ON trial_assessments (assessor_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX trial_assessments_athlete ON trial_assessments (athlete_id, assessed_at DESC);
CREATE TABLE trial_assessment_revisions (
  id            bigserial PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES trial_assessments,
  row_version   int NOT NULL,
  scores        jsonb NOT NULL,
  feedback      text,
  share         text NOT NULL,
  actor_id      uuid NOT NULL REFERENCES users,
  at            timestamptz NOT NULL DEFAULT now()
);

-- The selection decision, deliberately separate from attendance. Released to the player and guardians only when staff release it.
CREATE TABLE trial_outcomes (
  entry_id    uuid PRIMARY KEY REFERENCES event_entries,
  event_id    uuid NOT NULL REFERENCES events,
  decision    text NOT NULL CHECK (decision IN ('selected','second_trial','waitlist','not_progressing')),
  note        text CHECK (length(note) <= 1000),
  decided_by  uuid NOT NULL REFERENCES users,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid REFERENCES users,
  row_version int NOT NULL DEFAULT 1
);
CREATE TABLE trial_outcome_log (
  id        bigserial PRIMARY KEY,
  entry_id  uuid NOT NULL REFERENCES event_entries,
  from_decision text,
  to_decision text NOT NULL,
  note      text,
  actor_id  uuid NOT NULL REFERENCES users,
  at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trial_follow_ups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  entry_id    uuid NOT NULL REFERENCES event_entries,
  athlete_id  uuid NOT NULL REFERENCES users,
  kind        text NOT NULL CHECK (kind IN ('book_session','send_resource','review','other')),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  detail      text CHECK (length(detail) <= 1000),
  due_on      date,
  owner_id    uuid REFERENCES users,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  created_by  uuid NOT NULL REFERENCES users,
  client_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX trial_follow_ups_client_key ON trial_follow_ups (created_by, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX trial_follow_ups_entry ON trial_follow_ups (entry_id, created_at);
