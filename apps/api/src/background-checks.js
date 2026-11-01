// Background-check vendor adapter (#703). A provider orders a check and reports back; Sportarena keeps ONLY the mapped state (clear / not_clear / pending)
// and the vendor's reference. The vendor's report is never requested, parsed or stored here. Anything that is not an explicit "clear" or "not_clear" is
// "pending" (fail closed), and a vendor "clear" never makes a record valid by itself: a reviewer still confirms it through decide_compliance_record.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { many, one, tx } from './db.js';
import { config } from './config.js';
import { decrypt, blindIndex } from './crypto.js';
import { transport } from './identity/safe-http.js';
import { notify } from './notify.js';
import { logger } from './logger.js';

export const STATES = ['clear', 'not_clear', 'pending'];
/** Fail closed: only an explicit, exact result moves a check off "pending". */
export const mapState = (v) => (v === 'clear' || v === 'not_clear' ? v : 'pending');

export class VendorError extends Error {
  constructor(message, { permanent = false, code = 'vendor_error' } = {}) { super(String(message).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').slice(0, 200)); this.permanent = permanent; this.code = code; }
}

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const sign = (secret, raw) => createHmac('sha256', secret).update(raw).digest('hex');
/** Both adapters sign the raw body with HMAC-SHA256 in `x-signature`; nothing in the body is read before this passes. */
const verifyHmac = ({ cfg, rawBody, headers }) => !!cfg.webhook_secret && !!headers['x-signature'] && safeEq(headers['x-signature'], sign(cfg.webhook_secret, rawBody));
const parseEvent = (json) => (json && typeof json.event_id === 'string' && typeof json.ref === 'string' ? [{ eventId: json.event_id.slice(0, 120), ref: json.ref.slice(0, 200), state: mapState(json.result) }] : []);

// ---- stub (tests and local development only; refused in production so it can never be linked to real people)
const stubResults = new Map();
export const stubControl = { set: (ref, state) => stubResults.set(ref, state), clear: () => stubResults.clear() };
const stub = {
  kind: 'stub', label: 'Test provider (not for production)', production: false,
  async start() { return { ref: `stub_${randomBytes(9).toString('hex')}` }; },
  async status({ ref }) { return mapState(stubResults.get(ref)); },
  verifyWebhook: verifyHmac, parseWebhook: parseEvent,
};

// ---- a generic JSON provider: POST {base_url}/checks {reference, name} -> {id};  GET {base_url}/checks/{id} -> {result}
// Only `result` is read from a response. A vendor with a different shape gets its own small adapter in this map.
async function call(cfg, method, path, body) {
  let r;
  try {
    r = await transport.fetch({ url: `${cfg.base_url.replace(/\/$/, '')}${path}`, method, timeoutMs: 15_000, headers: { authorization: `Bearer ${cfg.api_key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new VendorError(`provider unreachable: ${e.message}`, { code: 'unreachable' }); }
  if (r.status >= 500 || r.status === 429) throw new VendorError(`provider answered ${r.status}`, { code: 'unavailable' });
  if (r.status < 200 || r.status >= 300) throw new VendorError(`provider refused (${r.status})`, { permanent: true, code: 'refused' });
  try { return JSON.parse(r.text); } catch { throw new VendorError('provider sent something unreadable', { permanent: true, code: 'unreadable' }); }
}
const generic = {
  kind: 'generic_json', label: 'Generic JSON provider', production: true,
  async start({ cfg, reference, name }) {
    const j = await call(cfg, 'POST', '/checks', { reference, name });
    if (typeof j?.id !== 'string' || !j.id) throw new VendorError('provider did not return a check id', { permanent: true, code: 'unreadable' });
    return { ref: j.id.slice(0, 200) };
  },
  async status({ cfg, ref }) { return mapState((await call(cfg, 'GET', `/checks/${encodeURIComponent(ref)}`))?.result); },
  verifyWebhook: verifyHmac, parseWebhook: parseEvent,
};

export const adapters = { stub, generic_json: generic };
export const CONFIG_FIELDS = { stub: { required: ['webhook_secret'], optional: [] }, generic_json: { required: ['base_url', 'api_key', 'webhook_secret'], optional: [] } };
export const adapterFor = (kind) => (Object.hasOwn(adapters, kind) && (adapters[kind].production || !config.isProd) ? adapters[kind] : null);
export const availableKinds = () => Object.values(adapters).filter((a) => a.production || !config.isProd).map((a) => ({ kind: a.kind, label: a.label, fields: CONFIG_FIELDS[a.kind] }));
export const signBody = sign;      // tests and vendors' own tooling sign the same way

export const refIndex = (provider, ref) => blindIndex(`bgcheck|${provider}|${ref}`);

// ---- applying a vendor result
/** Record the vendor's state. Idempotent; tells the scope's reviewers when a result arrives (no figures or names in the message). */
export async function applyVendorState(c, v, state, source) {
  const next = mapState(state);
  if (next === v.state) { await c.query('UPDATE comp_check_vendor SET last_polled_at=now(), last_error_code=NULL WHERE id=$1', [v.id]); return false; }
  if (v.confirmed_at) return false;                                  // a reviewer has already decided: a late vendor change never rewrites that
  await c.query('UPDATE comp_check_vendor SET state=$2, state_changed_at=now(), last_polled_at=now(), last_error_code=NULL WHERE id=$1', [v.id, next]);
  const rec = (await c.query('SELECT k.id, k.requirement_id, k.subject_kind, k.subject_id, q.scope_kind, q.scope_id, q.name FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.id=$1', [v.record_id])).rows[0];
  await c.query('INSERT INTO comp_events(requirement_id, record_id, subject_kind, subject_id, actor_id, action, detail) VALUES ($1,$2,$3,$4,NULL,$5,$6)',
    [rec.requirement_id, rec.id, rec.subject_kind, rec.subject_id, `vendor_${next}`, JSON.stringify({ provider: v.provider, source })]);
  if (next !== 'pending') {
    const { managerIds } = await import('./compliance.js');
    for (const m of await managerIds(c, rec.scope_kind, rec.scope_id)) await notify(c, m, { kind: 'compliance_review', title: 'A background check result is in', body: `${rec.name}: confirm the result in Compliance.`, data: { record_id: rec.id }, dedupe_key: `bgcheck:${v.id}:${next}:${m}` });
  }
  return true;
}

/** Look up the credentials a check was ordered with and decrypt them (only at the moment of use). */
export async function credentialsFor(credentialId) {
  const row = credentialId ? await one('SELECT * FROM comp_vendor_credentials WHERE id=$1', [credentialId]) : null;
  return row ? { row, cfg: JSON.parse(decrypt(row.config_enc, 'comp_vendor_credentials.config')) } : null;
}

/** Poll vendors for checks still pending (called by the compliance sweep). A vendor outage leaves the check pending and records only an error code. */
export async function pollBackgroundChecks({ limit = 50 } = {}) {
  const due = await many(`SELECT v.* FROM comp_check_vendor v JOIN comp_records k ON k.id=v.record_id
                           WHERE v.state='pending' AND k.status='submitted' AND (v.last_polled_at IS NULL OR v.last_polled_at < now() - interval '15 minutes') ORDER BY v.last_polled_at NULLS FIRST LIMIT $1`, [limit]);
  let changed = 0;
  for (const v of due) {
    try {
      const adapter = adapterFor(v.provider), cred = await credentialsFor(v.credential_id);
      if (!adapter || !cred) throw new VendorError('no usable credentials', { code: 'no_credentials' });
      const state = await adapter.status({ cfg: cred.cfg, ref: decrypt(v.provider_ref_enc, 'comp_check_vendor.provider_ref') });
      if (await tx((c) => applyVendorState(c, v, state, 'poll'))) changed++;
    } catch (e) {
      logger.warn('background check poll failed', { check: v.id, code: e.code ?? 'error' });
      await one('UPDATE comp_check_vendor SET last_polled_at=now(), last_error_code=$2 WHERE id=$1 RETURNING id', [v.id, (e.code ?? 'error').slice(0, 40)]);
    }
  }
  return changed;
}
