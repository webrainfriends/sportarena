// Athlete Performance Integration Hub (#583). One capability set for REST, OpenAPI and MCP. It extends the Integration Hub (the organisation is
// authorised through integration_access_requests) and wellness sharing (a coach sees wearable data only through a live share that includes
// the `wearables` field). Nothing here diagnoses, clears or screens an athlete: readings are descriptive and alerts are the athlete's own rules.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { requireConsent } from '../youth.js';
import { requireHealthNotice } from '../health-governance.js';
import { approvedAccess } from '../integrations/access.js';
import { PROVIDERS } from '../integrations/registry.js';
import { METRICS, ADAPTERS } from '../wearables/normalise.js';
import { storeReadings, syncConnection, evaluateAlerts, TOKEN_CTX } from '../wearables/sync.js';
import { shareBlock, shareEvent, reasonText } from '../wellness-sharing.js';
import { computeACWR, computeReadiness } from '../wearables/acwr.js';

const TAG = 'Athlete health';
const NOT_MEDICAL = 'Descriptive readings from the athlete\'s own devices. Not a diagnosis, medical advice or clearance to train or play; missing days are never estimated.';
const metricKey = z.enum(Object.keys(METRICS));
const wearableProviders = () => Object.entries(PROVIDERS).filter(([, p]) => p.athlete_scoped);
const COLS = 'id, organisation_id, provider_key, status, metrics_granted, sync_every_minutes, next_sync_at, last_success_at, last_attempt_at, last_error, last_summary, consent_at, revoked_at, version, created_at';
const shape = (r) => ({ ...r, provider_name: PROVIDERS[r.provider_key]?.name ?? r.provider_key, push_only: !ADAPTERS[r.provider_key]?.path });
// organisations the person belongs to: staff membership, a team of the organisation, or a cohort enrolment
const ORGS_SQL = `SELECT o.id, o.name FROM organisations o WHERE o.status='active' AND (
  EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=o.id AND m.user_id=$1 AND m.status='active')
  OR EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.organisation_id=o.id AND tm.user_id=$1 AND tm.status='active')
  OR EXISTS (SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=o.id AND e.user_id=$1 AND e.status='enrolled'))`;
const round = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);

async function mine(user, connId, c = { query }) {
  const r = (await c.query('SELECT * FROM athlete_connections WHERE id=$1 AND user_id=$2', [connId, user.id])).rows[0];
  if (!r) throw notFound('Connection'); // never reveal someone else's connection
  return r;
}

cap({
  name: 'list_wearable_providers', method: 'GET', path: '/me/wearables/providers', tag: TAG,
  summary: 'Providers you can connect, per organisation you belong to. A provider is listed as enabled only once the platform team has authorised your organisation for it. Also returns the canonical metrics and their units.',
  input: z.object({}),
  async handler({ user }) {
    const orgs = await many(`${ORGS_SQL} ORDER BY o.name`, [user.id]);
    const out = [];
    for (const o of orgs) {
      const providers = [];
      for (const [key, p] of wearableProviders()) providers.push({ key, name: p.name, auth: p.auth, scopes: p.scopes, push_only: !ADAPTERS[key]?.path, enabled: !!(await approvedAccess(o.id, key)) });
      out.push({ organisation_id: o.id, organisation_name: o.name, providers });
    }
    return { organisations: out, metrics: Object.entries(METRICS).map(([key, m]) => ({ key, label: m.label, unit: m.unit })), basis: NOT_MEDICAL };
  },
});

