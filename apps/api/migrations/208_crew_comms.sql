-- R20: Officiating Crew Communication Center (#1012)
-- Private, assignment-scoped communication for crew and organisers.
-- New tables: crew_threads, crew_messages, crew_message_reads, crew_message_attachments,
--             crew_briefings, crew_briefing_acks, crew_message_flags, crew_shared_docs
-- No finance tables — reuses platform ledger. No isolated PII tables — body_enc uses src/crypto.js.
-- Additive only. All personal free text stored encrypted (*_enc columns).

BEGIN;

-- ── Thread types and message types ───────────────────────────────────────────

-- A thread is scoped to one fixture (and optionally one assignment).
-- type controls access rules and UI rendering; priority elevates emergency threads.
CREATE TABLE IF NOT EXISTS crew_threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id         uuid NOT NULL REFERENCES fixtures(id),
  event_id           uuid NOT NULL REFERENCES events(id),
  -- assignment_id may be null for fixture-wide threads; set for assignment-specific ones
  assignment_id      uuid REFERENCES fixture_officials(id),
  type               text NOT NULL DEFAULT 'general'
                       CHECK (type IN ('general','briefing','emergency','handover','roster_change')),
  priority           integer NOT NULL DEFAULT 0,       -- higher = surfaced first; emergency threads use 100
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  created_by         uuid NOT NULL REFERENCES users(id),
  archived_at        timestamptz,
  archived_by        uuid REFERENCES users(id),
  -- Time-bound access: null = expires 2h after fixture end (computed at read time by capability).
  -- Set explicitly to override.
  access_expires_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crew_threads_fixture_idx ON crew_threads(fixture_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS crew_threads_event_idx   ON crew_threads(event_id)   WHERE archived_at IS NULL;

-- Thread participants: who can see and post in a thread.
-- The capability enforces that every participant is an accepted official or the event organiser.
CREATE TABLE IF NOT EXISTS crew_thread_participants (
  thread_id  uuid NOT NULL REFERENCES crew_threads(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  added_by   uuid REFERENCES users(id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS crew_thread_parts_user ON crew_thread_participants(user_id) WHERE removed_at IS NULL;

-- ── Messages ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crew_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES crew_threads(id),
  sender_id   uuid NOT NULL REFERENCES users(id),
  -- body_enc: encrypted personal/sensitive free text; plain body used for non-sensitive system notices
  body_enc    text,
  body        text CHECK (char_length(body) <= 2000),
  msg_type    text NOT NULL DEFAULT 'text'
                CHECK (msg_type IN ('text','attachment','emergency','roster_change','handover','system')),
  priority    integer NOT NULL DEFAULT 0,    -- 100 for emergency
  client_id   text CHECK (char_length(client_id) BETWEEN 8 AND 64),  -- idempotency key
  reply_to_id uuid REFERENCES crew_messages(id),
  edited_at   timestamptz,
  deleted_at  timestamptz,
  deleted_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,

  UNIQUE (thread_id, sender_id, client_id) DEFERRABLE
);
DO $$ BEGIN
  ALTER TABLE crew_messages ADD CONSTRAINT crew_messages_body_check
    CHECK (body IS NOT NULL OR body_enc IS NOT NULL OR msg_type IN ('attachment','system'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS crew_messages_thread_seq ON crew_messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS crew_messages_thread_time ON crew_messages(thread_id, created_at DESC) WHERE deleted_at IS NULL;

-- ── Read receipts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crew_message_reads (
  message_id uuid NOT NULL REFERENCES crew_messages(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS crew_message_reads_user ON crew_message_reads(user_id);

-- Per-thread high-water mark for unread count (perf optimization, same pattern as team_chat_reads).
CREATE TABLE IF NOT EXISTS crew_thread_reads (
  thread_id    uuid NOT NULL REFERENCES crew_threads(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- ── Attachments ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crew_message_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES crew_messages(id),
  thread_id     uuid NOT NULL REFERENCES crew_threads(id),
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  filename      text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  mime_type     text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 127),
  file_size_bytes bigint CHECK (file_size_bytes > 0 AND file_size_bytes <= 52428800),  -- 50 MB max
  url_enc       text NOT NULL,     -- encrypted storage URL; never logged
  removed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crew_attachments_message ON crew_message_attachments(message_id) WHERE removed_at IS NULL;

-- ── Pre-match Briefings ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crew_briefings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id    uuid NOT NULL REFERENCES fixtures(id),
  event_id      uuid NOT NULL REFERENCES events(id),
  sent_by       uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  body_enc      text NOT NULL,       -- briefing content — encrypted
  sport_context text CHECK (char_length(sport_context) <= 100),
  requires_ack  boolean NOT NULL DEFAULT true,
  archived_at   timestamptz,
  archived_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crew_briefings_fixture ON crew_briefings(fixture_id) WHERE archived_at IS NULL;

-- ── Briefing acknowledgements ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crew_briefing_acks (
  briefing_id  uuid NOT NULL REFERENCES crew_briefings(id),
  official_id  uuid NOT NULL REFERENCES users(id),
  acked_at     timestamptz NOT NULL DEFAULT now(),
  ip_hash      text,         -- SHA-256 of IP, for audit; never the raw IP
  PRIMARY KEY (briefing_id, official_id)
);

CREATE INDEX IF NOT EXISTS crew_briefing_acks_official ON crew_briefing_acks(official_id);

-- ── Shared Docs ───────────────────────────────────────────────────────────────

-- Documents (rules, permits, forms) shared at fixture or thread level.
CREATE TABLE IF NOT EXISTS crew_shared_docs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id      uuid NOT NULL REFERENCES fixtures(id),
  thread_id       uuid REFERENCES crew_threads(id),   -- null = fixture-wide
  shared_by       uuid NOT NULL REFERENCES users(id),
  doc_category    text NOT NULL DEFAULT 'rules'
                    CHECK (doc_category IN ('rules','permit','form','manual','other')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  description     text CHECK (char_length(description) <= 500),
  mime_type       text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 127),
  file_size_bytes bigint CHECK (file_size_bytes > 0),
  url_enc         text NOT NULL,     -- encrypted storage URL
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crew_shared_docs_fixture ON crew_shared_docs(fixture_id)   WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS crew_shared_docs_thread  ON crew_shared_docs(thread_id)    WHERE archived_at IS NULL;

-- ── Moderation / Message Flags ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crew_message_flags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES crew_messages(id),
  thread_id    uuid NOT NULL REFERENCES crew_threads(id),
  flagged_by   uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL CHECK (reason IN ('inappropriate_conduct','misinformation','personal_data_disclosed','other')),
  notes_enc    text,       -- optional notes from reporter — encrypted
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dismissed')),
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  resolution   text CHECK (char_length(resolution) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crew_flags_thread  ON crew_message_flags(thread_id)   WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS crew_flags_message ON crew_message_flags(message_id)  WHERE status = 'pending';

-- ── Audit: sensitive reads (personal data decrypt events) ────────────────────
-- Reuses existing audit_log table; no new table needed.

COMMIT;
