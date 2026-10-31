-- Spectator ticketing and gate management (#480): ticket products, orders, issued tickets, gate scans, attendance, transfers, refunds, passes.
-- Additive only: new tables and one widened CHECK; no existing row changes meaning and nothing is removed.
--  * Spectator tickets are NOT event entries. event_entries stays the participant registration; nothing here reads or writes it except to count
--    participants towards a safety capacity when the organiser asks for that.
--  * Money goes through the canonical `payments` table (purpose 'ticket_order'); the order, the payment and the ticket keep separate states.
--    A ticket is only 'refunded' after payments.refunded_cents has moved; until then it is 'refund_due'.
--  * The QR token is derived (serial + version, signed with a server key), so it carries no personal data; a reissue bumps `token_version`.
--  * Lifecycle history, scans and attendance are append-only (triggers refuse UPDATE/DELETE on history and scans).
--  * Gates reuse access_points (kind gate/turnstile at an event) rather than a second gate table.
-- Rollback = deploy the previous code; it ignores these tables.

CREATE TABLE ticket_settings (
  event_id             uuid PRIMARY KEY REFERENCES events,
  spectator_capacity   integer CHECK (spectator_capacity IS NULL OR spectator_capacity >= 0),   -- default per fixture (or for the event when it has no fixtures)
  safety_capacity      integer CHECK (safety_capacity IS NULL OR safety_capacity >= 0),         -- spectators + the groups below, when counted
  count_participants   boolean NOT NULL DEFAULT false,
  count_accreditations boolean NOT NULL DEFAULT false,
  sales_open           boolean NOT NULL DEFAULT true,
  hold_minutes         integer NOT NULL DEFAULT 15 CHECK (hold_minutes BETWEEN 5 AND 120),
  transfer_allowed     boolean NOT NULL DEFAULT true,
  transfer_cutoff_hours integer NOT NULL DEFAULT 2 CHECK (transfer_cutoff_hours BETWEEN 0 AND 720),
  refund_policy        text NOT NULL DEFAULT 'until_cutoff' CHECK (refund_policy IN ('anytime','until_cutoff','never')),
  refund_cutoff_hours  integer NOT NULL DEFAULT 24 CHECK (refund_cutoff_hours BETWEEN 0 AND 720),
  updated_by           uuid REFERENCES users,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- a different capacity for one fixture (its own pitch or court)
CREATE TABLE ticket_fixture_limits (
  fixture_id         uuid PRIMARY KEY REFERENCES fixtures,
  event_id           uuid NOT NULL REFERENCES events,
  spectator_capacity integer CHECK (spectator_capacity IS NULL OR spectator_capacity >= 0),
  safety_capacity    integer CHECK (safety_capacity IS NULL OR safety_capacity >= 0)
);

CREATE TABLE ticket_sections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  rows_count     integer NOT NULL CHECK (rows_count BETWEEN 1 AND 100),
  seats_per_row  integer NOT NULL CHECK (seats_per_row BETWEEN 1 AND 200),
  archived_at    timestamptz,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ticket_sections_name ON ticket_sections (event_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE ticket_products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  kind             text NOT NULL DEFAULT 'single' CHECK (kind IN ('single','pass')),     -- a pass admits to several fixtures with one entitlement
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description      text CHECK (description IS NULL OR length(description) <= 400),
  class            text NOT NULL DEFAULT 'adult' CHECK (class IN ('adult','youth','concession','vip','complimentary','other')),
  class_label      text CHECK (class_label IS NULL OR length(class_label) <= 40),
  seating          text NOT NULL DEFAULT 'general' CHECK (seating IN ('general','reserved')),
  section_id       uuid REFERENCES ticket_sections,
  price_minor      bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),                    -- the gross price a buyer pays per ticket
  currency         text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  tax_bp           integer NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
  tax_inclusive    boolean NOT NULL DEFAULT true,
  sale_starts_at   timestamptz,
  sale_ends_at     timestamptz,
  allocation       integer CHECK (allocation IS NULL OR allocation >= 0),
  per_order_limit  integer NOT NULL DEFAULT 10 CHECK (per_order_limit BETWEEN 1 AND 100),
  per_account_limit integer NOT NULL DEFAULT 10 CHECK (per_account_limit BETWEEN 1 AND 1000),
  channels         text[] NOT NULL DEFAULT '{online}' CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY['online','box_office','partner','complimentary']),
  transferable     boolean NOT NULL DEFAULT true,
  reentry          text NOT NULL DEFAULT 'single' CHECK (reentry IN ('single','reentry')),
  access_point_ids uuid[] NOT NULL DEFAULT '{}',                                          -- empty = any gate of the event
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (seating = 'general' OR section_id IS NOT NULL),
  CHECK (sale_ends_at IS NULL OR sale_starts_at IS NULL OR sale_ends_at > sale_starts_at)
);
CREATE UNIQUE INDEX ticket_products_name ON ticket_products (event_id, lower(name)) WHERE status <> 'archived';
CREATE INDEX ticket_products_event ON ticket_products (event_id);

