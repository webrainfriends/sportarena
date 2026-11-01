// Integration Hub engine: credentials, rate limits, usage, sync runs, event log and outbound webhook delivery (on the durable jobs queue).
import { createHmac } from 'node:crypto';
import { one, many, query } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { enqueue, runJobs } from '../jobs.js';
import { logger } from '../logger.js';
import { providerOf } from './registry.js';
import { send, checkTarget } from './http.js';

export const CFG_CTX = 'integration_installs.config';
export const CRED_CTX = 'integration_credentials.secret';
export const HOOK_CTX = 'integration_webhooks.secret';

/** Never let a credential reach a log line, even if a remote error message echoes it. */
export const scrub = (text, cfg = {}) => {
  let s = String(text ?? '').slice(0, 300);
  for (const v of Object.values(cfg)) if (typeof v === 'string' && v.length >= 6) s = s.split(v).join('•••');
  return s.replace(/(bearer|token|key|secret)[=: ]+\S+/gi, '$1 •••');
};

export async function loadConfig(install, c = { query }) {
  const base = install.config_enc ? JSON.parse(decrypt(install.config_enc, CFG_CTX)) : {};
  const cred = (await c.query("SELECT secret_enc FROM integration_credentials WHERE install_id=$1 AND kind IN ('api_key','oauth_token') AND effective_to IS NULL", [install.id])).rows[0];
  return { ...base, ...(cred ? JSON.parse(decrypt(cred.secret_enc, CRED_CTX)) : {}) };
}
export async function webhookSecret(installId) {
  const r = await one("SELECT secret_enc FROM integration_credentials WHERE install_id=$1 AND kind='webhook_secret' AND effective_to IS NULL", [installId]);
  return r ? decrypt(r.secret_enc, CRED_CTX) : null;
}

export async function logEvent(installId, kind, status, message, detail = {}, attempts = 1) {
  return one('INSERT INTO integration_events(install_id, kind, status, message, detail, attempts) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [installId, kind, status, message ? String(message).slice(0, 300) : null, detail, attempts]);
}
const bump = (installId, col) => query(`INSERT INTO integration_usage(install_id, day, ${col}) VALUES ($1, CURRENT_DATE, 1) ON CONFLICT (install_id, day) DO UPDATE SET ${col} = integration_usage.${col} + 1`, [installId]);

/** One-minute fixed window per install. Returns false (and counts a refusal) when the install is over its limit. */
export async function allowCall(install) {
  const r = await one(
    `INSERT INTO integration_windows(install_id, window_start, calls) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (install_id) DO UPDATE SET calls = CASE WHEN integration_windows.window_start = date_trunc('minute', now()) THEN integration_windows.calls + 1 ELSE 1 END,
       window_start = date_trunc('minute', now()) RETURNING calls`, [install.id]);
  if (r.calls > install.rate_per_minute) { await bump(install.id, 'refused'); return false; }
  await bump(install.id, 'calls');
  return true;
}
export const countFailure = (installId) => bump(installId, 'failures');

/** Fire an organisation event to every matching subscription. Idempotent per (event id, subscription). */
export async function emit(orgId, installId, type, data, eventId) {
  const hooks = await many("SELECT id FROM integration_webhooks WHERE organisation_id=$1 AND status='active' AND $2 = ANY(event_types) AND (install_id IS NULL OR install_id=$3)", [orgId, type, installId]);
  for (const h of hooks) await enqueue(null, { category: 'integrations', kind: 'deliver_webhook', payload: { hook_id: h.id, install_id: installId, event_id: eventId, type, data }, dedupeKey: `${h.id}:${eventId}` });
}

export async function runSync(installId, { manual = false } = {}) {
  const install = await one('SELECT * FROM integration_installs WHERE id=$1', [installId]);
  if (!install || install.status === 'disconnected') return { skipped: true };
  const p = providerOf(install.provider_key);
  if (!p?.pull) return { skipped: true };
  if (!(await allowCall(install))) { await logEvent(install.id, 'sync', 'refused', 'Rate limit reached; will try again later'); return { refused: true }; }
  let cfg = {};
  try {
    cfg = await loadConfig(install);
    const { summary } = await p.pull(cfg, { mode: install.mode });
    const ev = await logEvent(install.id, manual ? 'sync_manual' : 'sync', 'ok', 'Sync finished', summary ?? {});
    await query("UPDATE integration_installs SET status='connected', last_success_at=now(), last_attempt_at=now(), last_error=NULL, updated_at=now(), next_sync_at = CASE WHEN sync_every_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => sync_every_minutes) END WHERE id=$1", [install.id]);
    await emit(install.organisation_id, install.id, 'integration.sync.succeeded', { install_id: install.id, provider: install.provider_key, summary }, ev.id);
    return { ok: true, summary };
  } catch (e) {
    const msg = scrub(e.message, cfg);
    await countFailure(install.id);
    const ev = await logEvent(install.id, manual ? 'sync_manual' : 'sync', 'failed', msg, { permanent: !!e.permanent });
    await query("UPDATE integration_installs SET status='error', last_attempt_at=now(), last_error=$2, updated_at=now(), next_sync_at = CASE WHEN sync_every_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => LEAST(sync_every_minutes, 60)) END WHERE id=$1", [install.id, msg]);
    await emit(install.organisation_id, install.id, 'integration.sync.failed', { install_id: install.id, provider: install.provider_key, error: msg }, ev.id);
    return { ok: false, error: msg };
  }
}

/** Worker step: run due scheduled syncs (a few at a time) and deliver queued webhooks with backoff. */
export async function integrationSweep() {
  const due = await many("SELECT id FROM integration_installs WHERE status IN ('connected','error') AND next_sync_at IS NOT NULL AND next_sync_at <= now() ORDER BY next_sync_at LIMIT 10");
  let synced = 0;
  for (const d of due) { await runSync(d.id); synced++; }
  const jobs = await runJobs('integrations', { deliver_webhook });
  return { synced, ...jobs };
}

async function deliver_webhook({ hook_id, install_id, event_id, type, data }, job) {
  const hook = await one('SELECT * FROM integration_webhooks WHERE id=$1', [hook_id]);
  if (!hook || hook.status !== 'active') return;
  const bad = checkTarget(hook.url);
  if (bad) throw Object.assign(new Error(bad), { permanent: true });
  const body = JSON.stringify({ id: event_id, type, created_at: new Date().toISOString(), data });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', decrypt(hook.secret_enc, HOOK_CTX)).update(`${ts}.${body}`).digest('hex');
  try {
    const r = await send('POST', hook.url, { headers: { 'content-type': 'application/json', 'x-sportarena-timestamp': String(ts), 'x-sportarena-signature': `sha256=${sig}`, 'x-sportarena-event': type }, body });
    if (r.status < 200 || r.status > 299) throw new Error(`The receiver answered ${r.status}`);
    if (install_id) await logEvent(install_id, 'webhook_out', 'ok', `Delivered ${type}`, { hook_id }, job?.attempts ?? 1);
  } catch (e) {
    if (install_id) await logEvent(install_id, 'webhook_out', 'retrying', scrub(e.message), { hook_id }, job?.attempts ?? 1);
    logger.warn('integration webhook delivery failed', { hook_id, error: e.message });
    throw e;
  }
}
