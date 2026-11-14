-- Issue #1194: Elite Player Intelligence & Comparison Studio — Stage-Gated Team Selection
-- Selection campaign state machine, approval hierarchy, dossiers, scoring, and roster publication.

CREATE TABLE IF NOT EXISTS selection_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  team_id uuid REFERENCES teams,
  sport_id uuid REFERENCES sports,
  season text,
  purpose text NOT NULL CHECK (purpose IN ('academy_admissions','season_roster','matchday_xi','tournament_squad','relay_team','trial_selection','development_squad','emergency_cover','cup_squad')),
  name text NOT NULL,
  description_enc text,
  formation text,
  min_squad_size int,
  max_squad_size int,
  max_reserve_size int,
  age_bracket_min int,
  age_bracket_max int,
  eligibility_constraints jsonb NOT NULL DEFAULT '{}',
  stage int NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 11),
  policy_version_id uuid,
  proposer_id uuid NOT NULL REFERENCES users,
  nomination_deadline date,
  assessment_deadline date,
  decision_deadline date,
  publication_deadline date,
  approval_config jsonb NOT NULL DEFAULT '{}',
  sod_exception boolean NOT NULL DEFAULT false,
  committee_quorum int,
  voting_rule text NOT NULL DEFAULT 'majority' CHECK (voting_rule IN ('majority','unanimous','supermajority')),
  locked_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selc_org ON selection_campaigns (org_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS selc_team ON selection_campaigns (team_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS selc_stage ON selection_campaigns (stage) WHERE archived_at IS NULL;

-- Versioned policy/criteria snapshot locked at campaign start
CREATE TABLE IF NOT EXISTS selection_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  version int NOT NULL DEFAULT 1,
  rubric_snapshot jsonb NOT NULL DEFAULT '{}',
  weight_snapshot jsonb NOT NULL DEFAULT '{}',
  eligibility_rules jsonb NOT NULL DEFAULT '{}',
  min_evidence_threshold int NOT NULL DEFAULT 1,
  confidence_penalty_pct numeric(5,2) NOT NULL DEFAULT 20,
  locked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selpv_campaign ON selection_policy_versions (campaign_id);

-- Candidate nominations
CREATE TABLE IF NOT EXISTS selection_nominations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  candidate_id uuid NOT NULL REFERENCES users,
  nominated_by uuid NOT NULL REFERENCES users,
  source text NOT NULL CHECK (source IN ('manual','roster','watchlist','scouting','application','external')),
  watchlist_member_id uuid REFERENCES scouting_watchlist_members,
  position text,
  jersey_preference int,
  consent_status text NOT NULL DEFAULT 'pending' CHECK (consent_status IN ('pending','granted','denied','guardian_required','guardian_granted')),
  eligibility_status text NOT NULL DEFAULT 'unchecked' CHECK (eligibility_status IN ('unchecked','eligible','ineligible','provisional','expired')),
  stage text NOT NULL DEFAULT 'nominated' CHECK (stage IN ('nominated','eligibility_check','shortlisted','assessing','comparison','recommended','approved','declined','withdrawn','reserve','development')),
  notes_enc text,
  declined_reason text,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS seln_campaign ON selection_nominations (campaign_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS seln_candidate ON selection_nominations (candidate_id);

-- Per-nomination eligibility checks
CREATE TABLE IF NOT EXISTS selection_eligibility_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nomination_id uuid NOT NULL REFERENCES selection_nominations,
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  check_type text NOT NULL CHECK (check_type IN ('age','registration','clearance','guardian_consent','federation_clearance','transfer_window','visa','medical_clearance','academic','para_classification','safeguarding')),
  result text NOT NULL CHECK (result IN ('pass','fail','warning','expired','pending')),
  reason text,
  evidence_ref uuid,
  checked_at timestamptz NOT NULL DEFAULT now(),
  checker_id uuid NOT NULL REFERENCES users,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS selec_nomination ON selection_eligibility_checks (nomination_id);
CREATE INDEX IF NOT EXISTS selec_campaign ON selection_eligibility_checks (campaign_id);

-- Structured assessment per candidate per campaign
CREATE TABLE IF NOT EXISTS selection_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  nomination_id uuid NOT NULL REFERENCES selection_nominations,
  assessor_id uuid NOT NULL REFERENCES users,
  rubric_version_id uuid NOT NULL REFERENCES selection_policy_versions,
  scores jsonb NOT NULL DEFAULT '{}',
  total_score numeric(8,3),
  confidence_score numeric(5,2),
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  position text,
  observations_enc text,
  recommended_role text CHECK (recommended_role IN ('starter','reserve','development','exclude')),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sela_campaign ON selection_assessments (campaign_id);
CREATE INDEX IF NOT EXISTS sela_nomination ON selection_assessments (nomination_id);
CREATE INDEX IF NOT EXISTS sela_assessor ON selection_assessments (assessor_id);

-- Comparison scenarios saved in comparison lab
CREATE TABLE IF NOT EXISTS selection_comparison_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  analyst_id uuid NOT NULL REFERENCES users,
  name text,
  candidate_ids uuid[] NOT NULL,
  weights jsonb NOT NULL DEFAULT '{}',
  result_snapshot jsonb NOT NULL DEFAULT '{}',
  radar_snapshot jsonb NOT NULL DEFAULT '{}',
  sensitivity_analysis jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selcs_campaign ON selection_comparison_scenarios (campaign_id) WHERE archived_at IS NULL;

-- Probabilistic forecast runs
CREATE TABLE IF NOT EXISTS selection_forecast_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  model_version text NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}',
  result jsonb NOT NULL DEFAULT '{}',
  uncertainty jsonb NOT NULL DEFAULT '{}',
  feature_contributions jsonb NOT NULL DEFAULT '{}',
  insufficient_data boolean NOT NULL DEFAULT false,
  missing_data_pct numeric(5,2),
  run_by uuid NOT NULL REFERENCES users,
  run_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selfr_campaign ON selection_forecast_runs (campaign_id);

-- Coach's formal recommendation
CREATE TABLE IF NOT EXISTS selection_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  proposer_id uuid NOT NULL REFERENCES users,
  version int NOT NULL DEFAULT 1,
  squad_snapshot jsonb NOT NULL DEFAULT '{}',
  starters jsonb NOT NULL DEFAULT '[]',
  reserves jsonb NOT NULL DEFAULT '[]',
  development_list jsonb NOT NULL DEFAULT '[]',
  watchlist jsonb NOT NULL DEFAULT '[]',
  excluded jsonb NOT NULL DEFAULT '[]',
  formation text,
  tactical_notes_enc text,
  rationale jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','returned','superseded')),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selrec_campaign ON selection_recommendations (campaign_id);

-- Committee member reviews
CREATE TABLE IF NOT EXISTS selection_committee_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  reviewer_id uuid NOT NULL REFERENCES users,
  comment_enc text,
  vote text CHECK (vote IN ('approve','challenge','abstain')),
  conflict_declared boolean NOT NULL DEFAULT false,
  conflict_note_enc text,
  dissent_note_enc text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selcr_campaign ON selection_committee_reviews (campaign_id);

-- Configured approval route steps
CREATE TABLE IF NOT EXISTS selection_approval_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  step_order int NOT NULL,
  approver_role text NOT NULL CHECK (approver_role IN ('org_owner','club_owner','team_manager','head_coach','academy_director','federation_rep')),
  approver_id uuid REFERENCES users,
  delegate_id uuid REFERENCES users,
  is_required boolean NOT NULL DEFAULT true,
  sla_hours int NOT NULL DEFAULT 72,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','skipped','delegated')),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selar_campaign ON selection_approval_routes (campaign_id);

-- Individual approval decisions (immutable insert-only)
CREATE TABLE IF NOT EXISTS selection_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES selection_approval_routes,
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  recommendation_id uuid NOT NULL REFERENCES selection_recommendations,
  approver_id uuid NOT NULL REFERENCES users,
  decision text NOT NULL CHECK (decision IN ('approve','reject','return','abstain')),
  reason_enc text NOT NULL,
  conditions_enc text,
  pack_version int,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selad_campaign ON selection_approval_decisions (campaign_id);
CREATE INDEX IF NOT EXISTS selad_route ON selection_approval_decisions (route_id);

-- Final roster publications (idempotent per campaign)
CREATE TABLE IF NOT EXISTS selection_roster_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL UNIQUE,
  approval_decision_id uuid NOT NULL REFERENCES selection_approval_decisions,
  roster_snapshot jsonb NOT NULL DEFAULT '{}',
  eligibility_recheck_snapshot jsonb NOT NULL DEFAULT '{}',
  eligibility_recheck_at timestamptz,
  team_squad_write_at timestamptz,
  athlete_notified_at timestamptz,
  guardian_notified_at timestamptz,
  signed_pack_ref text,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selrp_campaign ON selection_roster_publications (campaign_id);

-- Athlete appeals after publication
CREATE TABLE IF NOT EXISTS selection_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  appellant_id uuid NOT NULL REFERENCES users,
  grounds_enc text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','upheld','dismissed','withdrawn')),
  reviewer_id uuid REFERENCES users,
  reviewer_note_enc text,
  resolved_at timestamptz,
  appeal_window_closes_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selapp_campaign ON selection_appeals (campaign_id);
CREATE INDEX IF NOT EXISTS selapp_appellant ON selection_appeals (appellant_id);

-- Immutable audit event log
CREATE TABLE IF NOT EXISTS selection_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES selection_campaigns,
  actor_id uuid NOT NULL REFERENCES users,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  ip_address inet,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selaudit_campaign ON selection_audit_events (campaign_id);
CREATE INDEX IF NOT EXISTS selaudit_actor ON selection_audit_events (actor_id);
CREATE INDEX IF NOT EXISTS selaudit_type ON selection_audit_events (event_type);
