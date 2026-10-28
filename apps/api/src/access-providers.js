// Provider-neutral adapters for gates, turnstiles, smart locks and readers (#510). The platform decides who may enter (from live bookings,
// memberships, accreditations); an adapter only carries that decision to hardware. Rules every adapter follows:
//   * it is only ever asked after the server has judged the person entitled;
//   * 'ok' needs an explicit positive answer from the provider. Silence, a timeout, a redirect or a non-2xx is 'unavailable', never a grant;
//   * the locker PIN is never sent: a provider mints its own temporary credential for a window and returns a reference to it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { decrypt } from './crypto.js';

export const SECRET_CTX = 'access_points.secret';
const TIMEOUT_MS = 3500;

/** https only in production; plain http only to loopback elsewhere (tests, local controllers). No private or literal-IP hosts in production. */
export function checkEndpoint(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'That is not a valid URL'; }
  if (u.username || u.password) return 'Do not put credentials in the URL';
  const host = u.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (config.isProd) {
    if (u.protocol !== 'https:') return 'The controller URL must use https';
    if (loopback || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.endsWith('.local') || host.endsWith('.internal')) return 'Use a public hostname for the controller';
  } else if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return 'The controller URL must use https';
  return null;
}

export const sign = (secret, ts, body) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
/** A signature over a plain string (device events, where the fields are the message). */
export const signText = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');
export function verifyText(secret, text, sig) {
  const want = Buffer.from(signText(secret, text));
  const got = Buffer.from(String(sig ?? ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

async function post(point, payload) {
  if (!point.endpoint_url || !point.secret_enc) return { outcome: 'unavailable', message: 'No controller is connected to this access point' };
  const bad = checkEndpoint(point.endpoint_url);
  if (bad) return { outcome: 'unavailable', message: bad };
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  try {
    const res = await fetch(point.endpoint_url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'x-access-timestamp': ts, 'x-access-signature': sign(decrypt(point.secret_enc, SECRET_CTX), ts, body) }, body,
    });
    if (res.status === 403 || res.status === 401) return { outcome: 'rejected', message: 'The controller refused the request' };
    if (!res.ok) return { outcome: 'unavailable', message: `The controller answered ${res.status}` };
    const j = await res.json().catch(() => null);
    if (j?.ok === true || j?.granted === true) return { outcome: 'ok', ref: typeof j.ref === 'string' ? j.ref.slice(0, 120) : null };
    if (j?.ok === false || j?.granted === false) return { outcome: 'rejected', message: 'The controller declined' };
    return { outcome: 'unavailable', message: 'The controller gave no clear answer' };
  } catch {
    return { outcome: 'unavailable', message: 'The controller could not be reached' };
  }
}

export const PROVIDERS = {
  manual: {
    label: 'Front desk (no hardware)',
    description: 'Nothing is connected. A staff member opens the door; the platform still judges entitlement and records the scan.',
    hardware: false,
    open: async () => ({ outcome: 'ok', ref: null }),
    provision: async () => ({ outcome: 'unavailable', message: 'This access point has no hardware adapter, so it cannot hold temporary credentials' }),
    revoke: async () => ({ outcome: 'ok' }),
  },
  webhook: {
    label: 'Signed webhook controller',
    description: 'A gate, turnstile or smart-lock controller that accepts signed JSON commands (open, provision, revoke) and answers {"ok": true}.',
    hardware: true,
    open: (point, ctx) => post(point, { action: 'open', point_id: point.id, direction: ctx.direction, reference: ctx.reference, at: new Date().toISOString() }),
    provision: (point, ctx) => post(point, { action: 'provision', point_id: point.id, reference: ctx.reference, valid_from: ctx.valid_from, valid_to: ctx.valid_to }),
    revoke: (point, ctx) => post(point, { action: 'revoke', point_id: point.id, reference: ctx.reference, provider_ref: ctx.provider_ref }),
  },
};
export const providerOf = (key) => PROVIDERS[key] ?? null;
