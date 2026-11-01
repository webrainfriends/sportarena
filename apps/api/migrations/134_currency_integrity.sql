-- Multi-currency integrity (issue #62). Additive only: no data is removed or rewritten.
-- 1. The shop and coach hires priced in a single implicit currency (the settlement currency, INR on existing servers).
--    The currency becomes an explicit, immutable property of each product, order and hire. Existing rows are backfilled
--    with INR, which is what they were always charged in.
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE shop_orders   ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE coach_hires   ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE market_posts  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';   -- the currency of a "for sale" card's price

-- 2. The currency of a money record never changes once it exists: a user's locale or a later settings change cannot
--    re-denominate an invoice, payment, wallet movement, gift card, top-up, shop order or hire.
CREATE OR REPLACE FUNCTION forbid_currency_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'the currency of a % record cannot be changed (% -> %)', TG_TABLE_NAME, OLD.currency, NEW.currency USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices','payments','wallet_ledger','wallet_topups','gift_cards','shop_orders','coach_hires'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_currency_fixed', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF currency ON %I FOR EACH ROW EXECUTE FUNCTION forbid_currency_change()', t || '_currency_fixed', t);
  END LOOP;
END $$;
-- Rollback: DROP the *_currency_fixed triggers and forbid_currency_change(); the three columns can stay (harmless, defaulted).
