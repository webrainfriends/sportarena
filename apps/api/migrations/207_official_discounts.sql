-- R36: Referee pricing discounts and promotions (#1017)
-- New tables: official_discounts, official_discount_redemptions, official_discount_approvals
-- Alters: official_invoices (discount columns), official_rate_agreements (discount columns)

BEGIN;

CREATE TABLE IF NOT EXISTS official_discounts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                  uuid NOT NULL REFERENCES users(id),
  owner_type                text NOT NULL CHECK (owner_type IN ('referee','organisation','platform')),
  funded_by                 text NOT NULL CHECK (funded_by IN ('referee','platform','organisation')),
  name                      text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  description               text,
  kind                      text NOT NULL CHECK (kind IN ('percent','fixed')),
  value_bp                  integer CHECK (value_bp BETWEEN 1 AND 10000),   -- basis points (100 = 1%) for percent
  value_minor               bigint CHECK (value_minor > 0),                 -- minor units for fixed
  currency                  char(3),
  discount_type             text NOT NULL CHECK (discount_type IN (
                              'recurring_contract','event','bulk_games',
                              'early_commitment','loyalty','first_booking','coupon','referral')),
  code                      text CHECK (char_length(code) BETWEEN 3 AND 32),
  code_normalized           text GENERATED ALWAYS AS (upper(trim(code))) STORED,
  auto_apply                boolean NOT NULL DEFAULT false,
  eligible_sports           uuid[],
  eligible_grade_levels     text[],
  eligible_customer_types   text[] NOT NULL DEFAULT ARRAY['academy','event_organiser','venue','individual'],
  min_booking_count         integer CHECK (min_booking_count >= 1),
  min_contract_value_minor  bigint CHECK (min_contract_value_minor >= 0),
  days_advance              integer CHECK (days_advance >= 1),
  loyalty_min_prior_bookings integer CHECK (loyalty_min_prior_bookings >= 1),
  max_redemptions           integer CHECK (max_redemptions >= 1),
  per_official_limit        integer CHECK (per_official_limit >= 1),
  per_customer_limit        integer CHECK (per_customer_limit >= 1),
  valid_from                timestamptz,
  valid_to                  timestamptz,
  min_price_floor_minor     bigint CHECK (min_price_floor_minor >= 0),
  min_price_floor_pct       integer CHECK (min_price_floor_pct BETWEEN 0 AND 100),
  stackable                 boolean NOT NULL DEFAULT false,
  stack_priority            integer NOT NULL DEFAULT 0,
  max_stack_discount_bp     integer CHECK (max_stack_discount_bp BETWEEN 1 AND 10000),
  requires_approval         boolean NOT NULL DEFAULT false,
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','expired','cancelled')),
  terms_enc                 text,
  metadata                  jsonb,
  created_by                uuid REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  archived_at               timestamptz,

  CONSTRAINT chk_percent_needs_bp  CHECK (kind <> 'percent' OR value_bp IS NOT NULL),
  CONSTRAINT chk_fixed_needs_minor CHECK (kind <> 'fixed' OR (value_minor IS NOT NULL AND currency IS NOT NULL)),
  CONSTRAINT chk_valid_range       CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS official_discounts_owner_code_uidx
  ON official_discounts(owner_id, code_normalized)
  WHERE code_normalized IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS official_discounts_owner_idx  ON official_discounts(owner_id)       WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS official_discounts_status_idx ON official_discounts(status)          WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS official_discounts_type_idx   ON official_discounts(discount_type)   WHERE archived_at IS NULL;

-- ── Redemptions ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS official_discount_redemptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id            uuid NOT NULL REFERENCES official_discounts(id),
  redeemed_by            uuid NOT NULL REFERENCES users(id),
  customer_id            uuid NOT NULL REFERENCES users(id),
  customer_org_id        uuid REFERENCES organisations(id),
  customer_type          text NOT NULL,
  booking_ref_id         uuid NOT NULL,
  booking_ref_type       text NOT NULL CHECK (booking_ref_type IN ('rate_agreement','invoice','engagement','education')),
  applied_kind           text NOT NULL CHECK (applied_kind IN ('percent','fixed')),
  applied_value_bp       integer,
  applied_value_minor    bigint,
  list_price_minor       bigint NOT NULL,
  discounted_price_minor bigint NOT NULL,
  saving_minor           bigint NOT NULL GENERATED ALWAYS AS (list_price_minor - discounted_price_minor) STORED,
  currency               char(3) NOT NULL,
  funded_by_snapshot     text NOT NULL,
  applied_at             timestamptz NOT NULL DEFAULT now(),
  voided_at              timestamptz,
  void_reason            text,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_percent_bp  CHECK (applied_kind <> 'percent' OR applied_value_bp IS NOT NULL),
  CONSTRAINT chk_fixed_minor CHECK (applied_kind <> 'fixed'   OR applied_value_minor IS NOT NULL),
  CONSTRAINT chk_floor       CHECK (discounted_price_minor >= 0)
);

CREATE INDEX IF NOT EXISTS odr_discount_idx    ON official_discount_redemptions(discount_id);
CREATE INDEX IF NOT EXISTS odr_redeemed_by_idx ON official_discount_redemptions(redeemed_by);
CREATE INDEX IF NOT EXISTS odr_customer_idx    ON official_discount_redemptions(customer_id);
CREATE INDEX IF NOT EXISTS odr_booking_ref_idx ON official_discount_redemptions(booking_ref_id, booking_ref_type);

-- ── Floor override approvals ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS official_discount_approvals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id          uuid NOT NULL REFERENCES official_discounts(id),
  redemption_id        uuid REFERENCES official_discount_redemptions(id),
  requested_by         uuid NOT NULL REFERENCES users(id),
  approved_by          uuid REFERENCES users(id),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  floor_override_reason text,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  decided_at           timestamptz,
  expires_at           timestamptz,
  notes                text
);

CREATE INDEX IF NOT EXISTS oda_discount_idx ON official_discount_approvals(discount_id);
CREATE INDEX IF NOT EXISTS oda_status_idx   ON official_discount_approvals(status) WHERE status = 'pending';

-- ── Extend official_invoices ─────────────────────────────────────────────────

ALTER TABLE official_invoices
  ADD COLUMN IF NOT EXISTS pre_discount_gross_minor bigint,
  ADD COLUMN IF NOT EXISTS discount_minor            bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_redemption_id    uuid REFERENCES official_discount_redemptions(id),
  ADD COLUMN IF NOT EXISTS discount_code             text,
  ADD COLUMN IF NOT EXISTS discount_funded_by        text;

-- ── Extend official_rate_agreements ─────────────────────────────────────────

ALTER TABLE official_rate_agreements
  ADD COLUMN IF NOT EXISTS discount_id              uuid REFERENCES official_discounts(id),
  ADD COLUMN IF NOT EXISTS discount_redemption_id   uuid REFERENCES official_discount_redemptions(id),
  ADD COLUMN IF NOT EXISTS applied_discount_bp      integer,
  ADD COLUMN IF NOT EXISTS applied_discount_minor   bigint,
  ADD COLUMN IF NOT EXISTS pre_discount_fee_minor   bigint,
  ADD COLUMN IF NOT EXISTS discount_funded_by       text;

COMMIT;
