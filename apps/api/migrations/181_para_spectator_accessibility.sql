-- PS-26: Accessible para-sport spectator results, media and broadcasts
-- Adds accessibility metadata to mr_assets, mr_streams and two new tables.
-- Additive only — no drops, no truncates, no data loss.

-- Accessibility metadata on media assets (caption, audio description, transcript, alt text)
ALTER TABLE mr_assets
  ADD COLUMN IF NOT EXISTS caption_ref        text CHECK (caption_ref IS NULL OR caption_ref ~ '^https://'),
  ADD COLUMN IF NOT EXISTS audio_desc_ref     text CHECK (audio_desc_ref IS NULL OR audio_desc_ref ~ '^https://'),
  ADD COLUMN IF NOT EXISTS transcript_ref     text CHECK (transcript_ref IS NULL OR transcript_ref ~ '^https://'),
  ADD COLUMN IF NOT EXISTS alt_text           text CHECK (alt_text IS NULL OR length(alt_text) <= 1000),
  ADD COLUMN IF NOT EXISTS a11y_status        text NOT NULL DEFAULT 'unknown' CHECK (a11y_status IN ('unknown','partial','verified','not_available'));

-- Accessibility metadata on streams (caption track, audio description track)
ALTER TABLE mr_streams
  ADD COLUMN IF NOT EXISTS caption_ref        text CHECK (caption_ref IS NULL OR caption_ref ~ '^https://'),
  ADD COLUMN IF NOT EXISTS audio_desc_ref     text CHECK (audio_desc_ref IS NULL OR audio_desc_ref ~ '^https://'),
  ADD COLUMN IF NOT EXISTS a11y_status        text NOT NULL DEFAULT 'unknown' CHECK (a11y_status IN ('unknown','partial','verified','not_available'));

-- Per-fixture organiser-declared accessibility configuration
CREATE TABLE IF NOT EXISTS fixture_accessibility_settings (
  fixture_id              uuid PRIMARY KEY REFERENCES fixtures ON DELETE CASCADE,
  caption_provider_url    text CHECK (caption_provider_url IS NULL OR caption_provider_url ~ '^https://'),
  audio_desc_provider_url text CHECK (audio_desc_provider_url IS NULL OR audio_desc_provider_url ~ '^https://'),
  play_by_play_enabled    boolean NOT NULL DEFAULT true,
  screen_reader_regions   boolean NOT NULL DEFAULT true,
  high_contrast_enabled   boolean NOT NULL DEFAULT false,
  class_aware_scoreboard  boolean NOT NULL DEFAULT true,
  show_combined_view      boolean NOT NULL DEFAULT true,
  caption_status          text NOT NULL DEFAULT 'unknown' CHECK (caption_status IN ('unknown','partial','verified','not_available')),
  audio_desc_status       text NOT NULL DEFAULT 'unknown' CHECK (audio_desc_status IN ('unknown','partial','verified','not_available')),
  transcript_status       text NOT NULL DEFAULT 'unknown' CHECK (transcript_status IN ('unknown','partial','verified','not_available')),
  updated_by              uuid REFERENCES users,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Play-by-play text entries (screen-reader friendly, non-video coverage)
CREATE TABLE IF NOT EXISTS fixture_play_by_play (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id      uuid NOT NULL REFERENCES fixtures ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  para_class_code text CHECK (para_class_code IS NULL OR length(para_class_code) <= 20),
  entry_at        timestamptz NOT NULL DEFAULT now(),
  entry_text      text NOT NULL CHECK (length(entry_text) BETWEEN 1 AND 2000),
  entry_kind      text NOT NULL DEFAULT 'update' CHECK (entry_kind IN ('update','result','record','alert','info')),
  authored_by     uuid REFERENCES users,
  authored_source text NOT NULL DEFAULT 'staff' CHECK (authored_source IN ('staff','automated_scoring','imported')),
  removed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_pbp_fixture ON fixture_play_by_play (fixture_id, entry_at DESC) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS fixture_pbp_event   ON fixture_play_by_play (event_id, entry_at DESC) WHERE removed_at IS NULL;
