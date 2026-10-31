-- Coach-published group classes (issue #656). Additive only: new tables, two constraints widened, no existing row is touched or removed.
-- A class is one dated occurrence of a coach's `group` rate card with a shared seat inventory. It is NOT an academy session
-- (those belong to an organisation cohort and are enrolled, not joined) and NOT a coach_hire (one booker, one headcount).
-- Seats are rows in coach_class_seats; every seat change runs under a row lock on the class so capacity can never be oversold.
CREATE TABLE IF NOT EXISTS coach_classes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id         uuid NOT NULL REFERENCES users,
  rate_card_id     uuid NOT NULL REFERENCES coach_rate_cards,
  sport_id         uuid NOT NULL REFERENCES sports,
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  starts_at        timestamptz NOT NULL,
  duration_min     int NOT NULL CHECK (duration_min BETWEEN 15 AND 1440),
  delivery         text NOT NULL DEFAULT 'in_person' CHECK (delivery IN ('in_person','online')),
  venue_id         uuid REFERENCES venues,
  location         text CHECK (length(location) <= 200),
  online_link_enc  text,                                  -- encrypted; only people holding a confirmed seat can read it
  min_participants int NOT NULL DEFAULT 1 CHECK (min_participants >= 1),
  max_participants int NOT NULL CHECK (max_participants >= 1),
  cutoff_at        timestamptz NOT NULL,                  -- if fewer than min_participants hold a seat by then, the class is cancelled and refunded
  price_cents      bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),   -- per seat, snapshotted from the rate card
  currency         text NOT NULL,
  audience         text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','adults','youth')),
  min_age          int CHECK (min_age IS NULL OR min_age BETWEEN 0 AND 120),
  max_age          int CHECK (max_age IS NULL OR max_age BETWEEN 0 AND 120),
  notes            text CHECK (length(notes) <= 1000),
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','completed')),
  cancelled_reason text CHECK (length(cancelled_reason) <= 200),
  cancelled_by     text CHECK (cancelled_by IN ('coach','min_not_met','admin')),
  series_id        uuid,
  row_version      int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (min_participants <= max_participants),
  CHECK (cutoff_at <= starts_at),
  CHECK (delivery = 'online' OR venue_id IS NOT NULL OR location IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS coach_classes_coach ON coach_classes (coach_id, starts_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS coach_classes_discover ON coach_classes (sport_id, starts_at) WHERE status = 'scheduled';
-- republishing the same slot twice (a retry, a re-run series) can never create a second live class
CREATE UNIQUE INDEX IF NOT EXISTS coach_classes_live_slot ON coach_classes (coach_id, starts_at) WHERE status <> 'cancelled';

-- status: guardian_pending (a young person asked; a guardian decides) -> waitlisted (class full, ordered by queued_at) ->
--         held (a seat is reserved until pay_by) -> confirmed (paid, or free) -> cancelled | expired | removed.
--         held and confirmed take a seat. Nothing is ever deleted: a seat that ends keeps its row and its history.
CREATE TABLE IF NOT EXISTS coach_class_seats (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id         uuid NOT NULL REFERENCES coach_classes,
  user_id          uuid NOT NULL REFERENCES users,
  applied_by       uuid REFERENCES users,                 -- the guardian who joined on a young person's behalf
  status           text NOT NULL CHECK (status IN ('guardian_pending','waitlisted','held','confirmed','cancelled','expired','removed')),
  payment_status   text NOT NULL DEFAULT 'not_required' CHECK (payment_status IN ('not_required','unpaid','paid','refund_due','refunded')),
  price_cents      bigint NOT NULL DEFAULT 0,
  pay_by           timestamptz,                           -- the payment window of a held seat
  queued_at        timestamptz NOT NULL DEFAULT now(),    -- waitlist order; reset only when the person rejoins
  attendance       text CHECK (attendance IN ('attended','no_show')),
  attendance_by    uuid REFERENCES users,
  late_cancel      boolean NOT NULL DEFAULT false,
  idempotency_key  text,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS coach_class_seats_user ON coach_class_seats (user_id, status);
CREATE INDEX IF NOT EXISTS coach_class_seats_queue ON coach_class_seats (class_id, queued_at, id) WHERE status = 'waitlisted';
CREATE INDEX IF NOT EXISTS coach_class_seats_pay_by ON coach_class_seats (pay_by) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS coach_class_seats_refunds ON coach_class_seats (class_id) WHERE payment_status = 'refund_due';

-- A seat is payable through the canonical payments flow (the constraint is widened, never narrowed).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('coach_class_seat' IN d) = 0 THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''coach_class_seat''::text])');
  END IF;
END $$;

-- A class holds its court through the canonical session -> booking link, the same one hires and academy sessions use.
DO $$ DECLARE n text; BEGIN
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid = 'session_venue_links'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%session_type%' LOOP
    EXECUTE format('ALTER TABLE session_venue_links DROP CONSTRAINT %I', n);
  END LOOP;
END $$;
ALTER TABLE session_venue_links ADD CONSTRAINT session_venue_links_session_type_check CHECK (session_type IN ('coach_hire','training_session','academy_session','coach_class'));

-- Performance Studio can open a class as a session source (it references, never copies, the roster and attendance).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'coaching_session_records_source_type_check' AND conrelid = 'coaching_session_records'::regclass;
  IF d IS NOT NULL AND position('coach_class' IN d) = 0 THEN
    ALTER TABLE coaching_session_records DROP CONSTRAINT coaching_session_records_source_type_check;
    EXECUTE 'ALTER TABLE coaching_session_records ADD CONSTRAINT coaching_session_records_source_type_check ' || replace(d, '::text])', '::text, ''coach_class''::text])');
  END IF;
END $$;
