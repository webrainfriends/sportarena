// Integration Hub (#597): one tenant-level framework for connecting outside systems (calendars, sports-data feeds, ticket scanners, ...).
// Providers are adapters in src/integrations/registry.js; everything else here is shared. Organisation owners and admins only; outsiders get 404.
// Credentials are write-only (encrypted, shown once where we generate them), rotation keeps history, and nothing is ever deleted.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { AppError, badRequest, conflict, notFound, tooMany } from '../errors.js';
import { audit } from '../helpers.js';
import { newOpaqueToken, encrypt } from '../crypto.js';
import { orgFor } from '../org-access.js';
import { CATEGORIES, MANAGED, PROVIDERS, describe, providerOf } from '../integrations/registry.js';
import { CFG_CTX, CRED_CTX, HOOK_CTX, allowCall, loadConfig, logEvent, runSync, scrub } from '../integrations/engine.js';
import { checkTarget } from '../integrations/http.js';
import { isPlatformAdminNow, requireIntegrationAccess } from '../integrations/access.js';

const TAG = 'Integrations';
const ADMINS = ['owner', 'admin'];
const ENTITIES = { user: 'users', team: 'teams', event: 'events', venue: 'venues' };
const EVENT_TYPES = ['integration.sync.succeeded', 'integration.sync.failed', 'integration.webhook.received'];

const webhookPath = (install) => (providerOf(install.provider_key)?.inbound ? `/api/v1/webhooks/integrations/${install.id}` : null);
const shape = (r, p) => ({
  id: r.id, organisation_id: r.organisation_id, provider_key: r.provider_key, category: r.category, provider_version: r.provider_version, provider_name: p?.name ?? r.provider_key,
  label: r.label, mode: r.mode, status: r.status, scopes_granted: r.scopes_granted, rate_per_minute: r.rate_per_minute, sync_every_minutes: r.sync_every_minutes,
  next_sync_at: r.next_sync_at, last_success_at: r.last_success_at, last_attempt_at: r.last_attempt_at, last_error: r.last_error, created_at: r.created_at, webhook_path: webhookPath(r),
  update_available: !!p && p.version !== r.provider_version,
});

/** Load an install the caller may administer. 404 for outsiders and for missing rows alike. */
async function installFor(user, installId, { write = false } = {}) {
  const row = await one('SELECT * FROM integration_installs WHERE id=$1', [installId]);
  if (!row) throw notFound('Integration');
  await orgFor(user, row.organisation_id, ADMINS, { write });
  return row;
}
const splitConfig = (p, cfg) => {
  const secret = {}; const plain = {};
  for (const [k, v] of Object.entries(cfg)) (p.secrets.includes(k) ? secret : plain)[k] = v;
  return { secret, plain };
};
const checkUrls = (cfg) => { for (const k of ['url', 'sandbox_url']) if (cfg[k]) { const bad = checkTarget(cfg[k]); if (bad) throw badRequest(`${k}: ${bad}`); } };
const hint = (secret) => { const v = Object.values(secret)[0]; return typeof v === 'string' && v.length > 8 && !/^https?:/.test(v) ? `…${v.slice(-4)}` : null; };

async function openCredential(c, installId, kind, secretObj, userId, hintText) {
  await c.query('UPDATE integration_credentials SET effective_to=now() WHERE install_id=$1 AND kind=$2 AND effective_to IS NULL', [installId, kind]);
  await c.query('INSERT INTO integration_credentials(install_id, kind, secret_enc, hint, created_by) VALUES ($1,$2,$3,$4,$5)', [installId, kind, encrypt(typeof secretObj === 'string' ? secretObj : JSON.stringify(secretObj), CRED_CTX), hintText ?? null, userId]);
}

