-- PS-28: Governed adaptive athlete performance insights and coach review for para-sport.
-- Additive only. No existing tables are dropped, truncated or narrowed.

-- Sanctioned metric catalog per sport / discipline / competition class.
-- Governs which metrics may be tracked, their provenance tier, and cohort eligibility.
CREATE TABLE IF NOT EXISTS para_metric_catalog (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_key                    TEXT NOT NULL,
  discipline_key               TEXT,
  class_code                   TEXT,            -- NULL = applies to all classes in this sport
  metric_key                   TEXT NOT NULL,
  display_name                 TEXT NOT NULL,
  unit                         TEXT,
  provenance                   TEXT NOT NULL
    CHECK (provenance IN ('official_results','coach_logged','self_reported','wearable')),
  metric_tier                  TEXT NOT NULL DEFAULT 'factual'
    CHECK (metric_tier IN ('factual','heuristic','clinician_only')),
  completeness_note            TEXT,
  requires_consent             BOOLEAN NOT NULL DEFAULT TRUE,
  clinician_only               BOOLEAN NOT NULL DEFAULT FALSE,
  governing_body_allows_cohort BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sport_key, discipline_key, class_code, metric_key)
);

COMMENT ON TABLE para_metric_catalog IS
  'Sanctioned performance metrics per para-sport / class. '
  'Governs what may be tracked, its provenance tier (factual/heuristic/clinician_only) and whether cohort benchmarks are permitted.';

-- Seed: wheelchair basketball (IWBF classes)
INSERT INTO para_metric_catalog (sport_key, class_code, metric_key, display_name, unit, provenance, metric_tier, completeness_note, requires_consent, governing_body_allows_cohort) VALUES
  ('wheelchair_basketball', 'IWBF_1.0', 'shooting_percentage',      'Shooting %',                '%',   'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_1.0', 'rebound_rate',             'Rebounds per game',         NULL,  'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_1.0', 'assist_turnover_ratio',    'Assist / Turnover ratio',   NULL,  'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_1.0', 'burst_frequency',          'Propulsion burst frequency','Hz',  'wearable',         'heuristic',  'Device-dependent; normalise to session duration.', TRUE, FALSE),
  ('wheelchair_basketball', 'IWBF_2.0', 'shooting_percentage',      'Shooting %',                '%',   'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_2.0', 'rebound_rate',             'Rebounds per game',         NULL,  'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_2.0', 'assist_turnover_ratio',    'Assist / Turnover ratio',   NULL,  'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_2.0', 'burst_frequency',          'Propulsion burst frequency','Hz',  'wearable',         'heuristic',  'Device-dependent; normalise to session duration.', TRUE, FALSE),
  ('wheelchair_basketball', 'IWBF_3.0', 'shooting_percentage',      'Shooting %',                '%',   'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_3.0', 'rebound_rate',             'Rebounds per game',         NULL,  'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_3.0', 'assist_turnover_ratio',    'Assist / Turnover ratio',   NULL,  'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_4.0', 'shooting_percentage',      'Shooting %',                '%',   'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_4.0', 'rebound_rate',             'Rebounds per game',         NULL,  'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_4.5', 'shooting_percentage',      'Shooting %',                '%',   'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_4.5', 'rebound_rate',             'Rebounds per game',         NULL,  'official_results', 'factual',    NULL, TRUE, TRUE),
  ('wheelchair_basketball', 'IWBF_4.5', 'assist_turnover_ratio',    'Assist / Turnover ratio',   NULL,  'official_results', 'factual',    NULL, TRUE, TRUE)
ON CONFLICT (sport_key, discipline_key, class_code, metric_key) DO NOTHING;

-- Seed: para swimming (IPC S-classes)
INSERT INTO para_metric_catalog (sport_key, class_code, metric_key, display_name, unit, provenance, metric_tier, completeness_note, requires_consent, governing_body_allows_cohort) VALUES
  ('para_swimming', 'IPC_S6',  '50m_split_time',         '50 m split time',      's',  'official_results', 'factual',   NULL, TRUE, TRUE),
  ('para_swimming', 'IPC_S6',  'stroke_rate',            'Stroke rate',          'spm','coach_logged',     'factual',   NULL, TRUE, TRUE),
  ('para_swimming', 'IPC_S6',  'turn_efficiency_index',  'Turn efficiency index', NULL, 'coach_logged',     'heuristic', 'Composite of push-off and glide; definition varies by coach.', TRUE, FALSE),
  ('para_swimming', 'IPC_S6',  'race_pace_variance',     'Race pace variance',   '%',  'coach_logged',     'heuristic', NULL, TRUE, FALSE),
  ('para_swimming', 'IPC_S6',  'perceived_exertion',     'Perceived exertion',   NULL, 'self_reported',    'factual',   NULL, TRUE, FALSE),
  ('para_swimming', 'IPC_S8',  '50m_split_time',         '50 m split time',      's',  'official_results', 'factual',   NULL, TRUE, TRUE),
  ('para_swimming', 'IPC_S8',  'stroke_rate',            'Stroke rate',          'spm','coach_logged',     'factual',   NULL, TRUE, TRUE),
  ('para_swimming', 'IPC_S10', '50m_split_time',         '50 m split time',      's',  'official_results', 'factual',   NULL, TRUE, TRUE),
  ('para_swimming', 'IPC_S10', 'stroke_rate',            'Stroke rate',          'spm','coach_logged',     'factual',   NULL, TRUE, TRUE)
