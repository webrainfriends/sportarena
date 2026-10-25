// Signature-provider adapter (#295). A provider turns "this person agrees to this exact text" into evidence the contract keeps.
//  - internal: the person signs inside Sportarena while logged in (the API call itself is the signature).
//  - webhook:  an external e-signature service signs elsewhere and tells us through a callback authenticated by an HMAC over the raw body
//              (header `X-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">`). Enabled only when SIGNATURE_WEBHOOK_SECRET is set.
// Neither provider ever decides who may sign: authority is re-checked against the live agreement on every signature, whatever the provider says.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

const TOLERANCE_S = 300;

const env = (k) => process.env[k] || '';
const DOCUSIGN_KEYS = ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_USER_ID', 'DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_PRIVATE_KEY', 'DOCUSIGN_CONNECT_KEY', 'DOCUSIGN_CALLBACK_URL'];

export const PROVIDERS = {
  internal: { id: 'internal', label: 'Sportarena', level: 'simple', enabled: () => true, intent: 'Signed in Sportarena by the logged-in signatory' },
  webhook: { id: 'webhook', label: 'External e-signature service', level: 'simple', enabled: () => !!process.env.SIGNATURE_WEBHOOK_SECRET, intent: 'Signed with the external e-signature service' },
  // Outbound vendor: Sportarena creates the signing request itself (`createRequest`) and the vendor's callback (`/webhooks/signatures/docusign`) signs.
  docusign: { id: 'docusign', label: 'DocuSign', level: 'advanced', vendor: true, enabled: () => DOCUSIGN_KEYS.every(env), intent: 'Signed with DocuSign (advanced electronic signature)' },
};

export const providerList = () => Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, level: p.level, enabled: p.enabled(), outbound: !!p.vendor }));

// ------------------------------------------------------------------ DocuSign
const b64u = (b) => Buffer.from(b).toString('base64url');
const baseUri = () => (env('DOCUSIGN_BASE_URI') || 'https://demo.docusign.net').replace(/\/$/, '');
const tokenUrl = () => env('DOCUSIGN_AUTH_URL') || 'https://account-d.docusign.com/oauth/token';
let cached = { token: null, until: 0 };

/** Service-user access token through the JWT grant (RS256 over the integration key), cached until a minute before it expires. */
async function docusignToken() {
  if (cached.token && Date.now() < cached.until) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const aud = new URL(tokenUrl()).host;
  const body = b64u(JSON.stringify({ iss: env('DOCUSIGN_INTEGRATION_KEY'), sub: env('DOCUSIGN_USER_ID'), aud, iat: now, exp: now + 3600, scope: 'signature impersonation' }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(env('DOCUSIGN_PRIVATE_KEY').replace(/\\n/g, '\n')).toString('base64url');
  const r = await fetch(tokenUrl(), { signal: AbortSignal.timeout(20000), method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error(`DocuSign sign-in failed (${j.error ?? r.status})`), { status: 502, code: 'vendor_auth' });
  cached = { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
  return cached.token;
}

const docusignApi = async (path, init = {}) => {
  const r = await fetch(`${baseUri()}/restapi/v2.1/accounts/${env('DOCUSIGN_ACCOUNT_ID')}${path}`, { ...init, signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${await docusignToken()}`, 'content-type': 'application/json', ...init.headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`DocuSign refused the request (${j.errorCode ?? r.status})`), { status: 502, code: 'vendor_rejected' });
  return j;
};

/**
 * Create a DocuSign envelope for the contract's draft PDF, one signer per named signatory, routed in parallel, with a Connect callback for
 * every completed / declined recipient. Returns { external_ref, recipients: [{ recipient_id, user_id }] }.
 * signers: [{ user_id, name, email }]; the signature box is placed on the last page, one per signer.
 */
export async function createDocusignRequest({ pdf, name, pages, signers }) {
  const j = await docusignApi('/envelopes', {
    method: 'POST',
    body: JSON.stringify({
      emailSubject: `Please sign: ${name}`, status: 'sent',
      documents: [{ documentBase64: pdf.toString('base64'), name: `${name}.pdf`, fileExtension: 'pdf', documentId: '1' }],
      recipients: { signers: signers.map((s, i) => ({ email: s.email, name: s.name, recipientId: String(i + 1), routingOrder: '1', tabs: { signHereTabs: [{ documentId: '1', pageNumber: String(pages), xPosition: '72', yPosition: String(560 - i * 70) }] } })) },
      eventNotification: { url: env('DOCUSIGN_CALLBACK_URL'), requireAcknowledgement: 'true', includeHMAC: 'true', loggingEnabled: 'true', eventData: { version: 'restv2.1', format: 'json' }, envelopeEvents: [{ envelopeEventStatusCode: 'voided' }], recipientEvents: [{ recipientEventStatusCode: 'Completed' }, { recipientEventStatusCode: 'Declined' }] },
    }),
  });
  return { external_ref: j.envelopeId, recipients: signers.map((s, i) => ({ recipient_id: String(i + 1), user_id: s.user_id })) };
}

/** Best-effort cancel of an envelope that was created but could not be recorded, or of a contract withdrawn while out for signature. */
export const voidDocusignRequest = (envelopeId, reason) => docusignApi(`/envelopes/${encodeURIComponent(envelopeId)}`, { method: 'PUT', body: JSON.stringify({ status: 'voided', voidedReason: reason }) });

/** DocuSign Connect HMAC: header `X-DocuSign-Signature-1` = base64 HMAC-SHA256 of the raw body under the Connect key. */
export function verifyDocusign(rawBody, header, key = env('DOCUSIGN_CONNECT_KEY')) {
  if (!key || !header) return false;
  const want = createHmac('sha256', key).update(rawBody).digest();
  const got = Buffer.from(String(header), 'base64');
  return got.length === want.length && timingSafeEqual(want, got);
}

/** Sign a Connect body the way DocuSign does; exported for tests and the integration guide. */
export const signDocusign = (key, rawBody) => createHmac('sha256', key).update(rawBody).digest('base64');

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
