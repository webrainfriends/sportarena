// Media rights background work (#482). Rights are always read live (a licence past its end already reads as expired and a feed past its end already refuses),
// so nothing waits for this sweep: it makes the stored stage match what everyone is shown, stops the credentials of ended rights, writes the history, and sends
// the expiry reminders. Every step is idempotent (row-locked, guarded by the expected stage, deduplicated notifications).
import { tx, many } from './db.js';
import { notify } from './notify.js';
import { sendMediaFollowerAlerts } from './media-fans.js';
import { logMr, partnerAdmins, eventOrganisers, eventOf } from './media-rights.js';

const REMIND_DAYS = [30, 7];

/** Licences that ran out become expired, their feeds end and their credentials are revoked. Returns how many licences changed. */
export async function expireMediaRights() {
  let n = 0;
  for (const l of await many("SELECT id FROM mr_licences WHERE stage IN ('active','suspended') AND effective_to <= now() ORDER BY effective_to, id LIMIT 200")) {
    n += await tx(async (c) => {
      const r = (await c.query("UPDATE mr_licences SET stage='expired', ended_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 AND stage IN ('active','suspended') AND effective_to <= now() RETURNING *", [l.id])).rows[0];
      if (!r) return 0;
      const g = (await c.query("UPDATE mr_feed_grants SET status='revoked', revoked_at=now(), revoke_reason='Licence expired' WHERE licence_id=$1 AND status='active' RETURNING api_token_id", [r.id])).rows;
      if (g.length) await c.query('UPDATE api_tokens SET revoked_at=now() WHERE id = ANY($1) AND revoked_at IS NULL', [g.map((x) => x.api_token_id).filter(Boolean)]);
      const ev = await eventOf((await c.query('SELECT event_id FROM mr_packages WHERE id=$1', [r.package_id])).rows[0].event_id, c);
      await logMr(c, ev.id, 'licence', r.id, 'expired', { detail: { reason: 'End date reached' } });
      for (const uid of new Set([...(await partnerAdmins(c, r.partner_id)), ...(await eventOrganisers(c, ev))])) await notify(c, uid, { kind: 'media_licence_expired', title: 'Media rights expired', body: `${r.licence_no} for ${ev.name} has ended. Renew it to keep the rights.`, data: { licence_id: r.id }, dedupe_key: `mr-expired:${r.id}:${uid}` });
      return 1;
    });
  }
  for (const g of await many("SELECT id FROM mr_feed_grants WHERE status='active' AND valid_to <= now() ORDER BY valid_to, id LIMIT 200")) {
    n += await tx(async (c) => {
      const r = (await c.query("UPDATE mr_feed_grants SET status='revoked', revoked_at=now(), revoke_reason='Feed period ended' WHERE id=$1 AND status='active' AND valid_to <= now() RETURNING *", [g.id])).rows[0];
      if (!r) return 0;
      if (r.api_token_id) await c.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [r.api_token_id]);
      return 1;
    });
  }
  return n;
}

/** 30 and 7 days before a licence ends, tell both sides once. Returns how many reminders were queued. */
export async function sendMediaRightsReminders() {
  let n = 0;
  for (const days of REMIND_DAYS) {
    for (const l of await many(
      `SELECT l.id, l.licence_no, l.partner_id, l.effective_to, p.event_id FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id
        WHERE l.stage='active' AND l.effective_to > now() AND l.effective_to <= now() + make_interval(days => $1) ORDER BY l.effective_to LIMIT 500`, [days])) {
      n += await tx(async (c) => {
        const ev = await eventOf(l.event_id, c);
        for (const uid of new Set([...(await partnerAdmins(c, l.partner_id)), ...(await eventOrganisers(c, ev))])) {
          await notify(c, uid, { kind: 'media_licence_expiring', title: `Media rights end within ${days} days`, body: `${l.licence_no} for ${ev.name} ends on ${new Date(l.effective_to).toISOString().slice(0, 10)}. Start a renewal if you want to continue.`, data: { licence_id: l.id }, dedupe_key: `mr-remind:${l.id}:${days}:${uid}` });
        }
        return 1;
      });
    }
  }
  return n;
}

export const runMediaRightsSweeps = async () => ({ changed: await expireMediaRights(), reminders: await sendMediaRightsReminders(), fan_alerts: await sendMediaFollowerAlerts() });
