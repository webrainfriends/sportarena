-- Multi-role tenant isolation: access-denied telemetry (issue #1129)
-- Every 403/404-as-403 from invoke() is logged here for IDOR detection, role-boundary monitoring and incident response.

CREATE TABLE IF NOT EXISTS access_denied_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  active_role   text,
  acting_org_id uuid REFERENCES organisations(id) ON DELETE SET NULL,
  error_code    text NOT NULL,          -- 'forbidden' | 'not_found' | 'unauthorized'
  http_status   int  NOT NULL,
  capability    text,                   -- capability name e.g. 'get_invoice'
  method        text,                   -- 'GET' | 'POST' etc.
  path          text,                   -- '/invoices/:id' (templated, no raw user ids in the path)
  attempted_entity text,               -- entity type e.g. 'invoice', 'clinical_record'
  attempted_id  text,                  -- the id that was attempted (UUID or similar)
  block_reason  text,                   -- human-readable: 'Role boundary', 'IDOR', 'Cross-tenant', etc.
  ip_hash       text,                  -- SHA-256 of IP (not stored plain)
  user_agent_summary text,             -- 'Chrome on iOS' style (not raw UA)
  mcp_call      boolean NOT NULL DEFAULT false,
  severity      text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical'))
);

CREATE INDEX IF NOT EXISTS access_denied_events_actor_at ON access_denied_events (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS access_denied_events_at ON access_denied_events (at DESC);
CREATE INDEX IF NOT EXISTS access_denied_events_severity_at ON access_denied_events (severity, at DESC);
CREATE INDEX IF NOT EXISTS access_denied_events_error_code_at ON access_denied_events (error_code, at DESC);

-- Permission matrix: live record of tested role × domain grants (populated/updated by CI and the capability)
CREATE TABLE IF NOT EXISTS permission_matrix_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain        text NOT NULL,          -- e.g. 'clinical_records', 'finance_payouts'
  data_owner    text NOT NULL,
  role_key      text NOT NULL,
  permission    text NOT NULL CHECK (permission IN ('allow','deny','conditional','na')),
  condition     text,                   -- description of condition when permission='conditional'
  negative_test text,                   -- CI test name that proves denial
  last_tested_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(domain, role_key)
);

-- Revocation propagation log: what was cleared when membership was removed
CREATE TABLE IF NOT EXISTS revocation_propagation_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at            timestamptz NOT NULL DEFAULT now(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid REFERENCES organisations(id) ON DELETE SET NULL,
  revoked_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reason        text NOT NULL,          -- 'removed_from_org', 'grant_expired', 'consent_revoked', etc.
  sessions_invalidated int NOT NULL DEFAULT 0,
  notifications_cancelled int NOT NULL DEFAULT 0,
  signed_urls_expired int NOT NULL DEFAULT 0,
  cache_keys_cleared int NOT NULL DEFAULT 0,
  deep_links_revoked int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS revocation_propagation_log_user ON revocation_propagation_log (user_id, at DESC);
CREATE INDEX IF NOT EXISTS revocation_propagation_log_org ON revocation_propagation_log (org_id, at DESC);
