// Athlete Data Hub & Performance Integration Platform (#566).
// Unified hub for wearables, GPS, lab/field assessments and manual entries.
// Athletes see their own data only. Coaches see only via live wellness_shares with 'assessments'/'wearables'.
// Nothing here is a diagnosis or medical clearance.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { requireConsent } from '../youth.js';
import { requireHealthNotice } from '../health-governance.js';
import { shareBlock } from '../wellness-sharing.js';
import { METRICS, ADAPTERS, normalise, MAPPING_VERSION } from '../wearables/normalise.js';
import { computeACWR, computeReadiness } from '../wearables/acwr.js';

const TAG = 'Athlete health';
const NOT_MEDICAL = 'Descriptive readings only. Not a diagnosis, medical advice or clearance to train or play.';

const metricKey = z.enum(Object.keys(METRICS));
const assessmentFamily = z.enum(['strength', 'jump', 'sprint', 'body_composition', 'fitness', 'flexibility', 'neuromuscular', 'manual']);
const assessmentProvider = z.enum(['manual', 'forcedecks', 'vald', 'inbody', 'brower', 'smartspeed', 'catapult_opf', 'dexa', 'skinfolds', 'csv_import']);

// ─── Athlete: full hub summary ────────────────────────────────────────────────
cap({
  name: 'get_athlete_data_hub',
  tag: TAG,
  summary: 'Your data hub: latest values per canonical metric, readiness, ACWR and all assessment families.',
  method: 'GET', path: '/me/data-hub',
  input: z.object({}),
  output: z.object({ disclaimer: z.string(), readiness: z.any(), acwr: z.any(), metrics: z.array(z.any()), assessments: z.array(z.any()), sources: z.array(z.any()) }),
  async handler({ user }) {
    const wearableMetrics = await many(
      `SELECT DISTINCT ON (metric_key) metric_key, value, unit, provider_key, recorded_on, quality, mapping_version
       FROM wearable_metrics WHERE user_id=$1 ORDER BY metric_key, recorded_on DESC`,
      [user.id],
    );
    const assessMetrics = await many(
      `SELECT DISTINCT ON (metric_key) metric_key, value, unit, 'assessment' AS provider_key, created_at::date AS recorded_on, quality
       FROM performance_measurements WHERE athlete_id=$1 AND voided_at IS NULL ORDER BY metric_key, created_at DESC`,
      [user.id],
    );
    const metricMap = {};
    for (const r of [...wearableMetrics, ...assessMetrics]) {
      const existing = metricMap[r.metric_key];
      if (!existing || r.recorded_on > existing.recorded_on) metricMap[r.metric_key] = r;
    }
    const metrics = Object.values(metricMap).map((r) => ({
      metric_key: r.metric_key,
      label: METRICS[r.metric_key]?.label ?? r.metric_key,
      value: r.value, unit: r.unit,
      provider: r.provider_key, recorded_on: r.recorded_on,
      quality: r.quality ?? [],
    }));
    const assessmentRows = await many(
      `SELECT assessment_family, COUNT(*) AS count, MAX(assessed_on) AS latest
       FROM performance_assessments WHERE athlete_id=$1 GROUP BY assessment_family`,
      [user.id],
    );
    const sources = await many(
      `SELECT id, provider_key, status, last_success_at, last_summary FROM athlete_connections WHERE user_id=$1 ORDER BY created_at`,
      [user.id],
    );
    let acwr = null;
    let readiness = null;
    try { acwr = await computeACWR(user.id); } catch {}
    try { readiness = await computeReadiness(user.id); } catch {}
    return { disclaimer: NOT_MEDICAL, readiness, acwr, metrics, assessments: assessmentRows, sources };
  },
});

