-- Verified recruiter & scout workspace (issue #313). Additive only: new tables, two widened CHECK lists. Nothing is dropped, rewritten or deleted.
-- Reused, not duplicated: verification_cases (type 'recruiter'), organisations, sport_profiles / athlete_measurements / career_memberships (read live under a grant),
-- youth_consents (new purpose 'recruitment'), audit_log, notifications.

ALTER TABLE verification_cases DROP CONSTRAINT IF EXISTS verification_cases_type_check;
ALTER TABLE verification_cases ADD CONSTRAINT verification_cases_type_check CHECK (type IN ('gamer','coach','physio','doctor','sponsor','event','insurer','lawyer','recruiter'));
ALTER TABLE youth_consents DROP CONSTRAINT IF EXISTS youth_consents_purpose_check;
ALTER TABLE youth_consents ADD CONSTRAINT youth_consents_purpose_check CHECK (purpose IN ('participation','medical','media','contact','coaching','recruitment'));

-- A recruiter's working profile. The verified badge itself lives on verification_cases; this is who they recruit for and where.
CREATE TABLE IF NOT EXISTS recruiter_profiles (
  user_id         uuid PRIMARY KEY REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  org_name        text CHECK (org_name IS NULL OR length(org_name) BETWEEN 2 AND 120),   -- only when the organisation is not on the platform
  sport_ids       uuid[] NOT NULL DEFAULT '{}',
  regions         text[] NOT NULL DEFAULT '{}',
  bio             text CHECK (bio IS NULL OR length(bio) <= 600),
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Scoped, time-limited, revocable permission for one verified recruiter to see parts of one athlete's card in one sport.
-- Access is re-evaluated live on every read, mutation and export (verification, expiry, revocation, youth consent): nothing is cached.
CREATE TABLE IF NOT EXISTS recruiter_access_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id   uuid NOT NULL REFERENCES users,
  athlete_id     uuid NOT NULL REFERENCES users,
  sport_id       uuid NOT NULL REFERENCES sports,
  scopes         text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['profile','measurements','career','contact','messages']::text[]),
  granted_scopes text[] NOT NULL DEFAULT '{}' CHECK (granted_scopes <@ ARRAY['profile','measurements','career','contact','messages']::text[]),
  purpose        text NOT NULL CHECK (purpose IN ('scouting','trial','scholarship','signing')),
  message        text CHECK (message IS NULL OR length(message) <= 500),
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined','withdrawn','revoked','expired')),
  expires_at     timestamptz NOT NULL,            -- end of the access window (a grant may be shorter than asked)
  decided_by     uuid REFERENCES users,           -- the athlete, or the guardian for a young person
  decided_at     timestamptz,
  decision_note  text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  revoked_by     uuid REFERENCES users,
  revoked_at     timestamptz,
  row_version    int NOT NULL DEFAULT 1,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (recruiter_id <> athlete_id)
);
-- one live ask per recruiter + athlete + sport (a double tap or a second tab cannot stack requests)
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_requests_one_open ON recruiter_access_requests (recruiter_id, athlete_id, sport_id) WHERE status IN ('requested','approved');
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_requests_idem ON recruiter_access_requests (recruiter_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS recruiter_requests_athlete ON recruiter_access_requests (athlete_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS recruiter_requests_recruiter ON recruiter_access_requests (recruiter_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS recruiter_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id uuid NOT NULL REFERENCES users,
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  sport_id     uuid REFERENCES sports,
  row_version  int NOT NULL DEFAULT 1,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_lists_name ON recruiter_lists (recruiter_id, lower(name)) WHERE archived_at IS NULL;

-- An athlete saved to a list. Only athletes the recruiter holds (or held) an approved grant for can be saved; the entry survives revocation
-- (so the recruiter keeps their own pipeline) but the athlete's data is redacted from it as soon as the grant stops being live.
CREATE TABLE IF NOT EXISTS recruiter_list_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES recruiter_lists,
  athlete_id  uuid NOT NULL REFERENCES users,
  request_id  uuid NOT NULL REFERENCES recruiter_access_requests,
  stage       text NOT NULL DEFAULT 'prospect' CHECK (stage IN ('prospect','shortlist','contacted','trial','offer','passed')),
  row_version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_entries_one ON recruiter_list_entries (list_id, athlete_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS recruiter_entries_list ON recruiter_list_entries (list_id, created_at, id);

CREATE TABLE IF NOT EXISTS recruiter_entry_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   uuid NOT NULL REFERENCES recruiter_list_entries,
  action     text NOT NULL,
  from_stage text,
  to_stage   text,
  actor_id   uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Recruiter-private evaluations: criteria ratings plus encrypted notes, always labelled with what the judgement was based on.
CREATE TABLE IF NOT EXISTS recruiter_evaluations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES recruiter_list_entries,
  recruiter_id uuid NOT NULL REFERENCES users,
  basis        text NOT NULL CHECK (basis IN ('live_viewing','video','match_report','trial','profile_only')),
  observed_on  date NOT NULL,
  ratings      jsonb NOT NULL DEFAULT '{}',
  overall      smallint NOT NULL CHECK (overall BETWEEN 1 AND 5),
  notes_enc    text,
  row_version  int NOT NULL DEFAULT 1,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_evaluations_idem ON recruiter_evaluations (recruiter_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS recruiter_evaluations_entry ON recruiter_evaluations (entry_id, observed_on DESC, id);
CREATE TABLE IF NOT EXISTS recruiter_evaluation_revisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES recruiter_evaluations,
  row_version   int NOT NULL,
  snapshot      jsonb NOT NULL,
  actor_id      uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Recruitment contact log: what the recruiter did and when to follow up (append-only).
CREATE TABLE IF NOT EXISTS recruiter_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES recruiter_list_entries,
  recruiter_id uuid NOT NULL REFERENCES users,
  kind         text NOT NULL CHECK (kind IN ('call','email','meeting','message','other')),
  contacted_on date NOT NULL,
  summary_enc  text,
  follow_up_on date,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_contacts_idem ON recruiter_contacts (recruiter_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS recruiter_contacts_entry ON recruiter_contacts (entry_id, contacted_on DESC, id);

-- Permission-controlled messaging: one thread per access request. Messages are only sent while the grant (with the `messages` scope) is live;
-- the athlete (or, for a young person, a guardian) can close the thread at any time. Bodies are encrypted.
CREATE TABLE IF NOT EXISTS recruiter_threads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES recruiter_access_requests,
  closed_by  uuid REFERENCES users,
  closed_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recruiter_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES recruiter_threads,
  sender_id   uuid NOT NULL REFERENCES users,
  sender_role text NOT NULL CHECK (sender_role IN ('recruiter','athlete','guardian')),
  body_enc    text NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_messages_idem ON recruiter_messages (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS recruiter_messages_thread ON recruiter_messages (thread_id, created_at, id);
