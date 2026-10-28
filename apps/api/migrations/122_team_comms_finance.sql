-- Team communication and member finance (issue #516). Additive only: nothing is dropped, rewritten or narrowed.
-- Team chat (team_messages) stays the one conversation per team; this adds a reconnect cursor, replies, reactions, pins, polls, media and a
-- guardians channel to it. RSVP stays in team_attendance (a message only points at an event/fixture). Money stays in `payments`: a member
-- obligation is a team_charge, a fundraising gift is a team_contribution, and both are paid through the canonical checkout.

-- ------------------------------------------------------------------------------------------------------------------ chat
-- the body check is widened (a photo or voice note may have no caption); every existing row still satisfies it
ALTER TABLE team_messages DROP CONSTRAINT IF EXISTS team_messages_body_check;
ALTER TABLE team_messages ADD CONSTRAINT team_messages_body_check CHECK (length(body) <= 2000);

ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;   -- reconnect cursor: strictly increasing, never reused
CREATE UNIQUE INDEX IF NOT EXISTS team_messages_seq ON team_messages (seq);
CREATE INDEX IF NOT EXISTS team_messages_team_seq ON team_messages (team_id, seq);
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','poll','rsvp','media'));
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'team' CHECK (audience IN ('team','guardians'));
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES team_messages;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS pinned_by uuid REFERENCES users;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES events;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS fixture_id uuid REFERENCES fixtures;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS client_id text CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64);  -- a retried send with the same id adds nothing
CREATE UNIQUE INDEX IF NOT EXISTS team_messages_client ON team_messages (team_id, sender_id, client_id) WHERE client_id IS NOT NULL;

-- photos, files and short voice notes: stored encrypted, served only to current members (membership is re-checked on every download)
CREATE TABLE IF NOT EXISTS team_chat_media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES teams,
  uploader_id  uuid NOT NULL REFERENCES users,
  audience     text NOT NULL DEFAULT 'team' CHECK (audience IN ('team','guardians')),
  kind         text NOT NULL CHECK (kind IN ('image','file','voice')),
  content_type text NOT NULL,
  name         text NOT NULL,
  file_name    text NOT NULL,
  size_bytes   int NOT NULL CHECK (size_bytes > 0),
  seconds      int CHECK (seconds IS NULL OR seconds BETWEEN 1 AND 180),
  sha256       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS team_chat_media_team ON team_chat_media (team_id, created_at DESC);
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS media_id uuid REFERENCES team_chat_media;
CREATE UNIQUE INDEX IF NOT EXISTS team_messages_media ON team_messages (media_id) WHERE media_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_message_reactions (
  message_id uuid NOT NULL REFERENCES team_messages,
  user_id    uuid NOT NULL REFERENCES users,
  emoji      text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,                                          -- taking a reaction back keeps the row
  PRIMARY KEY (message_id, user_id, emoji)
);

