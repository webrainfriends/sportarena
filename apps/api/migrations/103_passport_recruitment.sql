-- Recruitment passport (issue #312). Additive only: new tables and new columns with safe defaults; no existing row changes meaning.
-- Rollback: stop using the new columns/tables (the app ignores them); nothing is dropped. Files live encrypted on disk and are never deleted.
ALTER TABLE passport_links
  ADD COLUMN IF NOT EXISTS show_video boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_references boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_preferences boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_availability boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_academic boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recipient_id uuid REFERENCES users,      -- null = anyone holding the link (as before)
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users,        -- the athlete, or the guardian who arranged it for a young athlete
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS passport_links_recipient ON passport_links (recipient_id) WHERE recipient_id IS NOT NULL;

-- every open of a link (who, when) - recipient-scoped links record the signed-in recipient; bearer links record no identity
CREATE TABLE IF NOT EXISTS passport_link_views (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id   uuid NOT NULL REFERENCES passport_links,
  viewer_id uuid REFERENCES users,
  kind      text NOT NULL DEFAULT 'passport' CHECK (kind IN ('passport','video','academic','export')),
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS passport_link_views_link ON passport_link_views (link_id, at DESC);

-- video: an https link or an uploaded clip; only 'approved' ever leaves the athlete's own screen. A coach who coaches the athlete approves.
CREATE TABLE IF NOT EXISTS passport_videos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  sport_id     uuid REFERENCES sports,
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  link_url     text CHECK (link_url ~ '^https://'),
  file_name    text,
  content_type text,
  size_bytes   int,
  sha256       text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by  uuid REFERENCES users,
  reviewed_at  timestamptz,
  review_note  text CHECK (length(review_note) <= 300),
  version      int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  CHECK (link_url IS NOT NULL OR file_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS passport_videos_user ON passport_videos (user_id, created_at, id) WHERE removed_at IS NULL;

-- coach references: the coach writes it, the athlete approves it before it can be shared
CREATE TABLE IF NOT EXISTS passport_references (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  coach_id     uuid NOT NULL REFERENCES users,
  sport_id     uuid REFERENCES sports,
  body         text NOT NULL CHECK (length(body) BETWEEN 20 AND 1500),
  status       text NOT NULL DEFAULT 'pending_athlete' CHECK (status IN ('pending_athlete','approved','declined')),
  decided_at   timestamptz,
  version      int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS passport_references_user ON passport_references (user_id, created_at, id) WHERE removed_at IS NULL;

-- recruitment preferences (one row per athlete) and availability windows
CREATE TABLE IF NOT EXISTS recruitment_preferences (
  user_id        uuid PRIMARY KEY REFERENCES users,
  sport_slugs    text[] NOT NULL DEFAULT '{}',
  levels         text[] NOT NULL DEFAULT '{}',
  regions        text[] NOT NULL DEFAULT '{}',
  open_to        text[] NOT NULL DEFAULT '{}' CHECK (open_to <@ ARRAY['scholarship','trial','academy','club','college','relocation']),
  open_to_contact boolean NOT NULL DEFAULT false,
  notes          text CHECK (length(notes) <= 500),
  version        int NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recruitment_availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  kind        text NOT NULL CHECK (kind IN ('trial','visit','start')),
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  weekdays    int[] NOT NULL DEFAULT '{}',
  from_time   time,
  to_time     time,
  note        text CHECK (length(note) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  CHECK (to_date >= from_date)
);
CREATE INDEX IF NOT EXISTS recruitment_availability_user ON recruitment_availability (user_id, from_date, id) WHERE removed_at IS NULL;

-- optional academic evidence. Personal data is encrypted; every read by someone other than the owner is audit-logged.
CREATE TABLE IF NOT EXISTS academic_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  kind         text NOT NULL CHECK (kind IN ('transcript','certificate','report','test_score','other')),
  institution  text NOT NULL CHECK (length(institution) BETWEEN 1 AND 120),
  period_from  date,
  period_to    date,
  summary_enc  text,
  file_name    text,
  content_type text,
  size_bytes   int,
  sha256       text,
  provenance   text NOT NULL DEFAULT 'self_reported' CHECK (provenance IN ('self_reported','institution_issued')),
  version      int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS academic_evidence_user ON academic_evidence (user_id, created_at, id) WHERE removed_at IS NULL;

-- a guardian can allow a young athlete's recruitment sharing (widening the allowed list only)
ALTER TABLE youth_consents DROP CONSTRAINT IF EXISTS youth_consents_purpose_check;
ALTER TABLE youth_consents ADD CONSTRAINT youth_consents_purpose_check CHECK (purpose IN ('participation','medical','media','contact','coaching','recruitment_sharing'));

-- duplicate / retry protection: the same entry sent twice is one entry
CREATE UNIQUE INDEX IF NOT EXISTS passport_videos_link_once ON passport_videos (user_id, link_url) WHERE removed_at IS NULL AND link_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS passport_videos_file_once ON passport_videos (user_id, sha256) WHERE removed_at IS NULL AND sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS passport_references_once ON passport_references (user_id, coach_id, md5(body)) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recruitment_availability_once ON recruitment_availability (user_id, kind, from_date, to_date) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academic_evidence_once ON academic_evidence (user_id, kind, institution, coalesce(period_from, date '0001-01-01')) WHERE removed_at IS NULL;
