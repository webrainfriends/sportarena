// Sending queued WhatsApp Business / SMS template deliveries, falling back to the template's other channel, and applying provider
// delivery receipts. Same queue discipline as email / push / OpenWA: claim with FOR UPDATE SKIP LOCKED plus a lease, exponential backoff,
// dead-letter after the last attempt. A provider outage only ever delays or fails a delivery row; it never touches the business transaction.
import { config } from './config.js';
import { blindIndex, decrypt } from './crypto.js';
import { one, query, tx } from './db.js';
import { audit } from './helpers.js';
import { logger } from './logger.js';
import { failDelivery } from './notify.js';
import { CommError, STOP_WORDS, adapterFor, scrub } from './comms-providers.js';
import { USE_CASES, renderBody } from './comms-catalogue.js';
import { CONTACT_TABLE, VARS_CTX, activeProvider, eligible, insertDelivery, optOut, prepareChannel, providerConfig, suppressNumber } from './comms.js';

const MAX_ATTEMPTS = 5;
const RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };

/** The delivery could not be completed on its channel: try the template's fallback channel once (unique per notification+channel, so never twice). */
export async function triggerFallback(d) {
  const tpl = d.template_id ? await one('SELECT fallback_channel FROM comm_templates WHERE id=$1', [d.template_id]) : null;
  const channel = tpl?.fallback_channel;
  if (!channel || channel === d.channel || !(channel in CONTACT_TABLE)) return null; // 'email' / none: the email + in-app copy is always independent
  const n = await one('SELECT id, user_id, kind, data FROM notifications WHERE id=$1', [d.notification_id]);
  if (!n || !USE_CASES[d.use_case]) return null;
  const p = await prepareChannel(null, { userId: n.user_id, notification: n, useCase: d.use_case, essential: d.essential, channel, orgId: d.organisation_id });
  if (p.ok) return insertDelivery(null, { notificationId: n.id, channel, useCase: d.use_case, essential: d.essential, orgId: d.organisation_id, prepared: p, fallbackOf: d.id });
  if (p.record) return insertDelivery(null, { notificationId: n.id, channel, useCase: d.use_case, essential: d.essential, orgId: d.organisation_id, prepared: { provider: p.record.provider }, status: 'suppressed', reason: p.record.reason, fallbackOf: d.id });
  return null;
}

const finish = (id, status, error, code = null) =>
  query('UPDATE notification_deliveries SET status=$2, last_error=$3, error_code=$4, claimed_at=NULL, next_attempt_at=NULL WHERE id=$1', [id, status, error, code]);

