-- Sponsorship checkout, payouts and reconciliation (issue #294). Additive and backwards-compatible: no row is changed or removed.
-- A sponsor can now pay a money due online (Stripe / PayPal) through the canonical `payments` flow. The online payment is a
-- `sponsorship_payments` row (method 'online') that starts 'awaiting_payment' and becomes 'confirmed' ONLY when the verified provider
-- result settles the payment, so manual reports ('reported') stay unverified until the recipient confirms them. What the recipient is then
-- owed lives in the existing #71 provider_ledger / payouts; nothing here is a second ledger.
-- Rollback: nothing else depends on the new columns; restore the previous CHECK lists (no rows use the new values until online checkout is used).
ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment','shop_checkout','physio_package','sponsorship_payment'));

ALTER TABLE sponsorship_payments DROP CONSTRAINT sponsorship_payments_status_check;
ALTER TABLE sponsorship_payments ADD CONSTRAINT sponsorship_payments_status_check CHECK (status IN ('reported','confirmed','rejected','reversed','awaiting_payment','failed'));
ALTER TABLE sponsorship_payments DROP CONSTRAINT sponsorship_payments_method_check;
ALTER TABLE sponsorship_payments ADD CONSTRAINT sponsorship_payments_method_check CHECK (method IN ('bank_transfer','cash','other','online'));
ALTER TABLE sponsorship_payments ADD COLUMN payment_id uuid REFERENCES payments;                          -- the provider checkout behind an online payment
ALTER TABLE sponsorship_payments ADD COLUMN refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0);  -- given back to the sponsor (confirmed money is net of this)
CREATE UNIQUE INDEX sponsorship_payments_payment ON sponsorship_payments (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX sponsorship_payments_awaiting ON sponsorship_payments (obligation_id) WHERE status = 'awaiting_payment';
