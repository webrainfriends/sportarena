-- Coach marketplace: a public coach profile with weekly hours, athletes posting what they need and coaches responding,
-- verified reviews tied to completed sessions. Additive and idempotent: nothing is dropped, rewritten or narrowed.

CREATE TABLE IF NOT EXISTS coach_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users,
  headline    text,
  bio         text,
  city        text,
  timezone    text NOT NULL DEFAULT 'UTC',
  delivery    text NOT NULL DEFAULT 'in_person' CHECK (delivery IN ('in_person','online','both')),
  specialties text[] NOT NULL DEFAULT '{}',
  languages   text[] NOT NULL DEFAULT '{}',
  accepting   boolean NOT NULL DEFAULT true,     -- taking new athletes
  listed      boolean NOT NULL DEFAULT true,     -- shown in search
  slot_min    int NOT NULL DEFAULT 60 CHECK (slot_min BETWEEN 15 AND 240),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Weekly opening hours in the coach's own time zone. A replaced window is kept (removed_at), never deleted.
CREATE TABLE IF NOT EXISTS coach_availability (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id   uuid NOT NULL REFERENCES users,
  weekday    int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min  int NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min    int NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_min > start_min)
);
CREATE INDEX IF NOT EXISTS coach_availability_coach ON coach_availability (coach_id) WHERE removed_at IS NULL;

-- An athlete posts what they are looking for; coaches answer with a rate and a first session.
CREATE TABLE IF NOT EXISTS coach_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       uuid NOT NULL REFERENCES users,
  sport_id         uuid NOT NULL REFERENCES sports,
  title            text NOT NULL,
  goal             text,
  level            text CHECK (level IN ('beginner','amateur','semi_pro','pro')),
  delivery         text NOT NULL DEFAULT 'either' CHECK (delivery IN ('in_person','online','either')),
  city             text,
  budget_max_cents bigint CHECK (budget_max_cents IS NULL OR budget_max_cents >= 0),   -- per hour
  sessions_per_week int CHECK (sessions_per_week IS NULL OR sessions_per_week BETWEEN 1 AND 14),
  preferred_days   int[] NOT NULL DEFAULT '{}',
  start_by         date,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','closed')),
  filled_by        uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS coach_requests_open ON coach_requests (sport_id, created_at DESC) WHERE status='open';
CREATE INDEX IF NOT EXISTS coach_requests_athlete ON coach_requests (athlete_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coach_request_responses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid NOT NULL REFERENCES coach_requests,
  coach_id          uuid NOT NULL REFERENCES users,
  rate_cents_hour   bigint NOT NULL CHECK (rate_cents_hour >= 0),
  message           text,
  proposed_starts_at timestamptz NOT NULL,
  duration_min      int NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 15 AND 480),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','withdrawn')),
  hire_id           uuid REFERENCES coach_hires,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  UNIQUE (request_id, coach_id)
);
CREATE INDEX IF NOT EXISTS coach_request_responses_coach ON coach_request_responses (coach_id, created_at DESC);

-- One review per completed session, written by the athlete; the coach may answer once.
CREATE TABLE IF NOT EXISTS coach_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hire_id     uuid NOT NULL UNIQUE REFERENCES coach_hires,
  reviewer_id uuid NOT NULL REFERENCES users,
  coach_id    uuid NOT NULL REFERENCES users,
  rating      int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text,
  reply       text,
  replied_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_reviews_coach ON coach_reviews (coach_id, created_at DESC);

-- A hire that comes from an accepted response is already agreed by the coach: payment confirms it.
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS request_response_id uuid REFERENCES coach_request_responses;
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users;
