-- Academy daily transport: routes, stops, vehicles, schedules, bookings, check-ins and invoice lines.
-- Additive only — never touches existing tables.

CREATE TABLE academy_transport_routes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind            text NOT NULL CHECK (kind IN ('school_run','training_commute','event_shuttle','other')),
  direction       text NOT NULL DEFAULT 'both' CHECK (direction IN ('outbound','return','both')),
  supplier_id     uuid REFERENCES academy_suppliers,
  operator_name   text CHECK (char_length(operator_name) <= 120),
  notes_enc       text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON academy_transport_routes (organisation_id, status);

CREATE TABLE academy_transport_stops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id    uuid NOT NULL REFERENCES academy_transport_routes,
  sequence    smallint NOT NULL,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  address_enc text,
  gps_allowed boolean NOT NULL DEFAULT false,
  lat         numeric(9,6),
  lng         numeric(9,6),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, sequence)
);

CREATE TABLE academy_transport_vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id         uuid NOT NULL REFERENCES academy_transport_routes,
  registration_enc text,
  description      text CHECK (char_length(description) <= 200),
  capacity         smallint NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  driver_id        uuid REFERENCES users,
  driver_name_enc  text,
  driver_phone_enc text,
  escort_id        uuid REFERENCES users,
  valid_from       date NOT NULL DEFAULT CURRENT_DATE,
  valid_until      date,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE academy_route_schedules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id             uuid NOT NULL REFERENCES academy_transport_routes,
  session_id           uuid REFERENCES academy_sessions,
  cohort_id            uuid REFERENCES org_cohorts,
  recurrence           text[] NOT NULL DEFAULT '{}',
  outbound_depart_time time,
  return_depart_time   time,
  schedule_date        date,
  vehicle_id           uuid REFERENCES academy_transport_vehicles,
  seats_total          smallint,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','completed')),
  row_version          int NOT NULL DEFAULT 1,
  created_by           uuid REFERENCES users,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON academy_route_schedules (route_id, status);

CREATE TABLE academy_transport_bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  uuid NOT NULL REFERENCES academy_route_schedules,
  athlete_id   uuid NOT NULL REFERENCES users,
  stop_id      uuid REFERENCES academy_transport_stops,
  direction    text NOT NULL CHECK (direction IN ('outbound','return','both')),
  approved_by  uuid REFERENCES users,
  approved_at  timestamptz,
  revoked_by   uuid REFERENCES users,
  revoked_at   timestamptz,
  notes_enc    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, athlete_id, direction)
);
CREATE INDEX ON academy_transport_bookings (schedule_id) WHERE revoked_at IS NULL;

CREATE TABLE academy_transport_check_ins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id     uuid NOT NULL REFERENCES academy_route_schedules,
  athlete_id      uuid NOT NULL REFERENCES users,
  stop_id         uuid NOT NULL REFERENCES academy_transport_stops,
  direction       text NOT NULL CHECK (direction IN ('outbound','return')),
  event           text NOT NULL CHECK (event IN ('boarded','alighted','no_show','refused')),
  recorded_by     uuid REFERENCES users,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  offline         boolean NOT NULL DEFAULT false,
  captured_at     timestamptz,
  idempotency_key text,
  notes_enc       text,
  UNIQUE NULLS NOT DISTINCT (idempotency_key)
);
CREATE INDEX ON academy_transport_check_ins (schedule_id, athlete_id, recorded_at DESC);
CREATE TRIGGER academy_transport_check_ins_guard BEFORE UPDATE OR DELETE
  ON academy_transport_check_ins FOR EACH ROW EXECUTE FUNCTION youth_history_guard();

CREATE TABLE academy_transport_invoice_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id    uuid NOT NULL REFERENCES academy_route_schedules,
  invoice_ref    text CHECK (char_length(invoice_ref) <= 80),
  amount_minor   bigint,
  currency       char(3),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','paid','disputed')),
  submitted_by   uuid REFERENCES users,
  submitted_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON academy_transport_invoice_lines (schedule_id);
