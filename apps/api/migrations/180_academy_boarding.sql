-- 180: Residential Academy & Boarding Operations (issue #789)
-- Additive only. No DROP, TRUNCATE, or column narrowing.
-- Composes: organisations, users, org_enrolments, organisation_members, org_units, academy_suppliers, invoices.
-- Never duplicates identity, billing, guardian, or health subsystems.

-- ─── 1. Per-organisation boarding configuration ──────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_config (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL UNIQUE REFERENCES organisations(id),
  boarding_enabled     boolean NOT NULL DEFAULT false,
  gender_policy        text NOT NULL DEFAULT 'per_building' CHECK (gender_policy IN ('per_building','mixed_all','single_sex_all')),
  default_weekday_curfew time,
  default_weekend_curfew time,
  age_min              smallint CHECK (age_min >= 0),
  age_max              smallint CHECK (age_max <= 25),
  max_leave_hours      smallint DEFAULT 72,
  meal_slots           jsonb NOT NULL DEFAULT '["breakfast","lunch","dinner"]'::jsonb,
  incident_categories  text[] NOT NULL DEFAULT ARRAY['welfare','maintenance','safety','fire','medical_liaison','other'],
  notes                text,
  updated_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boarding_config_org ON boarding_config(organisation_id);

-- ─── 2. Buildings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_buildings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id),
  unit_id              uuid REFERENCES org_units(id) ON DELETE SET NULL,  -- optional campus link
  name                 text NOT NULL,
  code                 text,
  gender_policy        text NOT NULL DEFAULT 'mixed' CHECK (gender_policy IN ('male','female','mixed','staff')),
  age_min              smallint DEFAULT 0,
  age_max              smallint DEFAULT 25,
  floor_count          smallint DEFAULT 1,
  notes                text,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','closed','archived')),
  archived_at          timestamptz,
  row_version          integer NOT NULL DEFAULT 1,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

CREATE INDEX IF NOT EXISTS idx_boarding_buildings_org ON boarding_buildings(organisation_id) WHERE archived_at IS NULL;

-- ─── 3. Rooms ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_rooms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id          uuid NOT NULL REFERENCES boarding_buildings(id),
  number               text NOT NULL,
  floor                smallint DEFAULT 1,
  room_type            text NOT NULL DEFAULT 'twin' CHECK (room_type IN ('single','twin','triple','quad','dorm','staff','utility')),
  capacity             smallint NOT NULL DEFAULT 2 CHECK (capacity >= 1),
  en_suite             boolean NOT NULL DEFAULT false,
  accessibility_flag   boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','closed','archived')),
  notes                text,
  archived_at          timestamptz,
  row_version          integer NOT NULL DEFAULT 1,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (building_id, number)
);

CREATE INDEX IF NOT EXISTS idx_boarding_rooms_building ON boarding_rooms(building_id) WHERE archived_at IS NULL;

-- ─── 4. Beds ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_beds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id              uuid NOT NULL REFERENCES boarding_rooms(id),
  position             text NOT NULL DEFAULT 'A',           -- A, B, C… or top/bottom for bunks
  status               text NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','reserved','maintenance','decommissioned')),
  notes_enc            text,
  archived_at          timestamptz,
  row_version          integer NOT NULL DEFAULT 1,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, position)
);

CREATE INDEX IF NOT EXISTS idx_boarding_beds_room ON boarding_beds(room_id) WHERE archived_at IS NULL;

-- ─── 5. Occupancies (effective-dated bed ↔ enrolment) ─────────────────────────
-- Concurrency: allocate_boarding_bed SELECTs FOR UPDATE on the bed row before inserting.
CREATE TABLE IF NOT EXISTS boarding_occupancies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bed_id               uuid NOT NULL REFERENCES boarding_beds(id),
  enrolment_id         uuid NOT NULL REFERENCES org_enrolments(id),
  valid_from           date NOT NULL,
  valid_to             date,                                -- NULL = current resident
  allocated_by         uuid NOT NULL REFERENCES users(id),
  rationale_enc        text,                               -- internal staff note, encrypted
  check_in_at          timestamptz,
  check_in_by          uuid REFERENCES users(id),
  check_out_at         timestamptz,
  check_out_by         uuid REFERENCES users(id),
  vacated_reason       text,
  row_version          integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Prevents double-booking: a bed cannot have two open occupancies for the same date range.
CREATE UNIQUE INDEX IF NOT EXISTS uq_boarding_occupancy_active
  ON boarding_occupancies(bed_id)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_boarding_occupancies_enrolment ON boarding_occupancies(enrolment_id);
CREATE INDEX IF NOT EXISTS idx_boarding_occupancies_bed ON boarding_occupancies(bed_id);

