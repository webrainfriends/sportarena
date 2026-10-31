// Coach classes keep themselves honest (issue #656). Run by the maintenance worker; every step is safe to repeat
// (the class row lock serialises seat changes, updates are conditional, notifications carry dedupe keys).
import { many, tx } from './db.js';
import { logger } from './logger.js';
import { notify } from './notify.js';
import { cancelClassTx, confirmedCount, lockClass, notifySeat, processRefunds, promoteWaitlist } from './coach-classes.js';

const each = async (label, rows, fn) => {
  let n = 0;
  for (const r of rows) {
    try { n += (await fn(r)) ? 1 : 0; } catch (e) { logger.error(`coach class ${label} failed`, { class_id: r.id ?? r.class_id, error: String(e.message).slice(0, 200) }); }
  }
  return n;
};

export async function syncCoachClasses() {
  let changed = 0;

  // 1. a held seat that was not paid inside its window lapses, and the next person on the waitlist is offered it
  const lapsed = await many("SELECT DISTINCT class_id FROM coach_class_seats WHERE status='held' AND pay_by IS NOT NULL AND pay_by <= now()");
  changed += await each('payment window', lapsed, ({ class_id }) => tx(async (c) => {
    const k = await lockClass(c, class_id);
    if (!k) return false;
    const gone = (await c.query("UPDATE coach_class_seats SET status='expired', pay_by=NULL, updated_at=now() WHERE class_id=$1 AND status='held' AND pay_by IS NOT NULL AND pay_by <= now() RETURNING *", [class_id])).rows;
    for (const s of gone) await notifySeat(c, s, k, { kind: 'coach_class_hold_expired', title: 'Seat released', body: `Your held seat in "${k.title}" was released because it was not paid in time.`, key: `cc_expired:${s.id}` });
    if (k.status === 'scheduled') await promoteWaitlist(c, k);
    return gone.length > 0;
  }));

  // 2. the cutoff passed without the minimum: the class is cancelled and every paid seat is refunded
  const short = await many("SELECT id FROM coach_classes WHERE status='scheduled' AND cutoff_at <= now() AND starts_at > now() - interval '1 day'");
  changed += await each('minimum', short, ({ id }) => tx(async (c) => {
    const k = await lockClass(c, id);
    if (!k || k.status !== 'scheduled' || new Date(k.cutoff_at) > new Date()) return false;
    if ((await confirmedCount(c, k.id)) >= k.min_participants) return false;
    await cancelClassTx(c, k, { by: 'min_not_met', reason: 'Minimum not reached' });
    await notifyCoach(c, k);
    return true;
  }));

  // 3. a class that has ended is complete; a hold nobody paid is released
  const over = await many("SELECT id FROM coach_classes WHERE status='scheduled' AND starts_at + make_interval(mins => duration_min) <= now()");
  changed += await each('completion', over, ({ id }) => tx(async (c) => {
    const k = await lockClass(c, id);
    if (!k || k.status !== 'scheduled') return false;
    await c.query("UPDATE coach_class_seats SET status='expired', pay_by=NULL, updated_at=now() WHERE class_id=$1 AND status IN ('held','waitlisted','guardian_pending')", [id]);
    await c.query("UPDATE coach_classes SET status='completed', row_version=row_version+1, updated_at=now() WHERE id=$1", [id]);
    return true;
  }));

  // 4. refunds that could not be completed before are retried until the provider confirms them
  changed += await processRefunds(null);
  return changed;
}

async function notifyCoach(c, k) {
  await notify(c, k.coach_id, { kind: 'coach_class_auto_cancelled', title: 'Class cancelled — minimum not reached', body: `"${k.title}" did not reach its minimum by the cutoff, so it was cancelled and paid seats are being refunded.`, data: { class_id: k.id }, dedupe_key: `cc_auto_cancel:${k.id}` });
}
