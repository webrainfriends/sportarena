-- Sponsor collaboration: tasks, assignments, internal notes, due/review/expiry reminders and escalation (issue #306). Additive and backwards-compatible:
-- no existing row, column or constraint is changed or removed, and nothing here is ever deleted (a task is cancelled, a note is immutable).
-- A task or note belongs to ONE agreement (sponsorships) or ONE funding program (sponsorship_programs) and to ONE side of it:
--   side='sponsor'    the brand's own staff (programs are always the brand's)
--   side='recipient'  the recipient's own people
-- visibility='internal' is visible to the owning side only (never the other side, never a platform admin); 'shared' is visible to both sides.
-- `row_version` is the version callers send so an edit made on a stale view is refused (409).
-- Rollback: nothing else depends on these tables; DROP them only after exporting the tasks and notes you want to keep.
CREATE TABLE IF NOT EXISTS sponsorship_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id  uuid REFERENCES sponsorships,
  program_id      uuid REFERENCES sponsorship_programs,
  side            text NOT NULL CHECK (side IN ('sponsor','recipient')),
  visibility      text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','shared')),
  kind            text NOT NULL DEFAULT 'task' CHECK (kind IN ('task','review','expiry')),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  detail          text CHECK (detail IS NULL OR char_length(detail) <= 1000),
  assignee_id     uuid REFERENCES users,
  due_on          date,
  remind_days     int NOT NULL DEFAULT 3 CHECK (remind_days BETWEEN 0 AND 30),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  completed_by    uuid REFERENCES users,
  completed_at    timestamptz,
  escalated_at    timestamptz,
  escalation_level int NOT NULL DEFAULT 0,
  reminder_cycle  int NOT NULL DEFAULT 0,       -- bumped when the assignee or due date changes, so reminders fire again for the new plan
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((sponsorship_id IS NOT NULL) <> (program_id IS NOT NULL)),
  CHECK (program_id IS NULL OR (side = 'sponsor' AND visibility = 'internal'))   -- a program is the brand's own workspace
);
CREATE INDEX IF NOT EXISTS sponsorship_tasks_deal ON sponsorship_tasks (sponsorship_id, due_on NULLS LAST, id) WHERE sponsorship_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsorship_tasks_program ON sponsorship_tasks (program_id, due_on NULLS LAST, id) WHERE program_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsorship_tasks_assignee ON sponsorship_tasks (assignee_id, status, due_on) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsorship_tasks_due ON sponsorship_tasks (due_on) WHERE status = 'open' AND due_on IS NOT NULL;

-- Working notes and discussion on an agreement or program (optionally about one task). Immutable once written.
CREATE TABLE IF NOT EXISTS sponsorship_notes (
  id              bigserial PRIMARY KEY,
  sponsorship_id  uuid REFERENCES sponsorships,
  program_id      uuid REFERENCES sponsorship_programs,
  task_id         uuid REFERENCES sponsorship_tasks,
  side            text NOT NULL CHECK (side IN ('sponsor','recipient')),
  visibility      text NOT NULL CHECK (visibility IN ('internal','shared')),
  author_id       uuid NOT NULL REFERENCES users,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((sponsorship_id IS NOT NULL) <> (program_id IS NOT NULL)),
  CHECK (program_id IS NULL OR (side = 'sponsor' AND visibility = 'internal'))
);
CREATE INDEX IF NOT EXISTS sponsorship_notes_deal ON sponsorship_notes (sponsorship_id, id) WHERE sponsorship_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsorship_notes_program ON sponsorship_notes (program_id, id) WHERE program_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsorship_notes_task ON sponsorship_notes (task_id, id) WHERE task_id IS NOT NULL;

-- One row per reminder or escalation actually sent, so the scheduled job can run any number of times (or on two workers) and notify exactly once.
CREATE TABLE IF NOT EXISTS sponsorship_task_notices (
  task_id    uuid NOT NULL REFERENCES sponsorship_tasks,
  cycle      int NOT NULL,
  milestone  text NOT NULL CHECK (milestone IN ('upcoming','due','overdue','escalated','orphaned')),
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, cycle, milestone)
);
