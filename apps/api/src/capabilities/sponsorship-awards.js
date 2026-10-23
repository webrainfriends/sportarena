// Award approvals and conditional sponsorship offers (#289). decide_program_application (sponsorship-programs.js) starts an award;
// the capabilities here govern it: sign-offs by approver / finance / legal, issuing the award letter, expiry, the waitlist and the
// recipient's acceptance of one exact offer version, which creates the single canonical agreement (see src/sponsorship-awards.js).
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { logHistory, saveLines, generateObligations } from '../sponsor-agreements.js';
import { buildSchedule } from '../sponsor-schedule.js';
import { sponsorAccess, notifySponsor, actionsFor } from '../sponsor-access.js';
import { budgetBlocker, budgetUse, closeAward, expireOne, issue, logAward, approvalsOf, requiredSteps, assertVersion, needVersion, LIVE } from '../sponsorship-awards.js';
import { programFor, targetOwnerOf, iso } from './sponsorship-programs.js';

const date = z.string().date();
const STATUSES = ['waitlisted', 'pending_approval', 'approved', 'issued', 'accepted', 'declined', 'expired', 'withdrawn', 'rejected'];
const RECIPIENT_STATUSES = ['waitlisted', 'issued', 'accepted', 'declined', 'expired']; // sign-offs and rejections are the brand's internal business
const STEP_ACTION = { approver: 'award_approve', finance: 'award_finance', legal: 'award_legal' };
const CONDITION = z.object({ text: z.string().min(1).max(500), due_on: date.optional(), blocks_payment: z.boolean().default(false) });
const TARGET_NAME = (a) => `CASE ${a}.target_type WHEN 'athlete' THEN (SELECT display_name FROM users WHERE id=${a}.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=${a}.target_id) ELSE (SELECT name FROM events WHERE id=${a}.target_id) END`;
const AWARD_COLS = `w.id, w.program_id, w.round_id, w.application_id, w.status, w.amount_cents, w.currency, w.offer_version, w.row_version, w.waitlist_rank, w.expires_at, w.issued_at, w.sponsorship_id, w.responded_at, w.response_reason, w.closed_reason, w.decision_reason, w.created_at, w.updated_at`;

/** Program -> round -> application -> award, each locked in that order. `action` is the sponsor-side permission the caller needs. */
async function lockAward(c, user, awardId, action) {
  const w0 = (await c.query('SELECT program_id, round_id, application_id FROM sponsorship_awards WHERE id=$1', [awardId])).rows[0];
  if (!w0) throw notFound('Award');
  const { p, sp } = await programFor(user, w0.program_id, action, c, true);
  const r = (await c.query('SELECT * FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [w0.round_id])).rows[0];
  const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [w0.application_id])).rows[0];
  const award = (await c.query('SELECT * FROM sponsorship_awards WHERE id=$1 FOR UPDATE', [awardId])).rows[0];
  return { p, sp, r, a, award };
}

/** What the caller may see of an award, and what they may do with it. Staff see everything for their brand; the recipient only the offer. */
async function view(c, user, awardId) {
  const w = (await c.query(
    `SELECT ${AWARD_COLS}, w.letter, w.letter_version, a.applicant_id, a.target_type, a.target_id, a.requested_cents, a.receipt_no, ${TARGET_NAME('a')} AS target_name,
            p.name AS program_name, p.sponsor_id, p.offer_validity_days, sp.name AS sponsor_name,
            (SELECT status FROM sponsorship_award_reservations x WHERE x.award_id=w.id) AS reservation
       FROM sponsorship_awards w JOIN sponsorship_applications a ON a.id=w.application_id JOIN sponsorship_programs p ON p.id=w.program_id JOIN sponsors sp ON sp.id=p.sponsor_id WHERE w.id=$1`, [awardId])).rows[0];
  if (!w) throw notFound('Award');
  const sponsor = (await c.query('SELECT * FROM sponsors WHERE id=$1', [w.sponsor_id])).rows[0];
  const access = isAdmin(user) ? { role: 'admin' } : await sponsorAccess(user, sponsor, c);
  const staff = !!access;
  const recipient = w.applicant_id === user.id || (await targetOwnerOf(c, w.target_type, w.target_id)) === user.id;
  if (!staff && !(recipient && RECIPIENT_STATUSES.includes(w.status))) throw notFound('Award');
  const { applicant_id, target_id, ...pub } = w;
  const conditions = (await c.query('SELECT id, position, text, due_on::text, blocks_payment, met_at, met_note, offer_version FROM sponsorship_award_conditions WHERE award_id=$1 AND removed_at IS NULL ORDER BY position', [w.id])).rows;
  const out = { ...pub, conditions, my_side: staff ? 'sponsor' : 'recipient' };
  if (staff) {
    out.my_role = access.role;
    out.can = isAdmin(user) ? Object.keys(STEP_ACTION).concat(['manage']) : actionsFor(access.role).filter((x) => x.startsWith('award_')).concat(actionsFor(access.role).includes('program') ? ['manage'] : []);
    out.approvals = await approvalsOf(c, { id: w.id, offer_version: w.offer_version });
    out.events = (await c.query('SELECT kind, actor_id, offer_version, note, created_at FROM sponsorship_award_events WHERE award_id=$1 ORDER BY id', [w.id])).rows;
    out.proposed_by_me = (await c.query('SELECT proposed_by FROM sponsorship_awards WHERE id=$1', [w.id])).rows[0].proposed_by === user.id;
  }
  if (recipient && !staff) {
    out.can = ['respond'];
    const ex = w.expires_at && new Date(w.expires_at) <= new Date();
    out.expired = !!ex;
  }
  return out;
}