cap({
  name: 'list_integration_catalogue', method: 'GET', path: '/integrations/catalogue', tag: TAG,
  summary: 'Every integration a tenant can connect, by category: its version, capabilities, authentication, the data scopes it asks for, whether it supports a sandbox, and the settings it needs. Integrations that already have their own console (payments, single sign-on, WhatsApp/SMS) are listed with where to manage them.',
  input: z.object({ category: z.enum(CATEGORIES).optional(), country: z.string().length(2).optional().describe('ISO-3166-1 alpha-2 country code — filters providers scoped to a country (providers with no country are always included)'), organisation_id: id.optional().describe('Add this organisation\'s access state to every provider') }),
  async handler({ user }, i) {
    let access = {};
    if (i.organisation_id) {
      await orgFor(user, i.organisation_id, ADMINS);
      const rows = await many("SELECT DISTINCT ON (provider_key) provider_key, status FROM integration_access_requests WHERE organisation_id=$1 AND provider_key IS NOT NULL AND status NOT IN ('withdrawn') ORDER BY provider_key, (status='enabled') DESC, created_at DESC", [i.organisation_id]);
      access = Object.fromEntries(rows.map((r) => [r.provider_key, r.status]));
    }
    const platform = await isPlatformAdminNow(user);
    const live = Object.entries(PROVIDERS).map(([k, p]) => ({ ...describe(k, p), gated: true, access: platform ? 'enabled' : (access[k] ?? 'none') }))
      .filter((p) => !PROVIDERS[p.key].private || p.access === 'enabled')
      .filter((p) => !i.country || !PROVIDERS[p.key].country || PROVIDERS[p.key].country === '' || PROVIDERS[p.key].country === i.country);
    const managed = MANAGED.map((m) => ({ key: m.key, category: m.category, name: m.name, version: null, auth: null, sandbox: false, capabilities: [], scopes: [], credential_fields: [], fields: [], sync: false, inbound_webhook: false, managed_in: m.managed_in }));
    return { categories: CATEGORIES, providers: [...live, ...managed].filter((p) => !i.category || p.category === i.category), event_types: EVENT_TYPES };
  },
});

cap({
  name: 'list_integrations', method: 'GET', path: '/organisations/:organisation_id/integrations', tag: TAG,
  summary: 'The integrations connected for an organisation, with status, last success, last error and next scheduled sync. Disconnected ones are kept and shown when include_disconnected is true. Organisation owner or admin.',
  input: z.object({ organisation_id: id, include_disconnected: z.boolean().default(false), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, ADMINS);
    const rows = await many("SELECT * FROM integration_installs WHERE organisation_id=$1 AND ($2 OR status <> 'disconnected') ORDER BY created_at DESC LIMIT $3 OFFSET $4", [i.organisation_id, i.include_disconnected, i.limit, i.offset]);
    return { items: rows.map((r) => shape(r, providerOf(r.provider_key))) };
  },
});

