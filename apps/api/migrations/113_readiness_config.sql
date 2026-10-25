-- Transparent readiness and workload (#329). Additive only: one new table, no existing row or column is touched.
-- Readiness is a heuristic, not a medical tool. By default every athlete uses the standard weights and thresholds in code. A qualified coach
-- (live coaching relationship) or clinician (full medical grant + verified credential) who holds a live wellness share that includes
-- readiness may propose adjusted settings inside fixed safe ranges, with a written reason. Each change is a new, numbered, append-only
-- version; the athlete (or a verified guardian) can see every version and reset to the standard, which is just another version.
-- A staff version only applies while the share it was made under is live (checked on every read), so revoking sharing ends its effect.
-- Rollback = deploy the previous code: nothing else reads this table, and the data stays.
CREATE TABLE IF NOT EXISTS readiness_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES users,
  version     integer NOT NULL CHECK (version >= 1),
  source      text NOT NULL CHECK (source IN ('staff','reset')),
  config      jsonb NOT NULL,
  rationale_enc text,
  set_by      uuid NOT NULL REFERENCES users,
  set_by_kind text NOT NULL CHECK (set_by_kind IN ('coach','provider','athlete','guardian')),
  share_id    uuid REFERENCES wellness_shares,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (athlete_id, version),
  CHECK ((source = 'staff') = (share_id IS NOT NULL AND rationale_enc IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS readiness_configs_athlete ON readiness_configs (athlete_id, version DESC);
