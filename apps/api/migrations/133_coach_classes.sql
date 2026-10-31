-- Coach-published group classes (issue #656). Additive only: a class is one dated occurrence of a coach's `group` rate card with a
-- shared seat inventory. Seats are rows (status changes, nothing is deleted) so attendance, refunds and history stay intact.
-- A held seat counts against capacity until it is paid or its payment window ends, so seats can never be oversold.

CREATE TABLE IF NOT EXISTS coach_classes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id            uuid NOT NULL REFERENCES users,
  rate_card_id        uuid NOT NULL REFERENCES coach_rate_cards,
  sport_id            uuid NOT NULL REFERENCES sports,
  title               text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  starts_at           timestamptz NOT NULL,
  duration_min        int NOT NULL CHECK (duration_min BETWEEN 15 AND 720),
  venue_id            uuid REFERENCES venues,
  online_url          text CHECK (online_url IS NULL OR (online_url ~ '^https://' AND length(online_url) <= 500)),
  min_participants    int NOT NULL DEFAULT 1 CHECK (min_participants >= 1),
  max_participants    int NOT NULL CHECK (max_participants >= 1 AND max_participants <= 500),
  price_cents         bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),   -- one seat, fixed at publish so a later rate-card edit never reprices a sold class
  currency            text NOT NULL DEFAULT 'INR',
  skill_min           text CHECK (skill_min IN ('beginner','amateur','semi_pro','pro')),
  skill_max           text CHECK (skill_max IN ('beginner','amateur','semi_pro','pro')),
  audience            text NOT NULL DEFAULT 'adults' CHECK (audience IN ('adults','all_ages','youth')),
  min_age             int CHECK (min_age BETWEEN 0 AND 120),
  max_age             int CHECK (max_age BETWEEN 0 AND 120),
  visibility          text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','link')),
  cancel_before_hours int NOT NULL DEFAULT 12 CHECK (cancel_before_hours BETWEEN 0 AND 720),      -- a seat given up later than this is not refunded
  min_cutoff_hours    int NOT NULL DEFAULT 12 CHECK (min_cutoff_hours BETWEEN 0 AND 720),         -- under min_participants this long before the start: cancel and refund
  payment_window_min  int NOT NULL DEFAULT 60 CHECK (payment_window_min BETWEEN 5 AND 2880),
  notes               text CHECK (notes IS NULL OR length(notes) <= 500),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled','completed')),
  cancelled_reason    text CHECK (cancelled_reason IS NULL OR length(cancelled_reason) <= 300),
  cancelled_at        timestamptz,
  row_version         int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (min_participants <= max_participants),
  CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CHECK (venue_id IS NOT NULL OR online_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS coach_classes_coach ON coach_classes (coach_id, starts_at);
CREATE INDEX IF NOT EXISTS coach_classes_open ON coach_classes (status, starts_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS coach_classes_sport ON coach_classes (sport_id, starts_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS coach_class_seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id        uuid NOT NULL REFERENCES coach_classes,
  user_id         uuid NOT NULL REFERENCES users,
  applied_by      uuid REFERENCES users,                       -- a guardian taking a seat for a young person
  status          text NOT NULL CHECK (status IN ('guardian_pending','waitlisted','held','confirmed','cancelled','declined')),
  hold_expires_at timestamptz,                                 -- a held seat is released if unpaid by then
  payment_status  text NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none','unpaid','paid','refunded','not_refundable')),
  amount_cents    bigint NOT NULL DEFAULT 0,
  idempotency_key text,
  attendance      text CHECK (attendance IN ('attended','no_show')),
  attendance_by   uuid REFERENCES users,
  late_cancel     boolean NOT NULL DEFAULT false,
  cancelled_at    timestamptz,
  cancelled_by    text CHECK (cancelled_by IN ('member','coach','system')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS coach_class_seats_user ON coach_class_seats (user_id, status);
CREATE INDEX IF NOT EXISTS coach_class_seats_class ON coach_class_seats (class_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS coach_class_seats_idem ON coach_class_seats (class_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- A class's venue booking is linked, never copied, exactly as hires and academy sessions do.
DO $$ DECLARE n text; BEGIN
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid = 'session_venue_links'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%session_type%' LOOP
    EXECUTE format('ALTER TABLE session_venue_links DROP CONSTRAINT %I', n);
  END LOOP;
END $$;
ALTER TABLE session_venue_links ADD CONSTRAINT session_venue_links_session_type_check CHECK (session_type IN ('coach_hire','training_session','academy_session','coach_class'));

-- A seat is paid through canonical payments (the constraint is widened, never narrowed).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('coach_class_seat' IN d) = 0 THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''coach_class_seat''::text])');
  END IF;
END $$;

-- Performance Studio can run a coach class as its source (it references the seats read live, never a copy).
DO $$ DECLARE n text; BEGIN
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid = 'coaching_session_records'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%source_type%' LOOP
    EXECUTE format('ALTER TABLE coaching_session_records DROP CONSTRAINT %I', n);
  END LOOP;
END $$;
ALTER TABLE coaching_session_records ADD CONSTRAINT coaching_session_records_source_type_check CHECK (source_type IN ('training_session','coach_hire','fixture','team_session','academy_session','coach_class'));
