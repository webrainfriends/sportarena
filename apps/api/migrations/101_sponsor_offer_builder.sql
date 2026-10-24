-- Sponsor offer builder (#309): a client-generated reference makes "send offer" safe to retry (a timeout or a double tap returns the
-- offer already made instead of a second one). Purely additive and backwards-compatible: one nullable column and a partial unique index;
-- existing agreements, terms, payments and history are untouched and nothing is dropped, rewritten or deleted.
-- Rollback = deploy the previous code: the column is simply unused.
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS client_ref text CHECK (client_ref IS NULL OR length(client_ref) BETWEEN 8 AND 80);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorships_client_ref ON sponsorships (proposed_by, client_ref) WHERE client_ref IS NOT NULL;