-- ─── 6. Boarding applications ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_applications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id),
  enrolment_id         uuid NOT NULL REFERENCES org_enrolments(id),
  status               text NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted','under_review','offered','waitlisted','declined',
                                           'awaiting_acceptance','allocated','withdrawn','vacated')),
  priority             smallint DEFAULT 5,                  -- 1 high … 10 low
  preferred_building_id uuid REFERENCES boarding_buildings(id),
  programme_start      date,
  programme_end        date,
  notes_enc            text,                               -- internal staff notes, never shown to athlete
  offer_expires_at     timestamptz,
  guardian_accepted_at timestamptz,
  guardian_accepted_by uuid REFERENCES users(id),
  reviewed_at          timestamptz,
  reviewed_by          uuid REFERENCES users(id),
  review_note_enc      text,
  allocated_at         timestamptz,
  idempotency_key      text UNIQUE,
  row_version          integer NOT NULL DEFAULT 1,
  created_by           uuid NOT NULL REFERENCES users(id),  -- athlete or guardian
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrolment_id, status) DEFERRABLE INITIALLY DEFERRED  -- prevent two open applications for same enrolment
);

CREATE INDEX IF NOT EXISTS idx_boarding_apps_org ON boarding_applications(organisation_id, status);
CREATE INDEX IF NOT EXISTS idx_boarding_apps_enrolment ON boarding_applications(enrolment_id);

-- ─── 7. Leave requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_leave_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occupancy_id         uuid NOT NULL REFERENCES boarding_occupancies(id),
  leave_from           timestamptz NOT NULL,
  leave_to             timestamptz NOT NULL,
  reason_code          text NOT NULL DEFAULT 'family' CHECK (reason_code IN ('family','medical_liaison','competition','education','holiday','other')),
  destination_enc      text,                               -- encrypted: where athlete is going
  guardian_requested_by uuid REFERENCES users(id),
  guardian_approved_by uuid REFERENCES users(id),
  guardian_approved_at timestamptz,
  staff_approved_by    uuid REFERENCES users(id),
  staff_approved_at    timestamptz,
  staff_note_enc       text,
  denied_reason        text,
  return_actual        timestamptz,
  return_confirmed_by  uuid REFERENCES users(id),
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','guardian_approved','staff_approved','denied','cancelled','active','returned','overdue')),
  idempotency_key      text UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boarding_leave_occupancy ON boarding_leave_requests(occupancy_id);
CREATE INDEX IF NOT EXISTS idx_boarding_leave_active ON boarding_leave_requests(leave_from, leave_to) WHERE status IN ('staff_approved','active','overdue');

-- ─── 8. Visitor logs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_visitor_logs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occupancy_id         uuid NOT NULL REFERENCES boarding_occupancies(id),
  visitor_name_enc     text NOT NULL,
  visitor_phone_enc    text,
  visitor_id_ref_enc   text,                              -- reference to ID shown at desk, encrypted
  relationship         text NOT NULL CHECK (relationship IN ('parent','sibling','relative','family_friend','coach','club_official','other')),
  purpose              text NOT NULL DEFAULT 'visit' CHECK (purpose IN ('visit','pickup','delivery','other')),
  guardian_authorised_by uuid REFERENCES users(id),
  guardian_authorised_at timestamptz,
  guardian_auth_note   text,
  arrived_at           timestamptz NOT NULL DEFAULT now(),
  expected_departure   timestamptz,
  departed_at          timestamptz,
  staff_signed_in_by   uuid NOT NULL REFERENCES users(id),
  staff_signed_out_by  uuid REFERENCES users(id),
  status               text NOT NULL DEFAULT 'on_site' CHECK (status IN ('on_site','departed','refused')),
  refusal_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boarding_visitors_occupancy ON boarding_visitor_logs(occupancy_id);
CREATE INDEX IF NOT EXISTS idx_boarding_visitors_on_site ON boarding_visitor_logs(arrived_at) WHERE status = 'on_site';

-- ─── 9. Curfew rules ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_curfew_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id          uuid NOT NULL REFERENCES boarding_buildings(id),
  age_min              smallint DEFAULT 0,
  age_max              smallint DEFAULT 25,
  weekday_curfew       time NOT NULL,
  weekend_curfew       time NOT NULL,
  valid_from           date NOT NULL DEFAULT CURRENT_DATE,
  valid_to             date,
  set_by               uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boarding_curfew_building ON boarding_curfew_rules(building_id);

-- ─── 10. Duty assignments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_duty_assignments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id),
  building_id          uuid REFERENCES boarding_buildings(id),  -- NULL = whole campus
  user_id              uuid NOT NULL REFERENCES users(id),
  duty_date            date NOT NULL,
  shift_start          time NOT NULL,
  shift_end            time NOT NULL,
  role_code            text NOT NULL DEFAULT 'housemaster'
                         CHECK (role_code IN ('housemaster','houseparent','night_cover','safeguarding','welfare','coordinator','manager')),
  acknowledged_at      timestamptz,
  cover_for_id         uuid REFERENCES boarding_duty_assignments(id),  -- substitute link
  notes                text,
  row_version          integer NOT NULL DEFAULT 1,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boarding_duty_org_date ON boarding_duty_assignments(organisation_id, duty_date);
CREATE INDEX IF NOT EXISTS idx_boarding_duty_user ON boarding_duty_assignments(user_id);

