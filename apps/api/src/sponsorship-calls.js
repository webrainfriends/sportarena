// Deadline arithmetic and background notices for sponsorship calls (#285). Kept apart from the capabilities so the worker can use it.
import { many, one, tx } from './db.js';
import { notify } from './notify.js';
import { sponsorRecipients } from './sponsor-access.js';

/** The instants a round opens and closes. Rounds made before #285 have none stored and keep their old UTC day window. */
export const OPENS_AT = (a) => `coalesce(${a}.opens_at, ${a}.opens_on::timestamp AT TIME ZONE 'UTC')`;
export const CLOSES_AT = (a) => `coalesce(${a}.closes_at, (${a}.closes_on + 1)::timestamp AT TIME ZONE 'UTC')`;
/** The state of a round right now, derived from its deadline instants unless it was closed explicitly. clock_timestamp(), not now(): a request that waited on a lock must not use the time its transaction began. */
export const roundState = (a = 'r') => `(CASE WHEN ${a}.status='closed' OR clock_timestamp() >= ${CLOSES_AT(a)} THEN 'closed' WHEN clock_timestamp() < ${OPENS_AT(a)} THEN 'scheduled' ELSE 'open' END)`;

const when = (instant, timezone) => {
  try { return `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(instant))} (${timezone})`; } catch { return new Date(instant).toISOString(); }
};

/**
 * Worker step. (1) Invitees who have not applied or declined hear about a deadline in the next 24 hours; (2) the brand's staff hear
 * when a round's deadline has passed and how many applications wait for a decision. Both are idempotent through dedupe keys.
 * Returns the number of notifications stored.
 */
export async function sendCallNotices() {
  let sent = 0;
  const closing = await many(
    `SELECT r.id AS round_id, r.timezone, ${CLOSES_AT('r')} AS closes_at, p.id AS program_id, p.name AS program_name, i.id AS invitation_id, i.invitee_user_id
       FROM sponsorship_rounds r JOIN sponsorship_programs p ON p.id=r.program_id
       JOIN sponsorship_invitations i ON i.program_id=p.id AND i.status IN ('invited','viewed')
      WHERE p.status='published' AND ${roundState('r')}='open' AND ${CLOSES_AT('r')} <= now() + interval '24 hours'
      ORDER BY r.id, i.id LIMIT 500`);
  for (const x of closing) {
    await tx(async (c) => {
      const n = await notify(c, x.invitee_user_id, { kind: 'sponsorship_call', title: 'A sponsorship call you were invited to is closing', body: `${x.program_name} closes ${when(x.closes_at, x.timezone)}. Apply before then.`, data: { program_id: x.program_id, round_id: x.round_id, invitation_id: x.invitation_id }, dedupe_key: `call-closing:${x.round_id}:${x.invitation_id}` });
      if (n) sent++;
    });
  }
  const closed = await many(
    `SELECT r.id AS round_id, r.name AS round_name, p.id AS program_id, p.name AS program_name, p.sponsor_id,
            (SELECT count(*)::int FROM sponsorship_applications a WHERE a.round_id=r.id AND a.status='submitted') AS pending
       FROM sponsorship_rounds r JOIN sponsorship_programs p ON p.id=r.program_id
      WHERE p.status IN ('published','closed') AND ${CLOSES_AT('r')} <= now() AND ${CLOSES_AT('r')} > now() - interval '3 days'
      ORDER BY r.id LIMIT 500`);
  for (const x of closed) {
    const sp = await one('SELECT * FROM sponsors WHERE id=$1', [x.sponsor_id]);
    if (!sp) continue;
    await tx(async (c) => {
      const recipients = await sponsorRecipients(c, sp, 'program');
      for (const uid of recipients) {
        const n = await notify(c, uid, { kind: 'sponsorship_call', title: 'A sponsorship call has closed', body: `${x.program_name} · ${x.round_name} is closed with ${x.pending} application${x.pending === 1 ? '' : 's'} waiting for a decision.`, data: { program_id: x.program_id, round_id: x.round_id }, dedupe_key: `call-closed:${x.round_id}` });
        if (n) sent++;
      }
    });
  }
  return sent;
}
