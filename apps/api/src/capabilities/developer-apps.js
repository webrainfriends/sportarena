// Developer Platform (#569): developer app registration, API key management, usage dashboard.
// Every developer app gets a client_id (sa_dev_<uuid>) and an optional client_secret (sk_live_/sk_test_).
// Secrets are write-only: shown once at creation/rotation, stored encrypted, never read back.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { notFound, forbidden } from '../errors.js';
import { audit } from '../helpers.js';
import { newOpaqueToken, encrypt, sha256 } from '../crypto.js';
import { mustBePlatformAdmin } from '../platform.js';
import { SCOPES } from '../scopes.js';

const TAG = 'Developer';
const DEV_SECRET_CTX = 'developer_apps.client_secret';

// Allowed scopes for developer apps: clinical and admin are never grantable
const APP_SCOPES = SCOPES.filter((s) => !['clinical', 'admin'].includes(s));

async function appFor(user, appId, { write = false } = {}) {
  const row = await one('SELECT * FROM developer_apps WHERE id=$1', [appId]);
  if (!row) throw notFound('Developer app');
  if (row.owner_user_id !== user.id) {
    if (write) throw forbidden('Only the app owner may modify it');
    throw notFound('Developer app');
  }
  return row;
}

const mintSecret = (sandbox) => `${sandbox ? 'sk_test_' : 'sk_live_'}${newOpaqueToken().replace('sa_', '')}`;
const secretHint = (s) => `…${s.slice(-4)}`;

cap({
  name: 'create_developer_app',
  method: 'POST',
  path: '/developer/apps',
  tag: TAG,
  status: 201,
  summary: 'Register a new developer app. Returns the client_id and client_secret (shown once only). The secret is stored encrypted and never returned again; rotate it if lost.',
  input: z.object({
    name: z.string().min(2).max(120),
    description: z.string().max(1000).optional(),
    website_url: z.string().url().max(500).optional(),
    redirect_uris: z.array(z.string().url().startsWith('https://')).max(20).default([]),
    allowed_scopes: z.array(z.enum(APP_SCOPES)).min(1).default(['read']),
    sandbox_mode: z.boolean().default(true),
  }),
  async handler({ user }, i) {
    const secret = mintSecret(i.sandbox_mode);
    const row = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO developer_apps(owner_user_id, name, description, website_url, redirect_uris, allowed_scopes, sandbox_mode, client_secret_enc, client_secret_hint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [user.id, i.name, i.description ?? null, i.website_url ?? null, i.redirect_uris, i.allowed_scopes, i.sandbox_mode, encrypt(secret, DEV_SECRET_CTX), secretHint(secret)],
      );
      await audit(c, user.id, 'create_developer_app', 'developer_apps', r.rows[0].id);
      return r.rows[0];
    });
    return { id: row.id, client_id: row.client_id, client_secret: secret, sandbox_mode: row.sandbox_mode, name: row.name, created_at: row.created_at };
  },
});

cap({
  name: 'list_developer_apps',
  method: 'GET',
  path: '/developer/apps',
  tag: TAG,
  summary: 'All developer apps registered by the signed-in user, with today\'s usage summary.',
  input: z.object({ ...page, include_revoked: z.boolean().default(false) }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT a.*, u.calls AS calls_today, u.errors AS errors_today, u.webhook_fires AS webhook_fires_today
         FROM developer_apps a
         LEFT JOIN developer_app_usage u ON u.developer_app_id = a.id AND u.day = CURRENT_DATE
        WHERE a.owner_user_id = $1 AND ($2 OR a.status <> 'revoked')
        ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
      [user.id, i.include_revoked, i.limit, i.offset],
    );
    return { items: rows.map(shape) };
  },
});

