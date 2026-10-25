-- External calendar sync and availability (issue #331). Additive only: nothing is dropped, rewritten or deleted.
-- Removal is soft (revoked_at / removed_at / archived_at).

-- Edit personal blocks with a stale-version check, and allow travel time as a block kind.
ALTER TABLE athlete_blocks ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE athlete_blocks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE athlete_blocks DROP CONSTRAINT IF EXISTS athlete_blocks_kind_check;
ALTER TABLE athlete_blocks ADD CONSTRAINT athlete_blocks_kind_check CHECK (kind IN ('recovery','gym','rest','other','travel'));

-- A guardian can allow or withdraw calendar sharing for a young person (feeds and imports).
ALTER TABLE youth_consents DROP CONSTRAINT IF EXISTS youth_consents_purpose_check;
ALTER TABLE youth_consents ADD CONSTRAINT youth_consents_purpose_check CHECK (purpose IN ('participation','medical','media','contact','coaching','recruitment','recruitment_sharing','calendar_sharing'));

-- One row per person: home time zone, plus the version that guards availability windows and travel buffers against two devices overwriting each other.
CREATE TABLE IF NOT EXISTS calendar_prefs (
  user_id    uuid PRIMARY KEY REFERENCES users,
  timezone   text NOT NULL DEFAULT 'UTC',
  version    int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Weekly availability windows, wall-clock in their own time zone (so daylight-saving changes keep the same local hours).
CREATE TABLE IF NOT EXISTS availability_windows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  weekday     int NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  from_time   time NOT NULL,
  to_time     time NOT NULL,
  timezone    text NOT NULL,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (to_time > from_time)
);
CREATE INDEX IF NOT EXISTS availability_windows_user ON availability_windows (user_id, weekday) WHERE archived_at IS NULL;

-- Travel time needed before and after each kind of commitment.
CREATE TABLE IF NOT EXISTS travel_buffers (
  user_id    uuid NOT NULL REFERENCES users,
  kind       text NOT NULL CHECK (kind IN ('match','team','event','venue','training','duty')),
  before_min int NOT NULL DEFAULT 0 CHECK (before_min BETWEEN 0 AND 480),
  after_min  int NOT NULL DEFAULT 0 CHECK (after_min BETWEEN 0 AND 480),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

-- Outbound subscription: a private ICS link for Apple, Google or Outlook. Only a hash of the secret is stored (shown once).
CREATE TABLE IF NOT EXISTS calendar_feeds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users,
  created_by      uuid NOT NULL REFERENCES users,
  token_hash      text NOT NULL UNIQUE,
  label           text,
  kinds           text[] NOT NULL,
  detail          text NOT NULL DEFAULT 'busy' CHECK (detail IN ('busy','full')),
  version         int NOT NULL DEFAULT 1,
  revoked_at      timestamptz,
  fetch_count     int NOT NULL DEFAULT 0,
  last_fetched_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_feeds_user ON calendar_feeds (user_id, created_at DESC);

-- Inbound: an ICS address of another calendar. The address often carries a secret, so it is encrypted and never returned.
CREATE TABLE IF NOT EXISTS calendar_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users,
  created_by     uuid NOT NULL REFERENCES users,
  label          text,
  source_host    text NOT NULL,
  url_hash       text NOT NULL,
  url_enc        text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','error')),
  last_error     text,
  last_synced_at timestamptz,
  event_count    int NOT NULL DEFAULT 0,
  version        int NOT NULL DEFAULT 1,
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_imports_unique ON calendar_imports (user_id, url_hash) WHERE removed_at IS NULL;

-- Busy time only: no title, place, attendee or description of the other calendar is kept.
CREATE TABLE IF NOT EXISTS calendar_import_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id  uuid NOT NULL REFERENCES calendar_imports,
  uid_hash   text NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  all_day    boolean NOT NULL DEFAULT false,
  removed_at timestamptz,
  CHECK (ends_at > starts_at),
  UNIQUE (import_id, uid_hash, starts_at)
);
CREATE INDEX IF NOT EXISTS calendar_import_events_time ON calendar_import_events (import_id, starts_at) WHERE removed_at IS NULL;
