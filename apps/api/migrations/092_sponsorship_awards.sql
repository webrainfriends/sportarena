-- Award approvals and conditional sponsorship offers (#289). Purely additive and backwards-compatible: an award is now a governed
-- stage between "the brand decided to fund an application" and "the recipient accepted exact terms and the ONE canonical agreement
-- (a sponsorships row) exists". Existing agreements, applications and awards (which already have their agreement) are untouched and
-- keep counting against the program budget through sponsorship_applications. Nothing is dropped, rewritten or deleted; no
-- ON DELETE CASCADE; awards are withdrawn/expired (status), never deleted.
-- Rollback = deploy the previous code: the new nullable/defaulted program columns and the new tables are simply unused. Awards that
-- are still pending when you roll back never created an agreement; their application is still 'submitted' and can be decided again.

ALTER TABLE sponsorship_programs ADD COLUMN IF NOT EXISTS award_approval_cents bigint CHECK (award_approval_cents IS NULL OR award_approval_cents >= 0);  -- awards above this need a second approver
ALTER TABLE sponsorship_programs ADD COLUMN IF NOT EXISTS finance_signoff_cents bigint CHECK (finance_signoff_cents IS NULL OR finance_signoff_cents >= 0); -- awards above this need finance sign-off
ALTER TABLE sponsorship_programs ADD COLUMN IF NOT EXISTS legal_signoff_required boolean NOT NULL DEFAULT false;
ALTER TABLE sponsorship_programs ADD COLUMN IF NOT EXISTS offer_validity_days int NOT NULL DEFAULT 14 CHECK (offer_validity_days BETWEEN 1 AND 365);
ALTER TABLE sponsorship_programs ADD COLUMN IF NOT EXISTS waitlist_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sponsorship_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid NOT NULL REFERENCES sponsorship_programs,
  round_id      uuid NOT NULL REFERENCES sponsorship_rounds,
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  status        text NOT NULL CHECK (status IN ('waitlisted','pending_approval','approved','issued','accepted','declined','expired','withdrawn','rejected')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  offer_version int NOT NULL DEFAULT 1,            -- bumped by every change to the offer; the recipient accepts one exact version
  row_version   int NOT NULL DEFAULT 1,
  waitlist_rank int,
  expires_at    timestamptz,                       -- set when issued; an offer past it can no longer be accepted
  issued_at     timestamptz,
  issued_by     uuid REFERENCES users,
  issue_key     text,                              -- idempotency key of the issue call
  letter        text,                              -- plain-text award letter snapshot taken at issue
  letter_version int,
  proposed_by   uuid NOT NULL REFERENCES users,
  decision_reason text,
  sponsorship_id uuid REFERENCES sponsorships,     -- the single canonical agreement, set on acceptance
  responded_by  uuid REFERENCES users,
  responded_at  timestamptz,
  response_reason text,
  closed_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'accepted' OR sponsorship_id IS NOT NULL),
  CHECK (status <> 'issued' OR (expires_at IS NOT NULL AND letter IS NOT NULL))
);
-- one live award per application; a closed one (declined/expired/withdrawn/rejected) lets the brand award again
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_awards_live ON sponsorship_awards (application_id) WHERE status IN ('waitlisted','pending_approval','approved','issued','accepted');
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_awards_agreement ON sponsorship_awards (sponsorship_id) WHERE sponsorship_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_awards_issue_key ON sponsorship_awards (id, issue_key) WHERE issue_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsorship_awards_program ON sponsorship_awards (program_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS sponsorship_awards_expiry ON sponsorship_awards (expires_at) WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS sponsorship_awards_waitlist ON sponsorship_awards (program_id, waitlist_rank, id) WHERE status = 'waitlisted';
-- the canonical agreement of an application exists at most once
CREATE UNIQUE INDEX IF NOT EXISTS sponsorships_one_per_application ON sponsorships (application_id) WHERE application_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sponsorship_award_conditions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id    uuid NOT NULL REFERENCES sponsorship_awards,
  position    int  NOT NULL CHECK (position >= 0),     -- grows monotonically; editing the conditions retires the old rows (removed_at) instead of deleting them
  offer_version int NOT NULL DEFAULT 1,
  removed_at  timestamptz,
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  due_on      date,
  blocks_payment boolean NOT NULL DEFAULT false,   -- must be met before the money is paid
  met_at      timestamptz,
  met_by      uuid REFERENCES users,
  met_note    text CHECK (met_note IS NULL OR length(met_note) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (award_id, position)
);

-- Sign-offs per offer version: changing the offer starts a new version and needs fresh sign-offs.
CREATE TABLE IF NOT EXISTS sponsorship_award_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id      uuid NOT NULL REFERENCES sponsorship_awards,
  offer_version int  NOT NULL,
  step          text NOT NULL CHECK (step IN ('approver','finance','legal')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  note          text CHECK (note IS NULL OR length(note) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (award_id, offer_version, step)
);

-- The only reservation ledger: money held against the program and round budget while an award is not yet an agreement.
CREATE TABLE IF NOT EXISTS sponsorship_award_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id     uuid NOT NULL REFERENCES sponsorship_awards,
  program_id   uuid NOT NULL REFERENCES sponsorship_programs,
  round_id     uuid NOT NULL REFERENCES sponsorship_rounds,
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status       text NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','converted')),
  release_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  UNIQUE (award_id)                                -- a retry can never reserve twice
);
CREATE INDEX IF NOT EXISTS sponsorship_award_reservations_held ON sponsorship_award_reservations (program_id, round_id) WHERE status = 'held';

-- Append-only history of what happened to an award.
CREATE TABLE IF NOT EXISTS sponsorship_award_events (
  id         bigserial PRIMARY KEY,
  award_id   uuid NOT NULL REFERENCES sponsorship_awards,
  kind       text NOT NULL,
  actor_id   uuid REFERENCES users,
  offer_version int,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_award_events_award ON sponsorship_award_events (award_id, id);
