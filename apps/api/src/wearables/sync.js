// Sync for athlete wearable connections (#583). Reuses the Integration Hub's guarded transport, scrubbing and backoff; the schedule is
// run by the same worker step (integrationSweep). Access is re-checked on every run: if the organisation's authorisation ended or the
// athlete revoked consent, nothing is fetched.
import { one, many, query } from '../db.js';
import { decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { send } from '../integrations/http.js';
import { scrub } from '../integrations/engine.js';
import { approvedAccess } from '../integrations/access.js';
import { METRICS, ADAPTERS, MAPPING_VERSION, normalise } from './normalise.js';

export const TOKEN_CTX = 'athlete_connections.token';
const DAY = 864e5;

/** Turn raw adapter rows into stored readings for the metrics the athlete allowed. Returns { stored, skipped_unmapped, skipped_not_granted }. */
export async function storeReadings(conn, rows) {
  const days = new Map();
  let notGranted = 0, unmapped = 0;
  for (const r of rows) {
    if (!METRICS[r.metric_key] || r.value === null || !/^\d{4}-\d{2}-\d{2}$/.test(r.on)) { unmapped++; continue; }
    if (!conn.metrics_granted.includes(r.metric_key)) { notGranted++; continue; }
    const n = normalise(r.metric_key, r.value, r.unit);
    if (!n) { unmapped++; continue; }
    const k = `${r.metric_key}|${r.on}`;
    const d = days.get(k) ?? { ...r, n: [], src: [], flags: new Set() };
    d.n.push(n.value); d.src.push(Number(r.value)); n.flags.forEach((f) => d.flags.add(f));
    days.set(k, d);
  }
  let stored = 0;
  for (const d of days.values()) {
    const m = METRICS[d.metric_key];
    const agg = (xs) => (m.agg === 'sum' ? xs.reduce((a, b) => a + b, 0) : xs.reduce((a, b) => a + b, 0) / xs.length);
    const value = Math.round(agg(d.n) * 1000) / 1000;
    const flags = new Set(d.flags);
    if (value < m.min || value > m.max) flags.add('out_of_range');
    await query(
      `INSERT INTO wearable_metrics(user_id, connection_id, provider_key, metric_key, recorded_on, value, unit, source_metric, source_value, source_unit, mapping_version, quality)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (connection_id, metric_key, recorded_on) DO UPDATE SET value=EXCLUDED.value, source_value=EXCLUDED.source_value, source_unit=EXCLUDED.source_unit, quality=EXCLUDED.quality, mapping_version=EXCLUDED.mapping_version, imported_at=now()`,
      [conn.user_id, conn.id, conn.provider_key, d.metric_key, d.on, value, m.unit, d.source_metric, Math.round(agg(d.src) * 1000) / 1000, d.unit ?? null, MAPPING_VERSION, [...flags]]);
    stored++;
  }
  return { stored, skipped_unmapped: unmapped, skipped_not_granted: notGranted };
}

/** Evaluate the athlete's own alert rules. A rule fires at most once per day; the message states the rule and the numbers. */
export async function evaluateAlerts(userId) {
  const rules = await many('SELECT * FROM wearable_alert_rules WHERE user_id=$1 AND active AND archived_at IS NULL', [userId]);
  let fired = 0;
  for (const r of rules) {
    const a = await one(`SELECT avg(value)::float AS v, max(recorded_on)::text AS on_day, count(*)::int AS n FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on > current_date - $3::int`, [userId, r.metric_key, r.window_days]);
    if (!a?.n) continue;
    const m = METRICS[r.metric_key];
    const breach = r.comparator === 'above' ? a.v > Number(r.threshold) : a.v < Number(r.threshold);
    if (!breach) continue;
    const round = Math.round(a.v * 10) / 10;
    const explanation = `Your ${r.window_days}-day average ${m.label.toLowerCase()} is ${round} ${m.unit}, ${r.comparator} the ${r.threshold} ${m.unit} you set. This is a reminder from your own rule, not a medical finding.`;
    const ins = await one('INSERT INTO wearable_alerts(rule_id, user_id, recorded_on, observed, explanation) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (rule_id, recorded_on) DO NOTHING RETURNING id', [r.id, userId, a.on_day, round, explanation]);
    if (ins) { fired++; await notify(null, userId, { kind: 'wearable_alert', title: 'Your device alert', body: explanation, data: { screen: 'Health' }, dedupe_key: `wearable_alert:${r.id}:${a.on_day}` }); }
  }
  return fired;
}

export async function syncConnection(connId, { manual = false } = {}) {
  const conn = await one('SELECT * FROM athlete_connections WHERE id=$1', [connId]);
  if (!conn || conn.status === 'revoked' || conn.status === 'paused') return { skipped: true };
  const ad = ADAPTERS[conn.provider_key];
  if (!ad?.path) return { skipped: true, reason: 'push_only' };
  let token = '';
  try {
    if (!(await approvedAccess(conn.organisation_id, conn.provider_key))) {
      await query("UPDATE athlete_connections SET status='paused', last_attempt_at=now(), last_error='Your organisation’s access to this provider has ended. Your data is kept.', next_sync_at=NULL, updated_at=now() WHERE id=$1", [conn.id]);
      return { ok: false, paused: true };
    }
    token = decrypt(conn.token_enc, TOKEN_CTX);
    const since = new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10);
    const r = await send('GET', `${ad.base}${ad.path}?start_date=${since}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('The provider rejected the connection; reconnect your account'), { permanent: true });
    if (r.status !== 200) throw new Error(`The provider answered ${r.status}`);
    let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('The provider did not return JSON'), { permanent: true }); }
    const summary = await storeReadings(conn, ad.parse(json));
    await query("UPDATE athlete_connections SET status='connected', last_success_at=now(), last_attempt_at=now(), last_error=NULL, last_summary=$2, next_sync_at=now() + make_interval(mins => sync_every_minutes), updated_at=now() WHERE id=$1", [conn.id, summary]);
    const alerts = await evaluateAlerts(conn.user_id);
    return { ok: true, summary, alerts };
  } catch (e) {
    const msg = scrub(e.message, { token });
    await query("UPDATE athlete_connections SET status='error', last_attempt_at=now(), last_error=$2, next_sync_at=now() + make_interval(mins => LEAST(sync_every_minutes, 60)), updated_at=now() WHERE id=$1", [conn.id, msg]);
    return { ok: false, error: msg, manual };
  }
}

export async function wearableSweep() {
  const due = await many("SELECT id FROM athlete_connections WHERE status IN ('connected','error') AND next_sync_at IS NOT NULL AND next_sync_at <= now() ORDER BY next_sync_at LIMIT 10");
  for (const d of due) await syncConnection(d.id);
  return { wearables_synced: due.length };
}
