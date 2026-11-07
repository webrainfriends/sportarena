-- PS-02 (#832): integrate the governed para classification (#488) into competition entries. Additive only: new tables, no existing data touched or removed.
-- Nothing here stores an assessment, a diagnosis or medical evidence: only the class/status/version/decision reference that was in force, and policy-approved provisional participation.

-- 1. The classification in force when an entry was submitted / registered (frozen; a later reclassification never rewrites it).
CREATE TABLE IF NOT EXISTS para_entry_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  registration_id uuid NOT NULL REFERENCES reg_registrations,
  user_id         uuid NOT NULL REFERENCES users,
  stage           text NOT NULL CHECK (stage IN ('submitted','registered')),
  division_id     uuid REFERENCES reg_divisions,
  decision        text NOT NULL CHECK (decision IN ('eligible','ineligible','pending','unknown')),
  check_status    text NOT NULL CHECK (check_status IN ('pass','fail','pending','unknown','waived')),
  reason          text NOT NULL,
  source          jsonb,                  -- { kind, id, class_code, class_status, label, version, decision_ref } or a provisional approval
  policy_id       uuid REFERENCES reg_policies,
  policy_version  int,
  allowed_classes jsonb NOT NULL DEFAULT '[]',
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registration_id, stage)
);
CREATE INDEX IF NOT EXISTS para_entry_snapshots_event ON para_entry_snapshots (event_id, user_id);
DROP TRIGGER IF EXISTS para_entry_snapshots_append_only ON para_entry_snapshots;
CREATE TRIGGER para_entry_snapshots_append_only BEFORE UPDATE OR DELETE ON para_entry_snapshots FOR EACH ROW EXECUTE FUNCTION reg_append_only();

-- 2. Policy-approved provisional participation while a classification is pending or under review. Never available for a "not eligible" outcome.
CREATE TABLE IF NOT EXISTS para_provisional (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  user_id     uuid NOT NULL REFERENCES users,
  reason_enc  text NOT NULL,
  valid_until date NOT NULL,
  approved_by uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users
);
CREATE INDEX IF NOT EXISTS para_provisional_live ON para_provisional (event_id, user_id) WHERE revoked_at IS NULL;
