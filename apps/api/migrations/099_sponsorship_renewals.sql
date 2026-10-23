-- Term expiry, final settlement and explicit renewals for sponsorship agreements (issue #299). Additive and backwards-compatible: no row is changed or removed.
-- The end DATE of an agreement and the SETTLEMENT of what is owed under it are now separate facts:
--   'term_expired' = the term has ended but dues are still open (nothing is marked paid, cancelled or waived by the date passing);
--   'completed'    = the term has ended AND every due is fulfilled or cancelled.
-- 'ended' keeps meaning "terminated early by a party". A renewal is never silent: it is a NEW agreement (a linked successor, `renews_id`) that
-- goes through the normal offer / negotiation / exact-version acceptance flow, so the predecessor and its financial history stay untouched.
-- `renewal_rev` is the version callers send so an intent or proposal made on a stale view is refused (409).
-- Rollback: nothing else depends on the new columns/tables; restore the previous status CHECK once no row is 'term_expired' or 'completed'.
ALTER TABLE sponsorships DROP CONSTRAINT sponsorships_status_check;
ALTER TABLE sponsorships ADD CONSTRAINT sponsorships_status_check CHECK (status IN ('proposed','active','declined','ended','withdrawn','paused','term_expired','completed'));
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS renews_id uuid REFERENCES sponsorships;      -- the agreement this one succeeds
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS renewal_rev int NOT NULL DEFAULT 0;
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS term_expired_at timestamptz;                   -- when the worker saw the term end
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS settled_at timestamptz;                        -- when the last due was fulfilled or cancelled after expiry
ALTER TABLE sponsorships ADD CONSTRAINT sponsorships_not_own_successor CHECK (renews_id IS NULL OR renews_id <> id);
-- at most one live successor per agreement: two concurrent proposals cannot both succeed
CREATE UNIQUE INDEX IF NOT EXISTS sponsorships_one_successor ON sponsorships (renews_id) WHERE renews_id IS NOT NULL AND status NOT IN ('declined','withdrawn');
CREATE INDEX IF NOT EXISTS sponsorships_expiry ON sponsorships (ends_on) WHERE status IN ('active','term_expired');

-- Each side's current intention about renewing. The row is updated in place (one per side); every change is also in sponsorship_history.
CREATE TABLE IF NOT EXISTS sponsorship_renewal_assessments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  side           text NOT NULL CHECK (side IN ('sponsor','recipient')),
  intent         text NOT NULL CHECK (intent IN ('renew','renegotiate','not_renew')),
  note           text CHECK (char_length(note) <= 500),
  decided_by     uuid NOT NULL REFERENCES users,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sponsorship_id, side)
);

-- One row per reminder actually sent, so the scheduled job can run any number of times (or on two workers) and notify exactly once.
CREATE TABLE IF NOT EXISTS sponsorship_renewal_notices (
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  milestone      text NOT NULL CHECK (milestone IN ('d60','d30','d7','expired','settled')),
  sent_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sponsorship_id, milestone)
);
