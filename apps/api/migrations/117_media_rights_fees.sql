-- Rights-fee billing for media licences (#482). Additive only. A fee is a payable raised against a licence: it is paid through the existing hosted checkout
-- (payments.purpose_type 'media_rights_fee'), or recorded as received outside the platform by the organiser. The contracted amount stays on the licence;
-- fees record what was invoiced and what was collected, so the revenue report can tell the three apart, one currency at a time.
ALTER TABLE media_partners ADD COLUMN fee_seq integer NOT NULL DEFAULT 0;

CREATE TABLE mr_fees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id    uuid NOT NULL REFERENCES mr_licences,
  number        text NOT NULL UNIQUE,
  kind          text NOT NULL DEFAULT 'instalment' CHECK (kind IN ('licence_fee','instalment')),
  description   text CHECK (description IS NULL OR length(description) <= 200),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  due_on        date,
  payer_id      uuid NOT NULL REFERENCES users,          -- a partner member who can act; any other such member can take it over
  status        text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','cancelled','refunded')),
  paid_at       timestamptz,
  paid_method   text CHECK (paid_method IS NULL OR paid_method IN ('online','offline')),
  offline_ref   text CHECK (offline_ref IS NULL OR length(offline_ref) <= 160),
  recorded_by   uuid REFERENCES users,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  issued_by     uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mr_fees_licence ON mr_fees (licence_id, status);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment','shop_checkout','physio_package','sponsorship_payment','academy_charge','service_invoice','media_rights_fee'));