-- which fixtures a product admits to; no rows = every fixture of the event. A pass links many, a single-fixture product one.
CREATE TABLE ticket_product_fixtures (
  product_id uuid NOT NULL REFERENCES ticket_products,
  fixture_id uuid NOT NULL REFERENCES fixtures,
  PRIMARY KEY (product_id, fixture_id)
);

CREATE TABLE ticket_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  product_id  uuid NOT NULL REFERENCES ticket_products,
  kind        text NOT NULL CHECK (kind IN ('sponsor','team','vip','partner','media','other')),
  label       text NOT NULL CHECK (length(label) BETWEEN 2 AND 80),
  team_id     uuid REFERENCES teams,
  quota       integer NOT NULL CHECK (quota BETWEEN 1 AND 100000),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ticket_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  buyer_id        uuid NOT NULL REFERENCES users,
  channel         text NOT NULL CHECK (channel IN ('online','box_office','partner','complimentary')),
  status          text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','confirmed','cancelled','expired')),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor  bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor       bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor     bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  idempotency_key text,
  expires_at      timestamptz,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ticket_orders_idem ON ticket_orders (buyer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ticket_orders_event ON ticket_orders (event_id, status);

CREATE TABLE ticket_order_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES ticket_orders,
  product_id      uuid NOT NULL REFERENCES ticket_products,
  qty             integer NOT NULL CHECK (qty >= 1),
  name            text NOT NULL,                                                           -- snapshots: the price, tax and name at the time of sale
  class           text NOT NULL,
  unit_minor      bigint NOT NULL CHECK (unit_minor >= 0),
  unit_tax_minor  bigint NOT NULL CHECK (unit_tax_minor >= 0),
  currency        text NOT NULL
);
CREATE INDEX ticket_order_lines_order ON ticket_order_lines (order_id);

CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial          text NOT NULL UNIQUE,                                                    -- stable ticket id, shown on the ticket
  short_code      text NOT NULL UNIQUE,                                                    -- what a gate steward can type
  token_version   integer NOT NULL DEFAULT 1,
  entitlement_id  uuid NOT NULL,                                                           -- one entitlement, however many times it is transferred or reissued
  supersedes_id   uuid REFERENCES tickets,
  event_id        uuid NOT NULL REFERENCES events,
  product_id      uuid NOT NULL REFERENCES ticket_products,
  order_id        uuid NOT NULL REFERENCES ticket_orders,
  line_id         uuid REFERENCES ticket_order_lines,
  allocation_id   uuid REFERENCES ticket_allocations,
  holder_id       uuid REFERENCES users,
  guest_name_enc  text,                                                                    -- a guest holder: name and email are field-encrypted, never shown at the gate
  guest_email_enc text,
  claim_hash      text,                                                                    -- blind index of the claim code a guest uses to take the ticket into an account
  class           text NOT NULL,
  class_label     text,
  section_id      uuid REFERENCES ticket_sections,
  seat_label      text,
  price_minor     bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  tax_minor       bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  currency        text NOT NULL,
  status          text NOT NULL CHECK (status IN ('reserved','issued','void','refund_due','refunded','transferred')),
  hold_expires_at timestamptz,
  issued_at       timestamptz,
  ended_at        timestamptz,
  end_reason      text,
  refunded_minor  bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'reserved' OR hold_expires_at IS NOT NULL)
);
-- one valid ticket per entitlement: a transfer or reissue ends the old row in the same transaction
CREATE UNIQUE INDEX tickets_one_live_per_entitlement ON tickets (entitlement_id) WHERE status IN ('reserved','issued');
CREATE INDEX tickets_event ON tickets (event_id, status);
CREATE INDEX tickets_holder ON tickets (holder_id) WHERE holder_id IS NOT NULL;
CREATE INDEX tickets_order ON tickets (order_id);
CREATE INDEX tickets_product ON tickets (product_id, status);
CREATE INDEX tickets_claim ON tickets (claim_hash) WHERE claim_hash IS NOT NULL;

