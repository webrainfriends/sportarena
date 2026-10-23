-- Beneficiary portfolio (#292). Purely additive: the portfolio is a read model over the existing sponsorships, applications, awards, obligations and
-- payments (no second ledger, no new data), so this migration only adds indexes for the by-beneficiary lookups it makes. Nothing is dropped,
-- rewritten or deleted. Rollback = deploy the previous code; the indexes are harmless and can stay.
CREATE INDEX IF NOT EXISTS sponsorships_target ON sponsorships (target_type, target_id, status);
CREATE INDEX IF NOT EXISTS sponsorship_applications_target ON sponsorship_applications (target_type, target_id, status);
CREATE INDEX IF NOT EXISTS sponsorship_reviews_next ON sponsorship_reviews (sponsorship_id, created_at DESC, id) WHERE visibility = 'shared';
