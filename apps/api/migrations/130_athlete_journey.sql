-- Athlete 360 journey (#571). The portfolio is the existing player passport share link, so it only gains two privacy switches; nothing new
-- is stored about the athlete and no row is touched. Both default to off: a link made before this change shows exactly what it showed.
ALTER TABLE passport_links ADD COLUMN IF NOT EXISTS show_journey boolean NOT NULL DEFAULT false;
ALTER TABLE passport_links ADD COLUMN IF NOT EXISTS show_development boolean NOT NULL DEFAULT false;
