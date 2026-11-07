-- Venue Revenue Intelligence: demand heatmap, pricing recommendations,
-- controlled experiments, utilisation recommendations (additive only).

CREATE TABLE revenue_intel_config (
  venue_id          uuid PRIMARY KEY REFERENCES venues(id),
  automation_mode   text NOT NULL DEFAULT 'manual'
                    CHECK (automation_mode IN ('manual','bounded_auto')),
  min_price_cents   int CHECK (min_price_cents IS NULL OR min_price_cents >= 0),
  max_price_cents   int CHECK (max_price_cents IS NULL OR max_price_cents >= 0),
  max_change_pct    numeric(5,2) NOT NULL DEFAULT 15
                    CHECK (max_change_pct > 0 AND max_change_pct <= 50),
  protected_plan_ids jsonb NOT NULL DEFAULT '[]',
  blackout_periods  jsonb NOT NULL DEFAULT '[]',
  objectives        jsonb NOT NULL DEFAULT '{}',
  updated_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pricing_recommendations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id             uuid NOT NULL REFERENCES venues(id),
  resource_id          uuid REFERENCES resources(id),
  trigger_kind         text NOT NULL
                       CHECK (trigger_kind IN ('low_demand','high_demand','lead_time','last_minute','seasonal','experiment')),
  current_rate_cents   int,
  suggested_rate_cents int NOT NULL CHECK (suggested_rate_cents > 0),
  weekdays             int[],
  start_min            int CHECK (start_min IS NULL OR (start_min >= 0 AND start_min < 1440)),
  end_min              int CHECK (end_min IS NULL OR (end_min > 0 AND end_min <= 1440)),
  valid_from           date,
  valid_to             date,
  reason_json          jsonb NOT NULL DEFAULT '{}',
  expected_effect      jsonb NOT NULL DEFAULT '{}',
  source_period_days   int NOT NULL DEFAULT 28,
  constraints_json     jsonb NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','expired','applied')),
  decided_by           uuid REFERENCES users(id),
  decided_at           timestamptz,
  applied_rule_id      uuid REFERENCES price_rules(id),
  outcome_period_end   date,
  actual_effect        jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pricing_recommendations_venue_status_created
  ON pricing_recommendations(venue_id, status, created_at DESC);
CREATE INDEX pricing_recommendations_resource
  ON pricing_recommendations(resource_id)
  WHERE resource_id IS NOT NULL;

CREATE TABLE pricing_experiments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id              uuid NOT NULL REFERENCES venues(id),
  resource_ids          uuid[] NOT NULL,
  name                  text NOT NULL,
  hypothesis            text,
  control_rate_cents    int NOT NULL CHECK (control_rate_cents > 0),
  experiment_rate_cents int NOT NULL CHECK (experiment_rate_cents > 0),
  eligibility_json      jsonb NOT NULL DEFAULT '{}',
  start_date            date NOT NULL,
  end_date              date NOT NULL CHECK (end_date > start_date),
  primary_metric        text NOT NULL DEFAULT 'utilisation_pct',
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','completed','cancelled')),
  result_json           jsonb,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pricing_experiments_venue_status
  ON pricing_experiments(venue_id, status);

CREATE TABLE utilisation_recommendations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid NOT NULL REFERENCES venues(id),
  resource_id   uuid REFERENCES resources(id),
  kind          text NOT NULL
                CHECK (kind IN ('adjust_hours','repurpose_window','community_game','promotion','waitlist_open','maintenance')),
  priority      text NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('high','medium','low')),
  description   text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '{}',
  action_json   jsonb,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','acted','dismissed')),
  acted_at      timestamptz,
  acted_by      uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX utilisation_recommendations_venue_status_priority
  ON utilisation_recommendations(venue_id, status, priority);
