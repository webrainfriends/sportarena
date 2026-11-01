-- Unified Inbox (issue #594). Additive only: nothing is dropped, rewritten or narrowed, and no row is ever deleted.
-- Team chat (team_messages) stays the team channel and is listed in the inbox as it is. This adds the conversation types it lacks:
-- direct, group, event channel and threads linked to a team / event / fixture / registration. Message text is encrypted at rest.

CREATE TABLE conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('direct','group','event','context')),
  title          text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 80),
  created_by     uuid NOT NULL REFERENCES users,
  team_id        uuid REFERENCES teams,
  event_id       uuid REFERENCES events,
  fixture_id     uuid REFERENCES fixtures,
  entry_id       uuid REFERENCES event_entries,          -- a registration thread
  organisation_id uuid REFERENCES organisations,         -- tenant: copied from the team / event's organisation when it has one
  direct_key     text,                                   -- sorted "<userA>:<userB>" so a pair has exactly one direct conversation
  announcements_only boolean NOT NULL DEFAULT false,     -- only managers may post (a broadcast channel)
  retention_days int NOT NULL DEFAULT 730 CHECK (retention_days BETWEEN 30 AND 3650),
  last_seq       bigint NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  archived_at    timestamptz,
  archived_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'direct' OR direct_key IS NOT NULL),
  CHECK (kind <> 'context' OR team_id IS NOT NULL OR event_id IS NOT NULL OR fixture_id IS NOT NULL OR entry_id IS NOT NULL)
);
CREATE UNIQUE INDEX conversations_direct ON conversations (direct_key) WHERE direct_key IS NOT NULL;
CREATE UNIQUE INDEX conversations_event_channel ON conversations (event_id) WHERE kind = 'event' AND archived_at IS NULL;
CREATE INDEX conversations_team ON conversations (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX conversations_event ON conversations (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX conversations_activity ON conversations (last_message_at DESC NULLS LAST);

-- A person who leaves or is removed keeps their row (history stays); access ends the moment left_at is set.
CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations,
  user_id         uuid NOT NULL REFERENCES users,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','moderator','member')),
  added_by        uuid REFERENCES users,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  muted_at        timestamptz,                           -- the person's own mute (no push / SMS; still listed)
  silenced_until  timestamptz,                           -- a moderator's temporary posting stop
  silenced_by     uuid REFERENCES users,
  last_read_seq   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members (user_id) WHERE left_at IS NULL;

-- Messages: body is encrypted (body_enc, context conversation_messages.body). Hidden = removed from view by a moderator or the sender, row kept.
CREATE TABLE conversation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations,
  seq             bigint NOT NULL,
  sender_id       uuid NOT NULL REFERENCES users,
  body_enc        text NOT NULL,
  kind            text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','announcement','system')),
  requires_ack    boolean NOT NULL DEFAULT false,        -- an urgent notice: recipients confirm they saw it, otherwise it escalates
  escalate_after_minutes int CHECK (escalate_after_minutes IS NULL OR escalate_after_minutes BETWEEN 5 AND 1440),
  reply_to_id     uuid REFERENCES conversation_messages,
  attachment_id   uuid,
  client_id       text CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
  hidden_at       timestamptz,
  hidden_by       uuid REFERENCES users,
  hidden_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE UNIQUE INDEX conversation_messages_client ON conversation_messages (conversation_id, sender_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX conversation_messages_due ON conversation_messages (created_at) WHERE requires_ack;

CREATE TABLE conversation_acks (
  message_id uuid NOT NULL REFERENCES conversation_messages,
  user_id    uuid NOT NULL REFERENCES users,
  acked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- One row per person a notice was escalated to (their own delay, or the notice's): makes the sweep idempotent.
CREATE TABLE conversation_escalations (
  message_id   uuid NOT NULL REFERENCES conversation_messages,
  user_id      uuid NOT NULL REFERENCES users,
  escalated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- Attachments: stored encrypted on disk (doc-store); served only to current members, checked on every download.
CREATE TABLE conversation_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations,
  uploader_id     uuid NOT NULL REFERENCES users,
  kind            text NOT NULL CHECK (kind IN ('image','file')),
  content_type    text NOT NULL,
  name            text NOT NULL,
  file_name       text NOT NULL,
  size_bytes      int NOT NULL CHECK (size_bytes > 0),
  sha256          text NOT NULL,
  scan_status     text NOT NULL DEFAULT 'clean',
  removed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_attachments_conv ON conversation_attachments (conversation_id);

-- Reports and moderation: a report keeps the reporter, the message and the outcome. Nothing is deleted.
CREATE TABLE conversation_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations,
  message_id      uuid NOT NULL REFERENCES conversation_messages,
  reporter_id     uuid NOT NULL REFERENCES users,
  reason          text NOT NULL CHECK (reason IN ('abuse','harassment','unsafe_contact','spam','privacy','other')),
  note_enc        text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  handled_by      uuid REFERENCES users,
  handled_at      timestamptz,
  outcome         text CHECK (outcome IS NULL OR outcome IN ('hidden','silenced','dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, reporter_id)
);
CREATE INDEX conversation_reports_open ON conversation_reports (conversation_id) WHERE status = 'open';

-- A person can stop one other person from starting direct conversations with them (existing conversations stay, muted).
CREATE TABLE user_blocks (
  blocker_id uuid NOT NULL REFERENCES users,
  blocked_id uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- Quiet hours and escalation live with the other notification preferences.
ALTER TABLE notification_prefs ADD COLUMN quiet_start time;
ALTER TABLE notification_prefs ADD COLUMN quiet_end time;
ALTER TABLE notification_prefs ADD COLUMN quiet_tz text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE notification_prefs ADD COLUMN quiet_weekdays_only boolean NOT NULL DEFAULT false;
ALTER TABLE notification_prefs ADD COLUMN quiet_urgent_override boolean NOT NULL DEFAULT true;
ALTER TABLE notification_prefs ADD COLUMN escalate_after_minutes int CHECK (escalate_after_minutes IS NULL OR escalate_after_minutes BETWEEN 5 AND 1440);  -- NULL = the notice's own delay
ALTER TABLE notification_prefs ADD COLUMN escalation_off boolean NOT NULL DEFAULT false;                                                          -- "Never": no SMS / WhatsApp escalation (a young person's guardian is still told)
