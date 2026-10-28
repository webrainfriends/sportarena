-- Team & delegation travel operations (#485). Additive only: nothing is dropped, narrowed or rewritten, and nothing here deletes data.
-- A trip is a thin operational layer over canonical records: events/fixtures, teams/organisations and their people, supplier orders (#458),
-- the event budget ledger and guardian links. It owns no calendar, roster, marketplace, invoice ledger or inventory of its own.
-- Rows are archived/withdrawn/superseded, never removed; every change is appended to trip_changes with a snapshot.

CREATE TABLE IF NOT EXISTS trips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  purpose          text CHECK (purpose IS NULL OR length(purpose) <= 500),
  team_id          uuid REFERENCES teams,
  organisation_id  uuid REFERENCES organisations,
  sport_id         uuid REFERENCES sports,
  competition      text CHECK (competition IS NULL OR length(competition) <= 120),
  origin           text NOT NULL CHECK (length(origin) BETWEEN 1 AND 160),
  destination      text NOT NULL CHECK (length(destination) BETWEEN 1 AND 160),
  origin_country   text CHECK (origin_country IS NULL OR origin_country ~ '^[A-Z]{2}$'),
  origin_lat       double precision CHECK (origin_lat IS NULL OR origin_lat BETWEEN -90 AND 90),
  origin_lng       double precision CHECK (origin_lng IS NULL OR origin_lng BETWEEN -180 AND 180),
  destination_country text CHECK (destination_country IS NULL OR destination_country ~ '^[A-Z]{2}$'),
  destination_lat  double precision CHECK (destination_lat IS NULL OR destination_lat BETWEEN -90 AND 90),
  destination_lng  double precision CHECK (destination_lng IS NULL OR destination_lng BETWEEN -180 AND 180),
  timezone         text NOT NULL,                                   -- IANA zone of the destination; per-diem days and "today" follow it
  depart_at        timestamptz NOT NULL,
  return_at        timestamptz NOT NULL,
  manager_id       uuid NOT NULL REFERENCES users,
  status           text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','approval_pending','confirmed','in_progress','completed','cancelled')),
  allow_guests     boolean NOT NULL DEFAULT false,                  -- policy: may the manager add approved guests / non-roster travellers
  documents_required boolean NOT NULL DEFAULT false,                -- international travel: passport / visa readiness counts toward readiness
  passport_min_months int NOT NULL DEFAULT 6 CHECK (passport_min_months BETWEEN 0 AND 24),
  approval_requested_by uuid REFERENCES users,
  approval_requested_at timestamptz,
  approved_by      uuid REFERENCES users,
  approved_at      timestamptz,
  status_reason    text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  idempotency_key  text,
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (return_at > depart_at),
  CHECK (team_id IS NOT NULL OR organisation_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS trips_idem ON trips (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS trips_team ON trips (team_id, depart_at) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trips_org ON trips (organisation_id, depart_at) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trips_manager ON trips (manager_id, status);

-- Links to canonical events / fixtures. Unlinking stamps unlinked_at; the fixture is never modified from here.
CREATE TABLE IF NOT EXISTS trip_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    uuid NOT NULL REFERENCES trips,
  event_id   uuid NOT NULL REFERENCES events,
  fixture_id uuid REFERENCES fixtures,
  linked_by  uuid NOT NULL REFERENCES users,
  linked_at  timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_events_live ON trip_events (trip_id, event_id, coalesce(fixture_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE unlinked_at IS NULL;
CREATE INDEX IF NOT EXISTS trip_events_event ON trip_events (event_id) WHERE unlinked_at IS NULL;

-- Notes and checklists. visibility: managers = trip managers and chaperones only; party = everyone on the trip.
CREATE TABLE IF NOT EXISTS trip_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid NOT NULL REFERENCES trips,
  kind        text NOT NULL CHECK (kind IN ('note','checklist')),
  visibility  text NOT NULL DEFAULT 'managers' CHECK (visibility IN ('managers','party')),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  done        boolean NOT NULL DEFAULT false,
  done_by     uuid REFERENCES users,
  done_at     timestamptz,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS trip_notes_trip ON trip_notes (trip_id) WHERE archived_at IS NULL;

-- The travel party. Identity stays in users; team membership and match selection are separate things this row never copies.
CREATE TABLE IF NOT EXISTS trip_participants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid NOT NULL REFERENCES trips,
  user_id      uuid NOT NULL REFERENCES users,
  role         text NOT NULL CHECK (role IN ('athlete','coach','staff','official','medical','manager','chaperone','guest','guardian')),
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','confirmed','declined','withdrawn','replaced')),
  basis        text NOT NULL CHECK (basis IN ('team_roster','organisation','official_assignment','approved_guest','guardian_of')),
  guardian_of  uuid REFERENCES users,                              -- role guardian: the young traveller they accompany
  invited_by   uuid NOT NULL REFERENCES users,
  responded_at timestamptz,
  replaces_id  uuid REFERENCES trip_participants,
  ended_reason text CHECK (ended_reason IS NULL OR length(ended_reason) <= 300),
  ended_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_participants_live ON trip_participants (trip_id, user_id) WHERE status IN ('invited','confirmed');
CREATE INDEX IF NOT EXISTS trip_participants_user ON trip_participants (user_id, status);

-- Trip-specific guardian consent for a young traveller. Separate from the general "participation" consent, which is never a stand-in for it.
CREATE TABLE IF NOT EXISTS trip_consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  participant_id uuid NOT NULL REFERENCES trip_participants,
  child_id       uuid NOT NULL REFERENCES users,
  guardian_id    uuid NOT NULL REFERENCES users,
  emergency_contact_ok boolean NOT NULL DEFAULT false,            -- the guardian agrees to be reachable by trip staff in an emergency
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_consents_live ON trip_consents (participant_id) WHERE revoked_at IS NULL;

-- Transport legs. Instants are timestamptz; each end also keeps its IANA zone so local times are shown correctly everywhere.
CREATE TABLE IF NOT EXISTS trip_segments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  mode           text NOT NULL CHECK (mode IN ('air','rail','coach','car','ferry','local_transfer','other')),
  mode_label     text CHECK (mode_label IS NULL OR length(mode_label) <= 60),
  provider       text CHECK (provider IS NULL OR length(provider) <= 120),
  reference      text CHECK (reference IS NULL OR length(reference) <= 80),
  reference_source text NOT NULL DEFAULT 'external' CHECK (reference_source IN ('external','supplier_order')),  -- never "verified": no provider adapter confirms inventory
  origin         text NOT NULL CHECK (length(origin) BETWEEN 1 AND 160),
  destination    text NOT NULL CHECK (length(destination) BETWEEN 1 AND 160),
  origin_country text CHECK (origin_country IS NULL OR origin_country ~ '^[A-Z]{2}$'),
  origin_lat     double precision CHECK (origin_lat IS NULL OR origin_lat BETWEEN -90 AND 90),
  origin_lng     double precision CHECK (origin_lng IS NULL OR origin_lng BETWEEN -180 AND 180),
  destination_country text CHECK (destination_country IS NULL OR destination_country ~ '^[A-Z]{2}$'),
  destination_lat double precision CHECK (destination_lat IS NULL OR destination_lat BETWEEN -90 AND 90),
  destination_lng double precision CHECK (destination_lng IS NULL OR destination_lng BETWEEN -180 AND 180),
  depart_at      timestamptz NOT NULL,
  depart_tz      text NOT NULL,
  arrive_at      timestamptz NOT NULL,
  arrive_tz      text NOT NULL,
  meeting_point  text CHECK (meeting_point IS NULL OR length(meeting_point) <= 200),
  baggage_ref    text CHECK (baggage_ref IS NULL OR length(baggage_ref) <= 120),
  status         text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','booked','delayed','cancelled','completed')),
  svc_order_id   uuid REFERENCES svc_orders,
  note           text CHECK (note IS NULL OR length(note) <= 500),
  row_version    int NOT NULL DEFAULT 1,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CHECK (arrive_at > depart_at)
);
CREATE INDEX IF NOT EXISTS trip_segments_trip ON trip_segments (trip_id, depart_at) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS trip_segment_passengers (
  segment_id     uuid NOT NULL REFERENCES trip_segments,
  participant_id uuid NOT NULL REFERENCES trip_participants,
  added_at       timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_segment_passengers_live ON trip_segment_passengers (segment_id, participant_id) WHERE removed_at IS NULL;

-- Accommodation and rooming. Room numbers and roommates are private (see docs/team-travel.md).
CREATE TABLE IF NOT EXISTS trip_stays (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  property_name  text NOT NULL CHECK (length(property_name) BETWEEN 1 AND 160),
  address        text CHECK (address IS NULL OR length(address) <= 300),
  country        text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  lat            double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng            double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  reference      text CHECK (reference IS NULL OR length(reference) <= 80),
  reference_source text NOT NULL DEFAULT 'external' CHECK (reference_source IN ('external','supplier_order')),
  check_in_at    timestamptz NOT NULL,
  check_out_at   timestamptz NOT NULL,
  tz             text NOT NULL,
  status         text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','booked','changed','cancelled','completed')),
  svc_order_id   uuid REFERENCES svc_orders,
  note           text CHECK (note IS NULL OR length(note) <= 500),
  row_version    int NOT NULL DEFAULT 1,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CHECK (check_out_at > check_in_at)
);
CREATE INDEX IF NOT EXISTS trip_stays_trip ON trip_stays (trip_id) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS trip_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stay_id     uuid NOT NULL REFERENCES trip_stays,
  room_type   text NOT NULL CHECK (room_type IN ('single','double','twin','triple','quad','family','dorm','other')),
  label       text CHECK (label IS NULL OR length(label) <= 40),
  capacity    int NOT NULL CHECK (capacity BETWEEN 1 AND 20),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE TABLE IF NOT EXISTS trip_room_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        uuid NOT NULL REFERENCES trip_rooms,
  participant_id uuid NOT NULL REFERENCES trip_participants,
  assigned_by    uuid NOT NULL REFERENCES users,
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_room_assignments_live ON trip_room_assignments (room_id, participant_id) WHERE released_at IS NULL;

-- Passport / visa readiness: status and expiry only. Identifiers and evidence references are encrypted and revealed only to the holder
-- or a verified guardian (every reveal is audit-logged). No scans are stored.
CREATE TABLE IF NOT EXISTS trip_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  participant_id uuid NOT NULL REFERENCES trip_participants,
  kind           text NOT NULL CHECK (kind IN ('passport','visa')),
  status         text NOT NULL CHECK (status IN ('held','not_held','unknown','not_required','required','submitted','approved')),
  expires_on     date,
  number_enc     text,
  evidence_ref_enc text,
  updated_by     uuid NOT NULL REFERENCES users,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, kind)
);

-- Equipment and baggage consignments. References a canonical resource/asset when one exists; never duplicates stock.
CREATE TABLE IF NOT EXISTS trip_gear (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  category       text NOT NULL CHECK (category IN ('kit','equipment','medical','technical','food','personal','other')),
  description    text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  quantity       int NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  responsible_id uuid REFERENCES users,
  segment_id     uuid REFERENCES trip_segments,
  resource_id    uuid REFERENCES resources,
  logistics_ref  text CHECK (logistics_ref IS NULL OR length(logistics_ref) <= 80),
  state          text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','packed','loaded','in_transit','unloaded','received','missing','damaged')),
  row_version    int NOT NULL DEFAULT 1,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);
CREATE TABLE IF NOT EXISTS trip_gear_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gear_id    uuid NOT NULL REFERENCES trip_gear,
  state      text NOT NULL,
  checkpoint text CHECK (checkpoint IS NULL OR length(checkpoint) <= 120),
  note       text CHECK (note IS NULL OR length(note) <= 300),
  actor_id   uuid NOT NULL REFERENCES users,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trip_incidents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  kind           text NOT NULL CHECK (kind IN ('delay','medical','safeguarding','lost_item','security','other')),
  summary        text NOT NULL CHECK (length(summary) BETWEEN 2 AND 300),     -- operational summary only; no clinical or document detail
  participant_id uuid REFERENCES trip_participants,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  reported_by    uuid NOT NULL REFERENCES users,
  resolved_by    uuid REFERENCES users,
  resolved_at    timestamptz,
  resolution     text CHECK (resolution IS NULL OR length(resolution) <= 300),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Append-only history of every operational change. affected_user_ids is who was told; the snapshot never holds document numbers.
CREATE TABLE IF NOT EXISTS trip_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid NOT NULL REFERENCES trips,
  entity      text NOT NULL CHECK (entity IN ('trip','event_link','participant','segment','stay','room','gear','consent','document','incident','money','supplier_link','note')),
  entity_id   uuid,
  action      text NOT NULL,
  version     int,
  snapshot    jsonb NOT NULL DEFAULT '{}',
  note        text CHECK (note IS NULL OR length(note) <= 500),
  actor_id    uuid REFERENCES users,
  affected_user_ids uuid[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_changes_trip ON trip_changes (trip_id, created_at DESC);
CREATE OR REPLACE FUNCTION trip_history_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'trip history is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trip_changes_append_only ON trip_changes;
CREATE TRIGGER trip_changes_append_only BEFORE UPDATE OR DELETE ON trip_changes FOR EACH ROW EXECUTE FUNCTION trip_history_guard();
DROP TRIGGER IF EXISTS trip_gear_log_append_only ON trip_gear_log;
CREATE TRIGGER trip_gear_log_append_only BEFORE UPDATE OR DELETE ON trip_gear_log FOR EACH ROW EXECUTE FUNCTION trip_history_guard();

-- Per diem and expenses. Four states kept apart: entitlement (policy x days) -> claim (submitted/approved/rejected) -> payment (recorded money out)
-- -> balance. Money that leaves is recorded in trip_payments and, for an event organiser, in the canonical event budget ledger.
CREATE TABLE IF NOT EXISTS trip_perdiem_policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid NOT NULL REFERENCES trips,
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  daily_minor  bigint NOT NULL CHECK (daily_minor > 0),
  roles        text[] NOT NULL DEFAULT '{}',                     -- empty = every confirmed traveller
  created_by   uuid NOT NULL REFERENCES users,
  approved_by  uuid REFERENCES users,
  approved_at  timestamptz,
  superseded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_perdiem_live ON trip_perdiem_policies (trip_id) WHERE superseded_at IS NULL;
CREATE TABLE IF NOT EXISTS trip_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  participant_id uuid NOT NULL REFERENCES trip_participants,
  category       text NOT NULL CHECK (category IN ('meals','transport','lodging','visa_fees','baggage','other')),
  description    text NOT NULL CHECK (length(description) BETWEEN 2 AND 300),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  incurred_on    date NOT NULL,
  receipt_ref_enc text,
  status         text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  decision_note  text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  idempotency_key text,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_claims_idem ON trip_claims (participant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS trip_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  participant_id uuid NOT NULL REFERENCES trip_participants,
  kind           text NOT NULL CHECK (kind IN ('advance','per_diem','reimbursement')),
  claim_id       uuid REFERENCES trip_claims,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference      text CHECK (reference IS NULL OR length(reference) <= 80),
  source         text NOT NULL CHECK (source IN ('event_budget','external_record')),
  budget_payment_id uuid REFERENCES event_budget_payments,
  idempotency_key text,
  recorded_by    uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz,
  voided_by      uuid REFERENCES users,
  CHECK ((kind = 'reimbursement') = (claim_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_payments_idem ON trip_payments (trip_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trip_payments_claim ON trip_payments (claim_id) WHERE claim_id IS NOT NULL AND voided_at IS NULL;

-- Procurement hand-off: link an existing #458 RFQ / accepted order to the trip. The quote and order stay in supplier services.
CREATE TABLE IF NOT EXISTS trip_supplier_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    uuid NOT NULL REFERENCES trips,
  purpose    text NOT NULL CHECK (purpose IN ('travel','accommodation','local_transfer','equipment_freight','other')),
  rfq_id     uuid REFERENCES svc_rfqs,
  order_id   uuid REFERENCES svc_orders,
  linked_by  uuid NOT NULL REFERENCES users,
  linked_at  timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  CHECK ((rfq_id IS NOT NULL) <> (order_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_supplier_links_rfq ON trip_supplier_links (trip_id, rfq_id) WHERE unlinked_at IS NULL AND rfq_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trip_supplier_links_order ON trip_supplier_links (trip_id, order_id) WHERE unlinked_at IS NULL AND order_id IS NOT NULL;
