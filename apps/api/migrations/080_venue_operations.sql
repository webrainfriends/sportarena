-- Venue operations: map identifiers, packages & subscriptions on the existing plans, lockers with per-booking PINs,
-- the vendor register (maintenance contacts + suppliers), maintenance work and contracts. Additive only: nothing is dropped or rewritten.

-- Where the venue is on the map: a provider place id (e.g. a Google Place ID) and a pasted share link, next to latitude/longitude.
ALTER TABLE venues
  ADD COLUMN place_id           text,
  ADD COLUMN map_url            text,
  ADD COLUMN locker_auto_assign boolean NOT NULL DEFAULT false,   -- give every new booking a locker + PIN when one is free
  ADD COLUMN amenity_details    jsonb   NOT NULL DEFAULT '{}';    -- per amenity: { "Parking": { "note": "40 bays, rear gate", "fee_cents": 5000 } }

-- Packages (a pass that only works on chosen courts, with perks listed) and subscriptions (a membership that renews).
-- Same two tables as memberships/passes: one place to sell, buy and redeem.
ALTER TABLE venue_plans
  ADD COLUMN resource_ids uuid[]  NOT NULL DEFAULT '{}',   -- pass/package: usable only on these areas; empty = any area
  ADD COLUMN includes     text[]  NOT NULL DEFAULT '{}',   -- perks listed on the offer (locker, towel, coaching …)
  ADD COLUMN auto_renew   boolean NOT NULL DEFAULT false;  -- membership: a renewal is raised before it ends (subscription)
ALTER TABLE user_plans
  ADD COLUMN resource_ids uuid[]  NOT NULL DEFAULT '{}',
  ADD COLUMN includes     text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN auto_renew   boolean NOT NULL DEFAULT false,
  ADD COLUMN renews_id    uuid REFERENCES user_plans;      -- the plan this one renews

-- Lockers. Retired, never deleted.
CREATE TABLE venue_lockers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id   uuid NOT NULL REFERENCES venues,
  label      text NOT NULL,
  zone       text,
  size       text NOT NULL DEFAULT 'medium' CHECK (size IN ('small','medium','large')),
  notes      text,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, label)
);

-- A locker handed to a booking for a time window. The PIN is encrypted and only shown to the booker and the venue team.
CREATE TABLE locker_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locker_id      uuid NOT NULL REFERENCES venue_lockers,
  venue_id       uuid NOT NULL REFERENCES venues,
  reservation_id uuid NOT NULL REFERENCES reservations,
  user_id        uuid NOT NULL REFERENCES users,
  pin_enc        text NOT NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  shared_at      timestamptz,
  pin_version    int NOT NULL DEFAULT 1,
  created_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  released_by    uuid REFERENCES users,
  CHECK (ends_at > starts_at)
);
CREATE INDEX locker_assignments_locker ON locker_assignments (locker_id, starts_at, ends_at) WHERE status = 'active';
CREATE INDEX locker_assignments_reservation ON locker_assignments (reservation_id) WHERE status = 'active';

-- Vendor register: maintenance contractors and suppliers of consumables / kit. Contact details are encrypted.
CREATE TABLE venue_vendors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id         uuid NOT NULL REFERENCES venues,
  kind             text NOT NULL CHECK (kind IN ('maintenance','supplier','cleaning','security','technology','other')),
  name             text NOT NULL,
  categories       text[] NOT NULL DEFAULT '{}',        -- what they do: surface, lighting, plumbing, nets, drinks …
  contact_name_enc text,
  phone_enc        text,
  email_enc        text,
  address          text,
  website          text,
  emergency_24x7   boolean NOT NULL DEFAULT false,
  lead_time_days   int CHECK (lead_time_days BETWEEN 0 AND 365),
  payment_terms    text,
  rating           int CHECK (rating BETWEEN 1 AND 5),
  notes            text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_vendors_venue ON venue_vendors (venue_id, kind) WHERE status <> 'archived';

-- Maintenance work on the venue or one court. A repeat interval raises the next job when one is finished.
CREATE TABLE venue_maintenance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            uuid NOT NULL REFERENCES venues,
  resource_id         uuid REFERENCES resources,
  title               text NOT NULL,
  category            text NOT NULL DEFAULT 'general' CHECK (category IN ('general','surface','lighting','equipment','plumbing','electrical','cleaning','safety','inspection','other')),
  priority            text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status              text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','done','cancelled')),
  due_on              date,
  vendor_id           uuid REFERENCES venue_vendors,
  estimated_cost_cents bigint CHECK (estimated_cost_cents >= 0),
  actual_cost_cents   bigint CHECK (actual_cost_cents >= 0),
  repeat_every_days   int CHECK (repeat_every_days BETWEEN 1 AND 3650),
  block_batch_id      uuid,                              -- the blocked time that closes the court while the work is done
  notes               text,
  completed_at        timestamptz,
  completed_by        uuid REFERENCES users,
  next_id             uuid REFERENCES venue_maintenance, -- the repeat raised on completion
  reminded_at         timestamptz,                       -- the "due soon" reminder went out
  created_by          uuid REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_maintenance_venue ON venue_maintenance (venue_id, status, due_on);
CREATE INDEX venue_maintenance_resource ON venue_maintenance (resource_id) WHERE resource_id IS NOT NULL;

-- Contracts with vendors, landlords and service providers. The signed file lives in the venue documents folder (kind "contract").
ALTER TABLE subject_documents DROP CONSTRAINT IF EXISTS subject_documents_kind_check;
ALTER TABLE subject_documents ADD CONSTRAINT subject_documents_kind_check CHECK (kind IN ('policy','certificate','receipt','quote','other','contract'));

CREATE TABLE venue_contracts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid NOT NULL REFERENCES venues,
  vendor_id     uuid REFERENCES venue_vendors,
  kind          text NOT NULL CHECK (kind IN ('maintenance','supply','service','lease','sponsorship','other')),
  title         text NOT NULL,
  reference     text,
  starts_on     date,
  ends_on       date,
  auto_renews   boolean NOT NULL DEFAULT false,
  notice_days   int NOT NULL DEFAULT 30 CHECK (notice_days BETWEEN 0 AND 365),
  value_cents   bigint CHECK (value_cents >= 0),
  payment_terms text,
  document_id   uuid REFERENCES subject_documents,
  notes         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','ended','terminated')),
  reminded_at   timestamptz,                             -- the "ending soon" reminder went out
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX venue_contracts_venue ON venue_contracts (venue_id, status, ends_on);
