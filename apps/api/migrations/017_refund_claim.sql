-- Credit-note refunds are claimed with a lease so two callers (the post-cancellation kick, the worker, another instance)
-- can never process the same refund at once. Additive column; no data changes.
ALTER TABLE invoices ADD COLUMN refund_claimed_at timestamptz;
