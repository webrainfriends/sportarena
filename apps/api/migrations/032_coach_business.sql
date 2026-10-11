-- Coach business tools: specialisations, rate cards for individuals / groups / teams / events, contracts & commitments
-- with a delivery log, review pinning and nudges. Additive and idempotent: nothing is dropped, rewritten or narrowed.

CREATE TABLE IF NOT EXISTS coach_specialisations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id      uuid NOT NULL REFERENCES users,
  sport_id      uuid NOT NULL REFERENCES sports,
  name          text NOT NULL,
  levels        text[] NOT NULL DEFAULT '{}',          -- levels served: beginner, amateur, semi_pro, pro
  years         int CHECK (years IS NULL OR years BETWEEN 0 AND 80),
  certification text,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_specialisations_coach ON coach_specialisations (coach_id) WHERE archived_at IS NULL;

-- A price for one kind of work. A retired card is archived (kept, so old sessions still point at it).
CREATE TABLE IF NOT EXISTS coach_rate_cards (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id          uuid NOT NULL REFERENCES users,
  sport_id          uuid REFERENCES sports,
  specialisation_id uuid REFERENCES coach_specialisations,
  title             text NOT NULL,
  audience          text NOT NULL DEFAULT 'individual' CHECK (audience IN ('individual','group','team','event')),
  delivery          text NOT NULL DEFAULT 'in_person' CHECK (delivery IN ('in_person','online','both')),
  unit              text NOT NULL DEFAULT 'hour' CHECK (unit IN ('hour','session','day','month','package')),
  price_cents       bigint NOT NULL CHECK (price_cents >= 0),
  per_person        boolean NOT NULL DEFAULT false,     -- price is multiplied by the number of participants
  duration_min      int CHECK (duration_min IS NULL OR duration_min BETWEEN 15 AND 1440),
  min_participants  int NOT NULL DEFAULT 1 CHECK (min_participants >= 1),
  max_participants  int CHECK (max_participants IS NULL OR max_participants >= 1),
  sessions_included int CHECK (sessions_included IS NULL OR sessions_included >= 1),
  is_intro          boolean NOT NULL DEFAULT false,     -- a trial / introductory offer, shown as such
  description       text,
  active            boolean NOT NULL DEFAULT true,
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_rate_cards_coach ON coach_rate_cards (coach_id) WHERE archived_at IS NULL;

ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS tagline text,
  ADD COLUMN IF NOT EXISTS intro_video_url text,
  ADD COLUMN IF NOT EXISTS serves text[] NOT NULL DEFAULT '{individual}',
  ADD COLUMN IF NOT EXISTS travel_km int CHECK (travel_km IS NULL OR travel_km BETWEEN 0 AND 1000);

-- Who a session or request is for.
ALTER TABLE coach_hires
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'individual' CHECK (audience IN ('individual','group','team','event')),
  ADD COLUMN IF NOT EXISTS participants int NOT NULL DEFAULT 1 CHECK (participants >= 1),
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams,
  ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES events,
  ADD COLUMN IF NOT EXISTS rate_card_id uuid REFERENCES coach_rate_cards,
  ADD COLUMN IF NOT EXISTS review_requested_at timestamptz;
ALTER TABLE coach_requests
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'individual' CHECK (audience IN ('individual','group','team','event')),
  ADD COLUMN IF NOT EXISTS participants int NOT NULL DEFAULT 1 CHECK (participants >= 1),
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams,
  ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES events;
-- an answer can quote a rate card; for non-hourly cards the total is fixed
ALTER TABLE coach_request_responses
  ADD COLUMN IF NOT EXISTS rate_card_id uuid REFERENCES coach_rate_cards,
  ADD COLUMN IF NOT EXISTS total_cents bigint CHECK (total_cents IS NULL OR total_cents >= 0);
ALTER TABLE coach_reviews ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;

-- Contracts and commitments: recurring or dated work that fills the coach's schedule (a team season, an academy
-- retainer, an event engagement, a private block). Occurrences are computed from the pattern; what actually
-- happened is recorded in the log, so history is never rewritten.
CREATE TABLE IF NOT EXISTS coach_commitments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id       uuid NOT NULL REFERENCES users,
  kind           text NOT NULL CHECK (kind IN ('contract','retainer','team','event','personal','block')),
  title          text NOT NULL,
  sport_id       uuid REFERENCES sports,
  client_user_id uuid REFERENCES users,
  team_id        uuid REFERENCES teams,
  event_id       uuid REFERENCES events,
  client_name    text,                               -- an academy, school or club outside the platform
  rate_card_id   uuid REFERENCES coach_rate_cards,
  fee_cents      bigint CHECK (fee_cents IS NULL OR fee_cents >= 0),
  fee_unit       text CHECK (fee_unit IN ('session','month','total')),
  starts_on      date NOT NULL,
  ends_on        date,
  weekdays       int[] NOT NULL DEFAULT '{}',
  start_min      int NOT NULL DEFAULT 0 CHECK (start_min BETWEEN 0 AND 1439),
  duration_min   int NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 15 AND 1440),
  timezone       text NOT NULL DEFAULT 'UTC',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended','cancelled')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS coach_commitments_coach ON coach_commitments (coach_id, status);

CREATE TABLE IF NOT EXISTS coach_commitment_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id uuid NOT NULL REFERENCES coach_commitments,
  on_date       date NOT NULL,
  status        text NOT NULL CHECK (status IN ('delivered','skipped','cancelled')),
  note          text,
  logged_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commitment_id, on_date)
);

-- A coach request is also published as a Community post (kind 'wanted') so coaches find it in the feed; the post points back at the request.
ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS coach_request_id uuid REFERENCES coach_requests;
CREATE UNIQUE INDEX IF NOT EXISTS market_posts_coach_request ON market_posts (coach_request_id) WHERE coach_request_id IS NOT NULL;
-- requests posted before this change get their Community post too
INSERT INTO market_posts(author_id, kind, title, body, sport_id, city, positions, cta_label, visibility, coach_request_id)
SELECT r.athlete_id, 'wanted', 'Coach wanted: ' || r.title,
       concat_ws(E'\n', r.goal, concat_ws(' · ', initcap(r.audience), CASE WHEN r.sessions_per_week IS NOT NULL THEN r.sessions_per_week || '×/week' END)),
       r.sport_id, r.city, 1, 'Answer as coach', 'public', r.id
  FROM coach_requests r
 WHERE r.status = 'open' AND NOT EXISTS (SELECT 1 FROM market_posts p WHERE p.coach_request_id = r.id);
