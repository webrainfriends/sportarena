-- PS-17: Para-athlete doctor consultations and sport-specific clinical coordination.
-- Additive only: no drops, no truncates, no data changes to existing tables.

-- Para-sport consultation templates: declared by the doctor per sport context, not per athlete diagnosis.
CREATE TABLE IF NOT EXISTS para_consult_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES users(id),
  sport           TEXT NOT NULL,
  name_enc        TEXT NOT NULL,
  description_enc TEXT,
  fields_json     JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','archived')),
  use_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nonclinical support summaries: doctor-prepared, athlete-consented, revocable per person.
-- Content is nonclinical operational information only (access needs, emergency contacts).
-- Never contains diagnosis, medication, test results or classification status.
CREATE TABLE IF NOT EXISTS para_support_summaries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id           UUID NOT NULL REFERENCES users(id),
  author_id            UUID NOT NULL REFERENCES users(id),
  audience_label       TEXT NOT NULL,
  content_enc          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending_consent'
                         CHECK (status IN ('pending_consent','active','revoked')),
  athlete_consented_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-person revocable access grants on a support summary.
CREATE TABLE IF NOT EXISTS para_support_summary_access (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_id  UUID NOT NULL REFERENCES para_support_summaries(id) ON DELETE CASCADE,
  grantee_id  UUID NOT NULL REFERENCES users(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  UNIQUE (summary_id, grantee_id)
);

-- Para-doctor episode: links a consultation to an athlete, sport and optional template / appointment.
CREATE TABLE IF NOT EXISTS para_doctor_episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  UUID REFERENCES appointments(id),
  athlete_id      UUID NOT NULL REFERENCES users(id),
  doctor_id       UUID NOT NULL REFERENCES users(id),
  sport           TEXT NOT NULL,
  template_id     UUID REFERENCES para_consult_templates(id),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','complete','archived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pct_provider ON para_consult_templates(provider_id);
CREATE INDEX IF NOT EXISTS idx_pss_athlete  ON para_support_summaries(athlete_id);
CREATE INDEX IF NOT EXISTS idx_pss_author   ON para_support_summaries(author_id);
CREATE INDEX IF NOT EXISTS idx_pssa_summary ON para_support_summary_access(summary_id);
CREATE INDEX IF NOT EXISTS idx_pde_athlete  ON para_doctor_episodes(athlete_id);
CREATE INDEX IF NOT EXISTS idx_pde_doctor   ON para_doctor_episodes(doctor_id);
