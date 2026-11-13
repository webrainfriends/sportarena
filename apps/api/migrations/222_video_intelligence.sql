-- Video Intelligence & Tactical Analysis (issue #581)
-- Additive only: no DROP, no ON DELETE CASCADE on user data, no TRUNCATE.

CREATE TABLE IF NOT EXISTS video_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES passport_videos(id),
  author_id uuid NOT NULL REFERENCES users(id),
  parent_id uuid REFERENCES video_annotations(id),
  timestamp_ms int NOT NULL,
  end_timestamp_ms int,
  text_enc text,
  drawing_data jsonb,
  tactical_category text CHECK (tactical_category IN (
    'attacking','defending','set_piece','transition','pressing','shape',
    'individual_error','individual_excellence','fitness','other'
  )),
  ai_generated boolean NOT NULL DEFAULT false,
  ai_model text,
  ai_inference_label text,
  ai_confidence numeric(4,3),
  confirmed_at timestamptz,
  confirmed_by_id uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolved_by_id uuid REFERENCES users(id),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_annotations_video_removed_ts ON video_annotations(video_id, removed_at, timestamp_ms);
CREATE INDEX IF NOT EXISTS video_annotations_parent ON video_annotations(video_id, parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS video_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES passport_videos(id),
  assignee_id uuid NOT NULL REFERENCES users(id),
  assigned_by_id uuid NOT NULL REFERENCES users(id),
  message_enc text,
  context_start_ms int,
  context_end_ms int,
  tactical_category text,
  status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('draft','sent','seen','acknowledged','responded','dismissed')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  acknowledged_at timestamptz,
  athlete_response_enc text,
  response_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(video_id, assignee_id, assigned_by_id, context_start_ms)
);
CREATE INDEX IF NOT EXISTS video_assignments_assignee ON video_assignments(assignee_id, status, archived_at);
CREATE INDEX IF NOT EXISTS video_assignments_video ON video_assignments(video_id);

CREATE TABLE IF NOT EXISTS video_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  video_a_id uuid NOT NULL REFERENCES passport_videos(id),
  start_ms_a int NOT NULL DEFAULT 0,
  end_ms_a int,
  video_b_id uuid NOT NULL REFERENCES passport_videos(id),
  start_ms_b int NOT NULL DEFAULT 0,
  end_ms_b int,
  notes_enc text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_comparisons_creator ON video_comparisons(created_by_id, archived_at);

CREATE TABLE IF NOT EXISTS tactical_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  sport_id uuid REFERENCES sports(id),
  event_id uuid REFERENCES events(id),
  fixture_id uuid REFERENCES fixtures(id),
  pitch_template text NOT NULL DEFAULT 'full_pitch'
    CHECK (pitch_template IN (
      'full_pitch','half_pitch','penalty_area',
      'basketball_full','basketball_half','tennis_full',
      'rugby_full','blank'
    )),
  version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tactical_boards_owner ON tactical_boards(owner_id, archived_at);

CREATE TABLE IF NOT EXISTS tactical_board_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES tactical_boards(id),
  kind text NOT NULL CHECK (kind IN ('player','marker','arrow','zone','text','line')),
  position jsonb NOT NULL,
  style jsonb,
  label text,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tactical_board_items_board ON tactical_board_items(board_id, removed_at);

CREATE TABLE IF NOT EXISTS tactical_board_video_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES tactical_boards(id),
  video_id uuid NOT NULL REFERENCES passport_videos(id),
  annotation_id uuid REFERENCES video_annotations(id),
  timestamp_ms int NOT NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(board_id, video_id, timestamp_ms)
);

CREATE TABLE IF NOT EXISTS video_ai_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES passport_videos(id),
  annotation_id uuid REFERENCES video_annotations(id),
  timestamp_ms int,
  tag_key text NOT NULL,
  tag_value text NOT NULL,
  model_id text NOT NULL,
  inference_label text NOT NULL,
  confidence numeric(4,3),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected','superseded')),
  confirmed_at timestamptz,
  confirmed_by_id uuid REFERENCES users(id),
  rejected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_ai_tags_video_status ON video_ai_tags(video_id, status);