cap({
  name: 'connect_wearable', method: 'POST', path: '/me/wearables', tag: TAG, status: 201,
  summary: 'Connect your own account for a provider your organisation is authorised to use, choosing exactly which metrics may be imported. You must accept the provider\'s scopes. The access token is encrypted and never returned. A young athlete needs a guardian\'s current medical-data consent.',
  input: z.object({
    organisation_id: id, provider_key: z.string().max(40), metrics: z.array(metricKey).min(1).max(Object.keys(METRICS).length),
    accept_scopes: z.array(z.string().max(80)).max(10), access_token: z.string().min(8).max(2000).describe('the token your provider returned after you signed in there; encrypted at rest'),
    sync_every_minutes: z.number().int().min(15).max(10080).default(360),
  }),
  async handler({ user }, i) {
    const p = PROVIDERS[i.provider_key];
    if (!p?.athlete_scoped) throw notFound('Provider');
    if (!(await one(`${ORGS_SQL} AND o.id=$2`, [user.id, i.organisation_id]))) throw notFound('Organisation');
    if (!(await approvedAccess(i.organisation_id, i.provider_key))) throw forbidden('Your organisation has not been authorised for this provider. An organisation admin can request access in the Integration Hub.');
    const missing = p.scopes.map((s) => s.key).filter((k) => !i.accept_scopes.includes(k));
    if (missing.length) throw badRequest(`Accept the requested permissions first: ${missing.join(', ')}`);
    await requireHealthNotice(user.id);
    await requireConsent(user.id, 'medical', 'connecting a wearable', null);
    const metrics = [...new Set(i.metrics)];
    return tx(async (c) => {
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      if ((await c.query("SELECT 1 FROM athlete_connections WHERE user_id=$1 AND provider_key=$2 AND status <> 'revoked'", [user.id, i.provider_key])).rows.length) throw conflict('You already have this provider connected. Edit or disconnect it first.', { code: 'connection_exists' });
      const r = (await c.query(`INSERT INTO athlete_connections(user_id, organisation_id, provider_key, metrics_granted, token_enc, sync_every_minutes, next_sync_at)
        VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7 THEN now() END) RETURNING ${COLS}`, [user.id, i.organisation_id, i.provider_key, metrics, encrypt(i.access_token, TOKEN_CTX), i.sync_every_minutes, !!ADAPTERS[i.provider_key]?.path])).rows[0];
      await audit(c, user.id, 'connect_wearable', 'athlete_connections', r.id);
      return shape(r);
    });
  },
});

cap({
  name: 'list_wearable_connections', method: 'GET', path: '/me/wearables', tag: TAG,
  summary: 'Your connected providers with status, what you allowed, last sync, last error and the next scheduled sync. Revoked connections are kept for history.',
  input: z.object({ include_revoked: z.boolean().default(false) }),
  async handler({ user }, i) {
    return { items: (await many(`SELECT ${COLS} FROM athlete_connections WHERE user_id=$1 AND ($2 OR status <> 'revoked') ORDER BY created_at DESC`, [user.id, i.include_revoked])).map(shape) };
  },
});

cap({
  name: 'update_wearable_consent', method: 'PATCH', path: '/me/wearables/:id', tag: TAG,
  summary: 'Change which metrics are imported, pause or resume, or change how often it syncs. Send the `version` you last saw. Narrowing takes effect on the next sync; metrics already imported stay in your history.',
  input: z.object({ id, version: z.number().int().min(1), metrics: z.array(metricKey).min(1).optional(), paused: z.boolean().optional(), sync_every_minutes: z.number().int().min(15).max(10080).optional() }),
  async handler({ user }, i) {
    if (i.metrics === undefined && i.paused === undefined && i.sync_every_minutes === undefined) throw badRequest('Nothing to change');
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM athlete_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r) throw notFound('Connection');
      if (r.status === 'revoked') throw conflict('This connection was disconnected. Connect again to resume.');
      if (r.version !== i.version) throw conflict('This connection changed since you opened it. Reload and try again.', { code: 'stale_version', version: r.version });
      const status = i.paused === undefined ? r.status : i.paused ? 'paused' : 'connected';
      const u = (await c.query(`UPDATE athlete_connections SET metrics_granted=coalesce($2::text[], metrics_granted), status=$3, sync_every_minutes=coalesce($4::int, sync_every_minutes),
        next_sync_at = CASE WHEN $3='paused' THEN NULL WHEN $3='connected' AND next_sync_at IS NULL THEN now() ELSE next_sync_at END, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${COLS}`,
      [r.id, i.metrics ? [...new Set(i.metrics)] : null, status, i.sync_every_minutes ?? null])).rows[0];
      await audit(c, user.id, 'update_wearable_consent', 'athlete_connections', r.id);
      return shape(u);
    });
  },
});

