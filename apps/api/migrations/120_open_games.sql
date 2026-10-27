-- Find & Join Games (issue #508). Additive only: an open game is an ordinary `games` row plus the marketplace terms below.
-- Nothing here reserves a venue: `booking_id` points at the canonical booking, whose live state is read from `bookings`.

CREATE TABLE IF NOT EXISTS open_games (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id          uuid NOT NULL UNIQUE REFERENCES games,
  host_id          uuid NOT NULL REFERENCES users,
  team_id          uuid REFERENCES teams,                       -- a team looking for players / hosting
  fixture_game_id  uuid REFERENCES games,                       -- "need players" for an existing fixture
  booking_id       uuid REFERENCES bookings,                    -- canonical held/confirmed booking, when a venue is required
  visibility       text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','team','link')),
  approval_mode    text NOT NULL DEFAULT 'host' CHECK (approval_mode IN ('auto','host')),
  min_players      int NOT NULL DEFAULT 2 CHECK (min_players >= 1),
  max_players      int NOT NULL CHECK (max_players >= 1 AND max_players <= 500),
  host_plays       boolean NOT NULL DEFAULT true,
  skill_min        text CHECK (skill_min IN ('beginner','amateur','semi_pro','pro')),
  skill_max        text CHECK (skill_max IN ('beginner','amateur','semi_pro','pro')),
  place_latitude   double precision CHECK (place_latitude BETWEEN -90 AND 90),    -- a public place (park, ground) when there is no venue; never a home
  place_longitude  double precision CHECK (place_longitude BETWEEN -180 AND 180),
  place_city       text CHECK (place_city IS NULL OR length(place_city) <= 80),
  format           text CHECK (format IS NULL OR length(format) <= 40),
  role_needs       text[] NOT NULL DEFAULT '{}',
  audience         text NOT NULL DEFAULT 'adults' CHECK (audience IN ('adults','all_ages','youth')),
  min_age          int CHECK (min_age BETWEEN 0 AND 120),
  max_age          int CHECK (max_age BETWEEN 0 AND 120),
  cost_mode        text NOT NULL DEFAULT 'free' CHECK (cost_mode IN ('free','per_player','split_total')),
  cost_cents       bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  currency         text NOT NULL DEFAULT 'INR',
  cancel_before_hours int NOT NULL DEFAULT 6 CHECK (cancel_before_hours BETWEEN 0 AND 720),
  notes            text CHECK (notes IS NULL OR length(notes) <= 500),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled','completed')),
  cancelled_reason text,
  last_synced_starts_at timestamptz,                            -- last time/venue the participants were told about
  row_version      int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (min_players <= max_players),
  CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age)
);
CREATE INDEX IF NOT EXISTS open_games_status ON open_games (status, visibility);
CREATE INDEX IF NOT EXISTS open_games_host ON open_games (host_id);
CREATE INDEX IF NOT EXISTS open_games_team ON open_games (team_id) WHERE team_id IS NOT NULL;

-- A person's place in a game. The row is kept (status changes) so history, no-show facts and appeals stay intact.
CREATE TABLE IF NOT EXISTS open_game_members (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  open_game_id     uuid NOT NULL REFERENCES open_games,
  user_id          uuid NOT NULL REFERENCES users,
  applied_by       uuid REFERENCES users,                       -- a guardian applying for a young person
  status           text NOT NULL CHECK (status IN ('guardian_pending','requested','waitlisted','confirmed','declined','cancelled','removed')),
  approved         boolean NOT NULL DEFAULT false,              -- host/guardian approval given (a waitlisted person is promoted only when approved)
  position         text CHECK (position IS NULL OR length(position) <= 40),
  message          text CHECK (message IS NULL OR length(message) <= 300),
  idempotency_key  text,
  share_status     text NOT NULL DEFAULT 'none' CHECK (share_status IN ('none','due','settled','waived')),
  share_cents      bigint NOT NULL DEFAULT 0,
  attendance       text CHECK (attendance IN ('attended','no_show')),
  attendance_by    uuid REFERENCES users,
  checked_in_at    timestamptz,
  late_cancel      boolean NOT NULL DEFAULT false,
  cancelled_at     timestamptz,
  full_nudge_sent  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (open_game_id, user_id)
);
CREATE INDEX IF NOT EXISTS open_game_members_user ON open_game_members (user_id, status);
CREATE INDEX IF NOT EXISTS open_game_members_game ON open_game_members (open_game_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS open_game_members_idem ON open_game_members (open_game_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- A person who disagrees with a no-show / late-cancel fact asks for it to be reviewed; a corrected fact stops counting.
CREATE TABLE IF NOT EXISTS open_game_appeals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES open_game_members,
  raised_by   uuid NOT NULL REFERENCES users,
  fact        text NOT NULL CHECK (fact IN ('no_show','late_cancel')),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','corrected','upheld')),
  resolved_by uuid REFERENCES users,
  resolution  text CHECK (resolution IS NULL OR length(resolution) <= 500),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS open_game_appeals_one_open ON open_game_appeals (member_id, fact) WHERE status = 'open';

-- Temporary game conversation: for the host and confirmed players only. Closed (hidden, rows kept) once the chat window ends.
CREATE TABLE IF NOT EXISTS open_game_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  open_game_id uuid NOT NULL REFERENCES open_games,
  sender_id    uuid NOT NULL REFERENCES users,
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS open_game_messages_game ON open_game_messages (open_game_id, created_at DESC);

-- What a person chooses to share for discovery. Off unless they switch it on; no location is stored (distance uses the point the app sends per request).
CREATE TABLE IF NOT EXISTS open_game_prefs (
  user_id     uuid PRIMARY KEY REFERENCES users,
  discoverable boolean NOT NULL DEFAULT false,                  -- may hosts invite me / see me as a suggested player
  updated_at  timestamptz NOT NULL DEFAULT now()
);
