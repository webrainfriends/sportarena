-- Smart clips phase 2 (#505): rendered scorecard and sponsor-bumper frame columns on reel items.
-- Additive only: no data removed, no columns narrowed.
ALTER TABLE clip_reel_items ADD COLUMN IF NOT EXISTS frame_url  TEXT;
ALTER TABLE clip_reel_items ADD COLUMN IF NOT EXISTS frame_data JSONB;
