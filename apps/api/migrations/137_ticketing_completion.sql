-- Ticketing completion (#699): promo codes, waitlist, resale policy, parking and merchandise add-ons, reporting.
-- Additive only: new tables and columns, and two CHECK constraints widened in place (a superset of what they allowed); no row changes meaning, nothing is removed.
--  * Promo codes reuse the existing `discounts` / `discount_redemptions` framework (venue and academy codes already live there); a code can now belong to an event.
--    A redemption is recorded when the order is created (so limits are exact under the event lock) and is reversed (reversed_at), never deleted, when an unpaid order lapses.
--  * Waitlist offers are real reservations: promoting someone creates a held order, so the existing capacity check counts it and oversell stays impossible.
--  * Add-ons (parking, merchandise) sit in the same order and the same payment; they have their own stock and a collected state, and never count towards spectator capacity.
--  * The discount is stored per ticket (what the buyer actually paid is price - discount), so a refund gives back exactly what was charged.
-- Rollback = deploy the previous code; it ignores these columns and tables.

-- ---- promo codes -------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES events;
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS max_discount_minor bigint CHECK (max_discount_minor IS NULL OR max_discount_minor > 0);   -- cap on what one order can take off
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS stackable boolean NOT NULL DEFAULT false;                                                 -- may be combined with another code on one order
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS product_ids uuid[] NOT NULL DEFAULT '{}';                                                 -- ticket products it applies to; empty = all
ALTER TABLE discounts DROP CONSTRAINT IF EXISTS discounts_owner;
ALTER TABLE discounts ADD CONSTRAINT discounts_owner CHECK (
     (venue_id IS NOT NULL AND organisation_id IS NULL AND programme_id IS NULL AND event_id IS NULL)
  OR (venue_id IS NULL AND organisation_id IS NOT NULL AND event_id IS NULL)
  OR (venue_id IS NULL AND organisation_id IS NULL AND programme_id IS NULL AND event_id IS NOT NULL));
ALTER TABLE discounts ADD CONSTRAINT discounts_event_fixed_currency CHECK (event_id IS NULL OR kind = 'percent' OR currency IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS discounts_event_code ON discounts (event_id, upper(code)) WHERE event_id IS NOT NULL AND code IS NOT NULL;

ALTER TABLE discount_redemptions ADD COLUMN IF NOT EXISTS ticket_order_id uuid REFERENCES ticket_orders;
ALTER TABLE discount_redemptions ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE discount_redemptions DROP CONSTRAINT IF EXISTS discount_redemptions_target;
ALTER TABLE discount_redemptions ADD CONSTRAINT discount_redemptions_target CHECK (
  (reservation_id IS NOT NULL)::int + (enrolment_id IS NOT NULL)::int + (ticket_order_id IS NOT NULL)::int = 1);
CREATE UNIQUE INDEX IF NOT EXISTS discount_redemptions_ticket_order ON discount_redemptions (discount_id, ticket_order_id) WHERE ticket_order_id IS NOT NULL;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0);          -- promo share of this ticket; the buyer paid price_minor - discount_minor
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS discount_tax_minor bigint NOT NULL DEFAULT 0 CHECK (discount_tax_minor >= 0);  -- the tax that discount took off
ALTER TABLE ticket_order_lines ADD COLUMN IF NOT EXISTS discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0);
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0);
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS addons_minor bigint NOT NULL DEFAULT 0 CHECK (addons_minor >= 0);

-- ---- resale / transfer policy and waitlist settings ---------------------------------------------------------------------------------------------
ALTER TABLE ticket_settings ADD COLUMN IF NOT EXISTS resale_mode text NOT NULL DEFAULT 'transfer_only' CHECK (resale_mode IN ('transfer_only','resale'));
ALTER TABLE ticket_settings ADD COLUMN IF NOT EXISTS resale_cap_bp integer NOT NULL DEFAULT 10000 CHECK (resale_cap_bp BETWEEN 0 AND 10000);   -- never above face value
ALTER TABLE ticket_settings ADD COLUMN IF NOT EXISTS resale_fee_bp integer NOT NULL DEFAULT 0 CHECK (resale_fee_bp BETWEEN 0 AND 5000);
ALTER TABLE ticket_settings ADD COLUMN IF NOT EXISTS waitlist_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE ticket_settings ADD COLUMN IF NOT EXISTS waitlist_offer_minutes integer NOT NULL DEFAULT 15 CHECK (waitlist_offer_minutes BETWEEN 5 AND 120);

