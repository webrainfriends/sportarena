-- Advanced tournament formats (#490 / #577): double elimination, Swiss, pools → knockout, repechage, placement, best-of and aggregate ties,
-- governed redraws, publishing, and safe correction propagation. Everything extends the canonical stages / fixtures; nothing is copied.
-- Additive only: constraints are widened, columns and tables are added, no row is changed except the publish backfill below.

ALTER TABLE event_stages DROP CONSTRAINT IF EXISTS event_stages_kind_check;
ALTER TABLE event_stages ADD CONSTRAINT event_stages_kind_check CHECK (kind IN ('round_robin','knockout','double_elimination','swiss','pools'));
ALTER TABLE event_stages
  ADD COLUMN IF NOT EXISTS published_at    timestamptz,                      -- null = draft: seeds and draw are still editable, spectators see no bracket
  ADD COLUMN IF NOT EXISTS published_by    uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS revision        int NOT NULL DEFAULT 1,           -- bumps on every governed redraw / format revision
  ADD COLUMN IF NOT EXISTS algorithm       text,                             -- e.g. knockout/seed-order@1, swiss/score_group_dutch@1
  ADD COLUMN IF NOT EXISTS draw_seed       text,                             -- persisted randomness so a random draw can be reproduced
  ADD COLUMN IF NOT EXISTS parent_stage_id uuid REFERENCES event_stages;     -- a knockout generated from a pools stage
-- stages that existed before publishing was introduced were live from the start
UPDATE event_stages SET published_at = created_at WHERE published_at IS NULL;

ALTER TABLE fixtures DROP CONSTRAINT IF EXISTS fixtures_round_kind_check;
ALTER TABLE fixtures ADD CONSTRAINT fixtures_round_kind_check CHECK (round_kind IN
  ('group','round_of_32','round_of_16','quarter','semi','final','third_place','winners','losers','grand_final','repechage','placement'));
ALTER TABLE fixtures
  ADD COLUMN IF NOT EXISTS bracket_side text,                 -- winners | losers | grand_final | main | repechage | placement | consolation | pool | swiss
  ADD COLUMN IF NOT EXISTS round_no     int,
  ADD COLUMN IF NOT EXISTS pool         text,
  ADD COLUMN IF NOT EXISTS tie_id       uuid,                  -- the series / aggregate tie this game belongs to (bracket_ties.id)
  ADD COLUMN IF NOT EXISTS leg_no       int,
  ADD COLUMN IF NOT EXISTS leg_swap     boolean NOT NULL DEFAULT false,   -- true: the tie's side B is "home" in this game
  ADD COLUMN IF NOT EXISTS winner_optional boolean NOT NULL DEFAULT false,   -- a leg of an aggregate tie may end level; the tie decides
  ADD COLUMN IF NOT EXISTS conditional  jsonb,                 -- e.g. {"kind":"reset"}: only played if a rule says so
  ADD COLUMN IF NOT EXISTS void_reason  text;                  -- why a cancelled game is not an error: not_required | redrawn | superseded_by_correction
CREATE INDEX IF NOT EXISTS fixtures_tie ON fixtures (tie_id, leg_no) WHERE tie_id IS NOT NULL;

-- A tie of several games (best-of-N series or a multi-leg aggregate). Games are ordinary fixtures; this row records the tie's own state.
CREATE TABLE IF NOT EXISTS bracket_ties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id      uuid NOT NULL REFERENCES event_stages,
  key           text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('best_of','legs')),
  config        jsonb NOT NULL DEFAULT '{}',       -- {best_of:5} | {legs:2, away_goals:false}  (away goals only when explicitly true)
  a_team_id     uuid REFERENCES teams,
  b_team_id     uuid REFERENCES teams,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','needs_decider','decided')),
  winner_team_id uuid REFERENCES teams,
  method        text,                              -- aggregate | away_goals | decider | series
  decided_at    timestamptz,
  win_feeds_fixture_id  uuid REFERENCES fixtures,
  win_feeds_side        text CHECK (win_feeds_side IN ('home','away')),
  lose_feeds_fixture_id uuid REFERENCES fixtures,
  lose_feeds_side       text CHECK (lose_feeds_side IN ('home','away')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stage_id, key)
);

-- Append-only audit of how a stage was drawn and changed: inputs, algorithm, actor, reason and a snapshot of the pairings.
CREATE TABLE IF NOT EXISTS bracket_revisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id   uuid NOT NULL REFERENCES event_stages,
  version    int NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('generated','published','seed_edit','redraw','round_generated','stage_generated','repechage_generated','correction','conflict_resolved','format_revision')),
  reason     text,
  actor_id   uuid REFERENCES users,
  algorithm  text,
  inputs     jsonb NOT NULL DEFAULT '{}',
  snapshot   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bracket_revisions_stage ON bracket_revisions (stage_id, created_at);

-- A corrected result that cannot be applied to a game already started or played: an organiser decision is required (never silent).
CREATE TABLE IF NOT EXISTS bracket_conflicts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  stage_id        uuid REFERENCES event_stages,
  fixture_id      uuid NOT NULL REFERENCES fixtures,     -- the started / played game that now disagrees
  caused_by_fixture_id uuid REFERENCES fixtures,
  side            text NOT NULL CHECK (side IN ('home','away')),
  played_team_id  uuid REFERENCES teams,                 -- who actually took the place
  expected_team_id uuid REFERENCES teams,                -- who the corrected result puts there
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','kept','replayed')),
  resolution_reason text,
  resolved_by     uuid REFERENCES users,
  resolved_at     timestamptz,
  replacement_fixture_id uuid REFERENCES fixtures,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bracket_conflicts_open ON bracket_conflicts (fixture_id, side) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS bracket_conflicts_event ON bracket_conflicts (event_id, status);
