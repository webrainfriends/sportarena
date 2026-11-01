-- Player video library and highlight showcase (issue #317, child of #310). Additive only: nothing is dropped, rewritten or narrowed.
-- The library EXTENDS passport_videos (one store for a player's clips) and passport_links (one gate for sharing). Existing rows keep
-- their meaning: they default to visibility 'shared', exactly how an approved passport video behaved before.
ALTER TABLE passport_videos
  ADD COLUMN IF NOT EXISTS description_enc   text,
  ADD COLUMN IF NOT EXISTS source            text NOT NULL DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS provenance_ref    uuid,
  ADD COLUMN IF NOT EXISTS match_activity_id text,
  ADD COLUMN IF NOT EXISTS visibility        text NOT NULL DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS published_at      timestamptz,
  ADD COLUMN IF NOT EXISTS unpublished_at    timestamptz,
  ADD COLUMN IF NOT EXISTS client_key        text,
  ADD COLUMN IF NOT EXISTS archived_at       timestamptz;
DO $$ BEGIN
  ALTER TABLE passport_videos ADD CONSTRAINT passport_videos_source_chk CHECK (source IN ('upload','link','coaching_evidence'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE passport_videos ADD CONSTRAINT passport_videos_visibility_chk CHECK (visibility IN ('private','shared','public'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- backfill the meaning of the existing rows: link vs upload
UPDATE passport_videos SET source = CASE WHEN file_name IS NULL THEN 'link' ELSE 'upload' END WHERE source = 'upload' AND file_name IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS passport_videos_client_key ON passport_videos (user_id, client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS passport_videos_evidence_once ON passport_videos (user_id, provenance_ref) WHERE provenance_ref IS NOT NULL AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS passport_videos_match ON passport_videos (user_id, match_activity_id) WHERE match_activity_id IS NOT NULL AND removed_at IS NULL;

-- highlight reels and playlists (soft-state only; no cascades)
CREATE TABLE IF NOT EXISTS video_playlists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  kind            text NOT NULL DEFAULT 'playlist' CHECK (kind IN ('highlight','playlist')),
  description_enc text,
  sport_id        uuid REFERENCES sports,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX IF NOT EXISTS video_playlists_user ON video_playlists (user_id, created_at DESC, id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS video_playlist_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id uuid NOT NULL REFERENCES video_playlists,
  video_id    uuid NOT NULL REFERENCES passport_videos,
  position    int NOT NULL DEFAULT 0,
  added_at    timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS video_playlist_items_once ON video_playlist_items (playlist_id, video_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS video_playlist_items_order ON video_playlist_items (playlist_id, position, id) WHERE removed_at IS NULL;

-- a share link can be limited to one playlist (the existing passport link, token, revoke, expiry and consent gate apply unchanged)
ALTER TABLE passport_links ADD COLUMN IF NOT EXISTS playlist_id uuid REFERENCES video_playlists;
