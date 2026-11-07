-- Academy OS P1 / Gap 20 (#800): a tracked, human-approved, multi-step promotion / squad transfer / graduation workflow on top of the #395 progression
-- decisions. Additive only: nothing is dropped or rewritten. The work itself is done by the canonical capabilities (enrolment transfer, team invitation,
-- enrolment status, credentials); these tables only record the plan, the approvals, each step's outcome and what to undo. Rollback of this migration is
-- state-only: the three tables can be left in place unused, no other table is changed.
CREATE TABLE IF NOT EXISTS academy_promotion_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations,
  decision_id      uuid NOT NULL REFERENCES academy_progression_decisions,
  athlete_id       uuid NOT NULL REFERENCES users,
  pathway_id       uuid NOT NULL REFERENCES academy_pathways,
  decision         text NOT NULL,
  from_level       text,
  to_level         text,
  enrolment_id     uuid REFERENCES org_enrolments,
  from_cohort_id   uuid REFERENCES org_cohorts,
  to_cohort_id     uuid REFERENCES org_cohorts,
  team_id          uuid REFERENCES teams,
  team_role        text NOT NULL DEFAULT 'player' CHECK (team_role IN ('player','captain')),
  cert_kind        text NOT NULL DEFAULT 'certificate' CHECK (cert_kind IN ('certificate','badge','diploma')),
  cert_title       text,
  status           text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','in_progress','awaiting_acceptance','awaiting_final_approval','completed','partial','rejected','expired','cancelled','rolled_back')),
  checks           jsonb NOT NULL DEFAULT '[]',
  note_enc         text,
  expires_at       timestamptz NOT NULL,
  approved_by      uuid REFERENCES users,
  approved_at      timestamptz,
  final_approved_by uuid REFERENCES users,
  final_approved_at timestamptz,
  closed_at        timestamptz,
  row_version      int NOT NULL DEFAULT 1,
  idempotency_key  text,
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id)
);
CREATE INDEX IF NOT EXISTS academy_promotion_runs_org ON academy_promotion_runs (organisation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS academy_promotion_runs_athlete ON academy_promotion_runs (athlete_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS academy_promotion_runs_idem ON academy_promotion_runs (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS academy_promotion_steps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES academy_promotion_runs,
  seq            int NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('cohort_transfer','squad_invite','squad_acceptance','graduate_status','certificate')),
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','failed','declined','skipped','compensated')),
  target_type    text,
  target_id      text,
  error          text,
  attempts       int NOT NULL DEFAULT 0,
  claimed_at     timestamptz,
  done_at        timestamptz,
  compensated_at timestamptz,
  UNIQUE (run_id, kind)
);

-- Append-only history of everything that happened to a run (who, what, when): the audit trail the technical director and the athlete's record rely on.
CREATE TABLE IF NOT EXISTS academy_promotion_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES academy_promotion_runs,
  actor_id   uuid REFERENCES users,
  event      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_promotion_events_run ON academy_promotion_events (run_id, created_at, id);
DROP TRIGGER IF EXISTS academy_promotion_events_immutable ON academy_promotion_events;
CREATE TRIGGER academy_promotion_events_immutable BEFORE UPDATE OR DELETE ON academy_promotion_events FOR EACH ROW EXECUTE FUNCTION academy_outcomes_append_only();

-- Backfill: a follow-through done before this workflow existed becomes a completed run, so the history stays in one place.
INSERT INTO academy_promotion_runs(organisation_id, decision_id, athlete_id, pathway_id, decision, from_level, to_level, status, expires_at, approved_by, approved_at, closed_at, created_by, created_at)
SELECT d.organisation_id, d.id, d.athlete_id, d.pathway_id, d.decision, d.from_level, d.to_level, 'completed', f.first_at, f.by, f.first_at, f.first_at, f.by, f.first_at
  FROM academy_progression_decisions d
  JOIN (SELECT decision_id, min(created_at) AS first_at, (array_agg(created_by ORDER BY created_at))[1] AS by FROM academy_decision_follow_ups GROUP BY decision_id) f ON f.decision_id = d.id
ON CONFLICT (decision_id) DO NOTHING;
INSERT INTO academy_promotion_steps(run_id, seq, kind, state, target_type, target_id, done_at)
SELECT r.id, 1, CASE f.kind WHEN 'move_cohort' THEN 'cohort_transfer' WHEN 'invite_squad' THEN 'squad_invite' ELSE 'certificate' END, 'done', f.target_type, f.target_id, f.created_at
  FROM academy_decision_follow_ups f JOIN academy_promotion_runs r ON r.decision_id = f.decision_id
ON CONFLICT (run_id, kind) DO NOTHING;
