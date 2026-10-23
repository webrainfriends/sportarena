-- Sponsored goods returns, replacements, delivery evidence and service vouchers (#300).
-- Additive only: nothing is dropped or rewritten. Existing deliveries keep their rows; the new columns default so every old row stays valid.

-- 1. A fourth contribution kind: 'service' (funded coaching / venue / travel / medical). The check is widened, never narrowed.
ALTER TABLE sponsorship_lines DROP CONSTRAINT IF EXISTS sponsorship_lines_kind_check;
ALTER TABLE sponsorship_lines ADD CONSTRAINT sponsorship_lines_kind_check CHECK (kind IN ('money','goods','endorsement','service'));
ALTER TABLE sponsorship_obligations DROP CONSTRAINT IF EXISTS sponsorship_obligations_kind_check;
ALTER TABLE sponsorship_obligations ADD CONSTRAINT sponsorship_obligations_kind_check CHECK (kind IN ('money','goods','endorsement','service'));
ALTER TABLE sponsorship_lines ADD COLUMN IF NOT EXISTS service_type text CHECK (service_type IN ('coaching','venue','travel','medical'));
ALTER TABLE sponsorship_lines ADD CONSTRAINT sponsorship_lines_service_type CHECK ((kind = 'service') = (service_type IS NOT NULL));

-- 2. Delivery evidence and optimistic versioning on the existing dispatch / receipt rows.
ALTER TABLE sponsorship_deliveries ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE sponsorship_deliveries ADD COLUMN IF NOT EXISTS dispatch_evidence_url text;   -- sponsor's proof of dispatch (https link)
ALTER TABLE sponsorship_deliveries ADD COLUMN IF NOT EXISTS receipt_evidence_url text;    -- recipient's proof of receipt / condition (https link)
ALTER TABLE sponsorship_deliveries ADD COLUMN IF NOT EXISTS rejection_reason text CHECK (rejection_reason IN ('damaged','wrong_item','not_as_described','other'));

-- 3. Returns of goods that were received (damaged / wrong / not as described). A return never edits the delivery: it is its own append-mostly row.
CREATE TABLE IF NOT EXISTS sponsorship_delivery_returns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id    uuid NOT NULL REFERENCES sponsorship_deliveries,
  obligation_id  uuid NOT NULL REFERENCES sponsorship_obligations,
  quantity       integer NOT NULL CHECK (quantity > 0),
  reason         text NOT NULL CHECK (reason IN ('damaged','wrong_item','not_as_described','other')),
  resolution     text NOT NULL CHECK (resolution IN ('replace','credit')),  -- credit = the sponsor does not replace; the quantity is closed by credit, never counted as received
  note           text,
  evidence_url   text,
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','disputed','cancelled')),
  version        integer NOT NULL DEFAULT 1,
  idempotency_key text,
  requested_by   uuid NOT NULL REFERENCES users,
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, idempotency_key)                     -- a retried request returns the same row
);
CREATE INDEX IF NOT EXISTS sponsorship_returns_obligation ON sponsorship_delivery_returns (obligation_id, created_at, id);

-- A replacement shipment is an ordinary delivery that names the accepted return it replaces; each return is replaced at most once.
ALTER TABLE sponsorship_deliveries ADD COLUMN IF NOT EXISTS replaces_return_id uuid REFERENCES sponsorship_delivery_returns;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_deliveries_one_replacement ON sponsorship_deliveries (replaces_return_id) WHERE replaces_return_id IS NOT NULL AND status <> 'rejected';

-- 4. Service vouchers: a funded unit of service (one coaching session, one venue slot, one trip, one consultation fee).
CREATE TABLE IF NOT EXISTS sponsorship_vouchers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id  uuid NOT NULL REFERENCES sponsorship_obligations,
  service_type   text NOT NULL CHECK (service_type IN ('coaching','venue','travel','medical')),
  valid_until    date,
  status         text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','redeemed','void')),  -- 'expired' is derived: issued and past valid_until
  version        integer NOT NULL DEFAULT 1,
  issued_by      uuid NOT NULL REFERENCES users,
  void_reason    text,
  voided_by      uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_vouchers_obligation ON sponsorship_vouchers (obligation_id, created_at, id);

-- One redemption per voucher, enforced by the database: UNIQUE(voucher_id) makes a double redemption impossible even under a race.
CREATE TABLE IF NOT EXISTS sponsorship_voucher_redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id      uuid NOT NULL UNIQUE REFERENCES sponsorship_vouchers,
  redeemed_by     uuid NOT NULL REFERENCES users,
  idempotency_key text NOT NULL,
  booking_id      uuid REFERENCES bookings,                  -- optional link to the existing venue booking the voucher paid for
  reference       text,                                      -- coaching / travel / venue reference (never for medical)
  redeemed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_redemptions_booking ON sponsorship_voucher_redemptions (booking_id) WHERE booking_id IS NOT NULL;
