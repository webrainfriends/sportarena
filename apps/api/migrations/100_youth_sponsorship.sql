-- Guardian-authorized youth sponsorship (issue #307).
-- Additive only: one new table and nullable columns. Existing agreements, privacy defaults and financial history are untouched;
-- nothing is rewritten, narrowed or removed. Rollback = deploy the previous code: it ignores the new table and columns, which stay unused.

-- A verified guardian names a sponsor that may send ONE young person an offer. Without a live row (and a live guardian link behind it)
-- the young person stays undiscoverable and offers are refused. Withdrawing sets status, never deletes.
CREATE TABLE sponsorship_guardian_authorities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id      uuid NOT NULL REFERENCES users,
  sponsor_id    uuid NOT NULL REFERENCES sponsors,
  authorized_by uuid NOT NULL REFERENCES users,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_by  uuid REFERENCES users,
  withdrawn_at  timestamptz
);
CREATE UNIQUE INDEX sponsorship_guardian_authority_live ON sponsorship_guardian_authorities (child_id, sponsor_id) WHERE status = 'active';
CREATE INDEX sponsorship_guardian_authority_child ON sponsorship_guardian_authorities (child_id, created_at, id);
CREATE INDEX sponsorship_guardian_authority_sponsor ON sponsorship_guardian_authorities (sponsor_id, created_at, id);

-- Which verified guardian answered the offer for the young person, and when.
ALTER TABLE sponsorships
  ADD COLUMN guardian_id         uuid REFERENCES users,
  ADD COLUMN guardian_decided_at timestamptz;
