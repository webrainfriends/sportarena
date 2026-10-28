-- Enterprise identity & provisioning (#521). Additive only: nothing is dropped, rewritten or narrowed.
-- One canonical users row per person. An organisation's IdP (OIDC / SAML) and SCIM client only ever add, change or end that
-- organisation's own organisation_members row; they never touch users.roles, other organisations or the person's history.

ALTER TABLE organisation_members ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE organisation_members ADD CONSTRAINT organisation_members_source_check CHECK (source IN ('manual','sso','scim'));
ALTER TABLE organisation_members ADD COLUMN IF NOT EXISTS provisioned_connection_id uuid;
ALTER TABLE organisation_members ADD COLUMN IF NOT EXISTS deprovisioned_at timestamptz;

-- sessions opened through an organisation's IdP remember which connection, so offboarding can end exactly those, and carry a hard
-- ceiling the sliding refresh can never extend past.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS sso_connection_id uuid;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS hard_expires_at timestamptz;

-- a local two-step challenge that follows an organisation sign-in remembers the connection, so the session it opens is tagged the same way
ALTER TABLE account_tokens ADD COLUMN IF NOT EXISTS sso_connection_id uuid;

-- Domain claim: proof (DNS TXT) that the organisation controls an email domain. Discovery and JIT need it; it never grants a role.
CREATE TABLE org_domain_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  domain          text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  token           text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','revoked')),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  last_checked_at timestamptz,
  revoked_at      timestamptz
);
CREATE UNIQUE INDEX org_domain_claims_live ON org_domain_claims (organisation_id, domain) WHERE status <> 'revoked';
CREATE UNIQUE INDEX org_domain_claims_verified ON org_domain_claims (domain) WHERE status = 'verified';

-- One live SSO connection per organisation. config holds only public settings; the OIDC client secret is encrypted (client_secret_enc)
-- and never returned. allowed_roles is the role ceiling: no group mapping or default can grant a role outside it.
CREATE TABLE org_sso_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations,
  name                text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  protocol            text NOT NULL CHECK (protocol IN ('oidc','saml')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','disabled')),
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_secret_enc   text,
  idp_certs           jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_roles       text[] NOT NULL DEFAULT '{}',
  default_role        text,
  group_claim         text NOT NULL DEFAULT 'groups',
  jit_enabled         boolean NOT NULL DEFAULT false,
  require_mfa_signal  boolean NOT NULL DEFAULT false,
  session_hours       int CHECK (session_hours BETWEEN 1 AND 720),
  local_login         text NOT NULL DEFAULT 'allowed' CHECK (local_login IN ('allowed','sso_required')),
  break_glass_user_ids uuid[] NOT NULL DEFAULT '{}',
  clock_skew_seconds  int NOT NULL DEFAULT 60 CHECK (clock_skew_seconds BETWEEN 0 AND 300),
  tested_at           timestamptz,
  test_ok             boolean,
  test_detail         text,
  created_by          uuid NOT NULL REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  disabled_at         timestamptz
);
CREATE UNIQUE INDEX org_sso_connections_live ON org_sso_connections (organisation_id) WHERE status <> 'disabled';

-- Group / claim value -> organisation role. 'deny' wins over any 'allow'.
CREATE TABLE org_sso_group_mappings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES org_sso_connections,
  group_value   text NOT NULL CHECK (length(group_value) BETWEEN 1 AND 200),
  effect        text NOT NULL CHECK (effect IN ('allow','deny')),
  org_role      text,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  CHECK ((effect = 'allow') = (org_role IS NOT NULL))
);
CREATE UNIQUE INDEX org_sso_group_mappings_live ON org_sso_group_mappings (connection_id, lower(group_value)) WHERE removed_at IS NULL;

