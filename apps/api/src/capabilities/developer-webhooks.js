// Developer Platform (#569): developer webhook subscription management.
// These subscriptions fire on canonical domain events; clinical event types are structurally absent.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, newOpaqueToken } from '../crypto.js';
import { PLATFORM_EVENT_TYPES, DEV_HOOK_CTX, newWebhookSecret } from '../integrations/developer-webhooks.js';
import { checkTarget } from '../integrations/http.js';
import { enqueue } from '../jobs.js';
import { randomUUID } from 'node:crypto';

const TAG = 'Developer';

async function subFor(user, subId, { write = false } = {}) {
  const row = await one('SELECT s.*, a.owner_user_id FROM developer_webhook_subscriptions s JOIN developer_apps a ON a.id = s.developer_app_id WHERE s.id=$1', [subId]);
  if (!row) throw notFound('Webhook subscription');
  if (row.owner_user_id !== user.id) throw write ? forbidden('Only the app owner may modify it') : notFound('Webhook subscription');
  return row;
}

async function appOwnedBy(user, appId) {
  const app = await one('SELECT * FROM developer_apps WHERE id=$1', [appId]);
  if (!app) throw notFound('Developer app');
  if (app.owner_user_id !== user.id) throw notFound('Developer app');
  return app;
}

cap({
  name: 'create_developer_webhook',
  method: 'POST',
  path: '/developer/apps/:app_id/webhooks',
  tag: TAG,
  status: 201,
  summary: 'Subscribe a developer app to one or more platform event types. The signing secret is returned once; use it to verify HMAC-SHA256 signatures on deliveries.',
  input: z.object({
    app_id: id,
    url: z.string().url().max(500),
    event_types: z.array(z.enum(PLATFORM_EVENT_TYPES)).min(1).max(50),
  }),
  async handler({ user }, i) {
    await appOwnedBy(user, i.app_id);
    const bad = checkTarget(i.url);
    if (bad) throw badRequest(`url: ${bad}`);
    const secret = newWebhookSecret();
    const row = await tx(async (c) => {
      const r = await c.query(
        'INSERT INTO developer_webhook_subscriptions(developer_app_id, url, secret_enc, secret_hint, event_types) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [i.app_id, i.url, encrypt(secret, DEV_HOOK_CTX), `…${secret.slice(-4)}`, i.event_types],
      );
      await audit(c, user.id, 'create_developer_webhook', 'developer_webhook_subscriptions', r.rows[0].id);
      return r.rows[0];
    });
    return { ...shapeHook(row), webhook_secret: secret };
  },
});

cap({
  name: 'list_developer_webhooks',
  method: 'GET',
  path: '/developer/apps/:app_id/webhooks',
  tag: TAG,
  summary: 'All webhook subscriptions for a developer app, with health status.',
  input: z.object({ app_id: id, ...page }),
  async handler({ user }, i) {
    await appOwnedBy(user, i.app_id);
    const rows = await many(
      "SELECT * FROM developer_webhook_subscriptions WHERE developer_app_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [i.app_id, i.limit, i.offset],
    );
    return { items: rows.map(shapeHook) };
  },
});

