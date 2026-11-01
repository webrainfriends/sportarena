// Growth analytics service (#73): consent, first-touch attribution, de-duplicated telemetry, reconciliation to canonical records, experiments
// (deterministic assignment, exposure records, outcome results), data-quality indicators and retention. Telemetry is never an input to a governed KPI
// (kpi/catalogue.js reads the canonical tables only), so a replayed or forged event cannot inflate activation, participation or revenue.
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, query, tx } from '../db.js';
import { conflict, forbidden, notFound, tooMany, unprocessable } from '../errors.js';
import { isYouth } from '../youth.js';
import { EVENTS, RECONCILERS, eventByKey } from './events.js';
import { OUTCOMES, OUTCOME_KEYS, outcomesSql, wilson } from './outcomes.js';

export const CONSENT_POLICY_VERSION = 1;
export const SOURCES = ['search', 'social', 'partner', 'campaign', 'email', 'event', 'other'];
const DAILY_CAP = 5000;            // events one person can record in 24 hours; a runaway client cannot flood the table
const MAX_AGE_MS = 7 * 864e5;      // an event older than this is not accepted (offline queues flush within days, not months)
const MAX_FUTURE_MS = 5 * 6e4;     // clock skew allowance
const RECONCILE_GRACE_MIN = 10;    // a claim is "unmatched" only after the server has had this long to commit the record

// ------------------------------------------------------------------------------------------------ consent
export async function getConsent(userId) {
  const youth = await isYouth(userId);
  const row = await one('SELECT granted, policy_version, decided_at FROM analytics_consents WHERE user_id=$1', [userId]);
  return { available: !youth, decided: !!row, granted: !youth && !!row?.granted, policy_version: CONSENT_POLICY_VERSION, decided_at: row?.decided_at ?? null, recorded_with_version: row?.policy_version ?? null };
}

/** Grant or withdraw. Withdrawing takes effect at once: the person's telemetry is de-identified and they drop out of every experiment result. */
export async function setConsent(userId, granted) {
  if (await isYouth(userId)) throw conflict('Product analytics is not used for young people, so there is nothing to switch on.');
  return tx(async (c) => {
    await c.query(
      `INSERT INTO analytics_consents(user_id, granted, policy_version) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET granted=EXCLUDED.granted, policy_version=EXCLUDED.policy_version, decided_at=now(), changes=analytics_consents.changes+1`, [userId, granted, CONSENT_POLICY_VERSION]);
    if (!granted) await c.query(`UPDATE analytics_events SET user_id=NULL, entity_id=NULL, properties='{}', deidentified_at=now() WHERE user_id=$1`, [userId]);
    return getConsentIn(c, userId);
  });
}
const getConsentIn = async (c, userId) => {
  const r = (await c.query('SELECT granted, policy_version, decided_at FROM analytics_consents WHERE user_id=$1', [userId])).rows[0];
  return { available: true, decided: true, granted: r.granted, policy_version: CONSENT_POLICY_VERSION, decided_at: r.decided_at, recorded_with_version: r.policy_version };
};
const canRecord = async (userId) => {
  if (await isYouth(userId)) return false;
  const r = await one('SELECT granted FROM analytics_consents WHERE user_id=$1', [userId]);
  return !!r?.granted;
};

// ------------------------------------------------------------------------------------------------ attribution
/** First touch wins and is never overwritten, so a later campaign cannot steal credit for a person who already arrived another way. */
export async function recordAttribution(userId, { source, campaign }) {
  if (!(await canRecord(userId))) return { recorded: false, reason: 'not_recorded' };
  const row = await one('INSERT INTO analytics_attributions(user_id, source, campaign) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING RETURNING source', [userId, source, campaign ?? null]);
  const have = row ?? (await one('SELECT source FROM analytics_attributions WHERE user_id=$1', [userId]));
  return { recorded: !!row, source: have.source };
}