-- (connection, IdP subject) -> canonical user. Linked only through the controlled rules in the SSO flow.
CREATE TABLE org_sso_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    uuid NOT NULL REFERENCES org_sso_connections,
  user_id          uuid NOT NULL REFERENCES users,
  external_subject text NOT NULL,
  linked_how       text NOT NULL CHECK (linked_how IN ('jit_new_account','confirmed_by_owner','reclaimed_unverified_email')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unlinked')),
  linked_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  mfa_signal_at    timestamptz
);
CREATE UNIQUE INDEX org_sso_identities_subject ON org_sso_identities (connection_id, external_subject);
CREATE UNIQUE INDEX org_sso_identities_user ON org_sso_identities (connection_id, user_id) WHERE status = 'active';

-- Login attempts in flight: state (CSRF + SAML InResponseTo), OIDC nonce + PKCE verifier. Single use, short lived.
CREATE TABLE sso_login_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   uuid NOT NULL REFERENCES org_sso_connections,
  state_hash      text NOT NULL UNIQUE,
  nonce_hash      text,
  verifier_enc    text,
  saml_request_id text,
  redirect_uri    text NOT NULL,
  link_user_id    uuid REFERENCES users,   -- set when an already signed-in person adds this organisation to their account
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Replay protection: an assertion id / id_token jti is accepted once per connection until it would have expired anyway.
CREATE TABLE sso_replay (
  connection_id uuid NOT NULL REFERENCES org_sso_connections,
  value_hash    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (connection_id, value_hash)
);

-- A verified SAML result waiting for the app to collect it (one use, two minutes).
CREATE TABLE sso_tickets (
  ticket_hash   text PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES org_sso_connections,
  claims        jsonb NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

-- The email matched an existing canonical account: nothing is merged until that account's own signed-in owner confirms.
CREATE TABLE sso_link_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       text NOT NULL UNIQUE,
  connection_id    uuid NOT NULL REFERENCES org_sso_connections,
  user_id          uuid NOT NULL REFERENCES users,
  external_subject text NOT NULL,
  groups           jsonb NOT NULL DEFAULT '[]'::jsonb,
  mfa_signal       boolean NOT NULL DEFAULT false,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Append-only record of enterprise-identity decisions (login source, mapping, provisioning, failed policy). No assertions, tokens or secrets.
CREATE TABLE sso_events (
  id              bigserial PRIMARY KEY,
  organisation_id uuid REFERENCES organisations,
  connection_id   uuid REFERENCES org_sso_connections,
  user_id         uuid REFERENCES users,
  actor_id        uuid REFERENCES users,
  event           text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('ok','denied','error')),
  reason          text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sso_events_org ON sso_events (organisation_id, at DESC);

-- SCIM bearer credentials: org-scoped service identities, independent of any person's session or API token.
CREATE TABLE scim_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  connection_id   uuid NOT NULL REFERENCES org_sso_connections,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  token_hash      text NOT NULL UNIQUE,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  last_used_at    timestamptz,
  revoked_at      timestamptz
);

-- The enterprise's reference to a person (SCIM "User"). It never owns a users row; the link is made when the person signs in.
CREATE TABLE scim_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  connection_id   uuid NOT NULL REFERENCES org_sso_connections,
  external_id     text,
  email_enc       text NOT NULL,
  email_idx       text NOT NULL,
  display_name    text,
  active          boolean NOT NULL DEFAULT true,
  user_id         uuid REFERENCES users,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
CREATE UNIQUE INDEX scim_users_email ON scim_users (organisation_id, email_idx);
CREATE UNIQUE INDEX scim_users_external ON scim_users (organisation_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE scim_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  connection_id   uuid NOT NULL REFERENCES org_sso_connections,
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  external_id     text,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);
CREATE UNIQUE INDEX scim_groups_name ON scim_groups (organisation_id, lower(display_name)) WHERE removed_at IS NULL;

CREATE TABLE scim_group_members (
  group_id     uuid NOT NULL REFERENCES scim_groups,
  scim_user_id uuid NOT NULL REFERENCES scim_users,
  added_at     timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  PRIMARY KEY (group_id, scim_user_id)
);
