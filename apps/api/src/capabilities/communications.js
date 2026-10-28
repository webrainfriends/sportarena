// Communications control plane (India omnichannel, #499): SMS number verification and consent evidence for people; for organisation admins the
// Communication settings (channels, templates, delivery activity, usage); for the platform admin provider accounts and message quotas.
// Delivery itself is the existing notification queue (src/notify.js + src/comms*.js): modules keep calling notify(), nothing is duplicated here.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { blindIndex, decrypt, encrypt, sha256 } from '../crypto.js';
import { audit } from '../helpers.js';
import { config } from '../config.js';
import { orgFor } from '../org-access.js';
import { mustBePlatformAdmin, isPlatform } from '../platform.js';
import { isYouth } from '../youth.js';
import { tooMany } from '../account-security.js';
import { normalizePhone } from '../whatsapp.js';
import { CATEGORIES, CHANNELS, LOCALES, USE_CASES, VAR_TYPES, VAR_TYPE_LABELS, checkTemplate, formatVars, hasWebAddress, renderBody } from '../comms-catalogue.js';
import { CONFIG_FIELDS } from '../comms-providers.js';
import { activeProvider, deepLink, guardVerificationTarget, liftStopSuppression, optOut, quotaFor, recordConsent, sendSystem, usedThisMonth } from '../comms.js';

const TAG = 'Communications';
const ADMINS = ['owner', 'admin'];
const VIEWERS = ['owner', 'admin', 'finance'];
const CODE_TTL_MIN = 10;
const MAX_CODE_TRIES = 5;
const MAX_CODES_PER_DAY = 5;
const codeHash = (userId, code) => sha256(`sms:${userId}:${code}`);
const mask = (digits) => `+${digits.slice(0, 2)}${'•'.repeat(Math.max(0, digits.length - 5))}${digits.slice(-3)}`;
const orgId = id.optional().describe('the organisation; omit only as the platform admin for the platform-wide view');

// ---------------------------------------------------------------- the catalogue (what a template may say)
cap({
  name: 'get_communication_catalogue', method: 'GET', path: '/communications/catalogue', tag: TAG,
  summary: 'What can be sent over WhatsApp Business and SMS: the use cases (fee due, venue change, …) with the typed variables each template may use, the languages and the message categories people can switch off. Free text can never be a variable.',
  handler: () => ({
    channels: CHANNELS, locales: LOCALES.map(([code, label]) => ({ code, label })), categories: CATEGORIES.map(([key, label]) => ({ key, label })),
    variable_types: Object.entries(VAR_TYPE_LABELS).map(([type, label]) => ({ type, label })),
    use_cases: Object.entries(USE_CASES).filter(([, u]) => !u.system).map(([key, u]) => ({ key, label: u.label, category: u.category, essential: !!u.essential, variables: Object.entries(u.vars).map(([name, type]) => ({ name, type })) })),
  }),
});

// ---------------------------------------------------------------- SMS number (mirrors the WhatsApp number flow)
cap({
  name: 'get_sms_status', method: 'GET', path: '/me/sms', tag: TAG,
  summary: 'Whether SMS is available on this server, and the state of your SMS number (masked): none, awaiting its code, verified, or opted out.',
  async handler({ user }) {
    const s = await one('SELECT phone_enc, verified_at, opted_out_at FROM sms_contacts WHERE user_id=$1', [user.id]);
    const state = !s ? 'none' : s.opted_out_at ? 'opted_out' : s.verified_at ? 'verified' : 'pending_code';
    return { available: !!(await activeProvider(null, 'sms', null)), state, number: s ? mask(decrypt(s.phone_enc, 'sms_contacts.phone')) : null, verified_at: s?.verified_at ?? null };
  },
});

