-- Academy OS 1/3 follow-up: a trial is a seat on a published `trial` session of the Academy OS 2/3 timetable. The seat is the existing guest
-- attendance row (so rosters, capacity and attendance stay one fact); it is linked to the application that asked for the trial. Additive only.
ALTER TABLE academy_attendance ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES academy_applications;
ALTER TABLE academy_attendance ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
-- one pending (expected) trial seat per application; earlier seats keep their own outcome (attended, absent, excused) as history
CREATE UNIQUE INDEX IF NOT EXISTS academy_attendance_trial_live ON academy_attendance (application_id)
  WHERE application_id IS NOT NULL AND status = 'expected';
CREATE INDEX IF NOT EXISTS academy_attendance_application ON academy_attendance (application_id) WHERE application_id IS NOT NULL;
