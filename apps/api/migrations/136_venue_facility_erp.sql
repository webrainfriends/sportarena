-- Venue Operations & Facility ERP (#585). Additive only: nothing is dropped, narrowed or rewritten; existing rows keep their meaning.
-- Extends the existing venue stock (inventory_items), maintenance (venue_maintenance), staff (venue_staff), plans (venue_plans) and
-- bookings tables instead of adding parallel ones. Money stays in the canonical finance ledger / POS tables.

-- 1. Recurring series owned by the venue team. Bookings keep their own rows; a series only points at them.
CREATE TABLE IF NOT EXISTS venue_booking_series (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id       uuid NOT NULL REFERENCES venues,
  resource_id    uuid NOT NULL REFERENCES resources,
  reservation_id uuid REFERENCES reservations,
  title          text NOT NULL,
  start_time     text NOT NULL,
  end_time       text NOT NULL,
  pattern        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES users
);
CREATE INDEX IF NOT EXISTS venue_booking_series_venue ON venue_booking_series (venue_id, status);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS series_id uuid REFERENCES venue_booking_series;
CREATE INDEX IF NOT EXISTS bookings_series ON bookings (series_id) WHERE series_id IS NOT NULL;

-- 2. Membership entitlements on the existing plans: {"days":[1,2,3],"from":"06:00","to":"22:00"}; read by the access layer (access-layer.js) when a member checks in. Empty = unrestricted (today's behaviour).
ALTER TABLE venue_plans ADD COLUMN IF NOT EXISTS entitlements jsonb NOT NULL DEFAULT '{}';

-- 3. Asset register on the existing venue stock: an asset is an inventory item with a tag, place, condition and warranty.
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS resource_id    uuid REFERENCES resources,
  ADD COLUMN IF NOT EXISTS asset_tag      text,
  ADD COLUMN IF NOT EXISTS location       text,
  ADD COLUMN IF NOT EXISTS condition      text CHECK (condition IS NULL OR condition IN ('new','good','fair','poor','out_of_service')),
  ADD COLUMN IF NOT EXISTS serial_no      text,
  ADD COLUMN IF NOT EXISTS warranty_until date,
  ADD COLUMN IF NOT EXISTS purchased_on   date;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_asset_tag ON inventory_items (venue_id, asset_tag) WHERE asset_tag IS NOT NULL;

-- 4. Work orders on the existing maintenance table + preventive templates + incident register.
ALTER TABLE venue_maintenance
  ADD COLUMN IF NOT EXISTS asset_id      uuid REFERENCES inventory_items,
  ADD COLUMN IF NOT EXISTS assignee_id   uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS kind          text NOT NULL DEFAULT 'corrective' CHECK (kind IN ('corrective','preventive')),
  ADD COLUMN IF NOT EXISTS checklist     jsonb NOT NULL DEFAULT '[]',   -- [{label, done}]
  ADD COLUMN IF NOT EXISTS parts         jsonb NOT NULL DEFAULT '[]',   -- [{name, quantity, cost_cents}]
  ADD COLUMN IF NOT EXISTS template_id   uuid,
  ADD COLUMN IF NOT EXISTS incident_id   uuid,
  ADD COLUMN IF NOT EXISTS signed_off_by uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS signed_off_at timestamptz;

CREATE TABLE IF NOT EXISTS venue_pm_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id     uuid NOT NULL REFERENCES venues,
  title        text NOT NULL,
  resource_id  uuid REFERENCES resources,
  asset_id     uuid REFERENCES inventory_items,
  category     text NOT NULL DEFAULT 'inspection',
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  every_days   int NOT NULL CHECK (every_days BETWEEN 1 AND 3650),
  checklist    jsonb NOT NULL DEFAULT '[]',
  next_due_on  date NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_pm_templates_due ON venue_pm_templates (next_due_on) WHERE active;

CREATE TABLE IF NOT EXISTS venue_incidents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id       uuid NOT NULL REFERENCES venues,
  resource_id    uuid REFERENCES resources,
  kind           text NOT NULL CHECK (kind IN ('injury','safety','damage','security','other')),
  severity       text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','moderate','serious','critical')),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved')),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  summary        text NOT NULL,
  details_enc    text,                                 -- personal free text (people involved, injuries): encrypted, audit-logged on read
  involved_user_id uuid REFERENCES users,
  reported_by    uuid NOT NULL REFERENCES users,
  assignee_id    uuid REFERENCES users,
  maintenance_id uuid REFERENCES venue_maintenance,
  resolution     text,
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_incidents_venue ON venue_incidents (venue_id, status, occurred_at DESC);

-- 5. Staff duties and rostered shifts. venue_staff.role (manager/staff) still decides permissions; `duty` says what the person does.
ALTER TABLE venue_staff ADD COLUMN IF NOT EXISTS duty text NOT NULL DEFAULT 'general'
  CHECK (duty IN ('general','reception','maintenance','lifeguard','groundskeeper','coach_liaison'));
CREATE TABLE IF NOT EXISTS venue_shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues,
  user_id     uuid NOT NULL REFERENCES users,
  duty        text NOT NULL DEFAULT 'general',
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','clocked_in','completed','cancelled','missed')),
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  notes       text,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS venue_shifts_venue ON venue_shifts (venue_id, starts_at);
CREATE INDEX IF NOT EXISTS venue_shifts_user ON venue_shifts (user_id, starts_at);

-- 6. Readiness checks (pitch/court/pool/room/equipment). Checklists come from the resource kind (code), results are recorded here.
CREATE TABLE IF NOT EXISTS venue_readiness_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues,
  resource_id uuid NOT NULL REFERENCES resources,
  status      text NOT NULL CHECK (status IN ('ready','attention','not_ready')),
  items       jsonb NOT NULL DEFAULT '[]',              -- [{key,label,ok,note}]
  notes       text,
  checked_by  uuid NOT NULL REFERENCES users,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  maintenance_id uuid REFERENCES venue_maintenance
);
CREATE INDEX IF NOT EXISTS venue_readiness_resource ON venue_readiness_checks (resource_id, checked_at DESC);