cap({
  name: 'request_sms_verification', method: 'POST', path: '/me/sms/verify', tag: TAG,
  summary: 'Start SMS notifications: give your mobile number with the country code (e.g. +91…); a 6-digit code is sent to it by SMS. Adults only; limited to a few codes a day.',
  input: z.object({ phone: z.string().min(8).max(24).describe('with country code, e.g. +919876543210') }),
  async handler({ user }, i) {
    const digits = normalizePhone(i.phone);
    if (!digits) throw badRequest('Enter the number with its country code, like +91 98765 43210');
    if (await isYouth(user.id)) throw unprocessable('SMS messages are not sent to under-18 accounts. A parent or guardian can switch them on for their own number.');
    if (!(await activeProvider(null, 'sms', null))) throw unprocessable('SMS is not set up on this server yet');
    const cur = await one('SELECT code_sent_at FROM sms_contacts WHERE user_id=$1', [user.id]);
    if (cur?.code_sent_at && Date.now() - cur.code_sent_at.getTime() < 60_000) throw tooMany('Wait a minute before asking for another code.');
    if ((await one("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='send_sms_code' AND at > now() - interval '24 hours'", [user.id])).n >= MAX_CODES_PER_DAY) throw tooMany('Too many codes today. Try again tomorrow.');
    const target = await guardVerificationTarget(null, 'sms', digits);
    if (!target.ok) throw target.reason === 'blocked' ? unprocessable('That number cannot receive messages') : tooMany('That number has been sent too many codes today.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await audit(null, user.id, 'send_sms_code', 'users', user.id); // counted before sending, so a failing provider cannot be used to burn through the cap unseen
    const sent = await sendSystem(null, { channel: 'sms', digits, useCase: 'phone_verification', values: { code } });
    if (!sent) throw unprocessable('SMS verification is not set up yet (no approved verification template)');
    await one(
      `INSERT INTO sms_contacts(user_id, phone_enc, phone_idx, code_hash, code_expires_at, code_attempts, code_sent_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5), 0, now())
       ON CONFLICT (user_id) DO UPDATE SET phone_enc=$2, phone_idx=$3, code_hash=$4, code_expires_at=now() + make_interval(mins => $5), code_attempts=0, code_sent_at=now(), verified_at=NULL, opted_out_at=NULL, updated_at=now()
       RETURNING user_id`, [user.id, encrypt(digits, 'sms_contacts.phone'), blindIndex(digits), codeHash(user.id, code), CODE_TTL_MIN]);
    return { sent: true, number: mask(digits), expires_in_minutes: CODE_TTL_MIN };
  },
});

cap({
  name: 'confirm_sms_verification', method: 'POST', path: '/me/sms/confirm', tag: TAG,
  summary: 'Enter the 6-digit code you received by SMS. On success SMS notifications are switched on and your consent (source, time) is recorded.',
  input: z.object({ code: z.string().regex(/^\d{6}$/) }),
  async handler({ user }, i) {
    const s = await one('SELECT code_hash, code_expires_at, code_attempts, phone_idx FROM sms_contacts WHERE user_id=$1 AND verified_at IS NULL', [user.id]);
    if (!s?.code_hash || s.code_expires_at < new Date()) throw badRequest('That code has expired. Ask for a new one.');
    if (s.code_attempts >= MAX_CODE_TRIES) throw tooMany('Too many wrong codes. Ask for a new one.');
    const a = Buffer.from(codeHash(user.id, i.code)), b = Buffer.from(s.code_hash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await one('UPDATE sms_contacts SET code_attempts=code_attempts+1 WHERE user_id=$1 RETURNING user_id', [user.id]);
      throw badRequest('That code is not right.');
    }
    return tx(async (c) => {
      await c.query('UPDATE sms_contacts SET verified_at=now(), code_hash=NULL, code_expires_at=NULL, opted_out_at=NULL, updated_at=now() WHERE user_id=$1', [user.id]);
      await c.query('INSERT INTO notification_prefs(user_id, sms) VALUES ($1,true) ON CONFLICT (user_id) DO UPDATE SET sms=true', [user.id]);
      await liftStopSuppression(c, s.phone_idx, 'sms');
      await recordConsent(c, user.id, 'sms', 'opt_in', 'app_verification', { phoneIdx: s.phone_idx });
      await audit(c, user.id, 'verify_sms', 'users', user.id);
      return { verified: true };
    });
  },
});

cap({
  name: 'remove_sms_number', method: 'DELETE', path: '/me/sms', tag: TAG,
  summary: 'Stop SMS notifications immediately, including messages already queued. Your number stays on file as opted out (nothing is deleted); verify again to switch back on.',
  async handler({ user }) {
    await tx((c) => optOut(c, user.id, 'sms', { source: 'app_switch' }));
    return { state: 'opted_out' };
  },
});

cap({
  name: 'list_my_communication_consents', method: 'GET', path: '/me/communication-consents', tag: TAG,
  summary: 'Your own consent history for WhatsApp and SMS: every opt-in and opt-out with its source (app verification, app switch, STOP reply, provider suppression) and time.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many('SELECT id, channel, action, source, basis, created_at FROM comm_consents WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]),
});

