-- Study discovery, additive only: nothing is dropped, rewritten or narrowed.
-- * AI-suggested colleges/universities and their courses live in a shared catalogue (study_institutions / study_programmes),
--   clearly marked source='ai' and unverified until the institution lists itself on the platform.
-- * A personal bucket list saves either a platform-listed institution/programme or a catalogue entry.
-- * Ratings and reviews reuse the single reviews table (testimonials); only its allowed subject types are widened.

CREATE TABLE study_institutions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  kind             text NOT NULL DEFAULT 'college' CHECK (kind IN ('university','college','academy','school','institute','other')),
  country          text NOT NULL DEFAULT '',
  city             text,
  about            text,
  website          text,
  admissions_url   text,
  contact_email    text,
  contact_phone    text,
  admissions_process text,
  known_for        text,
  source           text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','manual')),
  verified         boolean NOT NULL DEFAULT false,
  organisation_id  uuid REFERENCES organisations,   -- set when the institution lists itself on the platform
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX study_institutions_name ON study_institutions (lower(btrim(name)), lower(btrim(country)));

CREATE TABLE study_programmes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id   uuid NOT NULL REFERENCES study_institutions,
  title            text NOT NULL,
  kind             text NOT NULL DEFAULT 'course' CHECK (kind IN ('course','certification','diploma','degree','postgraduate','short_course')),
  mode             text CHECK (mode IS NULL OR mode IN ('on_campus','online','hybrid')),
  description      text,
  duration_text    text,
  fee_text         text,
  intake_text      text,
  entry_requirements text,
  how_to_apply     text,
  apply_url        text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX study_programmes_title ON study_programmes (institution_id, lower(btrim(title)));

CREATE TABLE study_programme_sports (
  programme_id uuid NOT NULL REFERENCES study_programmes,
  sport_id     uuid NOT NULL REFERENCES sports,
  PRIMARY KEY (programme_id, sport_id)
);
CREATE INDEX study_programme_sports_sport ON study_programme_sports (sport_id);

-- A finished AI search, reused for 30 days so the same question does not call the model again.
CREATE TABLE study_discoveries (
  key             text PRIMARY KEY,
  region          text,
  sport_slugs     text[] NOT NULL DEFAULT '{}',
  institution_ids uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE study_bucket (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  target_type text NOT NULL CHECK (target_type IN ('institution','programme','study_institution','study_programme')),
  target_id   uuid NOT NULL,
  status      text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved','shortlisted','applying','applied','accepted','not_for_me')),
  note        text,
  target_date date,                                  -- e.g. the application deadline
  removed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX study_bucket_user ON study_bucket (user_id, created_at DESC) WHERE removed_at IS NULL;

ALTER TABLE testimonials DROP CONSTRAINT IF EXISTS testimonials_subject_type_check;
ALTER TABLE testimonials ADD CONSTRAINT testimonials_subject_type_check
  CHECK (subject_type IN ('user','team','event','venue','sponsor','product','institution','programme','study_institution','study_programme'));
