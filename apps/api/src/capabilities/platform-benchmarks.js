// Platform Competitive Benchmarks — platform-admin only. The 10 KPIs that measure GotMyGame's
// competitive health against Playo, GotSport, Hudle, TeamSnap, RAMP, PlayAtomic and play.book.
// Every endpoint calls mustBePlatformAdmin; the client also guards the entry point.
import { z } from 'zod';
import { cap } from '../registry.js';
import { many } from '../db.js';
import { mustBePlatformAdmin } from '../platform.js';
import { BENCHMARK_DEFS, computeAllBenchmarks, benchmarkTrend, benchmarkTrendAll, benchmarkBreakdown } from '../kpi/benchmarks.js';

const TAG = 'Benchmarks';
const date = z.string().date();
const preset = z.enum(['last_7', 'last_30', 'last_90', 'year_to_date', 'custom']);
const kpiKey = z.enum(/** @type {[string, ...string[]]} */ (BENCHMARK_DEFS.map((d) => d.key)));
const dim = z.enum(['city', 'sport']);

function periodDates(presetVal, from, to) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  switch (presetVal) {
    case 'last_7': return [new Date(+now - 7 * 86400000).toISOString().slice(0, 10), today];
    case 'last_30': return [new Date(+now - 30 * 86400000).toISOString().slice(0, 10), today];
    case 'last_90': return [new Date(+now - 90 * 86400000).toISOString().slice(0, 10), today];
    case 'year_to_date': return [`${now.getFullYear()}-01-01`, today];
    case 'custom': return [from, to];
    default: return [new Date(+now - 30 * 86400000).toISOString().slice(0, 10), today];
  }
}

cap({
  name: 'list_platform_benchmarks', method: 'GET', path: '/admin/benchmarks/summary', tag: TAG,
  summary: 'All 10 platform competitive KPIs computed live for the requested period. Returns each metric\'s current value, status (exceeds/on_track/at_risk/critical/no_data), period-over-period delta, target, thresholds and competitor benchmarks. Platform admin only.',
  input: z.object({ preset: preset.default('last_30'), from: date.optional(), to: date.optional() })
    .refine((i) => i.preset !== 'custom' || (i.from && i.to), 'Give both dates for a custom period'),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const [from, to] = periodDates(i.preset, i.from, i.to);
    const days = Math.round((new Date(to) - new Date(from)) / 86400000);
    const prevTo = new Date(new Date(from) - 86400000).toISOString().slice(0, 10);
    const prevFrom = new Date(new Date(prevTo) - days * 86400000).toISOString().slice(0, 10);
    const [current, previous] = await Promise.all([
      computeAllBenchmarks(from, to),
      computeAllBenchmarks(prevFrom, prevTo),
    ]);
    const prevMap = Object.fromEntries(previous.map((p) => [p.kpi_key, p]));
    return current.map((c) => {
      const prev = prevMap[c.kpi_key];
      const delta = c.value != null && prev?.value != null
        ? Math.round((c.value - prev.value) * 10) / 10
        : null;
      return { ...c, delta, prev_value: prev?.value ?? null, period: { from, to } };
    });
  },
});

cap({
  name: 'get_platform_benchmark_trend', method: 'GET', path: '/admin/benchmarks/trend', tag: TAG,
  summary: 'Monthly trend for the last N months for one KPI key (or all keys if omitted). Returns { month, value, sample_size, status } rows, oldest first. Platform admin only.',
  input: z.object({ key: kpiKey.optional(), months: z.coerce.number().int().min(3).max(36).default(12) }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    if (i.key) return { key: i.key, trend: await benchmarkTrend(i.key, i.months) };
    return benchmarkTrendAll(i.months);
  },
});

