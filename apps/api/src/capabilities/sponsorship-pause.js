// Pause and resume an accepted sponsorship agreement (#297). One side requests, the other approves; the agreed policy decides what happens to
// the dues in the pause (hold until resume, or move by the length of the pause). Nothing is waived, cancelled or duplicated, and every step is
// versioned (`pause_rev`) so a decision made on a stale view is refused. Hangs off the canonical `sponsorships` row; no second agreement system.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { dealContext, logHistory } from '../sponsor-agreements.js';
import { PAUSE_REASONS, applyPause, applyResume, pingParties, resumePlan } from '../sponsor-pause.js';

const date = z.string().date();
const rev = z.coerce.number().int().min(0).describe('the pause_rev you were looking at; a changed agreement is refused (409) so nobody acts on stale terms');
const today = async (c) => (await c.query('SELECT current_date::text AS d')).rows[0].d;

/** Which side the caller acts for. Only the two parties pause an agreement; a platform admin can read but never binds either side. */
function sideOf(ctx, what) {
  if (ctx.role === 'sponsor') { ctx.need('pause', what); return 'sponsor'; }
  if (ctx.role === 'recipient') {
    if (ctx.beneficiary && !ctx.beneficiary.representative) throw forbidden('Only a representative of the recipient can do that');
    return 'recipient';
  }
  throw forbidden('Only the sponsor or the recipient can do that');
}
const stale = (d, expected) => { if (d.pause_rev !== expected) throw conflict(`This agreement changed (now version ${d.pause_rev}); review it again`, { code: 'stale_version', pause_rev: d.pause_rev }); };
const lockPause = async (c, pid, sponsorshipId) => {
  const p = (await c.query('SELECT *, effective_from::text AS effective_from, planned_resume_on::text AS planned_resume_on FROM sponsorship_pauses WHERE id=$1 AND sponsorship_id=$2 FOR UPDATE', [pid, sponsorshipId])).rows[0];
  if (!p) throw notFound('Pause');
  return p;
};

cap({
  name: 'request_sponsorship_pause', method: 'POST', path: '/sponsorships/:id/pause-requests', tag: 'Sponsors', status: 201,
  summary: 'Sponsor (pause permission) or recipient: ask to pause an active agreement from a date, with a reason and the agreed treatment of the dues in it. `hold`: dues not yet due stay owed and fall due again on the resume date. `reschedule`: they move by the length of the pause and the agreement end moves with them. Dues already due before the start, and any due with money, goods or an endorsement in progress, are never held, so nothing is erased. The OTHER side must approve before anything changes. Only one pause can be open per agreement.',
  input: z.object({ id, expected_pause_rev: rev, reason_code: z.enum(PAUSE_REASONS), reason: z.string().max(500).optional(), policy: z.enum(['hold', 'reschedule']), effective_from: date, planned_resume_on: date.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      const side = sideOf(ctx, 'request a pause');
      const { d } = ctx;
      stale(d, i.expected_pause_rev);
      if (d.status === 'paused') throw conflict('This agreement is already paused');
      if (d.status !== 'active' || !d.accepted_version) throw conflict('Only an active, accepted agreement can be paused');
      if (i.effective_from < await today(c)) throw badRequest('A pause cannot start in the past');
      if (d.ends && i.effective_from > d.ends) throw badRequest('A pause cannot start after the agreement ends');
      if (i.planned_resume_on && i.planned_resume_on <= i.effective_from) throw badRequest('The planned resume date must be after the pause starts');
      if (i.reason_code === 'other' && !i.reason?.trim()) throw badRequest('Say why the agreement is being paused');
      try {
        const p = (await c.query(
          `INSERT INTO sponsorship_pauses(sponsorship_id, requested_by_side, requested_by, reason_code, reason, policy, effective_from, planned_resume_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, status, policy, reason_code, reason, effective_from::text AS effective_from, planned_resume_on::text AS planned_resume_on`,
          [d.id, side, user.id, i.reason_code, i.reason?.trim() || null, i.policy, i.effective_from, i.planned_resume_on ?? null])).rows[0];
        await c.query('UPDATE sponsorships SET pause_rev=pause_rev+1 WHERE id=$1', [d.id]);
        await logHistory(c, d.id, d.accepted_version, user.id, 'pause_requested', i.reason_code);
        await pingParties(c, d, 'A sponsorship pause was requested', user.id);
        return { ...p, pause_rev: d.pause_rev + 1 };
      } catch (e) { if (e.code === '23505') throw conflict('A pause is already open on this agreement'); throw e; }
    });
  },
});

