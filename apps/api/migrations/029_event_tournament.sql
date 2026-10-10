-- Tournament management for events: invitations, rules/seeding, holiday calendars, knockout brackets, event staff, vendors.
-- Idempotent: this file was first shipped as 027_event_tournament.sql and renumbered, so a database that already ran it must not fail.
-- Additive only: no existing column, row or constraint is narrowed. Nothing is deleted; every lifecycle ends in a status.

-- ---------------------------------------------------------------- invitations (teams or individuals)
CREATE TABLE IF NOT EXISTS event_invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events,
  team_id      uuid REFERENCES teams,
  user_id      uuid REFERENCES users,
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','declined','withdrawn','expired')),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ranking','rule')),
  rating       numeric,                    -- computed strength when it was suggested (informational)
  seed_hint    int CHECK (seed_hint IS NULL OR seed_hint >= 1),
  message      text,
  invited_by   uuid NOT NULL REFERENCES users,
  entry_id     uuid REFERENCES event_entries,
  expires_at   timestamptz,
  responded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((team_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS event_invitations_open ON event_invitations (event_id, coalesce(team_id, user_id)) WHERE status = 'invited';
CREATE INDEX IF NOT EXISTS event_invitations_event ON event_invitations (event_id, status);

-- ---------------------------------------------------------------- organiser-defined rules (data; evaluated by code)
CREATE TABLE IF NOT EXISTS event_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events,
  kind       text NOT NULL CHECK (kind IN ('invite_top_n','min_rating','min_games','city','exclude_team','seeding','note')),
  params     jsonb NOT NULL DEFAULT '{}',
  position   int NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_rules_event ON event_rules (event_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS event_seeds (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events,
  team_id    uuid NOT NULL REFERENCES teams,
  seed       int NOT NULL CHECK (seed >= 1),
  source     text NOT NULL DEFAULT 'computed' CHECK (source IN ('computed','manual')),
  rating     numeric,
  set_by     uuid REFERENCES users,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, team_id)
);

-- ---------------------------------------------------------------- calendar: event blackout days + reusable public holidays
CREATE TABLE IF NOT EXISTS event_calendar_days (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events,
  venue_id   uuid REFERENCES venues,       -- null = applies to every venue used by the event
  on_date    date NOT NULL,
  kind       text NOT NULL DEFAULT 'blackout' CHECK (kind IN ('holiday','blackout','rest_day')),
  label      text,
  created_by uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_calendar_days_event ON event_calendar_days (event_id, on_date) WHERE removed_at IS NULL;

-- Public holidays entered by users, matched against the venue's country (and city when `region` is set). No rows are shipped.
CREATE TABLE IF NOT EXISTS holiday_calendar_days (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country    text NOT NULL,                 -- ISO-3166 alpha-2 / free text, compared case-insensitively
  region     text,                          -- optional city/state the holiday is local to
  on_date    date NOT NULL,
  label      text NOT NULL,
  created_by uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS holiday_calendar_days_uniq ON holiday_calendar_days (upper(country), coalesce(lower(region), ''), on_date) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------- stages and knockout brackets
CREATE TABLE IF NOT EXISTS event_stages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events,
  kind       text NOT NULL CHECK (kind IN ('round_robin','knockout')),
  name       text NOT NULL,
  position   int NOT NULL DEFAULT 0,
  config     jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_stages_event ON event_stages (event_id, position);

-- Fixtures may now be bracket placeholders: teams unknown until feeder fixtures finish.
ALTER TABLE fixtures DROP CONSTRAINT IF EXISTS fixtures_check;
ALTER TABLE fixtures ADD CONSTRAINT fixtures_check CHECK (home_team_id IS NULL OR away_team_id IS NULL OR home_team_id <> away_team_id);
ALTER TABLE fixtures
  ADD COLUMN IF NOT EXISTS stage_id         uuid REFERENCES event_stages,
  ADD COLUMN IF NOT EXISTS round_kind       text CHECK (round_kind IN ('group','round_of_32','round_of_16','quarter','semi','final','third_place')),
  ADD COLUMN IF NOT EXISTS bracket_slot     int,
  ADD COLUMN IF NOT EXISTS home_placeholder text,
  ADD COLUMN IF NOT EXISTS away_placeholder text,
  ADD COLUMN IF NOT EXISTS winner_team_id   uuid REFERENCES teams,
  ADD COLUMN IF NOT EXISTS win_feeds_fixture_id  uuid REFERENCES fixtures,
  ADD COLUMN IF NOT EXISTS win_feeds_side        text CHECK (win_feeds_side IN ('home','away')),
  ADD COLUMN IF NOT EXISTS lose_feeds_fixture_id uuid REFERENCES fixtures,
  ADD COLUMN IF NOT EXISTS lose_feeds_side       text CHECK (lose_feeds_side IN ('home','away'));
CREATE INDEX IF NOT EXISTS fixtures_stage ON fixtures (stage_id, round_kind, bracket_slot);

-- ---------------------------------------------------------------- event staff (referees, doctors, physios, volunteers ...)
CREATE TABLE IF NOT EXISTS event_staff_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  role        text NOT NULL CHECK (role IN ('referee','umpire','linesman','scorer','doctor','physio','medic','volunteer','security','other')),
  title       text,
  needed      int NOT NULL DEFAULT 1 CHECK (needed >= 1),
  fee_cents   bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  currency    text NOT NULL DEFAULT 'INR',
  notes       text,
  closed_at   timestamptz,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_staff_roles_event ON event_staff_roles (event_id);

CREATE TABLE IF NOT EXISTS event_staff_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id     uuid NOT NULL REFERENCES event_staff_roles,
  event_id    uuid NOT NULL REFERENCES events,
  user_id     uuid NOT NULL REFERENCES users,
  status      text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','declined','released','withdrawn','completed')),
  fee_cents   bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  message     text,
  invited_by  uuid NOT NULL REFERENCES users,
  responded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_staff_assignments_open ON event_staff_assignments (role_id, user_id) WHERE status IN ('invited','accepted');
CREATE INDEX IF NOT EXISTS event_staff_assignments_user ON event_staff_assignments (user_id, status);

-- Append-only transition log.
CREATE TABLE IF NOT EXISTS event_staff_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES event_staff_assignments,
  actor_id      uuid REFERENCES users,
  from_status   text,
  to_status     text NOT NULL,
  reason        text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_staff_history_assignment ON event_staff_history (assignment_id, at);

-- ---------------------------------------------------------------- vendors: retail, catering, sponsors
CREATE TABLE IF NOT EXISTS event_vendors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  kind           text NOT NULL CHECK (kind IN ('retail','catering','sponsor','other')),
  vendor_user_id uuid NOT NULL REFERENCES users,   -- the person who accepts/declines (shop owner, sponsor owner ...)
  sponsor_id     uuid REFERENCES sponsors,
  fee_cents      bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),   -- pitch fee (retail/catering) or sponsorship amount
  currency       text NOT NULL DEFAULT 'INR',
  in_kind        text,
  notes          text,
  status         text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','declined','ended')),
  sponsorship_id uuid REFERENCES sponsorships,
  invited_by     uuid NOT NULL REFERENCES users,
  responded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_vendors_open ON event_vendors (event_id, kind, vendor_user_id) WHERE status IN ('invited','accepted');
CREATE INDEX IF NOT EXISTS event_vendors_user ON event_vendors (vendor_user_id, status);

CREATE TABLE IF NOT EXISTS event_products (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events,
  product_id uuid NOT NULL REFERENCES shop_products,
  added_by   uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_products_live ON event_products (event_id, product_id) WHERE removed_at IS NULL;
