-- Structured coach feedback on training sessions (coaching module enhancement).
-- Additive only: new nullable columns alongside the existing coach_feedback text field.

ALTER TABLE training_sessions
  ADD COLUMN IF NOT EXISTS coach_effort_rating  smallint CHECK (coach_effort_rating BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS coach_technical_notes text,
  ADD COLUMN IF NOT EXISTS coach_tactical_notes  text,
  ADD COLUMN IF NOT EXISTS coach_physical_notes  text,
  ADD COLUMN IF NOT EXISTS coach_next_focus      text;
