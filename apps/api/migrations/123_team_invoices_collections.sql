-- Teams join the canonical invoices and the recurring-collections desk (#516 follow-up). Additive only: constraints are widened, nothing is dropped,
-- rewritten or narrowed, and every existing row still satisfies them.

-- ---------------------------------------------------------------------------------------------------------------- invoices
-- A team charge is invoiced in the same invoices table as venue bookings and academy fees: numbered, gapless per team and kind, never edited once paid.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS team_charge_id uuid REFERENCES team_charges;
-- the existing arms (venue booking, academy fee, supplier order, front-desk sale) are read and kept; a team charge is one more arm
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'invoices_source' AND conrelid = 'invoices'::regclass;
  IF d IS NOT NULL AND d NOT LIKE '%team_charge_id%' THEN
    ALTER TABLE invoices DROP CONSTRAINT invoices_source;
    EXECUTE 'ALTER TABLE invoices ADD CONSTRAINT invoices_source ' || left(d, length(d) - 1)
      || ' OR (venue_id IS NULL AND reservation_id IS NULL AND organisation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NULL AND pos_sale_id IS NULL AND team_charge_id IS NOT NULL AND team_id IS NOT NULL))';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_team_live ON invoices (team_charge_id) WHERE kind = 'invoice' AND status IN ('open','paid');
CREATE INDEX IF NOT EXISTS invoices_team ON invoices (team_id, issued_at DESC) WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_invoice_counters (
  team_id uuid NOT NULL REFERENCES teams,
  kind    text NOT NULL CHECK (kind IN ('invoice','credit_note')),
  seq     int  NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, kind)
);

-- ---------------------------------------------------------------------------------------------------------------- collections
-- A team is a third owner of collection cases and policies, and a team charge a third kind of source. Late fees and suspension stay off for teams.
ALTER TABLE collection_cases DROP CONSTRAINT IF EXISTS collection_cases_owner_type_check;
ALTER TABLE collection_cases ADD CONSTRAINT collection_cases_owner_type_check CHECK (owner_type IN ('organisation','venue','team'));
ALTER TABLE collection_cases DROP CONSTRAINT IF EXISTS collection_cases_source_type_check;
ALTER TABLE collection_cases ADD CONSTRAINT collection_cases_source_type_check CHECK (source_type IN ('academy_charge','venue_plan','team_charge'));
ALTER TABLE collection_policies DROP CONSTRAINT IF EXISTS collection_policies_owner_type_check;
ALTER TABLE collection_policies ADD CONSTRAINT collection_policies_owner_type_check CHECK (owner_type IN ('organisation','venue','team'));