cap({
  name: 'get_developer_app',
  method: 'GET',
  path: '/developer/apps/:id',
  tag: TAG,
  summary: 'Full detail for a developer app: config, stats, active token count, active webhook count.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const app = await appFor(user, i.id);
    const [usage, tokens, hooks] = await Promise.all([
      many('SELECT * FROM developer_app_usage WHERE developer_app_id=$1 ORDER BY day DESC LIMIT 30', [i.id]),
      one('SELECT count(*) AS n FROM oauth_tokens WHERE developer_app_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [i.id]),
      one("SELECT count(*) AS n FROM developer_webhook_subscriptions WHERE developer_app_id=$1 AND status='active'", [i.id]),
    ]);
    return { ...shape(app), usage_30d: usage, active_tokens: Number(tokens?.n ?? 0), active_webhooks: Number(hooks?.n ?? 0) };
  },
});

cap({
  name: 'update_developer_app',
  method: 'PATCH',
  path: '/developer/apps/:id',
  tag: TAG,
  summary: 'Update the app\'s name, description, website URL, redirect URIs, allowed scopes or sandbox mode.',
  input: z.object({
    id,
    name: z.string().min(2).max(120).optional(),
    description: z.string().max(1000).optional(),
    website_url: z.string().url().max(500).nullable().optional(),
    redirect_uris: z.array(z.string().url().startsWith('https://')).max(20).optional(),
    allowed_scopes: z.array(z.enum(APP_SCOPES)).min(1).optional(),
    sandbox_mode: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    const app = await appFor(user, i.id, { write: true });
    if (app.status === 'revoked') throw forbidden('Revoked apps cannot be updated');
    const { id: _, ...fields } = i;
    const sets = []; const vals = [app.id];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = $${vals.push(v)}`);
    }
    if (!sets.length) return shape(app);
    sets.push('updated_at = now()');
    const row = await one(`UPDATE developer_apps SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    await audit(null, user.id, 'update_developer_app', 'developer_apps', app.id);
    return shape(row);
  },
});

cap({
  name: 'rotate_developer_app_secret',
  method: 'POST',
  path: '/developer/apps/:id/rotate-secret',
  tag: TAG,
  summary: 'Rotate the client_secret. The new secret is returned once only. All existing OAuth tokens remain valid until they expire or are revoked.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const app = await appFor(user, i.id, { write: true });
    if (app.status === 'revoked') throw forbidden('Revoked apps cannot be updated');
    const secret = mintSecret(app.sandbox_mode);
    await tx(async (c) => {
      await c.query('UPDATE developer_apps SET client_secret_enc=$2, client_secret_hint=$3, updated_at=now() WHERE id=$1', [app.id, encrypt(secret, DEV_SECRET_CTX), secretHint(secret)]);
      await audit(c, user.id, 'rotate_developer_app_secret', 'developer_apps', app.id);
    });
    return { client_secret: secret };
  },
});

cap({
  name: 'suspend_developer_app',
  method: 'POST',
  path: '/developer/apps/:id/suspend',
  tag: TAG,
  summary: 'Platform admin: suspend or reinstate a developer app. All tokens stop working while suspended.',
  auth: ['admin'],
  input: z.object({ id, suspended: z.boolean() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const app = await one('SELECT * FROM developer_apps WHERE id=$1', [i.id]);
    if (!app) throw notFound('Developer app');
    if (app.status === 'revoked') throw forbidden('Revoked apps cannot be updated');
    const newStatus = i.suspended ? 'suspended' : 'active';
    await tx(async (c) => {
      await c.query('UPDATE developer_apps SET status=$2, reviewed_at=now(), reviewed_by=$3, updated_at=now() WHERE id=$1', [app.id, newStatus, user.id]);
      await audit(c, user.id, i.suspended ? 'suspend_developer_app' : 'reinstate_developer_app', 'developer_apps', app.id);
    });
    return { id: app.id, status: newStatus };
  },
});

cap({
  name: 'revoke_developer_app',
  method: 'POST',
  path: '/developer/apps/:id/revoke',
  tag: TAG,
  summary: 'Permanently revoke a developer app. All tokens and webhook subscriptions stop immediately. Irreversible.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const app = await appFor(user, i.id, { write: true });
    if (app.status === 'revoked') return { id: app.id, status: 'revoked' };
    await tx(async (c) => {
      await c.query("UPDATE developer_apps SET status='revoked', client_secret_enc=NULL, updated_at=now() WHERE id=$1", [app.id]);
      await c.query('UPDATE oauth_tokens SET revoked_at=now() WHERE developer_app_id=$1 AND revoked_at IS NULL', [app.id]);
      await c.query("UPDATE developer_webhook_subscriptions SET status='revoked', updated_at=now() WHERE developer_app_id=$1 AND status<>'revoked'", [app.id]);
      await audit(c, user.id, 'revoke_developer_app', 'developer_apps', app.id);
    });
    return { id: app.id, status: 'revoked' };
  },
});

