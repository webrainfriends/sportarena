-- Exercise library and individual treatment plans (issue #210, slice 4). Additive only.
-- Exercises and plan versions are immutable once used/published: edits create a new version, nothing is overwritten or deleted.
CREATE TABLE exercises (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE exercise_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id  uuid NOT NULL REFERENCES exercises,
  version      int NOT NULL,
  title        text NOT NULL,
  body_region  text NOT NULL,
  equipment    text[] NOT NULL DEFAULT '{}',
  difficulty   text NOT NULL CHECK (difficulty IN ('beginner','intermediate','advanced')),
  goal         text NOT NULL,
  language     text NOT NULL DEFAULT 'en',
  instructions text NOT NULL,
  precautions  text,
  media_url    text,                                          -- optional instructional clip / image (https)
  media_source text,                                          -- provenance: who made it
  media_licence text,                                         -- licence or "original"; required with media
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exercise_id, version),
  CHECK (media_url IS NULL OR (media_licence IS NOT NULL AND media_source IS NOT NULL))
);
CREATE INDEX exercise_versions_search ON exercise_versions (body_region, goal);

CREATE TABLE treatment_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users,
  patient_id  uuid NOT NULL REFERENCES users,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','discharged')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX treatment_plans_patient ON treatment_plans (patient_id, created_at DESC);
CREATE INDEX treatment_plans_provider ON treatment_plans (provider_id, created_at DESC);

CREATE TABLE treatment_plan_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES treatment_plans,
  version          int NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded')),
  goals_enc        text,                                      -- patient-visible
  patient_instructions_enc text,                              -- patient-visible
  private_notes_enc text,                                     -- provider-only, never returned to the patient
  review_date      date,
  material_change  boolean NOT NULL DEFAULT false,            -- patient must acknowledge
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  published_by     uuid REFERENCES users,
  acknowledged_at  timestamptz,
  UNIQUE (plan_id, version)
);
CREATE UNIQUE INDEX treatment_plan_one_draft ON treatment_plan_versions (plan_id) WHERE status = 'draft';
CREATE UNIQUE INDEX treatment_plan_one_published ON treatment_plan_versions (plan_id) WHERE status = 'published';

CREATE TABLE treatment_plan_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id     uuid NOT NULL REFERENCES treatment_plan_versions,
  position            int NOT NULL,
  phase               int NOT NULL DEFAULT 1 CHECK (phase BETWEEN 1 AND 12),
  exercise_version_id uuid NOT NULL REFERENCES exercise_versions,
  side                text CHECK (side IN ('left','right','both')),
  sets                int CHECK (sets BETWEEN 1 AND 20),
  reps                int CHECK (reps BETWEEN 1 AND 200),
  hold_sec            int CHECK (hold_sec BETWEEN 0 AND 600),
  rest_sec            int CHECK (rest_sec BETWEEN 0 AND 600),
  times_per_week      int CHECK (times_per_week BETWEEN 1 AND 14),
  load_value          numeric CHECK (load_value >= 0),
  load_unit           text CHECK (load_unit IN ('kg','lb','band_level','percent_1rm','bodyweight')),
  tempo               text,
  notes_enc           text,                                   -- patient-visible instruction for this exercise
  stop_instructions_enc text,                                 -- patient-visible: when to stop / call the clinician
  UNIQUE (plan_version_id, position)
);
