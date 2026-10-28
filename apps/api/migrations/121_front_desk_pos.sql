-- Sports Front Desk & POS (#512). One orchestration layer over the canonical records: bookings/reservations, venue stock (inventory_items),
-- membership/pass plans, academy charges and the numbered `invoices` table. Nothing here is a second ledger of revenue: a sale only points at
-- the invoices that hold the money, and every report reconciles back to them. Additive only; nothing is dropped, narrowed or rewritten.

-- ---------------------------------------------------------------- venue stock gets sale / rental terms (the same rows the Supply screen manages)
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_category_check;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_category_check CHECK (category IN ('equipment','apparel','nutrition','medical','merch','other','food_beverage'));
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS sellable         boolean NOT NULL DEFAULT false,      -- offered at the front desk
  ADD COLUMN IF NOT EXISTS sell_price_cents bigint CHECK (sell_price_cents IS NULL OR sell_price_cents >= 0),
  ADD COLUMN IF NOT EXISTS stock_kind       text NOT NULL DEFAULT 'consumable' CHECK (stock_kind IN ('consumable','rental')),   -- rental kit comes back; consumables do not
  ADD COLUMN IF NOT EXISTS rental_fee_cents bigint CHECK (rental_fee_cents IS NULL OR rental_fee_cents >= 0),
  ADD COLUMN IF NOT EXISTS deposit_cents    bigint NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  ADD COLUMN IF NOT EXISTS damaged_qty      int NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),   -- rental kit returned broken: out of the rentable pool, kept on record
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz;
CREATE INDEX IF NOT EXISTS inventory_items_pos ON inventory_items (venue_id) WHERE sellable AND archived_at IS NULL;

