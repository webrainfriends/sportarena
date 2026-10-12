-- Sponsorship agreements (#145): structured contribution lines, a fixed-term schedule, and fulfilment tracking.
-- Everything here is a child of the existing `sponsorships` row (no second sponsorship system) and is purely additive:
-- existing deals keep working unchanged and get no lines, no schedule and no invented payments or currency.
ALTER TABLE sponsorships
  ADD COLUMN agreement_ref    text,
  ADD COLUMN currency         text,                          -- default currency of the lines; legacy amount_cents has none and stays unlabelled
  ADD COLUMN timezone         text NOT NULL DEFAULT 'UTC',   -- zone the due dates are meant in (dates are calendar dates)
  ADD COLUMN terms_version    integer NOT NULL DEFAULT 1,    -- bumped on every revision of an unanswered offer
  ADD COLUMN accepted_version integer;                       -- the exact version the recipient accepted
CREATE UNIQUE INDEX sponsorships_agreement_ref ON sponsorships (agreement_ref) WHERE agreement_ref IS NOT NULL;

CREATE TABLE sponsorship_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  version        integer NOT NULL,
  position       integer NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('money','goods','endorsement')),
  label          text NOT NULL,
  currency       text,                                       -- money: payment currency; goods/endorsement: currency of the (optional) estimate
  amount_cents   bigint CHECK (amount_cents > 0),            -- money: per instalment (last one absorbs rounding)
  total_cents    bigint CHECK (total_cents > 0),             -- money: committed total over the schedule
  estimate_cents bigint CHECK (estimate_cents >= 0),         -- goods valuation / endorsement estimate: NEVER counted as cash
  quantity       integer CHECK (quantity > 0),               -- goods: committed quantity (split across occurrences)
  unit           text,
  cadence        text NOT NULL DEFAULT 'once' CHECK (cadence IN ('once','weekly','monthly','quarterly','custom')),
  first_due_on   date,
  instalments    integer NOT NULL DEFAULT 1 CHECK (instalments BETWEEN 1 AND 120),
  custom_dates   date[],
  promoter       text CHECK (promoter IN ('sponsor','recipient')), -- endorsement: who promotes (the other party reviews)
  terms          jsonb NOT NULL DEFAULT '{}',                -- endorsement channels / logo placement / approval criteria / exclusivity
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sponsorship_id, version, position)
);

CREATE TABLE sponsorship_obligations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  version        integer NOT NULL,
  line_id        uuid NOT NULL REFERENCES sponsorship_lines,
  seq            integer NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('money','goods','endorsement')),
  due_on         date NOT NULL,
  amount_cents   bigint CHECK (amount_cents > 0),
  currency       text,
  quantity       integer CHECK (quantity > 0),
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','fulfilled','cancelled')), -- overdue is derived from due_on
  fulfilled_at   timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sponsorship_id, version, line_id, seq)            -- a retry or a second worker can never duplicate a due
);
CREATE INDEX sponsorship_obligations_due ON sponsorship_obligations (sponsorship_id, due_on, id);
CREATE INDEX sponsorship_obligations_open ON sponsorship_obligations (due_on) WHERE status = 'scheduled';

CREATE TABLE sponsorship_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id uuid NOT NULL REFERENCES sponsorship_obligations,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      text NOT NULL,
  method        text NOT NULL CHECK (method IN ('bank_transfer','cash','other')),
  reference     text NOT NULL,
  paid_on       date NOT NULL,
  evidence_url  text,
  status        text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','confirmed','rejected','reversed')), -- reported = sponsor's claim, unverified
  reported_by   uuid NOT NULL REFERENCES users,
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, reference)                          -- the same bank reference cannot be reported twice
);

CREATE TABLE sponsorship_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id  uuid NOT NULL REFERENCES sponsorship_obligations,
  quantity       integer NOT NULL CHECK (quantity > 0),
  reference      text,
  note           text,
  status         text NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched','received','rejected')),
  received_quantity integer CHECK (received_quantity >= 0),
  dispatched_by  uuid NOT NULL REFERENCES users,
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sponsorship_submissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id  uuid NOT NULL REFERENCES sponsorship_obligations,
  evidence_url   text NOT NULL,
  note           text,
  status         text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted','revision_requested')),
  submitted_by   uuid NOT NULL REFERENCES users,
  reviewed_by    uuid REFERENCES users,
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Who did what, to which version, and why. Append-only.
CREATE TABLE sponsorship_history (
  id             bigserial PRIMARY KEY,
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  version        integer,
  actor_id       uuid REFERENCES users,
  action         text NOT NULL,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsorship_history_deal ON sponsorship_history (sponsorship_id, id);
