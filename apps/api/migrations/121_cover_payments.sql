-- Cover: one person or organisation pays another person's bills (a sponsor, a club, a family member, a friend), under an agreement both sides approved.
-- Additive only. The bill keeps its own type and id, so refunds, receipts and settlement work as before; the payment simply records who paid.

CREATE TABLE cover_mandates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beneficiary_id   uuid NOT NULL REFERENCES users,
  payer_user_id    uuid REFERENCES users,
  payer_org_id     uuid REFERENCES organisations,
  initiated_by     text NOT NULL CHECK (initiated_by IN ('beneficiary','payer')),
  requested_by     uuid NOT NULL REFERENCES users,               -- who clicked: the beneficiary, a guardian for a young person, or the payer side
  status           text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','active','declined','revoked','cancelled','expired','used_up')),
  purposes         text[] NOT NULL CHECK (cardinality(purposes) > 0),
  term             text NOT NULL CHECK (term IN ('one_time','duration','unlimited')),
  valid_from       date,
  valid_until      date,
  bill_type        text,                                          -- set for "pay this one bill"
  bill_id          uuid,
  auto_send        boolean NOT NULL DEFAULT false,                -- true: every open bill in scope goes to the payer's inbox; false: only bills the beneficiary sends
  currency         text,
  max_per_bill_minor bigint CHECK (max_per_bill_minor IS NULL OR max_per_bill_minor > 0),
  max_total_minor  bigint CHECK (max_total_minor IS NULL OR max_total_minor > 0),
  sponsorship_id   uuid REFERENCES sponsorships,
  note             text,
  decided_by       uuid REFERENCES users,
  decided_at       timestamptz,
  ended_by         uuid REFERENCES users,
  ended_at         timestamptz,
  end_reason       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((payer_user_id IS NULL) <> (payer_org_id IS NULL)),
  CHECK (payer_user_id IS NULL OR payer_user_id <> beneficiary_id),
  CHECK (term <> 'duration' OR valid_until IS NOT NULL),
  CHECK (bill_type IS NULL OR (term = 'one_time' AND bill_id IS NOT NULL)),
  CHECK ((max_per_bill_minor IS NULL AND max_total_minor IS NULL) OR currency IS NOT NULL)
);
CREATE INDEX cover_mandates_beneficiary ON cover_mandates (beneficiary_id, status);
CREATE INDEX cover_mandates_payer_user ON cover_mandates (payer_user_id, status) WHERE payer_user_id IS NOT NULL;
CREATE INDEX cover_mandates_payer_org ON cover_mandates (payer_org_id, status) WHERE payer_org_id IS NOT NULL;

-- Every use of an agreement: a payment started under it, and whether it settled.
CREATE TABLE cover_uses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id    uuid NOT NULL REFERENCES cover_mandates,
  payment_id    uuid NOT NULL REFERENCES payments,
  purpose_type  text NOT NULL,
  purpose_id    uuid NOT NULL,
  paid_by       uuid NOT NULL REFERENCES users,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  currency      text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  UNIQUE (payment_id)
);
CREATE INDEX cover_uses_mandate ON cover_uses (mandate_id, status);

-- Bills the beneficiary explicitly sent to a payer.
CREATE TABLE cover_bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id    uuid NOT NULL REFERENCES cover_mandates,
  purpose_type  text NOT NULL,
  purpose_id    uuid NOT NULL,
  sent_by       uuid NOT NULL REFERENCES users,
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','withdrawn')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cover_bills_one ON cover_bills (mandate_id, purpose_type, purpose_id) WHERE status = 'sent';

CREATE TABLE cover_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id  uuid NOT NULL REFERENCES cover_mandates,
  actor_id    uuid REFERENCES users,
  action      text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cover_events_mandate ON cover_events (mandate_id, created_at);
CREATE TRIGGER cover_events_immutable BEFORE UPDATE OR DELETE ON cover_events FOR EACH ROW EXECUTE FUNCTION loyalty_immutable();

ALTER TABLE payments ADD COLUMN cover_mandate_id uuid REFERENCES cover_mandates;   -- set when someone paid another person's bill
