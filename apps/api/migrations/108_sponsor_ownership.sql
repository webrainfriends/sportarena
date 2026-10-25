-- Brand ownership transfer (#340). Purely additive: a revision counter on the brand (so a stale hand-over is rejected, even
-- if ownership went A -> B -> A meanwhile) and an append-only record of every hand-over. Nothing is dropped, rewritten or
-- deleted; existing brands start at revision 1. No ON DELETE CASCADE.
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS owner_rev int NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS sponsor_owner_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id      uuid NOT NULL REFERENCES sponsors,
  from_user_id    uuid NOT NULL REFERENCES users,
  to_user_id      uuid NOT NULL REFERENCES users,
  by_user_id      uuid NOT NULL REFERENCES users,           -- who performed it (owner, organisation owner/admin or platform admin)
  organisation_id uuid REFERENCES organisations,            -- the brand's organisation at the time, if any
  previous_owner_role text,                                 -- the previous owner's organisation role afterwards (null: not a member)
  rev             int NOT NULL,                             -- the brand's owner_rev after this hand-over
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX IF NOT EXISTS sponsor_owner_transfers_sponsor ON sponsor_owner_transfers (sponsor_id, created_at DESC);
