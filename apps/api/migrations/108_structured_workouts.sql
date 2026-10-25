-- Structured workout execution (issue #326). Additive only: existing sessions keep structure/actuals NULL and behave as before.
-- structure : planned blocks copied from the accepted plan revision (sets/reps, intervals, rest, distance, pace/power zones, demo links)
-- actuals   : the athlete's recorded results per block, compared with the plan on read
-- objective/focus : what the session is for (e.g. 'repeat-sprint ability', power)
-- version   : bumped on every athlete write so a second device with a stale copy gets a 409 instead of overwriting
ALTER TABLE training_sessions
  ADD COLUMN IF NOT EXISTS structure  jsonb CHECK (structure IS NULL OR jsonb_typeof(structure) = 'array'),
  ADD COLUMN IF NOT EXISTS actuals    jsonb CHECK (actuals IS NULL OR jsonb_typeof(actuals) = 'array'),
  ADD COLUMN IF NOT EXISTS actuals_at timestamptz,
  ADD COLUMN IF NOT EXISTS version    int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS objective  text CHECK (objective IS NULL OR length(objective) <= 300),
  ADD COLUMN IF NOT EXISTS focus      text CHECK (focus IS NULL OR focus IN ('speed','endurance','strength','power','technical','tactical','recovery'));
