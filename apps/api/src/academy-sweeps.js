// Academy OS background work: expire unanswered offers and promote the waitlist, and fan out announcements. (The next period of a monthly fee is raised
// by the shared subscription renewal in booking/plans.js, which also raises its charge.)
// Every step is idempotent (guarded by row versions, unique charge sequence numbers and job dedupe keys), so a retried or concurrent run cannot double up.
import { pool, tx, many } from './db.js';
import { runJobs } from './jobs.js';
import { notify } from './notify.js';
import { moveStage, lockProgramme, promoteWaitlist, tell, recipients } from './academy.js';

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
