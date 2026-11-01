// Coach classes keep themselves honest (issue #656). Run by the maintenance worker; every step is safe to repeat (updates are conditional,
// notifications carry dedupe keys, refunds are keyed per seat). Each class or seat is handled in its own transaction so one failure never blocks the rest.
import { many, tx } from './db.js';
import { logger } from './logger.js';
import { notify } from './notify.js';
import { cancelClass, lockClass, notifySeat, promoteWaitlist } from './coach-classes.js';

export async function syncCoachClasses() {
  let changed = 0;
  const fail = (what, ids, e) => logger.error(`coach class ${what} failed`, { ...ids, error: String(e.message).slice(0, 200) });

  // 1. an unpaid held seat whose payment window ended is released and offered to the next person in order
  for (const r of await many("SELECT z.id, z.class_id FROM coach_class_seats z WHERE z.status='held' AND z.payment_status='unpaid' AND z.hold_expires_at < now() ORDER BY z.hold_expires_at LIMIT 200")) {
    try {
      await tx(async (c) => {
        const k = await lockClass(c, r.class_id);
        const seat = (await c.query("SELECT * FROM coach_class_seats WHERE id=$1 AND status='held' AND payment_status='unpaid' AND hold_expires_at < now() FOR UPDATE", [r.id])).rows[0];
        if (!k || !seat) return; // paid or released meanwhile
        const row = (await c.query("UPDATE coach_class_seats SET status='cancelled', cancelled_at=now(), cancelled_by='system', payment_status='none', hold_expires_at=NULL, updated_at=now() WHERE id=$1 RETURNING *", [seat.id])).rows[0];
        await notifySeat(c, row, { kind: 'coach_class_hold_expired', title: 'Seat released', body: `Your seat in "${k.title}" was released because it was not paid in time.`, key: `cc_expired:${seat.id}` }, k);
        await promoteWaitlist(c, k);
        changed++;
      });
    } catch (e) { fail('hold expiry', { seat_id: r.id }, e); }
  }

  // 2. minimum not met at the cut-off: cancel the class and refund everyone
  for (const r of await many(
    `SELECT k.id FROM coach_classes k WHERE k.status='open' AND k.starts_at > now() AND k.starts_at - make_interval(hours => k.min_cutoff_hours) <= now()
        AND (SELECT count(*) FROM coach_class_seats z WHERE z.class_id=k.id AND z.status='confirmed') < k.min_participants LIMIT 100`)) {
    try {
      await tx(async (c) => {
        const k = await lockClass(c, r.id);
        if (!k || k.status !== 'open') return;
        const n = Number((await c.query("SELECT count(*) AS n FROM coach_class_seats WHERE class_id=$1 AND status='confirmed'", [k.id])).rows[0].n);
        if (n >= k.min_participants) return;
        await cancelClass(c, k, { reason: 'Not enough people joined', by: 'system' });
        await c.query("UPDATE session_venue_links SET released_at=now(), release_reason='class cancelled' WHERE session_type='coach_class' AND session_id=$1 AND released_at IS NULL", [k.id]);
        await notify(c, k.coach_id, { kind: 'coach_class_auto_cancelled', title: 'Class cancelled: too few joined', body: `"${k.title}" did not reach its minimum by the cut-off, so it was cancelled and everyone was refunded.`, data: { class_id: k.id }, dedupe_key: `cc_autocancel:${k.id}` });
        changed++;
      });
    } catch (e) { fail('minimum check', { class_id: r.id }, e); }
  }

  // 3. a class nobody finished closes itself a day after it ended
  const done = await many("UPDATE coach_classes SET status='completed', row_version=row_version+1, updated_at=now() WHERE status='open' AND starts_at + make_interval(mins => duration_min) + interval '1 day' < now() RETURNING id");
  changed += done.length;
  return changed;
}
