-- WhatsApp as a third notification channel (delivered through a self-hosted OpenWA gateway). Additive only: nothing is dropped or rewritten.

-- the delivery channel list grows (constraint re-created with a superset; no rows change)
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_channel_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('email','push','whatsapp'));

-- opt-in, so off until the person verifies a number
ALTER TABLE notification_prefs ADD COLUMN whatsapp boolean NOT NULL DEFAULT false;

-- one WhatsApp number per person: stored encrypted, verified by a code sent to it, opt-out is a flag (the row is kept)
CREATE TABLE whatsapp_contacts (
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
CREATE INDEX whatsapp_contacts_idx ON whatsapp_contacts(phone_idx);

-- sending numbers: the platform number plus dedicated numbers a platform admin has granted to an owner (event, organisation, sponsor, provider, venue)
CREATE TABLE whatsapp_senders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind    text NOT NULL CHECK (scope_kind IN ('platform','event','organisation','sponsor','provider','venue')),
  scope_id      uuid,
  label         text NOT NULL,
  openwa_session text NOT NULL,
  entitled_by   uuid REFERENCES users(id),
  entitled_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_kind = 'platform') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX whatsapp_senders_scope ON whatsapp_senders(scope_kind, coalesce(scope_id, '00000000-0000-0000-0000-000000000000')) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX whatsapp_senders_session ON whatsapp_senders(openwa_session) WHERE revoked_at IS NULL;
