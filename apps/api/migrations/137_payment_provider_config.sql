-- Platform-admin managed payment provider keys (#694). Values are field-level encrypted (value_enc, via crypto.js) and never returned by any API:
-- only the last four characters and where the live value comes from are shown. A value that is cleared is kept as a row with cleared_at set
-- (soft clear), so the history of who changed what stays in the audit log. Environment variables remain the fallback when no value is stored.
CREATE TABLE IF NOT EXISTS payment_provider_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider IN ('stripe','paypal','razorpay')),
  key         text NOT NULL CHECK (key ~ '^[a-z_]{2,40}$'),
  value_enc   text,
  last4       text CHECK (last4 IS NULL OR char_length(last4) <= 4),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  UNIQUE (provider, key)
);