cap({
  name: 'disconnect_wearable', method: 'POST', path: '/me/wearables/:id/disconnect', tag: TAG,
  summary: 'Disconnect a provider. Syncing stops at once and the stored access token is erased. What was already imported stays in your history. Repeating it is harmless.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM athlete_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r) throw notFound('Connection');
      if (r.status === 'revoked') return { id: r.id, status: 'revoked', revoked_at: r.revoked_at };
      const u = (await c.query("UPDATE athlete_connections SET status='revoked', revoked_at=now(), token_enc=NULL, next_sync_at=NULL, version=version+1, updated_at=now() WHERE id=$1 RETURNING revoked_at", [r.id])).rows[0];
      await audit(c, user.id, 'disconnect_wearable', 'athlete_connections', r.id);
      return { id: r.id, status: 'revoked', revoked_at: u.revoked_at };
    });
  },
});

cap({
  name: 'sync_wearable', method: 'POST', path: '/me/wearables/:id/sync', tag: TAG,
  summary: 'Sync now (also the retry after an error). Returns what was stored and what was skipped; a failure is recorded on the connection with a plain-language message.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await mine(user, i.id);
    if (r.status === 'revoked') throw conflict('This connection was disconnected');
    if (r.status === 'paused') throw conflict('This connection is paused. Resume it first.');
    if (!ADAPTERS[r.provider_key]?.path) throw badRequest('This provider sends readings from its app; there is nothing to pull');
    return syncConnection(r.id, { manual: true });
  },
});

cap({
  name: 'push_wearable_readings', method: 'POST', path: '/me/wearables/:id/readings', tag: TAG, status: 201,
  summary: 'Send readings from the device app (Apple Health, Health Connect). Each reading names a canonical metric, a value and a unit; units are converted and anything outside what you allowed is skipped, not stored.',
  input: z.object({ id, readings: z.array(z.object({ metric: metricKey, value: z.number(), unit: z.string().max(12), date: z.string().date() })).min(1).max(500) }),
  async handler({ user }, i) {
    const r = await mine(user, i.id);
    if (r.provider_key !== 'device_push') throw badRequest('Only the device-app connection accepts pushed readings');
    if (r.status !== 'connected') throw conflict('This connection is not active');
    const summary = await storeReadings(r, ADAPTERS.device_push.parse({ readings: i.readings }));
    await query("UPDATE athlete_connections SET last_success_at=now(), last_attempt_at=now(), last_error=NULL, last_summary=$2, updated_at=now() WHERE id=$1", [r.id, summary]);
    await evaluateAlerts(user.id);
    return summary;
  },
});

// ---------- personal dashboard (own data only) ----------

cap({
  name: 'get_wearable_trend', method: 'GET', path: '/me/wearables/trend', tag: TAG,
  summary: 'Your own daily series for one metric (canonical unit) with the provider and the vendor\'s original value and unit for each point, plus the average of the period.',
  input: z.object({ metric: metricKey, days: z.coerce.number().int().min(7).max(365).default(30) }),
  async handler({ user }, i) {
    const points = await many(`SELECT recorded_on::text AS date, value::float AS value, unit, provider_key, source_metric, source_value::float AS source_value, source_unit, quality FROM wearable_metrics
      WHERE user_id=$1 AND metric_key=$2 AND recorded_on > current_date - $3::int ORDER BY recorded_on`, [user.id, i.metric, i.days]);
    const m = METRICS[i.metric];
    return { metric: i.metric, label: m.label, unit: m.unit, days: i.days, points, average: points.length ? round(points.reduce((a, p) => a + p.value, 0) / points.length) : null, basis: NOT_MEDICAL };
  },
});

cap({
  name: 'get_wearable_quality', method: 'GET', path: '/me/wearables/quality', tag: TAG,
  summary: 'Data-quality indicators per connected provider and metric over the last 14 days: days with data, missing days, out-of-range readings, a stale or failing sync. Missing data is reported, never filled in.',
  input: z.object({}),
  async handler({ user }) {
    const conns = await many("SELECT * FROM athlete_connections WHERE user_id=$1 AND status <> 'revoked'", [user.id]);
    const items = [];
    for (const c of conns) {
      const stale = c.status === 'connected' && ADAPTERS[c.provider_key]?.path && (!c.last_success_at || Date.now() - new Date(c.last_success_at).getTime() > 2 * c.sync_every_minutes * 60000);
      const metrics = [];
      for (const k of c.metrics_granted) {
        const a = await one("SELECT count(*)::int AS have, count(*) FILTER (WHERE 'out_of_range' = ANY(quality))::int AS out_of_range, max(recorded_on)::text AS latest FROM wearable_metrics WHERE connection_id=$1 AND metric_key=$2 AND recorded_on > current_date - 14", [c.id, k]);
        const warnings = [];
        if (a.have < 14) warnings.push('missing_days');
        if (a.out_of_range) warnings.push('out_of_range');
        if (!a.have) warnings.push('no_data');
        metrics.push({ metric: k, label: METRICS[k].label, days_with_data: a.have, missing_days: 14 - a.have, out_of_range: a.out_of_range, latest: a.latest, warnings });
      }
      items.push({ connection_id: c.id, provider_key: c.provider_key, provider_name: PROVIDERS[c.provider_key]?.name, status: c.status, last_success_at: c.last_success_at, last_error: c.last_error, stale: !!stale, metrics });
    }
    return { window_days: 14, items };
  },
});

