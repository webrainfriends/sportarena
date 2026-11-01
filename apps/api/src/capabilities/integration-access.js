// Integration access (#597). An external integration is paid for and run for ONE organisation (or one event), as a small IT integration cycle:
//   submitted -> (needs_info <-> submitted) -> quoted -> accepted -> [in_development -> deployed] -> enabled      (or declined / withdrawn / revoked)
// The requester describes it and can log in to accept the price; the platform team reviews, asks for more, quotes, builds if needed, and enables.
// Until it is enabled the interface is a DRAFT. Enabled access belongs to that organisation (or event) only, via a commercial-engine override.
// Contact details are encrypted, and each time the platform team reads them it is audit-logged.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt, blindIndex } from '../crypto.js';
import { orgFor } from '../org-access.js';
import { mustBePlatformAdmin } from '../platform.js';
import { platformAdminEmails } from '../access.js';
import { notify } from '../notify.js';
import { commercialAudit } from '../commercial/engine.js';
import { PROVIDERS, providerOf } from '../integrations/registry.js';
import { checkTarget } from '../integrations/http.js';
import { approvedAccess, entitlementKey } from '../integrations/access.js';

const TAG = 'Integrations';
const ADMINS = ['owner', 'admin'];
const MODES = ['api_pull', 'api_push', 'webhook_in', 'webhook_out', 'file_transfer', 'sso', 'embed', 'other'];
const SECURITY = ['tls', 'oauth2', 'api_key', 'signed_requests', 'ip_allowlist', 'mutual_tls', 'sso_saml_oidc', 'iso_27001', 'soc2', 'data_protection_compliant'];
const OPEN = ['submitted', 'needs_info', 'quoted', 'accepted', 'in_development'];
const CTX_EMAIL = 'integration_access_requests.contact_email';
const CTX_PHONE = 'integration_access_requests.contact_phone';

const details = {
  integration_name: z.string().min(2).max(120).describe('What the system is called'),
  integration_url: z.string().url().max(500).optional().describe('Its address (https)'),
  mode: z.enum(MODES).describe('How it connects'),
  security: z.array(z.enum(SECURITY)).max(10).default([]).describe('Security the other system adheres to'),
  personal_data: z.boolean().default(false).describe('Whether personal data will flow'),
  monthly_volume: z.number().int().min(0).max(1_000_000_000).optional().describe('Transactions per month'),
  peak_per_minute: z.number().int().min(0).max(1_000_000).optional(),
  purpose: z.string().min(3).max(1000),
  starts_on: z.string().date().optional(),
  ends_on: z.string().date().optional(),
  contact_is_requester: z.boolean().default(true).describe('The requester is the contact; otherwise give another person'),
  contact_name: z.string().max(120).optional(),
  contact_email: z.string().email().max(200).optional(),
  contact_phone: z.string().min(5).max(30).optional(),
};
const checkDetails = (d) => {
  if (d.integration_url) { const bad = checkTarget(d.integration_url); if (bad) throw badRequest(`integration_url: ${bad}`); }
  if (d.starts_on && d.ends_on && d.ends_on < d.starts_on) throw badRequest('The end date is before the start date');
  if (d.contact_is_requester === false && (!d.contact_name || !(d.contact_email || d.contact_phone))) throw badRequest('Give the contact person\'s name and an email or phone number');
};

const platformTeam = () => many('SELECT id FROM users WHERE email_idx = ANY($1::text[])', [platformAdminEmails().map((e) => blindIndex(e))]);
const REQ_SQL = 'SELECT r.*, o.name AS organisation_name, e.name AS event_name, u.display_name AS requester_name FROM integration_access_requests r JOIN organisations o ON o.id=r.organisation_id LEFT JOIN events e ON e.id=r.event_id LEFT JOIN users u ON u.id=r.requested_by';

