-- Venue management & reservations: rich venue profile (geo, hours, contacts, staff), multi-area resources,
-- pricing rules, discounts, bulk blocks, multi-slot / multi-venue reservations, cancellation policy, notifications.

-- ---------------------------------------------------------------- sport catalogue (reference data venues can offer)
-- More sports so a venue can host racket, cue, lane, target and studio sports; anything else: create_sport.
INSERT INTO sports (slug, name, emoji, scoring) VALUES
 ('table-tennis','Table tennis','🏓','sets'),('squash','Squash','🎾','sets'),('padel','Padel','🎾','sets'),('pickleball','Pickleball','🏓','sets'),
 ('snooker','Snooker','🎱','points'),('pool','Pool / billiards','🎱','points'),('bowling','Bowling','🎳','points'),('golf','Golf','⛳','points'),
 ('futsal','Futsal','⚽','goals'),('handball','Handball','🤾','goals'),('rugby','Rugby','🏉','points'),('baseball','Baseball','⚾','points'),
 ('netball','Netball','🏐','goals'),('archery','Archery','🏹','points'),('boxing','Boxing','🥊','points'),('martial-arts','Martial arts','🥋','points'),
 ('gymnastics','Gymnastics','🤸','points'),('yoga','Yoga','🧘','points'),('climbing','Climbing','🧗','time'),('cycling','Cycling','🚴','time'),
 ('darts','Darts','🎯','points'),('ice-hockey','Ice hockey','🏒','goals'),('skating','Skating','⛸️','time'),('fitness','Fitness / gym','🏋️','points')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------- venue profile
ALTER TABLE venues
  ADD COLUMN description  text,
  ADD COLUMN country      text,
  ADD COLUMN postal_code  text,
  ADD COLUMN latitude     double precision CHECK (latitude  BETWEEN -90  AND 90),
  ADD COLUMN longitude    double precision CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN timezone     text NOT NULL DEFAULT 'UTC',          -- IANA zone; slots, hours and prices are evaluated in it
  ADD COLUMN currency     text NOT NULL DEFAULT 'INR',
  ADD COLUMN phone        text,                                  -- the venue's public business line
  ADD COLUMN email        text,
  ADD COLUMN website      text,
  ADD COLUMN amenities    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN min_notice_minutes int NOT NULL DEFAULT 0 CHECK (min_notice_minutes >= 0),
  ADD COLUMN max_advance_days   int NOT NULL DEFAULT 90 CHECK (max_advance_days BETWEEN 1 AND 730),
  ADD COLUMN cancel_free_hours  int NOT NULL DEFAULT 24 CHECK (cancel_free_hours >= 0),     -- full refund up to this long before start
  ADD COLUMN late_cancel_refund_percent int NOT NULL DEFAULT 0 CHECK (late_cancel_refund_percent BETWEEN 0 AND 100),
  ADD COLUMN notify_owner boolean NOT NULL DEFAULT true,         -- tell the venue team about new / changed / cancelled bookings
  ADD COLUMN active       boolean NOT NULL DEFAULT true;
CREATE INDEX venues_geo ON venues (latitude, longitude) WHERE latitude IS NOT NULL;

-- Opening hours: minutes since local midnight; several intervals per weekday allowed (split shifts).
-- A venue with no rows is treated as open around the clock.
CREATE TABLE venue_hours (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id   uuid NOT NULL REFERENCES venues ON DELETE CASCADE,
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  opens_min  int NOT NULL CHECK (opens_min BETWEEN 0 AND 1439),
  closes_min int NOT NULL CHECK (closes_min BETWEEN 1 AND 1440),
  CHECK (closes_min > opens_min)
);
CREATE INDEX venue_hours_venue ON venue_hours (venue_id, weekday);

-- Named people at the venue. Names / phones / emails are personal data: encrypted, audit-logged when read.
CREATE TABLE venue_contacts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id  uuid NOT NULL REFERENCES venues ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'general',            -- manager | reception | emergency | billing | general
  name_enc  text,
  phone_enc text,
  email_enc text,
  is_public boolean NOT NULL DEFAULT false,             -- shown to every signed-in user, not just staff
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_contacts_venue ON venue_contacts (venue_id);

-- People besides the owner who run the venue (can manage bookings, pricing, blocks, reports).
CREATE TABLE venue_staff (
  venue_id uuid NOT NULL REFERENCES venues ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role     text NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, user_id)
);

-- ---------------------------------------------------------------- gaming areas (courts, tables, lanes ...)
ALTER TABLE resources DROP CONSTRAINT resources_kind_check;
ALTER TABLE resources ADD CONSTRAINT resources_kind_check
  CHECK (kind IN ('court','ground','pool','track','room','equipment','table','lane','rink','range','studio','other'));
ALTER TABLE resources
  ADD COLUMN description  text,
  ADD COLUMN surface      text,
  ADD COLUMN indoor       boolean,
  ADD COLUMN max_players  int CHECK (max_players >= 1),      -- people per unit; `capacity` stays "concurrent bookings / units"
  ADD COLUMN slot_minutes int NOT NULL DEFAULT 60 CHECK (slot_minutes IN (15,20,30,45,60,90,120)),
  ADD COLUMN min_slots    int NOT NULL DEFAULT 1 CHECK (min_slots >= 1),
  ADD COLUMN max_slots    int NOT NULL DEFAULT 8 CHECK (max_slots >= 1),
  ADD COLUMN created_at   timestamptz NOT NULL DEFAULT now(),
  ADD CHECK (max_slots >= min_slots);

