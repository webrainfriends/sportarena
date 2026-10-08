-- Timetable: price categories (Peak, Off-peak, Weekend ...) and weekly windows that say when each court is open and under which category.
-- A venue with no windows keeps working exactly as before (venue_hours + price_rules + base rates).
CREATE TABLE price_categories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          uuid NOT NULL REFERENCES venues,
  name              text NOT NULL,
  color             text NOT NULL DEFAULT '#7c5cff',
  hourly_rate_cents int NOT NULL CHECK (hourly_rate_cents >= 0),          -- default for every court; courts can override below
  active            boolean NOT NULL DEFAULT true,                       -- false = retired (windows keep it; nothing is deleted)
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX price_categories_name ON price_categories (venue_id, lower(name)) WHERE active;

CREATE TABLE category_rates (
  category_id       uuid NOT NULL REFERENCES price_categories,
  resource_id       uuid NOT NULL REFERENCES resources,
  hourly_rate_cents int CHECK (hourly_rate_cents >= 0),             -- null = no override: the category default applies
  PRIMARY KEY (category_id, resource_id)
);

CREATE TABLE schedule_windows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues,
  resource_id uuid REFERENCES resources,                    -- null = every court of the venue (including ones added later)
  category_id uuid REFERENCES price_categories,             -- null = open at the court's base rate
  weekdays    smallint[] NOT NULL,                          -- 0 = Sunday
  start_min   int NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min     int NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  valid_from  date,
  valid_to    date,
  batch_id    uuid,                                         -- windows created by one bulk action
  removed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_min > start_min)
);
CREATE INDEX schedule_windows_venue ON schedule_windows (venue_id) WHERE removed_at IS NULL;

-- Off until a venue builds a timetable; then courts are open only when a window says so.
ALTER TABLE venues ADD COLUMN timetable_enabled boolean NOT NULL DEFAULT false;