cap({
  name: 'get_program_award_summary', method: 'GET', path: '/sponsorship-programs/:id/award-summary', tag: 'Sponsors',
  summary: 'Brand staff: the program\'s award budget at a glance — total, accepted (agreements), reserved for awards not yet accepted, what is still free — plus the number of waitlisted awards and the approval rules in force.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await programFor(user, i.id, 'read', pool);
    const use = await budgetUse(pool, 'program_id', p.id);
    const wl = (await pool.query("SELECT count(*)::int AS n FROM sponsorship_awards WHERE program_id=$1 AND status='waitlisted'", [p.id])).rows[0].n;
    return {
      program_id: p.id, currency: p.currency, budget_cents: Number(p.budget_cents), accepted_cents: use.cents - use.held_cents, reserved_cents: use.held_cents, free_cents: Number(p.budget_cents) - use.cents, waitlisted: wl,
      rules: { award_approval_cents: p.award_approval_cents == null ? null : Number(p.award_approval_cents), finance_signoff_cents: p.finance_signoff_cents == null ? null : Number(p.finance_signoff_cents), legal_signoff_required: p.legal_signoff_required, offer_validity_days: p.offer_validity_days, waitlist_enabled: p.waitlist_enabled },
    };
  },
});

cap({
  name: 'list_program_awards', method: 'GET', path: '/sponsorship-programs/:id/awards', tag: 'Sponsors',
  summary: 'Brand staff: the awards of a program (filter by round and status), newest first, each with the sign-offs it needs for its current offer version, whether its budget is reserved, and the waitlist rank. Deterministic pages.',
  input: z.object({ id, round_id: id.optional(), status: z.enum(STATUSES).optional(), ...page }),
  async handler({ user }, i) {
    const { p } = await programFor(user, i.id, 'read', pool);
    return many(
      `SELECT ${AWARD_COLS}, a.target_type, ${TARGET_NAME('a')} AS target_name, ap.handle AS applicant_handle, ap.display_name AS applicant_name, r.seq AS round_seq,
              (SELECT status FROM sponsorship_award_reservations x WHERE x.award_id=w.id) AS reservation,
              (SELECT coalesce(json_agg(json_build_object('step', s.step, 'status', s.status) ORDER BY s.step), '[]'::json) FROM sponsorship_award_approvals s WHERE s.award_id=w.id AND s.offer_version=w.offer_version) AS approvals
         FROM sponsorship_awards w JOIN sponsorship_applications a ON a.id=w.application_id JOIN users ap ON ap.id=a.applicant_id JOIN sponsorship_rounds r ON r.id=w.round_id
        WHERE w.program_id=$1 AND ($2::uuid IS NULL OR w.round_id=$2) AND ($3::text IS NULL OR w.status=$3)
        ORDER BY w.created_at DESC, w.id LIMIT $4 OFFSET $5`, [p.id, i.round_id ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'list_my_program_awards', method: 'GET', path: '/my/program-awards', tag: 'Sponsors',
  summary: 'Recipient: the funding offers made to your applications — issued offers (with expiry), accepted ones, waitlisted, declined and expired. Internal approval stages are not shown until the brand issues the offer.',
  input: z.object({ status: z.enum(RECIPIENT_STATUSES).optional(), ...page }),
  async handler({ user }, i) {
    for (const d of await many("SELECT w.id FROM sponsorship_awards w JOIN sponsorship_applications a ON a.id=w.application_id WHERE a.applicant_id=$1 AND w.status='issued' AND w.expires_at <= clock_timestamp() LIMIT 50", [user.id])) await expireOne(d.id);
    return many(
      `SELECT ${AWARD_COLS}, a.target_type, ${TARGET_NAME('a')} AS target_name, p.name AS program_name, sp.name AS sponsor_name
         FROM sponsorship_awards w JOIN sponsorship_applications a ON a.id=w.application_id JOIN sponsorship_programs p ON p.id=w.program_id JOIN sponsors sp ON sp.id=p.sponsor_id
        WHERE a.applicant_id=$1 AND w.status = ANY($2) AND ($3::text IS NULL OR w.status=$3) ORDER BY w.created_at DESC, w.id LIMIT $4 OFFSET $5`,
      [user.id, RECIPIENT_STATUSES, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_program_award', method: 'GET', path: '/program-awards/:id', tag: 'Sponsors',
  summary: 'An award: brand staff see the sign-offs, conditions, reservation and history; the recipient sees the issued offer, its conditions, the award letter and the expiry. Anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await expireOne(i.id); // an offer past its deadline is shown (and treated) as expired
    return view(pool, user, i.id);
  },
});

cap({
  name: 'update_program_award', method: 'PATCH', path: '/program-awards/:id', tag: 'Sponsors',
  summary: 'Brand manager/approver: change an award before it is accepted — amount (never above the request or the program maximum, and it must still fit the budget) and/or its conditions (each with an optional due date and whether it must be met before payment). Needs the current `row_version`. Every change starts a new offer version, voids earlier sign-offs and, if the offer was issued, takes it back so it must be approved and issued again; the recipient can only ever accept the version they were shown.',
  input: z.object({ id, row_version: z.coerce.number().int().positive(), amount_cents: money.min(1).optional(), conditions: z.array(CONDITION).max(10).optional().describe('replaces the current conditions'), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    if (i.amount_cents === undefined && !i.conditions) throw badRequest('Nothing to change');
    return tx(async (c) => {
      const { p, sp, r, a, award } = await lockAward(c, user, i.id, 'program');
      if (award.row_version !== i.row_version) throw conflict(`This award was changed by someone else (now version ${award.row_version}); the latest was loaded, review it and try again`, { current_version: award.row_version });
      if (!['pending_approval', 'approved', 'issued'].includes(award.status)) throw conflict(`A ${award.status} award cannot be changed`);
      const amount = i.amount_cents ?? Number(award.amount_cents);
      if (amount > Number(a.requested_cents)) throw badRequest('An award cannot exceed the amount requested');
      if (p.max_award_cents && amount > Number(p.max_award_cents)) throw unprocessable(`An award cannot exceed the program maximum of ${p.max_award_cents}`);
      if (amount !== Number(award.amount_cents)) {
        const why = await budgetBlocker(c, p, r, amount, award.id);
        if (why) throw conflict(why);
        await c.query("UPDATE sponsorship_award_reservations SET amount_cents=$2 WHERE award_id=$1 AND status='held'", [award.id, amount]);
      }
      const wasIssued = award.status === 'issued';
      const next = (await c.query(
        `UPDATE sponsorship_awards SET amount_cents=$2, offer_version=offer_version+1, row_version=row_version+1, status='pending_approval', expires_at=NULL, issue_key=NULL, letter=NULL, letter_version=NULL, updated_at=now()
          WHERE id=$1 RETURNING *`, [award.id, amount])).rows[0];
      if (i.conditions) {
        await c.query('UPDATE sponsorship_award_conditions SET removed_at=now() WHERE award_id=$1 AND removed_at IS NULL', [award.id]);
        let pos = Number((await c.query('SELECT coalesce(max(position)+1,0) AS n FROM sponsorship_award_conditions WHERE award_id=$1', [award.id])).rows[0].n);
        for (const x of i.conditions) await c.query('INSERT INTO sponsorship_award_conditions(award_id, position, text, due_on, blocks_payment, offer_version) VALUES ($1,$2,$3,$4,$5,$6)', [award.id, pos++, x.text, x.due_on ?? null, x.blocks_payment, next.offer_version]);
      }
      await logAward(c, award.id, 'revised', user.id, next.offer_version, i.reason);
      const steps = requiredSteps(p, amount);
      for (const step of steps) await c.query('INSERT INTO sponsorship_award_approvals(award_id, offer_version, step) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [award.id, next.offer_version, step]);
      if (!steps.length) await c.query("UPDATE sponsorship_awards SET status='approved' WHERE id=$1", [award.id]);
      else for (const step of steps) await notifySponsor(c, sp, STEP_ACTION[step], { kind: 'sponsorship_award', title: 'An award needs your sign-off', body: `A revised award needs ${step} sign-off.`, data: { award_id: award.id, step } }, null, user.id);
      if (wasIssued) await notify(c, a.applicant_id, { kind: 'sponsorship_offer', title: 'Your funding offer is being revised', body: `${sp.name} is revising its offer; the earlier version can no longer be accepted. You will be notified when the new offer is issued.`, data: { award_id: award.id }, dedupe_key: `award-revised:${award.id}:${next.offer_version}` });
      await audit(c, user.id, 'update', 'sponsorship_awards', award.id);
      return view(c, user, award.id);
    });
  },
});

cap({
  name: 'decide_award_approval', method: 'POST', path: '/program-awards/:id/approvals', tag: 'Sponsors',
  summary: 'Approve or reject one required sign-off (approver, finance or legal) of the award\'s current offer version. The signer needs that role on the brand, and the person who proposed the award cannot sign it off. A rejection ends the award and releases its reserved budget; when every required sign-off is approved the award becomes issuable.',
  input: z.object({ id, step: z.enum(['approver', 'finance', 'legal']), decision: z.enum(['approve', 'reject']), offer_version: z.coerce.number().int().positive(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p, sp, award } = await lockAward(c, user, i.id, STEP_ACTION[i.step]);
      assertVersion(award, i.offer_version);
      if (award.status !== 'pending_approval') throw conflict(`This award is ${award.status}, not waiting for sign-off`);
      if (award.proposed_by === user.id) throw forbidden('The person who proposed an award cannot sign it off');
      const step = (await c.query("SELECT * FROM sponsorship_award_approvals WHERE award_id=$1 AND offer_version=$2 AND step=$3 FOR UPDATE", [award.id, award.offer_version, i.step])).rows[0];
      if (!step) throw badRequest(`This award does not need ${i.step} sign-off`);
      if (step.status !== 'pending') throw conflict(`The ${i.step} sign-off is already ${step.status}`);
      await c.query("UPDATE sponsorship_award_approvals SET status=$4, decided_by=$5, decided_at=now(), note=$6 WHERE award_id=$1 AND offer_version=$2 AND step=$3", [award.id, award.offer_version, i.step, i.decision === 'approve' ? 'approved' : 'rejected', user.id, i.note ?? null]);
      await logAward(c, award.id, `${i.step}_${i.decision === 'approve' ? 'approved' : 'rejected'}`, user.id, award.offer_version, i.note);
      if (i.decision === 'reject') await closeAward(c, award, 'rejected', { actorId: user.id, reason: i.note ?? `${i.step} rejected` });
      else if (!(await c.query("SELECT 1 FROM sponsorship_award_approvals WHERE award_id=$1 AND offer_version=$2 AND status<>'approved'", [award.id, award.offer_version])).rowCount) {
        await c.query("UPDATE sponsorship_awards SET status='approved', row_version=row_version+1, updated_at=now() WHERE id=$1", [award.id]);
        await logAward(c, award.id, 'approved', user.id, award.offer_version);
        await notifySponsor(c, sp, 'program', { kind: 'sponsorship_award', title: 'An award is approved and ready to issue', body: `All required sign-offs for a ${p.currency} award are in; it can now be issued.`, data: { award_id: award.id } }, null, user.id);
      }
      await audit(c, user.id, `award_${i.step}_${i.decision}`, 'sponsorship_awards', award.id);
      return view(c, user, award.id);
    });
  },
});

cap({
  name: 'issue_program_award', method: 'POST', path: '/program-awards/:id/issue', tag: 'Sponsors',
  summary: 'Brand manager/approver: issue an approved award to the recipient as an award letter with an expiry (the program\'s offer validity). Refused (422) while a required sign-off is missing or the budget is not reserved. Needs an `idempotency_key`: repeating the call with the same key returns the same issued offer and never reserves or notifies twice.',
  input: z.object({ id, offer_version: z.coerce.number().int().positive(), idempotency_key: z.string().min(8).max(100) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p, sp, award } = await lockAward(c, user, i.id, 'program');
      if (award.issue_key === i.idempotency_key && award.status === 'issued' && award.offer_version === i.offer_version) return { ...(await view(c, user, award.id)), replayed: true };
      assertVersion(award, i.offer_version);
      await issue(c, award, p, sp, user, i.idempotency_key);
      await audit(c, user.id, 'issue', 'sponsorship_awards', award.id);
      return view(c, user, award.id);
    });
  },
});

cap({
  name: 'withdraw_program_award', method: 'POST', path: '/program-awards/:id/withdraw', tag: 'Sponsors',
  summary: 'Brand manager/approver: withdraw an award that has not been accepted (waitlisted, awaiting sign-off, approved or issued). Its reserved budget is released and offered to the waitlist; the application returns to the undecided pile so it can be decided again. An accepted award is an agreement and is ended through the agreement.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p, sp, a, award } = await lockAward(c, user, i.id, 'program');
      if (!['waitlisted', 'pending_approval', 'approved', 'issued'].includes(award.status)) throw conflict(`A ${award.status} award cannot be withdrawn`);
      await closeAward(c, award, 'withdrawn', { actorId: user.id, reason: i.reason });
      if (award.status === 'issued') await notify(c, a.applicant_id, { kind: 'sponsorship_offer', title: 'Your funding offer was withdrawn', body: `${sp.name} withdrew its offer from ${p.name}.`, data: { award_id: award.id }, dedupe_key: `award-withdrawn:${award.id}` });
      await audit(c, user.id, 'withdraw', 'sponsorship_awards', award.id);
      return view(c, user, award.id);
    });
  },
});

cap({
  name: 'respond_to_program_award', method: 'POST', path: '/program-awards/:id/respond', tag: 'Sponsors',
  summary: 'Recipient (the applicant or the owner of the funded team/event/profile): accept or decline an issued offer. Accepting names the exact `offer_version` shown (409 if the brand revised it since) and is refused once the offer has expired. Acceptance creates the single canonical agreement, with its schedule, and converts the reservation; repeating the same acceptance returns the same agreement. Declining releases the budget. No payment, consent or delivery is assumed.',
  input: z.object({ id, decision: z.enum(['accept', 'decline']), offer_version: z.coerce.number().int().positive(), reason: z.string().max(500).optional(), show_publicly: z.boolean().optional() }),
  async handler({ user }, i) {
    await expireOne(i.id); // never act on an offer that is past its deadline
    return tx(async (c) => {
      const w0 = (await c.query('SELECT program_id, round_id, application_id FROM sponsorship_awards WHERE id=$1', [i.id])).rows[0];
      if (!w0) throw notFound('Award');
      const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1 FOR UPDATE', [w0.program_id])).rows[0];
      await c.query('SELECT 1 FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [w0.round_id]);
      const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [w0.application_id])).rows[0];
      const award = (await c.query('SELECT * FROM sponsorship_awards WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const owner = await targetOwnerOf(c, a.target_type, a.target_id);
      if (a.applicant_id !== user.id && owner !== user.id && !isAdmin(user)) throw notFound('Award');
      const sp = (await c.query('SELECT * FROM sponsors WHERE id=$1', [p.sponsor_id])).rows[0];
      if (award.status === 'accepted' && i.decision === 'accept' && award.offer_version === i.offer_version) return { ...(await view(c, user, award.id)), replayed: true };
      if (award.status === 'expired') throw conflict('This offer expired; ask the brand to issue a new one');
      if (award.status !== 'issued') throw conflict(`This offer is ${award.status}`);
      assertVersion(award, i.offer_version);
      if (new Date(award.expires_at) <= new Date()) throw conflict('This offer expired; ask the brand to issue a new one');
      if (i.decision === 'decline') {
        await c.query('UPDATE sponsorship_awards SET responded_by=$2, responded_at=now(), response_reason=$3 WHERE id=$1', [award.id, user.id, i.reason ?? null]);
        await closeAward(c, award, 'declined', { actorId: user.id, reason: i.reason });
        await c.query("UPDATE sponsorship_applications SET status='withdrawn', decided_at=now(), decided_by=$2, decision_reason=$3 WHERE id=$1", [a.id, user.id, i.reason ?? 'Offer declined']);
        await notifySponsor(c, sp, 'program', { kind: 'sponsorship_award', title: 'An award offer was declined', body: `An offer from ${p.name} was declined.`, data: { award_id: award.id } }, null, null);
        return view(c, user, award.id);
      }
      // acceptance: the ONE canonical agreement, from the exact offer the recipient saw
      const visibility = a.target_type === 'athlete' && !i.show_publicly ? 'private' : 'public';
      const deal = (await c.query(
        `INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, starts_on, ends_on, proposed_by, objectives, visibility, program_id, round_id, application_id, status, decided_at, decided_by, accepted_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',now(),$14,1) RETURNING *`,
        [sp.id, a.target_type, a.target_id, award.amount_cents, p.currency, p.starts_on, p.ends_on, award.proposed_by, p.objective, visibility, p.id, award.round_id, a.id, user.id])).rows[0];
      const today = iso(new Date()), start = p.starts_on ? iso(p.starts_on) : null, end = p.ends_on ? iso(p.ends_on) : null;
      let due = start && start > today ? start : today;
      if (end && due > end) due = end;
      const line = { kind: 'money', label: `Award: ${p.name}`.slice(0, 160), currency: p.currency, total_cents: Number(award.amount_cents), cadence: 'once', first_due_on: due, terms: {} };
      buildSchedule([line], { starts_on: start, ends_on: end });
      await saveLines(c, deal.id, 1, [line]);
      await c.query("UPDATE sponsorships SET agreement_ref='SPA-'||upper(substr(id::text,1,8)) WHERE id=$1", [deal.id]);
      await logHistory(c, deal.id, 1, award.proposed_by, 'proposed', `Awarded from program ${p.name} (offer v${award.offer_version})`);
      await logHistory(c, deal.id, 1, user.id, 'accepted', i.reason);
      await generateObligations(c, deal.id);
      await c.query("UPDATE sponsorship_award_reservations SET status='converted', closed_at=now() WHERE award_id=$1 AND status='held'", [award.id]);
      await c.query("UPDATE sponsorship_awards SET status='accepted', sponsorship_id=$2, responded_by=$3, responded_at=now(), response_reason=$4, row_version=row_version+1, updated_at=now() WHERE id=$1", [award.id, deal.id, user.id, i.reason ?? null]);
      await c.query("UPDATE sponsorship_applications SET status='awarded', awarded_cents=$2, decided_at=now(), decided_by=$3, decision_reason=$4, sponsorship_id=$5 WHERE id=$1", [a.id, award.amount_cents, award.proposed_by, award.decision_reason, deal.id]);
      await logAward(c, award.id, 'accepted', user.id, award.offer_version, i.reason);
      await notifySponsor(c, sp, 'read', { kind: 'sponsorship_update', title: 'Award accepted', body: `An award from ${p.name} was accepted; the agreement is in place.`, data: { sponsorship_id: deal.id, award_id: award.id } }, null, null);
      await audit(c, user.id, 'accept', 'sponsorship_awards', award.id);
      return view(c, user, award.id);
    });
  },
});

cap({
  name: 'meet_award_condition', method: 'POST', path: '/program-awards/:id/conditions/:condition_id/met', tag: 'Sponsors',
  summary: 'Brand manager/approver: record that a condition of an accepted award has been met (with a note), or clear it again. A report from the recipient alone never marks a condition met.',
  input: z.object({ id, condition_id: id, met: z.boolean().default(true), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { award } = await lockAward(c, user, i.id, 'program');
      if (award.status !== 'accepted') throw conflict('Conditions are tracked once the award has been accepted');
      const x = (await c.query('UPDATE sponsorship_award_conditions SET met_at=$3, met_by=$4, met_note=$5 WHERE id=$1 AND award_id=$2 AND removed_at IS NULL RETURNING id', [i.condition_id, award.id, i.met ? new Date() : null, i.met ? user.id : null, i.note ?? null])).rows[0];
      if (!x) throw notFound('Condition');
      await logAward(c, award.id, i.met ? 'condition_met' : 'condition_cleared', user.id, award.offer_version, i.note);
      return view(c, user, award.id);
    });
  },
});
