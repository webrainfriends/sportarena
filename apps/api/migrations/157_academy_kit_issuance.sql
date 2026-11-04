-- Academy uniforms, kits & equipment issuance (#798). One layer over the canonical records, nothing parallel:
--   * stock stays in `inventory_items` (a SIZE is an ordinary stock row grouped by `style_key`), every movement stays in the append-only `pos_stock_moves`;
--   * what a family owes stays in `academy_charges` -> `invoices` -> payments (new charge kinds `kit`, `kit_deposit`), settled at the desk or online as before;
--   * replenishment stays in `supply_orders` (+ the academy's own `academy_suppliers`);
--   * entitlements, athlete sizes, the issue records and their event trail are the only new data.
-- Additive and idempotent: no DROP/TRUNCATE/rewrite of data, no ON DELETE CASCADE, existing rows keep their meaning (all new columns are nullable or defaulted).
-- ROLLBACK: deploy the previous build. The new tables/columns are inert for it; the only widened constraints (stock reason, charge kind) are supersets.

-- ---------------------------------------------------------------- stock: size, style, barcode, serial tracking on the existing rows
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS style_key  text;                       -- groups the sizes of one product, e.g. 'home-shirt-2026'
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS size_label text;                       -- 'M', 'YL', '42', 'One size' ...
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS kit_slot   text;                       -- shirt, shorts, boots, racket ... (src/kit-slots.js)
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS barcode    text;                       -- what a mobile scanner reads off the label
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS serialised boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_barcode ON inventory_items (venue_id, barcode) WHERE barcode IS NOT NULL AND venue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_items_style ON inventory_items (venue_id, style_key) WHERE style_key IS NOT NULL;

-- One row per physical unit, only for serialised kit (rackets, goalkeeper gloves, GPS vests ...). `inventory_items.quantity` stays the count of in_stock units.
CREATE TABLE IF NOT EXISTS inventory_units (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES inventory_items,
  venue_id   uuid NOT NULL REFERENCES venues,
  serial_no  text NOT NULL CHECK (length(serial_no) BETWEEN 1 AND 80),
  status     text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','issued','damaged','lost','written_off')),
  condition  text,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, serial_no)
);
CREATE INDEX IF NOT EXISTS inventory_units_item ON inventory_units (item_id, status);

-- ---------------------------------------------------------------- entitlements: what a programme / cohort / squad is owed
CREATE TABLE IF NOT EXISTS academy_kit_entitlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations,
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  scope_type       text NOT NULL CHECK (scope_type IN ('programme','cohort','team')),   -- team = squad
  scope_id         uuid NOT NULL,
  style_key        text NOT NULL,                                       -- the product; the athlete's size picks the stock row
  kit_slot         text,
  qty              int NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 20),
  mode             text NOT NULL DEFAULT 'included' CHECK (mode IN ('included','charged','deposit')),
  price_minor      bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  deposit_minor    bigint CHECK (deposit_minor IS NULL OR deposit_minor >= 0),
  require_payment  boolean NOT NULL DEFAULT false,                      -- the kit leaves the desk only once its charge is paid
  due_rule         text NOT NULL DEFAULT 'on_enrolment' CHECK (due_rule IN ('on_enrolment','days_after')),
  due_days         int NOT NULL DEFAULT 0 CHECK (due_days BETWEEN 0 AND 365),
  replace_after_months int CHECK (replace_after_months IS NULL OR replace_after_months BETWEEN 1 AND 120),
  return_days      int CHECK (return_days IS NULL OR return_days BETWEEN 1 AND 1095),   -- loan kit comes back after this many days (null = the athlete keeps it)
  size_required    boolean NOT NULL DEFAULT true,
  fulfil_venue_id  uuid REFERENCES venues,                              -- where it is collected; null = any venue of the academy
  collection_note  text CHECK (collection_note IS NULL OR length(collection_note) <= 500),
  archived_at      timestamptz,
  created_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  row_version      int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_kit_ent_unique ON academy_kit_entitlements (organisation_id, scope_type, scope_id, style_key) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS academy_kit_ent_org ON academy_kit_entitlements (organisation_id, scope_type, scope_id);

-- ---------------------------------------------------------------- sizes: append-only history, one live row per athlete and slot
CREATE TABLE IF NOT EXISTS academy_kit_sizes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  slot            text NOT NULL,
  size_label      text NOT NULL CHECK (length(size_label) BETWEEN 1 AND 20),
  fit_note_enc    text,                                                  -- fitting notes about a person's body: encrypted, reads audited
  set_by          uuid REFERENCES users,
  set_at          timestamptz NOT NULL DEFAULT now(),
  superseded_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_kit_sizes_live ON academy_kit_sizes (organisation_id, athlete_id, slot) WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------- the issue record: one row per athlete, entitlement and handed-over item