-- ---------------------------------------------------------------- per-venue desk rules
CREATE TABLE IF NOT EXISTS pos_settings (
  venue_id                  uuid PRIMARY KEY REFERENCES venues,
  require_shift             boolean NOT NULL DEFAULT false,          -- cash can only be taken while a drawer shift is open
  cashier_discount_max_bp   int NOT NULL DEFAULT 1000 CHECK (cashier_discount_max_bp BETWEEN 0 AND 10000),   -- above this a cashier needs a manager approval
  refund_limit_cents        bigint CHECK (refund_limit_cents IS NULL OR refund_limit_cents >= 0),             -- null = every cashier refund needs approval
  paid_out_limit_cents      bigint CHECK (paid_out_limit_cents IS NULL OR paid_out_limit_cents >= 0),         -- null = every paid-out needs approval
  variance_tolerance_cents  bigint NOT NULL DEFAULT 0 CHECK (variance_tolerance_cents >= 0),                  -- a count further off than this goes to a manager review
  manual_methods            text[] NOT NULL DEFAULT '{cash}',        -- tenders staff may record by hand (cash, card_terminal, upi_manual, bank_manual, other_manual)
  offline_cash_allowed      boolean NOT NULL DEFAULT true,           -- cash sales captured while the device was offline may be uploaded later
  updated_by                uuid REFERENCES users,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Cashiers are a lower role than the venue team: they can run the front desk and nothing else, so they are NOT rows of venue_staff
-- (every other venue guard - bookings, pricing, tenders, insurance, events - treats a venue_staff row as a full team member).
CREATE TABLE IF NOT EXISTS pos_cashiers (
  venue_id   uuid NOT NULL REFERENCES venues,
  user_id    uuid NOT NULL REFERENCES users,
  added_by   uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (venue_id, user_id)
);
CREATE INDEX IF NOT EXISTS pos_cashiers_user ON pos_cashiers (user_id) WHERE removed_at IS NULL;

-- Wrong approval codes are counted so a cashier cannot guess a manager's 6 digits.
CREATE TABLE IF NOT EXISTS pos_approval_attempts (
  id       bigserial PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES venues,
  user_id  uuid NOT NULL REFERENCES users,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_approval_attempts_recent ON pos_approval_attempts (venue_id, user_id, at DESC);

-- A walk-in guest's reservation is billed to the cashier who rang it up; every invoice and credit note it ever produces carries that flag.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS walk_in boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- cash drawer shifts
CREATE TABLE IF NOT EXISTS pos_shifts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            uuid NOT NULL REFERENCES venues,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by           uuid NOT NULL REFERENCES users,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  opening_float_cents bigint NOT NULL CHECK (opening_float_cents >= 0),
  open_note           text,
  closed_by           uuid REFERENCES users,
  closed_at           timestamptz,
  expected_cash_cents bigint,                       -- frozen at close
  counted_cash_cents  bigint CHECK (counted_cash_cents IS NULL OR counted_cash_cents >= 0),
  variance_cents      bigint,                       -- counted - expected (negative = short)
  close_note          text,
  review_status       text NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','pending','approved','disputed')),
  reviewed_by         uuid REFERENCES users,
  reviewed_at         timestamptz,
  review_note         text,
  CHECK (status = 'open' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL AND counted_cash_cents IS NOT NULL AND expected_cash_cents IS NOT NULL AND variance_cents IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_shifts_one_open ON pos_shifts (venue_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS pos_shifts_venue ON pos_shifts (venue_id, opened_at DESC);

-- A closed count is evidence: its figures can never change and a shift can never be removed. Only the one-time variance review may be written afterwards.
CREATE OR REPLACE FUNCTION pos_shift_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'shifts are never deleted'; END IF;
  IF OLD.status = 'closed' THEN
    IF NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.status IS DISTINCT FROM OLD.status OR NEW.opened_by IS DISTINCT FROM OLD.opened_by OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
       OR NEW.opening_float_cents IS DISTINCT FROM OLD.opening_float_cents OR NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.expected_cash_cents IS DISTINCT FROM OLD.expected_cash_cents OR NEW.counted_cash_cents IS DISTINCT FROM OLD.counted_cash_cents
       OR NEW.variance_cents IS DISTINCT FROM OLD.variance_cents OR NEW.close_note IS DISTINCT FROM OLD.close_note THEN
      RAISE EXCEPTION 'a closed shift is immutable';
    END IF;
    IF OLD.review_status IN ('approved','disputed') THEN RAISE EXCEPTION 'the variance review is final'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_shift_guard ON pos_shifts;
CREATE TRIGGER pos_shift_guard BEFORE UPDATE OR DELETE ON pos_shifts FOR EACH ROW EXECUTE FUNCTION pos_shift_guard();

-- Cash that moves without a sale. (Cash received and cash refunded come from the sale payments themselves.)
CREATE TABLE IF NOT EXISTS pos_cash_moves (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id    uuid NOT NULL REFERENCES pos_shifts,
  venue_id    uuid NOT NULL REFERENCES venues,
  kind        text NOT NULL CHECK (kind IN ('paid_out','cash_drop','float_added')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason      text NOT NULL,
  actor_id    uuid NOT NULL REFERENCES users,
  approved_by uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_cash_moves_shift ON pos_cash_moves (shift_id);

-- A manager's one-time, short-lived OK for something a cashier may not do alone (a big discount, a refund, a paid-out).
CREATE TABLE IF NOT EXISTS pos_approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id         uuid NOT NULL REFERENCES venues,
  kind             text NOT NULL CHECK (kind IN ('discount','refund','paid_out','void')),
  max_amount_cents bigint NOT NULL CHECK (max_amount_cents >= 0),
  reason           text NOT NULL,
  granted_by       uuid NOT NULL REFERENCES users,
  granted_to       uuid REFERENCES users,                                -- null = any cashier at this venue
  code             text NOT NULL,                                        -- the 6 digits a manager reads out / shows; the cashier types them in
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  used_by          uuid REFERENCES users,
  used_for         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_approvals_open_code ON pos_approvals (venue_id, code) WHERE used_at IS NULL;

-- ---------------------------------------------------------------- sales (the cart that was rung up) and what it points at
CREATE TABLE IF NOT EXISTS pos_sales (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id         uuid NOT NULL REFERENCES venues,
  cashier_id       uuid NOT NULL REFERENCES users,
  customer_id      uuid REFERENCES users,                                -- null = walk-in guest
  guest_name_enc   text,
  guest_phone_enc  text,
  shift_id         uuid REFERENCES pos_shifts,
  reservation_id   uuid REFERENCES reservations,                         -- the canonical booking, when the cart had court time
  currency         text NOT NULL,
  status           text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','void')),
  subtotal_cents   bigint NOT NULL DEFAULT 0,
  discount_cents   bigint NOT NULL DEFAULT 0,
  tax_cents        bigint NOT NULL DEFAULT 0,
  total_cents      bigint NOT NULL DEFAULT 0,
  discount_reason  text,
  discount_approved_by uuid REFERENCES users,
  client_ref       text,                                                  -- device-generated key: a retry (or an offline upload) returns the same sale
  captured_offline_at timestamptz,
  note             text,
  paid_at          timestamptz,
  voided_at        timestamptz,
  voided_by        uuid REFERENCES users,
  void_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_client_ref ON pos_sales (venue_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_sales_venue ON pos_sales (venue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pos_sales_shift ON pos_sales (shift_id);

CREATE TABLE IF NOT EXISTS pos_sale_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id          uuid NOT NULL REFERENCES pos_sales,
  kind             text NOT NULL CHECK (kind IN ('item','rental','deposit','plan','booking','invoice','academy_charge')),
  category         text NOT NULL,                                         -- report grouping: court, retail, food_beverage, rental, deposit, membership, pass, academy, fee
  description      text NOT NULL,
  item_id          uuid REFERENCES inventory_items,
  plan_id          uuid REFERENCES venue_plans,
  user_plan_id     uuid REFERENCES user_plans,
  booking_id       uuid REFERENCES bookings,
  invoice_id       uuid REFERENCES invoices,                              -- the invoice that holds this line's money (collected / goods / booking)
  charge_id        uuid REFERENCES academy_charges,
  qty              int NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_cents bigint NOT NULL DEFAULT 0,
  unit_cost_cents  bigint,                                                -- snapshot for margin; null when the venue has not recorded a cost
  discount_cents   bigint NOT NULL DEFAULT 0,
  tax_cents        bigint NOT NULL DEFAULT 0,
  total_cents      bigint NOT NULL DEFAULT 0,                             -- what the customer pays for the line (tax included)
  returned_qty     int NOT NULL DEFAULT 0 CHECK (returned_qty >= 0 AND returned_qty <= qty),
  position         int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pos_sale_lines_sale ON pos_sale_lines (sale_id, position);

CREATE TABLE IF NOT EXISTS pos_sale_invoices (
  sale_id    uuid NOT NULL REFERENCES pos_sales,
  invoice_id uuid NOT NULL REFERENCES invoices,
  role       text NOT NULL CHECK (role IN ('goods','booking','collected')),
  PRIMARY KEY (sale_id, invoice_id)
);

-- Every tender, as it really happened. 'online' rows are only ever confirmed by the payment provider's own confirmation (payment_id);
-- hand-recorded tenders are labelled manual, must be enabled for the venue and (except cash) must carry the terminal / UPI / bank reference.
CREATE TABLE IF NOT EXISTS pos_sale_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       uuid NOT NULL REFERENCES pos_sales,
  shift_id      uuid REFERENCES pos_shifts,
  kind          text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund')),
  method        text NOT NULL CHECK (method IN ('cash','card_terminal','upi_manual','bank_manual','other_manual','online')),
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','failed')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  tendered_cents bigint,                                                  -- cash handed over; change = tendered - amount
  reference     text,
  payment_id    uuid REFERENCES payments,
  credit_note_id uuid REFERENCES invoices,                                -- refunds: the credit note this paid back
  recorded_by   uuid NOT NULL REFERENCES users,
  captured_offline_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),     -- real time, so tenders taken in one transaction keep their order
  confirmed_at  timestamptz,
  CHECK (method <> 'online' OR payment_id IS NOT NULL OR kind = 'refund'),
  CHECK (method IN ('cash','online') OR reference IS NOT NULL),
  CHECK (method <> 'online' OR status <> 'confirmed' OR confirmed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pos_sale_payments_sale ON pos_sale_payments (sale_id);
CREATE INDEX IF NOT EXISTS pos_sale_payments_shift ON pos_sale_payments (shift_id) WHERE method = 'cash';
CREATE UNIQUE INDEX IF NOT EXISTS pos_sale_payments_one_pending ON pos_sale_payments (sale_id) WHERE method = 'online' AND status = 'pending' AND kind = 'payment';
CREATE UNIQUE INDEX IF NOT EXISTS pos_sale_payments_provider ON pos_sale_payments (payment_id) WHERE payment_id IS NOT NULL;

-- Equipment that goes out and comes back. One row per unit so every unit has its own state and deposit.
CREATE TABLE IF NOT EXISTS pos_rentals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id         uuid NOT NULL REFERENCES pos_sales,
  sale_line_id    uuid NOT NULL REFERENCES pos_sale_lines,
  venue_id        uuid NOT NULL REFERENCES venues,
  item_id         uuid NOT NULL REFERENCES inventory_items,
  status          text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','issued','returned','damaged','lost','cancelled')),
  deposit_cents   bigint NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  deposit_status  text NOT NULL DEFAULT 'none' CHECK (deposit_status IN ('none','held','refunded','forfeited','part_forfeited')),
  forfeited_cents bigint NOT NULL DEFAULT 0 CHECK (forfeited_cents >= 0 AND forfeited_cents <= deposit_cents),
  issued_at       timestamptz,
  issued_by       uuid REFERENCES users,
  due_at          timestamptz,
  closed_at       timestamptz,
  closed_by       uuid REFERENCES users,
  condition_note  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_rentals_venue ON pos_rentals (venue_id, status);
CREATE INDEX IF NOT EXISTS pos_rentals_sale ON pos_rentals (sale_id);

-- Append-only stock ledger for everything the desk does to stock: the quantity on the item can always be explained from here.
CREATE TABLE IF NOT EXISTS pos_stock_moves (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id   uuid NOT NULL REFERENCES venues,
  item_id    uuid NOT NULL REFERENCES inventory_items,
  sale_id    uuid REFERENCES pos_sales,
  rental_id  uuid REFERENCES pos_rentals,
  delta      int NOT NULL CHECK (delta <> 0),
  reason     text NOT NULL CHECK (reason IN ('sale','sale_void','return','return_writeoff','rental_out','rental_back','rental_cancel','damaged','lost','adjust')),
  note       text,
  actor_id   uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_stock_moves_item ON pos_stock_moves (item_id, created_at DESC);
CREATE OR REPLACE FUNCTION pos_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_stock_moves_append_only ON pos_stock_moves;
CREATE TRIGGER pos_stock_moves_append_only BEFORE UPDATE OR DELETE ON pos_stock_moves FOR EACH ROW EXECUTE FUNCTION pos_append_only();
DROP TRIGGER IF EXISTS pos_cash_moves_append_only ON pos_cash_moves;
CREATE TRIGGER pos_cash_moves_append_only BEFORE UPDATE OR DELETE ON pos_cash_moves FOR EACH ROW EXECUTE FUNCTION pos_append_only();

-- ---------------------------------------------------------------- the canonical invoice gets a fourth source: a front-desk sale
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pos_sale_id uuid REFERENCES pos_sales;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS walk_in boolean NOT NULL DEFAULT false;   -- bill-to is the cashier standing in for a guest: never shown as the cashier's own invoice, earns no points
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source;
ALTER TABLE invoices ADD CONSTRAINT invoices_source CHECK (
  (venue_id IS NOT NULL AND reservation_id IS NOT NULL AND organisation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NULL AND pos_sale_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND organisation_id IS NOT NULL AND academy_charge_id IS NOT NULL AND svc_order_id IS NULL AND pos_sale_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NOT NULL AND svc_profile_id IS NOT NULL AND pos_sale_id IS NULL)
  OR (venue_id IS NOT NULL AND reservation_id IS NULL AND organisation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NULL AND pos_sale_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS invoices_pos_sale ON invoices (pos_sale_id) WHERE pos_sale_id IS NOT NULL;

-- ---------------------------------------------------------------- online front-desk payments use the canonical payments table
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment','shop_checkout','physio_package','sponsorship_payment','academy_charge','service_invoice','media_rights_fee','pos_sale'));
