-- Platform benchmark configuration: targets, thresholds and competitor benchmarks for each of the 10
-- competitive KPIs. Rows are upserted by key; the table starts empty and defaults apply until an admin
-- saves a configuration. Additive only — never drop this table or truncate its rows.
CREATE TABLE IF NOT EXISTS platform_benchmark_configs (
  kpi_key               text        PRIMARY KEY,
  target_value          numeric,
  target_unit           text        CHECK (target_unit IN ('percent','hours','days','count','score','minutes','slots')),
  warn_threshold        numeric,
  crit_threshold        numeric,
  competitor_benchmarks jsonb       NOT NULL DEFAULT '{}',
  note                  text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE platform_benchmark_configs IS
  'Platform-admin-only: target values, alert thresholds and competitor benchmarks for the 10 competitive KPIs.';
