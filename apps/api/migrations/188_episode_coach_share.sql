-- Episode coach share: athlete or clinician opts a team in to see minimal availability info (issue #584).
-- No clinical detail is ever stored in or derived from this table; only the allowed fields from
-- injury_rtp_approvals (load_restrictions, expected_return) are surfaced to coaches.
-- Additive only. Rollback: deploy previous build.

CREATE TABLE IF NOT EXISTS injury_episode_coach_shares (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id           uuid NOT NULL REFERENCES injury_episodes(id),
  team_id              uuid NOT NULL REFERENCES teams(id),
  shared_by            uuid NOT NULL REFERENCES users(id),
  show_expected_return boolean NOT NULL DEFAULT true,
  show_restrictions    boolean NOT NULL DEFAULT false,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS injury_episode_coach_shares_live ON injury_episode_coach_shares
  (episode_id, team_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS injury_episode_coach_shares_team ON injury_episode_coach_shares
  (team_id) WHERE revoked_at IS NULL;
