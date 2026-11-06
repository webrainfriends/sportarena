-- Connected devices and activity synchronisation (#327). Additive only; data never deleted.
BEGIN;

CREATE TABLE IF NOT EXISTS connected_devices (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id),
  provider      text        NOT NULL CHECK (provider IN ('apple_health','google_fit','garmin','polar','whoop','fitbit','suunto')),
  display_name  text,
  token_enc     text,
  token_expiry  timestamptz,
  last_sync_at  timestamptz,
  battery_pct   int         CHECK (battery_pct BETWEEN 0 AND 100),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error','unlinked')),
  paused_at     timestamptz,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS connected_devices_user_id_idx ON connected_devices(user_id);
CREATE INDEX IF NOT EXISTS connected_devices_status_idx  ON connected_devices(user_id, status) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS device_activities (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      uuid        NOT NULL REFERENCES connected_devices(id),
  user_id        uuid        NOT NULL REFERENCES users(id),
  activity_type  text        NOT NULL CHECK (activity_type IN ('run','cycle','swim','strength','sleep','other')),
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  metrics        jsonb       NOT NULL DEFAULT '{}',
  source         text        NOT NULL,
  source_id      text,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, source_id)
);

CREATE INDEX IF NOT EXISTS device_activities_user_id_idx    ON device_activities(user_id);
CREATE INDEX IF NOT EXISTS device_activities_started_at_idx ON device_activities(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS device_activities_device_idx     ON device_activities(device_id, started_at DESC) WHERE archived_at IS NULL;

COMMIT;