cap({
  name: 'list_developer_app_tokens',
  method: 'GET',
  path: '/developer/apps/:id/tokens',
  tag: TAG,
  summary: 'Active OAuth tokens for this app: who authorised them, what scopes they have, when they expire.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await appFor(user, i.id);
    const rows = await many(
      'SELECT id, user_id, scopes, sandbox_mode, last_used_at, expires_at, created_at FROM oauth_tokens WHERE developer_app_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [i.id, i.limit, i.offset],
    );
    return { items: rows };
  },
});

cap({
  name: 'revoke_developer_app_token',
  method: 'POST',
  path: '/developer/apps/:id/tokens/:token_id/revoke',
  tag: TAG,
  summary: 'Revoke a specific OAuth token for this app.',
  input: z.object({ id, token_id: id }),
  async handler({ user }, i) {
    await appFor(user, i.id, { write: true });
    const r = await one('UPDATE oauth_tokens SET revoked_at=now() WHERE id=$1 AND developer_app_id=$2 AND revoked_at IS NULL RETURNING id', [i.token_id, i.id]);
    if (!r) throw notFound('Token');
    await audit(null, user.id, 'revoke_developer_app_token', 'oauth_tokens', i.token_id);
    return { id: i.token_id, revoked: true };
  },
});

cap({
  name: 'get_developer_app_usage',
  method: 'GET',
  path: '/developer/apps/:id/usage',
  tag: TAG,
  summary: 'Per-day usage for the last N days (default 30): API calls, errors, rate-limit refusals, webhook fires and failures.',
  input: z.object({ id, days: z.coerce.number().int().min(1).max(90).default(30) }),
  async handler({ user }, i) {
    await appFor(user, i.id);
    const rows = await many(
      "SELECT day, calls, errors, rate_refused, webhook_fires, webhook_failures FROM developer_app_usage WHERE developer_app_id=$1 AND day >= CURRENT_DATE - make_interval(days => $2) ORDER BY day DESC",
      [i.id, i.days],
    );
    return { items: rows };
  },
});

cap({
  name: 'list_developer_app_errors',
  method: 'GET',
  path: '/developer/apps/:id/errors',
  tag: TAG,
  summary: 'Recent webhook delivery failures for this app, most recent first.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await appFor(user, i.id);
    const rows = await many(
      "SELECT id, url, event_types, last_error, failure_count, last_success_at, status FROM developer_webhook_subscriptions WHERE developer_app_id=$1 AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
      [i.id, i.limit, i.offset],
    );
    return { items: rows };
  },
});

function shape(app) {
  return {
    id: app.id, client_id: app.client_id, name: app.name, description: app.description,
    website_url: app.website_url, logo_url: app.logo_url,
    client_secret_hint: app.client_secret_hint,
    redirect_uris: app.redirect_uris, allowed_scopes: app.allowed_scopes,
    sandbox_mode: app.sandbox_mode, status: app.status,
    created_at: app.created_at, updated_at: app.updated_at,
    calls_today: app.calls_today ?? null, errors_today: app.errors_today ?? null,
    webhook_fires_today: app.webhook_fires_today ?? null,
  };
}
