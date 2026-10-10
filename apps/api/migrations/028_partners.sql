-- Partner management: onboarding, venue approval, platform-controlled pricing, contracts, settlements and the platform ledger.
-- Additive only: nothing is dropped or rewritten. Existing venues stay approved and live; their owners are back-filled as active partners.

-- ---------------------------------------------------------------- partners
CREATE TABLE partners (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,                      -- human reference, e.g. PTR-000012
  name             text NOT NULL,
  legal_name       text,
  kind             text NOT NULL DEFAULT 'venue_operator' CHECK (kind IN ('venue_operator','club','academy','school','other')),
  status           text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','onboarding','active','suspended','offboarded','rejected')),
  owner_id         uuid NOT NULL REFERENCES users,
  city             text,
  country          text,
  contact_name_enc  text,                                     -- personal / banking data: field-level encrypted, reads audit-logged
  contact_email_enc text,
  contact_phone_enc text,
  tax_id_enc        text,
  payout_enc        text,                                     -- JSON: account holder, account number / IBAN, bank code
  payout_last4      text,
  checklist        jsonb NOT NULL DEFAULT '{}',               -- onboarding steps ticked by the platform team
  risk_score       int,
  notes            text,
  decision_reason  text,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  activated_at     timestamptz,
  suspended_at     timestamptz,
  offboarded_at    timestamptz,
  created_by       uuid REFERENCES users,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partners_status ON partners (status, applied_at DESC);
CREATE INDEX partners_owner ON partners (owner_id);
CREATE SEQUENCE partner_code_seq;

CREATE TABLE partner_events (                                 -- immutable timeline
  id         bigserial PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_events_partner ON partner_events (partner_id, id DESC);

-- ---------------------------------------------------------------- venue approval
ALTER TABLE venues
  ADD COLUMN approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending','approved','rejected','changes_requested')),
  ADD COLUMN approval_note   text,
  ADD COLUMN approved_by     uuid REFERENCES users,
  ADD COLUMN approved_at     timestamptz,
  ADD COLUMN partner_id      uuid REFERENCES partners,
  ADD COLUMN paused_by_partner boolean NOT NULL DEFAULT false;  -- hidden because its partner is suspended / offboarded (restored on reinstatement)
CREATE INDEX venues_partner ON venues (partner_id);
CREATE INDEX venues_approval ON venues (approval_status) WHERE approval_status <> 'approved';

-- Back-fill: every existing venue owner becomes an active partner so current venues keep working and can be given contracts.
INSERT INTO partners (code, name, kind, status, owner_id, city, activated_at)
SELECT 'PTR-' || lpad(nextval('partner_code_seq')::text, 6, '0'), u.display_name, 'venue_operator', 'active', o.owner_id,
       (SELECT v.city FROM venues v WHERE v.owner_id = o.owner_id AND v.city IS NOT NULL ORDER BY v.created_at LIMIT 1), now()
  FROM (SELECT DISTINCT owner_id FROM venues) o JOIN users u ON u.id = o.owner_id;
UPDATE venues v SET partner_id = p.id FROM partners p WHERE p.owner_id = v.owner_id AND v.partner_id IS NULL;

-- ---------------------------------------------------------------- platform-controlled pricing
ALTER TABLE price_rules
  ADD COLUMN source      text NOT NULL DEFAULT 'venue' CHECK (source IN ('venue','platform')),   -- platform rules always beat venue rules
  ADD COLUMN approved_by uuid REFERENCES users,
  ADD COLUMN request_id  uuid;
ALTER TABLE resources ADD COLUMN rate_source text NOT NULL DEFAULT 'venue' CHECK (rate_source IN ('venue','platform'));

-- A venue never edits its live prices. It files a request; the platform approves it, counters it or rejects it.
CREATE TABLE price_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid NOT NULL REFERENCES venues,
  requested_by  uuid NOT NULL REFERENCES users,
  kind          text NOT NULL CHECK (kind IN ('rule_create','rule_update','rule_delete','base_rate','category_create','category_update','category_rate')),
  target_id     uuid,                                         -- rule / resource / category the change is about
  payload       jsonb NOT NULL,                               -- what the venue asked for
  current       jsonb,                                        -- what is live now (snapshot at filing time)
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','countered','approved','rejected','withdrawn')),
  counter       jsonb,                                        -- the platform's counter-offer (same shape as payload)
  thread        jsonb NOT NULL DEFAULT '[]',                  -- negotiation log: [{at, by, role, action, note}]
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_requests_queue ON price_requests (status, created_at) WHERE status IN ('pending','countered');
CREATE INDEX price_requests_venue ON price_requests (venue_id, created_at DESC);

-- Every platform price decision, with the factors behind it (location, demand, rating, facilities, discounts).
CREATE TABLE price_list_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues,
  version     int NOT NULL,
  snapshot    jsonb NOT NULL,                                 -- base rates + platform rules after the change
  factors     jsonb NOT NULL DEFAULT '{}',
  note        text,
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, version)
);

