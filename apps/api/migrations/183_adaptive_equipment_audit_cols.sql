-- PS-18 (#848) additive: add workflow-audit columns that the adaptive_equipment capability
-- references but were absent from the initial 182 migration. All are nullable and backwards-
-- compatible — existing rows default to NULL, no data is altered.

ALTER TABLE adaptive_assets    ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users; -- backcompat: allow null for legacy rows

ALTER TABLE adaptive_loans
  ADD COLUMN IF NOT EXISTS deposit_amount_cents bigint,
  ADD COLUMN IF NOT EXISTS confirmed_by         uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS confirmed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS handed_over_by       uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS returned_to          uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS cancelled_by         uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS requested_by         uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS venue_id             uuid REFERENCES venues;

ALTER TABLE adaptive_loan_incidents
  ADD COLUMN IF NOT EXISTS photos_available     boolean NOT NULL DEFAULT false;

ALTER TABLE adaptive_event_allocations
  ADD COLUMN IF NOT EXISTS allocated_by         uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS cancelled_by         uuid REFERENCES users;

ALTER TABLE adaptive_fittings
  ADD COLUMN IF NOT EXISTS outcome_recorded_at  timestamptz,
  ADD COLUMN IF NOT EXISTS requested_by         uuid REFERENCES users;

ALTER TABLE adaptive_service_records
  ADD COLUMN IF NOT EXISTS recorded_by          uuid REFERENCES users;

ALTER TABLE adaptive_athlete_equipment
  ADD COLUMN IF NOT EXISTS updated_at           timestamptz NOT NULL DEFAULT now();
