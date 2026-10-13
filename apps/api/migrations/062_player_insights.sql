-- Where an athlete plays, per sport profile: a self-declared city/area used only to compare them with players nearby
-- (insights show cohort aggregates, never other players' data). Additive and nullable: existing profiles are untouched.
ALTER TABLE sport_profiles ADD COLUMN IF NOT EXISTS region text;
CREATE INDEX IF NOT EXISTS sport_profiles_sport_region ON sport_profiles (sport_id, lower(btrim(region))) WHERE region IS NOT NULL;
