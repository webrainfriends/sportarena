-- PS-25 Para-athlete peer mentoring, community discovery, moderated communities
-- Additive migration: adds new tables and extends the communities table.

-- Extend communities with para-sport fields
ALTER TABLE communities ADD COLUMN IF NOT EXISTS para_sports text[] NOT NULL DEFAULT '{}';
ALTER TABLE communities ADD COLUMN IF NOT EXISTS adaptive boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS communities_para_sports_gin ON communities USING GIN(para_sports);
CREATE INDEX IF NOT EXISTS communities_adaptive ON communities(adaptive) WHERE adaptive IS TRUE;

-- Para mentor profiles: sport experience only, never diagnosis/classification
CREATE TABLE IF NOT EXISTS para_mentor_profiles (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid        NOT NULL REFERENCES users(id),
  bio_enc       text,                            -- AES-256-GCM encrypted; max 500 chars; no medical language
  sports        text[]      NOT NULL DEFAULT '{}', -- catalogue sport slugs
  disciplines   text[]      NOT NULL DEFAULT '{}', -- e.g. sprint, field, sitting-volleyball
  peer_years    smallint,                        -- years as para-athlete in those sports
  comm_formats  text[]      NOT NULL DEFAULT '{}', -- video, phone, in_person, async_message, bsl, auslan
  availability  text,                            -- e.g. 'weekends', 'flexible'; free short text ≤100 chars
  languages     text[]      NOT NULL DEFAULT '{}',
  accepting     boolean     NOT NULL DEFAULT true,
  listed        boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (athlete_id)
);
CREATE INDEX IF NOT EXISTS para_mentor_profiles_sports ON para_mentor_profiles USING GIN(sports);
CREATE INDEX IF NOT EXISTS para_mentor_profiles_listed ON para_mentor_profiles(listed) WHERE listed IS TRUE;

-- Para mentorship relationships
CREATE TABLE IF NOT EXISTS para_mentorships (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_id           uuid        NOT NULL REFERENCES users(id),
  mentee_id           uuid        NOT NULL REFERENCES users(id),
  sport_id            uuid        REFERENCES sports(id),
  discipline          text,
  goal_enc            text,                      -- AES-256-GCM; mentee's stated goal; visible only to mentee
  status              text        NOT NULL DEFAULT 'requested'
                                  CHECK (status IN ('requested','accepted','declined','active','completed','ended')),
  mentor_accepted_at  timestamptz,
  mentee_accepted_at  timestamptz,
  start_on            date,
  end_on              date,
  end_reason          text,
  created_by          uuid        REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT para_mentorship_different_parties CHECK (mentor_id <> mentee_id)
);
CREATE INDEX IF NOT EXISTS para_mentorships_mentor ON para_mentorships(mentor_id);
CREATE INDEX IF NOT EXISTS para_mentorships_mentee ON para_mentorships(mentee_id);
CREATE INDEX IF NOT EXISTS para_mentorships_status  ON para_mentorships(status);

-- Sessions scheduled within a mentorship
CREATE TABLE IF NOT EXISTS para_mentorship_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mentorship_id   uuid        NOT NULL REFERENCES para_mentorships(id),
  title_enc       text,
  scheduled_at    timestamptz,
  format          text        CHECK (format IN ('video','phone','in_person','async_message')),
  notes_enc       text,
  status          text        NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN ('scheduled','completed','cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_mentorship_sessions_mentorship ON para_mentorship_sessions(mentorship_id);

-- End-of-mentorship feedback (mutual; each person sees only their own submission)
CREATE TABLE IF NOT EXISTS para_mentorship_feedback (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mentorship_id   uuid        NOT NULL REFERENCES para_mentorships(id),
  from_id         uuid        NOT NULL REFERENCES users(id),
  rating          smallint    CHECK (rating BETWEEN 1 AND 5),
  body_enc        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mentorship_id, from_id)
);
