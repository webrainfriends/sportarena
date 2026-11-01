-- Recurring monthly coaching (issue #659). A coach_rate_cards row with unit='month' becomes a real subscription.
-- No new billing system: each billing period is a user_plans row (the same table venue memberships and academy fees use, paid through canonical
-- payments), chained by period number; coach_subscriptions is only the agreement that owns the chain. Everything here is additive.

ALTER TABLE coach_rate_cards
  ADD COLUMN IF NOT EXISTS rollover_max int NOT NULL DEFAULT 0 CHECK (rollover_max BETWEEN 0 AND 100),   -- unused sessions carried into the next period (0 = none)
  ADD COLUMN IF NOT EXISTS grace_days   int NOT NULL DEFAULT 3 CHECK (grace_days BETWEEN 0 AND 30);      -- days after a missed payment before the entitlement lapses

CREATE TABLE IF NOT EXISTS coach_subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id            uuid NOT NULL REFERENCES users,
  rate_card_id        uuid NOT NULL REFERENCES coach_rate_cards,
  athlete_id          uuid NOT NULL REFERENCES users,          -- who receives the coaching
  payer_id            uuid NOT NULL REFERENCES users,          -- who pays (the athlete, or a verified guardian of a young athlete)
  title               text NOT NULL,                           -- terms copied at subscribe time; later card edits never change what was agreed
  price_cents         bigint NOT NULL CHECK (price_cents > 0),
  currency            text NOT NULL,
  sessions_per_period int NOT NULL CHECK (sessions_per_period >= 0),
  rollover_max        int NOT NULL DEFAULT 0,
  grace_days          int NOT NULL DEFAULT 3,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','past_due','lapsed','cancelled')),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  paused_at           timestamptz,
  lapsed_at           timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- one live subscription per athlete per card
CREATE UNIQUE INDEX IF NOT EXISTS coach_subscriptions_live ON coach_subscriptions (rate_card_id, athlete_id) WHERE status IN ('active','paused','past_due');
CREATE INDEX IF NOT EXISTS coach_subscriptions_coach ON coach_subscriptions (coach_id, status);
CREATE INDEX IF NOT EXISTS coach_subscriptions_payer ON coach_subscriptions (payer_id, status);
CREATE INDEX IF NOT EXISTS coach_subscriptions_athlete ON coach_subscriptions (athlete_id, status);

-- A period is a user_plans row (kind 'pass': included sessions, a validity window). Owned by a coach instead of a venue or an organisation.
ALTER TABLE user_plans ALTER COLUMN plan_id DROP NOT NULL;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS coach_id uuid REFERENCES users;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES coach_subscriptions;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS period_no int CHECK (period_no IS NULL OR period_no >= 1);
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS due_on date;                 -- when this period's payment falls due (the previous period's end)
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS carried_sessions int NOT NULL DEFAULT 0;   -- sessions rolled over from the previous period
ALTER TABLE user_plans DROP CONSTRAINT IF EXISTS user_plans_owner;
ALTER TABLE user_plans ADD CONSTRAINT user_plans_owner CHECK (
  (venue_id IS NOT NULL AND organisation_id IS NULL AND coach_id IS NULL)
  OR (venue_id IS NULL AND organisation_id IS NOT NULL AND coach_id IS NULL)
  OR (venue_id IS NULL AND organisation_id IS NULL AND coach_id IS NOT NULL AND subscription_id IS NOT NULL AND period_no IS NOT NULL));
-- the idempotency key: one period of one subscription exists once, however many sweeps or retries run
CREATE UNIQUE INDEX IF NOT EXISTS user_plans_sub_period ON user_plans (subscription_id, period_no) WHERE subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_plans_coach ON user_plans (coach_id, status) WHERE coach_id IS NOT NULL;

-- A session booked with a subscription's included sessions. One row per hire; the session comes back if the hire is cancelled.
CREATE TABLE IF NOT EXISTS coach_subscription_redemptions (
  hire_id      uuid PRIMARY KEY REFERENCES coach_hires,
  user_plan_id uuid NOT NULL REFERENCES user_plans,
  restored_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_sub_redemptions_plan ON coach_subscription_redemptions (user_plan_id);
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS carry_settled_at timestamptz;   -- when rolled-over sessions were moved into this period

-- A period is paid through canonical payments (the constraint is widened, never narrowed).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('coach_subscription_period' IN d) = 0 THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''coach_subscription_period''::text])');
  END IF;
END $$;