-- ─── 11. Welfare checks ──────────────────────────────────────────────────────
-- note_enc is restricted: only boarding coordinator and safeguarding roles may read it.
CREATE TABLE IF NOT EXISTS boarding_welfare_checks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_assignment_id   uuid NOT NULL REFERENCES boarding_duty_assignments(id),
  occupancy_id         uuid REFERENCES boarding_occupancies(id),  -- NULL = general building check
  building_id          uuid REFERENCES boarding_buildings(id),
  checked_at           timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL CHECK (status IN ('present','absent','concern','late_return','room_empty','all_present')),
  note_enc             text,                              -- restricted: safeguarding only
  reporter_id          uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boarding_welfare_duty ON boarding_welfare_checks(duty_assignment_id);
CREATE INDEX IF NOT EXISTS idx_boarding_welfare_occupancy ON boarding_welfare_checks(occupancy_id) WHERE occupancy_id IS NOT NULL;

-- ─── 12. Incidents ───────────────────────────────────────────────────────────
-- safeguarding_flag=true: full record visible only to boarding coordinator + safeguarding officer.
-- GET returns 404 (not 403) for underprivileged roles, so incident existence is not leaked.
CREATE TABLE IF NOT EXISTS boarding_incidents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id),
  building_id          uuid REFERENCES boarding_buildings(id),
  room_id              uuid REFERENCES boarding_rooms(id),
  occupancy_id         uuid REFERENCES boarding_occupancies(id),
  severity             text NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
  category             text NOT NULL DEFAULT 'other',
  description_enc      text NOT NULL,
  safeguarding_flag    boolean NOT NULL DEFAULT false,
  reporter_id          uuid NOT NULL REFERENCES users(id),
  assigned_to          uuid REFERENCES users(id),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','in_progress','resolved','closed')),
  resolved_at          timestamptz,
  resolved_by          uuid REFERENCES users(id),
  resolution_note_enc  text,
  supplier_request_id  uuid,                              -- linked to academy_supplier_requests if maintenance
  idempotency_key      text UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boarding_incidents_org ON boarding_incidents(organisation_id, status);
CREATE INDEX IF NOT EXISTS idx_boarding_incidents_safeguarding ON boarding_incidents(organisation_id) WHERE safeguarding_flag = true;

-- ─── 13. Meal plans ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boarding_meal_plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occupancy_id         uuid NOT NULL REFERENCES boarding_occupancies(id),
  plan_code            text NOT NULL DEFAULT 'full' CHECK (plan_code IN ('breakfast_only','half','full','custom','none')),
  valid_from           date NOT NULL DEFAULT CURRENT_DATE,
  valid_to             date,
  notes                text,
  set_by               uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_boarding_meal_plan_active
  ON boarding_meal_plans(occupancy_id)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_boarding_meal_occupancy ON boarding_meal_plans(occupancy_id);

-- ─── 14. Meal flags (operational dietary flags — never clinical) ───────────────
-- flag_key is a safe operational code (halal, kosher, vegetarian, etc.); never stores medical diagnosis.
-- consented_at records guardian/athlete consent; revoked_at soft-deletes without erasing history.
CREATE TABLE IF NOT EXISTS boarding_meal_flags (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occupancy_id         uuid NOT NULL REFERENCES boarding_occupancies(id),
  flag_key             text NOT NULL CHECK (flag_key IN ('halal','kosher','vegetarian','vegan','nut_free','gluten_free','dairy_free','egg_free','shellfish_free','low_sugar','other')),
  consented_at         timestamptz NOT NULL DEFAULT now(),
  consented_by         uuid NOT NULL REFERENCES users(id),
  source               text NOT NULL DEFAULT 'guardian' CHECK (source IN ('guardian','athlete','staff_recorded')),
  revoked_at           timestamptz,
  revoked_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (occupancy_id, flag_key)
);

CREATE INDEX IF NOT EXISTS idx_boarding_meal_flags_occupancy ON boarding_meal_flags(occupancy_id) WHERE revoked_at IS NULL;

-- ─── 15. Boarding charges (references canonical invoices — no new ledger) ────
CREATE TABLE IF NOT EXISTS boarding_charges (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occupancy_id         uuid NOT NULL REFERENCES boarding_occupancies(id),
  invoice_id           uuid,                              -- FK to invoices when canonical billing confirms
  invoice_line_ref     text,
  period_from          date NOT NULL,
  period_to            date NOT NULL,
  amount_minor         bigint NOT NULL,
  currency             text NOT NULL,
  charge_type          text NOT NULL DEFAULT 'boarding_fee' CHECK (charge_type IN ('boarding_fee','meal_plan','laundry','activity','deposit','other')),
  description          text,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','invoiced','paid','overdue','refunded','cancelled')),
  idempotency_key      text UNIQUE,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boarding_charges_occupancy ON boarding_charges(occupancy_id);
CREATE INDEX IF NOT EXISTS idx_boarding_charges_invoice ON boarding_charges(invoice_id) WHERE invoice_id IS NOT NULL;
