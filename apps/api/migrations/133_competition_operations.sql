-- Season, Division & League administration (issue #576), on top of #476 (comp_*): stages (play-offs), match-week administration, ranked-meet series for
-- sports that are ranked by time / distance / weight / judged score, and a schedule-change history. Additive only: columns and tables are added, a CHECK
-- is WIDENED, nothing is dropped, rewritten or narrowed. No second match, team or score store: play-off games are ordinary `fixtures` linked through
-- comp_fixture_links; a ranked meet is a comp_rounds row whose per-team results (many competitors per meet, so not a two-sided fixture) live in comp_meet_results.
-- Rollback: stop using the capabilities; dropping the columns/tables is a maintainer decision, never automatic.

-- a play-off stage is a division of kind 'playoff' fed from a source division's table (widening the allowed values only)
ALTER TABLE comp_divisions DROP CONSTRAINT IF EXISTS comp_divisions_kind_check;
ALTER TABLE comp_divisions ADD CONSTRAINT comp_divisions_kind_check CHECK (kind IN ('division','conference','pool','category','playoff'));
ALTER TABLE comp_divisions ADD COLUMN IF NOT EXISTS stage_format text NOT NULL DEFAULT 'league' CHECK (stage_format IN ('league','knockout'));
ALTER TABLE comp_divisions ADD COLUMN IF NOT EXISTS source_division_id uuid REFERENCES comp_divisions;

-- match-week administration: a round can be closed once its games are settled; a closed round no longer takes schedule changes
ALTER TABLE comp_rounds ADD COLUMN IF NOT EXISTS window_enforced boolean NOT NULL DEFAULT false;   -- opt-in: a kick-off outside the window then needs an explicit confirmation
ALTER TABLE comp_rounds ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE comp_rounds ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES users;

-- every kick-off change, with the reason (the decision on the fixture only keeps the latest state)
CREATE TABLE IF NOT EXISTS comp_schedule_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id   uuid NOT NULL REFERENCES comp_seasons,
  division_id uuid NOT NULL REFERENCES comp_divisions,
  fixture_id  uuid NOT NULL REFERENCES fixtures,
  action      text NOT NULL CHECK (action IN ('rescheduled','postponed','restored','shifted','moved_round')),
  from_at     timestamptz,
  to_at       timestamptz,
  reason      text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  actor_id    uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comp_schedule_changes_season ON comp_schedule_changes (season_id, created_at);

-- ranked-meet series
CREATE TABLE IF NOT EXISTS comp_meet_results (
  round_id    uuid NOT NULL REFERENCES comp_rounds,
  season_id   uuid NOT NULL REFERENCES comp_seasons,
  division_id uuid NOT NULL REFERENCES comp_divisions,
  team_id     uuid NOT NULL REFERENCES teams,
  value       numeric,                                       -- time (seconds), distance, weight or score as entered; null when only the place is known
  position    int CHECK (position IS NULL OR position >= 1),
  status      text NOT NULL DEFAULT 'finished' CHECK (status IN ('finished','dns','dnf','dq')),
  entered_by  uuid NOT NULL REFERENCES users,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, team_id)
);
CREATE TABLE IF NOT EXISTS comp_meet_result_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id    uuid NOT NULL REFERENCES comp_rounds,
  season_id   uuid NOT NULL REFERENCES comp_seasons,
  results     jsonb NOT NULL,                                -- the full result list as published
  reason      text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_id    uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS comp_schedule_changes_immutable ON comp_schedule_changes;
CREATE TRIGGER comp_schedule_changes_immutable BEFORE UPDATE OR DELETE ON comp_schedule_changes FOR EACH ROW EXECUTE FUNCTION comp_immutable();
DROP TRIGGER IF EXISTS comp_meet_result_log_immutable ON comp_meet_result_log;
CREATE TRIGGER comp_meet_result_log_immutable BEFORE UPDATE OR DELETE ON comp_meet_result_log FOR EACH ROW EXECUTE FUNCTION comp_immutable();
-- a completed or archived season is closed to meet results and schedule history too
DROP TRIGGER IF EXISTS comp_meet_results_closed ON comp_meet_results;
CREATE TRIGGER comp_meet_results_closed BEFORE INSERT OR UPDATE OR DELETE ON comp_meet_results FOR EACH ROW EXECUTE FUNCTION comp_season_closed();
DROP TRIGGER IF EXISTS comp_schedule_changes_closed ON comp_schedule_changes;
CREATE TRIGGER comp_schedule_changes_closed BEFORE INSERT ON comp_schedule_changes FOR EACH ROW EXECUTE FUNCTION comp_season_closed();

-- play-off stage entrants: a team stays a member of its league division (one live membership per season), the stage records who qualified from where
CREATE TABLE IF NOT EXISTS comp_stage_entries (
  division_id        uuid NOT NULL REFERENCES comp_divisions,
  season_id          uuid NOT NULL REFERENCES comp_seasons,
  team_id            uuid NOT NULL REFERENCES teams,
  seed               int  NOT NULL CHECK (seed >= 1),
  source_division_id uuid NOT NULL REFERENCES comp_divisions,
  source_rank        int  NOT NULL CHECK (source_rank >= 1),
  created_by         uuid NOT NULL REFERENCES users,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (division_id, team_id)
);
DROP TRIGGER IF EXISTS comp_stage_entries_immutable ON comp_stage_entries;
CREATE TRIGGER comp_stage_entries_immutable BEFORE UPDATE OR DELETE ON comp_stage_entries FOR EACH ROW EXECUTE FUNCTION comp_immutable();
DROP TRIGGER IF EXISTS comp_stage_entries_closed ON comp_stage_entries;
CREATE TRIGGER comp_stage_entries_closed BEFORE INSERT ON comp_stage_entries FOR EACH ROW EXECUTE FUNCTION comp_season_closed();
