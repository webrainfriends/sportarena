-- Issue #565: Opponent analysis workspace — profiles, recent games, key players,
-- set pieces, curated playlists, and append-only audit log.

CREATE TABLE IF NOT EXISTS opponent_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  opponent_team_id uuid REFERENCES teams,     -- nullable for external teams
  opponent_name text,                          -- for teams not on platform
  season text NOT NULL,
  analyst_id uuid NOT NULL REFERENCES users,
  formation text,                              -- e.g. '4-3-3'
  style_notes_enc text,
  general_tendencies_enc text,
  strengths_enc text,
  weaknesses_enc text,
  archived_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS op_org ON opponent_profiles (org_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS op_season ON opponent_profiles (org_id, season) WHERE archived_at IS NULL;

-- Recent game records for the opponent
CREATE TABLE IF NOT EXISTS opponent_games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES opponent_profiles,
  fixture_id uuid REFERENCES fixtures,         -- nullable for manually entered games
  opponent_name text,                          -- the opponent's opponent in this game
  match_date date,
  result text CHECK (result IN ('W','D','L')),
  score_for int,
  score_against int,
  formation_used text,
  notes_enc text,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS og_profile ON opponent_games (profile_id);

-- Key players to watch
CREATE TABLE IF NOT EXISTS opponent_key_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES opponent_profiles,
  user_id uuid REFERENCES users,               -- nullable for external players
  display_name text NOT NULL,
  position text,
  shirt_number int,
  threat_level text NOT NULL DEFAULT 'medium' CHECK (threat_level IN ('high','medium','low')),
  role_notes_enc text,
  stats_snapshot jsonb,
  removed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS okp_profile ON opponent_key_players (profile_id) WHERE removed_at IS NULL;

-- Set piece schemes
CREATE TABLE IF NOT EXISTS opponent_set_pieces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES opponent_profiles,
  kind text NOT NULL CHECK (kind IN ('corner_attack','corner_defence','freekick_attack','freekick_defence','throw_in','penalty','other')),
  side text CHECK (side IN ('left','right','central','both')),
  pattern_notes_enc text NOT NULL,
  clip_session_id uuid REFERENCES video_clip_sessions,  -- supporting clip
  archived_at timestamptz,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS osp_profile ON opponent_set_pieces (profile_id) WHERE archived_at IS NULL;

-- Curated video playlists for opponent analysis
CREATE TABLE IF NOT EXISTS opponent_playlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES opponent_profiles,
  name text NOT NULL,
  description_enc text,
  clip_ids uuid[] NOT NULL DEFAULT '{}',      -- ordered array of video_clip_sessions.id
  archived_at timestamptz,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opl_profile ON opponent_playlists (profile_id) WHERE archived_at IS NULL;

-- Append-only audit log for opponent analysis (privacy: notes are encrypted above)
CREATE TABLE IF NOT EXISTS opponent_analysis_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES opponent_profiles,
  actor_id uuid NOT NULL REFERENCES users,
  action text NOT NULL,
  entity_kind text NOT NULL,
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oaa_profile ON opponent_analysis_audit (profile_id);
