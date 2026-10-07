-- Payments: Stripe / PayPal redirect checkout for shop orders, coach hires and insurance policies.

CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id    uuid NOT NULL REFERENCES users,
  provider    text NOT NULL CHECK (provider IN ('stripe','paypal')),
  purpose_type text NOT NULL CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy')),
  purpose_id  uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency    text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
  provider_ref text,                -- Stripe Checkout Session id / PayPal order id
  provider_payment_ref text,        -- Stripe payment_intent / PayPal capture id (needed to refund)
  created_at  timestamptz NOT NULL DEFAULT now(),
  paid_at     timestamptz,
  refunded_at timestamptz,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_purpose ON payments (purpose_type, purpose_id);
CREATE INDEX payments_payer ON payments (payer_id, created_at DESC);

-- things that can be paid for carry their own payment state
ALTER TABLE shop_orders DROP CONSTRAINT shop_orders_status_check;
ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_status_check CHECK (status IN ('awaiting_payment','placed','shipped','delivered','cancelled'));

ALTER TABLE coach_hires ADD COLUMN payment_status text NOT NULL DEFAULT 'not_required' CHECK (payment_status IN ('not_required','unpaid','paid','refunded'));

ALTER TABLE insurance_policies DROP CONSTRAINT insurance_policies_status_check;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_status_check CHECK (status IN ('pending_payment','active','expired','cancelled'));
ALTER TABLE insurance_policies ADD COLUMN amount_cents bigint;
