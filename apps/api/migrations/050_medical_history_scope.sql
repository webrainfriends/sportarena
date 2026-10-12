-- Least-privilege historical access (issue #59). A grant now says how far back the provider may read other authors' records:
--   since_grant : records the provider wrote themselves, plus anything written from the moment of the grant (default for new grants)
--   all         : the athlete's whole history (the athlete's explicit choice)
-- Grants that already exist were given on the understanding that they showed the full history, so they are backfilled to 'all'
-- (nothing the athlete already consented to changes; they can narrow it by granting again). Additive and non-destructive.
ALTER TABLE medical_grants ADD COLUMN IF NOT EXISTS history_scope text NOT NULL DEFAULT 'all' CHECK (history_scope IN ('since_grant','all'));
ALTER TABLE medical_grants ALTER COLUMN history_scope SET DEFAULT 'since_grant';
