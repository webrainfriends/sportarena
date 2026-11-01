-- Skill level as a ranking formula (#633). Additive: widens the allowed formula kinds of ranking versions; no rows are touched.
-- The leaderboard is the existing rankings engine reading skill_ratings; there is no second leaderboard.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'ranking_definition_versions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%per_90%' LOOP
    EXECUTE format('ALTER TABLE ranking_definition_versions DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE ranking_definition_versions ADD CONSTRAINT ranking_definition_versions_formula_kind_check
  CHECK (formula_kind IN ('metric','per_90','per_match','team_form','skill_level'));
