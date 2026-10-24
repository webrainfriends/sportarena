// Guardian-authorized youth sponsorship (issue #307). The guardian link and purpose consents stay canonical in youth.js; this adds the
// sponsor-specific authority on top. Nothing here infers consent: a sponsorship never implies image (media) or contact permission.
import { query } from './db.js';
import { conflict, forbidden } from './errors.js';
import { notify } from './notify.js';
import { YOUTH_SQL, guardianLink, guardiansOf, isYouth, requireConsent } from './youth.js';

const LIVE_LINK = `l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())`;

/** Is this deal with a young athlete? */
export const isYouthDeal = async (c, d) => d.target_type === 'athlete' && isYouth(d.target_id, c);

/** The live authority a verified guardian gave this sponsor for this child: the row is active AND the authorising guardian is still verified AND the child is still youth. */
export async function liveAuthority(c, sponsorId, childId) {
  return (await (c ?? { query }).query(
    `SELECT a.* FROM sponsorship_guardian_authorities a JOIN users u ON u.id=a.child_id
       JOIN guardian_links l ON l.guardian_id=a.authorized_by AND l.child_id=a.child_id AND ${LIVE_LINK}
      WHERE a.sponsor_id=$1 AND a.child_id=$2 AND a.status='active' AND ${YOUTH_SQL}`, [sponsorId, childId])).rows[0] ?? null;
}

/** Sponsor-side actions on a youth agreement stop the moment the authority is withdrawn or the guardian is no longer verified. Payments and history are not affected. */
export async function assertYouthAuthority(c, ctx) {
  if (ctx.role !== 'sponsor' || !(await isYouthDeal(c, ctx.d))) return;
  if (!(await liveAuthority(c, ctx.d.sponsor_id, ctx.d.target_id))) throw forbidden('The guardian\'s authority for this sponsorship is not in force, so this action is not available');
}

/** Sponsor messages, reviews and objectives about a young person also need the guardian\'s contact permission, which is separate from the agreement. */
export async function assertYouthContact(c, ctx) {
  if (ctx.role !== 'sponsor' || !(await isYouthDeal(c, ctx.d))) return;
  await assertYouthAuthority(c, ctx);
  await requireConsent(ctx.d.target_id, 'contact', 'sponsor messages', c);
}

/** Notifications for a young person's sponsorship go to their verified guardians, never to the young person; everyone else is notified directly. */
export async function notifyRecipient(c, userId, msg) {
  if (typeof userId === 'string' && await isYouth(userId, c)) {
    const guardians = await guardiansOf(userId, c);
    if (guardians.length) { for (const g of guardians) await notify(c, g, msg); return; }
  }
  return notify(c, userId, msg);
}

export const youthConflict = () => conflict('This athlete is not open to sponsorship offers');

/** SQL: agreements aimed at a young athlete whose verified guardian is `$1`. `a` carries target_type/target_id. Adds the guardian to the recipient side of every list. */
export const guardedAthleteSql = (a, p = '$1') => `(${a}.target_type='athlete' AND ${a}.target_id IN (SELECT l.child_id FROM guardian_links l WHERE l.guardian_id=${p} AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())))`;

/** Who receives a young athlete's money: the frozen/selected guardian payee if still a verified guardian, else null (nobody may be paid until a guardian is set). */
export async function livePayee(c, d) {
  if (!d.payee_guardian_id) return null;
  return (await guardianLink(d.payee_guardian_id, d.target_id, c)) ? d.payee_guardian_id : null;
}
