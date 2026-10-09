-- Profile photos: a user may upload a photo that replaces the emoji avatar. Additive only; the emoji/colour stay as the fallback,
-- and old photo files/rows are kept (market_media rows are retired, never deleted).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE market_media ADD COLUMN IF NOT EXISTS purpose text;
