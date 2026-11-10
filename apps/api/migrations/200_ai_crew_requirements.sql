-- REF-R10: AI-powered crew requirements catalog and deficit alerts
-- Additive only — no drops, no data loss.

-- (a) Governing-body crew catalog (editable by platform admin)
CREATE TABLE IF NOT EXISTS official_crew_catalog (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport           text NOT NULL,
  governing_body  text NOT NULL,
  match_format    text NOT NULL DEFAULT 'standard',
  crew_role       text NOT NULL,
  min_required    int  NOT NULL DEFAULT 1,
  recommended     int  NOT NULL DEFAULT 1,
  notes           text,
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  retired_at      date,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport, governing_body, match_format, crew_role)
);
CREATE INDEX IF NOT EXISTS crew_catalog_sport ON official_crew_catalog(sport) WHERE retired_at IS NULL;

-- (b) Per-event penalty / degradation config (platform admin)
CREATE TABLE IF NOT EXISTS event_crew_deficit_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events(id),
  penalty_type    text NOT NULL CHECK (penalty_type IN ('points_deduction','rank_degradation','void_result','warning_only')),
  penalty_value   numeric(8,2) NOT NULL DEFAULT 0,
  applies_after   int  NOT NULL DEFAULT 1,
  overridden_by   uuid REFERENCES users(id),
  overridden_at   timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id)
);

-- (c) AI suggestion record per fixture
CREATE TABLE IF NOT EXISTS fixture_crew_suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id      uuid NOT NULL REFERENCES fixtures(id),
  suggested_at    timestamptz NOT NULL DEFAULT now(),
  suggested_roles jsonb NOT NULL DEFAULT '[]',
  accepted_by     uuid REFERENCES users(id),
  accepted_at     timestamptz,
  override_note   text
);
CREATE INDEX IF NOT EXISTS crew_suggestions_fixture ON fixture_crew_suggestions(fixture_id);

-- (d) Deficit alert log
CREATE TABLE IF NOT EXISTS crew_deficit_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id      uuid NOT NULL REFERENCES fixtures(id),
  event_id        uuid NOT NULL REFERENCES events(id),
  alerted_user_id uuid NOT NULL REFERENCES users(id),
  alert_type      text NOT NULL CHECK (alert_type IN ('organiser','official')),
  deficit_detail  jsonb NOT NULL DEFAULT '{}',
  sent_at         timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX IF NOT EXISTS crew_alerts_user    ON crew_deficit_alerts(alerted_user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS crew_alerts_fixture ON crew_deficit_alerts(fixture_id);
