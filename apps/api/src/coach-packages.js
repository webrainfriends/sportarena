// Redeemable coach session packages (issue #655). A package is a prepaid balance of N one-to-one sessions bought from a coach rate card
// (unit 'package'), paid through canonical payments (purpose 'coach_package') and spent when a hire is booked "using the package".
// The balance is never a stored counter: sessions used = redemptions whose hire is still live (not cancelled / expired), so a cancelled or
// expired hire returns its session by itself and a completed one keeps it. Concurrent bookings are serialised by the purchase row lock.
// Nothing here deletes data: expiring and refunding only change status.
import { many, tx } from './db.js';
import { notify } from './notify.js';
import { logger } from './logger.js';
import { tellPayers } from './coach-subscriptions.js';

export const EXPIRY_NOTICE_DAYS = 7;   // "expires soon" goes out this many days before the end

/** Sessions currently spent (a hire that is cancelled or expired no longer counts). Alias the purchase table as `p`. */
export const LIVE_USED = "(SELECT count(*)::int FROM coach_package_redemptions r JOIN coach_hires h ON h.id=r.hire_id WHERE r.purchase_id=p.id AND h.status NOT IN ('cancelled','expired'))";

export const isLive = (p) => p.status === 'active' && !(p.expires_at && new Date(p.expires_at) <= new Date());
export const leftOf = (p) => (isLive(p) ? Math.max(0, p.sessions_total - p.used) : 0);

/** Payment confirmed: the package starts and its validity runs from now. Idempotent: only a package awaiting payment activates. */
export async function activateCoachPackage(c, id) {
  const p = (await c.query(
    `UPDATE coach_package_purchases SET status='active', activated_at=now(), expires_at=CASE WHEN valid_days IS NULL THEN NULL ELSE now() + make_interval(days => valid_days) END
      WHERE id=$1 AND status='awaiting_payment' RETURNING *`, [id])).rows[0];
  if (!p) return false;
  const who = (await c.query('SELECT display_name FROM users WHERE id=$1', [p.athlete_id])).rows[0]?.display_name ?? 'An athlete';
  const coach = (await c.query('SELECT display_name FROM users WHERE id=$1', [p.coach_id])).rows[0]?.display_name ?? 'your coach';
  for (const u of await tellPayers(c, p)) {
    await notify(c, u, { kind: 'coach_package_active', title: `${p.title} is ready ✓`, body: `${p.sessions_total} session${p.sessions_total === 1 ? '' : 's'} with ${coach}. Book one and choose “use my package”.`, data: { package_id: p.id }, dedupe_key: `coach_package_active:${p.id}:${u}` });
  }
  await notify(c, p.coach_id, { kind: 'coach_package_sold', title: `${who} bought ${p.title}`, body: `${p.sessions_total} prepaid session${p.sessions_total === 1 ? '' : 's'}.`, data: { package_id: p.id, for_coach: true }, dedupe_key: `coach_package_sold:${p.id}` });
  return true;
}

/**
 * Spend one session on a hire. The caller is inside the booking transaction (it holds the coach calendar lock); this row-locks the package so
 * parallel bookings can never overspend. Returns { ok } or { error } (notFound | inactive | expired | late | sport | empty).
 */
export async function redeemCoachPackage(c, { packageId, hirerId, coachId, athleteId, sportId, startsAt, hireId }) {
  const p = (await c.query(`SELECT p.*, ${LIVE_USED} AS used FROM coach_package_purchases p WHERE p.id=$1 FOR UPDATE`, [packageId])).rows[0];
  if (!p || p.coach_id !== coachId || p.athlete_id !== athleteId || ![p.payer_id, p.athlete_id].includes(hirerId)) return { error: 'notFound' };
  if (p.status === 'expired') return { error: 'expired' };
  if (p.status !== 'active') return { error: 'inactive' };
  if (p.expires_at && new Date(p.expires_at) <= new Date()) return { error: 'expired' };
  if (p.expires_at && new Date(startsAt) > new Date(p.expires_at)) return { error: 'late', expires_at: p.expires_at };   // the session itself must fall inside the validity
  if (p.sport_id && p.sport_id !== sportId) return { error: 'sport' };
  if (p.used >= p.sessions_total) return { error: 'empty' };
  await c.query('INSERT INTO coach_package_redemptions(hire_id, purchase_id) VALUES ($1,$2)', [hireId, p.id]);
  return { ok: true, sessions_left: p.sessions_total - p.used - 1, purchase_id: p.id };
}

/** One pass over live packages: say "expires soon" once, then close the ones whose time is up. Safe to repeat. */
export async function syncCoachPackages() {
  let changed = 0;
  const fail = (what, id, e) => logger.error(`coach package ${what} failed`, { id, error: String(e.message).slice(0, 200) });
  const live = (await many(`SELECT p.id FROM coach_package_purchases p WHERE p.status='active' AND p.expires_at IS NOT NULL AND p.expires_at <= now() + make_interval(days => ${EXPIRY_NOTICE_DAYS}) ORDER BY p.expires_at LIMIT 500`));
  for (const r of live) {
    try {
      await tx(async (c) => {
        const p = (await c.query(`SELECT p.*, ${LIVE_USED} AS used FROM coach_package_purchases p WHERE p.id=$1 AND p.status='active' FOR UPDATE`, [r.id])).rows[0];
        if (!p) return;
        const left = Math.max(0, p.sessions_total - p.used);
        if (new Date(p.expires_at) <= new Date()) {
          await c.query("UPDATE coach_package_purchases SET status='expired' WHERE id=$1 AND status='active'", [p.id]);
          if (left > 0) for (const u of await tellPayers(c, p)) await notify(c, u, { kind: 'coach_package_expired', title: `${p.title} has expired`, body: `${left} unused session${left === 1 ? '' : 's'} could not be used in time. Ask your coach if they can help.`, data: { package_id: p.id }, dedupe_key: `coach_package_expired:${p.id}:${u}` });
          changed++;
        } else if (!p.expiry_notified_at && left > 0) {
          await c.query('UPDATE coach_package_purchases SET expiry_notified_at=now() WHERE id=$1', [p.id]);
          const day = new Date(p.expires_at).toISOString().slice(0, 10);
          for (const u of await tellPayers(c, p)) await notify(c, u, { kind: 'coach_package_expiring', title: `${p.title} expires on ${day}`, body: `${left} session${left === 1 ? ' is' : 's are'} still unused. Book ${left === 1 ? 'it' : 'them'} before then.`, data: { package_id: p.id }, dedupe_key: `coach_package_expiring:${p.id}:${u}` });
          changed++;
        }
      });
    } catch (e) { fail('sweep', r.id, e); }
  }
  return changed;
}