cap({
  name: 'get_my_wearable_dashboard', method: 'GET', path: '/me/wearables/dashboard', tag: TAG,
  summary: 'Your own latest reading per metric, the change of the last 7 days against your previous 28, and your recent alerts. Only your data; no comparison with other athletes.',
  input: z.object({}),
  async handler({ user }) {
    const tiles = [];
    for (const [k, m] of Object.entries(METRICS)) {
      const a = await one(`SELECT (SELECT value::float FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 ORDER BY recorded_on DESC LIMIT 1) AS latest,
        (SELECT recorded_on::text FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 ORDER BY recorded_on DESC LIMIT 1) AS latest_on,
        (SELECT avg(value)::float FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on > current_date - 7) AS last7,
        (SELECT avg(value)::float FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on <= current_date - 7 AND recorded_on > current_date - 35) AS prev28`, [user.id, k]);
      if (a.latest === null) continue;
      tiles.push({ metric: k, label: m.label, unit: m.unit, latest: round(a.latest), latest_on: a.latest_on, avg_7d: round(a.last7), avg_prev_28d: round(a.prev28), change: a.last7 !== null && a.prev28 !== null ? round(a.last7 - a.prev28) : null });
    }
    const alerts = await many('SELECT a.id, a.recorded_on::text AS date, a.observed::float AS observed, a.explanation, r.metric_key, r.comparator, r.threshold::float AS threshold FROM wearable_alerts a JOIN wearable_alert_rules r ON r.id=a.rule_id WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 10', [user.id]);
    return { tiles, alerts, basis: NOT_MEDICAL };
  },
});

// ---------- configurable alerts with transparent thresholds ----------

const rule = z.object({ metric: metricKey, comparator: z.enum(['above', 'below']), threshold: z.number(), window_days: z.number().int().min(1).max(28).default(1) });
const ruleText = (r) => `Tell me when my ${r.window_days}-day average ${METRICS[r.metric_key].label.toLowerCase()} is ${r.comparator} ${Number(r.threshold)} ${METRICS[r.metric_key].unit}`;
const ruleShape = (r) => ({ id: r.id, metric: r.metric_key, comparator: r.comparator, threshold: Number(r.threshold), window_days: r.window_days, active: r.active, rule: ruleText(r) });

cap({
  name: 'create_wearable_alert_rule', method: 'POST', path: '/me/wearables/alert-rules', tag: TAG, status: 201,
  summary: 'Set your own alert: notify me when the average of a metric over N days goes above or below a number you choose. The rule is shown in plain words and each alert quotes it. Alerts are reminders, never a medical finding.',
  input: rule,
  async handler({ user }, i) {
    const m = METRICS[i.metric];
    if (i.threshold < m.min || i.threshold > m.max) throw badRequest(`Choose a threshold between ${m.min} and ${m.max} ${m.unit}`);
    if ((await one('SELECT count(*)::int AS n FROM wearable_alert_rules WHERE user_id=$1 AND archived_at IS NULL', [user.id])).n >= 20) throw conflict('You can keep up to 20 alert rules; archive one first');
    const r = await one('INSERT INTO wearable_alert_rules(user_id, metric_key, comparator, threshold, window_days) VALUES ($1,$2,$3,$4,$5) RETURNING *', [user.id, i.metric, i.comparator, i.threshold, i.window_days]);
    return ruleShape(r);
  },
});

cap({
  name: 'list_wearable_alert_rules', method: 'GET', path: '/me/wearables/alert-rules', tag: TAG,
  summary: 'Your alert rules in plain words.', input: z.object({}),
  async handler({ user }) { return { items: (await many('SELECT * FROM wearable_alert_rules WHERE user_id=$1 AND archived_at IS NULL ORDER BY created_at', [user.id])).map(ruleShape) }; },
});

