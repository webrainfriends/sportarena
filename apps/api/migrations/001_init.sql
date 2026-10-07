-- SportArena MVP schema.
-- Convention: columns ending in _enc hold AES-256-GCM ciphertext (see src/crypto.js);
-- columns ending in _idx hold HMAC-SHA256 blind indexes used only for exact-match lookups.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  emoji       text NOT NULL DEFAULT '🏅',
  scoring     text NOT NULL DEFAULT 'points' CHECK (scoring IN ('points','time','distance','goals','sets'))
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text UNIQUE NOT NULL CHECK (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name  text NOT NULL,
  roles         text[] NOT NULL DEFAULT '{athlete}',
  bio           text,
  avatar_emoji  text NOT NULL DEFAULT '😎',
  avatar_color  text NOT NULL DEFAULT '#FF3D81',
  password_hash text NOT NULL,
  -- personal identification (encrypted)
  email_enc       text NOT NULL,
  email_idx       text UNIQUE NOT NULL,
  full_name_enc   text,
  phone_enc       text,
  dob_enc         text,
  national_id_enc text,
  address_enc     text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name        text NOT NULL,
  token_hash  text UNIQUE NOT NULL,
  last_used_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

-- A person's role within a sport (athlete / coach / referee / physio / doctor)
CREATE TABLE sport_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  sport_id    uuid NOT NULL REFERENCES sports,
  role        text NOT NULL CHECK (role IN ('athlete','coach','referee','physio','doctor')),
  level       text NOT NULL DEFAULT 'beginner' CHECK (level IN ('beginner','amateur','semi_pro','pro')),
  position    text,
  license_no_enc text,
  UNIQUE (user_id, sport_id, role)
);

