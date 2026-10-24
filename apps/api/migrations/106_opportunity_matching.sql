-- Explainable player opportunity matching (issue #316, child of #310). Additive only: nullable columns, nothing is
-- dropped, narrowed or rewritten, and existing rows keep meaning "not stated" (the matcher reports that as missing data,
-- it never guesses). Rollback: the columns are unused by older code and can simply be left in place.
--  * team openings (billboard), events/trials and study programmes can state the positions, levels, region and age band
--    they are for, so a player's card can be compared with them
--  * the player can state a budget (what they can pay per opportunity) next to their recruitment preferences
-- levels use the sport-card vocabulary: beginner | amateur | semi_pro | pro (validated by the capabilities).

ALTER TABLE billboard_posts ADD COLUMN IF NOT EXISTS positions text[] NOT NULL DEFAULT '{}';
ALTER TABLE billboard_posts ADD COLUMN IF NOT EXISTS levels    text[] NOT NULL DEFAULT '{}';
ALTER TABLE billboard_posts ADD COLUMN IF NOT EXISTS region    text;
ALTER TABLE billboard_posts ADD COLUMN IF NOT EXISTS min_age   int CHECK (min_age IS NULL OR min_age BETWEEN 3 AND 99);
ALTER TABLE billboard_posts ADD COLUMN IF NOT EXISTS max_age   int CHECK (max_age IS NULL OR max_age BETWEEN 3 AND 99);

ALTER TABLE events ADD COLUMN IF NOT EXISTS levels  text[] NOT NULL DEFAULT '{}';
ALTER TABLE events ADD COLUMN IF NOT EXISTS region  text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS min_age int CHECK (min_age IS NULL OR min_age BETWEEN 3 AND 99);
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_age int CHECK (max_age IS NULL OR max_age BETWEEN 3 AND 99);

ALTER TABLE programmes ADD COLUMN IF NOT EXISTS levels  text[] NOT NULL DEFAULT '{}';
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS min_age int CHECK (min_age IS NULL OR min_age BETWEEN 3 AND 99);
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS max_age int CHECK (max_age IS NULL OR max_age BETWEEN 3 AND 99);

-- the player's own budget per opportunity, in one currency (no silent conversion anywhere)
ALTER TABLE recruitment_preferences ADD COLUMN IF NOT EXISTS budget_cents    bigint CHECK (budget_cents IS NULL OR budget_cents >= 0);
ALTER TABLE recruitment_preferences ADD COLUMN IF NOT EXISTS budget_currency text   CHECK (budget_currency IS NULL OR budget_currency ~ '^[A-Z]{3}$');
