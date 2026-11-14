-- Sponsorship contract enhancements (#386): Adobe Sign adapter, signing order, deadline, reminder schedule,
-- audit trail and completion certificate infrastructure. All changes are additive and backwards-compatible.

-- Additional columns on sponsorship_contracts
ALTER TABLE sponsorship_contracts
  ADD COLUMN IF NOT EXISTS signing_order     TEXT    NOT NULL DEFAULT 'parallel'
                                                     CHECK  (signing_order IN ('parallel','sequential')),
  ADD COLUMN IF NOT EXISTS deadline_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_schedule JSONB   NOT NULL DEFAULT '{"days":[7,3,1],"sent":[]}',
  ADD COLUMN IF NOT EXISTS signing_level     TEXT,
  ADD COLUMN IF NOT EXISTS provider_envelope_id TEXT;

-- Full per-event audit trail
CREATE TABLE IF NOT EXISTS sponsorship_contract_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id      UUID        NOT NULL REFERENCES sponsorship_contracts(id),
  event_type       TEXT        NOT NULL
                   CHECK (event_type IN ('created','sent','signed','declined','voided','reminded',
                                         'deadline_extended','certificate_issued','reminder_scheduled')),
  actor_id         UUID        REFERENCES users(id),
  provider_event_id TEXT,
  ip_address       INET,
  user_agent       TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_contract_events_contract_at
  ON sponsorship_contract_events(contract_id, created_at DESC);

-- Scheduled and sent reminders per signatory
CREATE TABLE IF NOT EXISTS sponsorship_contract_reminders (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID        NOT NULL REFERENCES sponsorship_contracts(id),
  signatory_id    UUID        REFERENCES sponsorship_signatories(id),
  channel         TEXT        NOT NULL DEFAULT 'push',
  scheduled_for   TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_contract_reminders_contract_sched
  ON sponsorship_contract_reminders(contract_id, scheduled_for);

-- Allow adobe_sign as a provider value in the existing signature tables
-- (no constraint change needed — provider is TEXT, so any value is accepted)