CREATE TABLE teams (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  sport_id  uuid NOT NULL REFERENCES sports,
  owner_id  uuid NOT NULL REFERENCES users,
  emoji     text NOT NULL DEFAULT '🔥',
  color     text NOT NULL DEFAULT '#7C4DFF',
  city      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_members (
  team_id   uuid NOT NULL REFERENCES teams ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'player' CHECK (role IN ('captain','player','coach','manager','physio')),
  jersey_no int,
  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','left')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE venues (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  city      text,
  address   text,
  owner_id  uuid NOT NULL REFERENCES users,
  emoji     text NOT NULL DEFAULT '🏟️',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE resources (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id  uuid NOT NULL REFERENCES venues ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('court','ground','pool','track','room','equipment')),
  name      text NOT NULL,
  sport_id  uuid REFERENCES sports,
  capacity  int NOT NULL DEFAULT 1 CHECK (capacity >= 1),   -- concurrent bookings allowed (units for equipment)
  hourly_rate_cents int NOT NULL DEFAULT 0 CHECK (hourly_rate_cents >= 0),
  active    boolean NOT NULL DEFAULT true
);

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  sport_id    uuid NOT NULL REFERENCES sports,
  organizer_id uuid NOT NULL REFERENCES users,
  kind        text NOT NULL DEFAULT 'tournament' CHECK (kind IN ('tournament','league','friendly','camp','trial')),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','ongoing','completed','cancelled')),
  description text,
  venue_id    uuid REFERENCES venues,
  starts_on   date,
  ends_on     date,
  points_win  int NOT NULL DEFAULT 3,
  points_draw int NOT NULL DEFAULT 1,
  points_loss int NOT NULL DEFAULT 0,
  entry_fee_cents int NOT NULL DEFAULT 0,
  banner_emoji text NOT NULL DEFAULT '🏆',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE event_entries (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  team_id   uuid REFERENCES teams,
  user_id   uuid REFERENCES users,
  status    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((team_id IS NULL) <> (user_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (event_id, team_id, user_id)
);

CREATE TABLE fixtures (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  round     text,
  home_team_id uuid REFERENCES teams,
  away_team_id uuid REFERENCES teams,
  resource_id  uuid REFERENCES resources,
  referee_id   uuid REFERENCES users,
  scheduled_at timestamptz NOT NULL,
  status    text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','completed','cancelled')),
  home_score int,
  away_score int,
  CHECK (home_team_id IS DISTINCT FROM away_team_id)
);

CREATE TABLE bookings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users,
  team_id     uuid REFERENCES teams,
  event_id    uuid REFERENCES events,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  quantity    int NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  status      text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  price_cents int NOT NULL DEFAULT 0,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX bookings_resource_time ON bookings (resource_id, starts_at, ends_at) WHERE status = 'confirmed';

-- Individual performance: scores, points, personal bests
CREATE TABLE performances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  sport_id    uuid NOT NULL REFERENCES sports,
  event_id    uuid REFERENCES events,
  fixture_id  uuid REFERENCES fixtures,
  metric      text NOT NULL,              -- e.g. goals, 100m_time_s, assists
  value       numeric NOT NULL,
  points      numeric NOT NULL DEFAULT 0,
  recorded_by uuid NOT NULL REFERENCES users,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX performances_user ON performances (user_id, sport_id);
CREATE INDEX performances_event ON performances (event_id);

CREATE TABLE awards (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('cup','trophy','medal_gold','medal_silver','medal_bronze','mvp','badge')),
  event_id  uuid REFERENCES events,
  team_id   uuid REFERENCES teams,
  user_id   uuid REFERENCES users,
  note      text,
  awarded_by uuid NOT NULL REFERENCES users,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (team_id IS NOT NULL OR user_id IS NOT NULL)
);

CREATE TABLE sponsors (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id  uuid NOT NULL REFERENCES users,
  name      text NOT NULL,
  industry  text,
  website   text,
  emoji     text NOT NULL DEFAULT '💎',
  contact_name_enc  text,
  contact_email_enc text,
  contact_phone_enc text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sponsorships (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id uuid NOT NULL REFERENCES sponsors ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('event','team','athlete')),
  target_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  in_kind   text,
  status    text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','declined','ended')),
  proposed_by uuid NOT NULL REFERENCES users,
  starts_on date, ends_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supply chain
CREATE TABLE inventory_items (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id  uuid NOT NULL REFERENCES users,
  venue_id  uuid REFERENCES venues,
  name      text NOT NULL,
  category  text NOT NULL DEFAULT 'equipment' CHECK (category IN ('equipment','apparel','nutrition','medical','merch','other')),
  sku       text,
  quantity  int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_level int NOT NULL DEFAULT 0,
  unit_cost_cents int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE supply_orders (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id   uuid NOT NULL REFERENCES inventory_items ON DELETE CASCADE,
  supplier  text NOT NULL,
  quantity  int NOT NULL CHECK (quantity > 0),
  status    text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','shipped','received','cancelled')),
  ordered_by uuid NOT NULL REFERENCES users,
  expected_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz
);

-- Health: physios & doctors. Clinical text is encrypted; access needs athlete consent.
CREATE TABLE appointments (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES users,
  provider_id uuid NOT NULL REFERENCES users,
  starts_at timestamptz NOT NULL,
  duration_min int NOT NULL DEFAULT 30,
  status    text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','completed','cancelled')),
  reason_enc text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE medical_grants (
  athlete_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (athlete_id, provider_id)
);
CREATE TABLE medical_records (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES users,
  provider_id uuid NOT NULL REFERENCES users,
  kind      text NOT NULL CHECK (kind IN ('injury','checkup','clearance','rehab','note')),
  clearance text CHECK (clearance IN ('cleared','restricted','not_cleared')),
  summary_enc text NOT NULL,
  details_enc text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Insurance
CREATE TABLE insurance_plans (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  insurer   text NOT NULL,
  cover_for text NOT NULL CHECK (cover_for IN ('individual','team','event')),
  premium_cents bigint NOT NULL,
  coverage_cents bigint NOT NULL,
  description text,
  emoji     text NOT NULL DEFAULT '🛡️'
);
CREATE TABLE insurance_policies (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id   uuid NOT NULL REFERENCES insurance_plans,
  holder_id uuid NOT NULL REFERENCES users,
  subject_type text NOT NULL CHECK (subject_type IN ('individual','team','event')),
  subject_id uuid NOT NULL,
  policy_no_enc text NOT NULL,
  beneficiary_enc text,
  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  starts_on date NOT NULL DEFAULT current_date,
  ends_on   date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE insurance_claims (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES insurance_policies ON DELETE CASCADE,
  claimant_id uuid NOT NULL REFERENCES users,
  description_enc text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status    text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','approved','rejected','paid')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE testimonials (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users,
  subject_type text NOT NULL CHECK (subject_type IN ('user','team','event','venue','sponsor')),
  subject_id uuid NOT NULL,
  rating    int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (author_id, subject_type, subject_id)
);
CREATE INDEX testimonials_subject ON testimonials (subject_type, subject_id);

-- Every read of decrypted PII / clinical data is logged here (no values stored).
CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  actor_id  uuid,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id uuid,
  at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sports (slug, name, emoji, scoring) VALUES
 ('football','Football','⚽','goals'),('basketball','Basketball','🏀','points'),
 ('cricket','Cricket','🏏','points'),('tennis','Tennis','🎾','sets'),
 ('badminton','Badminton','🏸','sets'),('athletics','Athletics','🏃','time'),
 ('swimming','Swimming','🏊','time'),('volleyball','Volleyball','🏐','sets'),
 ('kabaddi','Kabaddi','🤼','points'),('hockey','Hockey','🏑','goals'),
 ('esports','Esports','🎮','points'),('skateboarding','Skateboarding','🛹','points');