// ─── Athlete: 90-day metric timeline with provenance ─────────────────────────
cap({
  name: 'list_hub_metric_timeline',
  tag: TAG,
  summary: '90-day timeline for one canonical metric with per-point provenance.',
  method: 'GET', path: '/me/data-hub/metrics/:metric_key',
  input: z.object({ metric_key: metricKey }),
  output: z.object({ metric_key: z.string(), points: z.array(z.any()) }),
  async handler({ user, params }) {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const wRows = await many(
      `SELECT recorded_on AS on, value, unit, provider_key AS provider, source_metric, source_value, source_unit, quality, mapping_version
       FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on >= $3 ORDER BY recorded_on`,
      [user.id, params.metric_key, since],
    );
    const aRows = await many(
      `SELECT pm.created_at::date AS on, pm.value, pm.unit, 'assessment' AS provider, pm.metric_key AS source_metric,
              pm.original_value AS source_value, pm.original_unit AS source_unit, pm.quality, NULL AS mapping_version
       FROM performance_measurements pm
       WHERE pm.athlete_id=$1 AND pm.metric_key=$2 AND pm.created_at >= $3 AND pm.voided_at IS NULL ORDER BY pm.created_at`,
      [user.id, params.metric_key, since],
    );
    const points = [...wRows, ...aRows].sort((a, b) => (String(a.on) < String(b.on) ? -1 : 1));
    return { metric_key: params.metric_key, points };
  },
});

// ─── Athlete: create performance assessment ───────────────────────────────────
cap({
  name: 'create_performance_assessment',
  tag: TAG,
  summary: 'Log a lab or field test session with measurements. Requires health notice acceptance.',
  method: 'POST', path: '/me/assessments',
  input: z.object({
    assessed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    assessment_family: assessmentFamily,
    test_protocol: z.string().min(1).max(200),
    provider: assessmentProvider.optional().default('manual'),
    source_ref: z.string().max(200).optional(),
    assessor_id: z.string().uuid().optional(),
    org_id: z.string().uuid().optional(),
    location: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    measurements: z.array(z.object({
      metric_key: metricKey,
      value: z.number(),
      unit: z.string().max(20),
      original_value: z.number().optional(),
      original_unit: z.string().max(20).optional(),
    })).min(1).max(50),
  }),
  output: z.object({ id: z.string(), measurement_count: z.number() }),
  async handler({ user, body }) {
    await requireHealthNotice(user.id);
    await requireConsent(user.id, 'medical');
    const locationEnc = body.location ? await encrypt(body.location) : null;
    const notesEnc = body.notes ? await encrypt(body.notes) : null;
    const result = await tx(async (client) => {
      const { id: assessId } = await client.one(
        `INSERT INTO performance_assessments
           (athlete_id, org_id, assessed_on, assessment_family, test_protocol, provider, source_ref, assessor_id, location_enc, notes_enc, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [user.id, body.org_id ?? null, body.assessed_on, body.assessment_family, body.test_protocol,
          body.provider ?? 'manual', body.source_ref ?? null, body.assessor_id ?? null,
          locationEnc, notesEnc, JSON.stringify({ created_by: user.id, mapping_version: MAPPING_VERSION })],
      );
      let count = 0;
      for (const m of body.measurements) {
        const norm = normalise(m.metric_key, m.value, m.unit);
        const canonValue = norm?.value ?? m.value;
        const canonUnit = norm?.unit ?? m.unit;
        const quality = norm?.flags ?? [];
        await client.query(
          `INSERT INTO performance_measurements
             (assessment_id, athlete_id, metric_key, value, unit, original_value, original_unit, quality)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [assessId, user.id, m.metric_key, canonValue, canonUnit,
            m.original_value ?? m.value, m.original_unit ?? m.unit, quality],
        );
        count++;
      }
      return { id: assessId, measurement_count: count };
    });
    await audit(user.id, 'assessment.created', { assessment_id: result.id });
    return result;
  },
});

