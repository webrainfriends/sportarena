// Developer Platform (#569): sandbox mode — synthetic event firing, isolated test delivery log.
// sk_test_ tokens operate in sandbox mode. No real financial, medical, or personal data is served.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden } from '../errors.js';
import { audit } from '../helpers.js';
import { PLATFORM_EVENT_TYPES, emitPlatformEvent } from '../integrations/developer-webhooks.js';
import { randomUUID } from 'node:crypto';

const TAG = 'Developer';

async function sandboxAppFor(user, appId) {
  const app = await one("SELECT * FROM developer_apps WHERE id=$1 AND status='active'", [appId]);
  if (!app) throw new (await import('../errors.js')).notFound('Developer app')();
  if (app.owner_user_id !== user.id) throw new (await import('../errors.js')).notFound('Developer app')();
  if (!app.sandbox_mode) throw forbidden('This app is not in sandbox mode. Enable sandbox_mode to use sandbox features.');
  return app;
}

cap({
  name: 'get_sandbox_info',
  method: 'GET',
  path: '/developer/apps/:app_id/sandbox',
  tag: TAG,
  summary: 'Sandbox status for a developer app: sandbox mode flag, test token prefix, rate limits, and what synthetic event types are available.',
  input: z.object({ app_id: id }),
  async handler({ user }, i) {
    const app = await one("SELECT id, name, sandbox_mode, status FROM developer_apps WHERE id=$1 AND owner_user_id=$2", [i.app_id, user.id]);
    if (!app) throw (await import('../errors.js')).notFound('Developer app');
    const delivery_count = await one(
      "SELECT count(*) AS n FROM jobs WHERE kind='deliver_developer_webhook' AND payload->>'app_id'=$1 AND created_at >= CURRENT_DATE",
      [i.app_id],
    );
    return {
      app_id: app.id,
      app_name: app.name,
      sandbox_mode: app.sandbox_mode,
      token_prefix: app.sandbox_mode ? 'sk_test_' : 'sk_live_',
      rate_limit_per_minute: app.sandbox_mode ? 1000 : 100,
      sandbox_description: 'Sandbox tokens (sk_test_*) are isolated from production data. Fire synthetic events to test webhook delivery end-to-end.',
      available_event_types: PLATFORM_EVENT_TYPES,
      test_deliveries_today: Number(delivery_count?.n ?? 0),
    };
  },
});

cap({
  name: 'fire_sandbox_event',
  method: 'POST',
  path: '/developer/apps/:app_id/sandbox/events',
  tag: TAG,
  summary: 'Fire a synthetic platform event into the sandbox delivery pipeline. Triggers matching webhook subscriptions with test payload data.',
  input: z.object({
    app_id: id,
    event_type: z.enum(PLATFORM_EVENT_TYPES),
    payload_override: z.record(z.unknown()).optional(),
  }),
  async handler({ user }, i) {
    await sandboxAppFor(user, i.app_id);
    const syntheticEntityId = `sandbox-${randomUUID()}`;
    const basePayload = buildSyntheticPayload(i.event_type, i.app_id);
    const data = { ...basePayload, ...( i.payload_override ?? {}), sandbox: true, fired_by: user.id };
    await emitPlatformEvent(i.event_type, data, syntheticEntityId);
    await audit(null, user.id, 'fire_sandbox_event', 'developer_apps', i.app_id, { event_type: i.event_type });
    return { queued: true, event_type: i.event_type, entity_id: syntheticEntityId };
  },
});

cap({
  name: 'list_sandbox_deliveries',
  method: 'GET',
  path: '/developer/apps/:app_id/sandbox/deliveries',
  tag: TAG,
  summary: 'Sandbox webhook delivery log: last N test deliveries with status, timing and response detail.',
  input: z.object({ app_id: id, ...page }),
  async handler({ user }, i) {
    const app = await one("SELECT id FROM developer_apps WHERE id=$1 AND owner_user_id=$2", [i.app_id, user.id]);
    if (!app) throw (await import('../errors.js')).notFound('Developer app');
    const rows = await many(
      `SELECT j.id, j.status, j.attempts, j.run_at, j.finished_at, j.last_error,
              j.payload->>'type' AS event_type, j.payload->'data'->>'sandbox' AS is_sandbox,
              j.created_at
         FROM jobs j
        WHERE j.kind='deliver_developer_webhook'
          AND j.payload->>'app_id' = $1
          AND j.payload->'data'->>'sandbox' = 'true'
        ORDER BY j.created_at DESC LIMIT $2 OFFSET $3`,
      [i.app_id, i.limit, i.offset],
    );
    return { items: rows };
  },
});

function buildSyntheticPayload(eventType, appId) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const payloads = {
    'registration.created': { registration_id: id, event_id: `sandbox-event-${appId}`, participant_count: 1, category: 'Open', registered_at: now },
    'registration.cancelled': { registration_id: id, event_id: `sandbox-event-${appId}`, cancelled_at: now, reason: 'test' },
    'registration.approved': { registration_id: id, event_id: `sandbox-event-${appId}`, approved_at: now },
    'fixture.published': { fixture_id: id, competition_id: `sandbox-comp-${appId}`, round: 1, scheduled_at: now, home_team: 'Team A', away_team: 'Team B' },
    'fixture.result_final': { fixture_id: id, competition_id: `sandbox-comp-${appId}`, home_score: 2, away_score: 1, result_status: 'confirmed', finalised_at: now },
    'fixture.result_amended': { fixture_id: id, competition_id: `sandbox-comp-${appId}`, amended_at: now, reason: 'score_correction' },
    'event.published': { event_id: id, name: 'Sandbox Tournament 2026', sport: 'tennis', published_at: now },
    'event.cancelled': { event_id: id, name: 'Sandbox Tournament 2026', cancelled_at: now, reason: 'test' },
    'event.rescheduled': { event_id: id, new_starts_at: now, rescheduled_at: now },
    'payment.completed': { payment_id: id, amount: 50.00, currency: 'GBP', completed_at: now },
    'payment.refunded': { payment_id: id, amount: 50.00, currency: 'GBP', refunded_at: now },
    'ticket.scanned': { ticket_id: id, event_id: `sandbox-event-${appId}`, scanned_at: now, gate: 'Main Entrance' },
    'ticket.sold': { ticket_id: id, event_id: `sandbox-event-${appId}`, ticket_type: 'General Admission', sold_at: now, amount: 25.00, currency: 'GBP' },
    'supplier.award_confirmed': { award_id: id, supplier_name: 'Sandbox Supplier Ltd', contract_value: 10000, currency: 'GBP', awarded_at: now },
    'supplier.contract_signed': { contract_id: id, supplier_name: 'Sandbox Supplier Ltd', signed_at: now },
    'organisation.member_joined': { organisation_id: `sandbox-org-${appId}`, member_name: 'Sandbox Athlete', role: 'player', joined_at: now },
    'organisation.member_left': { organisation_id: `sandbox-org-${appId}`, member_name: 'Sandbox Athlete', role: 'player', left_at: now },
  };
  return payloads[eventType] ?? { event_id: id, occurred_at: now };
}