const shape = (r, { platform = false } = {}) => ({
  id: r.id, organisation_id: r.organisation_id, organisation_name: r.organisation_name, scope_type: r.scope_type, event_id: r.event_id, event_name: r.event_name ?? null,
  provider_key: r.provider_key, provider_name: providerOf(r.provider_key)?.name ?? null, integration_name: r.integration_name, integration_url: r.integration_url, mode: r.mode, security: r.security,
  personal_data: r.personal_data, monthly_volume: r.monthly_volume, peak_per_minute: r.peak_per_minute, purpose: r.purpose, starts_on: r.starts_on, ends_on: r.ends_on,
  contact_is_requester: r.contact_is_requester, contact_name: r.contact_is_requester ? (r.requester_name ?? null) : r.contact_name, has_contact_email: !!r.contact_email_enc, has_contact_phone: !!r.contact_phone_enc,
  status: r.status, draft: r.status !== 'enabled' && OPEN.includes(r.status), needs_development: r.needs_development,
  quote: ['quoted', 'accepted', 'in_development', 'enabled'].includes(r.status) || r.pricing_mode ? { pricing_mode: r.pricing_mode, price_minor: r.price_minor, currency: r.currency, billing: r.billing, valid_until: r.quote_valid_until } : null,
  created_at: r.created_at, updated_at: r.updated_at,
});
const log = (c, requestId, actor, side, kind, note) => c.query('INSERT INTO integration_access_events(request_id, actor_id, actor_side, kind, note) VALUES ($1,$2,$3,$4,$5)', [requestId, actor, side, kind, note ?? null]);
const tellRequester = async (c, r, title, body) => { for (const m of (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [r.organisation_id])).rows) await notify(c, m.user_id, { kind: 'integration_access', title, body, data: { request_id: r.id } }); };
const tellPlatform = async (title, body, requestId) => { for (const t of await platformTeam()) await notify(null, t.id, { kind: 'integration_access', title, body, data: { request_id: requestId } }); };

/** Load a request the caller may see: its organisation's owner/admin, or the platform admin. Everyone else gets 404. */
async function requestFor(user, requestId, { write = false } = {}) {
  const r = (await one(`${REQ_SQL} WHERE r.id=$1`, [requestId]));
  if (!r) throw notFound('Request');
  let platform = false;
  try { await mustBePlatformAdmin(user); platform = true; } catch { /* not platform */ }
  if (!platform) await orgFor(user, r.organisation_id, ADMINS, { write });
  return { r, platform };
}