cap({
  name: 'update_wearable_alert_rule', method: 'PATCH', path: '/me/wearables/alert-rules/:id', tag: TAG,
  summary: 'Change, switch off, or archive one of your alert rules. Archiving keeps past alerts.',
  input: z.object({ id, threshold: z.number().optional(), comparator: z.enum(['above', 'below']).optional(), window_days: z.number().int().min(1).max(28).optional(), active: z.boolean().optional(), archive: z.boolean().optional() }),
  async handler({ user }, i) {
    const r = await one('SELECT * FROM wearable_alert_rules WHERE id=$1 AND user_id=$2 AND archived_at IS NULL', [i.id, user.id]);
    if (!r) throw notFound('Alert rule');
    const m = METRICS[r.metric_key];
    if (i.threshold !== undefined && (i.threshold < m.min || i.threshold > m.max)) throw badRequest(`Choose a threshold between ${m.min} and ${m.max} ${m.unit}`);
    const u = await one(`UPDATE wearable_alert_rules SET threshold=coalesce($2,threshold), comparator=coalesce($3,comparator), window_days=coalesce($4,window_days), active=coalesce($5,active),
      archived_at = CASE WHEN $6 THEN now() ELSE archived_at END, updated_at=now() WHERE id=$1 RETURNING *`, [r.id, i.threshold ?? null, i.comparator ?? null, i.window_days ?? null, i.active ?? null, !!i.archive]);
    return ruleShape(u);
  },
});

// ---------- coach team dashboard (only through live shares that include `wearables`) ----------

cap({
  name: 'get_team_wearable_overview', method: 'GET', path: '/wearables/team', tag: TAG,
  summary: 'Coach: wearable load and recovery inputs for the athletes who currently share `wearables` with you. Each athlete is re-checked live (share, coaching relationship, guardian consent); only metrics the athlete allowed are shown and each view is logged and visible to the athlete. Athletes who stopped sharing simply do not appear.',
  input: z.object({ days: z.coerce.number().int().min(7).max(90).default(28) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const shares = (await c.query("SELECT s.* FROM wellness_shares s WHERE s.recipient_id=$1 AND s.recipient_kind='coach' AND s.revoked_at IS NULL AND s.expires_at > now() AND 'wearables' = ANY(s.fields) ORDER BY s.created_at", [user.id])).rows;
      const athletes = [], unavailable = [];
      for (const s of shares) {
        const block = await shareBlock(c, s);
        const who = (await c.query('SELECT id, display_name, handle FROM users WHERE id=$1', [s.athlete_id])).rows[0];
        if (block) { unavailable.push({ athlete: who, reason: reasonText(block) }); continue; }
        const days = Math.min(i.days, s.history_days);
        const conns = (await c.query("SELECT provider_key, status, last_success_at, metrics_granted FROM athlete_connections WHERE user_id=$1 AND status <> 'revoked'", [s.athlete_id])).rows;
        const allowed = [...new Set(conns.flatMap((x) => x.metrics_granted))];
        const metrics = [];
        for (const k of allowed) {
          const a = (await c.query(`SELECT (SELECT value::float FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on > current_date - $3::int ORDER BY recorded_on DESC LIMIT 1) AS latest,
            (SELECT avg(value)::float FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on > current_date - 7) AS last7,
            (SELECT avg(value)::float FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on <= current_date - 7 AND recorded_on > current_date - $3::int) AS prev,
            (SELECT count(*)::int FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on > current_date - $3::int) AS have`, [s.athlete_id, k, days])).rows[0];
          metrics.push({ metric: k, label: METRICS[k].label, unit: METRICS[k].unit, latest: round(a.latest), avg_7d: round(a.last7), avg_prior: round(a.prev), change: a.last7 !== null && a.prev !== null ? round(a.last7 - a.prev) : null, days_with_data: a.have, missing_days: days - a.have });
        }
        await shareEvent(c, s, user.id, 'viewed', { wearables: true, days });
        await audit(c, user.id, 'read_wearables_shared', 'wellness_shares', s.id);
        athletes.push({ athlete: who, share_id: s.id, window_days: days, providers: conns.map((x) => ({ provider_key: x.provider_key, status: x.status, last_success_at: x.last_success_at })), metrics });
      }
      return { athletes, unavailable, basis: NOT_MEDICAL };
    });
  },
});

