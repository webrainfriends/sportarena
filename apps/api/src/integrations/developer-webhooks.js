// Developer Platform (#569): platform event delivery engine for developer webhook subscriptions.
// Distinct from engine.js / integration_webhooks (org-level bilateral integrations).
// These subscriptions fire on canonical domain events (registrations, fixtures, payments, etc.)
// and never carry clinical/health data.
import { createHmac, randomUUID } from 'node:crypto';
import { one, many, query } from '../db.js';
import { decrypt, encrypt, newOpaqueToken } from '../crypto.js';
import { enqueue } from '../jobs.js';
import { runJobs } from '../jobs.js';
import { logger } from '../logger.js';
import { send, checkTarget } from './http.js';

export const DEV_HOOK_CTX = 'developer_webhook_subscriptions.secret';
export const DEV_SECRET_CTX = 'developer_apps.client_secret';

/** Event types that developer apps may subscribe to. Clinical event types are structurally absent. */
export const PLATFORM_EVENT_TYPES = [
  'registration.created', 'registration.cancelled', 'registration.approved',
  'fixture.published', 'fixture.result_final', 'fixture.result_amended',
  'event.published', 'event.cancelled', 'event.rescheduled',
  'payment.completed', 'payment.refunded',
  'ticket.scanned', 'ticket.sold',
  'supplier.award_confirmed', 'supplier.contract_signed',
  'organisation.member_joined', 'organisation.member_left',
];

const bumpUsage = (appId, col) =>
  query(`INSERT INTO developer_app_usage(developer_app_id, day, ${col}) VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (developer_app_id, day) DO UPDATE SET ${col} = developer_app_usage.${col} + 1`, [appId]);

/** One-minute fixed window per developer app. Returns false (and counts a refusal) when over limit. */
export async function allowDeveloperCall(appId, limitPerMinute = 100) {
  const r = await one(
    `INSERT INTO developer_app_windows(developer_app_id, window_start, calls)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (developer_app_id) DO UPDATE
       SET calls = CASE WHEN developer_app_windows.window_start = date_trunc('minute', now())
                        THEN developer_app_windows.calls + 1 ELSE 1 END,
           window_start = date_trunc('minute', now())
     RETURNING calls`,
    [appId],
  );
  if (r.calls > limitPerMinute) {
    await bumpUsage(appId, 'rate_refused');
    return false;
  }
  await bumpUsage(appId, 'calls');
  return true;
}

export const countDeveloperError = (appId) => bumpUsage(appId, 'errors');

/**
 * Fire a canonical platform domain event to all matching developer webhook subscriptions.
 * Called fire-and-forget (after the DB write succeeds) from canonical capability handlers.
 * entityId provides deduplication so a rerun produces no duplicate deliveries.
 */
export async function emitPlatformEvent(type, data, entityId) {
  if (!PLATFORM_EVENT_TYPES.includes(type)) return;
  const subs = await many(
    "SELECT s.id, a.id AS app_id FROM developer_webhook_subscriptions s JOIN developer_apps a ON a.id = s.developer_app_id WHERE s.status='active' AND a.status='active' AND $1 = ANY(s.event_types)",
    [type],
  );
  for (const s of subs) {
    await enqueue(null, {
      category: 'developer',
      kind: 'deliver_developer_webhook',
      payload: { sub_id: s.id, app_id: s.app_id, type, data, event_entity_id: entityId },
      dedupeKey: `${s.id}:${type}:${entityId}`,
      maxAttempts: 6,
    });
  }
}

/** Worker job handler — deliver one event to one developer webhook subscription. */
export async function deliverDeveloperWebhook({ sub_id, app_id, type, data }, job) {
  const sub = await one('SELECT * FROM developer_webhook_subscriptions WHERE id=$1', [sub_id]);
  if (!sub || sub.status !== 'active') return;
  const app = await one("SELECT * FROM developer_apps WHERE id=$1 AND status='active'", [app_id]);
  if (!app) return;

  const bad = checkTarget(sub.url);
  if (bad) throw Object.assign(new Error(bad), { permanent: true });

  const payload = { id: randomUUID(), type, data, created_at: new Date().toISOString() };
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const secret = decrypt(sub.secret_enc, DEV_HOOK_CTX);
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  try {
    const r = await send('POST', sub.url, {
      headers: {
        'content-type': 'application/json',
        'x-sportarena-timestamp': String(ts),
        'x-sportarena-signature': `sha256=${sig}`,
        'x-sportarena-event': type,
        'x-sportarena-app-id': app_id,
      },
      body,
    });
    if (r.status < 200 || r.status > 299) throw new Error(`Receiver answered ${r.status}`);

    await query(
      "UPDATE developer_webhook_subscriptions SET last_success_at=now(), failure_count=0, last_error=NULL, updated_at=now() WHERE id=$1",
      [sub_id],
    );
    await bumpUsage(app_id, 'webhook_fires');
  } catch (e) {
    const msg = String(e.message ?? e).slice(0, 300);
    const newCount = (sub.failure_count ?? 0) + 1;
    if (newCount >= 10) {
      await query(
        "UPDATE developer_webhook_subscriptions SET status='paused', failure_count=$2, last_error=$3, updated_at=now() WHERE id=$1",
        [sub_id, newCount, msg],
      );
    } else {
      await query(
        'UPDATE developer_webhook_subscriptions SET failure_count=$2, last_error=$3, updated_at=now() WHERE id=$1',
        [sub_id, newCount, msg],
      );
    }
    await bumpUsage(app_id, 'webhook_failures');
    logger.warn('developer webhook delivery failed', { sub_id, app_id, type, error: msg });
    throw e;
  }
}

/** Worker sweep: drain queued developer webhook deliveries. */
export async function developerWebhookSweep() {
  return runJobs('developer', { deliver_developer_webhook: deliverDeveloperWebhook });
}

/** Generate a new webhook signing secret (plaintext returned once only). */
export function newWebhookSecret() {
  return newOpaqueToken().replace('sa_', 'whs_');
}
