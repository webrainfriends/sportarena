// Provider adapters for templated WhatsApp Business and SMS. One interface, two adapters:
//   send({ cfg, to, template, vars, text, reference }) -> { ref }            throws CommError(permanent?) on failure
//   verifyWebhook({ cfg, rawBody, headers }) -> boolean                       authenticity comes from the provider's signature, never from the body
//   parseWebhook(json) -> [{ id, type: 'status'|'inbound', ... }]             provider payloads normalised, so one handler serves both
// Credentials live encrypted in comm_providers.config_enc and are decrypted only here, per send. Tests replace `adapters.*.fetch`.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

// error text from a provider can echo the destination number: it is stored, logged and shown to organisation admins, so digits are removed
export const scrub = (text) => String(text ?? '').replace(/\+?\d[\d\s().-]{5,}\d/g, '[number]');

export class CommError extends Error {
  constructor(message, { permanent = false, code = null, suppress = null } = {}) {
    super(scrub(message));
    Object.assign(this, { permanent, code, suppress });
  }
}

const hmac = (secret, raw) => createHmac('sha256', secret).update(raw).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

async function postJson(url, body, headers) {
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { res, json };
}

// ---------------------------------------------------------------- WhatsApp Business Cloud API (official, template messages)
// Meta error codes that are permanent for this recipient: not a WhatsApp user / number invalid (131026), blocked or opted out (131050), template problems.
const WA_NOT_REACHABLE = new Set([131026, 1013, 131030]);
const WA_STOPPED = new Set([131050]);
const WA_TEMPLATE_BROKEN = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);
const waLang = (locale) => locale.replace('-', '_');

export const whatsappCloud = {
  kind: 'whatsapp_cloud', channel: 'whatsapp',
  base: () => config.comms.whatsappCloudBase,
  async send({ cfg, to, template, formatted, reference }) {
    const params = template.variables.map((v) => ({ type: 'text', text: formatted[v.name] }));
    const { res, json } = await postJson(`${this.base()}/${cfg.api_version ?? 'v21.0'}/${encodeURIComponent(cfg.phone_number_id)}/messages`, {
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: template.provider_template_id, language: { code: waLang(template.locale) }, components: params.length ? [{ type: 'body', parameters: params }] : [] },
      biz_opaque_callback_data: reference,
    }, { authorization: `Bearer ${cfg.access_token}` });
    if (!res.ok) {
      const code = Number(json?.error?.code) || null;
      const permanent = res.status === 400 || res.status === 401 || res.status === 403 || WA_NOT_REACHABLE.has(code) || WA_STOPPED.has(code) || WA_TEMPLATE_BROKEN.has(code);
      throw new CommError(`WhatsApp Cloud answered ${res.status}${json?.error?.message ? `: ${String(json.error.message).slice(0, 120)}` : ''}`,
        { permanent: permanent && res.status !== 429 && res.status < 500, code: code ? String(code) : String(res.status), suppress: WA_STOPPED.has(code) ? 'stop' : WA_NOT_REACHABLE.has(code) ? 'invalid_number' : null });
    }
    const ref = json?.messages?.[0]?.id;
    if (!ref) throw new CommError('WhatsApp Cloud accepted the call without a message id', { code: 'no_ref' });
    return { ref };
  },
  verifyWebhook({ cfg, rawBody, headers }) {
    const sig = String(headers['x-hub-signature-256'] ?? '');
    return !!cfg.app_secret && sig.startsWith('sha256=') && safeEq(sig.slice(7), hmac(cfg.app_secret, rawBody));
  },
  /** Meta's one-time subscription handshake (GET). */
  handshake({ cfg, query }) {
    return query['hub.mode'] === 'subscribe' && !!cfg.verify_token && safeEq(query['hub.verify_token'] ?? '', cfg.verify_token) ? String(query['hub.challenge'] ?? '') : null;
  },
  parseWebhook(json) {
    const out = [];
    for (const entry of json?.entry ?? []) for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      for (const s of v.statuses ?? []) {
        const err = s.errors?.[0];
        const code = err ? Number(err.code) : null;
        out.push({ id: `${s.id}:${s.status}:${s.timestamp ?? ''}`, type: 'status', ref: s.id, state: { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' }[s.status] ?? null,
          code: code ? String(code) : null, suppress: WA_STOPPED.has(code) ? 'stop' : WA_NOT_REACHABLE.has(code) ? 'invalid_number' : null });
      }
      for (const m of v.messages ?? []) out.push({ id: `in:${m.id}`, type: 'inbound', from: String(m.from ?? ''), text: m.type === 'text' ? String(m.text?.body ?? '') : '' });
    }
    return out;
  },
};

// ---------------------------------------------------------------- SMS through an HTTPS gateway bridge (India: DLT-registered header + template id)
// The bridge is a thin service in front of MSG91 / Twilio / Kaleyra etc., so the platform keeps one contract:
//   POST {url}  { to: "+91…", sender, text, template_id, entity_id, reference }  ->  { id }
//   webhook     { events: [{ id, ref, status: sent|delivered|failed|read, code?, permanent? } | { id, type: "inbound", from, text }] }, signed x-signature = hex HMAC-SHA256(rawBody, webhook_secret)
export const smsHttp = {
  kind: 'sms_http', channel: 'sms',
  async send({ cfg, to, template, text, reference }) {
    const { res, json } = await postJson(cfg.url, { to: `+${to}`, sender: cfg.sender_id, text, template_id: template.provider_template_id, entity_id: cfg.entity_id ?? null, reference }, { authorization: `Bearer ${cfg.api_key}`, 'idempotency-key': reference });
    if (!res.ok) throw new CommError(`SMS gateway answered ${res.status}${json?.error ? `: ${String(json.error).slice(0, 120)}` : ''}`, { permanent: res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408, code: String(json?.code ?? res.status), suppress: json?.suppress ?? null });
    if (!json?.id) throw new CommError('SMS gateway accepted the call without a message id', { code: 'no_ref' });
    return { ref: String(json.id) };
  },
  verifyWebhook({ cfg, rawBody, headers }) {
    return !!cfg.webhook_secret && !!headers['x-signature'] && safeEq(String(headers['x-signature']), hmac(cfg.webhook_secret, rawBody));
  },
  handshake: () => null,
  parseWebhook(json) {
    return (json?.events ?? []).map((e) => e.type === 'inbound'
      ? { id: `in:${e.id}`, type: 'inbound', from: String(e.from ?? ''), text: String(e.text ?? '') }
      : { id: `${e.ref}:${e.status}:${e.id}`, type: 'status', ref: String(e.ref), state: ['sent', 'delivered', 'read', 'failed'].includes(e.status) ? e.status : null, code: e.code ? String(e.code) : null, suppress: e.suppress ?? null });
  },
};

export const adapters = { whatsapp_cloud: whatsappCloud, sms_http: smsHttp };
export const adapterFor = (kind) => (Object.hasOwn(adapters, kind) ? adapters[kind] : null);

/** Provider settings accepted when an account is linked; secrets are write-only (never returned). */
export const CONFIG_FIELDS = {
  whatsapp_cloud: { required: ['phone_number_id', 'access_token', 'app_secret', 'verify_token'], optional: ['waba_id', 'api_version'] },
  sms_http: { required: ['url', 'api_key', 'sender_id', 'webhook_secret'], optional: ['entity_id'] },
};
export const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)\s*[.!]?\s*$/i;
