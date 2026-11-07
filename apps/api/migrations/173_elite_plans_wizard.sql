-- Elite plans wizard: tier, emoji, tagline, capacity cap, joining fee,
-- coaching hours, priority booking lead, sport scope, and early-bird pricing.
-- All columns are additive; existing rows get safe defaults.
ALTER TABLE venue_plans
  ADD COLUMN IF NOT EXISTS tier                       TEXT,
  ADD COLUMN IF NOT EXISTS emoji                      TEXT,
  ADD COLUMN IF NOT EXISTS tagline                    TEXT,
  ADD COLUMN IF NOT EXISTS max_members                INTEGER,
  ADD COLUMN IF NOT EXISTS joining_fee_cents          INTEGER,
  ADD COLUMN IF NOT EXISTS coaching_hours             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS booking_lead_priority_hours INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sport_slugs               TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS early_bird_price_cents     INTEGER,
  ADD COLUMN IF NOT EXISTS early_bird_days            INTEGER;

ALTER TABLE venue_plans
  DROP CONSTRAINT IF EXISTS venue_plans_tier_check;
ALTER TABLE venue_plans
  ADD CONSTRAINT venue_plans_tier_check
    CHECK (tier IS NULL OR tier IN ('bronze', 'silver', 'gold', 'platinum', 'elite'));

COMMENT ON COLUMN venue_plans.tier IS 'bronze | silver | gold | platinum | elite – display ordering and UI theming';
COMMENT ON COLUMN venue_plans.emoji IS 'emoji badge shown on the plan card and member wallet';
COMMENT ON COLUMN venue_plans.tagline IS 'one-line marketing tagline shown to athletes browsing plans';
COMMENT ON COLUMN venue_plans.max_members IS 'stop selling when this many active holders exist; NULL = unlimited';
COMMENT ON COLUMN venue_plans.joining_fee_cents IS 'one-time fee charged alongside the first membership price, in minor units of venue currency';
COMMENT ON COLUMN venue_plans.coaching_hours IS 'included coaching hours per period (0 = none)';
COMMENT ON COLUMN venue_plans.booking_lead_priority_hours IS 'members may book this many hours before non-members; 0 = no priority';
COMMENT ON COLUMN venue_plans.sport_slugs IS 'restrict to these sport slugs; empty array = all sports at the venue';
COMMENT ON COLUMN venue_plans.early_bird_price_cents IS 'discounted intro price for the first early_bird_days days; NULL = no intro offer';
COMMENT ON COLUMN venue_plans.early_bird_days IS 'how many days after the plan goes on sale the early-bird price applies';