// ---------------------------------------------------------------- scoping helpers
/** Organisation admins act on their organisation; the platform admin may act on any, or on the platform itself (no organisation). */
async function scope(user, organisation_id, roles, { write = false } = {}) {
  if (!organisation_id) {
    if (!isPlatform(user)) throw badRequest('Say which organisation (organisation_id)');
    await mustBePlatformAdmin(user);
    return { org: null, role: 'platform' };
  }
  return orgFor(user, organisation_id, roles, { write });
}
const platformOnly = async (user) => { await mustBePlatformAdmin(user); };

// ---------------------------------------------------------------- Communication settings (one read for the whole page)
cap({
  name: 'get_communication_settings', method: 'GET', path: '/communications/settings', tag: TAG,
  summary: 'The Communication settings page for an organisation: which channels are live (own account or the platform\'s), template counts, recent failures and this month\'s usage against its quota. As the platform admin without organisation_id: provider accounts, quotas and the dedicated-number list.',
  input: z.object({ organisation_id: orgId }),
  async handler({ user }, i) {
    const { org } = await scope(user, i.organisation_id, VIEWERS);
    const orgKey = org?.id ?? null;
    const channels = [];
    for (const channel of CHANNELS) {
      const p = await activeProvider(null, channel, orgKey);
      const t = await one("SELECT count(*) FILTER (WHERE state='active')::int AS active, count(*) FILTER (WHERE state='pending')::int AS pending, count(*) FILTER (WHERE state='draft')::int AS draft FROM comm_templates WHERE channel=$1 AND (organisation_id = $2 OR organisation_id IS NULL)", [channel, orgKey]);
      const q = await quotaFor(null, orgKey, channel);
      channels.push({
        channel, status: p ? 'active' : 'not_configured', account: p ? (p.organisation_id ? 'organisation' : 'platform') : null, provider: p?.kind ?? null, sender_label: p?.sender_label ?? null, since: p?.effective_from ?? null,
        templates: t, used: orgKey ? await usedThisMonth(null, orgKey, channel) : null, limit: q?.monthly_limit ?? null, addon_key: q?.addon_key ?? null,
      });
    }
    const failures = await many(
      `SELECT d.id, d.channel, d.use_case, d.status, d.error_code, d.last_error, d.created_at FROM notification_deliveries d
        WHERE d.provider IS NOT NULL AND d.status IN ('failed','suppressed') AND d.created_at > now() - interval '7 days' AND d.organisation_id IS NOT DISTINCT FROM $1 ORDER BY d.created_at DESC LIMIT 5`, [orgKey]);
    const base = { organisation_id: orgKey, channels, recent_failures: failures };
    if (org) return { ...base, dedicated_numbers: await many("SELECT id, label, entitled_at FROM whatsapp_senders WHERE scope_kind='organisation' AND scope_id=$1 AND revoked_at IS NULL", [org.id]) };
    return {
      ...base,
      providers: await many('SELECT id, channel, kind, organisation_id, label, sender_label, effective_from, effective_to FROM comm_providers ORDER BY effective_to IS NOT NULL, created_at DESC LIMIT 100'),
      organisations: await many("SELECT id, name, city FROM organisations WHERE status='active' ORDER BY name LIMIT 500"), // for the platform admin's pickers
      quotas: await many('SELECT q.id, q.organisation_id, o.name AS organisation, q.channel, q.monthly_limit, q.addon_key, q.effective_from FROM comm_quotas q LEFT JOIN organisations o ON o.id=q.organisation_id WHERE q.effective_to IS NULL ORDER BY q.organisation_id IS NOT NULL, o.name'),
    };
  },
});

// ---------------------------------------------------------------- provider accounts and quotas (platform admin)
const configSchema = {
  whatsapp_cloud: z.object({ phone_number_id: z.string().min(3).max(40), access_token: z.string().min(10).max(1000), app_secret: z.string().min(8).max(200), verify_token: z.string().min(8).max(200), waba_id: z.string().max(40).optional(), api_version: z.string().regex(/^v\d+\.\d+$/).optional() }).strict(),
  sms_http: z.object({ url: z.string().url().max(300), api_key: z.string().min(8).max(500), sender_id: z.string().min(3).max(20), webhook_secret: z.string().min(8).max(200), entity_id: z.string().max(40).optional() }).strict(),
};
const KIND_CHANNEL = { whatsapp_cloud: 'whatsapp', sms_http: 'sms' };

