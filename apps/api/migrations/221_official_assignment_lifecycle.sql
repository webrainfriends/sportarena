-- Official assignment lifecycle – REF-R01 (#992). Additive only.
-- Adds: proposed, confirmed, expired, replaced states; invitation deadline; ack metadata; replace chain.

-- Extend status check to include the four new lifecycle states.
ALTER TABLE fixture_officials DROP CONSTRAINT IF EXISTS fixture_officials_status_check;
ALTER TABLE fixture_officials ADD CONSTRAINT fixture_officials_status_check
  CHECK (status IN (
    'invited','proposed','accepted','confirmed',
    'declined','expired','withdrawn','released','replaced','cancelled','completed','substituted'
  ));

-- invitation_deadline: when an invited/proposed assignment automatically expires if unresponded.
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS invitation_deadline timestamptz;

-- ack_required_reason: human-readable description of what changed (time, venue, etc.) requiring re-ack.
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS ack_required_reason text CHECK (ack_required_reason IS NULL OR length(ack_required_reason) <= 500);

-- ack_at: when the official acknowledged the most recent schedule change.
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS ack_at timestamptz;

-- confirmed_at: when the organiser explicitly confirmed this assignment (invited/accepted → confirmed).
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- confirmed_by: organiser who triggered the confirm-crew action.
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES users(id);

-- deadline_notified_at: when the 24-hour deadline warning was sent so we do not spam.
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS deadline_notified_at timestamptz;

-- replace_of: FK back to the assignment this one replaced (organiser pre-match replacement chain).
-- Distinct from substitution_of (mid-match emergency swap).
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS replace_of uuid REFERENCES fixture_officials(id);

-- Extend the unique-open index to cover proposed and confirmed as well as invited and accepted.
-- A person cannot hold two open assignments on the same fixture for the same role.
DROP INDEX IF EXISTS fixture_officials_one_open;
CREATE UNIQUE INDEX fixture_officials_one_open
  ON fixture_officials(fixture_id, user_id, role)
  WHERE status IN ('invited','proposed','accepted','confirmed');

-- Index for efficient expiry sweep (scheduler or inline on accept): find all past-deadline open assignments.
CREATE INDEX IF NOT EXISTS fixture_officials_deadline
  ON fixture_officials(invitation_deadline)
  WHERE invitation_deadline IS NOT NULL AND status IN ('invited','proposed');

-- Extend the role check to match migration 201_official_role_taxonomy.sql (add chair_umpire, etc. if not present).
ALTER TABLE fixture_officials DROP CONSTRAINT IF EXISTS fixture_officials_role_check;
ALTER TABLE fixture_officials ADD CONSTRAINT fixture_officials_role_check
  CHECK (role IN (
    'referee','umpire','linesman','scorer',
    'video_assistant_referee','fourth_official','reserve_assistant_referee',
    'shot_clock_operator','timekeeper','goal_line_official','technical_official',
    'chair_umpire','match_commissioner','technical_delegate','starter','marshal'
  ));

-- Extend event_crew_requirements role check to match (if that table exists).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='event_crew_requirements') THEN
    ALTER TABLE event_crew_requirements DROP CONSTRAINT IF EXISTS event_crew_requirements_role_check;
    ALTER TABLE event_crew_requirements ADD CONSTRAINT event_crew_requirements_role_check
      CHECK (role IN (
        'referee','umpire','linesman','scorer',
        'video_assistant_referee','fourth_official','reserve_assistant_referee',
        'shot_clock_operator','timekeeper','goal_line_official','technical_official',
        'chair_umpire','match_commissioner','technical_delegate','starter','marshal'
      ));
  END IF;
END $$;
