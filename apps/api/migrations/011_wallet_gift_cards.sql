-- Wallet (stored value per currency), gift cards, and paying invoices with wallet credit.
CREATE TABLE wallet_accounts (
  user_id       uuid NOT NULL REFERENCES users,
  currency      text NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, currency)
);

-- Append-only: every movement of money in or out of a wallet. The balance above always equals the sum of these rows.
CREATE TABLE wallet_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users,
  currency      text NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),     -- positive = money in, negative = money out
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  kind          text NOT NULL CHECK (kind IN ('topup','gift_card','spend','refund','adjustment')),
  ref_type      text,
  ref_id        uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_ledger_user ON wallet_ledger (user_id, currency, created_at DESC);

CREATE TABLE wallet_topups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  currency     text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status       text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz
);
CREATE INDEX wallet_topups_user ON wallet_topups (user_id, created_at DESC);

-- A gift card is a prepaid code: bought online, redeemed into the redeemer's wallet. Only the hash of the code is used to look it up;
-- the code itself is stored encrypted so the buyer can see it again.
CREATE TABLE gift_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency     text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status       text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','active','redeemed','cancelled','expired')),
  code_hash    text UNIQUE,
  code_enc     text,
  code_hint    text,
  message      text,
  purchaser_id uuid NOT NULL REFERENCES users,
  redeemed_by  uuid REFERENCES users,
  redeemed_at  timestamptz,
  expires_at   timestamptz,
  paid_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_cards_purchaser ON gift_cards (purchaser_id, created_at DESC);

CREATE TABLE gift_card_attempts (
  id      bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users,
  ok      boolean NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_card_attempts_user ON gift_card_attempts (user_id, at DESC);

-- Wallet credit applied to an invoice. returned_cents = what has since been given back (invoice voided/shrunk, or refunded).
CREATE TABLE invoice_credits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES invoices,
  user_id        uuid NOT NULL REFERENCES users,
  source         text NOT NULL CHECK (source IN ('wallet')),
  amount_cents   int NOT NULL CHECK (amount_cents > 0),
  returned_cents int NOT NULL DEFAULT 0 CHECK (returned_cents >= 0 AND returned_cents <= amount_cents),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_credits_invoice ON invoice_credits (invoice_id);

ALTER TABLE invoices
  ADD COLUMN credits_cents int NOT NULL DEFAULT 0,               -- wallet credit currently applied (amount due = total - credits)
  ADD COLUMN refund_to_credits_cents int NOT NULL DEFAULT 0;     -- credit notes: the part refunded straight back to the wallet

ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card'));
