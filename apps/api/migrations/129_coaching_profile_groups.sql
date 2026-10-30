-- Coach Performance Studio completion (issue #580). Additive only: nothing is dropped, rewritten or narrowed.

-- Coaching philosophy lives on the one coach profile (no second profile). It is part of the coach's public statement, like the headline.
ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS philosophy text CHECK (philosophy IS NULL OR char_length(philosophy) <= 1500),
  ADD COLUMN IF NOT EXISTS coaching_styles text[] NOT NULL DEFAULT '{}';

-- Saved player groups: a named, reusable set of people the coach already coaches (for example "U14 defenders" or "Batters").
-- A group is a convenience for building a session roster; it grants no access. Every use re-checks each person's current relationship.
CREATE TABLE IF NOT EXISTS coaching_player_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES users,
  team_id     uuid REFERENCES teams,
  sport_id    uuid REFERENCES sports,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  row_version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coaching_player_groups_name ON coaching_player_groups (coach_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS coaching_player_groups_coach ON coaching_player_groups (coach_id, name, id) WHERE archived_at IS NULL;

-- Members are kept when removed (removed_at), never deleted.
CREATE TABLE IF NOT EXISTS coaching_player_group_members (
  group_id   uuid NOT NULL REFERENCES coaching_player_groups,
  athlete_id uuid NOT NULL REFERENCES users,
  added_at   timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (group_id, athlete_id)
);
CREATE INDEX IF NOT EXISTS coaching_player_group_members_athlete ON coaching_player_group_members (athlete_id) WHERE removed_at IS NULL;
