-- Mutually accepted amendments of an ACCEPTED sponsorship agreement (#296).
-- Purely additive: existing agreements, versions, dues, payments and allocations are untouched; no row is rewritten or removed.
-- Rollback = deploy the previous code; the new tables/columns are ignored by it (an open proposal simply cannot be answered, and nothing
-- changes without an acceptance). An accepted amendment's new version, its dues and the cancelled-by-amendment markers stay as history.

-- A proposal to change an active agreement. It changes NOTHING until the other side accepts the exact revision.
CREATE TABLE sponsorship_amendments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id      uuid NOT NULL REFERENCES sponsorships,
  seq                 integer NOT NULL,                       -- 1, 2, 3 ... per agreement
  base_version        integer NOT NULL,                       -- the accepted terms version this proposal changes
  proposed_side       text NOT NULL CHECK (proposed_side IN ('sponsor','recipient')),
  proposed_by         uuid NOT NULL REFERENCES users,
  rev                 integer NOT NULL DEFAULT 1,             -- bumped each time the proposer edits it; acceptance names the rev it saw
  effective_from      date NOT NULL,                          -- only dues on or after this date can change
  starts_on           date,
  ends_on             date,
  timezone            text,
  lines               jsonb NOT NULL,                         -- the full proposed set of contribution lines (value, recurrence, deliverables, rights)
  allocations         jsonb,                                  -- proposed payee allocation set (organisation / group agreements); NULL = payees unchanged
  base_allocation_rev integer,                                -- allocations changed since this proposal -> it is stale
  reason              text,
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected','withdrawn','superseded')),
  decided_by          uuid REFERENCES users,
  decided_at          timestamptz,
  decision_note       text,
  resulting_version   integer,                                -- the terms version the acceptance created
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sponsorship_id, seq)
);
-- one open proposal per agreement: two sides cannot race to apply different changes
CREATE UNIQUE INDEX sponsorship_amendments_open ON sponsorship_amendments (sponsorship_id) WHERE status = 'proposed';

-- Which dues an amendment cancelled (the future, untouched ones) and which it created. Old dues are never deleted or edited.
ALTER TABLE sponsorship_obligations ADD COLUMN cancelled_by_amendment uuid REFERENCES sponsorship_amendments;
ALTER TABLE sponsorship_obligations ADD COLUMN created_by_amendment uuid REFERENCES sponsorship_amendments;

-- From which date an amended version's dues apply. NULL = the original terms (all occurrences). Rebuilding a schedule never recreates earlier dues.
ALTER TABLE sponsorship_versions ADD COLUMN effective_from date;
ALTER TABLE sponsorship_versions ADD COLUMN amendment_id uuid REFERENCES sponsorship_amendments;

-- A fulfilled due is settled history: its amount, date, currency, quantity and identity can never change, and it can never be cancelled.
-- (Its status may still reopen when a confirmed payment is reversed or refunded, which is existing behaviour.)
CREATE FUNCTION sponsorship_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'fulfilled' AND (
       NEW.status = 'cancelled' OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.due_on <> OLD.due_on OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.kind <> OLD.kind OR NEW.line_id <> OLD.line_id OR NEW.version <> OLD.version OR NEW.seq <> OLD.seq OR NEW.sponsorship_id <> OLD.sponsorship_id) THEN
    RAISE EXCEPTION 'A fulfilled due is settled history and cannot be changed or cancelled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sponsorship_obligations_guard BEFORE UPDATE ON sponsorship_obligations FOR EACH ROW EXECUTE FUNCTION sponsorship_obligation_guard();
