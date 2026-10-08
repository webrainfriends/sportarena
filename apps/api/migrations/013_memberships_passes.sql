-- Memberships (a % off every booking at a venue for a period) and multi-session passes (prepaid sessions), sold by venues.
CREATE TABLE venue_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            uuid NOT NULL REFERENCES venues,
  kind                text NOT NULL CHECK (kind IN ('membership','pass')),
  name                text NOT NULL,
  description         text,
  price_cents         int NOT NULL CHECK (price_cents > 0),
  duration_days       int CHECK (duration_days BETWEEN 1 AND 3650),             -- memberships: how long it lasts
  discount_bp         int CHECK (discount_bp BETWEEN 100 AND 9000),             -- memberships: % off every booking (1000 = 10%)
  sessions            int CHECK (sessions BETWEEN 1 AND 1000),                  -- passes: number of sessions
  session_value_cents int CHECK (session_value_cents > 0),                      -- passes: the most one session pays toward a booking
  valid_days          int CHECK (valid_days BETWEEN 1 AND 3650),                -- passes: usable for this long after purchase
  active              boolean NOT NULL DEFAULT true,                            -- false = no longer sold (existing holders keep theirs)
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'membership' AND duration_days IS NOT NULL AND discount_bp IS NOT NULL) OR (kind = 'pass' AND sessions IS NOT NULL AND session_value_cents IS NOT NULL AND valid_days IS NOT NULL))
);
CREATE INDEX venue_plans_venue ON venue_plans (venue_id) WHERE active;

-- What a person bought. The terms are copied at purchase so later edits to the plan never change what they hold.
CREATE TABLE user_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES venue_plans,
  venue_id            uuid NOT NULL REFERENCES venues,
  user_id             uuid NOT NULL REFERENCES users,
  kind                text NOT NULL CHECK (kind IN ('membership','pass')),
  name                text NOT NULL,
  status              text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','active','used_up','expired','cancelled')),
  price_cents         int NOT NULL,
  currency            text NOT NULL,
  discount_bp         int,
  sessions_total      int,
  sessions_left       int CHECK (sessions_left >= 0),
  session_value_cents int,
  duration_days       int NOT NULL,                                            -- membership length / pass validity
  starts_at           timestamptz,
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_plans_user ON user_plans (user_id, venue_id, status);
CREATE INDEX user_plans_venue ON user_plans (venue_id, status);

ALTER TABLE invoice_credits
  ADD COLUMN user_plan_id uuid REFERENCES user_plans,   -- pass credits: which pass paid, and how many sessions
  ADD COLUMN units        int NOT NULL DEFAULT 0;
ALTER TABLE invoice_credits DROP CONSTRAINT invoice_credits_source_check;
ALTER TABLE invoice_credits ADD CONSTRAINT invoice_credits_source_check CHECK (source IN ('wallet','points','pass'));

ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan'));
