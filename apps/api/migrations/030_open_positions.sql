-- Open positions become a public job board: anyone signed in can apply, both sides exchange documents,
-- the organiser accepts and generates a contract, and the applicant accepts it to be confirmed.
-- Additive and idempotent: constraints are only widened, no row is deleted or rewritten. Everything ends in a status.

-- Vendor-type positions (retail stall, catering, other vendor) live beside crew positions. For these the applicant pays the organiser.
ALTER TABLE event_staff_roles DROP CONSTRAINT IF EXISTS event_staff_roles_role_check;
ALTER TABLE event_staff_roles ADD CONSTRAINT event_staff_roles_role_check
  CHECK (role IN ('referee','umpire','linesman','scorer','doctor','physio','medic','volunteer','security','other','retail','catering','vendor'));
ALTER TABLE event_staff_roles
  ADD COLUMN IF NOT EXISTS pay_direction text NOT NULL DEFAULT 'event_pays' CHECK (pay_direction IN ('event_pays','applicant_pays')),
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;   -- listed on the arena and open to applications

-- Applications are assignments that start as 'applied'; 'contract_sent' = organiser accepted and issued a contract.
ALTER TABLE event_staff_assignments DROP CONSTRAINT IF EXISTS event_staff_assignments_status_check;
ALTER TABLE event_staff_assignments ADD CONSTRAINT event_staff_assignments_status_check
  CHECK (status IN ('invited','accepted','declined','released','withdrawn','completed','applied','contract_sent','rejected'));
ALTER TABLE event_staff_assignments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'invite' CHECK (source IN ('invite','application')),
  ADD COLUMN IF NOT EXISTS proposed_fee_cents bigint CHECK (proposed_fee_cents IS NULL OR proposed_fee_cents >= 0);
ALTER TABLE event_staff_assignments ALTER COLUMN invited_by DROP NOT NULL;   -- applications are not invited by anyone

DROP INDEX IF EXISTS event_staff_assignments_open;
CREATE UNIQUE INDEX IF NOT EXISTS event_staff_assignments_open ON event_staff_assignments (role_id, user_id) WHERE status IN ('invited','accepted','applied','contract_sent');

-- One contract per accepted application (a replaced one is voided, never edited or deleted).
CREATE TABLE IF NOT EXISTS event_contracts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  assignment_id    uuid NOT NULL REFERENCES event_staff_assignments,
  organiser_id     uuid NOT NULL REFERENCES users,
  party_id         uuid NOT NULL REFERENCES users,
  title            text NOT NULL,
  body             text NOT NULL,
  fee_cents        bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  currency         text NOT NULL DEFAULT 'INR',
  pay_direction    text NOT NULL DEFAULT 'event_pays' CHECK (pay_direction IN ('event_pays','applicant_pays')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed','declined','void')),
  organiser_signed_at timestamptz NOT NULL DEFAULT now(),
  party_signed_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_contracts_live ON event_contracts (assignment_id) WHERE status IN ('pending','signed');
CREATE INDEX IF NOT EXISTS event_contracts_party ON event_contracts (party_id, status);
CREATE INDEX IF NOT EXISTS event_contracts_event ON event_contracts (event_id, status);

-- Documents exchanged on one application / assignment by the organiser and the applicant. Encrypted on disk; only hidden, never deleted.
CREATE TABLE IF NOT EXISTS event_staff_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES event_staff_assignments,
  uploaded_by   uuid NOT NULL REFERENCES users,
  title         text NOT NULL,
  content_type  text NOT NULL,
  file_name     text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS event_staff_documents_assignment ON event_staff_documents (assignment_id) WHERE removed_at IS NULL;
