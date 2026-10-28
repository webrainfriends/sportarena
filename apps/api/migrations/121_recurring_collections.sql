-- Recurring collections & dunning (issue #511). Additive only: nothing is dropped, rewritten or narrowed.
-- The canonical records stay authoritative: academy_charges (what is owed), invoices (the numbered document), payments (provider cash) and
-- user_plans (venue memberships). This migration adds the *facts around them*: part payments and adjustments against a charge, explicit
-- billing schedules that raise one charge per period, and the dunning case that follows an unpaid charge until it is resolved.

-- ---------------------------------------------------------------------------------------------------------------- charges
-- Remaining balance = amount_minor - settled_minor - adjusted_minor. Both columns are kept in step with charge_receipts / charge_adjustments
-- inside the same transaction; the rows are the evidence, the columns make the balance cheap to read and to constrain.
ALTER TABLE academy_charges ADD COLUMN IF NOT EXISTS settled_minor bigint NOT NULL DEFAULT 0 CHECK (settled_minor >= 0);
ALTER TABLE academy_charges ADD COLUMN IF NOT EXISTS adjusted_minor bigint NOT NULL DEFAULT 0 CHECK (adjusted_minor >= 0);
ALTER TABLE academy_charges ADD COLUMN IF NOT EXISTS parent_charge_id uuid REFERENCES academy_charges;   -- a late fee points at the charge that was late
ALTER TABLE academy_charges ADD CONSTRAINT academy_charges_balance CHECK (settled_minor + adjusted_minor <= amount_minor) NOT VALID;
ALTER TABLE academy_charges DROP CONSTRAINT IF EXISTS academy_charges_kind_check;
ALTER TABLE academy_charges ADD CONSTRAINT academy_charges_kind_check CHECK (kind IN ('registration','deposit','tuition','instalment','trial','pack','dues','late_fee'));
CREATE UNIQUE INDEX IF NOT EXISTS academy_charges_one_late_fee ON academy_charges (parent_charge_id) WHERE kind = 'late_fee';

-- money received against a charge: a desk payment (full or part) or an online payment. Append-only; a retry with the same key adds nothing.
CREATE TABLE IF NOT EXISTS charge_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id       uuid NOT NULL REFERENCES academy_charges,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  method          text NOT NULL,                                   -- online | cash | card | upi | bank | other
  payment_id      uuid REFERENCES payments,                        -- the canonical payment, for online receipts
  recorded_by     uuid REFERENCES users,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS charge_receipts_key ON charge_receipts (charge_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS charge_receipts_payment ON charge_receipts (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS charge_receipts_charge ON charge_receipts (charge_id, created_at);

-- a waiver (the academy forgives it) or a concession (a goodwill reduction) against an unpaid charge: explicit, attributed, never an edited price
CREATE TABLE IF NOT EXISTS charge_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id       uuid NOT NULL REFERENCES academy_charges,
  kind            text NOT NULL CHECK (kind IN ('waiver','concession')),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  reason_enc      text NOT NULL,                                   -- internal; hardship details are personal data
  actor_id        uuid NOT NULL REFERENCES users,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (charge_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS charge_adjustments_charge ON charge_adjustments (charge_id, created_at);

-- ------------------------------------------------------------------------------------------------------ billing schedules
-- An explicit recurring schedule on an enrolment (an academy programme or a club / team cohort). The terms and every future due date are frozen
-- when it is created; each period raises exactly one canonical charge (and so one numbered invoice), guarded by the unique (schedule, period).
CREATE TABLE IF NOT EXISTS billing_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  enrolment_id    uuid NOT NULL REFERENCES org_enrolments,
  payer_id        uuid NOT NULL REFERENCES users,
  label           text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('monthly','term','season','custom')),
  currency        text NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  tax_rate_bp     int NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  due_dates       date[] NOT NULL CHECK (cardinality(due_dates) BETWEEN 1 AND 60),
  raise_days_before int NOT NULL DEFAULT 7 CHECK (raise_days_before BETWEEN 0 AND 60),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  -- A provider mandate (issue #498) is a permission to collect, not a payment and not an entitlement: its state is stored on its own and never read as paid.
  mandate_ref     text,
  mandate_status  text NOT NULL DEFAULT 'none' CHECK (mandate_status IN ('none','pending','active','failed','revoked')),
  terms           jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ended_reason    text,
  UNIQUE (created_by, idempotency_key)
);
CREATE INDEX IF NOT EXISTS billing_schedules_org ON billing_schedules (organisation_id, status);
CREATE INDEX IF NOT EXISTS billing_schedules_enrolment ON billing_schedules (enrolment_id);

CREATE TABLE IF NOT EXISTS billing_schedule_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES billing_schedules,
  period_no   int NOT NULL,
  due_on      date NOT NULL,
  charge_id   uuid REFERENCES academy_charges,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_schedule_periods_charge ON billing_schedule_periods (charge_id) WHERE charge_id IS NOT NULL;

-- --------------------------------------------------------------------------------------------------------------- policy
-- How an organisation or venue chases money. Defaults live in code; a row exists only once someone has chosen to change them.
-- owner_type is 'organisation' or 'venue' (the owner table differs, so there is no foreign key).
CREATE TABLE IF NOT EXISTS collection_policies (
  owner_type       text NOT NULL CHECK (owner_type IN ('organisation','venue')),
  owner_id         uuid NOT NULL,
  reminder_offsets int[] NOT NULL DEFAULT '{-3,0,3,7,14}',          -- days from the due date; each fires at most once per case
  grace_days       int NOT NULL DEFAULT 3 CHECK (grace_days BETWEEN 0 AND 60),
  retry_days       int[] NOT NULL DEFAULT '{1,3,5}',                -- after a failed payment attempt: when to ask again; its length is the retry budget
  escalate_after_days int NOT NULL DEFAULT 21 CHECK (escalate_after_days BETWEEN 1 AND 365),
  late_fee_enabled boolean NOT NULL DEFAULT false,
  late_fee_minor   bigint NOT NULL DEFAULT 0 CHECK (late_fee_minor >= 0),
  late_fee_currency text,                                           -- the fee is in one currency and is only added to charges in that currency
  late_fee_after_days int NOT NULL DEFAULT 7 CHECK (late_fee_after_days BETWEEN 1 AND 365),
  late_fee_basis   text,                                            -- the contractual / legal basis, required before a late fee can be switched on
  suspension_enabled boolean NOT NULL DEFAULT false,
  suspend_after_days int NOT NULL DEFAULT 30 CHECK (suspend_after_days BETWEEN 1 AND 365),
  updated_by       uuid REFERENCES users,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_type, owner_id),
  CHECK (NOT late_fee_enabled OR (late_fee_minor > 0 AND late_fee_basis IS NOT NULL AND late_fee_currency IS NOT NULL)),
  CHECK (cardinality(reminder_offsets) <= 12 AND cardinality(retry_days) <= 6)
);

-- ------------------------------------------------------------------------------------------------------ dunning cases
-- One case per unpaid thing (an academy/club charge, or a venue membership renewal). The case holds the lifecycle and the human work around it;
-- whether money is owed is always read from the canonical record, never from the case.
CREATE TABLE IF NOT EXISTS collection_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type      text NOT NULL CHECK (owner_type IN ('organisation','venue')),
  owner_id        uuid NOT NULL,
  source_type     text NOT NULL CHECK (source_type IN ('academy_charge','venue_plan')),
  source_id       uuid NOT NULL,
  payer_id        uuid NOT NULL REFERENCES users,
  currency        text NOT NULL,
  due_on          date NOT NULL,
  state           text NOT NULL DEFAULT 'upcoming' CHECK (state IN ('upcoming','due','attempted','paid','failed','retrying','overdue','escalated','resolved','waived','cancelled')),
  attempts        int NOT NULL DEFAULT 0,
  failed_attempts int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_reminder_at timestamptz,
  promised_on     date,                                             -- the payer's promise to pay; reminders pause until it passes
  hold_until      date,                                             -- a human override: no reminders, fees or suspension until this date
  next_action     text,
  next_action_on  date,
  had_trouble     boolean NOT NULL DEFAULT false,                   -- it went overdue or a payment failed at some point (paid afterwards = recovered)
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS collection_cases_owner ON collection_cases (owner_type, owner_id, state, due_on);
CREATE INDEX IF NOT EXISTS collection_cases_payer ON collection_cases (payer_id);

-- append-only history of everything done on a case: reminders sent, attempts, promises, notes, adjustments, suspension. Internal notes are encrypted.
CREATE TABLE IF NOT EXISTS collection_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES collection_cases,
  kind        text NOT NULL,
  actor_id    uuid REFERENCES users,                                -- null = the system
  data        jsonb NOT NULL DEFAULT '{}',
  note_enc    text,
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS collection_events_dedupe ON collection_events (case_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS collection_events_case ON collection_events (case_id, created_at);

-- an approved payment plan against one charge: the original charge and invoice stay as they were; the plan only says when the balance will be paid
CREATE TABLE IF NOT EXISTS payment_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id       uuid NOT NULL REFERENCES academy_charges,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','broken','cancelled')),
  instalments     jsonb NOT NULL,                                   -- [{ due_on, amount_minor }] adding up to exactly the balance at approval
  balance_minor   bigint NOT NULL CHECK (balance_minor > 0),
  settled_at_approval bigint NOT NULL,                              -- charge.settled_minor when approved: what was paid since is settled_minor - this
  note_enc        text,
  approved_by     uuid NOT NULL REFERENCES users,
  approved_at     timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL,
  UNIQUE (charge_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_plans_one_active ON payment_plans (charge_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------------------------------------- suspension
-- Non-payment may pause access to a service, never anything else: it is prospective (it blocks future self check-in / passes), explicit, attributed
-- and reversible. Enrolment, attendance history, medical and safety records are untouched.
CREATE TABLE IF NOT EXISTS entitlement_suspensions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id    uuid NOT NULL REFERENCES org_enrolments,
  organisation_id uuid NOT NULL REFERENCES organisations,
  case_id         uuid REFERENCES collection_cases,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  reason          text NOT NULL,
  started_by      uuid REFERENCES users,                            -- null = the policy, applied by the worker
  starts_at       timestamptz NOT NULL DEFAULT now(),
  lifted_at       timestamptz,
  lifted_by       uuid REFERENCES users,
  lift_reason     text
);
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_suspensions_one_active ON entitlement_suspensions (enrolment_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS entitlement_suspensions_org ON entitlement_suspensions (organisation_id, status);
