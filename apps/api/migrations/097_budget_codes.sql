-- Unique budget code (BUD-00042): the tag a budget carries everywhere it is shown, so programs, awards, agreements and payments can be
-- traced back to it and a budget can be quoted unambiguously. Additive: one nullable-then-filled column, one sequence, one unique index.
-- Existing budgets are backfilled in creation order (only rows without a code are touched); nothing is dropped, rewritten or deleted.
CREATE SEQUENCE IF NOT EXISTS sponsorship_budget_code_seq;
ALTER TABLE sponsorship_budgets ADD COLUMN IF NOT EXISTS code text;
UPDATE sponsorship_budgets b SET code = 'BUD-' || lpad(nextval('sponsorship_budget_code_seq')::text, 5, '0')
  FROM (SELECT id FROM sponsorship_budgets WHERE code IS NULL ORDER BY created_at, id) o WHERE b.id = o.id;
ALTER TABLE sponsorship_budgets ALTER COLUMN code SET DEFAULT ('BUD-' || lpad(nextval('sponsorship_budget_code_seq')::text, 5, '0'));
ALTER TABLE sponsorship_budgets ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_budgets_code ON sponsorship_budgets (code);
