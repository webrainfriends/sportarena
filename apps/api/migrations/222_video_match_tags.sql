-- Issue #565: Video, Scouting & Sports Intelligence Platform
-- Sport-specific configurable tag templates and timestamped match event tags on videos.

-- Per-org, per-sport configurable tag taxonomy (coaches define their own tag types)
CREATE TABLE IF NOT EXISTS video_tag_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  sport_id uuid REFERENCES sports,
  name text NOT NULL,
  code text NOT NULL,                        -- short code e.g. 'goal', 'shot', 'foul'
  colour text NOT NULL DEFAULT '#8458B3',    -- hex colour for timeline marker
  icon text,                                 -- optional icon name
  category text NOT NULL DEFAULT 'event',   -- event / tactical / custom
  is_default boolean NOT NULL DEFAULT false, -- seeded from sport catalogue
  archived_at timestamptz,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vtt_org ON video_tag_templates (org_id);
CREATE INDEX IF NOT EXISTS vtt_sport ON video_tag_templates (org_id, sport_id) WHERE sport_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vtt_org_code ON video_tag_templates (org_id, sport_id, code) WHERE archived_at IS NULL;

-- Timestamped sport event tags placed on a video
CREATE TABLE IF NOT EXISTS video_sport_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES passport_videos,
  template_id uuid NOT NULL REFERENCES video_tag_templates,
  timestamp_ms bigint NOT NULL,              -- position in video
  duration_ms bigint,                        -- optional span
  match_event_id uuid,                       -- FK to canonical match event (nullable)
  match_event_version int,                   -- snapshot of match event version at link time
  ai_suggested boolean NOT NULL DEFAULT false,
  ai_confidence numeric(4,3),                -- 0.000–1.000 when ai_suggested
  verified boolean NOT NULL DEFAULT false,   -- set to true by a human
  notes_enc text,                            -- encrypted coach note
  author_id uuid NOT NULL REFERENCES users,
  corrected_from uuid REFERENCES video_sport_tags, -- version-safe correction chain
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vst_video ON video_sport_tags (video_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS vst_template ON video_sport_tags (template_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS vst_video_ts ON video_sport_tags (video_id, timestamp_ms) WHERE archived_at IS NULL;

-- Links a video to a fixture/match with start offset (for multi-angle or delayed recordings)
CREATE TABLE IF NOT EXISTS video_match_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES passport_videos,
  fixture_id uuid NOT NULL REFERENCES fixtures,
  start_offset_ms bigint NOT NULL DEFAULT 0,  -- video time that corresponds to match kick-off
  angle text,                                  -- 'main', 'tactical', 'goalline', 'player_tracking'
  version int NOT NULL DEFAULT 1,
  correction_notes_enc text,
  linked_by uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vml_video_fixture ON video_match_links (video_id, fixture_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS vml_fixture ON video_match_links (fixture_id) WHERE archived_at IS NULL;
