-- Guardian payee for a young athlete's sponsorship money (issue #307).
-- Additive only: two nullable columns. Existing agreements and payments are untouched (null = paid to the recipient as before).
-- Rollback = deploy the previous code; the columns are simply unused.
ALTER TABLE sponsorships ADD COLUMN payee_guardian_id uuid REFERENCES users;
-- The payee is frozen on each payment when it is reported / its checkout opens, so a later change never rewrites who was to be paid.
ALTER TABLE sponsorship_payments ADD COLUMN payee_guardian_id uuid REFERENCES users;
