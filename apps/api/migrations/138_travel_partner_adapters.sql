-- Travel partner adapters (#704): hotel / flight search, hold and book through the Integration Hub, plus organiser room blocks ("stay-to-play").
-- Additive only: new tables, two CHECK constraints widened (never narrowed). Nothing is dropped, rewritten or cascaded; rows are voided/cancelled, not deleted.
-- Rollback: the new tables are unused by older code; the widened CHECKs only add allowed values.

-- Per-traveller consent to share booking details with a partner (given by the traveller, or the verified guardian of a young traveller). Revoked, never deleted.
CREATE TABLE IF NOT EXISTS trip_partner_consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips,
  participant_id uuid NOT NULL REFERENCES trip_participants,
  granted_by     uuid NOT NULL REFERENCES users,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_partner_consents_live ON trip_partner_consents (participant_id) WHERE revoked_at IS NULL;

-- Organiser-supplied room block for an event. The organiser states the terms; SportArena only records and allocates.
CREATE TABLE IF NOT EXISTS event_room_blocks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events,
  property_name text NOT NULL CHECK (length(property_name) BETWEEN 1 AND 160),
  address      text CHECK (address IS NULL OR length(address) <= 300),
  country      text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  check_in_on  date NOT NULL,
  check_out_on date NOT NULL CHECK (check_out_on > check_in_on),
  rooms_total  int NOT NULL CHECK (rooms_total BETWEEN 1 AND 2000),
  rate_minor   bigint NOT NULL CHECK (rate_minor >= 0),
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cut_off_on   date,
  terms        text CHECK (terms IS NULL OR length(terms) <= 1000),
  reference    text CHECK (reference IS NULL OR length(reference) <= 80),
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);
CREATE INDEX IF NOT EXISTS event_room_blocks_event ON event_room_blocks (event_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS travel_bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips,
  kind          text NOT NULL CHECK (kind IN ('air','stay')),
  source        text NOT NULL CHECK (source IN ('partner','room_block')),
  install_id    uuid REFERENCES integration_installs,
  room_block_id uuid REFERENCES event_room_blocks,
  partner_ref   text CHECK (partner_ref IS NULL OR length(partner_ref) <= 120),
  offer_ref     text CHECK (offer_ref IS NULL OR length(offer_ref) <= 120),
  status        text NOT NULL CHECK (status IN ('held','booked','changed','cancelled','failed')),
  summary       text NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  tz            text NOT NULL,
  price_minor   bigint NOT NULL CHECK (price_minor >= 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rooms         int CHECK (rooms IS NULL OR rooms BETWEEN 1 AND 100),
  terms         jsonb NOT NULL DEFAULT '{}'::jsonb,       -- cancellation terms as given by the partner or organiser
  cancel_by     timestamptz,
  segment_id    uuid REFERENCES trip_segments,
  stay_id       uuid REFERENCES trip_stays,
  budget_payment_id uuid REFERENCES event_budget_payments,
  idempotency_key text,
  row_version   int NOT NULL DEFAULT 1,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS travel_bookings_trip ON travel_bookings (trip_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS travel_bookings_idem ON travel_bookings (trip_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS travel_bookings_partner_ref ON travel_bookings (install_id, partner_ref) WHERE partner_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS travel_booking_travellers (
  booking_id     uuid NOT NULL REFERENCES travel_bookings,
  participant_id uuid NOT NULL REFERENCES trip_participants,
  PRIMARY KEY (booking_id, participant_id)
);

-- Append-only record of every hold / book / change / cancel, whether it came from a person or from the partner. No personal data in `detail`.
CREATE TABLE IF NOT EXISTS travel_booking_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES travel_bookings,
  actor      text NOT NULL CHECK (actor IN ('user','partner','system')),
  actor_id   uuid REFERENCES users,
  action     text NOT NULL CHECK (action IN ('held','booked','changed','cancelled','failed','synced')),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS travel_booking_events_booking ON travel_booking_events (booking_id, created_at);
DROP TRIGGER IF EXISTS travel_booking_events_append_only ON travel_booking_events;
CREATE TRIGGER travel_booking_events_append_only BEFORE UPDATE OR DELETE ON travel_booking_events FOR EACH ROW EXECUTE FUNCTION trip_history_guard();

-- Widen (never narrow) the existing allowed values.
DO $$ DECLARE n text; t text; BEGIN
  FOREACH t IN ARRAY ARRAY['trip_segments','trip_stays'] LOOP
    FOR n IN SELECT conname FROM pg_constraint WHERE conrelid=t::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%reference_source%' LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, n);
    END LOOP;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (reference_source IN (''external'',''supplier_order'',''partner'',''room_block''))', t, t || '_reference_source_check');
  END LOOP;
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid='trip_changes'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%entity%' LOOP
    EXECUTE format('ALTER TABLE trip_changes DROP CONSTRAINT %I', n);
  END LOOP;
  ALTER TABLE trip_changes ADD CONSTRAINT trip_changes_entity_check CHECK (entity IN ('trip','event_link','participant','segment','stay','room','gear','consent','document','incident','money','supplier_link','note','travel_booking','room_block'));
END $$;
