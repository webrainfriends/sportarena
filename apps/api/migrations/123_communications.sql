-- India omnichannel communications (issue #499): SMS + official WhatsApp Business templates on top of the existing notification queue.
-- Additive only: no table is dropped or rewritten, no row is deleted. The existing constraints are re-created as supersets.

-- 1. The one delivery queue learns about SMS, honest provider states and provider evidence.
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_channel_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('email','push','whatsapp','sms'));
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_status_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_check CHECK (status IN ('pending','sent','delivered','read','failed','suppressed'));
ALTER TABLE notification_deliveries
  ADD COLUMN provider        text,            -- NULL = the legacy email / push / OpenWA paths; 'whatsapp_cloud' | 'sms_http' for templated sends
  ADD COLUMN provider_ref    text,            -- the provider's message id, used to match delivery receipts
  ADD COLUMN template_id     uuid,
  ADD COLUMN use_case        text,
  ADD COLUMN essential       boolean NOT NULL DEFAULT false, -- operational message: ignores category mutes and quotas (never a STOP or a removed number)
  ADD COLUMN vars_enc        text,            -- validated template variables only (never free text), encrypted at rest (context notification_deliveries.vars)
  ADD COLUMN organisation_id uuid REFERENCES organisations(id),
  ADD COLUMN error_code      text,
  ADD COLUMN delivered_at    timestamptz,
  ADD COLUMN read_at         timestamptz,
  ADD COLUMN fallback_of     uuid REFERENCES notification_deliveries(id);
-- one templated delivery per notification and channel: a worker retry or webhook replay can never create a second one
CREATE UNIQUE INDEX notification_deliveries_once ON notification_deliveries (notification_id, channel) WHERE provider IS NOT NULL;
CREATE INDEX notification_deliveries_org ON notification_deliveries (organisation_id, created_at DESC) WHERE organisation_id IS NOT NULL;

-- 2. Per-person preferences for the new channel and message categories.
ALTER TABLE notification_prefs ADD COLUMN sms boolean NOT NULL DEFAULT false;
ALTER TABLE notification_prefs ADD COLUMN comm_categories_off text[] NOT NULL DEFAULT '{}';
ALTER TABLE notification_prefs ADD COLUMN comm_locale text NOT NULL DEFAULT 'en-IN';

-- 3. SMS number: stored encrypted, verified by a code sent to it, opt-out is a flag (the row is kept). Same shape as whatsapp_contacts.
CREATE TABLE sms_contacts (
  user_id          uuid PRIMARY KEY REFERENCES users(id),
  phone_enc        text NOT NULL,
  phone_idx        text NOT NULL,
  verified_at      timestamptz,
  code_hash        text,
  code_expires_at  timestamptz,
  code_attempts    int NOT NULL DEFAULT 0,
  code_sent_at     timestamptz,
  opted_out_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_contacts_idx ON sms_contacts(phone_idx);

-- 4. Consent / operational-basis evidence. Append-only: a change is a new row, never an update.
CREATE TABLE comm_consents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  channel    text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  action     text NOT NULL CHECK (action IN ('opt_in','opt_out')),
  source     text NOT NULL CHECK (source IN ('app_verification','app_switch','inbound_stop','provider_suppression','admin')),
  basis      text NOT NULL DEFAULT 'consent' CHECK (basis IN ('consent','operational')),
  phone_idx  text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comm_consents_user ON comm_consents(user_id, created_at DESC);

-- 5. Number-level suppression (STOP, invalid, blocked). Looked up by blind index so it holds even if the person changes account.
CREATE TABLE comm_suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_idx  text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  reason     text NOT NULL CHECK (reason IN ('stop','provider_blocked','invalid_number')),
  source     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz
);
CREATE UNIQUE INDEX comm_suppressions_open ON comm_suppressions(phone_idx, channel) WHERE lifted_at IS NULL;

-- 6. Provider accounts. Credentials are encrypted; a rotation closes the old row (effective_to) and opens a new one, so history is kept.
CREATE TABLE comm_providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  kind            text NOT NULL CHECK (kind IN ('whatsapp_cloud','sms_http')),
  organisation_id uuid REFERENCES organisations(id),   -- NULL = the platform account
  label           text NOT NULL,
  sender_label    text,
  config_enc      text NOT NULL,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX comm_providers_open ON comm_providers(channel, coalesce(organisation_id, '00000000-0000-0000-0000-000000000000')) WHERE effective_to IS NULL;

-- 7. Approved message templates. A change is a new version; older versions are retired, never edited or deleted.
CREATE TABLE comm_templates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid REFERENCES organisations(id),   -- NULL = platform template, usable by every organisation
  use_case             text NOT NULL,
  channel              text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  locale               text NOT NULL,
  version              int NOT NULL DEFAULT 1,
  provider_template_id text,                                -- the provider's approved template name / DLT template id
  body                 text NOT NULL,
  variables            jsonb NOT NULL DEFAULT '[]',         -- [{ "name": "amount", "type": "currency" }]
  fallback_channel     text CHECK (fallback_channel IN ('whatsapp','sms','email')),
  org_branding         boolean NOT NULL DEFAULT false,
  state                text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending','active','retired')),
  created_by           uuid REFERENCES users(id),
  activated_at         timestamptz,
  retired_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX comm_templates_version ON comm_templates(coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'), use_case, channel, locale, version);
CREATE UNIQUE INDEX comm_templates_active ON comm_templates(coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'), use_case, channel, locale) WHERE state = 'active';

-- 8. Message quotas (monthly). Usage is counted from notification_deliveries, so there is no second counter to drift.
CREATE TABLE comm_quotas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations(id),   -- NULL = the platform default for organisations without their own row
  channel         text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  monthly_limit   int CHECK (monthly_limit >= 0),      -- NULL = unlimited
  addon_key       text,                                -- optional paid add-on this entitlement belongs to
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz,
  set_by          uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX comm_quotas_open ON comm_quotas(channel, coalesce(organisation_id, '00000000-0000-0000-0000-000000000000')) WHERE effective_to IS NULL;

-- the provider account a message actually went out through: receipts are matched to it, and a provider's message ids only need to be unique per account
ALTER TABLE notification_deliveries ADD COLUMN provider_account_id uuid REFERENCES comm_providers(id);
CREATE UNIQUE INDEX notification_deliveries_provider_ref ON notification_deliveries (provider_account_id, provider_ref) WHERE provider_ref IS NOT NULL;

-- backfill: numbers verified before this migration get the consent evidence they never had a log for (the verification time is the evidence time)
INSERT INTO comm_consents(user_id, channel, action, source, basis, phone_idx, created_at)
  SELECT user_id, 'whatsapp', 'opt_in', 'app_verification', 'consent', phone_idx, verified_at FROM whatsapp_contacts WHERE verified_at IS NOT NULL;
INSERT INTO comm_consents(user_id, channel, action, source, basis, phone_idx, created_at)
  SELECT user_id, 'whatsapp', 'opt_out', 'app_switch', 'consent', phone_idx, opted_out_at FROM whatsapp_contacts WHERE opted_out_at IS NOT NULL;