// ------------------------------------------------------------------------------------------------ telemetry
/** Record a batch. Every event gets its own result so one bad event never loses the rest; replays are acknowledged, not stored twice. */
export async function recordEvents(userId, events) {
  const allowed = await canRecord(userId);
  const recent = allowed ? Number((await one(`SELECT count(*) AS n FROM analytics_events WHERE user_id=$1 AND received_at > now() - interval '24 hours'`, [userId])).n) : 0;
  if (recent >= DAILY_CAP) throw tooMany('Too many analytics events today; this is a limit on a single device.');
  const consentVersion = CONSENT_POLICY_VERSION;
  const results = [];
  for (const ev of events) {
    const def = eventByKey(ev.event_key);
    const out = (status, reason) => results.push({ dedupe_key: ev.dedupe_key, event_key: ev.event_key, status, ...(reason ? { reason } : {}) });
    if (!allowed) { out('dropped', 'not_recorded'); continue; }       // no consent / young person: nothing is stored, and the reason does not say which
    if (!def) { out('dropped', 'unknown_event'); continue; }
    if (ev.event_version !== undefined && ev.event_version !== def.version) { out('dropped', 'unsupported_version'); continue; }
    const t = Date.parse(ev.occurred_at);
    if (t > Date.now() + MAX_FUTURE_MS || t < Date.now() - MAX_AGE_MS) { out('dropped', 'bad_time'); continue; }
    const props = def.props.safeParse(ev.properties ?? {});
    if (!props.success) { out('dropped', 'invalid_properties'); continue; }
    if (ev.entity_type && !def.entities.includes(ev.entity_type)) { out('dropped', 'invalid_entity'); continue; }
    if (def.entities.length && ev.entity_type && !ev.entity_id) { out('dropped', 'invalid_entity'); continue; }
    if (!def.entities.length && (ev.entity_type || ev.entity_id)) { out('dropped', 'invalid_entity'); continue; }
    const r = await one(
      `INSERT INTO analytics_events(event_key, event_version, dedupe_key, user_id, occurred_at, platform, entity_type, entity_id, sport_id, properties, consent_version, reconcile_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (event_key, dedupe_key) DO UPDATE SET duplicate_count = analytics_events.duplicate_count + 1 WHERE analytics_events.user_id IS NOT DISTINCT FROM EXCLUDED.user_id
       RETURNING (xmax = 0) AS inserted`,
      [def.key, def.version, ev.dedupe_key, userId, new Date(t).toISOString(), ev.platform ?? 'web', ev.entity_type ?? null, ev.entity_id ?? null, ev.sport_id ?? null, JSON.stringify(props.data), consentVersion, def.reconcile ? 'pending' : 'not_applicable']);
    out(r?.inserted ? 'accepted' : 'duplicate');
  }
  return { results, accepted: results.filter((r) => r.status === 'accepted').length, duplicates: results.filter((r) => r.status === 'duplicate').length, dropped: results.filter((r) => r.status === 'dropped').length };
}

/** Check each pending claim against the canonical record. Matched at once; unmatched only once the server has had time to commit it. */
export async function reconcileEvents() {
  let matched = 0, unmatched = 0;
  for (const def of EVENTS.filter((e) => e.reconcile)) {
    for (const [entityType, name] of Object.entries(def.reconcile)) {
      const sql = RECONCILERS[name];
      const m = await query(`UPDATE analytics_events ev SET reconcile_state='matched', reconciled_at=now() WHERE ev.event_key=$1 AND ev.entity_type=$2 AND ev.reconcile_state='pending' AND ev.user_id IS NOT NULL AND ev.entity_id IS NOT NULL AND EXISTS (${sql.replace('$1', 'ev.entity_id').replace('$2', 'ev.user_id')})`, [def.key, entityType]);
      matched += m.rowCount;
    }
    const u = await query(`UPDATE analytics_events SET reconcile_state='unmatched', reconciled_at=now() WHERE event_key=$1 AND reconcile_state='pending' AND received_at < now() - make_interval(mins => $2::int)`, [def.key, RECONCILE_GRACE_MIN]);
    unmatched += u.rowCount;
  }
  return { matched, unmatched };
}

