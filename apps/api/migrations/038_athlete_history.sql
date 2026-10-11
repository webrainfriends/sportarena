-- Unified athlete history (#100). Official games/fixtures are PROJECTED into My Sports at read time — nothing is copied into
-- player_matches. Additive only: no existing row is changed or removed.
--
-- player_match_links: an athlete-confirmed "this match I logged is that official match" reconciliation (counts once; the official
--   facts win, the athlete keeps their note/rating). Soft-removed with removed_at, never deleted. player_match_id deliberately has
--   no FK so deleting a manual match / sport card can never be blocked or cascade through this table.
-- player_match_notes: the athlete's private rating/notes on an official match; keyed by source so it never touches the official record.

CREATE TABLE IF NOT EXISTS player_match_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users,
  player_match_id uuid NOT NULL,
  source_type     text NOT NULL CHECK (source_type IN ('game','fixture')),
  source_id       uuid NOT NULL,
  match_method    text NOT NULL DEFAULT 'user_confirmed' CHECK (match_method IN ('explicit','auto_exact','user_confirmed')),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS player_match_links_one_per_match  ON player_match_links (player_match_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_match_links_one_per_source ON player_match_links (user_id, source_type, source_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS player_match_notes (
  user_id     uuid NOT NULL REFERENCES users,
  source_type text NOT NULL CHECK (source_type IN ('game','fixture')),
  source_id   uuid NOT NULL,
  rating      numeric(3,1) CHECK (rating BETWEEN 0 AND 10),
  notes       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_type, source_id)
);

-- the projection filters by person early
CREATE INDEX IF NOT EXISTS game_participants_user ON game_participants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS team_squads_fixture_user ON team_squads (fixture_id, user_id);
CREATE INDEX IF NOT EXISTS associations_user_target ON associations (user_id, target_type, target_id);