ON CONFLICT (sport_key, discipline_key, class_code, metric_key) DO NOTHING;

-- Seed: para athletics (IPC T/F classes)
INSERT INTO para_metric_catalog (sport_key, class_code, metric_key, display_name, unit, provenance, metric_tier, completeness_note, requires_consent, governing_body_allows_cohort) VALUES
  ('para_athletics', 'IPC_T54', 'sprint_time_100m',   '100 m time',          's',  'official_results', 'factual', NULL, TRUE, TRUE),
  ('para_athletics', 'IPC_T54', 'sprint_time_400m',   '400 m time',          's',  'official_results', 'factual', NULL, TRUE, TRUE),
  ('para_athletics', 'IPC_F46', 'throw_distance_m',   'Throw distance',      'm',  'official_results', 'factual', NULL, TRUE, TRUE),
  ('para_athletics', 'IPC_F46', 'flight_phase_ratio',  'Flight phase ratio',  NULL, 'wearable',         'heuristic','Requires calibrated IMU; definition varies.', TRUE, FALSE),
  ('para_athletics', 'IPC_F33', 'throw_distance_m',   'Throw distance',      'm',  'official_results', 'factual', NULL, TRUE, TRUE)
ON CONFLICT (sport_key, discipline_key, class_code, metric_key) DO NOTHING;

-- Para performance insights: AI-drafted by coach, governed review lifecycle, athlete sees only published rows.
CREATE TABLE IF NOT EXISTS para_insights (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id            UUID NOT NULL REFERENCES users(id),
  coach_id              UUID REFERENCES users(id),
  sport_key             TEXT NOT NULL,
  discipline_key        TEXT,
  class_code            TEXT NOT NULL,
  class_version_id      UUID,            -- frozen reference to para class version at draft time
  insight_type          TEXT NOT NULL
    CHECK (insight_type IN ('trend','plateau','milestone','regression','training_recommendation')),
  metric_keys           TEXT[] NOT NULL,
  metric_resolutions    JSONB NOT NULL DEFAULT '{}',
    -- {metric_key: 'approved'|'rejected'|'pending'}
  source_refs           JSONB NOT NULL DEFAULT '[]',
    -- [{type:'official_results'|'coach_logged'|'self_reported'|'wearable', record_id, label}]
  ai_draft              JSONB NOT NULL,
    -- {summary, detail, confidence:'high'|'medium'|'low', limitations, insufficient_data:bool}
  annotation_tags       TEXT[],
    -- subset of: accurate needs_context clinical_concern outstanding_progress revise
  coach_annotation_enc  TEXT,            -- field-level encrypted via src/crypto.js
  coach_decision        TEXT
    CHECK (coach_decision IN ('approved','rejected','modified') OR coach_decision IS NULL),
  coach_reviewed_at     TIMESTAMPTZ,
  review_due_at         TIMESTAMPTZ,
  challenge_note        TEXT,
  challenge_raised_at   TIMESTAMPTZ,
  challenge_resolved_at TIMESTAMPTZ,
  challenge_resolved_by UUID REFERENCES users(id),
  challenge_resolution  TEXT
    CHECK (challenge_resolution IN ('addressed','updated_insight','referred_to_clinician') OR challenge_resolution IS NULL),
  bias_flag             BOOLEAN NOT NULL DEFAULT FALSE,
  bias_flagged_at       TIMESTAMPTZ,
  bias_cleared_at       TIMESTAMPTZ,
  bias_cleared_by       UUID REFERENCES users(id),
  status                TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','under_review','approved','rejected','published')),
  athlete_visible       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE para_insights IS
  'AI-drafted para-sport performance insights. Status lifecycle: draft → under_review → approved/rejected → published. '
  'Athletes see only published rows (athlete_visible=true). Coach annotation is encrypted. '
  'Bias flag blocks publication until cleared. AI never infers impairment, class, diagnosis or eligibility.';

CREATE INDEX IF NOT EXISTS para_insights_athlete ON para_insights(athlete_id, status);
CREATE INDEX IF NOT EXISTS para_insights_coach   ON para_insights(coach_id, status);
CREATE INDEX IF NOT EXISTS para_insights_pending ON para_insights(status) WHERE status IN ('draft','under_review');
CREATE INDEX IF NOT EXISTS para_insights_bias    ON para_insights(bias_flag) WHERE bias_flag = TRUE;

-- Tag existing performance rows with frozen para class version at recording time (additive, nullable).
ALTER TABLE performances ADD COLUMN IF NOT EXISTS para_class_version_id UUID;

COMMENT ON COLUMN performances.para_class_version_id IS
  'Para competition class version frozen at time this performance was recorded. '
  'Never updated after insert. NULL for non-para athletes or non-para performances. '
  'Prevents cross-class-version trend contamination (PS-28).';