/** Retention: past the window the person link, entity and properties are removed. The row and the counts it contributed to are kept (nothing is deleted). */
export async function deidentifyExpiredEvents(days = config.analyticsRetentionDays) {
  const r = await query(`UPDATE analytics_events SET user_id=NULL, entity_id=NULL, properties='{}', deidentified_at=now() WHERE deidentified_at IS NULL AND occurred_at < now() - make_interval(days => $1::int)`, [days]);
  return r.rowCount;
}
export const growthMaintenance = async () => ({ ...(await reconcileEvents()), deidentified: await deidentifyExpiredEvents() });

// ------------------------------------------------------------------------------------------------ data quality
export async function dataQuality() {
  const t = await one(`SELECT count(*)::int AS total, coalesce(sum(duplicate_count),0)::int AS duplicates, max(received_at) AS latest,
      count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS last_24h, count(*) FILTER (WHERE deidentified_at IS NOT NULL)::int AS deidentified,
      min(occurred_at) FILTER (WHERE deidentified_at IS NULL) AS oldest_identified FROM analytics_events`);
  const rec = await many(`SELECT event_key, count(*) FILTER (WHERE reconcile_state='matched')::int AS matched, count(*) FILTER (WHERE reconcile_state='unmatched')::int AS unmatched, count(*) FILTER (WHERE reconcile_state='pending')::int AS pending
      FROM analytics_events WHERE reconcile_state <> 'not_applicable' GROUP BY event_key ORDER BY event_key`);
  const c = await one(`SELECT count(*) FILTER (WHERE granted)::int AS granted, count(*) FILTER (WHERE NOT granted)::int AS withdrawn FROM analytics_consents`);
  const users = Number((await one('SELECT count(*) AS n FROM users')).n);
  const ageH = t.latest ? Math.floor((Date.now() - new Date(t.latest).getTime()) / 36e5) : null;
  const decided = rec.reduce((a, r) => a + r.matched + r.unmatched, 0), bad = rec.reduce((a, r) => a + r.unmatched, 0);
  const warnings = [];
  if (!t.total) warnings.push({ code: 'no_events', severity: 'info', text: 'No telemetry has been recorded yet. Nothing is recorded for a person until they switch analytics on.' });
  else if (ageH > 48) warnings.push({ code: 'stale', severity: 'warn', text: `The newest event arrived ${Math.floor(ageH / 24)} days ago. Check that the apps are sending events.` });
  if (decided && bad / decided > 0.05) warnings.push({ code: 'unreconciled', severity: 'warn', text: `${bad} of ${decided} checked events do not match a booking, game or payment on record (${Math.round((bad / decided) * 100)}%). Treat funnel counts with care.` });
  return {
    telemetry: { events: t.total, last_24h: t.last_24h, replays_ignored: t.duplicates, replay_rate: t.total + t.duplicates ? Math.round((t.duplicates / (t.total + t.duplicates)) * 1000) / 10 : 0, latest_at: t.latest, age_hours: ageH, freshness: !t.total ? 'no_records' : ageH > 48 ? 'stale' : 'current' },
    reconciliation: rec, consent: { granted: c.granted, withdrawn: c.withdrawn, people: users, coverage_percent: users ? Math.round((c.granted / users) * 1000) / 10 : 0 },
    retention: { days: config.analyticsRetentionDays, deidentified: t.deidentified, oldest_identified_at: t.oldest_identified }, warnings,
  };
}

// ------------------------------------------------------------------------------------------------ experiments
const COLS = 'id, key, name, hypothesis, status, variants, success_metric, guardrails, min_sample, window_days, owner_id, started_at, ended_at, conclusion, row_version, created_at, updated_at';
export const outcomeCatalogue = () => OUTCOME_KEYS.map((k) => ({ key: k, label: OUTCOMES[k].label, better: OUTCOMES[k].better }));

export function assignVariant(key, userId, variants) {
  const total = variants.reduce((a, v) => a + v.weight, 0);
  let n = createHash('sha256').update(`${key}:${userId}`).digest().readUInt32BE(0) % total;
  for (const v of variants) { if (n < v.weight) return v.key; n -= v.weight; }
  return variants[0].key;
}

export async function loadExperiment(idOrKey) {
  const isId = /^[0-9a-f-]{36}$/.test(idOrKey);
  return one(`SELECT ${COLS} FROM experiments WHERE ${isId ? 'id' : 'key'}=$1`, [idOrKey]);
}

