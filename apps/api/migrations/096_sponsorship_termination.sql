-- Termination of a sponsorship agreement: notice, reason and effective date, return of goods, refunds of canonical sponsorship payments,
-- disputes and a final settlement (#298).
-- Purely additive: existing agreements, dues, payments, deliveries and history are untouched; no row is rewritten or removed, nothing is
-- backfilled (an agreement that already ended simply has no termination record). Rollback = deploy the previous code; the new tables and
-- columns are ignored by it and every due, payment and delivery keeps its recorded state.

-- One termination per agreement: notice given -> (agreed) -> ended on the effective date -> settled. It never deletes or edits a due.
CREATE TABLE sponsorship_terminations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id      uuid NOT NULL REFERENCES sponsorships,
  given_side          text NOT NULL CHECK (given_side IN ('sponsor','recipient')),
  given_by            uuid NOT NULL REFERENCES users,
  reason_code         text NOT NULL CHECK (reason_code IN ('mutual','breach','non_performance','budget','other')),
  reason              text,
  notice_on           date NOT NULL,
  effective_on        date NOT NULL CHECK (effective_on >= notice_on),
  base_version        integer NOT NULL,                       -- the accepted terms version the notice was given against
  rev                 integer NOT NULL DEFAULT 1,             -- bumped on every workflow change; an answer names the rev it saw (stale -> 409)
  status              text NOT NULL DEFAULT 'notice' CHECK (status IN ('notice','agreed','ended','settled','withdrawn')),
  agreed_by           uuid REFERENCES users,                  -- the other side accepted the termination terms
  agreed_at           timestamptz,
  dispute_note        text,
  disputed_by         uuid REFERENCES users,
  disputed_at         timestamptz,
  dispute_resolved_by uuid REFERENCES users,
  dispute_resolved_at timestamptz,
  dispute_case_id     uuid REFERENCES cases,                  -- the support case that carries the dispute, when one was opened
  ended_at            timestamptz,
  settled_by          uuid REFERENCES users,
  settled_at          timestamptz,
  settlement          jsonb,                                  -- frozen final settlement, including anything carried forward
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- one live termination per agreement: two sides cannot race to apply different ones
CREATE UNIQUE INDEX sponsorship_terminations_live ON sponsorship_terminations (sponsorship_id) WHERE status IN ('notice','agreed','ended');
CREATE INDEX sponsorship_terminations_due ON sponsorship_terminations (effective_on) WHERE status IN ('notice','agreed');

-- Goods sent back. The quantity can never exceed what was actually received (received_quantity), across every non-declined return of that delivery.
CREATE TABLE sponsorship_returns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  termination_id  uuid NOT NULL REFERENCES sponsorship_terminations,
  delivery_id     uuid NOT NULL REFERENCES sponsorship_deliveries,
  quantity        integer NOT NULL CHECK (quantity > 0),
  requested_side  text NOT NULL CHECK (requested_side IN ('sponsor','recipient')),
  requested_by    uuid NOT NULL REFERENCES users,
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','declined','received')),
  note            text,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsorship_returns_delivery ON sponsorship_returns (delivery_id);
CREATE INDEX sponsorship_returns_termination ON sponsorship_returns (termination_id, created_at, id);

-- Backstop for the quantity rule (the API checks it first, under a lock on the delivery): a return can never push the total above what was received.
CREATE FUNCTION sponsorship_return_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE got integer; sent integer;
BEGIN
  IF NEW.status = 'declined' THEN RETURN NEW; END IF;
  SELECT coalesce(received_quantity, 0) INTO got FROM sponsorship_deliveries WHERE id = NEW.delivery_id FOR UPDATE;
  SELECT coalesce(sum(quantity), 0) INTO sent FROM sponsorship_returns WHERE delivery_id = NEW.delivery_id AND status <> 'declined' AND id <> NEW.id;
  IF sent + NEW.quantity > got THEN
    RAISE EXCEPTION 'Returned quantity (%) cannot exceed the goods received (%)', sent + NEW.quantity, got;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sponsorship_returns_guard BEFORE INSERT OR UPDATE OF quantity, status ON sponsorship_returns FOR EACH ROW EXECUTE FUNCTION sponsorship_return_guard();

-- Money given back. Always references a canonical sponsorship payment (and, for online money, the provider payment behind it).
CREATE TABLE sponsorship_refunds (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  termination_id         uuid NOT NULL REFERENCES sponsorship_terminations,
  sponsorship_payment_id uuid NOT NULL REFERENCES sponsorship_payments,
  amount_cents           bigint NOT NULL CHECK (amount_cents > 0),
  currency               text NOT NULL,                       -- always the currency of the payment; currencies are never converted or combined
  requested_side         text NOT NULL CHECK (requested_side IN ('sponsor','recipient')),
  requested_by           uuid NOT NULL REFERENCES users,
  status                 text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined','refunded')),
  note                   text,
  decided_by             uuid REFERENCES users,
  decided_at             timestamptz,
  decision_note          text,
  refunded_at            timestamptz,                         -- set only once the money has actually been given back (manual: confirmed by the payee; online: by the provider)
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsorship_refunds_payment ON sponsorship_refunds (sponsorship_payment_id);
CREATE INDEX sponsorship_refunds_termination ON sponsorship_refunds (termination_id, created_at, id);

-- The part of a due that an agreed termination refund conceded: refunding a payment under a termination must not re-open that due as a debt.
ALTER TABLE sponsorship_obligations ADD COLUMN conceded_cents bigint NOT NULL DEFAULT 0 CHECK (conceded_cents >= 0);
