-- Premium live game centre (#578). Additive only: one nullable column, no existing data is read differently or changed.
-- NULL = every module the data supports is shown (the previous behaviour plus the new ones); a list = only those modules.
-- Rollback: the column is read only by the live-centre projection; leaving it in place is harmless.
ALTER TABLE events ADD COLUMN IF NOT EXISTS public_modules text[];
