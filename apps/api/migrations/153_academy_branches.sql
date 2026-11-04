-- Academy OS 3/3 close-out: branches / locations for the academy. A branch is a named grouping the academy defines; it REFERENCES the canonical
-- venues (venue_ids) and never copies venue data. A programme belongs to at most one branch, so P&L by branch is exactly the sum of its programmes.
-- Additive only: nothing is dropped or rewritten, a programme with no branch is simply "unassigned", and a branch is archived, never deleted.
CREATE TABLE IF NOT EXISTS academy_branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  city            text CHECK (city IS NULL OR length(city) <= 80),
  venue_ids       uuid[] NOT NULL DEFAULT '{}',
  code            text CHECK (code IS NULL OR code ~ '^[A-Za-z0-9-]{2,12}$'),     -- short reference used in reports, e.g. MAD-N
  manager_id      uuid REFERENCES users,                                          -- the person accountable for the branch (a user, never a copy of their data)
  address         text CHECK (address IS NULL OR length(address) <= 200),         -- business location, not a personal address
  opened_on       date,
  athlete_target  int CHECK (athlete_target IS NULL OR athlete_target > 0),       -- planning target the scorecard compares against
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  archived_by     uuid REFERENCES users,
  idempotency_key text
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_branches_name ON academy_branches (organisation_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academy_branches_idem ON academy_branches (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE academy_programmes ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES academy_branches;
CREATE INDEX IF NOT EXISTS academy_programmes_branch ON academy_programmes (branch_id) WHERE branch_id IS NOT NULL;

-- Follow-through of a human progression decision (certificate, squad invitation, cohort move). The work itself is done by the canonical
-- capability (credentials, team invitations, enrolment transfer); this append-only row only links the decision to the record it caused, so
-- a retry can never issue a second certificate or invitation for the same decision.
CREATE TABLE IF NOT EXISTS academy_decision_follow_ups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES academy_progression_decisions,
  kind        text NOT NULL CHECK (kind IN ('issue_certificate','invite_squad','move_cohort')),
  target_type text NOT NULL,
  target_id   text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id, kind)
);
DROP TRIGGER IF EXISTS academy_follow_ups_immutable ON academy_decision_follow_ups;
CREATE TRIGGER academy_follow_ups_immutable BEFORE UPDATE OR DELETE ON academy_decision_follow_ups FOR EACH ROW EXECUTE FUNCTION academy_outcomes_append_only();

-- Identical pack content for the same person and template is the same document (a retry never makes a second copy). The table stays append-only.
ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS snapshot_sha text;
CREATE INDEX IF NOT EXISTS generated_documents_snapshot ON generated_documents (source_type, source_id, generated_by, snapshot_sha) WHERE snapshot_sha IS NOT NULL;
