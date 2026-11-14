-- Developer Platform (#569): OAuth 2.0 app registration, developer API keys, platform event subscriptions,
-- governed public read-APIs, sandbox mode, and developer usage dashboard.
-- Additive migration — no DROP/TRUNCATE, no ON DELETE CASCADE on user data.

CREATE TABLE developer_apps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID NOT NULL REFERENCES users(id),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description       TEXT CHECK (length(description) <= 1000),
  website_url       TEXT CHECK (length(website_url) <= 500),
  logo_url          TEXT CHECK (length(logo_url) <= 500),
  client_id         TEXT NOT NULL UNIQUE DEFAULT 'sa_dev_' || gen_random_uuid()::text,
  client_secret_enc TEXT,            -- AES-256-GCM, context 'developer_apps.client_secret'; NULL once revoked
  client_secret_hint TEXT,           -- last 4 chars of plaintext secret
  redirect_uris     TEXT[] NOT NULL DEFAULT '{}',
  allowed_scopes    TEXT[] NOT NULL DEFAULT ARRAY['read'],  -- subset of SCOPES; clinical/admin excluded
  sandbox_mode      BOOLEAN NOT NULL DEFAULT true,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON developer_apps(owner_user_id);
CREATE INDEX ON developer_apps(status);

-- OAuth 2.0 authorization codes (short-lived, single-use, PKCE-ready)
CREATE TABLE oauth_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_app_id  UUID NOT NULL REFERENCES developer_apps(id),
  user_id           UUID NOT NULL REFERENCES users(id),
  code_hash         TEXT NOT NULL UNIQUE,    -- sha256 of plaintext code
  redirect_uri      TEXT NOT NULL,
  scopes            TEXT[] NOT NULL,
  code_challenge    TEXT,                    -- PKCE S256 hash
  used_at           TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '10 minutes',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON oauth_codes(developer_app_id, user_id);

-- OAuth 2.0 access tokens minted for developer apps
CREATE TABLE oauth_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_app_id  UUID NOT NULL REFERENCES developer_apps(id),
  user_id           UUID REFERENCES users(id),   -- NULL for client_credentials grant
  token_hash        TEXT NOT NULL UNIQUE,         -- sha256 of bearer token
  scopes            TEXT[] NOT NULL,
  sandbox_mode      BOOLEAN NOT NULL,
  last_used_at      TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON oauth_tokens(developer_app_id);
CREATE INDEX ON oauth_tokens(user_id);
CREATE INDEX ON oauth_tokens(token_hash) WHERE revoked_at IS NULL;

-- Platform-level developer webhook subscriptions.
-- Distinct from integration_webhooks (org-level, bilateral).
-- These fire on canonical platform domain events (registrations, fixtures, payments, …).
CREATE TABLE developer_webhook_subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_app_id  UUID NOT NULL REFERENCES developer_apps(id),
  url               TEXT NOT NULL CHECK (length(url) <= 500),
  secret_enc        TEXT NOT NULL,   -- AES-256-GCM, context 'developer_webhook_subscriptions.secret'
  secret_hint       TEXT,
  event_types       TEXT[] NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  last_success_at   TIMESTAMPTZ,
  last_error        TEXT,
  failure_count     INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON developer_webhook_subscriptions(developer_app_id);
CREATE INDEX ON developer_webhook_subscriptions(status);

-- Per-day usage counters for each developer app
CREATE TABLE developer_app_usage (
  developer_app_id  UUID NOT NULL REFERENCES developer_apps(id),
  day               DATE NOT NULL,
  calls             INT NOT NULL DEFAULT 0,
  errors            INT NOT NULL DEFAULT 0,
  rate_refused      INT NOT NULL DEFAULT 0,
  webhook_fires     INT NOT NULL DEFAULT 0,
  webhook_failures  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (developer_app_id, day)
);

-- Rolling 1-minute rate-limit window per app (mirrors integration_windows)
CREATE TABLE developer_app_windows (
  developer_app_id  UUID PRIMARY KEY REFERENCES developer_apps(id),
  window_start      TIMESTAMPTZ NOT NULL DEFAULT now(),
  calls             INT NOT NULL DEFAULT 0
);

-- Immutable audit trail for OAuth consent grants and revocations
CREATE TABLE oauth_consent_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_app_id  UUID NOT NULL REFERENCES developer_apps(id),
  user_id           UUID NOT NULL REFERENCES users(id),
  action            TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
  scopes            TEXT[],
  ip                TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON oauth_consent_log(user_id);
CREATE INDEX ON oauth_consent_log(developer_app_id);
