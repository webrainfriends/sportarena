-- Team chat: one conversation per team, visible to its active members only. Additive; messages are soft-deleted.
CREATE TABLE team_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES teams,
  sender_id  uuid NOT NULL REFERENCES users,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  announcement boolean NOT NULL DEFAULT false,     -- posted by a manager; every member is notified
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users
);
CREATE INDEX team_messages_feed ON team_messages (team_id, created_at DESC);

CREATE TABLE team_chat_reads (
  team_id      uuid NOT NULL REFERENCES teams,
  user_id      uuid NOT NULL REFERENCES users,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
