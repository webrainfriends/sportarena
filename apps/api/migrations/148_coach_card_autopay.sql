-- Automatic card-on-file charging for coach subscriptions (#680). Additive only; nothing is dropped, rewritten or narrowed.
-- It extends the one mandate system (payment_mandates, #694) with a Stripe card method. Raw card data never reaches us: only the
-- provider's customer and payment-method ids (encrypted, context payment_mandates.customer / payment_mandates.pm) and display fields.

-- 1. A mandate can now be held with Stripe, as a saved card.
DO $$
DECLARE con text;
BEGIN
  FOR con IN SELECT conname FROM pg_constraint WHERE conrelid = 'payment_mandates'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%provider%razorpay%' LOOP
    EXECUTE format('ALTER TABLE payment_mandates DROP CONSTRAINT %I', con);
  END LOOP;
END $$;
ALTER TABLE payment_mandates ADD CONSTRAINT payment_mandates_provider_check CHECK (provider IN ('razorpay','stripe'));

ALTER TABLE payment_mandates
  ADD COLUMN IF NOT EXISTS method          text NOT NULL DEFAULT 'upi' CHECK (method IN ('upi','card')),
  ADD COLUMN IF NOT EXISTS customer_enc    text,
  ADD COLUMN IF NOT EXISTS payment_method_enc text,
  ADD COLUMN IF NOT EXISTS card_brand      text,
  ADD COLUMN IF NOT EXISTS card_last4      text,
  ADD COLUMN IF NOT EXISTS card_exp        text,
  ADD COLUMN IF NOT EXISTS consent_by      uuid REFERENCES users(id),   -- the verified guardian who allowed it, when the subscriber is a young person
  ADD COLUMN IF NOT EXISTS consent_at      timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_reason  text;

-- 2. One row per charge attempt. The unique key is the idempotency key of the charge: a retry of the same attempt can never add a second row,
--    and a partial unique index guarantees at most one successful (or in-flight) charge per subscription period.
CREATE TABLE IF NOT EXISTS mandate_charges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES payment_mandates(id),
  subscription_id uuid NOT NULL REFERENCES coach_subscriptions(id),
  period_no       int  NOT NULL,
  attempt         int  NOT NULL,
  payment_id      uuid REFERENCES payments(id),
  provider_ref    text,
  amount_minor    bigint NOT NULL,
  currency        text NOT NULL,
  status          text NOT NULL DEFAULT 'started' CHECK (status IN ('started','processing','succeeded','failed')),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_no, attempt)
);
CREATE UNIQUE INDEX IF NOT EXISTS mandate_charges_one_per_period ON mandate_charges (subscription_id, period_no) WHERE status IN ('processing','succeeded');
CREATE INDEX IF NOT EXISTS mandate_charges_mandate ON mandate_charges (mandate_id, created_at DESC);