-- ---------------------------------------------------------------- pricing
-- Time-of-day / weekday / season rates. Most specific wins: area-specific over venue-wide, then priority, then newest.
-- No matching rule -> the area's own hourly_rate_cents.
CREATE TABLE price_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues ON DELETE CASCADE,
  resource_id uuid REFERENCES resources ON DELETE CASCADE,       -- null = every area of the venue
  name        text NOT NULL,
  weekdays    smallint[],                                         -- null = every day
  start_min   int NOT NULL DEFAULT 0    CHECK (start_min BETWEEN 0 AND 1439),
  end_min     int NOT NULL DEFAULT 1440 CHECK (end_min BETWEEN 1 AND 1440),
  hourly_rate_cents int NOT NULL CHECK (hourly_rate_cents >= 0),
  valid_from  date,
  valid_to    date,
  priority    int NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_min > start_min)
);
CREATE INDEX price_rules_venue ON price_rules (venue_id) WHERE active;

-- Discounts: automatic (multi-slot, off-peak, weekday ...) or code-based. The best single discount applies per venue.
CREATE TABLE discounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues ON DELETE CASCADE,
  resource_id uuid REFERENCES resources ON DELETE CASCADE,
  name        text NOT NULL,
  code        text,                                               -- null = automatic
  kind        text NOT NULL CHECK (kind IN ('percent','fixed')),
  value       int NOT NULL CHECK (value > 0),                     -- percent (1-100) or minor units
  min_slots   int NOT NULL DEFAULT 1 CHECK (min_slots >= 1),      -- "book 3+ slots, save 10%"
  weekdays    smallint[],
  valid_from  date,
  valid_to    date,
  max_redemptions int CHECK (max_redemptions >= 1),
  per_user_limit  int CHECK (per_user_limit >= 1),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value <= 100)
);
CREATE UNIQUE INDEX discounts_code ON discounts (venue_id, upper(code)) WHERE code IS NOT NULL;

-- ---------------------------------------------------------------- blocks (maintenance, holidays, private hire ...)
CREATE TABLE venue_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues ON DELETE CASCADE,
  resource_id uuid REFERENCES resources ON DELETE CASCADE,        -- null = the whole venue
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  kind        text NOT NULL DEFAULT 'other' CHECK (kind IN ('maintenance','holiday','event','private','other')),
  reason      text,
  batch_id    uuid NOT NULL,                                      -- one bulk request = one batch, released together
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX venue_blocks_venue_time ON venue_blocks (venue_id, starts_at, ends_at);
CREATE INDEX venue_blocks_batch ON venue_blocks (batch_id);

-- ---------------------------------------------------------------- reservations (a basket of slots, one or many areas / venues)
CREATE TABLE reservations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,                                -- short reference to quote at the front desk
  user_id    uuid NOT NULL REFERENCES users,
  status     text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  currency   text NOT NULL,
  promo_codes text[] NOT NULL DEFAULT '{}',
  subtotal_cents int NOT NULL DEFAULT 0,
  discount_cents int NOT NULL DEFAULT 0,
  total_cents    int NOT NULL DEFAULT 0,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservations_user ON reservations (user_id, created_at DESC);

-- A booking is one line of a reservation: one area, one contiguous run of slots.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('confirmed','cancelled','no_show'));
ALTER TABLE bookings
  ADD COLUMN reservation_id uuid REFERENCES reservations ON DELETE CASCADE,
  ADD COLUMN slots          int,
  ADD COLUMN players        int CHECK (players >= 1),
  ADD COLUMN base_cents     int,                                   -- price before discount
  ADD COLUMN discount_cents int NOT NULL DEFAULT 0,
  ADD COLUMN source         text NOT NULL DEFAULT 'user' CHECK (source IN ('user','admin','fixture')),
  ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refund_due','refunded','waived')),
  ADD COLUMN guest_name_enc  text,                                 -- walk-in / phone customers entered by staff (encrypted)
  ADD COLUMN guest_phone_enc text,
  ADD COLUMN refund_cents   int NOT NULL DEFAULT 0,
  ADD COLUMN cancelled_at   timestamptz,
  ADD COLUMN cancelled_by   uuid REFERENCES users,
  ADD COLUMN cancel_reason  text,
  ADD COLUMN reminded_at    timestamptz,
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();
UPDATE bookings SET source = 'fixture' WHERE event_id IS NOT NULL;
CREATE INDEX bookings_reservation ON bookings (reservation_id);
CREATE INDEX bookings_user_time ON bookings (user_id, starts_at DESC);

CREATE TABLE discount_redemptions (
  discount_id    uuid NOT NULL REFERENCES discounts ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users,
  amount_cents   int NOT NULL,
  PRIMARY KEY (discount_id, reservation_id)
);
CREATE INDEX discount_redemptions_user ON discount_redemptions (discount_id, user_id);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind       text NOT NULL,                                        -- reservation_confirmed | booking_cancelled | booking_modified | booking_reminder | ...
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE notification_prefs (
  user_id        uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  in_app         boolean NOT NULL DEFAULT true,
  email          boolean NOT NULL DEFAULT true,
  reminder_hours int NOT NULL DEFAULT 24 CHECK (reminder_hours BETWEEN 1 AND 168),
  muted_kinds    text[] NOT NULL DEFAULT '{}'
);

-- Outbound channels (email today) are queued here and sent by the dispatcher; in-app is always instant.
CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_pending ON notification_deliveries (created_at) WHERE status = 'pending';
