-- Coaching hub: an evaluation can hang off any coaching session (class, 1:1 booking, academy session, game, team session), not only a class.
-- Additive only: new nullable link columns, a widened context list (every old value still allowed), and a backfill of session_record_id for class evaluations.
ALTER TABLE coaching_evaluations ADD COLUMN IF NOT EXISTS hire_id uuid REFERENCES coach_hires(id);
ALTER TABLE coaching_evaluations ADD COLUMN IF NOT EXISTS fixture_id uuid REFERENCES fixtures(id);
ALTER TABLE coaching_evaluations ADD COLUMN IF NOT EXISTS academy_session_id uuid REFERENCES academy_sessions(id);
ALTER TABLE coaching_evaluations DROP CONSTRAINT IF EXISTS coaching_evaluations_context_type_check;
ALTER TABLE coaching_evaluations ADD CONSTRAINT coaching_evaluations_context_type_check
  CHECK (context_type IN ('class','session','period','match','trial','custom','booking','academy','game'));
CREATE INDEX IF NOT EXISTS coaching_evaluations_session ON coaching_evaluations (session_record_id) WHERE session_record_id IS NOT NULL;
UPDATE coaching_evaluations e SET session_record_id = r.id
  FROM coaching_session_records r
 WHERE e.session_record_id IS NULL AND e.class_id IS NOT NULL AND r.coach_id = e.coach_id AND r.source_type = 'coach_class' AND r.source_id = e.class_id::text;
