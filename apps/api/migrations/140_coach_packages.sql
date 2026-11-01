-- Redeemable coach session packages (issue #655). A coach_rate_cards row with unit='package' becomes a real prepaid balance.
-- Additive only: two new tables, one nullable column, one widened CHECK. Existing hires, cards and subscriptions are untouched; nothing is deleted.
-- Balance is never stored as a counter: sessions used = redemptions whose hire is still live, so a cancelled or expired hire returns its session by itself.

ALTER TABLE coach_rate_cards ADD COLUMN IF NOT EXISTS valid_days int CHECK (valid_days IS NULL OR valid_days BETWEEN 1 AND 1825);   -- package validity from payment (NULL = no expiry)

CREATE TABLE IF NOT EXISTS coach_package_purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id        uuid NOT NULL REFERENCES users,
  rate_card_id    uuid NOT NULL REFERENCES coach_rate_cards,
  sport_id        uuid REFERENCES sports,                      -- copied from the card (NULL = any sport the coach coaches)
  athlete_id      uuid NOT NULL REFERENCES users,              -- who receives the coaching
  payer_id        uuid NOT NULL REFERENCES users,              -- who pays (the athlete, or a verified guardian of a young athlete)
  title           text NOT NULL,                               -- terms are copied at purchase time; later card edits never change what was agreed
  sessions_total  int NOT NULL CHECK (sessions_total >= 1),
  price_cents     bigint NOT NULL CHECK (price_cents >= 0),
  currency        text NOT NULL,
  valid_days      int,
  status          text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','active','expired','refunded','cancelled')),
  activated_at    timestamptz,
  expires_at      timestamptz,
  expiry_notified_at timestamptz,                              -- the "expires soon" notice went out
  refunded_cents  bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  refunded_at     timestamptz,
  refunded_by     uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_pkg_payer ON coach_package_purchases (payer_id, status);
CREATE INDEX IF NOT EXISTS coach_pkg_athlete ON coach_package_purchases (athlete_id, status);
CREATE INDEX IF NOT EXISTS coach_pkg_coach ON coach_package_purchases (coach_id, status);

-- One row per hire booked with a package, so a session is never counted twice.
CREATE TABLE IF NOT EXISTS coach_package_redemptions (
  hire_id     uuid PRIMARY KEY REFERENCES coach_hires,
  purchase_id uuid NOT NULL REFERENCES coach_package_purchases,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_pkg_redemptions_purchase ON coach_package_redemptions (purchase_id);

-- A package is paid through canonical payments (the constraint is widened, never narrowed).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('coach_package' IN d) = 0 THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''coach_package''::text])');
  END IF;
END $$;
