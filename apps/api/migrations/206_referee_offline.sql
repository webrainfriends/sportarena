-- Referee offline workflow (R08). Additive only.
-- referee_sync_sessions: one row per device–fixture session (tracks pack download, op counts, drift).
-- referee_offline_ops: server-side staging/audit of each op the device submits in a batch.

CREATE TABLE IF NOT EXISTS referee_sync_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id         uuid NOT NULL REFERENCES fixtures(id),
  official_id        uuid NOT NULL REFERENCES users(id),
  device_id          text NOT NULL,
  status             text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','syncing','synced','conflict','failed')),
  pack_downloaded_at timestamptz,
  pack_version       int NOT NULL DEFAULT 0,
  last_sync_at       timestamptz,
  queued_ops         int NOT NULL DEFAULT 0,
  conflict_ops       int NOT NULL DEFAULT 0,
  sync_warnings      jsonb,
  clock_drift_ms     int,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fixture_id, official_id, device_id)
);
CREATE INDEX IF NOT EXISTS rss_fixture   ON referee_sync_sessions(fixture_id);
CREATE INDEX IF NOT EXISTS rss_official  ON referee_sync_sessions(official_id);

CREATE TABLE IF NOT EXISTS referee_offline_ops (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES referee_sync_sessions(id),
  fixture_id    uuid NOT NULL REFERENCES fixtures(id),
  official_id   uuid NOT NULL REFERENCES users(id),
  device_id     text NOT NULL,
  client_key    text NOT NULL,
  op_type       text NOT NULL
    CHECK (op_type IN ('control_op','match_event','session_event','official_report','event_correction')),
  payload_enc   text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','applied','duplicate','conflict','rejected','error')),
  seq           int NOT NULL,
  applied_id    uuid,
  conflict_data jsonb,
  error_detail  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fixture_id, client_key)
);
CREATE INDEX IF NOT EXISTS roo_fixture   ON referee_offline_ops(fixture_id);
CREATE INDEX IF NOT EXISTS roo_official  ON referee_offline_ops(official_id);
CREATE INDEX IF NOT EXISTS roo_status    ON referee_offline_ops(status);
CREATE INDEX IF NOT EXISTS roo_device    ON referee_offline_ops(device_id);

-- Add client_key to official_reports for idempotent offline submission
ALTER TABLE official_reports ADD COLUMN IF NOT EXISTS client_key text;
CREATE UNIQUE INDEX IF NOT EXISTS official_reports_client_key_key
  ON official_reports(client_key) WHERE client_key IS NOT NULL;