cap({
  name: 'list_benchmark_configs', method: 'GET', path: '/admin/benchmarks/config', tag: TAG,
  summary: 'The saved targets, thresholds and competitor benchmarks for every KPI. Rows that have not been configured yet return the system defaults. Platform admin only.',
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    let saved = [];
    try { saved = await many('SELECT * FROM platform_benchmark_configs', []); } catch { /* table may not exist yet in this env */ }
    const cfgMap = Object.fromEntries(saved.map((r) => [r.kpi_key, r]));
    return BENCHMARK_DEFS.map((def) => ({
      kpi_key: def.key,
      label: def.label,
      unit: def.unit,
      target_value: cfgMap[def.key]?.target_value != null ? +cfgMap[def.key].target_value : def.default_target,
      warn_threshold: cfgMap[def.key]?.warn_threshold != null ? +cfgMap[def.key].warn_threshold : def.default_warn,
      crit_threshold: cfgMap[def.key]?.crit_threshold != null ? +cfgMap[def.key].crit_threshold : def.default_crit,
      competitor_benchmarks: cfgMap[def.key]?.competitor_benchmarks ?? def.competitors,
      note: cfgMap[def.key]?.note ?? null,
      is_customised: !!cfgMap[def.key],
    }));
  },
});

cap({
  name: 'update_benchmark_config', method: 'PUT', path: '/admin/benchmarks/config/:key', tag: TAG,
  summary: 'Set or update the target, warning threshold, critical threshold and competitor benchmarks for one KPI. All fields are optional — omitted fields keep their existing or default value. Platform admin only.',
  input: z.object({
    key: kpiKey,
    target_value: z.number().optional(),
    warn_threshold: z.number().optional(),
    crit_threshold: z.number().optional(),
    competitor_benchmarks: z.record(z.string(), z.number().nullable()).optional(),
    note: z.string().max(400).optional(),
  }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const db = await import('../db.js');
    let existing = null;
    try { existing = await db.one('SELECT * FROM platform_benchmark_configs WHERE kpi_key=$1', [i.key]); } catch { /* ok */ }
    const def = BENCHMARK_DEFS.find((d) => d.key === i.key);
    const merged = {
      target_value: i.target_value ?? (existing?.target_value != null ? +existing.target_value : def.default_target),
      warn_threshold: i.warn_threshold ?? (existing?.warn_threshold != null ? +existing.warn_threshold : def.default_warn),
      crit_threshold: i.crit_threshold ?? (existing?.crit_threshold != null ? +existing.crit_threshold : def.default_crit),
      competitor_benchmarks: { ...(existing?.competitor_benchmarks ?? def.competitors), ...(i.competitor_benchmarks ?? {}) },
      note: i.note ?? existing?.note ?? null,
    };
    await db.one(
      `INSERT INTO platform_benchmark_configs
         (kpi_key, target_value, warn_threshold, crit_threshold, competitor_benchmarks, note, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
       ON CONFLICT (kpi_key) DO UPDATE SET
         target_value=$2, warn_threshold=$3, crit_threshold=$4,
         competitor_benchmarks=$5, note=$6, updated_at=now(), updated_by=$7
       RETURNING kpi_key`,
      [i.key, merged.target_value, merged.warn_threshold, merged.crit_threshold,
       JSON.stringify(merged.competitor_benchmarks), merged.note, user.id]
    );
    return { kpi_key: i.key, ...merged };
  },
});

cap({
  name: 'get_benchmark_breakdown', method: 'GET', path: '/admin/benchmarks/breakdown', tag: TAG,
  summary: 'Break down one KPI by city or sport for the requested period. Returns { dim_key, value, sample_size } rows. Platform admin only.',
  input: z.object({
    key: kpiKey,
    preset: preset.default('last_30'), from: date.optional(), to: date.optional(),
    dimension: dim.default('city'),
  }).refine((i) => i.preset !== 'custom' || (i.from && i.to), 'Give both dates for a custom period'),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const [from, to] = periodDates(i.preset, i.from, i.to);
    const rows = await benchmarkBreakdown(i.key, from, to, i.dimension);
    return { key: i.key, dimension: i.dimension, period: { from, to }, rows };
  },
});
