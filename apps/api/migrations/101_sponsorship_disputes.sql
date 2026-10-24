-- Sponsorship disputes, complaints and risk controls (#308).
-- A dispute is ONE canonical support case (cases, kind=dispute) plus a thin sponsorship_disputes row that says what it is about
-- (an agreement, a payment, a goods delivery or endorsement evidence) and carries the sponsorship-specific workflow: contested status,
-- reviewers, reasoned risk flags, appeals and the canonical adjustment a resolution applied. The thread, evidence and timeline stay in
-- case_messages / case_evidence / case_events; nothing is copied.
-- Purely additive: no existing row is rewritten or removed, no debt, payment, delivery or evidence is touched by opening a dispute.
-- Rollback = deploy the previous code; the new tables/columns are ignored and every due, payment and case keeps its recorded state.

-- cases may now link the exact sponsorship record in dispute (widening the allowed list only)
ALTER TABLE case_links DROP CONSTRAINT case_links_entity_type_check;
ALTER TABLE case_links ADD CONSTRAINT case_links_entity_type_check CHECK (entity_type IN ('reservation','booking','invoice','payment','shop_order','coach_hire','event','game','fixture','appointment','insurance_policy','sponsorship',
  'sponsorship_obligation','sponsorship_payment','sponsorship_delivery','sponsorship_submission'));

CREATE TABLE sponsorship_disputes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL UNIQUE REFERENCES cases,
  sponsorship_id  uuid NOT NULL REFERENCES sponsorships,
  subject_type    text NOT NULL CHECK (subject_type IN ('agreement','payment','goods','evidence')),
  obligation_id   uuid REFERENCES sponsorship_obligations,
  payment_id      uuid REFERENCES sponsorship_payments,
  delivery_id     uuid REFERENCES sponsorship_deliveries,
  submission_id   uuid REFERENCES sponsorship_submissions,
  opened_side     text NOT NULL CHECK (opened_side IN ('sponsor','recipient')),
  opened_by       uuid NOT NULL REFERENCES users,
  disputed_cents  bigint CHECK (disputed_cents > 0),          -- only for money; never above the linked payment / due
  currency        text,                                       -- always the linked record's currency, never converted
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','resolved','appealed','withdrawn')),
  rev             integer NOT NULL DEFAULT 1,                 -- every change bumps it; a write names the rev it saw (stale -> 409)
  outcome         text CHECK (outcome IN ('concession','no_financial_change','dismissed')),
  resolution      text,
  resolved_by     uuid REFERENCES users,
  resolved_at     timestamptz,
  appeal_until    timestamptz,                                -- the window in which either side may appeal the decision
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_type = 'payment') = (payment_id IS NOT NULL)),
  CHECK ((subject_type = 'goods') = (delivery_id IS NOT NULL)),
  CHECK ((subject_type = 'evidence') = (submission_id IS NOT NULL)),
  UNIQUE (opened_by, idempotency_key)
);
CREATE INDEX sponsorship_disputes_deal ON sponsorship_disputes (sponsorship_id, created_at DESC, id);
-- one live dispute per disputed record: two people cannot race to open the same complaint
CREATE UNIQUE INDEX sponsorship_disputes_live_payment ON sponsorship_disputes (payment_id) WHERE payment_id IS NOT NULL AND status IN ('open','under_review','appealed');
CREATE UNIQUE INDEX sponsorship_disputes_live_delivery ON sponsorship_disputes (delivery_id) WHERE delivery_id IS NOT NULL AND status IN ('open','under_review','appealed');
CREATE UNIQUE INDEX sponsorship_disputes_live_submission ON sponsorship_disputes (submission_id) WHERE submission_id IS NOT NULL AND status IN ('open','under_review','appealed');
CREATE UNIQUE INDEX sponsorship_disputes_live_agreement ON sponsorship_disputes (sponsorship_id, opened_side) WHERE subject_type = 'agreement' AND status IN ('open','under_review','appealed');

-- Who may read a dispute besides the two sides: reviewers added with a reason. Removing one keeps the row (removed_at), so access is auditable.
CREATE TABLE sponsorship_dispute_reviewers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES sponsorship_disputes,
  user_id     uuid NOT NULL REFERENCES users,
  added_by    uuid NOT NULL REFERENCES users,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  uuid REFERENCES users
);
CREATE UNIQUE INDEX sponsorship_dispute_reviewers_live ON sponsorship_dispute_reviewers (dispute_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX sponsorship_dispute_reviewers_user ON sponsorship_dispute_reviewers (user_id) WHERE removed_at IS NULL;

-- Risk flags: always reasoned, never deleted; clearing records who and why.
CREATE TABLE sponsorship_dispute_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    uuid NOT NULL REFERENCES sponsorship_disputes,
  kind          text NOT NULL CHECK (kind IN ('amount_mismatch','suspected_fraud','duplicate_claim','evidence_concern','consent_concern','other')),
  reason        text NOT NULL CHECK (length(btrim(reason)) >= 5),
  raised_by     uuid NOT NULL REFERENCES users,
  raised_side   text NOT NULL CHECK (raised_side IN ('sponsor','recipient','reviewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cleared_by    uuid REFERENCES users,
  cleared_reason text,
  cleared_at    timestamptz,
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL) AND (cleared_at IS NULL) = (cleared_reason IS NULL))
);
CREATE INDEX sponsorship_dispute_flags_dispute ON sponsorship_dispute_flags (dispute_id, created_at, id);

-- Appeals: the decision that was appealed stays on record; the appeal is decided by a different reviewer.
CREATE TABLE sponsorship_dispute_appeals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    uuid NOT NULL REFERENCES sponsorship_disputes,
  appealed_by   uuid NOT NULL REFERENCES users,
  side          text NOT NULL CHECK (side IN ('sponsor','recipient')),
  reason        text NOT NULL CHECK (length(btrim(reason)) >= 5),
  decision_before text,                                       -- the resolution text being appealed
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsorship_dispute_appeals_dispute ON sponsorship_dispute_appeals (dispute_id, created_at, id);

-- The financial effect of a resolution. A concession is applied to the canonical obligation (sponsorship_obligations.conceded_cents, the same
-- mechanism a termination refund uses); this row only records it, so there is no second ledger. One resolution (and appeal round) applies once.
CREATE TABLE sponsorship_dispute_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    uuid NOT NULL REFERENCES sponsorship_disputes,
  round         integer NOT NULL DEFAULT 1,                   -- 1 = first decision, 2 = after an appeal
  obligation_id uuid NOT NULL REFERENCES sponsorship_obligations,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      text NOT NULL,
  applied_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispute_id, round)
);

-- Flags, appeals and adjustments are history: they may not be deleted (flags are cleared in place with a reason).
CREATE FUNCTION sponsorship_dispute_keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME; END $$;
CREATE TRIGGER sponsorship_dispute_flags_keep BEFORE DELETE ON sponsorship_dispute_flags FOR EACH ROW EXECUTE FUNCTION sponsorship_dispute_keep();
CREATE TRIGGER sponsorship_dispute_appeals_keep BEFORE UPDATE OR DELETE ON sponsorship_dispute_appeals FOR EACH ROW EXECUTE FUNCTION sponsorship_dispute_keep();
CREATE TRIGGER sponsorship_dispute_adjustments_keep BEFORE UPDATE OR DELETE ON sponsorship_dispute_adjustments FOR EACH ROW EXECUTE FUNCTION sponsorship_dispute_keep();
CREATE TRIGGER sponsorship_disputes_keep BEFORE DELETE ON sponsorship_disputes FOR EACH ROW EXECUTE FUNCTION sponsorship_dispute_keep();
