-- Issue #1024: verified, moderated referee reputation — testimony and visibility prefs
BEGIN;

CREATE TABLE IF NOT EXISTS off_reputation_visibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  dimension text NOT NULL CHECK (dimension IN (
    'completed_matches','on_time_rate','feedback_averages',
    'assessments','cpd','grade','testimony'
  )),
  visibility text NOT NULL DEFAULT 'organiser_only'
    CHECK (visibility IN ('public','organiser_only','private')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT off_rep_vis_uniq UNIQUE (user_id, dimension)
);
CREATE INDEX IF NOT EXISTS off_rep_vis_user_idx ON off_reputation_visibility(user_id);

CREATE TABLE IF NOT EXISTS off_testimony (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  author_user_id uuid NOT NULL REFERENCES users(id),
  sport_id uuid REFERENCES sports(id),
  body_enc text NOT NULL,
  author_grade_snapshot jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending_dispute'
    CHECK (status IN ('pending_dispute','active','hidden','archived')),
  dispute_window_ends_at timestamptz NOT NULL,
  published_at timestamptz,
  moderation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT off_testimony_no_self CHECK (subject_user_id <> author_user_id)
);
CREATE INDEX IF NOT EXISTS off_testimony_subject_idx ON off_testimony(subject_user_id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS off_testimony_author_idx ON off_testimony(author_user_id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS off_testimony_window_idx ON off_testimony(dispute_window_ends_at)
  WHERE status = 'pending_dispute';

CREATE TABLE IF NOT EXISTS off_testimony_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  testimony_id uuid NOT NULL REFERENCES off_testimony(id),
  disputing_user_id uuid NOT NULL REFERENCES users(id),
  reason_enc text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','upheld','dismissed')),
  moderator_id uuid REFERENCES users(id),
  moderator_note text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT off_testimony_dispute_uniq UNIQUE (testimony_id, disputing_user_id)
);
CREATE INDEX IF NOT EXISTS off_testimony_dispute_status_idx ON off_testimony_disputes(status)
  WHERE status = 'open';

COMMIT;
