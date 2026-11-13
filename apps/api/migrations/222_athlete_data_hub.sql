-- Athlete Data Hub & Performance Integration Platform (#566). Additive only: nothing is dropped or rewritten.
-- Extends the wearable hub (migration 139) with lab/field assessment sessions, individual measurements,
-- and assessment-only provider registrations. All voiding is soft (voided_at / voided_by), never DELETE.

-- Lab/field test sessions: a single assessment event (e.g. "CMJ battery", "DEXA scan", "1RM test day").
CREATE TABLE IF NOT EXISTS performance_assessments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid        NOT NULL REFERENCES users(id),
  org_id          uuid        REFERENCES organisations(id),
  assessed_on     date        NOT NULL,
  assessment_family text      NOT NULL CHECK (assessment_family IN (
    'strength','jump','sprint','body_composition','fitness','flexibility','neuromuscular','manual'
  )),
  test_protocol   text        NOT NULL,
  provider        text        NOT NULL DEFAULT 'manual' CHECK (provider IN (
    'manual','forcedecks','vald','inbody','brower','smartspeed','catapult_opf','dexa','skinfolds','csv_import'
  )),
  source_ref      text,
  assessor_id     uuid        REFERENCES users(id),
  location_enc    text,
  notes_enc       text,
  provenance      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perf_assessments_athlete ON performance_assessments(athlete_id, assessed_on DESC);
CREATE INDEX IF NOT EXISTS perf_assessments_org     ON performance_assessments(org_id, assessed_on DESC) WHERE org_id IS NOT NULL;

-- Individual metric readings within an assessment. Append-only; void instead of DELETE.
CREATE TABLE IF NOT EXISTS performance_measurements (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id   uuid        NOT NULL REFERENCES performance_assessments(id),
  athlete_id      uuid        NOT NULL REFERENCES users(id),
  metric_key      text        NOT NULL,
  value           numeric     NOT NULL,
  unit            text        NOT NULL,
  original_value  numeric,
  original_unit   text,
  quality         text[]      NOT NULL DEFAULT '{}',
  voided_at       timestamptz,
  voided_by       uuid        REFERENCES users(id),
  void_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perf_meas_athlete_metric ON performance_measurements(athlete_id, metric_key, created_at DESC) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS perf_meas_assessment     ON performance_measurements(assessment_id);

-- Assessment-only provider registrations (wearable providers tracked in athlete_connections).
CREATE TABLE IF NOT EXISTS hub_data_sources (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id          uuid        NOT NULL REFERENCES users(id),
  org_id              uuid        REFERENCES organisations(id),
  provider            text        NOT NULL,
  display_name        text        NOT NULL,
  status              text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  last_import_at      timestamptz,
  last_import_summary jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (athlete_id, org_id, provider)
);
CREATE INDEX IF NOT EXISTS hub_sources_athlete ON hub_data_sources(athlete_id) WHERE status <> 'archived';

-- Extend wellness_shares fields to allow 'assessments' and 'fitness_tests' (10 max instead of 8).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'wellness_shares'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%wearables%'
  LOOP
    EXECUTE format('ALTER TABLE wellness_shares DROP CONSTRAINT %I', c);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wellness_shares_fields_ck2') THEN
    ALTER TABLE wellness_shares ADD CONSTRAINT wellness_shares_fields_ck2
      CHECK (cardinality(fields) BETWEEN 1 AND 10
        AND fields <@ ARRAY['sleep','soreness','mood','hydration','readiness','workload',
                            'body_map','wearables','assessments','fitness_tests']);
  END IF;
END $$;