cap({
  name: 'link_comm_provider', method: 'POST', path: '/admin/communications/providers', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Link (or rotate) the WhatsApp Business Cloud API or SMS gateway account for the platform, or for one organisation. Credentials are encrypted and write-only; linking again closes the previous account (kept as history) and opens the new one. Platform admin only.',
  input: z.object({ kind: z.enum(['whatsapp_cloud', 'sms_http']), organisation_id: id.optional(), label: z.string().min(2).max(80), sender_label: z.string().max(60).optional(), config: z.record(z.any()) }),
  async handler({ user }, i) {
    await platformOnly(user);
    const parsed = configSchema[i.kind].safeParse(i.config);
    if (!parsed.success) throw badRequest(`Provider settings are incomplete: ${parsed.error.issues.map((x) => x.path.join('.') || x.message).join(', ')}. Needed: ${CONFIG_FIELDS[i.kind].required.join(', ')}`);
    if (i.kind === 'sms_http' && config.isProd && !parsed.data.url.startsWith('https://')) throw badRequest('The SMS gateway must use https');
    const channel = KIND_CHANNEL[i.kind];
    return tx(async (c) => {
      if (i.organisation_id && !(await c.query("SELECT 1 FROM organisations WHERE id=$1 AND status='active'", [i.organisation_id])).rowCount) throw notFound('Organisation');
      await c.query('UPDATE comm_providers SET effective_to=now() WHERE channel=$1 AND organisation_id IS NOT DISTINCT FROM $2 AND effective_to IS NULL', [channel, i.organisation_id ?? null]);
      const row = (await c.query(
        'INSERT INTO comm_providers(channel, kind, organisation_id, label, sender_label, config_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, channel, kind, organisation_id, label, sender_label, effective_from',
        [channel, i.kind, i.organisation_id ?? null, i.label, i.sender_label ?? null, encrypt(JSON.stringify(parsed.data), 'comm_providers.config'), user.id])).rows[0];
      await audit(c, user.id, 'link_comm_provider', 'comm_providers', row.id);
      return { ...row, webhook_path: `/api/v1/webhooks/comms/${i.kind}/${row.id}` };
    });
  },
});

cap({
  name: 'retire_comm_provider', method: 'DELETE', path: '/admin/communications/providers/:id', tag: TAG, auth: ['admin'],
  summary: 'Stop using a provider account (kept as history). Messages for that scope fall back to the platform account, or wait if there is none. Platform admin only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await platformOnly(user);
    const r = await one('UPDATE comm_providers SET effective_to=now() WHERE id=$1 AND effective_to IS NULL RETURNING id', [i.id]);
    if (!r) throw notFound('Provider account');
    await audit(null, user.id, 'retire_comm_provider', 'comm_providers', r.id);
    return { retired: true };
  },
});

cap({
  name: 'set_comm_quota', method: 'POST', path: '/admin/communications/quotas', tag: TAG, auth: ['admin'], status: 200,
  summary: 'Set the monthly message allowance for a channel: for one organisation, or the platform default (no organisation_id). monthly_limit null means unlimited; addon_key names the paid add-on the entitlement belongs to. The previous row is closed and kept. Platform admin only.',
  input: z.object({ organisation_id: id.optional(), channel: z.enum(CHANNELS), monthly_limit: z.number().int().min(0).max(100_000_000).nullable(), addon_key: z.string().max(60).optional() }),
  async handler({ user }, i) {
    await platformOnly(user);
    return tx(async (c) => {
      if (i.organisation_id && !(await c.query('SELECT 1 FROM organisations WHERE id=$1', [i.organisation_id])).rowCount) throw notFound('Organisation');
      await c.query('UPDATE comm_quotas SET effective_to=now() WHERE channel=$1 AND organisation_id IS NOT DISTINCT FROM $2 AND effective_to IS NULL', [i.channel, i.organisation_id ?? null]);
      const row = (await c.query('INSERT INTO comm_quotas(organisation_id, channel, monthly_limit, addon_key, set_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, organisation_id, channel, monthly_limit, addon_key, effective_from', [i.organisation_id ?? null, i.channel, i.monthly_limit, i.addon_key ?? null, user.id])).rows[0];
      await audit(c, user.id, 'set_comm_quota', 'comm_quotas', row.id);
      return row;
    });
  },
});

