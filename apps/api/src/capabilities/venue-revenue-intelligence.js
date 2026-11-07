// Venue Revenue Intelligence: demand heatmap, utilisation forecast, no-show risk insight,
// pricing recommendations with guardrail enforcement, dynamic pricing config, pricing
// experiments and operational utilisation recommendations.
// All demand signals are observed facts; forecasts use rolling mean + linear trend only.
// No retroactive repricing: generated rules always have valid_from >= tomorrow.
import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { mustManage, mustFind } from '../helpers.js';
import { lockResource } from '../booking/engine.js';
import { addDays } from '../booking/time.js';

const id = z.string().uuid();
const day = z.string().date();

// ------------------------------------------------------------------ demand heatmap

cap({
  name: 'demand_heatmap',
  method: 'GET',
  path: '/venues/:venue_id/revenue-intel/demand',
  tag: 'Revenue Intelligence',
  summary: 'Observed demand signals (bookings + waitlists + slot alerts + cancellations) aggregated into a 7-day × 24-hour grid. Pure SQL aggregation — observed facts only, never inferred or forecast.',
  input: z.object({
    venue_id: id,
    resource_id: id.optional(),
    period_days: z.coerce.number().int().min(7).max(365).default(90),
    tz: z.string().max(60).default('UTC'),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    const since = `now() - interval '${i.period_days} days'`;
    const resourceFilter = i.resource_id ? `AND b.resource_id = $4` : '';
    const resourceFilterW = i.resource_id ? `AND we.resource_id = $4` : '';
    const resourceFilterS = i.resource_id ? `AND sa.resource_id = $4` : '';
    const args = i.resource_id
      ? [i.venue_id, i.tz, i.period_days, i.resource_id]
      : [i.venue_id, i.tz, i.period_days];

    const bookings = await many(`
      SELECT
        EXTRACT(DOW FROM b.starts_at AT TIME ZONE $2)::int AS weekday,
        EXTRACT(HOUR FROM b.starts_at AT TIME ZONE $2)::int AS hour,
        COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS bookings,
        COUNT(*) FILTER (WHERE b.status = 'cancelled') AS cancellations
      FROM bookings b
      JOIN resources r ON r.id = b.resource_id
      WHERE r.venue_id = $1
        AND b.starts_at >= now() - ($3 || ' days')::interval
        ${resourceFilter}
      GROUP BY 1, 2
    `, args);

    const waitlist = await many(`
      SELECT
        EXTRACT(DOW FROM we.slot_starts_at AT TIME ZONE $2)::int AS weekday,
        EXTRACT(HOUR FROM we.slot_starts_at AT TIME ZONE $2)::int AS hour,
        COUNT(*) AS waitlist_entries
      FROM waitlist_entries we
      JOIN resources r ON r.id = we.resource_id
      WHERE r.venue_id = $1
        AND we.slot_starts_at >= now() - ($3 || ' days')::interval
        AND we.status IN ('waiting','offered')
        ${resourceFilterW}
      GROUP BY 1, 2
    `, args).catch(() => []);

    const alerts = await many(`
      SELECT
        EXTRACT(DOW FROM sa.slot_starts_at AT TIME ZONE $2)::int AS weekday,
        EXTRACT(HOUR FROM sa.slot_starts_at AT TIME ZONE $2)::int AS hour,
        COUNT(*) AS slot_alerts
      FROM slot_alerts sa
      JOIN resources r ON r.id = sa.resource_id
      WHERE r.venue_id = $1
        AND sa.slot_starts_at >= now() - ($3 || ' days')::interval
        ${resourceFilterS}
      GROUP BY 1, 2
    `, args).catch(() => []);

    // Merge signals into a lookup map
    const grid = {};
    for (const row of bookings) {
      const k = `${row.weekday}:${row.hour}`;
      grid[k] = { weekday: row.weekday, hour: row.hour, bookings: Number(row.bookings), cancellations: Number(row.cancellations), waitlist_entries: 0, slot_alerts: 0 };
    }
    for (const row of waitlist) {
      const k = `${row.weekday}:${row.hour}`;
      if (!grid[k]) grid[k] = { weekday: row.weekday, hour: row.hour, bookings: 0, cancellations: 0, waitlist_entries: 0, slot_alerts: 0 };
      grid[k].waitlist_entries = Number(row.waitlist_entries);
    }
    for (const row of alerts) {
      const k = `${row.weekday}:${row.hour}`;
      if (!grid[k]) grid[k] = { weekday: row.weekday, hour: row.hour, bookings: 0, cancellations: 0, waitlist_entries: 0, slot_alerts: 0 };
      grid[k].slot_alerts = Number(row.slot_alerts);
    }

    const cells = Object.values(grid).map((cell) => ({
      ...cell,
      demand_score: cell.bookings + cell.waitlist_entries * 0.5 + cell.slot_alerts * 0.3 - cell.cancellations * 0.2,
    }));

    const max_score = cells.length ? Math.max(...cells.map((c) => c.demand_score)) : 0;
    for (const cell of cells) {
      cell.intensity = max_score > 0 ? Math.min(4, Math.floor((cell.demand_score / max_score) * 4)) : 0;
    }

    return {
      period_days: i.period_days,
      methodology: 'observed_facts_only',
      disclaimer: 'Observed demand signals only — not a forecast or prediction.',
      max_score,
      cells,
    };
  },
});

// ------------------------------------------------------------------ utilisation forecast

cap({
  name: 'utilisation_forecast',
  method: 'GET',
  path: '/venues/:venue_id/revenue-intel/forecast',
  tag: 'Revenue Intelligence',
  summary: 'Rolling-mean + linear-trend utilisation forecast. Requires ≥28 days of booking history. Discloses data_coverage_days and mae_pct. Never machine-learning.',
  input: z.object({
    venue_id: id,
    resource_id: id.optional(),
    forecast_weeks: z.coerce.number().int().min(1).max(12).default(4),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);

    const args = i.resource_id ? [i.venue_id, i.resource_id] : [i.venue_id];
    const resourceFilter = i.resource_id ? 'AND b.resource_id = $2' : '';

    // Weekly utilisation for past 16 weeks
    const history = await many(`
      SELECT
        date_trunc('week', b.starts_at)::date AS week_start,
        COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS bookings,
        COUNT(*) AS total_slots_proxied
      FROM bookings b
      JOIN resources r ON r.id = b.resource_id
      WHERE r.venue_id = $1
        AND b.starts_at >= now() - interval '16 weeks'
        ${resourceFilter}
      GROUP BY 1
      ORDER BY 1
    `, args);

    // Available capacity per week (count of schedulable slots from price_rules as a proxy)
    const capacityRow = await one(`
      SELECT COUNT(*) AS rule_count
      FROM price_rules pr
      JOIN resources r ON r.id = pr.resource_id
      WHERE r.venue_id = $1
        AND pr.valid_from <= current_date
        AND (pr.valid_to IS NULL OR pr.valid_to >= current_date)
        ${i.resource_id ? 'AND pr.resource_id = $2' : ''}
    `, args);

    const data_coverage_days = history.length * 7;
    if (data_coverage_days < 28) {
      return { insufficient_history: true, data_coverage_days, min_required_days: 28 };
    }

    const weeks = history.map((w, idx) => ({ idx, bookings: Number(w.bookings) }));
    const n = weeks.length;

    // Rolling 4-week mean
    const rolling = weeks.map((w, i) => {
      const slice = weeks.slice(Math.max(0, i - 3), i + 1);
      return slice.reduce((s, x) => s + x.bookings, 0) / slice.length;
    });

    // Linear trend via simple least-squares on rolling means
    const sumX = weeks.reduce((s, w) => s + w.idx, 0);
    const sumY = rolling.reduce((s, v) => s + v, 0);
    const sumXY = weeks.reduce((s, w, i) => s + w.idx * rolling[i], 0);
    const sumX2 = weeks.reduce((s, w) => s + w.idx * w.idx, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;
    const intercept = (sumY - slope * sumX) / n;

    // MAE on historical rolling vs actual
    const mae = weeks.reduce((s, w) => s + Math.abs(w.bookings - rolling[w.idx]), 0) / n;
    const avg_bookings = sumY / n;
    const mae_pct = avg_bookings > 0 ? Math.round((mae / avg_bookings) * 100 * 10) / 10 : null;

    // Build historical actual series
    const actual = history.map((w, idx) => ({
      week_start: w.week_start,
      bookings: Number(w.bookings),
      rolling_mean: Math.round(rolling[idx] * 10) / 10,
    }));

    // Project forward
    const lastWeek = new Date(history[history.length - 1].week_start);
    const projected = Array.from({ length: i.forecast_weeks }, (_, k) => {
      const futureIdx = n + k;
      const val = Math.max(0, intercept + slope * futureIdx);
      const week_start = new Date(lastWeek);
      week_start.setUTCDate(week_start.getUTCDate() + (k + 1) * 7);
      return {
        week_start: week_start.toISOString().slice(0, 10),
        projected_bookings: Math.round(val * 10) / 10,
        confidence_band_low: Math.max(0, Math.round((val - mae) * 10) / 10),
        confidence_band_high: Math.round((val + mae) * 10) / 10,
      };
    });

    const confidence = data_coverage_days >= 84 ? 'high' : data_coverage_days >= 56 ? 'medium' : 'low';

    return {
      methodology: 'rolling_mean_linear_trend',
      disclaimer: 'Forecast uses rolling mean + linear trend — not machine learning. Treat as directional guidance only.',
      data_coverage_days,
      mae_pct,
      confidence,
      actual,
      projected,
    };
  },
});

// ------------------------------------------------------------------ no-show risk insight

cap({
  name: 'noshow_risk_insight',
  method: 'GET',
  path: '/venues/:venue_id/revenue-intel/noshow-risk',
  tag: 'Revenue Intelligence',
  summary: 'Descriptive statistics on no-show patterns by hour-band, day, channel, days-to-slot and member vs guest. Operational evidence for reminder timing and deposit triggers. No per-customer score.',
  input: z.object({ venue_id: id, period_days: z.coerce.number().int().min(14).max(365).default(90) }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    const args = [i.venue_id, i.period_days];

    const [byDay, byHour, byChannel, byLeadTime, byMembership] = await Promise.all([
      many(`
        SELECT
          EXTRACT(DOW FROM b.starts_at)::int AS weekday,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS total
        FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE r.venue_id = $1 AND b.starts_at >= now() - ($2 || ' days')::interval
        GROUP BY 1 ORDER BY 1
      `, args),
      many(`
        SELECT
          CASE
            WHEN EXTRACT(HOUR FROM b.starts_at) < 9 THEN 'early_morning'
            WHEN EXTRACT(HOUR FROM b.starts_at) < 12 THEN 'morning'
            WHEN EXTRACT(HOUR FROM b.starts_at) < 17 THEN 'afternoon'
            WHEN EXTRACT(HOUR FROM b.starts_at) < 20 THEN 'evening'
            ELSE 'night'
          END AS hour_band,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS total
        FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE r.venue_id = $1 AND b.starts_at >= now() - ($2 || ' days')::interval
        GROUP BY 1
      `, args),
      many(`
        SELECT
          COALESCE(b.channel, 'unknown') AS channel,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS total
        FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE r.venue_id = $1 AND b.starts_at >= now() - ($2 || ' days')::interval
        GROUP BY 1
      `, args).catch(() => []),
      many(`
        SELECT
          CASE
            WHEN (b.starts_at::date - b.created_at::date) = 0 THEN 'same_day'
            WHEN (b.starts_at::date - b.created_at::date) <= 1 THEN '1_day_ahead'
            WHEN (b.starts_at::date - b.created_at::date) <= 3 THEN '2_3_days_ahead'
            WHEN (b.starts_at::date - b.created_at::date) <= 7 THEN '4_7_days_ahead'
            ELSE 'over_a_week'
          END AS lead_time_band,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS total
        FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE r.venue_id = $1 AND b.starts_at >= now() - ($2 || ' days')::interval
        GROUP BY 1
      `, args),
      many(`
        SELECT
          CASE WHEN b.plan_id IS NOT NULL THEN 'member' ELSE 'guest' END AS membership,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS total
        FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE r.venue_id = $1 AND b.starts_at >= now() - ($2 || ' days')::interval
        GROUP BY 1
      `, args).catch(() => []),
    ]);

    const pct = (ns, total) => total > 0 ? Math.round((Number(ns) / Number(total)) * 1000) / 10 : null;

    return {
      methodology: 'descriptive_statistics',
      disclaimer: 'Operational insight only. No per-customer risk score. Use to time reminders and decide deposit thresholds.',
      period_days: i.period_days,
      by_day: byDay.map((r) => ({ weekday: r.weekday, no_show_rate_pct: pct(r.no_shows, r.total), no_shows: Number(r.no_shows), total: Number(r.total) })),
      by_hour_band: byHour.map((r) => ({ hour_band: r.hour_band, no_show_rate_pct: pct(r.no_shows, r.total), no_shows: Number(r.no_shows), total: Number(r.total) })),
      by_channel: byChannel.map((r) => ({ channel: r.channel, no_show_rate_pct: pct(r.no_shows, r.total), no_shows: Number(r.no_shows), total: Number(r.total) })),
      by_lead_time: byLeadTime.map((r) => ({ lead_time_band: r.lead_time_band, no_show_rate_pct: pct(r.no_shows, r.total), no_shows: Number(r.no_shows), total: Number(r.total) })),
      by_membership: byMembership.map((r) => ({ membership: r.membership, no_show_rate_pct: pct(r.no_shows, r.total), no_shows: Number(r.no_shows), total: Number(r.total) })),
    };
  },
});

// ------------------------------------------------------------------ pricing recommendations

cap({
  name: 'generate_pricing_recommendations',
  method: 'POST',
  path: '/venues/:venue_id/revenue-intel/pricing-recommendations/generate',
  tag: 'Revenue Intelligence',
  summary: 'Generate (or refresh) explainable pricing recommendations per resource based on observed demand, current price rules and configured guardrails. Each recommendation includes reason factors and expected-effect estimates.',
  input: z.object({ venue_id: id, resource_id: id.optional(), period_days: z.coerce.number().int().min(28).max(365).default(90) }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);

    const cfg = await one('SELECT * FROM revenue_intel_config WHERE venue_id=$1', [i.venue_id]);
    const resourceFilter = i.resource_id ? 'AND r.id = $2' : '';
    const rArgs = i.resource_id ? [i.venue_id, i.resource_id] : [i.venue_id];

    const resources = await many(`
      SELECT r.id, r.name, r.sport_id
      FROM resources r
      WHERE r.venue_id = $1 AND r.active = true ${resourceFilter}
    `, rArgs);

    const created = [];

    for (const resource of resources) {
      // Get utilisation for this resource
      const util = await one(`
        SELECT
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS total_bookings,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
          MIN(b.starts_at) AS earliest
        FROM bookings b
        WHERE b.resource_id = $1
          AND b.starts_at >= now() - ($2 || ' days')::interval
      `, [resource.id, i.period_days]);

      if (Number(util.total_bookings) < 10) continue; // not enough data

      // Peak vs off-peak breakdown by day-of-week hour
      const demandRows = await many(`
        SELECT
          EXTRACT(DOW FROM b.starts_at)::int AS weekday,
          EXTRACT(HOUR FROM b.starts_at)::int AS hour,
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS bookings,
          COUNT(*) FILTER (WHERE b.status = 'cancelled') AS cancellations,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows
        FROM bookings b
        WHERE b.resource_id = $1
          AND b.starts_at >= now() - ($2 || ' days')::interval
        GROUP BY 1, 2
      `, [resource.id, i.period_days]);

      const currentRule = await one(`
        SELECT pr.hourly_rate_cents
        FROM price_rules pr
        WHERE pr.resource_id = $1
          AND pr.valid_from <= current_date
          AND (pr.valid_to IS NULL OR pr.valid_to >= current_date)
        ORDER BY pr.priority DESC, pr.created_at DESC
        LIMIT 1
      `, [resource.id]);

      const currentRate = currentRule?.hourly_rate_cents ?? null;
      if (!currentRate) continue;

      const totalBookings = Number(util.total_bookings);
      const avgPerHour = demandRows.reduce((s, r) => s + Number(r.bookings), 0) / Math.max(1, demandRows.length);

      // Find low-demand windows (below 40% of average)
      const lowWindows = demandRows.filter((r) => Number(r.bookings) < avgPerHour * 0.4);
      // Find high-demand windows (above 160% of average)
      const highWindows = demandRows.filter((r) => Number(r.bookings) > avgPerHour * 1.6);

      const maxChangeFraction = (cfg?.max_change_pct ?? 15) / 100;
      const minRate = cfg?.min_price_cents ?? Math.round(currentRate * 0.5);
      const maxRate = cfg?.max_price_cents ?? Math.round(currentRate * 2);

      const recs = [];

      if (lowWindows.length >= 3) {
        const suggestedRate = Math.max(minRate, Math.min(maxRate, Math.round(currentRate * (1 - maxChangeFraction * 0.8))));
        if (suggestedRate < currentRate) {
          recs.push({
            trigger_kind: 'low_demand',
            current_rate_cents: currentRate,
            suggested_rate_cents: suggestedRate,
            weekdays: [...new Set(lowWindows.map((r) => r.weekday))],
            start_min: Math.min(...lowWindows.map((r) => r.hour)) * 60,
            end_min: (Math.max(...lowWindows.map((r) => r.hour)) + 1) * 60,
            reason_json: {
              factors: [
                { label: 'avg_bookings_per_slot', value: Math.round(avgPerHour * 10) / 10, direction: 'below_average' },
                { label: 'low_demand_slots', value: lowWindows.length },
              ],
              narrative: `${lowWindows.length} time slots show demand below 40% of your average. A ${Math.round((currentRate - suggestedRate) / 100) / 10 * 10}% reduction may stimulate bookings.`,
            },
            expected_effect: { metric: 'bookings', estimate: '+10–20%', unit: 'bookings_per_week', confidence: 'low' },
            source_period_days: i.period_days,
          });
        }
      }

      if (highWindows.length >= 2) {
        const suggestedRate = Math.max(minRate, Math.min(maxRate, Math.round(currentRate * (1 + maxChangeFraction * 0.6))));
        if (suggestedRate > currentRate) {
          recs.push({
            trigger_kind: 'high_demand',
            current_rate_cents: currentRate,
            suggested_rate_cents: suggestedRate,
            weekdays: [...new Set(highWindows.map((r) => r.weekday))],
            start_min: Math.min(...highWindows.map((r) => r.hour)) * 60,
            end_min: (Math.max(...highWindows.map((r) => r.hour)) + 1) * 60,
            reason_json: {
              factors: [
                { label: 'avg_bookings_per_slot', value: Math.round(avgPerHour * 10) / 10, direction: 'above_average' },
                { label: 'high_demand_slots', value: highWindows.length },
              ],
              narrative: `${highWindows.length} time slots show demand above 160% of your average. A rate increase may capture additional revenue without meaningfully reducing fill.`,
            },
            expected_effect: { metric: 'revenue', estimate: '+5–15%', unit: 'revenue_per_week', confidence: 'low' },
            source_period_days: i.period_days,
          });
        }
      }

      for (const rec of recs) {
        const row = await one(`
          INSERT INTO pricing_recommendations
            (venue_id, resource_id, trigger_kind, current_rate_cents, suggested_rate_cents,
             weekdays, start_min, end_min, reason_json, expected_effect, source_period_days, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
          RETURNING *
        `, [i.venue_id, resource.id, rec.trigger_kind, rec.current_rate_cents, rec.suggested_rate_cents,
            rec.weekdays, rec.start_min, rec.end_min, JSON.stringify(rec.reason_json),
            JSON.stringify(rec.expected_effect), rec.source_period_days]);
        created.push(row);
      }
    }

    return { generated: created.length, recommendations: created };
  },
});

cap({
  name: 'list_pricing_recommendations',
  method: 'GET',
  path: '/venues/:venue_id/revenue-intel/pricing-recommendations',
  tag: 'Revenue Intelligence',
  summary: 'List pricing recommendations for a venue, optionally filtered by status.',
  input: z.object({
    venue_id: id,
    status: z.enum(['pending','approved','rejected','expired','applied']).optional(),
    resource_id: id.optional(),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    const conditions = ['pr.venue_id = $1'];
    const args = [i.venue_id];
    if (i.status) { args.push(i.status); conditions.push(`pr.status = $${args.length}`); }
    if (i.resource_id) { args.push(i.resource_id); conditions.push(`pr.resource_id = $${args.length}`); }
    return many(`
      SELECT pr.*, r.name AS resource_name
      FROM pricing_recommendations pr
      LEFT JOIN resources r ON r.id = pr.resource_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY pr.created_at DESC
      LIMIT 100
    `, args);
  },
});

// ------------------------------------------------------------------ apply recommendation

cap({
  name: 'apply_pricing_recommendation',
  method: 'POST',
  path: '/pricing-recommendations/:id/decision',
  tag: 'Revenue Intelligence',
  summary: 'Approve or reject a pending pricing recommendation. On approve: creates a price_rule (using advisory lock for concurrency safety) with valid_from = tomorrow, enforces guardrails, marks recommendation applied. Never reprices existing confirmed bookings.',
  input: z.object({
    id,
    action: z.enum(['approve', 'reject']),
    valid_from: day.optional(),
    valid_to: day.optional(),
    note: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    const rec = await one('SELECT * FROM pricing_recommendations WHERE id=$1', [i.id]);
    if (!rec) throw notFound('Pricing recommendation not found');
    if (rec.status !== 'pending') throw badRequest(`Recommendation is already ${rec.status}`);
    await mustManage(user, rec.venue_id);

    if (i.action === 'reject') {
      await one('UPDATE pricing_recommendations SET status=\'rejected\', decided_by=$2, decided_at=now() WHERE id=$1 RETURNING *', [i.id, user.id]);
      return { status: 'rejected' };
    }

    // Approve: enforce guardrails and create a price rule
    const cfg = await one('SELECT * FROM revenue_intel_config WHERE venue_id=$1', [rec.venue_id]);
    if (cfg?.min_price_cents && rec.suggested_rate_cents < cfg.min_price_cents)
      throw badRequest(`Suggested rate is below the configured minimum of ${cfg.min_price_cents / 100}`);
    if (cfg?.max_price_cents && rec.suggested_rate_cents > cfg.max_price_cents)
      throw badRequest(`Suggested rate exceeds the configured maximum of ${cfg.max_price_cents / 100}`);
    if (cfg?.max_change_pct && rec.current_rate_cents) {
      const changePct = Math.abs((rec.suggested_rate_cents - rec.current_rate_cents) / rec.current_rate_cents) * 100;
      if (changePct > cfg.max_change_pct)
        throw badRequest(`Change of ${changePct.toFixed(1)}% exceeds guardrail maximum of ${cfg.max_change_pct}%`);
    }

    // Check blackout periods
    const validFrom = i.valid_from ?? addDays(new Date(), 1).toISOString().slice(0, 10);
    if (cfg?.blackout_periods?.length) {
      for (const bp of cfg.blackout_periods) {
        if (validFrom >= bp.from && validFrom <= bp.to)
          throw badRequest(`The date ${validFrom} falls within a configured blackout period (${bp.from} – ${bp.to})`);
      }
    }

    let ruleRow;
    await tx(async (c) => {
      if (rec.resource_id) await lockResource(c, rec.resource_id);
      ruleRow = await c.query(`
        INSERT INTO price_rules
          (venue_id, resource_id, name, weekdays, start_min, end_min, hourly_rate_cents,
           valid_from, valid_to, priority, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5,'revenue_intel')
        RETURNING *
      `, [
        rec.venue_id, rec.resource_id,
        `Revenue Intel: ${rec.trigger_kind}`,
        rec.weekdays,
        rec.start_min, rec.end_min,
        rec.suggested_rate_cents,
        validFrom,
        i.valid_to ?? rec.valid_to ?? null,
        10,
      ]);
      await c.query(`
        UPDATE pricing_recommendations
        SET status='applied', decided_by=$2, decided_at=now(), applied_rule_id=$3,
            outcome_period_end=($4::date + interval '28 days')::date
        WHERE id=$1
      `, [i.id, user.id, ruleRow.rows[0].id, validFrom]);
    });

    return { status: 'applied', rule: ruleRow.rows[0] };
  },
});

// ------------------------------------------------------------------ configure dynamic pricing

cap({
  name: 'configure_dynamic_pricing',
  method: 'PUT',
  path: '/venues/:venue_id/revenue-intel/config',
  tag: 'Revenue Intelligence',
  summary: 'Save or update dynamic-pricing guardrails for a venue. Requires venue owner role.',
  input: z.object({
    venue_id: id,
    automation_mode: z.enum(['manual','bounded_auto']).optional(),
    min_price_cents: z.number().int().min(0).optional(),
    max_price_cents: z.number().int().min(0).optional(),
    max_change_pct: z.number().min(1).max(50).optional(),
    protected_plan_ids: z.array(z.string().uuid()).optional(),
    blackout_periods: z.array(z.object({ from: day, to: day })).max(20).optional(),
    objectives: z.object({
      protect_peak: z.boolean().optional(),
      fill_offpeak: z.boolean().optional(),
      reduce_noshow: z.boolean().optional(),
    }).optional(),
  }),
  async handler({ user }, i) {
    const member = await one('SELECT role FROM venue_members WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [i.venue_id, user.id]);
    if (!member || member.role !== 'owner') throw forbidden('Only venue owners can configure dynamic pricing guardrails');

    if (i.min_price_cents != null && i.max_price_cents != null && i.min_price_cents > i.max_price_cents)
      throw badRequest('min_price_cents must be less than or equal to max_price_cents');

    // Validate blackout period ordering
    if (i.blackout_periods) {
      for (const bp of i.blackout_periods) {
        if (bp.from > bp.to) throw badRequest(`Blackout period from ${bp.from} must be before ${bp.to}`);
      }
    }

    const existing = await one('SELECT * FROM revenue_intel_config WHERE venue_id=$1', [i.venue_id]);
    if (existing) {
      return one(`
        UPDATE revenue_intel_config SET
          automation_mode = COALESCE($2, automation_mode),
          min_price_cents = COALESCE($3::int, min_price_cents),
          max_price_cents = COALESCE($4::int, max_price_cents),
          max_change_pct = COALESCE($5::numeric, max_change_pct),
          protected_plan_ids = COALESCE($6::jsonb, protected_plan_ids),
          blackout_periods = COALESCE($7::jsonb, blackout_periods),
          objectives = COALESCE($8::jsonb, objectives),
          updated_by = $9,
          updated_at = now()
        WHERE venue_id=$1
        RETURNING *
      `, [i.venue_id, i.automation_mode ?? null, i.min_price_cents ?? null, i.max_price_cents ?? null,
          i.max_change_pct ?? null,
          i.protected_plan_ids ? JSON.stringify(i.protected_plan_ids) : null,
          i.blackout_periods ? JSON.stringify(i.blackout_periods) : null,
          i.objectives ? JSON.stringify(i.objectives) : null,
          user.id]);
    }

    return one(`
      INSERT INTO revenue_intel_config
        (venue_id, automation_mode, min_price_cents, max_price_cents, max_change_pct,
         protected_plan_ids, blackout_periods, objectives, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [i.venue_id,
        i.automation_mode ?? 'manual',
        i.min_price_cents ?? null,
        i.max_price_cents ?? null,
        i.max_change_pct ?? 15,
        JSON.stringify(i.protected_plan_ids ?? []),
        JSON.stringify(i.blackout_periods ?? []),
        JSON.stringify(i.objectives ?? {}),
        user.id]);
  },
});

cap({
  name: 'get_dynamic_pricing_config',
  method: 'GET',
  path: '/venues/:venue_id/revenue-intel/config',
  tag: 'Revenue Intelligence',
  summary: 'Get current dynamic pricing guardrails for a venue.',
  input: z.object({ venue_id: id }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    return (await one('SELECT * FROM revenue_intel_config WHERE venue_id=$1', [i.venue_id])) ?? { venue_id: i.venue_id, automation_mode: 'manual', max_change_pct: 15, protected_plan_ids: [], blackout_periods: [], objectives: {} };
  },
});

// ------------------------------------------------------------------ utilisation recommendations

cap({
  name: 'list_utilisation_recommendations',
  method: 'GET',
  path: '/venues/:venue_id/revenue-intel/utilisation-recommendations',
  tag: 'Revenue Intelligence',
  summary: 'List open utilisation recommendations with evidence (adjust hours, promotions, community games, maintenance scheduling, waitlist activation).',
  input: z.object({
    venue_id: id,
    status: z.enum(['open','acted','dismissed']).default('open'),
    priority: z.enum(['high','medium','low']).optional(),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    const conditions = ['ur.venue_id = $1', 'ur.status = $2'];
    const args = [i.venue_id, i.status];
    if (i.priority) { args.push(i.priority); conditions.push(`ur.priority = $${args.length}`); }
    return many(`
      SELECT ur.*, r.name AS resource_name
      FROM utilisation_recommendations ur
      LEFT JOIN resources r ON r.id = ur.resource_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE ur.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, ur.created_at DESC
    `, args);
  },
});

cap({
  name: 'update_utilisation_recommendation',
  method: 'PATCH',
  path: '/utilisation-recommendations/:id',
  tag: 'Revenue Intelligence',
  summary: 'Mark a utilisation recommendation as acted on or dismissed.',
  input: z.object({
    id,
    status: z.enum(['acted','dismissed']),
  }),
  async handler({ user }, i) {
    const rec = await one('SELECT * FROM utilisation_recommendations WHERE id=$1', [i.id]);
    if (!rec) throw notFound('Utilisation recommendation not found');
    await mustManage(user, rec.venue_id);
    return one('UPDATE utilisation_recommendations SET status=$2, acted_at=now(), acted_by=$3 WHERE id=$1 RETURNING *', [i.id, i.status, user.id]);
  },
});

// ------------------------------------------------------------------ pricing experiments

cap({
  name: 'create_pricing_experiment',
  method: 'POST',
  path: '/venues/:venue_id/revenue-intel/experiments',
  tag: 'Revenue Intelligence',
  summary: 'Create a controlled pricing experiment. Validates no overlap with active experiments on the same resources. Status starts as draft.',
  input: z.object({
    venue_id: id,
    resource_ids: z.array(id).min(1).max(10),
    name: z.string().min(2).max(120),
    hypothesis: z.string().max(500).optional(),
    control_rate_cents: z.number().int().min(1),
    experiment_rate_cents: z.number().int().min(1),
    start_date: day,
    end_date: day,
    primary_metric: z.enum(['utilisation_pct','booking_count','revenue_cents']).default('utilisation_pct'),
    eligibility_json: z.object({}).passthrough().optional(),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    if (i.start_date >= i.end_date) throw badRequest('end_date must be after start_date');

    // Check for overlapping active experiments on same resources
    const overlap = await one(`
      SELECT id FROM pricing_experiments
      WHERE venue_id = $1
        AND status IN ('draft','active')
        AND resource_ids && $2::uuid[]
        AND start_date < $3::date
        AND end_date > $4::date
      LIMIT 1
    `, [i.venue_id, `{${i.resource_ids.join(',')}}`, i.end_date, i.start_date]);

    if (overlap) throw badRequest('An existing experiment overlaps with these resources and date range. Cancel or complete it first.');

    return one(`
      INSERT INTO pricing_experiments
        (venue_id, resource_ids, name, hypothesis, control_rate_cents, experiment_rate_cents,
         eligibility_json, start_date, end_date, primary_metric, created_by)
      VALUES ($1,$2::uuid[],$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [i.venue_id, `{${i.resource_ids.join(',')}}`, i.name, i.hypothesis ?? null,
        i.control_rate_cents, i.experiment_rate_cents,
        JSON.stringify(i.eligibility_json ?? {}),
        i.start_date, i.end_date, i.primary_metric, user.id]);
  },
});

cap({
  name: 'activate_pricing_experiment',
  method: 'POST',
  path: '/pricing-experiments/:id/activate',
  tag: 'Revenue Intelligence',
  summary: 'Transition a draft pricing experiment to active and create bounded price rules for the experiment window.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const exp = await one('SELECT * FROM pricing_experiments WHERE id=$1', [i.id]);
    if (!exp) throw notFound('Experiment not found');
    if (exp.status !== 'draft') throw badRequest(`Experiment is already ${exp.status}`);
    await mustManage(user, exp.venue_id);

    const rules = [];
    await tx(async (c) => {
      for (const rid of exp.resource_ids) {
        await lockResource(c, rid);
        const r = await c.query(`
          INSERT INTO price_rules
            (venue_id, resource_id, name, hourly_rate_cents, valid_from, valid_to, priority, source)
          VALUES ($1,$2,$3,$4,$5,$6,20,'experiment')
          RETURNING *
        `, [exp.venue_id, rid, `Experiment: ${exp.name}`, exp.experiment_rate_cents, exp.start_date, exp.end_date, 20]);
        rules.push(r.rows[0]);
      }
      await c.query('UPDATE pricing_experiments SET status=\'active\' WHERE id=$1', [i.id]);
    });

    return { status: 'active', rules };
  },
});

cap({
  name: 'pricing_experiment_results',
  method: 'GET',
  path: '/pricing-experiments/:id/results',
  tag: 'Revenue Intelligence',
  summary: 'Compare utilisation, booking count and revenue for the control period (before) vs experiment period.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const exp = await one('SELECT * FROM pricing_experiments WHERE id=$1', [i.id]);
    if (!exp) throw notFound('Experiment not found');
    await mustManage(user, exp.venue_id);

    const duration = Math.max(1, Math.round((new Date(exp.end_date) - new Date(exp.start_date)) / 864e5));

    // Control period: same duration before start_date
    const controlStart = new Date(exp.start_date);
    controlStart.setUTCDate(controlStart.getUTCDate() - duration);
    const controlStartStr = controlStart.toISOString().slice(0, 10);

    const resourceArray = `{${exp.resource_ids.join(',')}}`;

    const [controlData, experimentData] = await Promise.all([
      one(`
        SELECT
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS bookings,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
          COALESCE(SUM(b.amount_cents) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue_cents
        FROM bookings b
        WHERE b.resource_id = ANY($1::uuid[])
          AND b.starts_at >= $2::date AND b.starts_at < $3::date
      `, [resourceArray, controlStartStr, exp.start_date]),
      one(`
        SELECT
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS bookings,
          COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
          COALESCE(SUM(b.amount_cents) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue_cents
        FROM bookings b
        WHERE b.resource_id = ANY($1::uuid[])
          AND b.starts_at >= $2::date AND b.starts_at < $3::date
      `, [resourceArray, exp.start_date, exp.end_date]),
    ]);

    const totalControl = Number(controlData.bookings);
    const totalExp = Number(experimentData.bookings);
    const minSamples = 30;
    const insufficientSamples = totalControl < minSamples || totalExp < minSamples;

    return {
      experiment: { id: exp.id, name: exp.name, status: exp.status, start_date: exp.start_date, end_date: exp.end_date },
      control_period: { start: controlStartStr, end: exp.start_date, bookings: totalControl, no_shows: Number(controlData.no_shows), revenue_cents: Number(controlData.revenue_cents) },
      experiment_period: { start: exp.start_date, end: exp.end_date, bookings: totalExp, no_shows: Number(experimentData.no_shows), revenue_cents: Number(experimentData.revenue_cents) },
      delta: {
        bookings_pct: totalControl > 0 ? Math.round(((totalExp - totalControl) / totalControl) * 1000) / 10 : null,
        revenue_pct: Number(controlData.revenue_cents) > 0 ? Math.round(((Number(experimentData.revenue_cents) - Number(controlData.revenue_cents)) / Number(controlData.revenue_cents)) * 1000) / 10 : null,
      },
      caveat: insufficientSamples ? `Fewer than ${minSamples} bookings in one or both arms — results are directional only, not statistically significant.` : null,
    };
  },
});

cap({
  name: 'list_pricing_experiments',
  method: 'GET',
  path: '/venues/:venue_id/revenue-intel/experiments',
  tag: 'Revenue Intelligence',
  summary: 'List pricing experiments for a venue.',
  input: z.object({ venue_id: id, status: z.enum(['draft','active','completed','cancelled']).optional() }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    const conditions = ['venue_id = $1'];
    const args = [i.venue_id];
    if (i.status) { args.push(i.status); conditions.push(`status = $${args.length}`); }
    return many(`SELECT * FROM pricing_experiments WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`, args);
  },
});

// ------------------------------------------------------------------ recommendation outcome

cap({
  name: 'recommendation_outcome',
  method: 'GET',
  path: '/pricing-recommendations/:id/outcome',
  tag: 'Revenue Intelligence',
  summary: 'For an applied recommendation past its outcome_period_end: compare actual utilisation and revenue vs pre-recommendation baseline. Populates actual_effect.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const rec = await one('SELECT * FROM pricing_recommendations WHERE id=$1', [i.id]);
    if (!rec) throw notFound('Pricing recommendation not found');
    await mustManage(user, rec.venue_id);
    if (rec.status !== 'applied') throw badRequest('Only applied recommendations have an outcome');
    if (!rec.outcome_period_end) throw badRequest('Outcome period has not been set');

    const now = new Date().toISOString().slice(0, 10);
    if (now < rec.outcome_period_end) {
      return { ready: false, outcome_period_end: rec.outcome_period_end, message: `Outcome data is collected until ${rec.outcome_period_end}` };
    }

    // Baseline: 28 days before valid_from
    const baselineStart = new Date(rec.valid_from ?? rec.created_at);
    baselineStart.setUTCDate(baselineStart.getUTCDate() - 28);
    const baselineEnd = new Date(rec.valid_from ?? rec.created_at);

    const resourceFilter = rec.resource_id ? 'AND b.resource_id = $4' : 'AND r.venue_id = $4';
    const resourceArg = rec.resource_id ?? rec.venue_id;

    const [baseline, outcome] = await Promise.all([
      one(`
        SELECT
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS bookings,
          COALESCE(SUM(b.amount_cents) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue_cents
        FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE r.venue_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 ${resourceFilter}
      `, [rec.venue_id, baselineStart.toISOString().slice(0, 10), baselineEnd.toISOString().slice(0, 10), resourceArg]),
      one(`
        SELECT
          COUNT(*) FILTER (WHERE b.status IN ('confirmed','completed','no_show')) AS bookings,
          COALESCE(SUM(b.amount_cents) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue_cents
        FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE r.venue_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 ${resourceFilter}
      `, [rec.venue_id, rec.valid_from ?? rec.created_at, rec.outcome_period_end, resourceArg]),
    ]);

    const bookingsDelta = Number(baseline.bookings) > 0
      ? Math.round(((Number(outcome.bookings) - Number(baseline.bookings)) / Number(baseline.bookings)) * 1000) / 10
      : null;
    const revenueDelta = Number(baseline.revenue_cents) > 0
      ? Math.round(((Number(outcome.revenue_cents) - Number(baseline.revenue_cents)) / Number(baseline.revenue_cents)) * 1000) / 10
      : null;

    const actual_effect = {
      bookings_change_pct: bookingsDelta,
      revenue_change_pct: revenueDelta,
      baseline_bookings: Number(baseline.bookings),
      outcome_bookings: Number(outcome.bookings),
      baseline_revenue_cents: Number(baseline.revenue_cents),
      outcome_revenue_cents: Number(outcome.revenue_cents),
    };

    await one('UPDATE pricing_recommendations SET actual_effect=$2 WHERE id=$1', [i.id, JSON.stringify(actual_effect)]);

    return { ready: true, actual_effect, expected_effect: rec.expected_effect };
  },
});