/** Show a person an experiment. Assignment never changes; the exposure is recorded once (later calls only raise the count) and only with consent. */
export async function expose(userId, expKey) {
  const e = await loadExperiment(expKey);
  if (!e) throw notFound('Experiment');
  const control = e.variants[0].key;
  if (e.status !== 'running') return { experiment: e.key, variant: control, active: false, recorded: false };
  if (await isYouth(userId)) return { experiment: e.key, variant: control, active: true, recorded: false };   // young people always get the standard experience
  const variant = assignVariant(e.key, userId, e.variants);
  if (!(await canRecord(userId))) return { experiment: e.key, variant, active: true, recorded: false };
  const r = await one(
    `INSERT INTO experiment_exposures(experiment_id, user_id, variant) VALUES ($1,$2,$3)
     ON CONFLICT (experiment_id, user_id) DO UPDATE SET exposure_count = experiment_exposures.exposure_count + 1, last_exposed_at = now() RETURNING variant, (xmax = 0) AS first`, [e.id, userId, variant]);
  return { experiment: e.key, variant: r.variant, active: true, recorded: true, first_exposure: r.first };
}

/** Per variant: who was exposed, who has finished their window, and how the success and guardrail outcomes look — with an interval, never a bare percentage. */
export async function experimentResults(e) {
  const keys = [e.success_metric, ...e.guardrails];
  const rows = (await pool.query(outcomesSql(keys), [e.id, e.window_days])).rows;
  const by = new Map(rows.map((r) => [r.variant, r]));
  const variants = e.variants.map((v) => {
    const r = by.get(v.key) ?? { exposed: 0, mature: 0 };
    return { key: v.key, weight: v.weight, control: v.key === e.variants[0].key, exposed: r.exposed, mature: r.mature, maturing: r.exposed - r.mature,
      outcomes: Object.fromEntries(keys.map((k) => [k, { successes: r[`o_${k}`] ?? 0, ...wilson(r[`o_${k}`] ?? 0, r.mature) }])) };
  });
  const ctl = variants[0];
  const enough = variants.every((v) => v.mature >= e.min_sample);
  const compare = (k) => variants.slice(1).map((v) => {
    const a = v.outcomes[k], b = ctl.outcomes[k];
    const diff = a.rate == null || b.rate == null ? null : Math.round((a.rate - b.rate) * 10) / 10;
    const clear = a.rate != null && b.rate != null && (a.low > b.high || a.high < b.low);
    const worse = clear && (OUTCOMES[k].better === 'higher' ? a.rate < b.rate : a.rate > b.rate);
    return { variant: v.key, difference_points: diff, clear_difference: clear, worse_than_control: worse };
  });
  const success = { metric: e.success_metric, label: OUTCOMES[e.success_metric].label, better: OUTCOMES[e.success_metric].better, vs_control: compare(e.success_metric) };
  const guardrails = e.guardrails.map((k) => ({ metric: k, label: OUTCOMES[k].label, better: OUTCOMES[k].better, vs_control: compare(k), breached: compare(k).some((x) => x.worse_than_control) }));
  const warnings = [];
  if (!enough) warnings.push({ code: 'insufficient_data', severity: 'info', text: `Each variant needs at least ${e.min_sample} people who have finished their ${e.window_days}-day window before a difference means anything. Until then, treat the numbers as indications.` });
  if (guardrails.some((g) => g.breached)) warnings.push({ code: 'guardrail_breached', severity: 'warn', text: 'A guardrail is clearly worse than the control. Consider stopping this experiment.' });
  return { experiment: { id: e.id, key: e.key, name: e.name, status: e.status, window_days: e.window_days, min_sample: e.min_sample }, ready: enough, variants, success, guardrails, warnings,
    basis: 'Only people who switched analytics on and have finished their window are counted. Outcomes come from bookings, games and payments on record, never from app events.' };
}

export const mustBeOperator = (user) => { if (!user?.roles?.includes('admin')) throw forbidden('Growth analytics is limited to the platform operators'); };
export { COLS as EXPERIMENT_COLS, unprocessable };
