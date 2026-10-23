-- Sponsorship beneficiaries (#291): an organisation or a durable group (an organisation cohort) can be the beneficiary of a
-- sponsorship, with explicit allocations and a named payee per allocation. Purely additive: the only change to an existing
-- object is that the sponsorships.target_type CHECK is WIDENED (every existing value stays valid); no row is rewritten or removed.
-- Rollback = deploy the previous code; the new tables/columns are simply ignored.
ALTER TABLE sponsorships DROP CONSTRAINT sponsorships_target_type_check;
ALTER TABLE sponsorships ADD CONSTRAINT sponsorships_target_type_check CHECK (target_type IN ('event','team','athlete','organisation','group'));

-- Organisations are private by default: sponsors can only find and approach one that opted in.
ALTER TABLE organisations ADD COLUMN open_to_sponsors boolean NOT NULL DEFAULT false;

-- Beneficiary = who the support is for; representative = the live organisation owner/admin who acts for it; payee = the
-- person who receives and confirms the money. Rows are never edited or deleted: changing an allocation RELEASES the row
-- and adds a new one, and the payee's name is frozen on the row, so later membership changes never rewrite history.
CREATE TABLE sponsorship_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id   uuid NOT NULL REFERENCES sponsorships,
  beneficiary_type text NOT NULL CHECK (beneficiary_type IN ('organisation','group','team')),
  beneficiary_id   uuid NOT NULL,
  beneficiary_name text NOT NULL,
  share_bp         integer NOT NULL CHECK (share_bp BETWEEN 1 AND 10000),   -- basis points of every money line; 10000 = 100%
  payee_user_id    uuid NOT NULL REFERENCES users,
  payee_name       text NOT NULL,
  terms_version    integer NOT NULL,                                        -- the agreement version in force when it was set
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  set_by           uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_by      uuid REFERENCES users,
  released_at      timestamptz
);
-- the same beneficiary can never be allocated twice at once
CREATE UNIQUE INDEX sponsorship_allocations_live ON sponsorship_allocations (sponsorship_id, beneficiary_type, beneficiary_id) WHERE status = 'active';
CREATE INDEX sponsorship_allocations_payee ON sponsorship_allocations (payee_user_id) WHERE status = 'active';
CREATE INDEX sponsorship_allocations_deal ON sponsorship_allocations (sponsorship_id, created_at, id);

-- Optimistic-concurrency token for the allocation set (a stale editor is told to reload).
ALTER TABLE sponsorships ADD COLUMN allocation_rev integer NOT NULL DEFAULT 1;

-- Who the payees were when a payment was confirmed. Existing payments stay NULL (nothing is invented).
ALTER TABLE sponsorship_payments ADD COLUMN payee_snapshot jsonb;