-- every change to the transfer, resale, refund or waitlist rules; appended to, never changed
CREATE TABLE IF NOT EXISTS ticket_policy_history (
  id        bigserial PRIMARY KEY,
  event_id  uuid NOT NULL REFERENCES events,
  actor_id  uuid REFERENCES users,
  field     text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_policy_history_event ON ticket_policy_history (event_id, id);
CREATE TRIGGER ticket_policy_history_append_only BEFORE UPDATE OR DELETE ON ticket_policy_history FOR EACH ROW EXECUTE FUNCTION ticket_append_only();

-- a priced hand-over between two accounts, checked against the cap and recorded with the fee the organiser is owed
CREATE TABLE IF NOT EXISTS ticket_resales (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  entitlement_id uuid NOT NULL,
  from_ticket_id uuid NOT NULL REFERENCES tickets,
  to_ticket_id   uuid REFERENCES tickets,
  seller_id      uuid NOT NULL REFERENCES users,
  buyer_id       uuid NOT NULL REFERENCES users,
  face_minor     bigint NOT NULL CHECK (face_minor >= 0),
  price_minor    bigint NOT NULL CHECK (price_minor >= 0),
  fee_minor      bigint NOT NULL CHECK (fee_minor >= 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cap_bp         integer NOT NULL,
  fee_bp         integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (price_minor <= face_minor)
);
CREATE INDEX IF NOT EXISTS ticket_resales_event ON ticket_resales (event_id, created_at);

-- ---- add-ons: parking and merchandise ------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_addons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  kind             text NOT NULL CHECK (kind IN ('parking','merchandise','other')),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description      text CHECK (description IS NULL OR length(description) <= 300),
  collect_note     text CHECK (collect_note IS NULL OR length(collect_note) <= 160),     -- where to collect it (gate, desk, lot)
  price_minor      bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_bp           integer NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
  tax_inclusive    boolean NOT NULL DEFAULT true,
  stock            integer CHECK (stock IS NULL OR stock >= 0),                           -- null = unlimited
  per_order_limit  integer NOT NULL DEFAULT 4 CHECK (per_order_limit BETWEEN 1 AND 100),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_addons_name ON ticket_addons (event_id, lower(name)) WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS ticket_addon_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial          text NOT NULL UNIQUE,
  short_code      text NOT NULL UNIQUE,
  event_id        uuid NOT NULL REFERENCES events,
  addon_id        uuid NOT NULL REFERENCES ticket_addons,
  order_id        uuid NOT NULL REFERENCES ticket_orders,
  holder_id       uuid NOT NULL REFERENCES users,
  kind            text NOT NULL,
  name            text NOT NULL,
  collect_note    text,
  price_minor     bigint NOT NULL CHECK (price_minor >= 0),
  tax_minor       bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  currency        text NOT NULL,
  status          text NOT NULL CHECK (status IN ('reserved','issued','collected','void','refund_due','refunded')),
  hold_expires_at timestamptz,
  issued_at       timestamptz,
  collected_at    timestamptz,
  collected_by    uuid REFERENCES users,
  ended_at        timestamptz,
  end_reason      text,
  refunded_minor  bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'reserved' OR hold_expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ticket_addon_items_addon ON ticket_addon_items (addon_id, status);
CREATE INDEX IF NOT EXISTS ticket_addon_items_order ON ticket_addon_items (order_id);
CREATE INDEX IF NOT EXISTS ticket_addon_items_holder ON ticket_addon_items (holder_id);

-- ---- waitlist -------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_waitlist (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigserial NOT NULL,                                                  -- the queue order: first in, first offered
  event_id         uuid NOT NULL REFERENCES events,
  product_id       uuid NOT NULL REFERENCES ticket_products,
  user_id          uuid NOT NULL REFERENCES users,
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  status           text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','purchased','expired','passed','left')),
  order_id         uuid REFERENCES ticket_orders,                                       -- the held order that IS the offer
  offered_at       timestamptz,
  offer_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_waitlist_live ON ticket_waitlist (product_id, user_id) WHERE status IN ('waiting','offered');
CREATE INDEX IF NOT EXISTS ticket_waitlist_queue ON ticket_waitlist (product_id, seq) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS ticket_waitlist_user ON ticket_waitlist (user_id, created_at DESC);