cap({
  name: 'request_integration_access', method: 'POST', path: '/organisations/:organisation_id/integration-access', tag: TAG, status: 201,
  summary: 'Start the integration cycle: describe the external system you need (name, address, how it connects, security it adheres to, expected volume, purpose, duration, contact person). The platform team reviews it, may ask for more, advises a price, and enables it for your organisation (or one event or tournament) only once you accept. Pick a catalogue provider, or leave provider_key out for something custom (the interface stays a draft until the platform team builds and deploys it). Organisation owner or admin.',
  input: z.object({ organisation_id: id, provider_key: z.string().max(60).optional(), event_id: id.optional(), ...details, integration_name: details.integration_name.optional() }),
  async handler({ user }, i) {
    const { org } = await orgFor(user, i.organisation_id, ADMINS, { write: true });
    const p = i.provider_key ? providerOf(i.provider_key) : null;
    if (i.provider_key && !p) throw notFound('Integration provider');
    const name = i.integration_name ?? p?.name;
    if (!name) throw badRequest('Say what the integration is called');
    checkDetails(i);
    if (i.event_id && !(await one('SELECT 1 AS x FROM events WHERE id=$1 AND organisation_id=$2', [i.event_id, i.organisation_id]))) throw notFound('Event');
    if (i.provider_key && (await approvedAccess(i.organisation_id, i.provider_key, i.event_id ?? null))) throw conflict('This integration is already enabled');
    return tx(async (c) => {
      let row;
      try {
        row = (await c.query(
          `INSERT INTO integration_access_requests(organisation_id, scope_type, event_id, provider_key, integration_name, integration_url, mode, security, personal_data, monthly_volume, peak_per_minute, purpose, starts_on, ends_on,
             contact_is_requester, contact_name, contact_email_enc, contact_phone_enc, needs_development, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
          [i.organisation_id, i.event_id ? 'event' : 'organisation', i.event_id ?? null, i.provider_key ?? null, name, i.integration_url ?? null, i.mode, i.security, i.personal_data, i.monthly_volume ?? null, i.peak_per_minute ?? null, i.purpose,
            i.starts_on ?? null, i.ends_on ?? null, i.contact_is_requester, i.contact_is_requester ? null : i.contact_name, i.contact_email ? encrypt(i.contact_email, CTX_EMAIL) : null, i.contact_phone ? encrypt(i.contact_phone, CTX_PHONE) : null, !p, user.id])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('There is already an open request for this integration'); throw e; }
      await log(c, row.id, user.id, 'requester', 'submitted', null);
      await audit(c, user.id, 'request_integration_access', 'integration_access_requests', row.id);
      await tellPlatform('Integration requested', `${org.name}: ${name}`, row.id);
      return shape({ ...row, organisation_name: org.name, requester_name: user.display_name });
    });
  },
});

cap({
  name: 'list_integration_access', method: 'GET', path: '/organisations/:organisation_id/integration-access', tag: TAG,
  summary: 'The organisation\'s integration requests and where each one stands in the cycle (draft until enabled). Organisation owner or admin.',
  input: z.object({ organisation_id: id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, ADMINS);
    return { items: (await many(`${REQ_SQL} WHERE r.organisation_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [i.organisation_id, i.limit, i.offset])).map((r) => shape(r)) };
  },
});

cap({
  name: 'get_integration_access', method: 'GET', path: '/integration-access/:id', tag: TAG,
  summary: 'One request in full with its timeline (what was asked, quoted, accepted, built and enabled, with the notes each side gave). The platform team also sees the contact person\'s email and phone (decrypted, and audit-logged). Requesting organisation owner/admin, or platform admin; anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { r, platform } = await requestFor(user, i.id);
    const out = shape(r);
    out.timeline = await many('SELECT e.kind, e.note, e.actor_side, e.created_at, u.display_name AS actor FROM integration_access_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.request_id=$1 ORDER BY e.created_at', [r.id]);
    if (platform) {
      out.contact_email = r.contact_email_enc ? decrypt(r.contact_email_enc, CTX_EMAIL) : null;
      out.contact_phone = r.contact_phone_enc ? decrypt(r.contact_phone_enc, CTX_PHONE) : null;
      await audit(null, user.id, 'read_integration_contact', 'integration_access_requests', r.id);
    }
    return out;
  },
});

cap({
  name: 'update_integration_access', method: 'PATCH', path: '/integration-access/:id', tag: TAG,
  summary: 'Answer the platform team\'s questions or correct the details while the request is waiting for review or for more information. A request that needed information goes back to the platform team. Organisation owner or admin.',
  input: z.object({ id, note: z.string().max(500).optional(), ...Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v.optional()])) }),
  async handler({ user }, i) {
    const { r } = await requestFor(user, i.id, { write: true });
    if (!['submitted', 'needs_info'].includes(r.status)) throw conflict('This request can no longer be edited');
    const merged = { ...r, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && k in details)) };
    checkDetails({ ...merged, contact_is_requester: merged.contact_is_requester });
    const email = i.contact_email ? encrypt(i.contact_email, CTX_EMAIL) : r.contact_email_enc;
    const phone = i.contact_phone ? encrypt(i.contact_phone, CTX_PHONE) : r.contact_phone_enc;
    return tx(async (c) => {
      await c.query(
        `UPDATE integration_access_requests SET integration_name=$2, integration_url=$3, mode=$4, security=$5, personal_data=$6, monthly_volume=$7, peak_per_minute=$8, purpose=$9, starts_on=$10, ends_on=$11,
           contact_is_requester=$12, contact_name=$13, contact_email_enc=$14, contact_phone_enc=$15, status='submitted', updated_at=now() WHERE id=$1`,
        [r.id, merged.integration_name, merged.integration_url, merged.mode, merged.security, merged.personal_data, merged.monthly_volume, merged.peak_per_minute, merged.purpose, merged.starts_on, merged.ends_on,
          merged.contact_is_requester, merged.contact_is_requester ? null : merged.contact_name, email, phone]);
      await log(c, r.id, user.id, 'requester', r.status === 'needs_info' ? 'answered' : 'updated', i.note);
      await audit(c, user.id, 'update_integration_access', 'integration_access_requests', r.id);
      await tellPlatform('Integration request updated', `${r.organisation_name}: ${merged.integration_name}`, r.id);
      return shape((await c.query(`${REQ_SQL} WHERE r.id=$1`, [r.id])).rows[0]);
    });
  },
});

