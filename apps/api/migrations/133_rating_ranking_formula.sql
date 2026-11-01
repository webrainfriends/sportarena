-- Skill level as a ranking formula (#633). Additive: only widens an allowed-value list; no row is read, changed or removed.
-- A ranking version may now use formula_kind 'rating' (the verified skill level 1.0-7.0 from skill_ratings), so levels are ranked on the existing
-- rankings engine instead of a parallel leaderboard.
-- Rollback: nothing else reads the new value; versions already stored keep their kind.
ALTER TABLE ranking_definition_versions DROP CONSTRAINT IF EXISTS ranking_definition_versions_formula_kind_check;
ALTER TABLE ranking_definition_versions ADD CONSTRAINT ranking_definition_versions_formula_kind_check
  CHECK (formula_kind IN ('metric','per_90','per_match','team_form','rating'));
