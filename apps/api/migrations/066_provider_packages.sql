-- Physio/doctor prepaid session packages (issue #210, slice 3). Additive only (the payments purpose check is widened, as in earlier migrations).
-- A package is a provider-defined bundle of sessions of one service. A purchase snapshots the terms; sessions are redeemed at booking.
CREATE TABLE provider_packages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES users,
  service_id    uuid NOT NULL REFERENCES provider_services,
  title         text NOT NULL,
  sessions      int NOT NULL CHECK (sessions BETWEEN 2 AND 100),
  price_cents   bigint NOT NULL CHECK (price_cents >= 0),
  currency      text NOT NULL,
  tax_class     text NOT NULL DEFAULT 'unspecified' CHECK (tax_class IN ('unspecified','taxable','exempt','zero_rated','out_of_scope')),
  valid_days    int CHECK (valid_days BETWEEN 1 AND 1825),      -- usable for this many days after payment; NULL = no expiry
  refund_terms  text,                                          -- shown before purchase
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient_packages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id     uuid NOT NULL REFERENCES provider_packages,
  provider_id    uuid NOT NULL REFERENCES users,
  patient_id     uuid NOT NULL REFERENCES users,
  service_id     uuid NOT NULL REFERENCES provider_services,
  title          text NOT NULL,
  sessions_total int NOT NULL,
  price_cents    bigint NOT NULL,
  currency       text NOT NULL,
  tax_class      text NOT NULL,
  valid_days     int,
  refund_terms   text,
  status         text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','active','cancelled')),
  activated_at   timestamptz,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_packages_patient ON patient_packages (patient_id, created_at DESC);

-- one session redeemed per appointment (unique): retries cannot spend two; a cancelled/expired appointment gives its session back
CREATE TABLE package_redemptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_package_id uuid NOT NULL REFERENCES patient_packages,
  appointment_id     uuid NOT NULL UNIQUE REFERENCES appointments,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX package_redemptions_pkg ON package_redemptions (patient_package_id);

ALTER TABLE appointments ADD COLUMN patient_package_id uuid REFERENCES patient_packages;

ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment','shop_checkout','physio_package'));