cap({
  name: 'respond_integration_quote', method: 'POST', path: '/integration-access/:id/quote-response', tag: TAG,
  summary: 'Accept or turn down the price the platform team advised. Accepting does not enable anything by itself: the platform team then builds it if needed and enables it. Turning it down sends the request back for a new quote. Organisation owner or admin.',
  input: z.object({ id, decision: z.enum(['accept', 'reject']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const { r } = await requestFor(user, i.id, { write: true });
    if (r.status !== 'quoted') throw conflict('There is no price waiting for your answer');
    if (i.decision === 'accept' && r.quote_valid_until && new Date(r.quote_valid_until) < new Date(new Date().toDateString())) throw conflict('This quote has expired; ask the platform team for a new one');
    await tx(async (c) => {
      await c.query('UPDATE integration_access_requests SET status=$2, updated_at=now() WHERE id=$1', [r.id, i.decision === 'accept' ? 'accepted' : 'submitted']);
      await log(c, r.id, user.id, 'requester', i.decision === 'accept' ? 'quote_accepted' : 'quote_rejected', i.note);
      await audit(c, user.id, `${i.decision}_integration_quote`, 'integration_access_requests', r.id);
    });
    await tellPlatform(i.decision === 'accept' ? 'Price accepted' : 'Price turned down', `${r.organisation_name}: ${r.integration_name}`, r.id);
    return { status: i.decision === 'accept' ? 'accepted' : 'submitted' };
  },
});

cap({
  name: 'withdraw_integration_access', method: 'DELETE', path: '/integration-access/:id', tag: TAG,
  summary: 'Withdraw a request that is not enabled yet (kept as history).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { r } = await requestFor(user, i.id, { write: true });
    if (!OPEN.includes(r.status)) throw conflict('Only a request that is still in progress can be withdrawn');
    await tx(async (c) => { await c.query("UPDATE integration_access_requests SET status='withdrawn', updated_at=now() WHERE id=$1", [r.id]); await log(c, r.id, user.id, 'requester', 'withdrawn', null); await audit(c, user.id, 'withdraw_integration_access', 'integration_access_requests', r.id); });
    return { withdrawn: true };
  },
});

cap({
  name: 'admin_list_integration_requests', method: 'GET', path: '/admin/integration-access', tag: TAG, auth: ['admin'],
  summary: 'Platform admin only: integration requests from every organisation, oldest first. status "open" is everything still in the cycle.',
  input: z.object({ status: z.enum(['open', 'submitted', 'needs_info', 'quoted', 'accepted', 'in_development', 'enabled', 'declined', 'withdrawn', 'revoked']).default('open'), ...page }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const rows = await many(`${REQ_SQL} WHERE ${i.status === 'open' ? 'r.status = ANY($1::text[])' : 'r.status = $1'} ORDER BY r.created_at ASC LIMIT $2 OFFSET $3`, [i.status === 'open' ? OPEN : i.status, i.limit, i.offset]);
    return { items: rows.map((r) => shape(r)) };
  },
});

// decision -> statuses it may start from
const FROM = { request_info: ['submitted'], quote: ['submitted', 'needs_info', 'quoted'], start_development: ['accepted'], deploy: ['in_development'], enable: ['accepted'], decline: OPEN, revoke: ['enabled'] };

cap({
  name: 'admin_decide_integration_request', method: 'POST', path: '/admin/integration-access/:id/decision', tag: TAG, auth: ['admin'],
  summary: 'Platform admin only: move a request through the cycle. request_info (ask the requester for more), quote (advise the price: special amount or waived, billing, validity; set needs_development if it must be built), start_development (after the price is accepted), deploy (bind the finished adapter by provider_key), enable (after acceptance and, if needed, deployment: records the price as an entitlement for that organisation or event only), decline, revoke (ends access and pauses its connections, kept as history). Each step notifies the requester.',
  input: z.object({
    id, decision: z.enum(['request_info', 'quote', 'start_development', 'deploy', 'enable', 'decline', 'revoke']), note: z.string().max(500).optional(),
    pricing_mode: z.enum(['special', 'waived']).optional(), price_minor: z.number().int().min(0).max(1_000_000_000).optional(), currency: z.string().length(3).optional(),
    billing: z.enum(['one_time', 'monthly', 'annual']).optional(), valid_until: z.string().date().optional(), needs_development: z.boolean().optional(), provider_key: z.string().max(60).optional(), ends_on: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM integration_access_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      if (!FROM[i.decision].includes(r.status)) throw conflict(`A request that is ${r.status.replace('_', ' ')} cannot take that step`);
      let status; let title;
      if (i.decision === 'request_info') {
        if (!i.note) throw badRequest('Say what more you need'); status = 'needs_info'; title = 'More information needed';
      } else if (i.decision === 'quote') {
        if (!i.pricing_mode) throw badRequest('Advise the price: special pricing, or waived');
        if (i.pricing_mode === 'special' && (!i.price_minor || !i.currency || !i.billing)) throw badRequest('A special price needs an amount, currency and billing');
        status = 'quoted'; title = 'Price advised';
        await c.query('UPDATE integration_access_requests SET pricing_mode=$2, price_minor=$3, currency=$4, billing=$5, quote_valid_until=$6, needs_development=coalesce($7, needs_development) WHERE id=$1',
          [r.id, i.pricing_mode, i.pricing_mode === 'special' ? i.price_minor : null, i.pricing_mode === 'special' ? i.currency.toUpperCase() : null, i.pricing_mode === 'special' ? i.billing : null, i.valid_until ?? null, i.needs_development ?? null]);
      } else if (i.decision === 'start_development') {
        if (!r.needs_development) throw badRequest('This request does not need development'); status = 'in_development'; title = 'Development started';
      } else if (i.decision === 'deploy') {
        if (!i.provider_key || !PROVIDERS[i.provider_key]) throw badRequest('Name the deployed provider adapter');
        status = 'accepted'; title = 'Built and ready to enable';
        await c.query('UPDATE integration_access_requests SET provider_key=$2, needs_development=false WHERE id=$1', [r.id, i.provider_key]);
      } else if (i.decision === 'enable') {
        if (!r.provider_key) throw badRequest('Deploy the adapter first'); if (r.needs_development) throw badRequest('Development is not finished');
        const price = r.pricing_mode === 'waived' ? 'price waived' : `${(Number(r.price_minor) / 100).toFixed(2)} ${r.currency} ${String(r.billing).replace('_', ' ')}`;
        const subject = r.event_id ? ['event', r.event_id] : ['organisation', r.organisation_id];
        const o = (await c.query(`INSERT INTO commercial_overrides(scope, subject_type, subject_id, key, mode, enabled, reason, ends_on, created_by) VALUES ('contract',$1,$2,$3,'set',true,$4,$5,$6) RETURNING id`,
          [subject[0], subject[1], entitlementKey(r.provider_key), `Integration: ${price}`.slice(0, 300), i.ends_on ?? r.ends_on ?? null, user.id])).rows[0];
        await commercialAudit(c, user.id, 'create_override', 'commercial_overrides', o.id, { key: entitlementKey(r.provider_key), integration_request: r.id });
        await c.query('UPDATE integration_access_requests SET override_id=$2 WHERE id=$1', [r.id, o.id]);
        status = 'enabled'; title = 'Integration enabled';
      } else if (i.decision === 'decline') {
        if (!i.note) throw badRequest('Say why it is declined'); status = 'declined'; title = 'Integration declined';
      } else {
        await c.query("UPDATE commercial_overrides SET status='revoked', revoked_at=now() WHERE id=$1", [r.override_id]);
        await commercialAudit(c, user.id, 'revoke_override', 'commercial_overrides', r.override_id, { integration_request: r.id });
        await c.query("UPDATE integration_installs SET status='paused', next_sync_at=NULL, updated_at=now() WHERE organisation_id=$1 AND provider_key=$2 AND status IN ('connected','error') AND ($3::uuid IS NULL OR event_id = $3)", [r.organisation_id, r.provider_key, r.event_id]);
        status = 'revoked'; title = 'Integration access revoked';
      }
      await c.query('UPDATE integration_access_requests SET status=$2, decided_by=$3, updated_at=now() WHERE id=$1', [r.id, status, user.id]);
      await log(c, r.id, user.id, 'platform', i.decision, i.note);
      await audit(c, user.id, `${i.decision}_integration_access`, 'integration_access_requests', r.id);
      await tellRequester(c, r, title, `${r.integration_name}${i.note ? `: ${i.note}` : ''}`);
      return shape((await c.query(`${REQ_SQL} WHERE r.id=$1`, [r.id])).rows[0]);
    });
  },
});
