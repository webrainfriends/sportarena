-- Sponsorship programs and funding rounds (#284). Purely additive and backwards-compatible: a sponsor brand can run a program
-- (budget, eligibility, caps) with one-off or recurring rounds; applicants apply to an open round and an award becomes an
-- ordinary sponsorship, so agreements, obligations and payments stay in their existing tables. Nothing is dropped, rewritten
-- or deleted; no ON DELETE CASCADE; programs are archived, never deleted. Rollback = deploy the previous code (the new
-- tables and nullable columns are simply unused).

CREATE TABLE IF NOT EXISTS sponsorship_programs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id    uuid NOT NULL REFERENCES sponsors,
  owner_id      uuid NOT NULL REFERENCES users,
  created_by    uuid NOT NULL REFERENCES users,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  objective     text CHECK (objective IS NULL OR length(objective) <= 2000),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','archived')),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  budget_cents  bigint NOT NULL CHECK (budget_cents >= 0),
  sports        text[] NOT NULL DEFAULT '{}',   -- sport slugs; empty = any sport
  regions       text[] NOT NULL DEFAULT '{}',   -- free text (city/state/country); empty = anywhere
  eligibility   jsonb  NOT NULL DEFAULT '{}',   -- { target_types: [...], verified_only: bool, notes }
  starts_on     date,
  ends_on       date,
  max_award_cents bigint CHECK (max_award_cents IS NULL OR max_award_cents > 0),
  max_awards    int CHECK (max_awards IS NULL OR max_awards > 0),
  recurrence    jsonb,                          -- { cadence: monthly|quarterly|yearly, open_days: n } or null
  row_version   int NOT NULL DEFAULT 1,
  published_at  timestamptz,
  closed_at     timestamptz,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CHECK (max_award_cents IS NULL OR max_award_cents <= budget_cents OR budget_cents = 0)
);
CREATE INDEX IF NOT EXISTS sponsorship_programs_sponsor ON sponsorship_programs (sponsor_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS sponsorship_programs_open ON sponsorship_programs (status, created_at DESC, id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS sponsorship_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid NOT NULL REFERENCES sponsorship_programs,
  seq           int  NOT NULL CHECK (seq > 0),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),  -- scheduled vs open is derived from the dates
  opens_on      date NOT NULL,
  closes_on     date NOT NULL,
  budget_cents  bigint CHECK (budget_cents IS NULL OR budget_cents >= 0),  -- null = limited only by the program budget
  max_awards    int CHECK (max_awards IS NULL OR max_awards > 0),
  terms_version int NOT NULL DEFAULT 1,
  row_version   int NOT NULL DEFAULT 1,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, seq),
  CHECK (closes_on >= opens_on)
);

-- Append-only: every version of a round's terms, so an application can always be shown against the terms it was made under.
CREATE TABLE IF NOT EXISTS sponsorship_round_terms (
  round_id   uuid NOT NULL REFERENCES sponsorship_rounds,
  version    int  NOT NULL,
  snapshot   jsonb NOT NULL,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, version)
);

CREATE TABLE IF NOT EXISTS sponsorship_applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         uuid NOT NULL REFERENCES sponsorship_programs,
  round_id           uuid NOT NULL REFERENCES sponsorship_rounds,
  round_terms_version int NOT NULL,
  terms_snapshot     jsonb NOT NULL,            -- program + round terms copied at submit; later edits never rewrite it
  applicant_id       uuid NOT NULL REFERENCES users,
  target_type        text NOT NULL CHECK (target_type IN ('event','team','athlete')),
  target_id          uuid NOT NULL,
  requested_cents    bigint NOT NULL CHECK (requested_cents > 0),
  currency           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  pitch              text CHECK (pitch IS NULL OR length(pitch) <= 2000),
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','awarded','declined','withdrawn')),
  awarded_cents      bigint CHECK (awarded_cents IS NULL OR awarded_cents > 0),
  decided_by         uuid REFERENCES users,
  decided_at         timestamptz,
  decision_reason    text,
  sponsorship_id     uuid REFERENCES sponsorships,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'awarded' OR (awarded_cents IS NOT NULL AND awarded_cents <= requested_cents AND sponsorship_id IS NOT NULL))
);
-- one live application per round and target
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_applications_live ON sponsorship_applications (round_id, target_type, target_id) WHERE status IN ('submitted','awarded');
CREATE INDEX IF NOT EXISTS sponsorship_applications_round ON sponsorship_applications (round_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS sponsorship_applications_applicant ON sponsorship_applications (applicant_id, created_at DESC, id);

-- Awards (and later agreements) reference their originating program, round and application. Existing deals stay null.
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES sponsorship_programs;
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS round_id uuid REFERENCES sponsorship_rounds;
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES sponsorship_applications;
CREATE INDEX IF NOT EXISTS sponsorships_program ON sponsorships (program_id) WHERE program_id IS NOT NULL;
