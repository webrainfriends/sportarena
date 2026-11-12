BEGIN;
CREATE TABLE IF NOT EXISTS clinical_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  sender_id uuid NOT NULL REFERENCES users(id),
  recipient_id uuid NOT NULL REFERENCES users(id),
  body_enc text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS clinical_messages_thread_idx ON clinical_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS clinical_messages_recipient_unread_idx ON clinical_messages(recipient_id) WHERE read_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS clinical_messages_sender_idx ON clinical_messages(sender_id);
COMMIT;