-- a poll is a message; its options and votes are rows. Not an RSVP: attendance questions use team_attendance.
CREATE TABLE IF NOT EXISTS team_polls (
  message_id uuid PRIMARY KEY REFERENCES team_messages,
  question   text NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
  multiple   boolean NOT NULL DEFAULT false,
  closes_at  timestamptz,
  closed_at  timestamptz,
  closed_by  uuid REFERENCES users
);
CREATE TABLE IF NOT EXISTS team_poll_options (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES team_polls,
  position   int NOT NULL,
  label      text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  UNIQUE (message_id, position)
);
CREATE TABLE IF NOT EXISTS team_poll_votes (
  option_id  uuid NOT NULL REFERENCES team_poll_options,
  message_id uuid NOT NULL REFERENCES team_polls,
  user_id    uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,                                          -- changing a vote keeps the old row
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_poll_votes_user ON team_poll_votes (message_id, user_id);

ALTER TABLE team_chat_reads ADD COLUMN IF NOT EXISTS last_read_seq bigint NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------------------------------------------- finance
-- what the team may show its members about money (default: only their own obligations)
CREATE TABLE IF NOT EXISTS team_finance_settings (
  team_id            uuid PRIMARY KEY REFERENCES teams,
  members_see_totals boolean NOT NULL DEFAULT false,
  updated_by         uuid REFERENCES users,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- one batch = one decision by a manager (a dues round, a match fee, a shared expense). Its charges are the per-member rows.
CREATE TABLE IF NOT EXISTS team_charge_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES teams,
  kind         text NOT NULL CHECK (kind IN ('dues','season_fee','match_fee','expense')),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  currency     text NOT NULL,
  total_minor  bigint NOT NULL CHECK (total_minor >= 0),          -- what the batch asks for in all (fixed amount x members, or the expense total)
  split_mode   text NOT NULL CHECK (split_mode IN ('fixed','equal','weights','exact')),
  due_on       date,
  event_id     uuid REFERENCES events,
  fixture_id   uuid REFERENCES fixtures,
  paid_by      uuid REFERENCES users,                             -- an expense: the member who fronted the money and is owed it back
  plan_id      uuid,                                              -- set when a recurring plan raised it
  plan_period  text,
  idempotency_key text,                                           -- a retried request with the same key raises nothing twice
  created_by   uuid NOT NULL REFERENCES users,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_charge_batches_team ON team_charge_batches (team_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS team_charge_batches_key ON team_charge_batches (team_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_charge_batches_period ON team_charge_batches (plan_id, plan_period) WHERE plan_id IS NOT NULL;

-- what one member owes. The payer is the member, or a verified guardian when the member is a young person (the child is never the payer).
CREATE TABLE IF NOT EXISTS team_charges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES team_charge_batches,
  team_id        uuid NOT NULL REFERENCES teams,
  member_id      uuid NOT NULL REFERENCES users,
  payer_id       uuid NOT NULL REFERENCES users,
  amount_minor   bigint NOT NULL CHECK (amount_minor >= 0),       -- the share, fixed when raised
  adjusted_minor bigint NOT NULL DEFAULT 0 CHECK (adjusted_minor >= 0),   -- reductions and waivers, each one a row in team_charge_entries
  settled_minor  bigint NOT NULL DEFAULT 0 CHECK (settled_minor >= 0),
  due_on         date,
  status         text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','waived','cancelled')),
  paid_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (settled_minor + adjusted_minor <= amount_minor),
  UNIQUE (batch_id, member_id)
);
CREATE INDEX IF NOT EXISTS team_charges_team ON team_charges (team_id, status, due_on);
CREATE INDEX IF NOT EXISTS team_charges_payer ON team_charges (payer_id, status, due_on);

-- append-only: every raise, adjustment, waiver and receipt. A retry with the same key adds nothing.
CREATE TABLE IF NOT EXISTS team_charge_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id       uuid NOT NULL REFERENCES team_charges,
  kind            text NOT NULL CHECK (kind IN ('raised','reduction','waiver','receipt','cancelled')),
  amount_minor    bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  method          text,                                           -- online | cash | upi | bank | card | other (receipts)
  payment_id      uuid REFERENCES payments,
  reason_enc      text,                                           -- encrypted free text
  actor_id        uuid REFERENCES users,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_charge_entries_key ON team_charge_entries (charge_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_charge_entries_payment ON team_charge_entries (payment_id) WHERE payment_id IS NOT NULL;

-- recurring dues: one batch per period, raised by the worker, idempotent through team_charge_batches_period
CREATE TABLE IF NOT EXISTS team_dues_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  currency      text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  every_months  int NOT NULL CHECK (every_months BETWEEN 1 AND 12),
  next_on       date NOT NULL,
  due_days      int NOT NULL DEFAULT 7 CHECK (due_days BETWEEN 0 AND 60),
  ends_on       date,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE team_charge_batches DROP CONSTRAINT IF EXISTS team_charge_batches_plan_fk;
ALTER TABLE team_charge_batches ADD CONSTRAINT team_charge_batches_plan_fk FOREIGN KEY (plan_id) REFERENCES team_dues_plans;

-- member fundraising: a target and an approved purpose; gifts are contributions. Sponsorship stays separate unless linked on purpose.
CREATE TABLE IF NOT EXISTS team_fundraisers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        uuid NOT NULL REFERENCES teams,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  purpose        text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 500),
  currency       text NOT NULL,
  target_minor   bigint NOT NULL CHECK (target_minor > 0),
  closes_on      date,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed','cancelled')),
  approved_by    uuid REFERENCES users,
  approved_at    timestamptz,
  sponsorship_id uuid REFERENCES sponsorships,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_fundraisers_team ON team_fundraisers (team_id, status);

CREATE TABLE IF NOT EXISTS team_contributions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fundraiser_id  uuid NOT NULL REFERENCES team_fundraisers,
  contributor_id uuid NOT NULL REFERENCES users,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  anonymous      boolean NOT NULL DEFAULT false,
  method         text,
  status         text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','cancelled')),
  paid_at        timestamptz,
  recorded_by    uuid REFERENCES users,
  idempotency_key text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_contributions_fund ON team_contributions (fundraiser_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS team_contributions_key ON team_contributions (fundraiser_id, contributor_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- the canonical payments table learns the two new purposes. The current list is read and extended, never rewritten, so purposes added by
-- other migrations stay valid.
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND d NOT LIKE '%team_charge%' THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''team_charge''::text, ''team_contribution''::text])');
  END IF;
END $$;
