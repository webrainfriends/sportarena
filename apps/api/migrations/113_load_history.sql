-- Unified training and match load history (#328). Additive only: new columns on session_loads with safe defaults (every existing row becomes a
-- 'manual' record and keeps its values), one new append-only revision table. Nothing is dropped, rewritten or narrowed.
-- A load record can now point at the confirmed completed training session or verified match appearance it came from. A partial unique index
-- per source means one source can never be counted twice, whatever the retries or races. Minutes and RPE are always entered or confirmed by
-- the athlete; nothing is estimated or inferred here.
-- Rollback = deploy the previous code: it ignores the new columns and table, and the data stays.
ALTER TABLE session_loads
  ADD COLUMN IF NOT EXISTS source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','training_session','match')),
  ADD COLUMN IF NOT EXISTS training_session_id uuid REFERENCES training_sessions,
  ADD COLUMN IF NOT EXISTS appearance_id       uuid REFERENCES match_appearances,
  ADD COLUMN IF NOT EXISTS minutes_basis       text NOT NULL DEFAULT 'athlete_entered' CHECK (minutes_basis IN ('athlete_entered','match_verified')),
  ADD COLUMN IF NOT EXISTS row_version         integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at          timestamptz NOT NULL DEFAULT now();
ALTER TABLE session_loads DROP CONSTRAINT IF EXISTS session_loads_source_link;
ALTER TABLE session_loads ADD CONSTRAINT session_loads_source_link CHECK (
  (source = 'manual'            AND training_session_id IS NULL     AND appearance_id IS NULL) OR
  (source = 'training_session'  AND training_session_id IS NOT NULL AND appearance_id IS NULL) OR
  (source = 'match'             AND appearance_id IS NOT NULL       AND training_session_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS session_loads_one_per_session ON session_loads (training_session_id) WHERE training_session_id IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS session_loads_one_per_appearance ON session_loads (appearance_id) WHERE appearance_id IS NOT NULL AND archived_at IS NULL;

-- Every create, link, correction and archive, with the values before and after and the athlete's reason (encrypted: it is personal free text).
CREATE TABLE IF NOT EXISTS session_load_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id     uuid NOT NULL REFERENCES session_loads,
  user_id     uuid NOT NULL REFERENCES users,
  actor_id    uuid REFERENCES users,
  action      text NOT NULL CHECK (action IN ('created','linked','corrected','archived')),
  row_version integer NOT NULL,
  before      jsonb,
  after       jsonb NOT NULL,
  reason_enc  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_load_revisions_load ON session_load_revisions (load_id, created_at DESC, id);
-- Backfill: give every existing record a 'created' revision so each has a history from the start.
INSERT INTO session_load_revisions(load_id, user_id, actor_id, action, row_version, after, created_at)
SELECT l.id, l.user_id, l.user_id, 'created', 1,
       jsonb_build_object('session_date', l.session_date::text, 'kind', l.kind, 'minutes', l.minutes, 'rpe', l.rpe, 'source', 'manual'), l.created_at
  FROM session_loads l WHERE NOT EXISTS (SELECT 1 FROM session_load_revisions r WHERE r.load_id = l.id);