// ---- Connected devices (#327) —- athlete-scoped device management --------------------------
// OAuth tokens are AES-256-GCM encrypted at rest. Data is NEVER hard-deleted: archived_at or status='unlinked'.

cap({
  name: 'list_connected_devices', method: 'GET', path: '/me/devices', tag: TAG,
  summary: 'Your connected health platforms and wearables: provider, last-sync, battery where available, status.',
  input: z.object({}),
  async handler({ user }) {
    return many(
      `SELECT id, provider, display_name, last_sync_at, battery_pct, status, paused_at, created_at
       FROM connected_devices WHERE user_id=$1 AND archived_at IS NULL ORDER BY created_at ASC`,
      [user.id]);
  },
});

cap({
  name: 'connect_device', method: 'POST', path: '/me/devices', tag: TAG, status: 201,
  summary: 'Connect a health platform or wearable device. OAuth token stored encrypted; re-connecting an existing provider updates its token.',
  input: z.object({
    provider: z.enum(['apple_health','google_fit','garmin','polar','whoop','fitbit','suunto']),
    display_name: z.string().max(100).optional(),
    oauth_token: z.string().max(4096).optional(),
    oauth_token_expiry: z.string().datetime().optional(),
  }),
  async handler({ user }, { provider, display_name, oauth_token, oauth_token_expiry }) {
    const token_enc = oauth_token ? encrypt(oauth_token, `device:token:${user.id}:${provider}`) : null;
    const device = await one(
      `INSERT INTO connected_devices (user_id, provider, display_name, token_enc, token_expiry, status)
       VALUES ($1,$2,$3,$4,$5,'active')
       ON CONFLICT (user_id, provider) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, connected_devices.display_name),
         token_enc    = COALESCE(EXCLUDED.token_enc, connected_devices.token_enc),
         token_expiry = COALESCE(EXCLUDED.token_expiry, connected_devices.token_expiry),
         status       = 'active',
         paused_at    = NULL,
         archived_at  = NULL
       RETURNING id, provider, display_name, status, created_at`,
      [user.id, provider, display_name || provider, token_enc, oauth_token_expiry || null]);
    await audit(null, user.id, 'device_connected', 'connected_devices', device.id);
    return device;
  },
});

cap({
  name: 'disconnect_device', method: 'DELETE', path: '/me/devices/:id', tag: TAG,
  summary: 'Revoke a device connection. Tokens are wiped; all historical data is kept (soft-delete via status=unlinked).',
  input: z.object({ id }),
  async handler({ user }, { id: devId }) {
    const device = await one(
      `UPDATE connected_devices SET status='unlinked', token_enc=NULL, archived_at=now()
       WHERE id=$1 AND user_id=$2 AND archived_at IS NULL RETURNING id, provider`,
      [devId, user.id]);
    if (!device) throw notFound('Device');
    await audit(null, user.id, 'device_disconnected', 'connected_devices', devId);
    return { id: devId, disconnected: true };
  },
});

cap({
  name: 'pause_device_sync', method: 'PATCH', path: '/me/devices/:id', tag: TAG,
  summary: 'Pause or resume sync for a connected device without revoking the token.',
  input: z.object({ id, paused: z.boolean() }),
  async handler({ user }, { id: devId, paused }) {
    const device = await one(
      `UPDATE connected_devices SET paused_at=$1, status=$2
       WHERE id=$3 AND user_id=$4 AND archived_at IS NULL RETURNING id, status`,
      [paused ? new Date() : null, paused ? 'paused' : 'active', devId, user.id]);
    if (!device) throw notFound('Device');
    return { id: devId, paused };
  },
});

cap({
  name: 'get_device_sync_history', method: 'GET', path: '/me/devices/:id/history', tag: TAG,
  summary: 'Device detail + recent activities (default 7 days, up to 90).',
  input: z.object({ id, days: z.coerce.number().int().min(1).max(90).default(7) }),
  async handler({ user }, { id: devId, days }) {
    const device = await one(
      `SELECT id, provider, display_name, last_sync_at, battery_pct, status
       FROM connected_devices WHERE id=$1 AND user_id=$2 AND archived_at IS NULL`,
      [devId, user.id]);
    if (!device) throw notFound('Device');
    const activities = await many(
      `SELECT id, activity_type, started_at, ended_at, metrics, source
       FROM device_activities
       WHERE device_id=$1 AND started_at >= now() - ($2 || ' days')::interval AND archived_at IS NULL
       ORDER BY started_at DESC LIMIT 100`,
      [devId, days]);
    return { device, activities, days, basis: NOT_MEDICAL };
  },
});