// ---------------------------------------------------------------- templates
const variableSchema = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), type: z.enum(Object.keys(VAR_TYPES)) });
const TEMPLATE = 't.id, t.organisation_id, t.use_case, t.channel, t.locale, t.version, t.provider_template_id, t.body, t.variables, t.fallback_channel, t.org_branding, t.state, t.activated_at, t.retired_at, t.created_at';

cap({
  name: 'list_comm_templates', method: 'GET', path: '/communications/templates', tag: TAG,
  summary: 'Message templates: the platform\'s and, with organisation_id, that organisation\'s own. Filter by channel, use case or state. Each version is a separate row; older versions are retired, never edited.',
  input: z.object({ organisation_id: orgId, channel: z.enum(CHANNELS).optional(), use_case: z.string().max(40).optional(), state: z.enum(['draft', 'pending', 'active', 'retired']).optional(), ...page }),
  async handler({ user }, i) {
    const { org } = await scope(user, i.organisation_id, VIEWERS);
    return many(
      `SELECT ${TEMPLATE}, CASE WHEN t.organisation_id IS NULL THEN 'platform' ELSE 'organisation' END AS scope FROM comm_templates t
        WHERE (t.organisation_id = $1 OR t.organisation_id IS NULL) AND ($2::text IS NULL OR t.channel=$2) AND ($3::text IS NULL OR t.use_case=$3) AND ($4::text IS NULL OR t.state=$4)
        ORDER BY t.use_case, t.channel, t.locale, t.version DESC LIMIT $5 OFFSET $6`, [org?.id ?? null, i.channel ?? null, i.use_case ?? null, i.state ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'create_comm_template', method: 'POST', path: '/communications/templates', tag: TAG, status: 201,
  summary: 'Draft a new template (or a new version of one): a use case, channel and language, the message with {{variables}}, the provider\'s template id, and an optional fallback channel. Variables must be the typed ones the use case offers; free text cannot be a variable. Organisation admins create their own; the platform admin creates platform templates (no organisation_id).',
  input: z.object({
    organisation_id: orgId, use_case: z.string().max(40), channel: z.enum(CHANNELS), locale: z.enum(LOCALES.map(([k]) => k)),
    body: z.string().min(5).max(1024), variables: z.array(variableSchema).max(10), provider_template_id: z.string().min(2).max(120).optional(),
    fallback_channel: z.enum(['sms', 'whatsapp', 'email']).nullable().optional(), org_branding: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const { org } = await scope(user, i.organisation_id, ADMINS, { write: true });
    if (USE_CASES[i.use_case]?.system && org) throw forbidden('Only the platform can define that template');
    const vars = checkTemplate(i);
    if (hasWebAddress(i.body)) throw badRequest('Put links in with the {{link}} variable; the message itself cannot contain a web address');
    if (i.fallback_channel === i.channel) throw badRequest('The fallback must be a different channel');
    return tx(async (c) => {
      const v = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM comm_templates WHERE organisation_id IS NOT DISTINCT FROM $1 AND use_case=$2 AND channel=$3 AND locale=$4', [org?.id ?? null, i.use_case, i.channel, i.locale])).rows[0].v;
      const row = (await c.query(
        `INSERT INTO comm_templates(organisation_id, use_case, channel, locale, version, provider_template_id, body, variables, fallback_channel, org_branding, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, organisation_id, use_case, channel, locale, version, provider_template_id, body, variables, fallback_channel, org_branding, state, created_at`,
        [org?.id ?? null, i.use_case, i.channel, i.locale, v, i.provider_template_id ?? null, i.body, JSON.stringify(vars), i.fallback_channel ?? null, i.org_branding, user.id])).rows[0];
      await audit(c, user.id, 'create_comm_template', 'comm_templates', row.id);
      return row;
    });
  },
});

const loadTemplate = async (user, tid, roles, write) => {
  const t = await one('SELECT * FROM comm_templates WHERE id=$1', [tid]);
  if (!t) throw notFound('Template');
  if (t.organisation_id) await orgFor(user, t.organisation_id, roles, { write });
  else if (write) await platformOnly(user); // platform templates are changed only by the platform admin; any signed-in organisation admin may read and preview them
  else if (!isPlatform(user) && !(await one("SELECT 1 FROM organisation_members WHERE user_id=$1 AND status='active' AND role = ANY($2)", [user.id, roles]))) throw notFound('Template');
  return t;
};

cap({
  name: 'set_comm_template_state', method: 'PATCH', path: '/communications/templates/:id', tag: TAG,
  summary: 'Move a template through its lifecycle: draft → pending (submitted to the provider for approval) → active (the platform admin records the provider\'s approval; the previous active version is retired) → retired. Retiring is available to the owning organisation too.',
  input: z.object({ id, state: z.enum(['pending', 'active', 'retired']) }),
  async handler({ user }, i) {
    const t = await loadTemplate(user, i.id, ADMINS, true);
    if (i.state === 'active') {
      await platformOnly(user); // provider approval is an external fact only the platform admin records
      if (!['draft', 'pending'].includes(t.state)) throw conflict(`A ${t.state} template cannot be activated; create a new version`);
      if (!t.provider_template_id) throw unprocessable('Add the provider\'s approved template id before activating');
    } else if (i.state === 'pending' && t.state !== 'draft') throw conflict('Only a draft can be submitted');
    else if (i.state === 'retired' && t.state === 'retired') throw conflict('Already retired');
    return tx(async (c) => {
      if (i.state === 'active') await c.query("UPDATE comm_templates SET state='retired', retired_at=now() WHERE organisation_id IS NOT DISTINCT FROM $1 AND use_case=$2 AND channel=$3 AND locale=$4 AND state='active'", [t.organisation_id, t.use_case, t.channel, t.locale]);
      const row = (await c.query(`UPDATE comm_templates SET state=$2, activated_at=CASE WHEN $2='active' THEN now() ELSE activated_at END, retired_at=CASE WHEN $2='retired' THEN now() ELSE retired_at END WHERE id=$1 RETURNING id, state, version, activated_at, retired_at`, [t.id, i.state])).rows[0];
      await audit(c, user.id, `comm_template_${i.state}`, 'comm_templates', t.id);
      return row;
    });
  },
});

const SMS_SEGMENT = (text) => { const uni = /[^\u0000-\u007f₹€£]/.test(text); const per = uni ? (text.length <= 70 ? 70 : 67) : (text.length <= 160 ? 160 : 153); return { encoding: uni ? 'unicode' : 'gsm', segments: Math.max(1, Math.ceil(text.length / per)) }; };

cap({
  name: 'preview_comm_template', method: 'POST', path: '/communications/templates/:id/preview', tag: TAG,
  summary: 'Render a template with the values you give (typed: names, amounts as {minor, currency}, dates) exactly as the recipient would see it, with the SMS length. The link is the secure in-app link; it cannot be overridden. Nothing is sent.',
  input: z.object({ id, values: z.record(z.any()).default({}) }),
  async handler({ user }, i) {
    const t = await loadTemplate(user, i.id, VIEWERS, false);
    const values = { ...i.values, link: deepLink({}) ?? 'https://link.invalid/?open=notifications' };
    let formatted;
    try { formatted = formatVars(t.variables, values); } catch (e) { throw badRequest(`Preview needs a valid value: ${e.message}`); }
    const text = renderBody(t.body, formatted);
    return { text, length: text.length, ...(t.channel === 'sms' ? SMS_SEGMENT(text) : {}), variables: t.variables, fallback_channel: t.fallback_channel };
  },
});

// ---------------------------------------------------------------- delivery activity and usage
const STATE = "CASE d.status WHEN 'pending' THEN 'queued' ELSE d.status END";

cap({
  name: 'list_comm_deliveries', method: 'GET', path: '/communications/deliveries', tag: TAG,
  summary: 'Delivery activity of templated WhatsApp / SMS messages for an organisation, newest first. State is honest: queued (not yet handed to the provider), sent (accepted by the provider, no receipt yet), delivered, read, failed, or suppressed (with the reason: opted out, quota, no template…). Shows who and what use case, never the message variables or the phone number.',
  input: z.object({ organisation_id: orgId, channel: z.enum(CHANNELS).optional(), state: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed']).optional(), ...page }),
  async handler({ user }, i) {
    const { org } = await scope(user, i.organisation_id, VIEWERS);
    await audit(null, user.id, 'read_comm_deliveries', 'organisations', org?.id ?? null);
    return many(
      `SELECT d.id, d.channel, d.use_case, ${STATE} AS state, d.attempts, d.error_code, d.last_error AS reason, d.provider_ref, d.fallback_of, d.created_at, d.sent_at, d.delivered_at, d.read_at, u.display_name AS recipient
         FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id
        WHERE d.provider IS NOT NULL AND d.organisation_id IS NOT DISTINCT FROM $1 AND ($2::text IS NULL OR d.channel=$2) AND ($3::text IS NULL OR ${STATE}=$3)
        ORDER BY d.created_at DESC LIMIT $4 OFFSET $5`, [org?.id ?? null, i.channel ?? null, i.state ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'retry_comm_delivery', method: 'POST', path: '/communications/deliveries/:id/retry', tag: TAG,
  summary: 'Put a failed delivery back in the queue with a fresh attempt budget. Only for messages the provider never accepted and whose fallback has not been sent. Consent and opt-outs are checked again when it is sent, so retrying never overrides a STOP.',
  input: z.object({ id }),
  async handler({ user }, i) {
    // not a message the provider accepted, and not one whose fallback is already on its way: retrying those would send the person two messages
    const d = await one(
      `SELECT d.id, d.organisation_id FROM notification_deliveries d WHERE d.id=$1 AND d.provider IS NOT NULL AND d.status='failed' AND d.provider_ref IS NULL
          AND NOT EXISTS (SELECT 1 FROM notification_deliveries f WHERE f.fallback_of=d.id AND f.status IN ('pending','sent','delivered','read'))`, [i.id]);
    if (!d) throw notFound('Failed delivery');
    if (d.organisation_id) await scope(user, d.organisation_id, ADMINS, { write: true });
    else if (isPlatform(user)) await platformOnly(user);
    else throw notFound('Failed delivery'); // platform-level deliveries are invisible to everyone else
    await one("UPDATE notification_deliveries SET status='pending', attempts=0, claimed_at=NULL, next_attempt_at=NULL, last_error=NULL, error_code=NULL WHERE id=$1 RETURNING id", [d.id]);
    await audit(null, user.id, 'retry_comm_delivery', 'notification_deliveries', d.id);
    return { queued: true };
  },
});

cap({
  name: 'get_comm_usage', method: 'GET', path: '/communications/usage', tag: TAG,
  summary: 'This calendar month\'s WhatsApp / SMS usage for an organisation against its allowance (quota and optional paid add-on), with a breakdown by state and use case. As the platform admin without organisation_id: usage of every organisation.',
  input: z.object({ organisation_id: orgId }),
  async handler({ user }, i) {
    const { org } = await scope(user, i.organisation_id, VIEWERS);
    const month = "created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'";
    if (!org) {
      return many(`SELECT d.organisation_id, o.name AS organisation, d.channel, count(*) FILTER (WHERE d.status IN ('pending','sent','delivered','read'))::int AS used, count(*) FILTER (WHERE d.status='failed')::int AS failed
                     FROM notification_deliveries d LEFT JOIN organisations o ON o.id=d.organisation_id WHERE d.provider IS NOT NULL AND d.${month} GROUP BY 1,2,3 ORDER BY used DESC LIMIT 200`);
    }
    const channels = [];
    for (const channel of CHANNELS) {
      const q = await quotaFor(null, org.id, channel), used = await usedThisMonth(null, org.id, channel);
      channels.push({ channel, used, limit: q?.monthly_limit ?? null, remaining: q?.monthly_limit == null ? null : Math.max(0, q.monthly_limit - used), addon_key: q?.addon_key ?? null });
    }
    return {
      organisation_id: org.id, channels,
      by_state: await many(`SELECT channel, ${STATE.replaceAll('d.', '')} AS state, count(*)::int AS n FROM notification_deliveries WHERE provider IS NOT NULL AND organisation_id=$1 AND ${month} GROUP BY 1,2 ORDER BY 1,2`, [org.id]),
      by_use_case: await many(`SELECT use_case, channel, count(*)::int AS n FROM notification_deliveries WHERE provider IS NOT NULL AND organisation_id=$1 AND ${month} GROUP BY 1,2 ORDER BY n DESC`, [org.id]),
    };
  },
});
