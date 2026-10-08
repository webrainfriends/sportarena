-- Multi-currency venues, tax settings, numbered invoices / credit notes, and online payment for reservations.
-- Additive only: nothing is dropped or rewritten except widening one CHECK and backfilling payable_cents = price_cents.

-- ---------------------------------------------------------------- venue money settings
ALTER TABLE venues
  ADD COLUMN legal_name      text,                              -- who the invoice is issued by
  ADD COLUMN tax_id          text,                              -- business tax number (GSTIN, VAT id …), printed on invoices
  ADD COLUMN billing_address text,
  ADD COLUMN tax_name        text NOT NULL DEFAULT 'Tax',
  ADD COLUMN tax_rate_bp     int  NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),   -- basis points: 1800 = 18%
  ADD COLUMN tax_inclusive   boolean NOT NULL DEFAULT true,     -- listed prices already include tax (else it is added at checkout)
  ADD COLUMN invoice_prefix  text CHECK (invoice_prefix ~ '^[A-Z0-9]{2,8}$'),
  ADD COLUMN payment_mode    text NOT NULL DEFAULT 'pay_at_venue' CHECK (payment_mode IN ('pay_at_venue','online_optional','online_required'));

CREATE UNIQUE INDEX venues_invoice_prefix ON venues (invoice_prefix) WHERE invoice_prefix IS NOT NULL;

-- ---------------------------------------------------------------- bookings carry tax and the amount actually payable
ALTER TABLE bookings
  ADD COLUMN tax_cents     int NOT NULL DEFAULT 0,              -- tax contained in (inclusive) or added to (exclusive) the price
  ADD COLUMN payable_cents int;                                 -- price_cents, plus tax when the venue adds it on top
UPDATE bookings SET payable_cents = price_cents WHERE payable_cents IS NULL;
ALTER TABLE bookings ALTER COLUMN payable_cents SET DEFAULT 0;
ALTER TABLE bookings ALTER COLUMN payable_cents SET NOT NULL;

ALTER TABLE reservations
  ADD COLUMN tax_cents        int NOT NULL DEFAULT 0,
  ADD COLUMN payable_cents    int NOT NULL DEFAULT 0,
  ADD COLUMN payment_deadline timestamptz,                      -- unpaid online-required bookings are released after this
  ADD COLUMN billing_enc      text;                             -- encrypted JSON {name, address, tax_id} printed on invoices
UPDATE reservations SET payable_cents = total_cents WHERE payable_cents = 0;

-- ---------------------------------------------------------------- invoices & credit notes (one per venue per reservation, in the venue's currency)
CREATE TABLE invoice_counters (
  venue_id uuid NOT NULL REFERENCES venues,
  kind     text NOT NULL CHECK (kind IN ('invoice','credit_note')),
  seq      int  NOT NULL DEFAULT 0,
  PRIMARY KEY (venue_id, kind)
);

CREATE TABLE invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit_note')),
  number         text NOT NULL UNIQUE,                          -- gapless per venue and kind, e.g. ARN-2026-000012 / CN-ARN-2026-000003
  venue_id       uuid NOT NULL REFERENCES venues,
  reservation_id uuid NOT NULL REFERENCES reservations,
  user_id        uuid NOT NULL REFERENCES users,                -- bill-to
  parent_id      uuid REFERENCES invoices,                      -- a credit note points at what it credits
  currency       text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  total_cents    int  NOT NULL CHECK (total_cents >= 0),        -- credit notes are positive amounts in their own kind
  tax_cents      int  NOT NULL DEFAULT 0,
  tax_name       text NOT NULL,
  tax_rate_bp    int  NOT NULL,
  tax_inclusive  boolean NOT NULL,
  seller         jsonb NOT NULL,                                -- snapshot: legal name, tax id, address
  buyer_enc      text,                                          -- encrypted snapshot of the bill-to details
  lines          jsonb NOT NULL,
  revision       int  NOT NULL DEFAULT 1,
  payment_method text,                                          -- online | cash | card | upi | bank | other
  issued_at      timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  voided_at      timestamptz,
  refund_status  text CHECK (refund_status IN ('pending','done','failed','manual')),   -- credit notes: how the money goes back
  refunded_at    timestamptz,
  refund_attempts int NOT NULL DEFAULT 0,
  refund_error   text
);
CREATE INDEX invoices_reservation ON invoices (reservation_id, venue_id);
CREATE INDEX invoices_user ON invoices (user_id, issued_at DESC);
CREATE INDEX invoices_venue ON invoices (venue_id, issued_at DESC);
CREATE INDEX invoices_refunds ON invoices (issued_at) WHERE kind = 'credit_note' AND refund_status = 'pending';

-- ---------------------------------------------------------------- online payments (Stripe / PayPal) for invoices, in the invoice's currency
ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice'));
ALTER TABLE payments ADD COLUMN refunded_cents bigint NOT NULL DEFAULT 0;   -- partial refunds (credit notes) add up here
UPDATE payments SET refunded_cents = amount_cents WHERE status = 'refunded' AND refunded_cents = 0;