-- ---------------------------------------------------------------- contracts
CREATE TABLE contract_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  body          text NOT NULL,                                -- plain text with {{placeholders}}
  default_terms jsonb NOT NULL DEFAULT '{}',
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_contracts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_no    text NOT NULL UNIQUE,                        -- e.g. CTR-000007-v2
  partner_id     uuid NOT NULL REFERENCES partners,
  venue_id       uuid REFERENCES venues,                      -- null = covers all of the partner's venues
  version        int NOT NULL DEFAULT 1,
  supersedes_id  uuid REFERENCES partner_contracts,
  template_id    uuid REFERENCES contract_templates,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','active','declined','terminated','superseded')),
  terms          jsonb NOT NULL,
  clauses        jsonb NOT NULL DEFAULT '[]',                 -- custom clauses added during onboarding
  body           text NOT NULL,                               -- the rendered agreement
  body_sha256    text NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  sent_at        timestamptz,
  accepted_by    uuid REFERENCES users,
  accepted_at    timestamptz,
  terminated_at  timestamptz,
  termination_reason text,
  created_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_contracts_partner ON partner_contracts (partner_id, created_at DESC);
CREATE INDEX partner_contracts_venue ON partner_contracts (venue_id) WHERE status = 'active';
CREATE SEQUENCE contract_no_seq;

-- ---------------------------------------------------------------- settlements
CREATE TABLE settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_no    text NOT NULL UNIQUE,
  partner_id       uuid NOT NULL REFERENCES partners,
  venue_id         uuid NOT NULL REFERENCES venues,
  contract_id      uuid NOT NULL REFERENCES partner_contracts,
  currency         text NOT NULL,
  period_start     date,
  period_end       date NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','void')),
  invoices_count   int NOT NULL DEFAULT 0,
  sales_cents      bigint NOT NULL DEFAULT 0,                 -- ex-tax sales, net of credit notes
  tax_cents        bigint NOT NULL DEFAULT 0,
  platform_collected_cents bigint NOT NULL DEFAULT 0,         -- money the platform took (online / wallet), incl. tax, net of refunds
  venue_collected_cents    bigint NOT NULL DEFAULT 0,         -- money the venue took at the counter
  commission_bp    int NOT NULL,
  commission_cents bigint NOT NULL DEFAULT 0,
  commission_tax_cents bigint NOT NULL DEFAULT 0,
  gateway_fee_cents bigint NOT NULL DEFAULT 0,
  reserve_held_cents bigint NOT NULL DEFAULT 0,
  reserve_released_cents bigint NOT NULL DEFAULT 0,
  adjustments_cents bigint NOT NULL DEFAULT 0,
  net_payable_cents bigint NOT NULL DEFAULT 0,                -- positive: platform pays the partner; negative: partner owes the platform
  flags            jsonb NOT NULL DEFAULT '[]',               -- assistant anomaly flags
  notes            text,
  payout_ref       text,
  reserve_released_by uuid REFERENCES settlements,            -- set on the settlement whose reserve was released later
  approved_by      uuid REFERENCES users,
  approved_at      timestamptz,
  paid_at          timestamptz,
  created_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlements_partner ON settlements (partner_id, created_at DESC);
CREATE INDEX settlements_venue ON settlements (venue_id, period_end DESC);
CREATE SEQUENCE settlement_no_seq;

CREATE TABLE settlement_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES settlements,
  invoice_id    uuid REFERENCES invoices,                     -- an invoice (+) or credit note (-)
  kind          text NOT NULL CHECK (kind IN ('invoice','credit_note','adjustment')),
  description   text,
  sales_cents   bigint NOT NULL DEFAULT 0,                    -- ex-tax, signed
  collected_cents bigint NOT NULL DEFAULT 0,                  -- incl. tax, signed
  collected_by  text CHECK (collected_by IN ('platform','venue')),
  amount_cents  bigint NOT NULL DEFAULT 0,                    -- adjustment amount, signed
  live          boolean NOT NULL DEFAULT true                 -- false once the settlement is voided, so the invoice can be settled again
);
CREATE UNIQUE INDEX settlement_lines_invoice_live ON settlement_lines (invoice_id) WHERE live AND invoice_id IS NOT NULL;
CREATE INDEX settlement_lines_settlement ON settlement_lines (settlement_id);

-- ---------------------------------------------------------------- platform ledger (revenue and cost entries that are not bookings)
CREATE TABLE platform_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date  date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('revenue','cost')),
  category    text NOT NULL,                                  -- e.g. payment_gateway, marketing, onboarding_incentive, subscription_fee
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency    text NOT NULL,
  partner_id  uuid REFERENCES partners,
  venue_id    uuid REFERENCES venues,
  description text,
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_ledger_date ON platform_ledger (entry_date DESC);