CREATE TABLE ticket_history (
  id          bigserial PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES tickets,
  actor_id    uuid REFERENCES users,
  kind        text NOT NULL,
  from_status text,
  to_status   text,
  detail      jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_history_ticket ON ticket_history (ticket_id, id);

-- who passed a gate, once per ticket per fixture (or per day for a ticket that is not tied to a fixture)
CREATE TABLE ticket_attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES tickets,                                        -- the ticket that was scanned
  entitlement_id  uuid NOT NULL,                                                           -- admission is per entitlement, so a transfer, reissue or replacement can never admit twice
  event_id        uuid NOT NULL REFERENCES events,
  fixture_id      uuid REFERENCES fixtures,
  scope_key       text NOT NULL,                                                           -- the fixture id, or the event-local day
  access_point_id uuid REFERENCES access_points,
  operator_id     uuid NOT NULL REFERENCES users,
  first_in_at     timestamptz NOT NULL DEFAULT now(),
  inside          boolean NOT NULL DEFAULT true,
  entries         integer NOT NULL DEFAULT 1,
  last_scan_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entitlement_id, scope_key)
);
CREATE INDEX ticket_attendance_event ON ticket_attendance (event_id, fixture_id);

CREATE TABLE ticket_scans (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES events,
  ticket_id       uuid REFERENCES tickets,
  fixture_id      uuid REFERENCES fixtures,
  access_point_id uuid REFERENCES access_points,
  operator_id     uuid NOT NULL REFERENCES users,
  direction       text NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  method          text NOT NULL DEFAULT 'camera' CHECK (method IN ('camera','manual','search','offline')),
  result          text NOT NULL,
  client_ref      text,                                                                    -- idempotency for a scan retried or replayed after being offline
  scanned_at      timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ticket_scans_client_ref ON ticket_scans (event_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX ticket_scans_event ON ticket_scans (event_id, scanned_at);

-- a fixture that was retimed or called off after tickets were sold: lets a holder refund past the normal cutoff
CREATE TABLE ticket_schedule_changes (
  id         bigserial PRIMARY KEY,
  event_id   uuid NOT NULL REFERENCES events,
  fixture_id uuid REFERENCES fixtures,
  kind       text NOT NULL CHECK (kind IN ('rescheduled','cancelled','event_cancelled')),
  old_at     timestamptz,
  new_at     timestamptz,
  actor_id   uuid REFERENCES users,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_schedule_changes_event ON ticket_schedule_changes (event_id, at);

-- history and scans can be added to, never changed or removed
CREATE FUNCTION ticket_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END $$;
CREATE TRIGGER ticket_history_append_only BEFORE UPDATE OR DELETE ON ticket_history FOR EACH ROW EXECUTE FUNCTION ticket_append_only();
CREATE TRIGGER ticket_scans_append_only BEFORE UPDATE OR DELETE ON ticket_scans FOR EACH ROW EXECUTE FUNCTION ticket_append_only();

-- payments can now be for a ticket order (the existing constraint is widened in place, as earlier purposes did)
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('ticket_order' IN d) = 0 THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''ticket_order''::text])');
  END IF;
END $$;