cap({
  name: 'install_integration', method: 'POST', path: '/organisations/:organisation_id/integrations', tag: TAG, status: 201,
  summary: 'Connect a provider for an organisation. External integrations must first be enabled for the organisation by the platform team (see request_integration_access); otherwise this answers 403 integration_not_enabled. accept_scopes must list every data scope the provider asks for (see the catalogue), so the permissions are acknowledged. Credentials in settings are encrypted and never returned; for signed-webhook providers the webhook secret is generated and shown once in the response. Sandbox mode is only for providers that support it. Organisation owner or admin.',
  input: z.object({
    organisation_id: id, provider_key: z.string().max(60), event_id: id.optional().describe('Connect for one event or tournament (needs access enabled for it, or organisation-wide)'), label: z.string().min(2).max(80), mode: z.enum(['live', 'sandbox']).default('live'),
    settings: z.record(z.any()).default({}), accept_scopes: z.array(z.string().max(60)).max(20),
    rate_per_minute: z.number().int().min(1).max(6000).default(60), sync_every_minutes: z.number().int().min(15).max(10080).optional(),
  }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, ADMINS, { write: true });
    if (MANAGED.some((m) => m.key === i.provider_key)) throw conflict(`This integration is managed in ${MANAGED.find((m) => m.key === i.provider_key).managed_in}`);
    const p = providerOf(i.provider_key);
    if (!p) throw notFound('Integration provider');
    if (p.athlete_scoped) throw conflict('Athletes connect their own account for this provider (Recovery → Connected devices). Request access here so your organisation is authorised.');
    if (i.event_id && !(await one('SELECT 1 AS x FROM events WHERE id=$1 AND organisation_id=$2', [i.event_id, i.organisation_id]))) throw notFound('Event');
    const access = await requireIntegrationAccess(user, i.organisation_id, i.provider_key, i.event_id ?? null);
    if (i.mode === 'sandbox' && !p.sandbox) throw badRequest('This provider has no sandbox');
    const missing = p.scopes.map((s) => s.key).filter((k) => !i.accept_scopes.includes(k));
    if (missing.length) throw badRequest(`Accept the requested permissions first: ${missing.join(', ')}`);
    const parsed = p.fields.safeParse(i.settings);
    if (!parsed.success) throw badRequest(`Settings are incomplete: ${parsed.error.issues.map((x) => x.path.join('.') || x.message).join(', ')}`);
    checkUrls(parsed.data);
    if (i.sync_every_minutes && !p.pull) throw badRequest('This provider does not sync on a schedule');
    const { secret, plain } = splitConfig(p, parsed.data);
    return tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO integration_installs(organisation_id, provider_key, category, provider_version, label, mode, scopes_granted, config_enc, rate_per_minute, sync_every_minutes, next_sync_at, created_by, event_id, access_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $10::int IS NULL THEN NULL ELSE now() END, $11, $12, $13) RETURNING *`,
        [i.organisation_id, i.provider_key, p.category, p.version, i.label, i.mode, p.scopes.map((s) => s.key), Object.keys(plain).length ? encrypt(JSON.stringify(plain), CFG_CTX) : null, i.rate_per_minute, i.sync_every_minutes ?? null, user.id, i.event_id ?? null, access?.id ?? null])).rows[0];
      if (Object.keys(secret).length) await openCredential(c, r.id, p.auth === 'oauth2' ? 'oauth_token' : 'api_key', secret, user.id, hint(secret));
      let generated = null;
      if (p.generatesWebhookSecret) { generated = newOpaqueToken(); await openCredential(c, r.id, 'webhook_secret', generated, user.id, `…${generated.slice(-4)}`); }
      await audit(c, user.id, 'install_integration', 'integration_installs', r.id);
      return { ...shape(r, p), ...(generated ? { webhook_secret: generated, webhook_secret_note: 'Shown once. Sign each delivery body with HMAC-SHA256 and send it as x-sportarena-signature.' } : {}) };
    });
  },
});

cap({
  name: 'get_integration', method: 'GET', path: '/integrations/:id', tag: TAG,
  summary: 'One connection in full: status, requested and granted scopes, provider version (and whether a newer one exists), credential hints (never the values), sync health, rate limit and the last 14 days of usage (calls, failures, refusals).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id);
    const p = providerOf(r.provider_key);
    const creds = await many('SELECT kind, hint, effective_from, effective_to, revoked FROM integration_credentials WHERE install_id=$1 ORDER BY effective_from DESC LIMIT 10', [r.id]);
    const usage = await many("SELECT day, calls, failures, refused FROM integration_usage WHERE install_id=$1 AND day >= CURRENT_DATE - 13 ORDER BY day DESC", [r.id]);
    return { ...shape(r, p), capabilities: p?.capabilities ?? [], requested_scopes: p?.scopes ?? [], sandbox_supported: !!p?.sandbox, credentials: creds, usage };
  },
});

cap({
  name: 'update_integration', method: 'PATCH', path: '/integrations/:id', tag: TAG,
  summary: 'Change a connection: its name, live/sandbox mode, rate limit, sync schedule, or pause/resume it. Organisation owner or admin.',
  input: z.object({ id, label: z.string().min(2).max(80).optional(), mode: z.enum(['live', 'sandbox']).optional(), rate_per_minute: z.number().int().min(1).max(6000).optional(), sync_every_minutes: z.number().int().min(15).max(10080).nullable().optional(), status: z.enum(['connected', 'paused']).optional() }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    if (r.status === 'disconnected') throw conflict('This connection is disconnected');
    const p = providerOf(r.provider_key);
    if (i.mode === 'sandbox' && !p?.sandbox) throw badRequest('This provider has no sandbox');
    if (i.sync_every_minutes && !p?.pull) throw badRequest('This provider does not sync on a schedule');
    if (i.status === 'connected') await requireIntegrationAccess(user, r.organisation_id, r.provider_key, r.event_id);
    const next = i.sync_every_minutes === undefined ? undefined : i.sync_every_minutes;
    const row = await one(
      `UPDATE integration_installs SET label=coalesce($2,label), mode=coalesce($3,mode), rate_per_minute=coalesce($4,rate_per_minute), status=coalesce($5,status),
         sync_every_minutes = CASE WHEN $6::boolean THEN $7::int ELSE sync_every_minutes END,
         next_sync_at = CASE WHEN $6::boolean THEN (CASE WHEN $7::int IS NULL THEN NULL ELSE now() END) ELSE next_sync_at END, updated_at=now() WHERE id=$1 RETURNING *`,
      [r.id, i.label ?? null, i.mode ?? null, i.rate_per_minute ?? null, i.status ?? null, next !== undefined, next ?? null]);
    await audit(null, user.id, 'update_integration', 'integration_installs', r.id);
    return shape(row, p);
  },
});

cap({
  name: 'disconnect_integration', method: 'DELETE', path: '/integrations/:id', tag: TAG,
  summary: 'Disconnect a provider. Its credentials are revoked at once and syncing and inbound deliveries stop; the connection, its log, usage and external-ID mappings are kept as history. Organisation owner or admin.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    await tx(async (c) => {
      await c.query("UPDATE integration_installs SET status='disconnected', disconnected_at=now(), next_sync_at=NULL, updated_at=now() WHERE id=$1", [r.id]);
      await c.query('UPDATE integration_credentials SET effective_to=now(), revoked=true WHERE install_id=$1 AND effective_to IS NULL', [r.id]);
      await audit(c, user.id, 'disconnect_integration', 'integration_installs', r.id);
    });
    await logEvent(r.id, 'disconnect', 'ok', 'Disconnected');
    return { disconnected: true };
  },
});

cap({
  name: 'test_integration', method: 'POST', path: '/integrations/:id/test', tag: TAG,
  summary: 'Check that a connection works right now (reachability and credentials) without changing any data. The result is logged. Counts against the connection\'s rate limit.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    if (r.status === 'disconnected' || r.status === 'paused') throw conflict('This connection is disconnected or paused');
    if (!(await allowCall(r))) throw tooMany('This connection is over its rate limit; try again in a minute');
    const p = providerOf(r.provider_key); let cfg = {};
    try {
      cfg = await loadConfig(r);
      const out = await p.test(cfg, { mode: r.mode });
      await logEvent(r.id, 'test', 'ok', out.message);
      return out;
    } catch (e) {
      const msg = scrub(e.message, cfg);
      await logEvent(r.id, 'test', 'failed', msg);
      return { ok: false, message: msg };
    }
  },
});

cap({
  name: 'sync_integration', method: 'POST', path: '/integrations/:id/sync', tag: TAG,
  summary: 'Run a sync now (also the way to retry after a failure). Returns the outcome and updates last success / last error. Providers that only receive deliveries have nothing to sync.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    if (r.status === 'disconnected' || r.status === 'paused') throw conflict('Resume the connection before syncing');
    if (!providerOf(r.provider_key)?.pull) throw badRequest('This provider does not sync; it receives deliveries');
    await audit(null, user.id, 'sync_integration', 'integration_installs', r.id);
    return runSync(r.id, { manual: true });
  },
});

cap({
  name: 'rotate_integration_credential', method: 'POST', path: '/integrations/:id/credentials/rotate', tag: TAG,
  summary: 'Replace a connection\'s credentials. For providers with an API key or address, send the new values in settings (only the credential fields; they are encrypted and the old ones are closed but kept as history). For signed-webhook providers a new webhook secret is generated and shown once. The old credential stops working immediately.',
  input: z.object({ id, settings: z.record(z.any()).default({}) }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    if (r.status === 'disconnected') throw conflict('This connection is disconnected');
    const p = providerOf(r.provider_key);
    await requireIntegrationAccess(user, r.organisation_id, r.provider_key, r.event_id);
    let generated = null;
    await tx(async (c) => {
      if (p.secrets.length) {
        const cur = await loadConfig(r, c);
        const next = { ...cur, ...i.settings };
        const parsed = p.fields.safeParse(next);
        if (!parsed.success) throw badRequest(`Settings are incomplete: ${parsed.error.issues.map((x) => x.path.join('.') || x.message).join(', ')}`);
        checkUrls(parsed.data);
        const { secret } = splitConfig(p, parsed.data);
        await openCredential(c, r.id, p.auth === 'oauth2' ? 'oauth_token' : 'api_key', secret, user.id, hint(secret));
      }
      if (p.generatesWebhookSecret) { generated = newOpaqueToken(); await openCredential(c, r.id, 'webhook_secret', generated, user.id, `…${generated.slice(-4)}`); }
      if (!p.secrets.length && !generated) throw badRequest('This provider has no credentials to rotate');
      await c.query("UPDATE integration_installs SET status = CASE WHEN status='paused' THEN 'connected' ELSE status END, updated_at=now() WHERE id=$1", [r.id]);
      await audit(c, user.id, 'rotate_integration_credential', 'integration_installs', r.id);
    });
    await logEvent(r.id, 'rotate', 'ok', 'Credentials rotated');
    return { rotated: true, ...(generated ? { webhook_secret: generated } : {}) };
  },
});

cap({
  name: 'revoke_integration_credential', method: 'POST', path: '/integrations/:id/credentials/revoke', tag: TAG,
  summary: 'Revoke a connection\'s credentials without disconnecting it: syncing and inbound deliveries stop, the connection is paused, and rotating credentials later brings it back. Kept as history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    if (r.status === 'disconnected') throw conflict('This connection is disconnected');
    await tx(async (c) => {
      await c.query('UPDATE integration_credentials SET effective_to=now(), revoked=true WHERE install_id=$1 AND effective_to IS NULL', [r.id]);
      await c.query("UPDATE integration_installs SET status='paused', next_sync_at=NULL, updated_at=now() WHERE id=$1", [r.id]);
      await audit(c, user.id, 'revoke_integration_credential', 'integration_installs', r.id);
    });
    await logEvent(r.id, 'revoke', 'ok', 'Credentials revoked');
    return { revoked: true };
  },
});

cap({
  name: 'list_integration_events', method: 'GET', path: '/integrations/:id/events', tag: TAG,
  summary: 'The connection\'s log, newest first: syncs, tests, inbound and outbound deliveries, rotations. Messages never contain credentials. Filter by status.',
  input: z.object({ id, status: z.enum(['ok', 'failed', 'retrying', 'refused']).optional(), ...page }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id);
    const rows = await many('SELECT id, kind, status, message, detail, attempts, created_at FROM integration_events WHERE install_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4', [r.id, i.status ?? null, i.limit, i.offset]);
    return { items: rows };
  },
});

cap({
  name: 'map_external_id', method: 'POST', path: '/integrations/:id/external-ids', tag: TAG, status: 201,
  summary: 'Link one of our records (user, team, event or venue) to its identifier in the connected system, so later syncs and deliveries match the same thing. One mapping per record and per external id; remapping needs the old one removed first.',
  input: z.object({ id, entity_type: z.enum(Object.keys(ENTITIES)), internal_id: id, external_id: z.string().min(1).max(200) }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    if (!(await one(`SELECT 1 AS x FROM ${ENTITIES[i.entity_type]} WHERE id=$1`, [i.internal_id]))) throw notFound('Record');
    try {
      const row = await one('INSERT INTO integration_external_ids(install_id, entity_type, internal_id, external_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, entity_type, internal_id, external_id, created_at', [r.id, i.entity_type, i.internal_id, i.external_id, user.id]);
      await audit(null, user.id, 'map_external_id', 'integration_external_ids', row.id);
      return row;
    } catch (e) { if (e.code === '23505') throw conflict('That record or external id is already mapped'); throw e; }
  },
});

cap({
  name: 'list_external_ids', method: 'GET', path: '/integrations/:id/external-ids', tag: TAG,
  summary: 'The record mappings for a connection. Filter by entity type.',
  input: z.object({ id, entity_type: z.enum(Object.keys(ENTITIES)).optional(), ...page }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id);
    return { items: await many('SELECT id, entity_type, internal_id, external_id, created_at FROM integration_external_ids WHERE install_id=$1 AND archived_at IS NULL AND ($2::text IS NULL OR entity_type=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4', [r.id, i.entity_type ?? null, i.limit, i.offset]) };
  },
});

cap({
  name: 'unmap_external_id', method: 'DELETE', path: '/integrations/:id/external-ids/:mapping_id', tag: TAG,
  summary: 'Remove a mapping (kept as history, so it can be mapped again).',
  input: z.object({ id, mapping_id: id }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    const row = await one('UPDATE integration_external_ids SET archived_at=now() WHERE id=$1 AND install_id=$2 AND archived_at IS NULL RETURNING id', [i.mapping_id, r.id]);
    if (!row) throw notFound('Mapping');
    await audit(null, user.id, 'unmap_external_id', 'integration_external_ids', row.id);
    return { removed: true };
  },
});

cap({
  name: 'subscribe_integration_webhook', method: 'POST', path: '/organisations/:organisation_id/integration-webhooks', tag: TAG, status: 201,
  summary: 'Subscribe an https address to integration events (sync succeeded/failed, inbound delivery received), for the whole organisation or one connection. Each delivery is signed: x-sportarena-signature = sha256 HMAC of "<x-sportarena-timestamp>.<body>" with the secret shown once here. Failed deliveries retry with backoff and are then parked for an admin.',
  input: z.object({ organisation_id: id, url: z.string().url().max(500), event_types: z.array(z.enum(EVENT_TYPES)).min(1), install_id: id.optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, ADMINS, { write: true });
    if (!(await isPlatformAdminNow(user)) && !(await one("SELECT 1 AS x FROM integration_access_requests WHERE organisation_id=$1 AND status='enabled'", [i.organisation_id]))) throw new AppError(403, 'integration_not_enabled', 'Event subscriptions to external systems are enabled by the platform team. Request access first.');
    const bad = checkTarget(i.url); if (bad) throw badRequest(bad);
    if (i.install_id && !(await one('SELECT 1 AS x FROM integration_installs WHERE id=$1 AND organisation_id=$2', [i.install_id, i.organisation_id]))) throw notFound('Integration');
    const secret = newOpaqueToken();
    const row = await one('INSERT INTO integration_webhooks(organisation_id, install_id, url, event_types, secret_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, install_id, url, event_types, status, created_at', [i.organisation_id, i.install_id ?? null, i.url, i.event_types, encrypt(secret, HOOK_CTX), user.id]);
    await audit(null, user.id, 'subscribe_integration_webhook', 'integration_webhooks', row.id);
    return { ...row, secret };
  },
});

cap({
  name: 'list_integration_webhooks', method: 'GET', path: '/organisations/:organisation_id/integration-webhooks', tag: TAG,
  summary: 'The event subscriptions of an organisation (secrets are never shown again).',
  input: z.object({ organisation_id: id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, ADMINS);
    return { items: await many("SELECT id, install_id, url, event_types, status, created_at, revoked_at FROM integration_webhooks WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [i.organisation_id, i.limit, i.offset]) };
  },
});

cap({
  name: 'revoke_integration_webhook', method: 'DELETE', path: '/integration-webhooks/:id', tag: TAG,
  summary: 'Stop an event subscription (kept as history).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const h = await one('SELECT * FROM integration_webhooks WHERE id=$1', [i.id]);
    if (!h) throw notFound('Subscription');
    await orgFor(user, h.organisation_id, ADMINS, { write: true });
    await one("UPDATE integration_webhooks SET status='revoked', revoked_at=now() WHERE id=$1 RETURNING id", [h.id]);
    await audit(null, user.id, 'revoke_integration_webhook', 'integration_webhooks', h.id);
    return { revoked: true };
  },
});

cap({
  name: 'update_integration_provider', method: 'POST', path: '/integrations/:id/update-provider', tag: TAG,
  summary: 'Migrate an installed integration to the latest provider version. Re-validates existing settings against the new schema; if validation fails you must update settings first via update_integration. Returns the updated install row.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await installFor(user, i.id, { write: true });
    const p = providerOf(r.provider_key);
    if (!p) throw notFound('Provider');
    if (p.version === r.provider_version) throw conflict('Already on the latest provider version');
    const cfg = await loadConfig(r);
    const parsed = p.fields.safeParse(cfg);
    if (!parsed.success) throw badRequest(`Settings are incompatible with provider v${p.version}: ${parsed.error.issues.map((x) => x.path.join('.') || x.message).join(', ')}. Update your settings first.`);
    const updated = await one(
      "UPDATE integration_installs SET provider_version=$1, updated_at=now() WHERE id=$2 RETURNING *",
      [p.version, r.id],
    );
    await audit(null, user.id, 'update_integration_provider', 'integration_installs', r.id);
    await logEvent(r.id, 'update_provider', 'ok', `Migrated from v${r.provider_version} to v${p.version}`);
    return shape(updated, p);
  },
});

