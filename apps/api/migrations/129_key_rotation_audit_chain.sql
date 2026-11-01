-- Trust foundations (#632), part 1: encryption key rotation runs and a tamper-evident audit log.
-- Additive only: nothing is dropped, rewritten or narrowed. Existing audit rows are kept; they are chained the first time the log is sealed.

-- ---------------------------------------------------------------- key rotation
-- A run re-encrypts stored values under the active key. Only progress and counts live here: never key material, never values.
CREATE TABLE IF NOT EXISTS key_rotation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key   text NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  started_by   uuid REFERENCES users(id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  cursors      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per column: the last primary key handled, so a run resumes where it stopped
  report       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per column: re-encrypted / already current / unmapped / blocked, with the reason
  error        text
);
CREATE INDEX IF NOT EXISTS key_rotation_runs_started ON key_rotation_runs (started_at DESC);

-- ---------------------------------------------------------------- tamper-evident audit log
-- Inserts stay exactly as they were (no extra locking on the hot path). A short serialised "seal" step then chains rows in order:
-- each sealed row stores the hash of the one before it, so changing, removing or reordering a sealed row breaks every hash after it.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq       bigint;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash      text;
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_seq ON audit_log (seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_unsealed ON audit_log (id) WHERE hash IS NULL;

-- One row: how far the chain has been sealed.
CREATE TABLE IF NOT EXISTS audit_chain_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  seq       bigint NOT NULL DEFAULT 0,
  hash      text,
  sealed_at timestamptz
);
INSERT INTO audit_chain_head (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION audit_row_hash(prev text, s bigint, i bigint, actor uuid, act text, ent text, ent_id uuid, ts timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f', coalesce(prev, ''), s::text, i::text, coalesce(actor::text, ''), act, ent, coalesce(ent_id::text, ''),
    to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex')
$$;

-- Seal up to `max_rows` unsealed rows, oldest first. Serialised by the head row, so concurrent callers queue instead of forking the chain.
CREATE OR REPLACE FUNCTION seal_audit_log(max_rows integer DEFAULT 5000) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE s bigint; h text; r record; n integer := 0; nh text;
BEGIN
  SELECT seq, hash INTO s, h FROM audit_chain_head WHERE singleton FOR UPDATE;
  FOR r IN SELECT * FROM audit_log WHERE hash IS NULL ORDER BY id LIMIT max_rows LOOP
    s := s + 1;
    nh := audit_row_hash(h, s, r.id, r.actor_id, r.action, r.entity, r.entity_id, r.at);
    UPDATE audit_log SET seq = s, prev_hash = h, hash = nh WHERE id = r.id;
    h := nh; n := n + 1;
  END LOOP;
  IF n > 0 THEN UPDATE audit_chain_head SET seq = s, hash = h, sealed_at = now() WHERE singleton; END IF;
  RETURN n;
END $$;

-- The log is append-only. The one permitted change to a row is its sealing (hash columns filled in once, nothing else different).
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.hash IS NULL AND NEW.hash IS NOT NULL
       AND (OLD.id, OLD.actor_id, OLD.action, OLD.entity, OLD.entity_id, OLD.at) IS NOT DISTINCT FROM (NEW.id, NEW.actor_id, NEW.action, NEW.entity, NEW.entity_id, NEW.at) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();
