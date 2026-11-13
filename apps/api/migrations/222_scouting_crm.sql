-- Issue #565: Extended scouting CRM — watchlists, scout assignments, evaluation templates,
-- evaluations, side-by-side comparisons, recommendations, and evidence.
-- Extends existing academy_scouting_campaigns infrastructure.

-- Named watchlists (independent of campaigns — for ongoing talent monitoring)
CREATE TABLE IF NOT EXISTS scouting_watchlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  owner_id uuid NOT NULL REFERENCES users,
  name text NOT NULL,
  description_enc text,
  sport_id uuid REFERENCES sports,
  season text,
  shared_with_team boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sw_org ON scouting_watchlists (org_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS sw_owner ON scouting_watchlists (owner_id) WHERE archived_at IS NULL;

-- Athletes/prospects on a watchlist
CREATE TABLE IF NOT EXISTS scouting_watchlist_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id uuid NOT NULL REFERENCES scouting_watchlists,
  user_id uuid REFERENCES users,          -- existing platform user, or null for external
  external_name text,                     -- for scouted prospects not yet on platform
  external_club text,
  position text,
  birth_year int,
  priority text NOT NULL DEFAULT 'watch' CHECK (priority IN ('hot','warm','watch','passed')),
  notes_enc text,
  added_by uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS swm_watchlist ON scouting_watchlist_members (watchlist_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS swm_user ON scouting_watchlist_members (user_id) WHERE user_id IS NOT NULL AND removed_at IS NULL;

-- Assign a scout to monitor a specific athlete for a campaign or watchlist
CREATE TABLE IF NOT EXISTS scouting_scout_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scout_id uuid NOT NULL REFERENCES users,
  watchlist_member_id uuid REFERENCES scouting_watchlist_members,
  campaign_entry_id uuid REFERENCES academy_campaign_entries,
  objective_enc text,
  due_by date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  assigned_by uuid NOT NULL REFERENCES users,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ssa_target_check CHECK (
    (watchlist_member_id IS NOT NULL)::int + (campaign_entry_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX IF NOT EXISTS ssa_scout ON scouting_scout_assignments (scout_id) WHERE status = 'active';

-- Reusable evaluation templates (rubric with criteria and weights)
CREATE TABLE IF NOT EXISTS scouting_evaluation_tpls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  sport_id uuid REFERENCES sports,
  name text NOT NULL,
  criteria jsonb NOT NULL DEFAULT '[]',  -- [{id, label, weight, scale, description}]
  max_score numeric(6,2) NOT NULL DEFAULT 100,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS set_org ON scouting_evaluation_tpls (org_id) WHERE archived_at IS NULL;

-- Completed evaluations against a template
CREATE TABLE IF NOT EXISTS scouting_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES scouting_evaluation_tpls,
  campaign_entry_id uuid REFERENCES academy_campaign_entries,
  watchlist_member_id uuid REFERENCES scouting_watchlist_members,
  evaluator_id uuid NOT NULL REFERENCES users,
  scores jsonb NOT NULL DEFAULT '{}',    -- {criterion_id: score}
  total_score numeric(6,2),
  notes_enc text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS se_template ON scouting_evaluations (template_id);
CREATE INDEX IF NOT EXISTS se_evaluator ON scouting_evaluations (evaluator_id);
CREATE INDEX IF NOT EXISTS se_entry ON scouting_evaluations (campaign_entry_id) WHERE campaign_entry_id IS NOT NULL;

-- Side-by-side athlete comparison sets
CREATE TABLE IF NOT EXISTS scouting_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  name text NOT NULL,
  campaign_id uuid REFERENCES academy_scouting_campaigns,
  athlete_ids uuid[] NOT NULL,            -- array of user/member ids to compare
  criteria jsonb NOT NULL DEFAULT '[]',  -- subset of criteria to compare on
  notes_enc text,
  created_by uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sc_org ON scouting_comparisons (org_id) WHERE archived_at IS NULL;

-- Formal recommendations with pipeline outcome
CREATE TABLE IF NOT EXISTS scouting_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_entry_id uuid REFERENCES academy_campaign_entries,
  watchlist_member_id uuid REFERENCES scouting_watchlist_members,
  author_id uuid NOT NULL REFERENCES users,
  decision text NOT NULL CHECK (decision IN ('enrol','reserve','monitor','decline')),
  confidence int NOT NULL CHECK (confidence BETWEEN 1 AND 10),
  notes_enc text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','declined','superseded')),
  reviewed_by uuid REFERENCES users,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sr_entry ON scouting_recommendations (campaign_entry_id) WHERE campaign_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sr_author ON scouting_recommendations (author_id);

-- Evidence items attached to a recommendation
CREATE TABLE IF NOT EXISTS scouting_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id uuid NOT NULL REFERENCES scouting_recommendations,
  kind text NOT NULL CHECK (kind IN ('video','clip','document','stat','note','external')),
  ref_id uuid,                   -- video_clip_sessions.id / passport_videos.id / etc.
  external_url text,             -- for external links
  label text,
  notes_enc text,
  added_by uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sevid_rec ON scouting_evidence (recommendation_id) WHERE removed_at IS NULL;
