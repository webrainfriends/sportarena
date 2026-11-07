-- Video library enhancements (#317): playlist thumbnails, showcase view analytics. Additive only.
BEGIN;

ALTER TABLE video_playlists
  ADD COLUMN IF NOT EXISTS thumbnail_asset_id uuid; -- no media_assets table exists to reference (the foreign key made this migration fail and the deploy stop)

CREATE TABLE IF NOT EXISTS showcase_views (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id           uuid        NOT NULL REFERENCES users(id),
  viewer_fingerprint  text,
  viewed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS showcase_views_player_id_idx ON showcase_views(player_id);
CREATE INDEX IF NOT EXISTS showcase_views_viewed_at_idx ON showcase_views(viewed_at);

COMMIT;