/** Send every due templated delivery. Safe from several instances; each row is claimed first. */
export async function dispatchComms({ limit = config.comms.perCycle } = {}) {
  const pending = Number((await one("SELECT count(*) AS n FROM notification_deliveries WHERE status='pending' AND provider IS NOT NULL")).n);
  const { rows } = await query(
    `WITH due AS (
       SELECT id FROM notification_deliveries WHERE status='pending' AND provider IS NOT NULL AND channel IN ('whatsapp','sms')
          AND (next_attempt_at IS NULL OR next_attempt_at <= now()) AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED),
     claimed AS (UPDATE notification_deliveries d SET attempts=d.attempts+1, claimed_at=now() FROM due WHERE d.id=due.id RETURNING d.*)
     SELECT c.*, n.user_id FROM claimed c JOIN notifications n ON n.id=c.notification_id ORDER BY c.created_at`, [limit]);
  const out = { configured: true, pending, sent: 0, failed: 0, suppressed: 0 };
  for (const d of rows) {
    try {
      // the batch is sent one by one: refresh this row's lease first, so a second worker never re-claims it while we are still working through the batch
      const mine = await one("UPDATE notification_deliveries SET claimed_at=now() WHERE id=$1 AND status='pending' RETURNING id", [d.id]);
      if (!mine) continue; // withdrawn (opt-out) or finished elsewhere
      const provider = await activeProvider(null, d.channel, d.organisation_id);
      const adapter = provider && adapterFor(provider.kind);
      if (!adapter) throw new CommError('no active provider account', { code: 'no_provider' });
      const tpl = await one('SELECT * FROM comm_templates WHERE id=$1', [d.template_id]);
      const contact = await one(`SELECT phone_enc FROM ${CONTACT_TABLE[d.channel]} WHERE user_id=$1`, [d.user_id]);
      const vars = JSON.parse(decrypt(d.vars_enc, VARS_CTX));
      await audit(null, null, 'dispatch_comm', 'notifications', d.notification_id);
      // consent is checked as late as possible (right before the provider call): STOP, removal and suppression always win over a queued message
      const who = await eligible(null, d.user_id, d.channel, { essential: d.essential, category: USE_CASES[d.use_case]?.category });
      if (!who.ok) { await finish(d.id, 'suppressed', who.reason); out.suppressed++; continue; }
      const { ref } = await adapter.send({ cfg: providerConfig(provider), to: decrypt(contact.phone_enc, `${CONTACT_TABLE[d.channel]}.phone`), template: tpl, formatted: vars, text: renderBody(tpl.body, vars), reference: d.id });
      // the message has left: whatever happens to this bookkeeping, it must never be sent again
      try { await query("UPDATE notification_deliveries SET status='sent', provider_ref=$2, provider_account_id=$3, sent_at=now(), last_error=NULL, error_code=NULL, claimed_at=NULL WHERE id=$1", [d.id, ref, provider.id]); }
      catch (e) {
        logger.error('could not record the provider reference of a sent message', { error: String(e.message).slice(0, 200) });
        await query("UPDATE notification_deliveries SET status='sent', provider_account_id=$2, sent_at=now(), last_error='sent; provider reference not recorded', claimed_at=NULL WHERE id=$1", [d.id, provider.id]);
      }
      out.sent++;
    } catch (e) {
      out.failed++;
      logger.warn('communication delivery failed', { channel: d.channel, permanent: !!e.permanent, error: scrub(e.message).slice(0, 200) });
      await onSendFailure(d, e);
    }
  }
  out.pending = pending - out.sent - out.suppressed;
  return out;
}

async function onSendFailure(d, e) {
  const permanent = !!e.permanent;
  if (permanent) await finish(d.id, 'failed', String(e.message).slice(0, 300), e.code ?? null);
  else await failDelivery(d.channel, d, e, MAX_ATTEMPTS); // backs off, dead-letters after the last attempt
  if (e.suppress) await applySuppression(d.user_id, d.channel, e.suppress, 'provider');
  if (permanent || d.attempts >= MAX_ATTEMPTS) await triggerFallback(d);
}

/** A provider told us this number cannot or must not be messaged: stop trying, keep the evidence, honour STOP as an opt-out. */
async function applySuppression(userId, channel, kind, source) {
  if (kind === 'stop') return optOut(null, userId, channel, { source: 'provider_suppression', suppress: 'stop', note: source });
  const c = await one(`SELECT phone_idx FROM ${CONTACT_TABLE[channel]} WHERE user_id=$1`, [userId]);
  if (c) await suppressNumber(null, c.phone_idx, channel, kind === 'invalid_number' ? 'invalid_number' : 'provider_blocked', source);
}

// ---------------------------------------------------------------- provider webhooks
/**
 * Apply a verified batch of provider events. Each event is recorded in provider_events (primary key = replay guard) in the same transaction
 * that applies it, so a replay is a no-op and a crash leaves the event unapplied for the provider to retry. Receipts never move a delivery
 * backwards (a late "sent" after "read" is ignored) and never claim more than the provider said.
 */
export async function applyProviderEvents(provider, events) {
  const out = { applied: 0, duplicate: 0, unmatched: 0, optouts: 0 };
  for (const e of events) {
    await tx(async (c) => {
      const seen = await c.query('INSERT INTO provider_events(provider, event_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1', [`comms:${provider.id}`, e.id, e.type]);
      if (!seen.rowCount) { out.duplicate++; return; }
      if (e.type === 'inbound') { if (await handleInbound(c, provider, e)) out.optouts++; out.applied++; return; }
      if (!e.state) return;
      const d = (await c.query('SELECT * FROM notification_deliveries WHERE provider=$1 AND provider_account_id=$2 AND provider_ref=$3 FOR UPDATE', [provider.kind, provider.id, e.ref])).rows[0];
      if (!d) { out.unmatched++; await c.query('DELETE FROM provider_events WHERE provider=$1 AND event_id=$2', [`comms:${provider.id}`, e.id]); return; } // not ours yet: let the provider retry
      await applyStatus(c, d, e);
      out.applied++;
    });
  }
  return out;
}

