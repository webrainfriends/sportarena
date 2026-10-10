-- Team workspace: master team + per-event/tournament sub-teams, a team task board (tasks, subtasks, comments, files)
-- and event/match attendance (RSVP, captain confirmation, check-in). Additive only: existing teams become 'master' teams
-- and no data is dropped or rewritten. Nothing here cascades; tasks are archived (archived_at), never deleted.

ALTER TABLE teams
  ADD COLUMN parent_team_id uuid REFERENCES teams,            -- set => this is a sub-team of that master team
  ADD COLUMN kind           text NOT NULL DEFAULT 'master' CHECK (kind IN ('master','sub')),
  ADD COLUMN event_id       uuid REFERENCES events,           -- the tournament/event a sub-team plays in
  ADD COLUMN description    text,
  ADD COLUMN archived_at    timestamptz,
  ADD CONSTRAINT teams_sub_has_parent CHECK ((kind = 'sub') = (parent_team_id IS NOT NULL));
CREATE INDEX teams_parent ON teams (parent_team_id) WHERE parent_team_id IS NOT NULL;

CREATE TABLE team_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams,
  title       text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','review','done')),
  tags        text[] NOT NULL DEFAULT '{}',
  due_on      date,
  position    int NOT NULL DEFAULT 0,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX team_tasks_team ON team_tasks (team_id, status) WHERE archived_at IS NULL;

CREATE TABLE team_task_assignees (
  task_id uuid NOT NULL REFERENCES team_tasks,
  user_id uuid NOT NULL REFERENCES users,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX team_task_assignees_user ON team_task_assignees (user_id);

CREATE TABLE team_task_subtasks (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id  uuid NOT NULL REFERENCES team_tasks,
  title    text NOT NULL,
  done     boolean NOT NULL DEFAULT false,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_task_subtasks_task ON team_task_subtasks (task_id);

CREATE TABLE team_task_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES team_tasks,
  user_id    uuid NOT NULL REFERENCES users,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_task_comments_task ON team_task_comments (task_id);

CREATE TABLE team_task_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES team_tasks,
  name         text NOT NULL,
  url          text NOT NULL,
  content_type text,
  size_bytes   bigint,
  uploaded_by  uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_task_files_task ON team_task_files (task_id);

-- Who is coming to an event or match: the player's own RSVP, the captain/manager's confirmation, and day-of check-in.
-- Complements team_squads (selection by the coach) — attendance is about turning up.
CREATE TABLE team_attendance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES teams,
  event_id     uuid REFERENCES events,
  fixture_id   uuid REFERENCES fixtures,
  user_id      uuid NOT NULL REFERENCES users,
  rsvp         text NOT NULL DEFAULT 'pending' CHECK (rsvp IN ('pending','going','maybe','no')),
  note         text,
  responded_at timestamptz,
  confirmed_by uuid REFERENCES users,
  confirmed_at timestamptz,
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id IS NOT NULL OR fixture_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (team_id, event_id, fixture_id, user_id)
);
CREATE INDEX team_attendance_scope ON team_attendance (team_id, event_id, fixture_id);
CREATE INDEX team_attendance_user ON team_attendance (user_id);
