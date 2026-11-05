-- PS-14: Adaptive Academy Enrolment-to-Training Integration.
-- Additive only. No existing data touched. No diagnosis or classification data stored here.

CREATE TABLE IF NOT EXISTS academy_programme_changes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL REFERENCES organisations(id),
  athlete_id        UUID        NOT NULL REFERENCES users(id),
  from_programme_id UUID        NOT NULL REFERENCES academy_programmes(id),
  to_programme_id   UUID        NOT NULL REFERENCES academy_programmes(id),
  reason            TEXT,
  acted_by          UUID        NOT NULL REFERENCES users(id),
  shares_carried    INTEGER     NOT NULL DEFAULT 0,
  shares_revoked    INTEGER     NOT NULL DEFAULT 0,
  shares_prompted   INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_academy_programme_changes_org_athlete ON academy_programme_changes(org_id, athlete_id);

CREATE TABLE IF NOT EXISTS academy_enrolment_inclusion_prompts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL REFERENCES organisations(id),
  enrolment_id      UUID        NOT NULL REFERENCES org_enrolments(id),
  athlete_id        UUID        NOT NULL REFERENCES users(id),
  programme_id      UUID        NOT NULL REFERENCES academy_programmes(id),
  dismissed_at      TIMESTAMPTZ,
  shares_satisfied_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrolment_inclusion_prompts_uniq ON academy_enrolment_inclusion_prompts(enrolment_id);
