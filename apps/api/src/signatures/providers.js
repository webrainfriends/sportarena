// Signature-provider adapter (#295). A provider turns "this person agrees to this exact text" into evidence the contract keeps.
//  - internal: the person signs inside Sportarena while logged in (the API call itself is the signature).
//  - webhook:  an external e-signature service signs elsewhere and tells us through a callback authenticated by an HMAC over the raw body
//              (header `X-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">`). Enabled only when SIGNATURE_WEBHOOK_SECRET is set.
// Neither provider ever decides who may sign: authority is re-checked against the live agreement on every signature, whatever the provider says.
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_S = 300;

export const PROVIDERS = {
  internal: { id: 'internal', label: 'Sportarena', enabled: () => true, intent: 'Signed in Sportarena by the logged-in signatory' },
  webhook: { id: 'webhook', label: 'External e-signature service', enabled: () => !!process.env.SIGNATURE_WEBHOOK_SECRET, intent: 'Signed with the external e-signature service' },
};

export const providerList = () => Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, enabled: p.enabled() }));

/** Sign a body the way the external service must; exported so tests (and the provider's integration guide) use the same function. */
export const signCallback = (secret, rawBody, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;

export function verifyCallback(rawBody, header, secret = process.env.SIGNATURE_WEBHOOK_SECRET) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.trim().split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > TOLERANCE_S || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  const want = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(want, Buffer.from(parts.v1, 'hex'));
}