cap({
  name: 'decide_sponsorship_pause', method: 'PATCH', path: '/sponsorship-pauses/:id', tag: 'Sponsors',
  summary: 'The side that did NOT request the pause approves or declines it (you cannot approve your own request); the requester can withdraw it. Approving a pause that starts today takes effect at once (the agreement becomes paused and the covered dues are held); one that starts later is scheduled and starts automatically on its date. A request whose start date has passed must be raised again.',
  input: z.object({ id, expected_pause_rev: rev, decision: z.enum(['approve', 'decline', 'withdraw']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const found = (await c.query('SELECT sponsorship_id FROM sponsorship_pauses WHERE id=$1', [i.id])).rows[0];
      if (!found) throw notFound('Pause');
      const ctx = await dealContext(c, found.sponsorship_id, user, { lock: true });
      const side = sideOf(ctx, i.decision === 'withdraw' ? 'withdraw a pause request' : 'decide a pause request');
      const { d } = ctx;
      const p = await lockPause(c, i.id, d.id);
      stale(d, i.expected_pause_rev);
      if (p.status !== 'requested' && !(i.decision === 'withdraw' && p.status === 'scheduled')) throw conflict(`This pause is already ${p.status}`);
      if (i.decision === 'withdraw') {
        if (side !== p.requested_by_side) throw forbidden('Only the side that asked can withdraw the pause');
      } else {
        if (side === p.requested_by_side) throw forbidden('The other side has to decide your request');
        if (!i.note?.trim() && i.decision === 'decline') throw badRequest('Say why you are declining');
        if (d.status !== 'active') throw conflict(`The agreement is ${d.status}, so this pause can no longer be approved`);
        if (i.decision === 'approve' && p.effective_from < await today(c)) throw conflict('The start date of this request has passed; ask for a new pause');
      }
      const status = i.decision === 'approve' ? ((p.effective_from <= await today(c)) ? 'active' : 'scheduled') : i.decision === 'decline' ? 'declined' : 'withdrawn';
      await c.query('UPDATE sponsorship_pauses SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1', [p.id, status === 'active' ? 'scheduled' : status, user.id, i.note?.trim() || null]);
      if (status === 'active') await applyPause(c, { ...p, status: 'scheduled' }, d, user.id);
      else await c.query('UPDATE sponsorships SET pause_rev=pause_rev+1 WHERE id=$1', [d.id]);
      await logHistory(c, d.id, d.accepted_version, user.id, `pause_${i.decision === 'approve' ? (status === 'active' ? 'approved' : 'scheduled') : status}`, i.note);
      await pingParties(c, d, status === 'active' ? 'The sponsorship is paused' : status === 'scheduled' ? 'A sponsorship pause was approved' : `A sponsorship pause was ${status}`, user.id);
      return { id: p.id, status, pause_rev: (await c.query('SELECT pause_rev FROM sponsorships WHERE id=$1', [d.id])).rows[0].pause_rev };
    });
  },
});

cap({
  name: 'preview_sponsorship_resume', method: 'GET', path: '/sponsorships/:id/resume-preview', tag: 'Sponsors',
  summary: 'What resuming today would do, before anyone commits: for each held due its current and new date, amount and currency, the per-currency total, and the new agreement end. Changes nothing.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    const { d } = ctx;
    const p = (await pool.query("SELECT *, effective_from::text AS effective_from FROM sponsorship_pauses WHERE sponsorship_id=$1 AND status='active'", [d.id])).rows[0];
    if (!p || d.status !== 'paused') throw conflict('This agreement is not paused');
    return { pause_id: p.id, pause_rev: d.pause_rev, ...(await resumePlan(pool, p, d)) };
  },
});

cap({
  name: 'resume_sponsorship', method: 'POST', path: '/sponsorships/:id/resume', tag: 'Sponsors',
  summary: 'Either side resumes a paused agreement. Held dues are moved IN PLACE per the agreed policy (never re-created, so no due can be duplicated) and the agreement end moves where the policy says so. Send the pause_rev from the preview: if anything changed meanwhile the call is refused (409). A second resume is refused because the agreement is no longer paused.',
  input: z.object({ id, expected_pause_rev: rev }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      sideOf(ctx, 'resume agreements');
      const { d } = ctx;
      stale(d, i.expected_pause_rev);
      if (d.status !== 'paused') throw conflict('This agreement is not paused');
      const p = (await c.query("SELECT *, effective_from::text AS effective_from FROM sponsorship_pauses WHERE sponsorship_id=$1 AND status='active' FOR UPDATE", [d.id])).rows[0];
      if (!p) throw conflict('This agreement is not paused');
      const r = await applyResume(c, p, d, user.id);
      await pingParties(c, d, 'The sponsorship has resumed', user.id);
      return { status: 'active', pause_rev: d.pause_rev + 1, ...r.plan, summary: r.summary };
    });
  },
});
