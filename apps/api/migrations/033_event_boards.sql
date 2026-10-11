-- Department plans and kanban boards for events. Additive. Cards are archived, never deleted; every move is kept in a history.

CREATE TABLE IF NOT EXISTS event_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  department_id uuid NOT NULL REFERENCES event_departments,
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  goal          text,
  starts_on     date,
  ends_on       date,
  -- ordered columns of the board: [{"key":"backlog","label":"Backlog"}, …]; the last one means "done"
  columns       jsonb NOT NULL DEFAULT '[{"key":"backlog","label":"Backlog"},{"key":"doing","label":"Doing"},{"key":"blocked","label":"Blocked"},{"key":"review","label":"Review"},{"key":"done","label":"Done"}]',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS event_plans_event ON event_plans (event_id, department_id);

CREATE TABLE IF NOT EXISTS event_cards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id        uuid NOT NULL REFERENCES event_plans,
  department_id  uuid NOT NULL REFERENCES event_departments,
  event_id       uuid NOT NULL REFERENCES events,
  column_key     text NOT NULL,
  position       int NOT NULL DEFAULT 0,
  title          text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  description    text,
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  starts_at      timestamptz,
  ends_at        timestamptz,
  due_on         date,
  assignee_ids   uuid[] NOT NULL DEFAULT '{}',
  labels         text[] NOT NULL DEFAULT '{}',
  checklist      jsonb NOT NULL DEFAULT '[]',   -- [{"text":"…","done":false}]
  blocked_reason text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  done_at        timestamptz,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS event_cards_plan ON event_cards (plan_id, column_key, position) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS event_cards_event ON event_cards (event_id, starts_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS event_cards_assignees ON event_cards USING gin (assignee_ids);

CREATE TABLE IF NOT EXISTS event_card_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id    uuid NOT NULL REFERENCES event_cards,
  author_id  uuid NOT NULL REFERENCES users,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_card_comments_card ON event_card_comments (card_id, created_at);

CREATE TABLE IF NOT EXISTS event_card_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id     uuid NOT NULL REFERENCES event_cards,
  actor_id    uuid NOT NULL REFERENCES users,
  action      text NOT NULL,                    -- created | moved | edited | assigned | archived | restored
  from_column text,
  to_column   text,
  note        text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_card_history_card ON event_card_history (card_id, at);
