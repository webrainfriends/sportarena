-- A quote can carry the insurer's own terms in plain words (what is included, special conditions, discounts), and an insurer may
-- answer one request with several plans. Additive only.
ALTER TABLE insurance_quotes ADD COLUMN IF NOT EXISTS details text;
