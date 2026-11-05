-- PS-09: class-aware para-sport results, rankings and records
-- Additive only — never DROP or TRUNCATE existing data

ALTER TABLE performances
  ADD COLUMN IF NOT EXISTS sport_class              TEXT,
  ADD COLUMN IF NOT EXISTS guide_athlete_id         UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS classification_snapshot  JSONB;

-- null sport_class = non-para (backward-compatible); only para rows are indexed
CREATE INDEX IF NOT EXISTS performances_sport_class_idx
  ON performances(sport_id, sport_class, metric) WHERE sport_class IS NOT NULL;
CREATE INDEX IF NOT EXISTS performances_guide_idx
  ON performances(guide_athlete_id) WHERE guide_athlete_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS para_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id         UUID NOT NULL REFERENCES sports(id),
  discipline       TEXT,
  sport_class      TEXT NOT NULL,
  metric           TEXT NOT NULL,
  unit             TEXT,
  direction        TEXT NOT NULL DEFAULT 'lower',
  record_type      TEXT NOT NULL,
  value            DOUBLE PRECISION NOT NULL,
  holder_user_id   UUID REFERENCES users(id),
  achieved_at      DATE,
  event_id         UUID REFERENCES events(id),
  performance_id   UUID REFERENCES performances(id),
  governing_body   TEXT,
  source_url       TEXT,
  provenance       TEXT NOT NULL DEFAULT 'self_reported',
  status           TEXT NOT NULL DEFAULT 'pending_ratification',
  ratified_at      TIMESTAMPTZ,
  ratified_by      UUID REFERENCES users(id),
  superseded_by_id UUID REFERENCES para_records(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT para_records_type_check
    CHECK (record_type IN ('world','continental','national','personal_best')),
  CONSTRAINT para_records_status_check
    CHECK (status IN ('pending_ratification','current','historic')),
  CONSTRAINT para_records_prov_check
    CHECK (provenance IN ('self_reported','official','governing_body'))
);

CREATE INDEX IF NOT EXISTS para_records_lookup_idx
  ON para_records(sport_id, sport_class, metric, record_type, status);
CREATE INDEX IF NOT EXISTS para_records_holder_idx
  ON para_records(holder_user_id) WHERE holder_user_id IS NOT NULL;
