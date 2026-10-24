// Academy OS background work: expire unanswered offers and promote the waitlist, raise the next monthly tuition charge, and fan out announcements.
// Every step is idempotent (guarded by row versions, unique charge sequence numbers and job dedupe keys), so a retried or concurrent run cannot double up.
import { pool, tx, many } from './db.js';
import { runJobs } from './jobs.js';
import { notify } from './notify.js';
import { moveStage, lockProgramme, promoteWaitlist, tell, recipients, planCharges, insertCharges } from './academy.js';
import { addMonths } from './sponsor-schedule.js';
import { remindAcademyTrials } from './academy-trials.js';

/** The day-before reminder for booked trial seats (one per seat). */
export const remindTrials = () => tx((c) => remindAcademyTrials(c));

/** Offers past their expiry window lapse and the next person on the waitlist is offered the place. */
export async function expireAcademyOffers() {
  const due = await many("SELECT id, programme_id FROM academy_applications WHERE stage='offered' AND offer_expires_at <= now() ORDER BY offer_expires_at, id LIMIT 200");
  let n = 0;
  for (const d of due) {
    await tx(async (c) => {
      const p = await lockProgramme(c, d.programme_id);
      const a = (await c.query("SELECT * FROM academy_applications WHERE id=$1 AND stage='offered' AND offer_expires_at <= now() FOR UPDATE", [d.id])).rows[0];
      if (!a) return;
      const row = await moveStage(c, a, 'expired', { reason: 'Offer expired' });
      await tell(c, row, 'offer_expired', 'Your offer has expired');
      await promoteWaitlist(c, p);
      n++;
    });
  }
  return n;
}

/** Monthly programmes: raise next month's charge a week ahead, one per enrolment per month, until the programme ends. Never charges automatically. */
export async function raiseAcademyMonthlyCharges() {
  const rows = await many(
    `SELECT e.id AS enrolment_id, e.user_id, v.*, p.ends_on, ch.payer_id, ch.organisation_id, ch.last_due, ch.last_seq
       FROM org_enrolments e JOIN academy_programmes p ON p.id=e.programme_id JOIN academy_programme_versions v ON v.id=e.version_id AND v.billing_model='monthly'
       JOIN LATERAL (SELECT payer_id, organisation_id, max(due_on) AS last_due, max(seq) AS last_seq FROM academy_charges WHERE enrolment_id=e.id AND kind='instalment' GROUP BY payer_id, organisation_id) ch ON true
      WHERE e.status='enrolled' AND ch.last_due <= current_date + 30 ORDER BY e.id LIMIT 500`);
  let n = 0;
  for (const r of rows) {
    const next = addMonths(String(r.last_due).slice(0, 10), 1);
    if (next > new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)) continue;
    if (r.ends_on && next > String(r.ends_on).slice(0, 10)) continue;
    await tx(async (c) => {
      const [row] = planCharges({ ...r, registration_fee_minor: 0, billing_model: 'monthly', sibling_discount_bp: 0, multi_programme_discount_bp: 0 }, { today: next, sibling: false, multi: false });
      if (!row) return;
      try {
        await c.query('SAVEPOINT m');
        await insertCharges(c, { enrolmentId: r.enrolment_id, orgId: r.organisation_id, payerId: r.payer_id, rows: [row], seqStart: r.last_seq + 1 });
        await c.query('RELEASE SAVEPOINT m');
        await notify(c, r.payer_id, { kind: 'academy_payment_due', title: 'A payment is coming up', body: 'Open Gotmygame to see what is due.', data: { organisation_id: r.organisation_id, enrolment_id: r.enrolment_id }, dedupe_key: `academy:due:${r.enrolment_id}:${next}` });
        n++;
      } catch (e) { await c.query('ROLLBACK TO SAVEPOINT m'); if (e.code !== '23505') throw e; }
    });
  }
  return n;
}

const handlers = {
  'academy.announce': async (p) => {
    const apps = await many('SELECT id, organisation_id, programme_id, athlete_id, applicant_id FROM academy_applications WHERE organisation_id=$1 AND stage = ANY($2) AND ($3::uuid IS NULL OR programme_id=$3) ORDER BY id', [p.organisation_id, p.stages, p.programme_id]);
    const seen = new Set();
    for (const a of apps) {
      for (const uid of await recipients(pool, a)) {
        if (seen.has(uid)) continue; // one message per person even with several roles or children
        seen.add(uid);
        await notify(null, uid, { kind: 'academy_announcement', title: p.title, body: p.body, data: { organisation_id: p.organisation_id, programme_id: p.programme_id }, dedupe_key: `announce:${p.organisation_id}:${p.title}:${p.body.length}:${uid}:${new Date().toISOString().slice(0, 10)}` });
      }
    }
  },
};
export const runAcademyJobs = () => runJobs('academy', handlers);
