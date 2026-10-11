-- Verified competition scoring: every performance now says where it came from, and only approved competition results count toward official rankings.
-- Additive and backwards-compatible: columns/tables only, nothing is dropped or rewritten. Existing rows are classified (backfilled) below, never removed.
--   self_reported         practice the athlete logged themselves (private to them; the points they typed are kept as "claimed" and never ranked)
--   imported              evidence from a device/app/other source (labelled, never ranked)
--   approved_competition  a result for an event/fixture that an authorised official submitted and a different official approved
-- Rollback: the app code that reads these columns can be reverted without touching data; the columns are inert for the old code (old code ranks by the untouched `points` column).

ALTER TABLE performances
  ADD COLUMN IF NOT EXISTS provenance      text NOT NULL DEFAULT 'self_reported' CHECK (provenance IN ('self_reported','imported','approved_competition')),
  ADD COLUMN IF NOT EXISTS status          text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','submitted','approved','disputed','rejected','superseded')),
  ADD COLUMN IF NOT EXISTS unit            text,                    -- s | m | count, from the sport rules at the time
  ADD COLUMN IF NOT EXISTS direction       text CHECK (direction IN ('higher','lower')),
  ADD COLUMN IF NOT EXISTS rule_version    int NOT NULL DEFAULT 0,  -- 0 = recorded before versioned rules existed
  ADD COLUMN IF NOT EXISTS official_points numeric,                 -- derived server-side from the rules; null for anything not an approved-competition candidate
  ADD COLUMN IF NOT EXISTS achieved_on     date,
  ADD COLUMN IF NOT EXISTS evidence_ref    text,
  ADD COLUMN IF NOT EXISTS client_key      text,                    -- lets a flaky connection resend a submission safely
  ADD COLUMN IF NOT EXISTS supersedes_id   uuid REFERENCES performances,
  ADD COLUMN IF NOT EXISTS decided_by      uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS decided_at      timestamptz,
  ADD COLUMN IF NOT EXISTS decision_note   text;

-- Backfill: results an organiser/referee recorded for an event or fixture were the official ones before this change; keep them counting,
-- with official_points = the points that were awarded. Everything else (the athlete's own entries) is practice.
UPDATE performances SET provenance = 'approved_competition', status = 'approved', official_points = points,
       decided_by = recorded_by, decided_at = recorded_at, decision_note = 'Recorded before result approval existed', achieved_on = recorded_at::date
 WHERE rule_version = 0 AND status = 'recorded' AND provenance = 'self_reported'
   AND recorded_by <> user_id AND (event_id IS NOT NULL OR fixture_id IS NOT NULL);
UPDATE performances SET achieved_on = recorded_at::date WHERE achieved_on IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS performances_client_key ON performances (recorded_by, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS performances_official ON performances (sport_id, metric, user_id) WHERE provenance = 'approved_competition' AND status = 'approved';
CREATE INDEX IF NOT EXISTS performances_review ON performances (event_id, status) WHERE provenance = 'approved_competition';

-- Every step a result goes through, with the values as they were (corrections add a new row; the old evidence stays).
CREATE TABLE IF NOT EXISTS performance_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  performance_id uuid NOT NULL REFERENCES performances,
  actor_id       uuid NOT NULL REFERENCES users,
  action         text NOT NULL,           -- submitted, approved, rejected, disputed, corrected, superseded
  from_status    text,
  to_status      text,
  note           text,
  snapshot       jsonb,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS performance_log_perf ON performance_log (performance_id, at);
