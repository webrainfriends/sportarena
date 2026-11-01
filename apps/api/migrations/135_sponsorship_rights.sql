-- Sponsorship rights, inventory & activation lifecycle (#589). Additive only: columns have defaults that keep every existing unit, booking and allocation exactly as it was.

-- Rights restrictions on a sellable unit (same vocabulary as media-rights packages) and an optional asking price.
ALTER TABLE sponsor_inventory_units
  ADD COLUMN IF NOT EXISTS territory_mode text NOT NULL DEFAULT 'worldwide' CHECK (territory_mode IN ('worldwide', 'include', 'exclude')),
  ADD COLUMN IF NOT EXISTS countries text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS platforms text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS exclusivity_scope text CHECK (exclusivity_scope IS NULL OR char_length(exclusivity_scope) BETWEEN 2 AND 80),
  ADD COLUMN IF NOT EXISTS asking_price_minor bigint CHECK (asking_price_minor IS NULL OR asking_price_minor >= 0),
  ADD COLUMN IF NOT EXISTS asking_currency text CHECK (asking_currency IS NULL OR asking_currency ~ '^[A-Z]{3}$');
ALTER TABLE sponsor_inventory_units DROP CONSTRAINT IF EXISTS sponsor_inventory_units_territory_chk;
ALTER TABLE sponsor_inventory_units ADD CONSTRAINT sponsor_inventory_units_territory_chk CHECK (territory_mode = 'worldwide' OR cardinality(countries) > 0) NOT VALID;
ALTER TABLE sponsor_inventory_units DROP CONSTRAINT IF EXISTS sponsor_inventory_units_price_chk;
ALTER TABLE sponsor_inventory_units ADD CONSTRAINT sponsor_inventory_units_price_chk CHECK ((asking_price_minor IS NULL) = (asking_currency IS NULL)) NOT VALID;

-- What a booking actually granted inside the unit's rights (a subset of the unit's territory and platforms; empty = the unit's whole scope).
ALTER TABLE sponsor_inventory_bookings
  ADD COLUMN IF NOT EXISTS countries text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS platforms text[] NOT NULL DEFAULT '{}';

-- A sellable bundle of units of one event, team or athlete. Distinct from broadcast mr_packages: this is what a sponsor buys, that is what a broadcaster licenses.
CREATE TABLE IF NOT EXISTS sponsor_rights_packages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type  text NOT NULL CHECK (target_type IN ('event', 'team', 'athlete')),
  target_id    uuid NOT NULL,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  description  text CHECK (description IS NULL OR char_length(description) <= 1000),
  price_minor  bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency     text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  valid_from   date,
  valid_to     date,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'archived')),
  row_version  integer NOT NULL DEFAULT 1,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((price_minor IS NULL) = (currency IS NULL)),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS sponsor_rights_packages_target ON sponsor_rights_packages (target_type, target_id) WHERE status <> 'archived';
CREATE TABLE IF NOT EXISTS sponsor_rights_package_units (
  package_id uuid NOT NULL REFERENCES sponsor_rights_packages,
  unit_id    uuid NOT NULL REFERENCES sponsor_inventory_units,
  removed_at timestamptz,                                  -- taken out of the bundle; the row stays as history
  PRIMARY KEY (package_id, unit_id)
);

-- Hospitality / ticket allocations tied to the agreement (and booking) they fulfil.
ALTER TABLE ticket_allocations
  ADD COLUMN IF NOT EXISTS sponsorship_id uuid REFERENCES sponsorships,
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES sponsor_inventory_bookings;
CREATE INDEX IF NOT EXISTS ticket_allocations_deal ON ticket_allocations (sponsorship_id) WHERE sponsorship_id IS NOT NULL;