// ─── Athlete: list assessments ────────────────────────────────────────────────
cap({
  name: 'list_performance_assessments',
  tag: TAG,
  summary: 'Paginated list of your assessment sessions, filtered by family and date range.',
  method: 'GET', path: '/me/assessments',
  input: z.object({
    family: assessmentFamily.optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    offset: z.coerce.number().int().min(0).optional().default(0),
  }),
  output: z.object({ total: z.number(), items: z.array(z.any()) }),
  async handler({ user, query: q }) {
    const wheres = ['a.athlete_id=$1'];
    const vals = [user.id];
    if (q.family) { vals.push(q.family); wheres.push(`a.assessment_family=$${vals.length}`); }
    if (q.from) { vals.push(q.from); wheres.push(`a.assessed_on>=$${vals.length}`); }
    if (q.to) { vals.push(q.to); wheres.push(`a.assessed_on<=$${vals.length}`); }
    const where = wheres.join(' AND ');
    const [{ count }] = await many(`SELECT COUNT(*) FROM performance_assessments a WHERE ${where}`, vals);
    vals.push(q.limit, q.offset);
    const items = await many(
      `SELECT a.id, a.assessed_on, a.assessment_family, a.test_protocol, a.provider,
              a.assessor_id, a.created_at,
              (SELECT COUNT(*) FROM performance_measurements WHERE assessment_id=a.id AND voided_at IS NULL) AS measurement_count
       FROM performance_assessments a WHERE ${where} ORDER BY a.assessed_on DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    return { total: Number(count), items };
  },
});

// ─── Athlete: get one assessment with all measurements ────────────────────────
cap({
  name: 'get_performance_assessment',
  tag: TAG,
  summary: 'Full assessment detail including all measurements and provenance.',
  method: 'GET', path: '/me/assessments/:id',
  input: z.object({ id: id }),
  output: z.object({ assessment: z.any(), measurements: z.array(z.any()) }),
  async handler({ user, params }) {
    const assessment = await one(
      `SELECT * FROM performance_assessments WHERE id=$1 AND athlete_id=$2`,
      [params.id, user.id],
    ).catch(() => null);
    if (!assessment) throw notFound();
    if (assessment.location_enc) {
      assessment.location = await decrypt(assessment.location_enc);
      await audit(user.id, 'assessment.location_read', { assessment_id: params.id });
    }
    if (assessment.notes_enc) {
      assessment.notes = await decrypt(assessment.notes_enc);
      await audit(user.id, 'assessment.notes_read', { assessment_id: params.id });
    }
    delete assessment.location_enc;
    delete assessment.notes_enc;
    const measurements = await many(
      `SELECT id, metric_key, value, unit, original_value, original_unit, quality, voided_at, created_at
       FROM performance_measurements WHERE assessment_id=$1 ORDER BY created_at`,
      [params.id],
    );
    return { assessment, measurements };
  },
});

// ─── Athlete: soft-void a measurement ────────────────────────────────────────
cap({
  name: 'void_performance_measurement',
  tag: TAG,
  summary: 'Soft-void a measurement (original row kept for audit).',
  method: 'PATCH', path: '/me/assessments/:id/measurements/:mid/void',
  input: z.object({ id: id, mid: id, void_reason: z.string().min(1).max(500) }),
  output: z.object({ voided: z.boolean() }),
  async handler({ user, params, body }) {
    const meas = await one(
      `SELECT pm.id FROM performance_measurements pm
       JOIN performance_assessments a ON a.id=pm.assessment_id
       WHERE pm.id=$1 AND a.id=$2 AND a.athlete_id=$3 AND pm.voided_at IS NULL`,
      [params.mid, params.id, user.id],
    ).catch(() => null);
    if (!meas) throw notFound();
    await query(
      `UPDATE performance_measurements SET voided_at=now(), voided_by=$1, void_reason=$2 WHERE id=$3`,
      [user.id, body.void_reason, params.mid],
    );
    await audit(user.id, 'measurement.voided', { measurement_id: params.mid, reason: body.void_reason });
    return { voided: true };
  },
});

// ─── Athlete: register an assessment provider ─────────────────────────────────
cap({
  name: 'register_hub_source',
  tag: TAG,
  summary: 'Register an assessment data provider (ForceDecks, InBody, etc.) for your hub.',
  method: 'POST', path: '/me/data-hub/sources',
  input: z.object({
    provider: z.string().min(1).max(60),
    display_name: z.string().min(1).max(100),
    org_id: z.string().uuid().optional(),
  }),
  output: z.object({ id: z.string() }),
  async handler({ user, body }) {
    const existing = await one(
      `SELECT id FROM hub_data_sources WHERE athlete_id=$1 AND org_id IS NOT DISTINCT FROM $2 AND provider=$3`,
      [user.id, body.org_id ?? null, body.provider],
    ).catch(() => null);
    if (existing) return { id: existing.id };
    const { id: srcId } = await one(
      `INSERT INTO hub_data_sources (athlete_id, org_id, provider, display_name)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [user.id, body.org_id ?? null, body.provider, body.display_name],
    );
    return { id: srcId };
  },
});

