-- Integration Hub (#597): one tenant-level framework for connecting outside systems. Additive only; nothing is dropped or cascaded.
-- Installs belong to an organisation. Credentials are encrypted and rotated by closing the open row and opening a new one (as comm_providers).
CREATE TABLE IF NOT EXISTS integration_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  provider_key text NOT NULL,
  category text NOT NULL,
  provider_version text NOT NULL,
  label text NOT NULL,
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','sandbox')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','paused','error','disconnected')),
  scopes_granted text[] NOT NULL DEFAULT '{}',
  config_enc text,
  rate_per_minute int NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 6000),
  sync_every_minutes int CHECK (sync_every_minutes IS NULL OR sync_every_minutes BETWEEN 15 AND 10080),
  next_sync_at timestamptz,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);
CREATE INDEX IF NOT EXISTS integration_installs_org ON integration_installs(organisation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS integration_installs_due ON integration_installs(next_sync_at) WHERE status = 'connected' AND next_sync_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id uuid NOT NULL REFERENCES integration_installs(id),
  kind text NOT NULL CHECK (kind IN ('api_key','oauth_token','webhook_secret')),
  secret_enc text NOT NULL,
  hint text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  revoked boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_credentials_open ON integration_credentials(install_id, kind) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS integration_external_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id uuid NOT NULL REFERENCES integration_installs(id),
  entity_type text NOT NULL,
  internal_id uuid NOT NULL,
  external_id text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_ext_ids_ext ON integration_external_ids(install_id, entity_type, external_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS integration_ext_ids_int ON integration_external_ids(install_id, entity_type, internal_id) WHERE archived_at IS NULL;

-- Sync runs, inbound deliveries and outbound deliveries all log here. Messages are scrubbed of secrets before they are stored.
CREATE TABLE IF NOT EXISTS integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id uuid NOT NULL REFERENCES integration_installs(id),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','failed','retrying','refused')),
  message text,
  detail jsonb NOT NULL DEFAULT '{}',
  attempts int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_events_install ON integration_events(install_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_usage (
  install_id uuid NOT NULL REFERENCES integration_installs(id),
  day date NOT NULL,
  calls int NOT NULL DEFAULT 0,
  failures int NOT NULL DEFAULT 0,
  refused int NOT NULL DEFAULT 0,
  PRIMARY KEY (install_id, day)
);
CREATE TABLE IF NOT EXISTS integration_windows (
  install_id uuid PRIMARY KEY REFERENCES integration_installs(id),
  window_start timestamptz NOT NULL,
  calls int NOT NULL DEFAULT 0
);

-- Outbound event subscriptions for an organisation. Deliveries run on the durable jobs queue (category 'integrations').
CREATE TABLE IF NOT EXISTS integration_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  install_id uuid REFERENCES integration_installs(id),
  url text NOT NULL,
  event_types text[] NOT NULL,
  secret_enc text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS integration_webhooks_org ON integration_webhooks(organisation_id) WHERE status = 'active';
