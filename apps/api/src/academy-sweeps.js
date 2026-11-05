// Academy OS background work: expire unanswered offers and promote the waitlist, and fan out announcements. (The next period of a monthly fee is raised
// by the shared subscription renewal in booking/plans.js, which also raises its charge.)
// Every step is idempotent (guarded by row versions, unique charge sequence numbers and job dedupe keys), so a retried or concurrent run cannot double up.
import { pool, tx, many } from './db.js';
import { runJobs } from './jobs.js';
import { notify } from './notify.js';
import { moveStage, lockProgramme, promoteWaitlist, tell, recipients } from './academy.js';
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

/**
 * International admissions (#799): nudge the family about checklist items due within a week (or overdue) and evidence expiring within 30 days, and the
 * assigned owner about arrival tasks due within two days. Generic wording, one message per person per item per ISO week, so a re-run never doubles up.
 */
export async function remindIntlDeadlines() {
  const week = String(Math.floor(Date.now() / (7 * 864e5)));
  let n = 0;
  const items = await many(`SELECT i.id AS item_id, k.id AS case_id, k.application_id, k.organisation_id, a.applicant_id, k.athlete_id
      FROM academy_intl_items i JOIN academy_intl_cases k ON k.id=i.case_id JOIN academy_applications a ON a.id=k.application_id
     WHERE a.stage NOT IN ('withdrawn','declined','expired','enrolled') AND i.status IN ('open','rejected')
       AND i.due_on IS NOT NULL AND i.due_on <= CURRENT_DATE + 7
    UNION
    SELECT i.id, k.id, k.application_id, k.organisation_id, a.applicant_id, k.athlete_id
      FROM academy_intl_items i JOIN academy_intl_cases k ON k.id=i.case_id JOIN academy_applications a ON a.id=k.application_id
     WHERE a.stage NOT IN ('withdrawn','declined','expired','enrolled') AND i.status='verified' AND i.expires_on IS NOT NULL AND i.expires_on <= CURRENT_DATE + 30
     LIMIT 500`);
  for (const r of items) {
    for (const uid of await recipients(pool, { applicant_id: r.applicant_id, athlete_id: r.athlete_id })) {
      await notify(null, uid, { kind: 'academy_intl_deadline', title: 'A relocation item needs attention', body: 'Open Gotmygame to see the details.', data: { organisation_id: r.organisation_id, application_id: r.application_id, case_id: r.case_id }, dedupe_key: `intl:deadline:${r.item_id}:${week}:${uid}` });
      n++;
    }
  }
  const tasks = await many("SELECT t.id, t.owner_id, t.case_id, t.organisation_id FROM academy_arrival_tasks t WHERE t.status='open' AND t.owner_id IS NOT NULL AND t.due_on IS NOT NULL AND t.due_on <= CURRENT_DATE + 2 LIMIT 500");
  for (const t of tasks) { await notify(null, t.owner_id, { kind: 'academy_intl_task', title: 'An arrival task is due soon', body: 'Open Gotmygame to see the details.', data: { organisation_id: t.organisation_id, case_id: t.case_id }, dedupe_key: `intl:task:${t.id}:${week}` }); n++; }
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
