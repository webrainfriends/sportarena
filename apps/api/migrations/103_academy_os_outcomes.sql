-- Academy OS 3/3 (#395): pathways, assessments, progression decisions, provider associations, management-accounting entries and scenarios.
-- Strictly additive: no existing row is rewritten or removed. Athlete 360, P&L, ageing, retention signals and the executive home are
-- read-time projections over canonical records and have no tables of their own.

-- A configurable development pathway per academy (and optionally per sport). Levels live in an append-only version, so a
-- historical decision keeps the criteria that applied when it was taken.
CREATE TABLE IF NOT EXISTS academy_pathways (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  sport           text,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  current_version int NOT NULL DEFAULT 0,
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_pathways_org ON academy_pathways (organisation_id, status);

-- levels: [{ key, title, position, age_min, age_max, prerequisites:[level key], programme_ids:[uuid], min_attendance_pct,
--            criteria:[{ rubric_id, dimension_key, min_avg_score, min_observations }], destinations:[{ kind, label }] }]
CREATE TABLE IF NOT EXISTS academy_pathway_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pathway_id     uuid NOT NULL REFERENCES academy_pathways,
  version        int NOT NULL,
  levels         jsonb NOT NULL,
  effective_from date NOT NULL DEFAULT current_date,
  note           text,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pathway_id, version)
);

-- An academy assessment is a review of one athlete against one pathway level. It stores references to the evidence it looked at
-- (observation ids, attendance window, official performance ids) with their provenance; scores are never re-computed into a talent score.
CREATE TABLE IF NOT EXISTS academy_assessments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  pathway_id      uuid NOT NULL REFERENCES academy_pathways,
  version_id      uuid NOT NULL REFERENCES academy_pathway_versions,
  level_key       text NOT NULL,
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  assessor_id     uuid NOT NULL REFERENCES users,
  evidence        jsonb NOT NULL DEFAULT '{}',
  outcome         text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','criteria_met','criteria_partly_met','criteria_not_met')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','appealed','reassessed')),
  comment         text CHECK (comment IS NULL OR length(comment) <= 2000),
  comment_visibility text NOT NULL DEFAULT 'staff' CHECK (comment_visibility IN ('staff','athlete')),
  reviewed_by     uuid REFERENCES users,
  reviewed_at     timestamptz,
  appeal_reason   text,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (period_from <= period_to)
);
CREATE INDEX IF NOT EXISTS academy_assessments_athlete ON academy_assessments (organisation_id, athlete_id, created_at DESC);

-- Human progression decisions. Append-only; the current level of an athlete is the latest row for the pathway.
CREATE TABLE IF NOT EXISTS academy_progression_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  pathway_id      uuid NOT NULL REFERENCES academy_pathways,
  version_id      uuid NOT NULL REFERENCES academy_pathway_versions,
  decision        text NOT NULL CHECK (decision IN ('place','remain','promote','move_programme','invite_squad','reassess','graduate','pause')),
  from_level      text,
  to_level        text,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  assessment_id   uuid REFERENCES academy_assessments,
  criteria_snapshot jsonb NOT NULL DEFAULT '{}',
  decided_by      uuid NOT NULL REFERENCES users,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_progression_athlete ON academy_progression_decisions (pathway_id, athlete_id, created_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS academy_progression_idem ON academy_progression_decisions (decided_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION academy_outcomes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS academy_pathway_versions_immutable ON academy_pathway_versions;
CREATE TRIGGER academy_pathway_versions_immutable BEFORE UPDATE OR DELETE ON academy_pathway_versions FOR EACH ROW EXECUTE FUNCTION academy_outcomes_append_only();
DROP TRIGGER IF EXISTS academy_progression_immutable ON academy_progression_decisions;
CREATE TRIGGER academy_progression_immutable BEFORE UPDATE OR DELETE ON academy_progression_decisions FOR EACH ROW EXECUTE FUNCTION academy_outcomes_append_only();

-- Business association between an academy and a verified physio/doctor. It carries NO clinical data. Revoking keeps the row.
CREATE TABLE IF NOT EXISTS org_provider_associations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  provider_id     uuid NOT NULL REFERENCES users,
  relation        text NOT NULL CHECK (relation IN ('preferred','retained','on_call','programme_cover','event_cover','referral_partner')),
  programme_id    uuid REFERENCES academy_programmes,
  note            text CHECK (note IS NULL OR length(note) <= 500),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS org_provider_associations_live ON org_provider_associations (organisation_id, provider_id, relation, coalesce(programme_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'active';

-- Management-accounting cost lines. These are NOT payments or invoices and never touch the payment/settlement ledgers: they exist
-- because no payroll or timesheet source exists yet (Academy OS 2/3). Append-only; a correction voids the line and adds another.
-- allocation: { method: 'direct' | 'participants' | 'revenue_share' | 'split', splits: [{ programme_id, pct }] }
CREATE TABLE IF NOT EXISTS academy_cost_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  category        text NOT NULL CHECK (category IN ('staff','venue','other_direct','overhead')),
  programme_id    uuid REFERENCES academy_programmes,
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  incurred_on     date NOT NULL,
  allocation      jsonb NOT NULL DEFAULT '{"method":"direct"}',
  description     text NOT NULL CHECK (length(description) BETWEEN 3 AND 300),
  source_ref      text,
  rule_version    int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES users,
  void_reason     text,
  idempotency_key text,
  CHECK (category = 'overhead' OR programme_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS academy_cost_entries_org ON academy_cost_entries (organisation_id, incurred_on);
CREATE UNIQUE INDEX IF NOT EXISTS academy_cost_entries_idem ON academy_cost_entries (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Forecast scenarios: editable assumptions plus the computed result, kept apart from actuals. Creating one changes nothing else.
CREATE TABLE IF NOT EXISTS academy_scenarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  programme_id    uuid REFERENCES academy_programmes,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  assumptions     jsonb NOT NULL,
  baseline        jsonb NOT NULL,
  result          jsonb NOT NULL,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  idempotency_key text
);
CREATE INDEX IF NOT EXISTS academy_scenarios_org ON academy_scenarios (organisation_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS academy_scenarios_idem ON academy_scenarios (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Traceable sponsor funding of a charge: the free-text funding_ref stays, these point at the canonical sponsorship records.
ALTER TABLE academy_charges ADD COLUMN IF NOT EXISTS funding_sponsorship_id uuid REFERENCES sponsorships;
ALTER TABLE academy_charges ADD COLUMN IF NOT EXISTS funding_award_id uuid REFERENCES sponsorship_awards;

-- Consent for an academy to see ONLY the minimal fit/clearance status (never diagnosis, notes or restrictions text).
-- Given by the athlete (adult) or a verified guardian (young person); revoking keeps the row and hides the status at once.
CREATE TABLE IF NOT EXISTS academy_clearance_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  granted_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_clearance_shares_live ON academy_clearance_shares (organisation_id, athlete_id) WHERE revoked_at IS NULL;
