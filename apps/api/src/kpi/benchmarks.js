// Platform competitive benchmark KPIs. Ten platform-wide metrics that map directly to our
// competitive positioning against Playo, GotSport, Hudle, TeamSnap, RAMP, PlayAtomic and play.book.
// Every query reads live from canonical tables; a missing table returns { value: null, sample_size: 0 }.
// mustBePlatformAdmin is enforced by the capability layer, not here.
import { many, one } from '../db.js';

export const BENCHMARK_DEFS = [
  {
    key: 'booking_conversion',
    label: 'Search-to-confirmed-booking conversion',
    unit: 'percent',
    context: 'vs Playo · Booking simplicity',
    why: 'Whether GotMyGame can compete with Playo-style booking simplicity',
    methodology: 'Confirmed bookings (status = confirmed or completed) divided by all booking attempts (bookings created) in the period, expressed as a percentage. Walk-ins and admin-created bookings are included; cancellations count as attempts.',
    default_target: 70, default_warn: 55, default_crit: 40,
    competitors: { playo: 72, gotsport: 60, hudle: 65, teamsnap: null, ramp: null, playatomic: 70, play_book: 68 },
  },
  {
    key: 'bookable_slots_city',
    label: 'Available bookable slots per launch city',
    unit: 'slots',
    context: 'vs Playo · Supply density',
    why: 'Marketplace supply density, not total venue registrations',
    methodology: 'Count of active resources (resource × time-block) that are not taken by a confirmed/pending booking across all active venues, averaged across cities with at least one active venue.',
    default_target: 500, default_warn: 200, default_crit: 100,
    competitors: { playo: 1200, gotsport: null, hudle: 800, teamsnap: null, ramp: null, playatomic: 600, play_book: 700 },
  },
  {
    key: 'booking_payment_success',
    label: 'Booking and payment success rate',
    unit: 'percent',
    context: 'vs all · Commercial reliability',
    why: 'Commercial reliability',
    methodology: 'Payments with status = paid divided by all payment attempts linked to bookings in the period, expressed as a percentage.',
    default_target: 92, default_warn: 85, default_crit: 75,
    competitors: { playo: 94, gotsport: 91, hudle: 90, teamsnap: 93, ramp: 92, playatomic: 93, play_book: 91 },
  },
  {
    key: 'repeat_bookings_30d',
    label: 'Repeat bookings within 30 days',
    unit: 'percent',
    context: 'vs Hudle · Consumer retention',
    why: 'Consumer retention',
    methodology: 'Percentage of users who made at least one booking in the period and also made another booking within 30 days of their first booking in that period.',
    default_target: 45, default_warn: 30, default_crit: 20,
    competitors: { playo: 48, gotsport: 30, hudle: 44, teamsnap: 35, ramp: 28, playatomic: 42, play_book: 40 },
  },
  {
    key: 'venue_onboard_days',
    label: 'Time to onboard and activate a venue',
    unit: 'days',
    context: 'vs RAMP · B2B scalability',
    why: 'B2B scalability',
    methodology: 'Median days from venue created_at to their first confirmed booking. Venues created in the period that have no booking yet are excluded from the median (not yet activated).',
    default_target: 7, default_warn: 14, default_crit: 30,
    competitors: { playo: 5, gotsport: 10, hudle: 8, teamsnap: 7, ramp: 14, playatomic: 6, play_book: 9 },
  },
  {
    key: 'org_registration_completion',
    label: 'Club / academy registration completion rate',
    unit: 'percent',
    context: 'vs TeamSnap · Admin usability',
    why: 'Parent and administrator usability',
    methodology: 'Organisations that reached approval_status = approved or active, divided by all organisations created in the period, expressed as a percentage.',
    default_target: 70, default_warn: 50, default_crit: 35,
    competitors: { playo: null, gotsport: 68, hudle: 60, teamsnap: 75, ramp: 65, playatomic: null, play_book: null },
  },
  {
    key: 'tournament_publish_time',
    label: 'Time to create and publish a tournament',
    unit: 'minutes',
    context: 'vs GotSport · Operational simplicity',
    why: 'Operational simplicity versus GotSport',
    methodology: 'Median minutes from event created_at to published_at for events of kind = tournament that were published in the period.',
    default_target: 20, default_warn: 45, default_crit: 90,
    competitors: { playo: null, gotsport: 35, hudle: null, teamsnap: 25, ramp: 20, playatomic: null, play_book: null },
  },
  {
    key: 'official_payment_rate',
    label: 'Official assignments paid on time',
    unit: 'percent',
    context: 'vs all · Referee lifecycle',
    why: 'Completion of the referee lifecycle',
    methodology: 'Official assignments where payment was made on or before the due date, divided by all assignments with a due date in the period, expressed as a percentage.',
    default_target: 90, default_warn: 75, default_crit: 60,
    competitors: { playo: null, gotsport: 82, hudle: null, teamsnap: 85, ramp: 90, playatomic: null, play_book: null },
  },
  {
    key: 'cross_module_adoption',
    label: 'Cross-module adoption per organisation',
    unit: 'count',
    context: 'vs all · Ecosystem value',
    why: 'Whether the wider ecosystem adds real value',
    methodology: 'Average number of distinct capability domains used per organisation in the period, measured from audit_log entries grouped by organisation_id and action domain (the first segment of the action key).',
    default_target: 5, default_warn: 3, default_crit: 2,
    competitors: { playo: 2, gotsport: 3, hudle: 2, teamsnap: 4, ramp: 3, playatomic: 3, play_book: 2 },
  },
  {
    key: 'support_resolution_hrs',
    label: 'Support resolution time and customer satisfaction',
    unit: 'hours',
    context: 'vs all · Trust & readiness',
    why: 'Trust and operational readiness',
    methodology: 'Median hours from support_cases created_at to resolved_at for cases resolved in the period, plus average satisfaction score (1–5) where provided.',
    default_target: 8, default_warn: 24, default_crit: 72,
    competitors: { playo: 12, gotsport: 10, hudle: 14, teamsnap: 8, ramp: 10, playatomic: 12, play_book: 16 },
  },
];