async function applyStatus(c, d, e) {
  if (e.state === 'failed') {
    if (!['pending', 'sent'].includes(d.status)) return; // a delivered / read message cannot later "fail"
    await c.query("UPDATE notification_deliveries SET status='failed', error_code=$2, last_error='provider reported a failure', claimed_at=NULL WHERE id=$1", [d.id, e.code]);
    if (e.suppress) { const u = (await c.query('SELECT user_id FROM notifications WHERE id=$1', [d.notification_id])).rows[0]; if (u) await applySuppressionTx(c, u.user_id, d.channel, e.suppress); }
    await triggerFallbackTx(c, d);
    return;
  }
  if (RANK[e.state] <= RANK[d.status]) return;
  await c.query(
    `UPDATE notification_deliveries SET status=$2, sent_at=coalesce(sent_at, now()), delivered_at=CASE WHEN $2 IN ('delivered','read') THEN coalesce(delivered_at, now()) ELSE delivered_at END,
            read_at=CASE WHEN $2='read' THEN now() ELSE read_at END WHERE id=$1`, [d.id, e.state]);
}

// the webhook already holds a transaction; these run the same logic inside it
const applySuppressionTx = async (c, userId, channel, kind) => {
  if (kind === 'stop') return optOut(c, userId, channel, { source: 'provider_suppression', suppress: 'stop', note: 'provider' });
  const r = (await c.query(`SELECT phone_idx FROM ${CONTACT_TABLE[channel]} WHERE user_id=$1`, [userId])).rows[0];
  if (r) await suppressNumber(c, r.phone_idx, channel, kind === 'invalid_number' ? 'invalid_number' : 'provider_blocked', 'provider');
};
async function triggerFallbackTx(c, d) {
  const tpl = d.template_id ? (await c.query('SELECT fallback_channel FROM comm_templates WHERE id=$1', [d.template_id])).rows[0] : null;
  const channel = tpl?.fallback_channel;
  if (!channel || channel === d.channel || !(channel in CONTACT_TABLE)) return;
  const n = (await c.query('SELECT id, user_id, kind, data FROM notifications WHERE id=$1', [d.notification_id])).rows[0];
  if (!n || !USE_CASES[d.use_case]) return;
  const p = await prepareChannel(c, { userId: n.user_id, notification: n, useCase: d.use_case, essential: d.essential, channel, orgId: d.organisation_id });
  if (p.ok) await insertDelivery(c, { notificationId: n.id, channel, useCase: d.use_case, essential: d.essential, orgId: d.organisation_id, prepared: p, fallbackOf: d.id });
  else if (p.record) await insertDelivery(c, { notificationId: n.id, channel, useCase: d.use_case, essential: d.essential, orgId: d.organisation_id, prepared: { provider: p.record.provider }, status: 'suppressed', reason: p.record.reason, fallbackOf: d.id });
}

/** A reply from a recipient. STOP (and its common spellings) is an immediate opt-out on that channel and a number-level suppression. */
async function handleInbound(c, provider, e) {
  if (!STOP_WORDS.test(e.text)) return false;
  const digits = e.from.replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) return false;
  const channel = provider.channel, idx = blindIndex(digits);
  const contacts = (await c.query(`SELECT user_id FROM ${CONTACT_TABLE[channel]} WHERE phone_idx=$1 AND opted_out_at IS NULL`, [idx])).rows;
  for (const u of contacts) await optOut(c, u.user_id, channel, { source: 'inbound_stop', suppress: 'stop' });
  await suppressNumber(c, idx, channel, 'stop', 'inbound_stop'); // also when nobody is registered on it yet: a later sign-up cannot silently re-enable it
  return true;
}
