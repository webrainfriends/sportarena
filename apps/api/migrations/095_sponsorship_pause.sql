-- Pause and resume sponsorship agreements (issue #297). Additive and backwards-compatible: no row is changed or removed.
-- An accepted agreement can now be paused by agreement of both sides (one requests, the other approves) and resumed later. Every pause
-- records its reason, effective date and the agreed treatment of the dues in it: 'hold' (held dues fall due again on the resume date) or
-- 'reschedule' (they move by the length of the pause and the agreement end moves with them). Dues are never inserted, cancelled or
-- waived by a pause: they are flagged in place, so resuming cannot duplicate them and a debt cannot disappear.
-- `pause_rev` is the optimistic version callers send, so a pause/resume decided on a stale view is refused.
-- Rollback: nothing else depends on the new columns/table; restore the previous status CHECK once no row is 'paused'.
ALTER TABLE sponsorships DROP CONSTRAINT sponsorships_status_check;
ALTER TABLE sponsorships ADD CONSTRAINT sponsorships_status_check CHECK (status IN ('proposed','active','declined','ended','withdrawn','paused'));
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS pause_rev int NOT NULL DEFAULT 0;

CREATE TABLE sponsorship_pauses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id   uuid NOT NULL REFERENCES sponsorships,
  requested_by_side text NOT NULL CHECK (requested_by_side IN ('sponsor','recipient')),
  requested_by     uuid NOT NULL REFERENCES users,
  reason_code      text NOT NULL CHECK (reason_code IN ('injury','season_break','funding_review','force_majeure','other')),
  reason           text CHECK (char_length(reason) <= 500),
  policy           text NOT NULL CHECK (policy IN ('hold','reschedule')),
  effective_from   date NOT NULL,
  planned_resume_on date,
  status           text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','scheduled','active','declined','withdrawn','resumed','ended')),
  decided_by       uuid REFERENCES users,
  decided_at       timestamptz,
  decision_note    text CHECK (char_length(decision_note) <= 500),
  resumed_by       uuid REFERENCES users,
  resumed_on       date,
  resumed_at       timestamptz,
  summary          jsonb,                                  -- what the pause/resume actually did (dues held, moved, new end date)
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_resume_on IS NULL OR planned_resume_on > effective_from)
);
-- at most one open pause per agreement: concurrent requests cannot both succeed
CREATE UNIQUE INDEX sponsorship_pauses_open ON sponsorship_pauses (sponsorship_id) WHERE status IN ('requested','scheduled','active');
CREATE INDEX sponsorship_pauses_by_deal ON sponsorship_pauses (sponsorship_id, created_at);

ALTER TABLE sponsorship_obligations ADD COLUMN IF NOT EXISTS held_by_pause_id uuid REFERENCES sponsorship_pauses;
ALTER TABLE sponsorship_obligations ADD COLUMN IF NOT EXISTS original_due_on date;  -- the date before a pause moved it (kept for the record)
CREATE INDEX sponsorship_obligations_held ON sponsorship_obligations (held_by_pause_id) WHERE held_by_pause_id IS NOT NULL;