const defOf = (key) => BENCHMARK_DEFS.find((d) => d.key === key);

async function safeOne(sql, params) {
  try { return await one(sql, params); } catch { return null; }
}
async function safeMany(sql, params) {
  try { return await many(sql, params); } catch { return []; }
}

function isoDate(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }

async function computeSingle(key, from, to) {
  const f = isoDate(from), t = isoDate(to);
  switch (key) {
    case 'booking_conversion': {
      const r = await safeOne(
        `SELECT COUNT(*) FILTER (WHERE status IN ('confirmed','completed')) AS num, COUNT(*) AS den
           FROM bookings WHERE created_at::date BETWEEN $1 AND $2`, [f, t]);
      if (!r || +r.den === 0) return { value: null, sample_size: 0 };
      return { value: Math.round((+r.num / +r.den) * 1000) / 10, sample_size: +r.den };
    }
    case 'bookable_slots_city': {
      const r = await safeOne(
        `SELECT COUNT(rs.id) AS available_slots,
                COUNT(DISTINCT coalesce(v.city, v.country)) AS city_count
           FROM resources rs
           JOIN venues v ON v.id = rs.venue_id
          WHERE v.active = true
            AND NOT EXISTS (
              SELECT 1 FROM bookings b
               WHERE b.resource_id = rs.id
                 AND b.status IN ('confirmed','pending')
                 AND b.starts_at::date BETWEEN $1 AND $2
            )`, [f, t]);
      if (!r) return { value: null, sample_size: 0 };
      const cities = +r.city_count || 1;
      return { value: Math.round(+r.available_slots / cities), sample_size: +r.available_slots };
    }
    case 'booking_payment_success': {
      const r = await safeOne(
        `SELECT COUNT(*) FILTER (WHERE p.status = 'paid') AS num, COUNT(*) AS den
           FROM payments p
          WHERE p.purpose_type = 'venue_booking'
            AND p.created_at::date BETWEEN $1 AND $2`, [f, t]);
      if (!r || +r.den === 0) return { value: null, sample_size: 0 };
      return { value: Math.round((+r.num / +r.den) * 1000) / 10, sample_size: +r.den };
    }
    case 'repeat_bookings_30d': {
      const r = await safeOne(
        `WITH first_book AS (
           SELECT user_id, MIN(created_at) AS first_at
             FROM bookings
            WHERE status IN ('confirmed','completed') AND user_id IS NOT NULL
              AND created_at::date BETWEEN $1 AND $2
            GROUP BY user_id
         )
         SELECT COUNT(DISTINCT fb.user_id) FILTER (WHERE EXISTS (
                  SELECT 1 FROM bookings b2
                   WHERE b2.user_id = fb.user_id
                     AND b2.status IN ('confirmed','completed')
                     AND b2.created_at > fb.first_at
                     AND b2.created_at <= fb.first_at + interval '30 days'
                )) AS repeat_users,
                COUNT(DISTINCT fb.user_id) AS total_users
           FROM first_book fb`, [f, t]);
      if (!r || +r.total_users === 0) return { value: null, sample_size: 0 };
      return { value: Math.round((+r.repeat_users / +r.total_users) * 1000) / 10, sample_size: +r.total_users };
    }
    case 'venue_onboard_days': {
      const r = await safeOne(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY
           EXTRACT(EPOCH FROM (MIN(b.created_at) - v.created_at)) / 86400
         ) AS median_days,
         COUNT(DISTINCT v.id) AS sample_size
           FROM venues v
           JOIN bookings b ON b.venue_id = v.id AND b.status IN ('confirmed','completed')
          WHERE v.created_at::date BETWEEN $1 AND $2 AND b.created_at > v.created_at`, [f, t]);
      if (!r || r.median_days == null) return { value: null, sample_size: 0 };
      return { value: Math.round(+r.median_days * 10) / 10, sample_size: +r.sample_size };
    }
    case 'org_registration_completion': {
      const r = await safeOne(
        `SELECT COUNT(*) FILTER (WHERE approval_status IN ('approved','active')) AS approved,
                COUNT(*) AS total
           FROM organisations WHERE created_at::date BETWEEN $1 AND $2`, [f, t]);
      if (!r || +r.total === 0) return { value: null, sample_size: 0 };
      return { value: Math.round((+r.approved / +r.total) * 1000) / 10, sample_size: +r.total };
    }
    case 'tournament_publish_time': {
      const r = await safeOne(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY
           EXTRACT(EPOCH FROM (published_at - created_at)) / 60
         ) AS median_minutes,
         COUNT(*) AS sample_size
           FROM events
          WHERE kind = 'tournament' AND published_at IS NOT NULL
            AND published_at::date BETWEEN $1 AND $2`, [f, t]);
      if (!r || r.median_minutes == null) return { value: null, sample_size: 0 };
      return { value: Math.round(+r.median_minutes * 10) / 10, sample_size: +r.sample_size };
    }
    case 'official_payment_rate': {
      const r = await safeOne(
        `SELECT COUNT(*) FILTER (WHERE paid_at IS NOT NULL AND paid_at::date <= due_date) AS on_time,
                COUNT(*) AS total
           FROM official_assignments
          WHERE due_date IS NOT NULL AND due_date BETWEEN $1 AND $2`, [f, t]);
      if (!r || +r.total === 0) return { value: null, sample_size: 0 };
      return { value: Math.round((+r.on_time / +r.total) * 1000) / 10, sample_size: +r.total };
    }
    case 'cross_module_adoption': {
      const r = await safeOne(
        `SELECT AVG(domain_count) AS avg_domains, COUNT(*) AS sample_size FROM (
           SELECT organisation_id,
                  COUNT(DISTINCT SPLIT_PART(action, '.', 1)) AS domain_count
             FROM audit_log
            WHERE organisation_id IS NOT NULL AND created_at::date BETWEEN $1 AND $2
            GROUP BY organisation_id
         ) sub`, [f, t]);
      if (!r || r.avg_domains == null) return { value: null, sample_size: 0 };
      return { value: Math.round(+r.avg_domains * 10) / 10, sample_size: +r.sample_size };
    }
    case 'support_resolution_hrs': {
      const r = await safeOne(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY
           EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600
         ) AS median_hours,
         AVG(satisfaction_score) AS avg_satisfaction,
         COUNT(*) AS sample_size
           FROM support_cases
          WHERE resolved_at IS NOT NULL AND resolved_at::date BETWEEN $1 AND $2`, [f, t]);
      if (!r || r.median_hours == null) return { value: null, sample_size: 0 };
      return {
        value: Math.round(+r.median_hours * 10) / 10,
        sample_size: +r.sample_size,
        satisfaction: r.avg_satisfaction != null ? Math.round(+r.avg_satisfaction * 10) / 10 : null,
      };
    }
    default: return { value: null, sample_size: 0 };
  }
}

function kpiStatus(def, cfg, value) {
  if (value == null) return 'no_data';
  const target = cfg?.target_value != null ? +cfg.target_value : def.default_target;
  const warn = cfg?.warn_threshold != null ? +cfg.warn_threshold : def.default_warn;
  const crit = cfg?.crit_threshold != null ? +cfg.crit_threshold : def.default_crit;
  const lowerIsBetter = ['venue_onboard_days', 'tournament_publish_time', 'support_resolution_hrs'].includes(def.key);
  if (lowerIsBetter) {
    if (value <= target) return 'exceeds';
    if (value <= warn) return 'on_track';
    if (value <= crit) return 'at_risk';
    return 'critical';
  }
  if (value >= target) return 'exceeds';
  if (value >= warn) return 'on_track';
  if (value >= crit) return 'at_risk';
  return 'critical';
}

export async function computeAllBenchmarks(from, to) {
  const configs = await safeMany('SELECT * FROM platform_benchmark_configs', []);
  const cfgMap = Object.fromEntries((configs || []).map((c) => [c.kpi_key, c]));
  return Promise.all(
    BENCHMARK_DEFS.map(async (def) => {
      const result = await computeSingle(def.key, from, to);
      const cfg = cfgMap[def.key];
      return {
        kpi_key: def.key,
        label: def.label,
        unit: def.unit,
        context: def.context,
        why: def.why,
        methodology: def.methodology,
        value: result.value,
        sample_size: result.sample_size,
        satisfaction: result.satisfaction ?? null,
        status: kpiStatus(def, cfg, result.value),
        target_value: cfg?.target_value != null ? +cfg.target_value : def.default_target,
        target_unit: cfg?.target_unit ?? def.unit,
        warn_threshold: cfg?.warn_threshold != null ? +cfg.warn_threshold : def.default_warn,
        crit_threshold: cfg?.crit_threshold != null ? +cfg.crit_threshold : def.default_crit,
        competitor_benchmarks: cfg?.competitor_benchmarks ?? def.competitors,
      };
    })
  );
}

export async function benchmarkTrend(key, months = 12) {
  const def = defOf(key);
  if (!def) return [];
  const configs = await safeMany('SELECT * FROM platform_benchmark_configs WHERE kpi_key = $1', [key]);
  const cfg = configs?.[0];
  const rows = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    const result = await computeSingle(key, from, to);
    rows.push({
      month: from.toISOString().slice(0, 7),
      value: result.value,
      sample_size: result.sample_size,
      status: kpiStatus(def, cfg, result.value),
    });
  }
  return rows;
}

export async function benchmarkTrendAll(months = 12) {
  return Object.fromEntries(
    await Promise.all(BENCHMARK_DEFS.map(async (def) => [def.key, await benchmarkTrend(def.key, months)]))
  );
}

export async function benchmarkBreakdown(key, from, to, dimension = 'city') {
  const f = isoDate(from), t = isoDate(to);
  if (dimension === 'city') {
    if (key === 'booking_conversion') {
      const rows = await safeMany(
        `SELECT coalesce(v.city, v.country, 'Unknown') AS dim_key,
                COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed')) AS num,
                COUNT(*) AS den
           FROM bookings b
           JOIN resources rs ON rs.id = b.resource_id
           JOIN venues v ON v.id = rs.venue_id
          WHERE b.created_at::date BETWEEN $1 AND $2
          GROUP BY 1 ORDER BY den DESC LIMIT 20`, [f, t]);
      return (rows || []).map((r) => ({
        dim_key: r.dim_key,
        value: +r.den === 0 ? null : Math.round((+r.num / +r.den) * 1000) / 10,
        sample_size: +r.den,
      }));
    }
    if (key === 'booking_payment_success') {
      const rows = await safeMany(
        `SELECT coalesce(v.city, v.country, 'Unknown') AS dim_key,
                COUNT(*) FILTER (WHERE p.status = 'paid') AS num,
                COUNT(*) AS den
           FROM payments p
           JOIN bookings b ON b.id = p.purpose_id AND p.purpose_type = 'venue_booking'
           JOIN resources rs ON rs.id = b.resource_id
           JOIN venues v ON v.id = rs.venue_id
          WHERE p.created_at::date BETWEEN $1 AND $2
          GROUP BY 1 ORDER BY den DESC LIMIT 20`, [f, t]);
      return (rows || []).map((r) => ({
        dim_key: r.dim_key,
        value: +r.den === 0 ? null : Math.round((+r.num / +r.den) * 1000) / 10,
        sample_size: +r.den,
      }));
    }
    return [];
  }
  if (dimension === 'sport') {
    if (key === 'booking_conversion') {
      const rows = await safeMany(
        `SELECT coalesce(sp.name, 'Unknown') AS dim_key,
                COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed')) AS num,
                COUNT(*) AS den
           FROM bookings b
           JOIN resources rs ON rs.id = b.resource_id
           LEFT JOIN sports sp ON sp.id = rs.sport_id
          WHERE b.created_at::date BETWEEN $1 AND $2
          GROUP BY 1 ORDER BY den DESC LIMIT 20`, [f, t]);
      return (rows || []).map((r) => ({
        dim_key: r.dim_key,
        value: +r.den === 0 ? null : Math.round((+r.num / +r.den) * 1000) / 10,
        sample_size: +r.den,
      }));
    }
    return [];
  }
  return [];
}