CREATE TABLE IF NOT EXISTS academy_kit_issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  enrolment_id    uuid NOT NULL REFERENCES org_enrolments,
  athlete_id      uuid NOT NULL REFERENCES users,
  entitlement_id  uuid REFERENCES academy_kit_entitlements,             -- null = a one-off issue outside any entitlement
  item_id         uuid NOT NULL REFERENCES inventory_items,             -- the size row the stock came from
  unit_id         uuid REFERENCES inventory_units,
  venue_id        uuid NOT NULL REFERENCES venues,
  qty             int NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 20),
  status          text NOT NULL DEFAULT 'issued' CHECK (status IN ('reserved','issued','returned','exchanged','writeoff_pending','written_off','cancelled')),
  charge_id       uuid REFERENCES academy_charges,                       -- the canonical fee, when the kit is charged
  deposit_charge_id uuid REFERENCES academy_charges,                     -- the canonical refundable deposit, when there is one
  client_ref      text CHECK (client_ref IS NULL OR length(client_ref) BETWEEN 8 AND 80),
  exchange_of     uuid REFERENCES academy_kit_issues,
  issued_at       timestamptz,
  issued_by       uuid REFERENCES users,
  due_back_at     timestamptz,
  returned_at     timestamptz,
  returned_by     uuid REFERENCES users,
  return_condition text CHECK (return_condition IS NULL OR return_condition IN ('good','worn','damaged')),
  writeoff_kind   text CHECK (writeoff_kind IS NULL OR writeoff_kind IN ('damaged','lost')),
  writeoff_note   text,
  writeoff_requested_by uuid REFERENCES users,
  writeoff_decided_by   uuid REFERENCES users,
  writeoff_decision     text CHECK (writeoff_decision IS NULL OR writeoff_decision IN ('approved','rejected')),
  writeoff_decided_at   timestamptz,
  forfeit_minor   bigint NOT NULL DEFAULT 0 CHECK (forfeit_minor >= 0),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_kit_issues_ref ON academy_kit_issues (organisation_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS academy_kit_issues_athlete ON academy_kit_issues (organisation_id, athlete_id, status);
CREATE INDEX IF NOT EXISTS academy_kit_issues_ent ON academy_kit_issues (entitlement_id, enrolment_id);
CREATE INDEX IF NOT EXISTS academy_kit_issues_open ON academy_kit_issues (organisation_id, status, due_back_at);
CREATE UNIQUE INDEX IF NOT EXISTS academy_kit_issues_unit_live ON academy_kit_issues (unit_id) WHERE unit_id IS NOT NULL AND status IN ('reserved','issued','writeoff_pending');

-- Who did what, when: append-only, the audit trail of every issue.
CREATE TABLE IF NOT EXISTS academy_kit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  issue_id        uuid NOT NULL REFERENCES academy_kit_issues,
  kind            text NOT NULL,
  actor_id        uuid REFERENCES users,
  data            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_kit_events_issue ON academy_kit_events (issue_id, created_at);
DROP TRIGGER IF EXISTS academy_kit_events_append_only ON academy_kit_events;
CREATE TRIGGER academy_kit_events_append_only BEFORE UPDATE OR DELETE ON academy_kit_events FOR EACH ROW EXECUTE FUNCTION pos_append_only();

-- ---------------------------------------------------------------- the canonical stock ledger learns the kit movements
ALTER TABLE pos_stock_moves ADD COLUMN IF NOT EXISTS kit_issue_id uuid REFERENCES academy_kit_issues;
ALTER TABLE pos_stock_moves DROP CONSTRAINT IF EXISTS pos_stock_moves_reason_check;
ALTER TABLE pos_stock_moves ADD CONSTRAINT pos_stock_moves_reason_check CHECK (reason IN
  ('sale','sale_void','return','return_writeoff','rental_out','rental_back','rental_cancel','damaged','lost','adjust','kit_issue','kit_return','kit_exchange_out','kit_exchange_in','kit_cancel'));
CREATE INDEX IF NOT EXISTS pos_stock_moves_kit ON pos_stock_moves (kit_issue_id) WHERE kit_issue_id IS NOT NULL;

-- ---------------------------------------------------------------- the canonical fee table learns two kinds
ALTER TABLE academy_charges DROP CONSTRAINT IF EXISTS academy_charges_kind_check;
ALTER TABLE academy_charges ADD CONSTRAINT academy_charges_kind_check CHECK (kind IN ('registration','deposit','tuition','instalment','trial','pack','dues','late_fee','kit','kit_deposit'));

-- ---------------------------------------------------------------- replenishment: the existing supply order, linked to the academy's supplier and request
ALTER TABLE supply_orders ADD COLUMN IF NOT EXISTS academy_supplier_id uuid REFERENCES academy_suppliers;
ALTER TABLE supply_orders ADD COLUMN IF NOT EXISTS supplier_request_id uuid REFERENCES academy_supplier_requests;
ALTER TABLE supply_orders ADD COLUMN IF NOT EXISTS unit_cost_cents bigint CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0);
ALTER TABLE supply_orders ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE supply_orders ADD COLUMN IF NOT EXISTS ordered_by_org uuid REFERENCES organisations;