cap({
  name: 'manual_activity_import', method: 'POST', path: '/me/activities/import', tag: TAG, status: 201,
  summary: 'Manually import an activity. Creates a device_activity record and a matching session_load for ACWR.',
  input: z.object({
    activity_type: z.enum(['run','cycle','swim','strength','sleep','other']),
    started_at: z.string().datetime(),
    ended_at: z.string().datetime().optional(),
    metrics: z.record(z.unknown()).optional(),
    source_filename: z.string().max(255).optional(),
  }),
  async handler({ user }, { activity_type, started_at, ended_at, metrics, source_filename }) {
    const device = await one(
      `SELECT id FROM connected_devices WHERE user_id=$1 AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
      [user.id]);
    if (!device) throw badRequest('connect a device first to enable activity import');
    const src_id = source_filename || `manual_${user.id}_${Date.now()}`;
    const activity = await one(
      `INSERT INTO device_activities (device_id, user_id, activity_type, started_at, ended_at, metrics, source, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,'manual_import',$7)
       ON CONFLICT (device_id, source_id) DO NOTHING
       RETURNING id, activity_type, started_at`,
      [device.id, user.id, activity_type, started_at, ended_at || null, JSON.stringify(metrics || {}), src_id]);
    if (activity) {
      const mins = ended_at
        ? Math.max(1, Math.round((new Date(ended_at) - new Date(started_at)) / 60000))
        : 60;
      await query(
        `INSERT INTO session_loads (user_id, kind, minutes, rpe, logged_at)
         VALUES ($1,$2,$3,6,$4) ON CONFLICT DO NOTHING`,
        [user.id, activity_type === 'sleep' ? 'other' : activity_type, mins, started_at]);
    }
    return activity || { imported: false, reason: 'duplicate' };
  },
});

// ---------- ACWR and readiness (#583 elite extensions) ----------

cap({
  name: 'get_my_acwr', method: 'GET', path: '/me/wearables/acwr', tag: TAG,
  summary: 'Your own Acute:Chronic Workload Ratio from the last 35 days of training load (device sources + self-reported sRPE). ACWR = 7-day avg / 28-day avg. The zone (underload / optimal / caution / excessive) describes your load pattern; it is not a medical assessment.',
  input: z.object({}),
  async handler({ user }) {
    const data = await computeACWR(user.id);
    return { ...data, basis: NOT_MEDICAL };
  },
});

cap({
  name: 'get_my_readiness', method: 'GET', path: '/me/wearables/readiness', tag: TAG,
  summary: 'A 0–100 training readiness indicator derived from HRV, sleep duration and resting heart rate over the last 7 days, with the direction (improving / stable / declining). Not a medical clearance or fitness-to-play verdict.',
  input: z.object({}),
  async handler({ user }) { return computeReadiness(user.id); },
});

cap({
  name: 'get_team_acwr', method: 'GET', path: '/wearables/team/acwr', tag: TAG,
  summary: 'Coach: ACWR zone and readiness summary for all athletes currently sharing wearables with you. Sorted by highest concern first. Only through a live wellness share; each view is logged.',
  input: z.object({}),
  async handler({ user }) {
    return tx(async (c) => {
      const shares = (await c.query("SELECT s.* FROM wellness_shares s WHERE s.recipient_id=$1 AND s.recipient_kind='coach' AND s.revoked_at IS NULL AND s.expires_at > now() AND 'wearables' = ANY(s.fields) ORDER BY s.created_at", [user.id])).rows;
      if (!shares.length) return { athletes: [], unavailable: [], basis: NOT_MEDICAL };
      const athletes = [], unavailable = [];
      for (const s of shares) {
        const block = await shareBlock(c, s);
        const who = (await c.query('SELECT id, display_name, handle FROM users WHERE id=$1', [s.athlete_id])).rows[0];
        if (block) { unavailable.push({ athlete: who, reason: reasonText(block) }); continue; }
        const acwr = await computeACWR(s.athlete_id);
        const readiness = await computeReadiness(s.athlete_id);
        await shareEvent(c, s, user.id, 'viewed', { acwr: true });
        await audit(c, user.id, 'read_acwr_shared', 'wellness_shares', s.id);
        athletes.push({ athlete: who, ...acwr, readiness_score: readiness.score, readiness_direction: readiness.direction });
      }
      const zoneOrder = { excessive: 0, caution: 1, underload: 2, optimal: 3, no_data: 4 };
      athletes.sort((a, b) => (zoneOrder[a.zone] ?? 4) - (zoneOrder[b.zone] ?? 4));
      return { athletes, unavailable, basis: NOT_MEDICAL };
    });
  },
});

// ---------- sRPE (session RPE) (#583 elite extensions) ----------

const rpeSchema = z.object({ rpe: z.number().int().min(1).max(10), duration_minutes: z.number().int().min(1).max(600), logged_on: z.string().date().optional(), sport: z.string().max(60).optional(), notes: z.string().max(500).optional() });

cap({
  name: 'log_session_rpe', method: 'POST', path: '/me/wearables/srpe', tag: TAG, status: 201,
  summary: 'Self-report your perceived session intensity (Borg CR-10, 1–10) and duration in minutes. Session load = rpe × duration_minutes (arbitrary units, same scale as device training load). One entry per sport per day.',
  input: rpeSchema,
  async handler({ user }, i) {
    const on = i.logged_on ?? new Date().toISOString().slice(0, 10);
    const r = await one(
      `INSERT INTO session_rpe_logs(user_id, logged_on, rpe, duration_minutes, sport, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, logged_on, coalesce(sport,'')) DO UPDATE SET rpe=EXCLUDED.rpe, duration_minutes=EXCLUDED.duration_minutes, notes=EXCLUDED.notes, updated_at=now()
       RETURNING id, logged_on::text AS logged_on, rpe, duration_minutes, sport, notes`,
      [user.id, on, i.rpe, i.duration_minutes, i.sport ?? null, i.notes ?? null],
    );
    await evaluateAlerts(user.id);
    return { ...r, session_load: r.rpe * r.duration_minutes };
  },
});

cap({
  name: 'list_session_rpe', method: 'GET', path: '/me/wearables/srpe', tag: TAG,
  summary: 'Your own sRPE log for the last N days. Each entry shows the session load (rpe × duration_minutes) which feeds into your ACWR calculation.',
  input: z.object({ days: z.coerce.number().int().min(1).max(90).default(28) }),
  async handler({ user }, i) {
    const rows = await many(
      'SELECT id, logged_on::text AS logged_on, rpe, duration_minutes, sport, notes, (rpe * duration_minutes)::int AS session_load, created_at FROM session_rpe_logs WHERE user_id=$1 AND archived_at IS NULL AND logged_on > current_date - $2::int ORDER BY logged_on DESC',
      [user.id, i.days],
    );
    return { items: rows, days: i.days };
  },
});

cap({
  name: 'get_team_srpe', method: 'GET', path: '/wearables/team/srpe', tag: TAG,
  summary: 'Coach: sRPE logs for all athletes currently sharing wearables with you, for the last 14 days. Only through a live wellness share.',
  input: z.object({ days: z.coerce.number().int().min(1).max(28).default(14) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const shares = (await c.query("SELECT s.* FROM wellness_shares s WHERE s.recipient_id=$1 AND s.recipient_kind='coach' AND s.revoked_at IS NULL AND s.expires_at > now() AND 'wearables' = ANY(s.fields) ORDER BY s.created_at", [user.id])).rows;
      const result = [];
      for (const s of shares) {
        const block = await shareBlock(c, s);
        if (block) continue;
        const who = (await c.query('SELECT id, display_name FROM users WHERE id=$1', [s.athlete_id])).rows[0];
        const logs = (await c.query(
          'SELECT logged_on::text AS logged_on, rpe, duration_minutes, sport, (rpe * duration_minutes)::int AS session_load FROM session_rpe_logs WHERE user_id=$1 AND archived_at IS NULL AND logged_on > current_date - $2::int ORDER BY logged_on DESC',
          [s.athlete_id, i.days],
        )).rows;
        await shareEvent(c, s, user.id, 'viewed', { srpe: true });
        await audit(c, user.id, 'read_srpe_shared', 'wellness_shares', s.id);
        result.push({ athlete: who, logs });
      }
      return { athletes: result };
    });
  },
});
