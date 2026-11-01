-- Coach series become one commercial thing: a block price with an optional coach-defined discount, paid once or per date,
-- with skipped / rescheduled dates and a pro-rata cancel. Additive only: nothing is dropped, narrowed or rewritten, and
-- every existing series keeps working exactly as before (per-date payment, no discount).

-- the coach's block offer lives on the rate card (0 % = no discount; the rule is snapshotted onto each series at booking)
ALTER TABLE coach_rate_cards ADD COLUMN IF NOT EXISTS block_min_sessions int NOT NULL DEFAULT 4;
ALTER TABLE coach_rate_cards ADD COLUMN IF NOT EXISTS block_discount_pct numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE coach_rate_cards ADD COLUMN IF NOT EXISTS allow_pay_per_date boolean NOT NULL DEFAULT true;
DO $$ BEGIN
  ALTER TABLE coach_rate_cards ADD CONSTRAINT coach_rate_cards_block_chk CHECK (block_min_sessions BETWEEN 2 AND 60 AND block_discount_pct >= 0 AND block_discount_pct <= 90);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- the series itself: price, discount, how it is paid, and where it stands
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS rate_card_id uuid REFERENCES coach_rate_cards;
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS pay_mode text NOT NULL DEFAULT 'per_date';
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS list_total_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS discount_pct numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS discount_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS total_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS anchor_hire_id uuid REFERENCES coach_hires;   -- the hire a pay-once checkout is raised on
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES payments;          -- the single payment of a pay-once series
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users;
ALTER TABLE coach_series ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN
  ALTER TABLE coach_series ADD CONSTRAINT coach_series_status_chk CHECK (status IN ('active','cancelled','completed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coach_series ADD CONSTRAINT coach_series_pay_mode_chk CHECK (pay_mode IN ('once','per_date'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- each date: its undiscounted price (total_cents becomes the date's share of the block price), whether it was skipped, and where it moved from
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS list_cents bigint;
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS series_state text;
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS rescheduled_from timestamptz;
DO $$ BEGIN
  ALTER TABLE coach_hires ADD CONSTRAINT coach_hires_series_state_chk CHECK (series_state IS NULL OR series_state IN ('booked','skipped'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- backfill so existing series read the same under the new shape: list price = what was charged, totals = sum of their hires
UPDATE coach_hires SET list_cents = total_cents WHERE list_cents IS NULL;
UPDATE coach_hires SET series_state = 'booked' WHERE series_id IS NOT NULL AND series_state IS NULL;
UPDATE coach_series s SET
  list_total_cents = t.total, total_cents = t.total, currency = t.currency, rate_card_id = t.card
  FROM (SELECT series_id, sum(total_cents) FILTER (WHERE status <> 'cancelled' AND status <> 'expired') AS total, min(currency) AS currency, (array_agg(rate_card_id))[1] AS card
          FROM coach_hires WHERE series_id IS NOT NULL GROUP BY series_id) t
 WHERE s.id = t.series_id AND s.total_cents = 0 AND t.total IS NOT NULL;

CREATE INDEX IF NOT EXISTS coach_series_hirer ON coach_series (hirer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS coach_series_coach ON coach_series (coach_id, created_at DESC);
