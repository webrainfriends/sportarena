-- Lifecycle: a request nobody answered before it was due becomes `expired` (a final state, like cancelled).
-- Additive: the two CHECK constraints are only widened; no row is changed or removed.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('requested','confirmed','completed','cancelled','expired'));
ALTER TABLE coach_hires DROP CONSTRAINT IF EXISTS coach_hires_status_check;
ALTER TABLE coach_hires ADD CONSTRAINT coach_hires_status_check
  CHECK (status IN ('requested','confirmed','completed','cancelled','expired'));
