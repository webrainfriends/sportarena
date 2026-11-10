-- Migration 199: Coach session media & resource library
-- Additive only. No DROP, TRUNCATE or column removal.
-- Adds: session_media, session_media_views tables.
-- Files stored encrypted on disk (same pattern as inbox attachments).
-- Rows are retired with removed_at — bytes are never deleted.

CREATE TABLE IF NOT EXISTS session_media (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES training_sessions(id),
  plan_id         uuid        NOT NULL REFERENCES training_plans(id),   -- denorm: fast auth without join
  uploaded_by     uuid        NOT NULL REFERENCES users(id),
  kind            text        NOT NULL CHECK (kind IN ('video','document','image','link')),
  -- binary fields (NULL for kind='link')
  content_type    text,
  original_name   text,
  file_name       text,       -- encrypted .bin on disk under mediaDir/session-media/
  size_bytes      bigint,
  sha256          text,
  duration_sec    int,        -- video only: rounded seconds
  -- external link fields (NULL for binary kinds)
  link_url        text,
  link_provider   text        CHECK (link_provider IN ('youtube','vimeo','hudl','catapult','sportscode','other',NULL)),
  link_thumb_url  text,
  -- shared metadata
  caption         text        CHECK (length(caption) <= 500),
  position        smallint    NOT NULL DEFAULT 0,
  released        boolean     NOT NULL DEFAULT true,   -- coach can hold back; athletes only see released=true
  view_count      int         NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS session_media_session
  ON session_media(session_id, position) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS session_media_plan
  ON session_media(plan_id, created_at DESC) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS session_media_uploader
  ON session_media(uploaded_by, created_at DESC);

-- Record when each participant last viewed the resource list; drives unread badge.
CREATE TABLE IF NOT EXISTS session_media_views (
  session_id  uuid        NOT NULL REFERENCES training_sessions(id),
  user_id     uuid        NOT NULL REFERENCES users(id),
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS session_media_views_user
  ON session_media_views(user_id, session_id);

-- Prevent hard deletes; retirement = set removed_at.
CREATE OR REPLACE RULE session_media_no_delete
  AS ON DELETE TO session_media DO INSTEAD NOTHING;