// ─── Athlete: import assessment CSV ──────────────────────────────────────────
cap({
  name: 'import_assessment_csv',
  tag: TAG,
  summary: 'Parse a provider-specific CSV (InBody, Brower, ForceDecks) and store as assessment+measurements.',
  method: 'POST', path: '/me/data-hub/import',
  input: z.object({
    provider: assessmentProvider,
    assessed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rows: z.array(z.record(z.string())).min(1).max(500),
    org_id: z.string().uuid().optional(),
  }),
  output: z.object({ assessment_id: z.string(), imported: z.number(), skipped: z.number() }),
  async handler({ user, body }) {
    await requireHealthNotice(user.id);
    await requireConsent(user.id, 'medical');
    const adapter = ADAPTERS[body.provider];
    if (!adapter) throw badRequest(`No adapter for provider: ${body.provider}`);
    const dataKey = body.provider === 'inbody' ? 'results' : body.provider === 'brower' ? 'splits' : 'runs';
    const parsed = adapter.parse({ [dataKey]: body.rows });
    const familyMap = { inbody: 'body_composition', forcedecks: 'jump', vald: 'jump', brower: 'sprint', smartspeed: 'sprint' };
    const result = await tx(async (client) => {
      const { id: assessId } = await client.one(
        `INSERT INTO performance_assessments
           (athlete_id, org_id, assessed_on, assessment_family, test_protocol, provider, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [user.id, body.org_id ?? null, body.assessed_on,
          familyMap[body.provider] ?? 'manual',
          body.provider, body.provider,
          JSON.stringify({ imported_rows: body.rows.length, mapping_version: MAPPING_VERSION })],
      );
      let imported = 0;
      let skipped = 0;
      for (const p of parsed) {
        if (!p.metric_key || p.value === null) { skipped++; continue; }
        const norm = normalise(p.metric_key, p.value, p.unit);
        if (!norm) { skipped++; continue; }
        await client.query(
          `INSERT INTO performance_measurements
             (assessment_id, athlete_id, metric_key, value, unit, original_value, original_unit, quality)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [assessId, user.id, p.metric_key, norm.value, norm.unit, p.value, p.unit, norm.flags],
        );
        imported++;
      }
      return { assessment_id: assessId, imported, skipped };
    });
    await audit(user.id, 'assessment.csv_imported', { assessment_id: result.assessment_id, provider: body.provider });
    return result;
  },
});