cap({
  name: 'update_developer_webhook',
  method: 'PATCH',
  path: '/developer/apps/:app_id/webhooks/:id',
  tag: TAG,
  summary: 'Update a webhook subscription: change URL, event types, or pause/resume deliveries.',
  input: z.object({
    app_id: id, id,
    url: z.string().url().max(500).optional(),
    event_types: z.array(z.enum(PLATFORM_EVENT_TYPES)).min(1).max(50).optional(),
    status: z.enum(['active', 'paused']).optional(),
  }),
  async handler({ user }, i) {
    const sub = await subFor(user, i.id, { write: true });
    if (sub.status === 'revoked') throw forbidden('Revoked webhooks cannot be updated');
    if (i.url) { const bad = checkTarget(i.url); if (bad) throw badRequest(`url: ${bad}`); }
    const sets = []; const vals = [sub.id];
    if (i.url) sets.push(`url = $${vals.push(i.url)}`);
    if (i.event_types) sets.push(`event_types = $${vals.push(i.event_types)}`);
    if (i.status) sets.push(`status = $${vals.push(i.status)}`);
    if (!sets.length) return shapeHook(sub);
    sets.push('updated_at = now()');
    const row = await one(`UPDATE developer_webhook_subscriptions SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    await audit(null, user.id, 'update_developer_webhook', 'developer_webhook_subscriptions', sub.id);
    return shapeHook(row);
  },
});

cap({
  name: 'rotate_developer_webhook_secret',
  method: 'POST',
  path: '/developer/apps/:app_id/webhooks/:id/rotate-secret',
  tag: TAG,
  summary: 'Rotate the HMAC signing secret for a webhook subscription. The new secret is returned once only. Update your endpoint verification immediately.',
  input: z.object({ app_id: id, id }),
  async handler({ user }, i) {
    const sub = await subFor(user, i.id, { write: true });
    if (sub.status === 'revoked') throw forbidden('Revoked webhooks cannot be updated');
    const secret = newWebhookSecret();
    await tx(async (c) => {
      await c.query('UPDATE developer_webhook_subscriptions SET secret_enc=$2, secret_hint=$3, updated_at=now() WHERE id=$1', [sub.id, encrypt(secret, DEV_HOOK_CTX), `…${secret.slice(-4)}`]);
      await audit(c, user.id, 'rotate_developer_webhook_secret', 'developer_webhook_subscriptions', sub.id);
    });
    return { webhook_secret: secret };
  },
});

cap({
  name: 'delete_developer_webhook',
  method: 'POST',
  path: '/developer/apps/:app_id/webhooks/:id/delete',
  tag: TAG,
  summary: 'Soft-delete (revoke) a webhook subscription. Pending deliveries are abandoned.',
  input: z.object({ app_id: id, id }),
  async handler({ user }, i) {
    const sub = await subFor(user, i.id, { write: true });
    await tx(async (c) => {
      await c.query("UPDATE developer_webhook_subscriptions SET status='revoked', updated_at=now() WHERE id=$1", [sub.id]);
      await audit(c, user.id, 'delete_developer_webhook', 'developer_webhook_subscriptions', sub.id);
    });
    return { id: sub.id, status: 'revoked' };
  },
});

cap({
  name: 'test_developer_webhook',
  method: 'POST',
  path: '/developer/apps/:app_id/webhooks/:id/test',
  tag: TAG,
  summary: 'Send a synthetic test event to verify your endpoint is reachable and your signature verification works.',
  input: z.object({ app_id: id, id, event_type: z.enum(PLATFORM_EVENT_TYPES).optional() }),
  async handler({ user }, i) {
    const sub = await subFor(user, i.id);
    if (sub.status === 'revoked') throw forbidden('Revoked webhook');
    const eventType = i.event_type ?? sub.event_types[0];
    const testEntityId = `test-${randomUUID()}`;
    await enqueue(null, {
      category: 'developer',
      kind: 'deliver_developer_webhook',
      payload: { sub_id: sub.id, app_id: sub.developer_app_id, type: eventType, data: { test: true }, event_entity_id: testEntityId },
      dedupeKey: null,
      maxAttempts: 1,
    });
    return { queued: true, event_type: eventType };
  },
});

cap({
  name: 'list_developer_webhook_deliveries',
  method: 'GET',
  path: '/developer/apps/:app_id/webhooks/:id/deliveries',
  tag: TAG,
  summary: 'Recent webhook delivery attempts (from the jobs log) for one subscription.',
  input: z.object({ app_id: id, id, ...page }),
  async handler({ user }, i) {
    const sub = await subFor(user, i.id);
    const rows = await many(
      `SELECT id, status, attempts, run_at, finished_at, last_error, payload->>'type' AS event_type, created_at
         FROM jobs
        WHERE kind='deliver_developer_webhook' AND payload->>'sub_id' = $1
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [sub.id, i.limit, i.offset],
    );
    return { items: rows };
  },
});

function shapeHook(h) {
  return {
    id: h.id, developer_app_id: h.developer_app_id, url: h.url,
    secret_hint: h.secret_hint, event_types: h.event_types, status: h.status,
    last_success_at: h.last_success_at, last_error: h.last_error,
    failure_count: h.failure_count, created_at: h.created_at, updated_at: h.updated_at,
  };
}
