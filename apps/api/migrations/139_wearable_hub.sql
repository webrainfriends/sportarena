-- Athlete Performance Integration Hub (#583). Additive only: nothing is dropped, rewritten or cascaded.
-- An athlete connects a wearable/performance provider that their organisation has been authorised to use (integration_access_requests).
-- The athlete owns the consent and can narrow or revoke it at any time; revoking stops sync and keeps what was already imported.

CREATE TABLE IF NOT EXISTS athlete_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  provider_key text NOT NULL,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','paused','error','revoked')),
  metrics_granted text[] NOT NULL DEFAULT '{}',
  token_enc text,
  sync_every_minutes int NOT NULL DEFAULT 360 CHECK (sync_every_minutes BETWEEN 15 AND 10080),
  next_sync_at timestamptz,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  last_summary jsonb,
  consent_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- one live connection per athlete and provider; a revoked one stays as history
CREATE UNIQUE INDEX IF NOT EXISTS athlete_connections_live ON athlete_connections(user_id, provider_key) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS athlete_connections_due ON athlete_connections(next_sync_at) WHERE status IN ('connected','error') AND next_sync_at IS NOT NULL;

-- Canonical, normalised readings. The vendor's own value and unit are kept next to the canonical ones (provenance).
CREATE TABLE IF NOT EXISTS wearable_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL REFERENCES athlete_connections(id),
  provider_key text NOT NULL,
  metric_key text NOT NULL,
  recorded_on date NOT NULL,
  value numeric NOT NULL,
  unit text NOT NULL,
  source_metric text NOT NULL,
  source_value numeric NOT NULL,
  source_unit text,
  mapping_version int NOT NULL,
  quality text[] NOT NULL DEFAULT '{}',
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, metric_key, recorded_on)
);
CREATE INDEX IF NOT EXISTS wearable_metrics_user_day ON wearable_metrics(user_id, metric_key, recorded_on DESC);

-- Transparent alert rules the athlete (or a coach with a live share) can read in plain words. A rule only notifies; it never labels a person.
CREATE TABLE IF NOT EXISTS wearable_alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  metric_key text NOT NULL,
  comparator text NOT NULL CHECK (comparator IN ('above','below')),
  threshold numeric NOT NULL,
  window_days int NOT NULL DEFAULT 1 CHECK (window_days BETWEEN 1 AND 28),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wearable_alert_rules_user ON wearable_alert_rules(user_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS wearable_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES wearable_alert_rules(id),
  user_id uuid NOT NULL REFERENCES users(id),
  recorded_on date NOT NULL,
  observed numeric NOT NULL,
  explanation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, recorded_on)
);

-- Coaches see wearable data only through the athlete's existing wellness share: widen the allowed fields by one ('wearables').
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'wellness_shares'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%body_map%' LOOP
    EXECUTE format('ALTER TABLE wellness_shares DROP CONSTRAINT %I', c);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wellness_shares_fields_ck') THEN
    ALTER TABLE wellness_shares ADD CONSTRAINT wellness_shares_fields_ck CHECK (cardinality(fields) BETWEEN 1 AND 8 AND fields <@ ARRAY['sleep','soreness','mood','hydration','readiness','workload','body_map','wearables']);
  END IF;
END $$;