// ─── Coach: squad data hub overview ──────────────────────────────────────────
cap({
  name: 'get_coach_data_hub',
  tag: TAG,
  summary: 'Squad overview: avg readiness, ACWR alert count, missing data, session response summary.',
  method: 'GET', path: '/orgs/:org_id/data-hub',
  input: z.object({ org_id: id }),
  output: z.object({ squad_size: z.number(), avg_readiness: z.any(), acwr_alert_count: z.number(), missing_data_count: z.number(), athletes: z.array(z.any()) }),
  async handler({ user, params }) {
    await shareBlock(user.id, params.org_id, 'wearables');
    const athletes = await many(
      `SELECT DISTINCT u.id, u.full_name, u.avatar_url
       FROM users u
       JOIN team_members tm ON tm.user_id=u.id
       JOIN teams t ON t.id=tm.team_id
       WHERE t.organisation_id=$1 AND tm.status='active'
         AND EXISTS (
           SELECT 1 FROM wellness_shares ws
           WHERE ws.athlete_id=u.id AND ws.org_id=$1 AND ws.status='active'
             AND (ws.fields @> ARRAY['wearables'] OR ws.fields @> ARRAY['assessments'])
         )`,
      [params.org_id],
    );
    const today = new Date().toISOString().slice(0, 10);
    let readinessSum = 0;
    let readinessCount = 0;
    let acwrAlerts = 0;
    const enriched = await Promise.all(
      athletes.map(async (a) => {
        let readiness = null;
        let acwr = null;
        try { readiness = await computeReadiness(a.id); } catch {}
        try { acwr = await computeACWR(a.id); } catch {}
        if (readiness?.score) { readinessSum += readiness.score; readinessCount++; }
        if (acwr?.ratio > 1.3) acwrAlerts++;
        const lastSync = await one(
          `SELECT MAX(last_success_at) AS t FROM athlete_connections WHERE user_id=$1`,
          [a.id],
        ).catch(() => ({ t: null }));
        return { ...a, readiness, acwr, last_sync: lastSync?.t ?? null };
      }),
    );
    const missingToday = await many(
      `SELECT DISTINCT wm.user_id FROM wearable_metrics wm
       WHERE wm.user_id = ANY($1::uuid[]) AND wm.recorded_on = $2`,
      [athletes.map((a) => a.id), today],
    );
    const missing = athletes.length - missingToday.length;
    return {
      squad_size: athletes.length,
      avg_readiness: readinessCount > 0 ? Math.round(readinessSum / readinessCount) : null,
      acwr_alert_count: acwrAlerts,
      missing_data_count: missing,
      athletes: enriched,
    };
  },
});

// ─── Coach: squad metric comparison ──────────────────────────────────────────
cap({
  name: 'get_squad_metric_comparison',
  tag: TAG,
  summary: 'Per-athlete latest value and 7-day trend for a chosen metric.',
  method: 'GET', path: '/orgs/:org_id/data-hub/squad',
  input: z.object({ org_id: id, metric_key: metricKey }),
  output: z.object({ metric_key: z.string(), rows: z.array(z.any()) }),
  async handler({ user, params, query: q }) {
    await shareBlock(user.id, params.org_id, 'wearables');
    const athletes = await many(
      `SELECT DISTINCT u.id, u.full_name FROM users u
       JOIN team_members tm ON tm.user_id=u.id JOIN teams t ON t.id=tm.team_id
       WHERE t.organisation_id=$1 AND tm.status='active'
         AND EXISTS (SELECT 1 FROM wellness_shares ws WHERE ws.athlete_id=u.id AND ws.org_id=$1 AND ws.status='active' AND ws.fields @> ARRAY['wearables'])`,
      [params.org_id],
    );
    const rows = await Promise.all(athletes.map(async (a) => {
      const latest = await one(
        `SELECT DISTINCT ON (metric_key) value, unit, recorded_on FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 ORDER BY metric_key, recorded_on DESC`,
        [a.id, q.metric_key],
      ).catch(() => null);
      const week = await many(
        `SELECT recorded_on, value FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on >= CURRENT_DATE-7 ORDER BY recorded_on`,
        [a.id, q.metric_key],
      );
      return { ...a, latest, week };
    }));
    return { metric_key: q.metric_key, rows };
  },
});

