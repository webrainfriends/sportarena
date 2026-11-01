-- Growth, participation & operator analytics (#73). Additive only: new tables, no existing row is changed, nothing is dropped or cascaded.
-- The governed KPIs (kpi/catalogue.js) stay computed live from the canonical tables, so telemetry can never inflate a figure. These tables hold only
--   (1) a person's analytics consent, (2) first-touch acquisition attribution, (3) de-duplicated client telemetry that is reconciled to canonical records,
--   (4) feature-flag experiments with their exposure records.
-- Rollback: every object below is new, so removing it (after exporting if wanted) loses nothing that existed before this migration; the app and API
-- simply stop writing to it. Retention never deletes a row: it removes the person link and the properties (see growth/retention.js).

-- A person's choice about product analytics. No row = not decided = nothing is recorded about them. Young people are never recorded whatever this says.
CREATE TABLE IF NOT EXISTS analytics_consents (
  user_id        uuid PRIMARY KEY REFERENCES users,
  granted        boolean NOT NULL,
  policy_version int  NOT NULL DEFAULT 1,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  changes        int  NOT NULL DEFAULT 1
);

-- First-touch acquisition source, kept apart from the loyalty referral codes (which stay the record of who invited whom).
CREATE TABLE IF NOT EXISTS analytics_attributions (
  user_id     uuid PRIMARY KEY REFERENCES users,
  source      text NOT NULL CHECK (source IN ('search','social','partner','campaign','email','event','other')),
  campaign    text CHECK (campaign IS NULL OR char_length(campaign) <= 60),
  captured_at timestamptz NOT NULL DEFAULT now()
);

-- Telemetry. (event_key, dedupe_key) is unique, so a delivery that is retried or replayed is counted once; the repeat only raises duplicate_count.
-- No free text is stored: properties are validated against the registered event definition (growth/events.js), and an event about a young person,
-- a clinical, health, medical, insurance or legal record is refused before it reaches this table.
CREATE TABLE IF NOT EXISTS analytics_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key       text NOT NULL,
  event_version   int  NOT NULL,
  dedupe_key      text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 8 AND 80),
  user_id         uuid REFERENCES users,            -- removed by retention (de-identification), never the row
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  platform        text NOT NULL DEFAULT 'web' CHECK (platform IN ('web','ios','android','server')),
  entity_type     text,
  entity_id       uuid,
  sport_id        uuid REFERENCES sports,
  properties      jsonb NOT NULL DEFAULT '{}',
  consent_version int  NOT NULL,
  duplicate_count int  NOT NULL DEFAULT 0,
  reconcile_state text NOT NULL DEFAULT 'pending' CHECK (reconcile_state IN ('pending','matched','unmatched','not_applicable')),
  reconciled_at   timestamptz,
  deidentified_at timestamptz,
  UNIQUE (event_key, dedupe_key)
);
CREATE INDEX IF NOT EXISTS analytics_events_time ON analytics_events (occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS analytics_events_pending ON analytics_events (received_at, id) WHERE reconcile_state = 'pending';
CREATE INDEX IF NOT EXISTS analytics_events_user ON analytics_events (user_id, occurred_at) WHERE user_id IS NOT NULL;

-- Feature-flag experiments. A hypothesis, a success metric and the guardrail metrics are required before it can run. Never deleted: it is concluded or archived.
CREATE TABLE IF NOT EXISTS experiments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]{3,40}$'),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  hypothesis      text NOT NULL CHECK (char_length(hypothesis) BETWEEN 10 AND 600),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','stopped','concluded')),
  variants        jsonb NOT NULL,                    -- [{key, weight}] — the first is the control
  success_metric  text NOT NULL,                     -- an outcome from growth/outcomes.js
  guardrails      text[] NOT NULL DEFAULT '{}',
  min_sample      int  NOT NULL DEFAULT 100 CHECK (min_sample BETWEEN 10 AND 100000),
  window_days     int  NOT NULL DEFAULT 14 CHECK (window_days BETWEEN 1 AND 90),
  owner_id        uuid NOT NULL REFERENCES users,
  started_at      timestamptz,
  ended_at        timestamptz,
  conclusion      text CHECK (conclusion IS NULL OR char_length(conclusion) <= 600),
  row_version     int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per (experiment, person): the first exposure and how often it was shown again. Assignment is a pure function of (experiment key, person), so
-- a person never flips variant and a repeated delivery only raises exposure_count.
CREATE TABLE IF NOT EXISTS experiment_exposures (
  experiment_id    uuid NOT NULL REFERENCES experiments,
  user_id          uuid NOT NULL REFERENCES users,
  variant          text NOT NULL,
  first_exposed_at timestamptz NOT NULL DEFAULT now(),
  last_exposed_at  timestamptz NOT NULL DEFAULT now(),
  exposure_count   int NOT NULL DEFAULT 1,
  PRIMARY KEY (experiment_id, user_id)
);
CREATE INDEX IF NOT EXISTS experiment_exposures_user ON experiment_exposures (user_id);
