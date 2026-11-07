-- Family-facing live stream and replay hub (gaps audit, feature 5).
-- Additive only. Extends the existing media-rights stream registry (mr_streams); mr_streams never existed, so extending it made this migration fail.

ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS is_replay boolean NOT NULL DEFAULT false;
ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS replay_url text;
ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS replay_available_at timestamptz;
ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS duration_seconds int;
ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS event_markers jsonb NOT NULL DEFAULT '[]';
ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS camera_feeds jsonb NOT NULL DEFAULT '[]';
ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS quality_options jsonb NOT NULL DEFAULT '[]';
ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS allow_family_chat boolean NOT NULL DEFAULT true;
ALTER TABLE mr_streams ADD COLUMN IF NOT EXISTS offline_download_url text;

CREATE TABLE IF NOT EXISTS stream_alert_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  team_id uuid NOT NULL REFERENCES teams(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, team_id)
);

CREATE TABLE IF NOT EXISTS stream_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES mr_streams(id),
  user_id uuid NOT NULL REFERENCES users(id),
  message_enc text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stream_chat_stream ON stream_chat_messages(stream_id, sent_at DESC);