// ─── Coach: missing data report ───────────────────────────────────────────────
cap({
  name: 'get_missing_data_report',
  tag: TAG,
  summary: 'Which athletes are missing which data today, this week and this month.',
  method: 'GET', path: '/orgs/:org_id/data-hub/missing',
  input: z.object({ org_id: id }),
  output: z.object({ today: z.array(z.any()), this_week: z.array(z.any()), this_month: z.array(z.any()) }),
  async handler({ user, params }) {
    await shareBlock(user.id, params.org_id, 'wearables');
    const athletes = await many(
      `SELECT DISTINCT u.id, u.full_name FROM users u
       JOIN team_members tm ON tm.user_id=u.id JOIN teams t ON t.id=tm.team_id
       WHERE t.organisation_id=$1 AND tm.status='active'
         AND EXISTS (SELECT 1 FROM wellness_shares ws WHERE ws.athlete_id=u.id AND ws.org_id=$1 AND ws.status='active' AND ws.fields @> ARRAY['wearables'])`,
      [params.org_id],
    );
    const athleteIds = athletes.map((a) => a.id);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const withData = (since) =>
      many(
        `SELECT DISTINCT user_id FROM wearable_metrics WHERE user_id = ANY($1::uuid[]) AND recorded_on >= $2`,
        [athleteIds, since],
      );
    const [td, wk, mo] = await Promise.all([withData(today), withData(weekAgo), withData(monthAgo)]);
    const setOf = (rows) => new Set(rows.map((r) => r.user_id));
    const tdSet = setOf(td);
    const wkSet = setOf(wk);
    const moSet = setOf(mo);
    return {
      today: athletes.filter((a) => !tdSet.has(a.id)),
      this_week: athletes.filter((a) => !wkSet.has(a.id)),
      this_month: athletes.filter((a) => !moSet.has(a.id)),
    };
  },
});

// ─── Coach: session response ──────────────────────────────────────────────────
cap({
  name: 'get_session_response',
  tag: TAG,
  summary: 'Squad HRV, resting HR, sleep and wellness 48 h before vs after a training session.',
  method: 'GET', path: '/orgs/:org_id/data-hub/session-response/:session_id',
  input: z.object({ org_id: id, session_id: id }),
  output: z.object({ session: z.any(), metrics: z.array(z.any()) }),
  async handler({ user, params }) {
    await shareBlock(user.id, params.org_id, 'wearables');
    const session = await one(
      `SELECT id, start_time, name FROM sessions WHERE id=$1 AND organisation_id=$2`,
      [params.session_id, params.org_id],
    ).catch(() => null);
    if (!session) throw notFound();
    const athletes = await many(
      `SELECT DISTINCT u.id FROM users u
       JOIN team_members tm ON tm.user_id=u.id JOIN teams t ON t.id=tm.team_id
       WHERE t.organisation_id=$1 AND tm.status='active'
         AND EXISTS (SELECT 1 FROM wellness_shares ws WHERE ws.athlete_id=u.id AND ws.org_id=$1 AND ws.status='active' AND ws.fields @> ARRAY['wearables'])`,
      [params.org_id],
    );
    const athleteIds = athletes.map((a) => a.id);
    const sesDate = new Date(session.start_time);
    const before = new Date(sesDate.getTime() - 2 * 86400000).toISOString().slice(0, 10);
    const after = new Date(sesDate.getTime() + 2 * 86400000).toISOString().slice(0, 10);
    const sesDay = sesDate.toISOString().slice(0, 10);
    const metricsToCheck = ['hrv_rmssd', 'resting_hr', 'sleep_duration'];
    const rows = await many(
      `SELECT user_id, metric_key, recorded_on, value
       FROM wearable_metrics
       WHERE user_id = ANY($1::uuid[]) AND metric_key = ANY($2::text[])
         AND recorded_on BETWEEN $3 AND $4
       ORDER BY user_id, metric_key, recorded_on`,
      [athleteIds, metricsToCheck, before, after],
    );
    const metricSummary = metricsToCheck.map((mk) => {
      const pre = rows.filter((r) => r.metric_key === mk && String(r.recorded_on) < sesDay).map((r) => r.value);
      const post = rows.filter((r) => r.metric_key === mk && String(r.recorded_on) > sesDay).map((r) => r.value);
      const avg = (arr) => arr.length ? arr.reduce((a, b) => a + Number(b), 0) / arr.length : null;
      return { metric_key: mk, avg_pre: avg(pre), avg_post: avg(post) };
    });
    return { session, metrics: metricSummary };
  },
});
