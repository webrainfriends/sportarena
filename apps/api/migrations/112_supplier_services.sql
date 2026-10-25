-- Supplier services & procurement (issue #458). Additive only: new tables (svc_*), one widened CHECK on `invoices`/`payments`, nullable columns.
-- Nothing is dropped, truncated or rewritten. Existing shop goods, inventory/replenishment orders, event requests/budgets and venue/academy invoices are untouched.
-- Money: integer minor units + ISO currency on every row; tax in basis points; quantities are numeric(14,3). Records are never deleted (status / archived_at).
-- Rollback: stop using the capabilities (revert the code). Dropping the tables is a deliberate maintainer decision, never automatic.

-- ---------------------------------------------------------------- supplier identity
CREATE TABLE IF NOT EXISTS svc_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users,
  organisation_id  uuid REFERENCES organisations,                 -- the acting legal entity when the supplier is a company
  supplier_type    text NOT NULL CHECK (supplier_type IN ('individual','sole_trader','company')),
  legal_name       text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 160),
  trading_name     text CHECK (trading_name IS NULL OR length(trading_name) <= 160),
  description      text CHECK (description IS NULL OR length(description) <= 4000),
  categories       text[] NOT NULL DEFAULT '{}',
  coverage         jsonb NOT NULL DEFAULT '{}',                    -- {countries:[..], regions:[..], radius_km}
  operating_hours  jsonb NOT NULL DEFAULT '{}',                    -- {mon:[["09:00","17:00"]], ...}
  lead_time_days   int NOT NULL DEFAULT 0 CHECK (lead_time_days BETWEEN 0 AND 365),
  daily_capacity   numeric(10,2) CHECK (daily_capacity IS NULL OR daily_capacity >= 0),   -- units/day the supplier can deliver (NULL = not capped)
  contact_channel  text CHECK (contact_channel IS NULL OR length(contact_channel) <= 160),
  currencies       text[] NOT NULL DEFAULT '{}',
  timezone         text NOT NULL DEFAULT 'UTC',
  tax_registration text,                                            -- GSTIN / VAT id etc, printed on invoices
  billing_address  text,
  terms            text CHECK (terms IS NULL OR length(terms) <= 4000),
  invoice_prefix   text CHECK (invoice_prefix IS NULL OR invoice_prefix ~ '^[A-Z0-9]{2,8}$'),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  suspended_reason text,
  row_version      int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_profiles_owner_entity ON svc_profiles (owner_id, coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status <> 'archived';
CREATE UNIQUE INDEX IF NOT EXISTS svc_profiles_prefix ON svc_profiles (invoice_prefix) WHERE invoice_prefix IS NOT NULL;
CREATE INDEX IF NOT EXISTS svc_profiles_cat ON svc_profiles USING gin (categories);

CREATE TABLE IF NOT EXISTS svc_staff (                              -- who acts for the supplier, and in which capacity
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES svc_profiles,
  user_id     uuid NOT NULL REFERENCES users,
  role        text NOT NULL CHECK (role IN ('owner','sales','scheduler','supervisor','finance','crew')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_staff_live ON svc_staff (profile_id, user_id, role) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS svc_staff_user ON svc_staff (user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS svc_credentials (                        -- certificates / insurance; the badge says what was actually checked
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES svc_profiles,
  kind        text NOT NULL CHECK (kind IN ('insurance','electrical','pool_operator','first_aid','safeguarding','vehicle','food_safety','business_registration','other')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  reference   text,
  valid_from  date,
  valid_to    date,
  required_for_award boolean NOT NULL DEFAULT false,
  verification text NOT NULL DEFAULT 'self_declared' CHECK (verification IN ('self_declared','document_seen','verified_by_admin')),
  verified_by uuid REFERENCES users,
  verified_at timestamptz,
  document_ref text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svc_credentials_profile ON svc_credentials (profile_id, status, valid_to);

-- ---------------------------------------------------------------- offerings (the catalogue itself lives in code: src/svc/catalogue.js)
CREATE TABLE IF NOT EXISTS svc_offerings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     uuid NOT NULL REFERENCES svc_profiles,
  category       text NOT NULL,
  subcategory    text,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description    text CHECK (description IS NULL OR length(description) <= 4000),
  mode           text NOT NULL CHECK (mode IN ('service','goods','mixed')),
  pricing_model  text NOT NULL CHECK (pricing_model IN ('quote_only','fixed')),
  unit           text NOT NULL,
  rate_minor     bigint CHECK (rate_minor IS NULL OR rate_minor >= 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  min_quantity   numeric(14,3) NOT NULL DEFAULT 1 CHECK (min_quantity > 0),
  inclusions     text[] NOT NULL DEFAULT '{}',
  exclusions     text[] NOT NULL DEFAULT '{}',
  deliverables   text[] NOT NULL DEFAULT '{}',
  specs          jsonb NOT NULL DEFAULT '{}',                       -- category-specific typed fields (validated against the catalogue)
  geography      jsonb NOT NULL DEFAULT '{}',
  requires_certifications text[] NOT NULL DEFAULT '{}',
  goods_product_id uuid REFERENCES shop_products,                   -- optional link to the goods side of a mixed bundle (stock stays in the shop)
  media          jsonb NOT NULL DEFAULT '[]',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  row_version    int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (pricing_model = 'quote_only' OR rate_minor IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS svc_offerings_cat ON svc_offerings (category, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS svc_offerings_profile ON svc_offerings (profile_id, status, created_at DESC, id);

-- ---------------------------------------------------------------- tax configuration (effective-dated, per issuing supplier; never hard-coded)
CREATE TABLE IF NOT EXISTS svc_tax_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES svc_profiles,
  code            text NOT NULL CHECK (length(code) BETWEEN 1 AND 24),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  jurisdiction    text NOT NULL CHECK (length(jurisdiction) BETWEEN 1 AND 40),
  treatment       text NOT NULL DEFAULT 'standard' CHECK (treatment IN ('standard','zero_rated','exempt','reverse_charge')),
  rate_bp         int NOT NULL DEFAULT 0 CHECK (rate_bp BETWEEN 0 AND 10000),
  withholding_bp  int NOT NULL DEFAULT 0 CHECK (withholding_bp BETWEEN 0 AND 10000),   -- deducted by the buyer from the net where configured
  prices_include_tax boolean NOT NULL DEFAULT false,
  rounding        text NOT NULL DEFAULT 'per_line' CHECK (rounding IN ('per_line','per_document')),
  effective_from  date NOT NULL,
  effective_to    date,
  evidence        text,
  reviewed_by     uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS svc_tax_rules_lookup ON svc_tax_rules (profile_id, code, effective_from DESC);

-- ---------------------------------------------------------------- buyers (an organisation, an event, a venue or a person) and their delegated roles
CREATE TABLE IF NOT EXISTS svc_buyers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  event_id        uuid REFERENCES events,
  venue_id        uuid REFERENCES venues,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  timezone        text NOT NULL DEFAULT 'UTC',
  approval_policy jsonb NOT NULL DEFAULT '{}',                      -- {thresholds:[{up_to_minor, role}], single_supplier_needs_justification}
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_buyers_event ON svc_buyers (event_id) WHERE event_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS svc_buyers_org ON svc_buyers (organisation_id) WHERE organisation_id IS NOT NULL AND event_id IS NULL AND venue_id IS NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS svc_buyers_venue ON svc_buyers (venue_id) WHERE venue_id IS NOT NULL AND event_id IS NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS svc_buyers_person ON svc_buyers (owner_id) WHERE organisation_id IS NULL AND event_id IS NULL AND venue_id IS NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS svc_buyer_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id    uuid NOT NULL REFERENCES svc_buyers,
  user_id     uuid NOT NULL REFERENCES users,
  role        text NOT NULL CHECK (role IN ('requester','evaluator','approver','purchaser','acceptor','finance')),
  limit_minor bigint CHECK (limit_minor IS NULL OR limit_minor >= 0),   -- approver/purchaser delegated limit (NULL = no limit)
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_buyer_roles_live ON svc_buyer_roles (buyer_id, user_id, role) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS svc_buyer_roles_user ON svc_buyer_roles (user_id) WHERE status = 'active';

-- ---------------------------------------------------------------- planning: lots and requirements
CREATE TABLE IF NOT EXISTS svc_lots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id   uuid NOT NULL REFERENCES svc_buyers,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  budget_minor bigint CHECK (budget_minor IS NULL OR budget_minor >= 0),
  currency   text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_lots_name ON svc_lots (buyer_id, lower(name)) WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS svc_requirements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id       uuid NOT NULL REFERENCES svc_buyers,
  lot_id         uuid REFERENCES svc_lots,
  event_id       uuid REFERENCES events,
  venue_id       uuid REFERENCES venues,
  category       text NOT NULL,
  subcategory    text,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  scope          jsonb NOT NULL DEFAULT '{}',                       -- typed per category (validated against the catalogue)
  quantity       numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit           text NOT NULL,
  headcount      int CHECK (headcount IS NULL OR headcount > 0),
  starts_at      timestamptz,
  ends_at        timestamptz,
  timezone       text NOT NULL DEFAULT 'UTC',
  recurrence     jsonb,                                              -- {freq:'weekly', by_day:['mon'], until:'2026-12-31'}
  site_access    text,
  qualifications text[] NOT NULL DEFAULT '{}',
  budget_minor   bigint CHECK (budget_minor IS NULL OR budget_minor >= 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  owner_id       uuid REFERENCES users,
  depends_on     uuid[] NOT NULL DEFAULT '{}',
  deadline       date,
  acceptance_criteria text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','needs_quotes','quoting','evaluating','awarded','confirmed','delivered','closed','cancelled')),
  copied_from    uuid REFERENCES svc_requirements,                  -- a template copy carries scope and proposed dates only
  row_version    int NOT NULL DEFAULT 1,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS svc_requirements_buyer ON svc_requirements (buyer_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS svc_requirements_event ON svc_requirements (event_id) WHERE event_id IS NOT NULL;

-- ---------------------------------------------------------------- RFQ, invitations, clarifications
CREATE TABLE IF NOT EXISTS svc_rfqs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          uuid NOT NULL REFERENCES svc_buyers,
  requirement_id    uuid NOT NULL REFERENCES svc_requirements,
  lot_id            uuid REFERENCES svc_lots,
  event_request_id  uuid REFERENCES event_requests,                 -- the existing event request this RFQ adapts (inbox stays canonical)
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  scope_version     int NOT NULL DEFAULT 1,
  scope             jsonb NOT NULL,                                  -- frozen snapshot of the requirement for this version
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  audience          text NOT NULL DEFAULT 'invited' CHECK (audience IN ('invited','published')),
  invite_deadline   timestamptz,
  question_deadline timestamptz,
  quote_deadline    timestamptz,
  rubric            jsonb NOT NULL DEFAULT '[]',                     -- [{key,label,weight}]
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','quoting','evaluation','approval_pending','awarded','partially_awarded','closed','declined','withdrawn','cancelled','expired')),
  allow_partial     boolean NOT NULL DEFAULT false,
  single_supplier_justification text,
  row_version       int NOT NULL DEFAULT 1,
  created_by        uuid NOT NULL REFERENCES users,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svc_rfqs_buyer ON svc_rfqs (buyer_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS svc_rfqs_requirement ON svc_rfqs (requirement_id);

CREATE TABLE IF NOT EXISTS svc_rfq_versions (                       -- every scope change keeps the previous snapshot
  rfq_id     uuid NOT NULL REFERENCES svc_rfqs,
  version    int NOT NULL,
  scope      jsonb NOT NULL,
  changed_by uuid REFERENCES users,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rfq_id, version)
);

CREATE TABLE IF NOT EXISTS svc_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id      uuid NOT NULL REFERENCES svc_rfqs,
  profile_id  uuid NOT NULL REFERENCES svc_profiles,
  status      text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','declined','site_visit_requested','quoted','withdrawn','closed')),
  reason      text,
  site_visit_at timestamptz,
  responded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, profile_id)
);
CREATE INDEX IF NOT EXISTS svc_invites_profile ON svc_invites (profile_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS svc_clarifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id      uuid NOT NULL REFERENCES svc_rfqs,
  invite_id   uuid REFERENCES svc_invites,                          -- the asking supplier (NULL for buyer notices)
  author_id   uuid NOT NULL REFERENCES users,
  author_side text NOT NULL CHECK (author_side IN ('buyer','supplier')),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  shared      boolean NOT NULL DEFAULT false,                       -- a shared answer is shown to every invited supplier, without who asked
  answers_id  uuid REFERENCES svc_clarifications,
  attachments jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svc_clarifications_rfq ON svc_clarifications (rfq_id, created_at, id);

-- ---------------------------------------------------------------- quotes (versioned) and their lines
CREATE TABLE IF NOT EXISTS svc_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id        uuid NOT NULL REFERENCES svc_rfqs,
  invite_id     uuid NOT NULL REFERENCES svc_invites,
  profile_id    uuid NOT NULL REFERENCES svc_profiles,
  version       int NOT NULL CHECK (version >= 1),
  scope_version int NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','withdrawn','superseded','expired','shortlisted','rejected','awarded','partially_awarded')),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_until   timestamptz,
  prices_include_tax boolean NOT NULL DEFAULT false,
  net_minor     bigint NOT NULL DEFAULT 0,
  tax_minor     bigint NOT NULL DEFAULT 0,
  gross_minor   bigint NOT NULL DEFAULT 0,
  terms         jsonb NOT NULL DEFAULT '{}',                         -- {cancellation, warranty, sla, payment_terms, deposit_bp, assumptions, inclusions, exclusions, staffing, schedule, milestones}
  fx_snapshot   jsonb,                                               -- comparison only: {base, rate, as_of}
  submitted_at  timestamptz,
  row_version   int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, profile_id, version)
);
CREATE INDEX IF NOT EXISTS svc_quotes_rfq ON svc_quotes (rfq_id, status);
CREATE INDEX IF NOT EXISTS svc_quotes_profile ON svc_quotes (profile_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS svc_quote_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id     uuid NOT NULL REFERENCES svc_quotes,
  line_no      int NOT NULL,
  line_type    text NOT NULL CHECK (line_type IN ('service','goods')),
  charge_kind  text NOT NULL DEFAULT 'labour' CHECK (charge_kind IN ('labour','material','travel','equipment','other')),
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 400),
  quantity     numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit         text NOT NULL,
  rate_minor   bigint NOT NULL CHECK (rate_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_code     text,
  tax_bp       int NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
  tax_treatment text NOT NULL DEFAULT 'standard',
  net_minor    bigint NOT NULL,
  tax_minor    bigint NOT NULL,
  gross_minor  bigint NOT NULL,
  milestone    text,
  delivery_on  date,
  UNIQUE (quote_id, line_no)
);

-- ---------------------------------------------------------------- evaluation and approval
CREATE TABLE IF NOT EXISTS svc_evaluations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id       uuid NOT NULL REFERENCES svc_rfqs,
  quote_id     uuid NOT NULL REFERENCES svc_quotes,
  evaluator_id uuid NOT NULL REFERENCES users,
  scores       jsonb NOT NULL DEFAULT '{}',
  total        numeric(8,2) NOT NULL DEFAULT 0,
  rationale    text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  compliant    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, evaluator_id)
);

CREATE TABLE IF NOT EXISTS svc_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id      uuid NOT NULL REFERENCES svc_buyers,
  subject_type  text NOT NULL CHECK (subject_type IN ('award','variation','invoice_exception','termination')),
  subject_id    uuid NOT NULL,
  rfq_id        uuid REFERENCES svc_rfqs,
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  currency      text NOT NULL,
  requested_by  uuid NOT NULL REFERENCES users,
  decided_by    uuid REFERENCES users,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  exception_reason text,
  decision_note text,
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)           -- separation of duties, enforced in the database too
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_approvals_open ON svc_approvals (subject_type, subject_id) WHERE status = 'pending';

-- ---------------------------------------------------------------- orders (purchase / service orders), lines, variations
CREATE TABLE IF NOT EXISTS svc_counters (
  scope_id uuid NOT NULL,
  kind     text NOT NULL,
  seq      int NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, kind)
);

CREATE TABLE IF NOT EXISTS svc_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text NOT NULL UNIQUE,
  buyer_id       uuid NOT NULL REFERENCES svc_buyers,
  profile_id     uuid NOT NULL REFERENCES svc_profiles,
  rfq_id         uuid REFERENCES svc_rfqs,
  quote_id       uuid REFERENCES svc_quotes,
  quote_version  int,
  scope_version  int,
  requirement_id uuid REFERENCES svc_requirements,
  lot_id         uuid REFERENCES svc_lots,
  event_id       uuid REFERENCES events,
  venue_id       uuid REFERENCES venues,
  budget_line_id uuid REFERENCES event_budget_lines,                 -- the single commitment this order links (never counted again through finance)
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  net_minor      bigint NOT NULL,
  tax_minor      bigint NOT NULL,
  gross_minor    bigint NOT NULL,
  tax_snapshot   jsonb NOT NULL DEFAULT '{}',
  terms          jsonb NOT NULL DEFAULT '{}',
  approval_id    uuid REFERENCES svc_approvals,
  status         text NOT NULL DEFAULT 'pending_supplier' CHECK (status IN ('pending_supplier','changes_proposed','confirmed','in_progress','paused','completed','cancelled','terminated','rejected')),
  fulfilment     text NOT NULL DEFAULT 'planned' CHECK (fulfilment IN ('planned','scheduled','in_progress','submitted_for_acceptance','partially_accepted','accepted','rework','cancelled')),
  billing        text NOT NULL DEFAULT 'not_billed' CHECK (billing IN ('not_billed','partially_billed','billed')),
  settlement     text NOT NULL DEFAULT 'unpaid' CHECK (settlement IN ('unpaid','partially_paid','paid')),
  travel_confirmation text CHECK (travel_confirmation IS NULL OR travel_confirmation IN ('supplier_booking_confirmed','third_party_reference_recorded')),
  third_party_ref text,
  agreement_status text NOT NULL DEFAULT 'not_required' CHECK (agreement_status IN ('not_required','pending_signature','signed_by_buyer','signed_by_supplier','fully_signed')),
  reason         text,
  effective_on   date,
  row_version    int NOT NULL DEFAULT 1,
  confirmed_at   timestamptz,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- an accepted quote version backs at most one live order per lot-share (over-award guard is in the award transaction too)
CREATE UNIQUE INDEX IF NOT EXISTS svc_orders_quote_live ON svc_orders (quote_id) WHERE quote_id IS NOT NULL AND status NOT IN ('cancelled','rejected','terminated');
CREATE INDEX IF NOT EXISTS svc_orders_buyer ON svc_orders (buyer_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS svc_orders_profile ON svc_orders (profile_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS svc_orders_event ON svc_orders (event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS svc_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES svc_orders,
  line_no       int NOT NULL,
  line_type     text NOT NULL CHECK (line_type IN ('service','goods')),
  charge_kind   text NOT NULL DEFAULT 'labour',
  description   text NOT NULL,
  unit          text NOT NULL,
  rate_minor    bigint NOT NULL CHECK (rate_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0,
  tax_code      text,
  tax_bp        int NOT NULL DEFAULT 0,
  tax_treatment text NOT NULL DEFAULT 'standard',
  qty_ordered   numeric(14,3) NOT NULL CHECK (qty_ordered >= 0),
  qty_accepted  numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_accepted >= 0),
  qty_invoiced  numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_invoiced >= 0),
  milestone     text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  UNIQUE (order_id, line_no),
  CHECK (qty_accepted <= qty_ordered)                                 -- acceptance can never exceed what was ordered
);

CREATE TABLE IF NOT EXISTS svc_variations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES svc_orders,
  version       int NOT NULL CHECK (version >= 1),
  kind          text NOT NULL CHECK (kind IN ('scope','cost','date','headcount','pause','resume','reschedule','partial_cancellation','termination')),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  effective_on  date,
  changes       jsonb NOT NULL DEFAULT '{}',                         -- {lines:[{line_no, qty_ordered, rate_minor}], add_lines:[..], dates:{..}}
  delta_net_minor bigint NOT NULL DEFAULT 0,
  delta_tax_minor bigint NOT NULL DEFAULT 0,
  proposed_by   uuid NOT NULL REFERENCES users,
  proposed_side text NOT NULL CHECK (proposed_side IN ('buyer','supplier')),
  counterparty_status text NOT NULL DEFAULT 'pending' CHECK (counterparty_status IN ('pending','accepted','rejected')),
  approval_id   uuid REFERENCES svc_approvals,
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','rejected','cancelled')),
  impact        jsonb NOT NULL DEFAULT '{}',                         -- recorded effect on completed work, capacity, fees, refunds, remaining commitment
  idempotency_key text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  UNIQUE (order_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_variations_key ON svc_variations (order_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------- capacity (reserved under a row lock on the profile)
CREATE TABLE IF NOT EXISTS svc_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES svc_profiles,
  order_id    uuid NOT NULL REFERENCES svc_orders,
  day         date NOT NULL,
  units       numeric(10,2) NOT NULL CHECK (units > 0),
  status      text NOT NULL DEFAULT 'held' CHECK (status IN ('held','confirmed','released')),
  hold_expires_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, day)
);
CREATE INDEX IF NOT EXISTS svc_allocations_day ON svc_allocations (profile_id, day) WHERE status <> 'released';

CREATE TABLE IF NOT EXISTS svc_blackouts (                           -- days the supplier cannot work
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES svc_profiles,
  day        date NOT NULL,
  reason     text,
  UNIQUE (profile_id, day)
);

-- ---------------------------------------------------------------- scheduling, fulfilment and acceptance
CREATE TABLE IF NOT EXISTS svc_visits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES svc_orders,
  line_id        uuid REFERENCES svc_order_lines,
  occurrence_key text NOT NULL,                                       -- deterministic (rule + date): regenerating or retrying never duplicates a visit
  site_label     text,
  resource_key   text,                                                -- site/pitch/pool used for conflict detection
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  planned_qty    numeric(14,3) NOT NULL CHECK (planned_qty > 0),
  actual_qty     numeric(14,3),
  supervisor_id  uuid REFERENCES users,
  assignees      uuid[] NOT NULL DEFAULT '{}',
  subcontractor  jsonb,                                               -- {name, approved_by_buyer:boolean}
  checklist      jsonb NOT NULL DEFAULT '[]',
  readings       jsonb NOT NULL DEFAULT '[]',                         -- test readings (pool water, electrical tests) as recorded evidence only
  evidence       jsonb NOT NULL DEFAULT '[]',
  status         text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','scheduled','in_progress','submitted_for_acceptance','accepted','partially_accepted','rejected','rework','paused','cancelled','no_show')),
  rework_due     date,
  notes          text,
  row_version    int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at),
  UNIQUE (order_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS svc_visits_order ON svc_visits (order_id, starts_at);
CREATE INDEX IF NOT EXISTS svc_visits_resource ON svc_visits (resource_key, starts_at) WHERE resource_key IS NOT NULL AND status NOT IN ('cancelled','rejected');

CREATE TABLE IF NOT EXISTS svc_attendance (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id   uuid NOT NULL REFERENCES svc_visits,
  user_id    uuid REFERENCES users,
  name       text,
  status     text NOT NULL CHECK (status IN ('present','late','no_show','replaced')),
  checked_in_at  timestamptz,
  checked_out_at timestamptz,
  hours      numeric(6,2) CHECK (hours IS NULL OR hours >= 0),
  replaced_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS svc_acceptances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES svc_orders,
  line_id     uuid NOT NULL REFERENCES svc_order_lines,
  visit_id    uuid REFERENCES svc_visits,
  decision    text NOT NULL CHECK (decision IN ('accepted','rejected')),
  quantity    numeric(14,3) NOT NULL CHECK (quantity >= 0),
  reason      text,
  rework_due  date,
  decided_by  uuid NOT NULL REFERENCES users,
  idempotency_key text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (decision = 'accepted' OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_acceptances_key ON svc_acceptances (order_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS svc_incidents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES svc_orders,
  visit_id   uuid REFERENCES svc_visits,
  kind       text NOT NULL CHECK (kind IN ('incident','exception','no_show','replacement')),
  detail     text NOT NULL CHECK (length(detail) BETWEEN 1 AND 2000),
  reported_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- finance: supplier invoices live in the canonical `invoices` table
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS svc_profile_id uuid REFERENCES svc_profiles;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS svc_order_id uuid REFERENCES svc_orders;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source;
ALTER TABLE invoices ADD CONSTRAINT invoices_source CHECK (
  (venue_id IS NOT NULL AND reservation_id IS NOT NULL AND organisation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND organisation_id IS NOT NULL AND academy_charge_id IS NOT NULL AND svc_order_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NOT NULL AND svc_profile_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS invoices_svc_order ON invoices (svc_order_id) WHERE svc_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS svc_invoices (                           -- supplier-side detail of an invoice; draft/pro forma exist only here until issued
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid UNIQUE REFERENCES invoices,                    -- set when issued (the immutable canonical record)
  order_id       uuid NOT NULL REFERENCES svc_orders,
  profile_id     uuid NOT NULL REFERENCES svc_profiles,
  buyer_id       uuid NOT NULL REFERENCES svc_buyers,
  doc_type       text NOT NULL CHECK (doc_type IN ('proforma','invoice','credit_note','debit_note')),
  parent_id      uuid REFERENCES svc_invoices,                      -- credit/debit/replacement points at what it adjusts
  supplier_number text NOT NULL,                                     -- number the supplier gave it (unique per issuer for issued documents)
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','void','replaced')),
  currency       text NOT NULL,
  lines          jsonb NOT NULL,                                     -- [{order_line_id, description, unit, quantity, rate_minor, discount_minor, tax_code, tax_bp, net_minor, tax_minor, gross_minor}]
  net_minor      bigint NOT NULL,
  tax_minor      bigint NOT NULL,
  gross_minor    bigint NOT NULL,
  withholding_minor bigint NOT NULL DEFAULT 0,
  payable_minor  bigint NOT NULL,                                    -- gross minus configured withholding
  prices_include_tax boolean NOT NULL DEFAULT false,
  kind           text NOT NULL DEFAULT 'progress' CHECK (kind IN ('deposit','progress','milestone','final','visit','adjustment')),
  milestone      text,
  service_period daterange,
  po_reference   text,
  due_on         date,
  tax_evidence   jsonb NOT NULL DEFAULT '{}',
  match_status   text NOT NULL DEFAULT 'unchecked' CHECK (match_status IN ('unchecked','matched','exception','exception_approved')),
  match_detail   jsonb NOT NULL DEFAULT '{}',
  approval_id    uuid REFERENCES svc_approvals,
  paid_minor     bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  credited_minor bigint NOT NULL DEFAULT 0 CHECK (credited_minor >= 0),
  payer_id       uuid REFERENCES users,                              -- the buyer-side person who started an online payment for this invoice
  pay_status     text NOT NULL DEFAULT 'unpaid' CHECK (pay_status IN ('unpaid','partially_paid','paid','refunded')),
  idempotency_key text,
  issued_at      timestamptz,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_invoices_number ON svc_invoices (profile_id, lower(supplier_number)) WHERE status IN ('issued','void','replaced');   -- duplicate-invoice guard per issuer
CREATE UNIQUE INDEX IF NOT EXISTS svc_invoices_key ON svc_invoices (profile_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS svc_invoices_order ON svc_invoices (order_id, status);
CREATE INDEX IF NOT EXISTS svc_invoices_buyer ON svc_invoices (buyer_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS svc_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  svc_invoice_id uuid NOT NULL REFERENCES svc_invoices,
  source        text NOT NULL CHECK (source IN ('manual_bank','manual_cash','manual_other','provider')),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  currency      text NOT NULL,
  paid_on       date NOT NULL,
  reference     text,
  evidence      text,                                                 -- bank reference / receipt ref; required for manual records
  payment_id    uuid REFERENCES payments,                             -- verified provider payment (signed callback), when source = provider
  status        text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','verified','voided')),
  recorded_by   uuid NOT NULL REFERENCES users,
  voided_by     uuid REFERENCES users,
  void_reason   text,
  payout_state  text NOT NULL DEFAULT 'not_applicable' CHECK (payout_state IN ('not_applicable','manual_pending','manual_recorded')),   -- supplier payout is never faked as transferred
  idempotency_key text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  CHECK (source <> 'provider' OR payment_id IS NOT NULL),
  CHECK (source = 'provider' OR evidence IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_payments_key ON svc_payments (svc_invoice_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS svc_payments_provider ON svc_payments (payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS svc_payments_reference ON svc_payments (svc_invoice_id, lower(reference)) WHERE reference IS NOT NULL AND status <> 'voided';   -- one bank/receipt reference identifies one transfer
CREATE INDEX IF NOT EXISTS svc_payments_invoice ON svc_payments (svc_invoice_id, status);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment','shop_checkout','physio_package','sponsorship_payment','academy_charge','service_invoice'));

-- ---------------------------------------------------------------- activity (append-only trail of state changes, reasons and approvals)
CREATE TABLE IF NOT EXISTS svc_activity (
  id          bigserial PRIMARY KEY,
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  actor_id    uuid REFERENCES users,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svc_activity_entity ON svc_activity (entity, entity_id, id);

-- issued supplier invoices are immutable snapshots: only payment/match/state columns may change after issue
CREATE OR REPLACE FUNCTION svc_invoice_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('issued','void','replaced') AND (
       NEW.lines IS DISTINCT FROM OLD.lines OR NEW.net_minor <> OLD.net_minor OR NEW.tax_minor <> OLD.tax_minor OR NEW.gross_minor <> OLD.gross_minor
       OR NEW.currency <> OLD.currency OR NEW.supplier_number <> OLD.supplier_number OR NEW.order_id <> OLD.order_id) THEN
    RAISE EXCEPTION 'issued supplier invoices are immutable; issue a credit note or replacement' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS svc_invoice_immutable ON svc_invoices;
CREATE TRIGGER svc_invoice_immutable BEFORE UPDATE ON svc_invoices FOR EACH ROW EXECUTE FUNCTION svc_invoice_immutable();

-- submitted quote lines are frozen once the quote leaves draft
CREATE OR REPLACE FUNCTION svc_quote_lines_frozen() RETURNS trigger AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM svc_quotes WHERE id = coalesce(NEW.quote_id, OLD.quote_id);
  IF s <> 'draft' THEN RAISE EXCEPTION 'a submitted quote version cannot be edited; submit a new version' USING ERRCODE = '23514'; END IF;
  RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS svc_quote_lines_frozen ON svc_quote_lines;
CREATE TRIGGER svc_quote_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON svc_quote_lines FOR EACH ROW EXECUTE FUNCTION svc_quote_lines_frozen();

-- ---------------------------------------------------------------- event budget links (one commitment, one payment: never counted twice)
ALTER TABLE event_budget_lines    ADD COLUMN IF NOT EXISTS svc_order_id   uuid REFERENCES svc_orders;
ALTER TABLE event_budget_payments ADD COLUMN IF NOT EXISTS svc_payment_id uuid REFERENCES svc_payments;
CREATE UNIQUE INDEX IF NOT EXISTS event_budget_lines_svc_order ON event_budget_lines (svc_order_id) WHERE svc_order_id IS NOT NULL AND status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS event_budget_payments_svc ON event_budget_payments (svc_payment_id) WHERE svc_payment_id IS NOT NULL;
