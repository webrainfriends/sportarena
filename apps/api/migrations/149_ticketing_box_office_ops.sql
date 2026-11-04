-- Professional ticketing & fan entry (#587), extending spectator ticketing (#480) and its completion (#699). Additive only: nothing is dropped, narrowed or rewritten.
--   * bundles & hospitality packages: tickets + add-ons sold together at one price; the saving is shared across the tickets so refunds stay exact
--   * box office: tills (shifts), tenders (cash / card terminal / UPI / voucher), cash-up with variance, refunds paid back at the desk
--   * scanner sessions: one row per device shift, so offline replay can be reconciled against what the device says it scanned
--   * reconciliations: an immutable sign-off of sold / issued / admitted / no-show for an event (or fixture)
--   * seating-chart hook: sections can carry the id of the external chart they were synced from

-- ---- bundles ---------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_bundles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  kind             text NOT NULL DEFAULT 'bundle' CHECK (kind IN ('bundle','hospitality')),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description      text CHECK (description IS NULL OR length(description) <= 400),
  perks            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(perks) <= 12),            -- hospitality: lounge, catering, host, ...
  price_minor      bigint NOT NULL CHECK (price_minor >= 0),                                 -- the gross price of one bundle
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  sale_starts_at   timestamptz,
  sale_ends_at     timestamptz,
  stock            integer CHECK (stock IS NULL OR stock >= 0),                              -- null = limited only by the tickets inside
  per_order_limit  integer NOT NULL DEFAULT 4 CHECK (per_order_limit BETWEEN 1 AND 100),
  channels         text[] NOT NULL DEFAULT '{online}' CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY['online','box_office','partner']),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (sale_ends_at IS NULL OR sale_starts_at IS NULL OR sale_ends_at > sale_starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_bundles_name ON ticket_bundles (event_id, lower(name)) WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS ticket_bundle_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id  uuid NOT NULL REFERENCES ticket_bundles,
  product_id uuid REFERENCES ticket_products,
  addon_id   uuid REFERENCES ticket_addons,
  qty        integer NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 50),
  CHECK ((product_id IS NULL) <> (addon_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ticket_bundle_items_bundle ON ticket_bundle_items (bundle_id);

-- one row per bundle bought on an order (snapshots, so a later price change never rewrites a sale)
CREATE TABLE IF NOT EXISTS ticket_bundle_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  bundle_id       uuid NOT NULL REFERENCES ticket_bundles,
  order_id        uuid NOT NULL REFERENCES ticket_orders,
  qty             integer NOT NULL CHECK (qty >= 1),
  name            text NOT NULL,
  kind            text NOT NULL,
  currency        text NOT NULL,
  list_minor      bigint NOT NULL CHECK (list_minor >= 0),                                   -- what the parts cost on their own
  charged_minor   bigint NOT NULL CHECK (charged_minor >= 0),                                -- what the bundle cost (never more than the parts)
  discount_minor  bigint NOT NULL CHECK (discount_minor >= 0),                               -- list - charged, carried on the tickets so refunds are exact
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_bundle_orders_bundle ON ticket_bundle_orders (bundle_id);
CREATE INDEX IF NOT EXISTS ticket_bundle_orders_order ON ticket_bundle_orders (order_id);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS bundle_order_id uuid REFERENCES ticket_bundle_orders;
ALTER TABLE ticket_addon_items ADD COLUMN IF NOT EXISTS bundle_order_id uuid REFERENCES ticket_bundle_orders;

-- ---- box office: tills and tenders -----------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_tills (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES events,
  operator_id         uuid NOT NULL REFERENCES users,
  access_point_id     uuid REFERENCES access_points,
  label               text CHECK (label IS NULL OR length(label) <= 60),
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  opening_float_minor bigint NOT NULL DEFAULT 0 CHECK (opening_float_minor >= 0),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  expected_cash_minor bigint,
  counted_cash_minor  bigint CHECK (counted_cash_minor IS NULL OR counted_cash_minor >= 0),
  variance_minor      bigint,                                                                -- counted - expected: negative is short
  close_note          text CHECK (close_note IS NULL OR length(close_note) <= 300),
  closed_by           uuid REFERENCES users,
  CHECK (status = 'open' OR closed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_tills_one_open ON ticket_tills (event_id, operator_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ticket_tills_event ON ticket_tills (event_id, status);

CREATE TABLE IF NOT EXISTS ticket_tenders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  till_id        uuid REFERENCES ticket_tills,
  order_id       uuid NOT NULL REFERENCES ticket_orders,
  ticket_id      uuid REFERENCES tickets,                                                    -- set on a refund of one ticket
  kind           text NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','refund')),
  method         text NOT NULL CHECK (method IN ('cash','card_terminal','upi','voucher','other')),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),                                   -- what counts towards the order (change excluded)
  tendered_minor bigint CHECK (tendered_minor IS NULL OR tendered_minor >= amount_minor),    -- cash handed over
  change_minor   bigint NOT NULL DEFAULT 0 CHECK (change_minor >= 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference      text CHECK (reference IS NULL OR length(reference) <= 60),                  -- terminal slip / UPI / voucher number
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_tenders_till ON ticket_tenders (till_id);
CREATE INDEX IF NOT EXISTS ticket_tenders_order ON ticket_tenders (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_tenders_refund_once ON ticket_tenders (ticket_id) WHERE kind = 'refund';

-- a walk-up buyer can leave an email and agree to be contacted; nothing else about them is kept
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS till_id uuid REFERENCES ticket_tills;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT false;

-- ---- scanner sessions and reconciliation -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_scan_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events,
  operator_id        uuid NOT NULL REFERENCES users,
  device_label       text NOT NULL CHECK (length(device_label) BETWEEN 2 AND 60),
  access_point_id    uuid REFERENCES access_points,
  fixture_id         uuid REFERENCES fixtures,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  manifest_at        timestamptz,                                                           -- when this device last downloaded the offline list
  manifest_count     integer,
  reported_scans     integer CHECK (reported_scans IS NULL OR reported_scans >= 0),         -- what the device says it scanned, offline included
  reported_admitted  integer CHECK (reported_admitted IS NULL OR reported_admitted >= 0),
  close_note         text CHECK (close_note IS NULL OR length(close_note) <= 300)
);
CREATE INDEX IF NOT EXISTS ticket_scan_sessions_event ON ticket_scan_sessions (event_id, started_at);
ALTER TABLE ticket_scans ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES ticket_scan_sessions;
CREATE INDEX IF NOT EXISTS ticket_scans_session ON ticket_scans (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ticket_reconciliations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  fixture_id    uuid REFERENCES fixtures,
  signed_by     uuid NOT NULL REFERENCES users,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  note          text CHECK (note IS NULL OR length(note) <= 300),
  snapshot      jsonb NOT NULL                                                              -- the numbers as they stood; never edited
);
CREATE INDEX IF NOT EXISTS ticket_reconciliations_event ON ticket_reconciliations (event_id, signed_at);

-- ---- seating-chart hook ---------------------------------------------------------------------------------------------------------------------------
ALTER TABLE ticket_sections ADD COLUMN IF NOT EXISTS external_provider text CHECK (external_provider IS NULL OR length(external_provider) <= 40);
ALTER TABLE ticket_sections ADD COLUMN IF NOT EXISTS external_ref text CHECK (external_ref IS NULL OR length(external_ref) <= 120);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_sections_external ON ticket_sections (event_id, external_provider, external_ref) WHERE external_ref IS NOT NULL AND archived_at IS NULL;
