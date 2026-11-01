-- Country-wise payment methods (platform admin switch), Razorpay as a third provider, and the India GST billing profile (#694, #503).
-- Additive only: nothing is dropped or rewritten; rows in payment_method_countries are flipped, never deleted.

-- 1. Which payment method is switched on in which country. A country/method with no row is OFF.
CREATE TABLE IF NOT EXISTS payment_method_countries (
  country     text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  method      text NOT NULL CHECK (method IN ('card','paypal','upi','netbanking','wallet')),
  enabled     boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country, method)
);

-- Keep today's behaviour: card and PayPal were usable everywhere, so every country that already has an address on file
-- (plus India) starts with them ON. Anything else starts OFF until the platform admin enables it.
INSERT INTO payment_method_countries (country, method, enabled)
SELECT c.country, m.method, true
  FROM (SELECT DISTINCT country FROM addresses WHERE country IS NOT NULL UNION SELECT 'IN') c
  CROSS JOIN (VALUES ('card'), ('paypal')) m(method)
ON CONFLICT DO NOTHING;

-- 2. Razorpay joins Stripe and PayPal; remember which method family and country each payment used.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('stripe','paypal','razorpay'));
ALTER TABLE payments ADD COLUMN IF NOT EXISTS method text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

-- 3. India GST billing profile per organisation / venue / coach.
CREATE TABLE IF NOT EXISTS gst_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind      text NOT NULL CHECK (owner_kind IN ('organisation','venue','user')),
  owner_id        uuid NOT NULL,
  gstin           text NOT NULL CHECK (gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'),
  state_code      text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),     -- first two digits of the GSTIN, kept explicit for place-of-supply maths
  legal_name      text,
  default_sac     text CHECK (default_sac IS NULL OR default_sac ~ '^[0-9]{4,8}$'),
  tax_inclusive   boolean NOT NULL DEFAULT true,
  rate_bp         integer NOT NULL DEFAULT 1800 CHECK (rate_bp BETWEEN 0 AND 4000),
  archived_at     timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gst_profiles_owner ON gst_profiles (owner_kind, owner_id) WHERE archived_at IS NULL;

-- CGST/SGST/IGST split frozen on the document when it is issued (older invoices keep NULL and are untouched).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_breakup jsonb;
