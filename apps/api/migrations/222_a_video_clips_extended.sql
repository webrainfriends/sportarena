-- Issue #565: Extended clip sessions — trim, group, athlete assignment with coaching notes.

-- A trim session: a named clip carved from a source video
CREATE TABLE IF NOT EXISTS video_clip_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_video_id uuid NOT NULL REFERENCES passport_videos,
  org_id uuid NOT NULL REFERENCES organisations,
  title text NOT NULL,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  notes_enc text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','archived')),
  created_by uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vcs_range_check CHECK (end_ms > start_ms)
);
CREATE INDEX IF NOT EXISTS vcs_org ON video_clip_sessions (org_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS vcs_video ON video_clip_sessions (source_video_id) WHERE archived_at IS NULL;

-- Assign a clip to an athlete with a coaching note and review state
CREATE TABLE IF NOT EXISTS video_clip_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_session_id uuid NOT NULL REFERENCES video_clip_sessions,
  athlete_id uuid NOT NULL REFERENCES users,
  coaching_note_enc text,
  review_state text NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','viewed','understood','question','resolved')),
  first_viewed_at timestamptz,
  responded_at timestamptz,
  revoked_at timestamptz,
  assigned_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vca_clip_athlete ON video_clip_assignments (clip_session_id, athlete_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS vca_athlete ON video_clip_assignments (athlete_id) WHERE revoked_at IS NULL;

-- Named clip groups (e.g. "Defensive Shape Week 3", "Set Piece Review")
CREATE TABLE IF NOT EXISTS video_clip_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  name text NOT NULL,
  description_enc text,
  sport_id uuid REFERENCES sports,
  created_by uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcg_org ON video_clip_groups (org_id) WHERE archived_at IS NULL;

-- Membership of clips in groups
CREATE TABLE IF NOT EXISTS video_clip_group_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES video_clip_groups,
  clip_session_id uuid NOT NULL REFERENCES video_clip_sessions,
  position int NOT NULL DEFAULT 0,
  added_by uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vcgi_group_clip ON video_clip_group_items (group_id, clip_session_id) WHERE removed_at IS NULL;
