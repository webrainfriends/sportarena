// Award approvals and conditional offers (#289). An award sits between "the brand decided to fund an application" and "the recipient
// accepted exact terms": it reserves budget, collects the sign-offs the program requires, is issued as a letter with an expiry and
// only the recipient's acceptance of the exact offer version creates the single canonical agreement (a sponsorships row).
// Lock order everywhere: program -> round -> application -> award, so concurrent decisions serialise on the budget.
import { badRequest, conflict, unprocessable } from './errors.js';
import { notify } from './notify.js';
import { notifySponsor } from './sponsor-access.js';
import { pool, tx } from './db.js';

export const LIVE = ['waitlisted', 'pending_approval', 'approved', 'issued', 'accepted'];
export const STEPS = ['approver', 'finance', 'legal'];
const fmtMoney = (cents, currency) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency }).format(Number(cents) / 100); } catch { return `${currency} ${Number(cents) / 100}`; } };

export const logAward = (c, awardId, kind, actorId, offerVersion, note) =>
  c.query('INSERT INTO sponsorship_award_events(award_id, kind, actor_id, offer_version, note) VALUES ($1,$2,$3,$4,$5)', [awardId, kind, actorId ?? null, offerVersion ?? null, note ?? null]);

/** Money and count already used for a program (`program_id`) or a round (`round_id`): accepted awards plus budget held for awards that are not yet agreements. */
export async function budgetUse(c, column, value) {
  if (!['program_id', 'round_id'].includes(column)) throw new Error('bad column');
  const a = (await c.query(`SELECT coalesce(sum(awarded_cents),0)::bigint AS cents, count(*)::int AS n FROM sponsorship_applications WHERE ${column}=$1 AND status='awarded'`, [value])).rows[0];
  const h = (await c.query(`SELECT coalesce(sum(amount_cents),0)::bigint AS cents, count(*)::int AS n FROM sponsorship_award_reservations WHERE ${column}=$1 AND status='held'`, [value])).rows[0];
  return { cents: Number(a.cents) + Number(h.cents), n: a.n + h.n, held_cents: Number(h.cents), held_n: h.n };
}

/** Why `amount` does not fit the program / round budget and award counts (excluding the award's own reservation), or null. */
export async function budgetBlocker(c, p, r, amount, excludeAwardId = null) {
  const own = excludeAwardId ? (await c.query("SELECT amount_cents FROM sponsorship_award_reservations WHERE award_id=$1 AND status='held'", [excludeAwardId])).rows[0] : null;
  const ownCents = Number(own?.amount_cents ?? 0), ownN = own ? 1 : 0;
  const pu = await budgetUse(c, 'program_id', p.id), ru = await budgetUse(c, 'round_id', r.id);
  const pCents = pu.cents - ownCents, rCents = ru.cents - ownCents;
  if (p.max_awards && pu.n - ownN + 1 > p.max_awards) return `The program has reached its limit of ${p.max_awards} awards`;
  if (r.max_awards && ru.n - ownN + 1 > r.max_awards) return `This round has reached its limit of ${r.max_awards} awards`;
  if (pCents + amount > Number(p.budget_cents)) return `This award would exceed the program budget (${Number(p.budget_cents) - pCents} remaining)`;
  if (r.budget_cents != null && rCents + amount > Number(r.budget_cents)) return `This award would exceed the round budget (${Number(r.budget_cents) - rCents} remaining)`;
  return null;
}

/** The sign-offs an award of this size needs under the program's rules. */
export function requiredSteps(p, amount) {
  const steps = [];
  if (p.award_approval_cents != null && amount > Number(p.award_approval_cents)) steps.push('approver');
  if (p.finance_signoff_cents != null && amount > Number(p.finance_signoff_cents)) steps.push('finance');
  if (p.legal_signoff_required) steps.push('legal');
  return steps;
}

async function openApprovals(c, award, p) {
  const steps = requiredSteps(p, Number(award.amount_cents));
  for (const step of steps) await c.query("INSERT INTO sponsorship_award_approvals(award_id, offer_version, step) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [award.id, award.offer_version, step]);
  return steps;
}

export const approvalsOf = async (c, award) =>
  (await c.query('SELECT step, status, decided_by, decided_at, note FROM sponsorship_award_approvals WHERE award_id=$1 AND offer_version=$2 ORDER BY step', [award.id, award.offer_version])).rows;

async function reserve(c, award) {
  // UNIQUE(award_id): a retry or a concurrent call cannot reserve twice
  await c.query("INSERT INTO sponsorship_award_reservations(award_id, program_id, round_id, currency, amount_cents) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (award_id) DO NOTHING", [award.id, award.program_id, award.round_id, award.currency, award.amount_cents]);
}

/** Moves a newly approved/pending award forward: with no sign-offs required the offer is issued straight away. */
async function settle(c, award, p, sp, user) {
  const steps = await openApprovals(c, award, p);
  let row = award;
  if (!steps.length) {
    row = (await c.query("UPDATE sponsorship_awards SET status='approved', updated_at=now() WHERE id=$1 RETURNING *", [award.id])).rows[0];
    await logAward(c, award.id, 'approved', user?.id ?? null, award.offer_version, 'No sign-off required');
    row = await issue(c, row, p, sp, user, `auto:${award.offer_version}`);
  } else {
    await notifySignoffs(c, sp, award, steps);
  }
  return row;
}

async function notifySignoffs(c, sp, award, steps) {
  const action = { approver: 'award_approve', finance: 'award_finance', legal: 'award_legal' };
  for (const step of steps) {
    await notifySponsor(c, sp, action[step], { kind: 'sponsorship_award', title: 'An award needs your sign-off', body: `A ${fmtMoney(award.amount_cents, award.currency)} award needs ${step} sign-off.`, data: { award_id: award.id, step } }, null, award.proposed_by);
  }
}

/** Creates the award for an application under the program lock: reserve (or waitlist when the program has one) and start the sign-offs. */
export async function startAward(c, { p, sp, r, a, amount, user, reason }) {
  const why = await budgetBlocker(c, p, r, amount);
  if (why && !p.waitlist_enabled) throw conflict(why);
  const status = why ? 'waitlisted' : 'pending_approval';
  const rank = why ? Number((await c.query("SELECT coalesce(max(waitlist_rank),0)+1 AS n FROM sponsorship_awards WHERE program_id=$1", [p.id])).rows[0].n) : null;
  const award = (await c.query(
    `INSERT INTO sponsorship_awards(program_id, round_id, application_id, status, amount_cents, currency, waitlist_rank, proposed_by, decision_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [p.id, r.id, a.id, status, amount, p.currency, rank, user.id, reason ?? null])).rows[0];
  await logAward(c, award.id, status === 'waitlisted' ? 'waitlisted' : 'created', user.id, 1, why ?? reason);
  if (status === 'waitlisted') {
    await notify(c, a.applicant_id, { kind: 'sponsorship_program', title: 'You are on the waitlist', body: `Your application to ${p.name} is on the waitlist (#${rank}); you will hear from us if funds become available.`, data: { award_id: award.id }, dedupe_key: `award-waitlist:${award.id}` });
    return award;
  }
  await reserve(c, award);
  return settle(c, award, p, sp, user);
}

/** The plain-text award letter for the exact offer version. */
export async function letterFor(c, award, p, sp, a) {
  const conds = (await c.query('SELECT text, due_on::text, blocks_payment FROM sponsorship_award_conditions WHERE award_id=$1 AND removed_at IS NULL ORDER BY position', [award.id])).rows;
  const target = (await c.query(
    `SELECT CASE $1::text WHEN 'athlete' THEN (SELECT display_name FROM users WHERE id=$2) WHEN 'team' THEN (SELECT name FROM teams WHERE id=$2) ELSE (SELECT name FROM events WHERE id=$2) END AS n`, [a.target_type, a.target_id])).rows[0]?.n ?? 'the recipient';
  const lines = [
    `Award letter — offer version ${award.offer_version}`, '',
    `${sp.name} is pleased to award ${target} ${fmtMoney(award.amount_cents, award.currency)} from the sponsorship program "${p.name}".`,
    `Application reference: ${a.receipt_no ?? a.id}`,
  ];
  if (conds.length) {
    lines.push('', 'This award is conditional on:');
    conds.forEach((x, i) => lines.push(`${i + 1}. ${x.text}${x.due_on ? ` (by ${x.due_on})` : ''}${x.blocks_payment ? ' — must be met before payment' : ''}`));
  }
  lines.push('', 'Nothing is paid until you accept this exact offer and the agreement is in place. The offer lapses if it is not accepted before it expires.');
  return lines.join('\n');
}

/** Issues an approved award. Idempotent per key: a retry returns the issued award and never re-reserves or re-notifies. */
export async function issue(c, award, p, sp, user, key) {
  if (award.status === 'issued' && award.issue_key === key) return { ...award, replayed: true };
  if (award.status !== 'approved') {
    if (award.status === 'pending_approval') throw unprocessable('This award still needs sign-off before it can be issued');
    throw conflict(`A ${award.status} award cannot be issued`);
  }
  const res = (await c.query("SELECT status FROM sponsorship_award_reservations WHERE award_id=$1", [award.id])).rows[0];
  if (res?.status !== 'held') throw unprocessable('The budget for this award is not reserved');
  const open = (await c.query("SELECT 1 FROM sponsorship_award_approvals WHERE award_id=$1 AND offer_version=$2 AND status<>'approved'", [award.id, award.offer_version])).rowCount;
  if (open) throw unprocessable('This award still needs sign-off before it can be issued');
  const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1', [award.application_id])).rows[0];
  const letter = await letterFor(c, award, p, sp, a);
  const row = (await c.query(
    `UPDATE sponsorship_awards SET status='issued', issued_at=now(), issued_by=$2, issue_key=$3, letter=$4, letter_version=offer_version,
            expires_at = clock_timestamp() + make_interval(days => $5), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
    [award.id, user?.id ?? null, key, letter, p.offer_validity_days])).rows[0];
  await logAward(c, award.id, 'issued', user?.id, row.offer_version);
  await notify(c, a.applicant_id, { kind: 'sponsorship_offer', title: 'Your funding application was awarded', body: `${sp.name} offered ${fmtMoney(row.amount_cents, row.currency)}. Review the award letter and accept the offer before it expires.`, data: { award_id: row.id, application_id: a.id }, dedupe_key: `award-issued:${row.id}:${row.offer_version}` });
  return row;
}

/** Ends a not-yet-accepted award: releases the reservation (only if still held) and offers the freed budget to the waitlist. */
export async function closeAward(c, award, status, { actorId = null, reason = null } = {}) {
  const row = (await c.query("UPDATE sponsorship_awards SET status=$2, closed_reason=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 AND status NOT IN ('accepted','declined','expired','withdrawn','rejected') RETURNING *", [award.id, status, reason])).rows[0];
  if (!row) return null;
  await c.query("UPDATE sponsorship_award_reservations SET status='released', release_reason=$2, closed_at=now() WHERE award_id=$1 AND status='held'", [award.id, status]);
  await logAward(c, award.id, status, actorId, award.offer_version, reason);
  await promoteWaitlist(c, award.program_id);
  return row;
}

/** Gives freed budget to waitlisted awards in rank order (first that fits). The caller holds the program lock. */
export async function promoteWaitlist(c, programId) {
  const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1', [programId])).rows[0];
  if (!p?.waitlist_enabled) return 0;
  const sp = (await c.query('SELECT * FROM sponsors WHERE id=$1', [p.sponsor_id])).rows[0];
  const waiting = (await c.query("SELECT * FROM sponsorship_awards WHERE program_id=$1 AND status='waitlisted' ORDER BY waitlist_rank, id FOR UPDATE", [programId])).rows;
  let n = 0;
  for (const w of waiting) {
    const r = (await c.query('SELECT * FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [w.round_id])).rows[0];
    const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [w.application_id])).rows[0];
    if (a.status !== 'submitted') { await c.query("UPDATE sponsorship_awards SET status='withdrawn', closed_reason='application no longer open', updated_at=now() WHERE id=$1", [w.id]); await logAward(c, w.id, 'withdrawn', null, w.offer_version, 'application no longer open'); continue; }
    if (await budgetBlocker(c, p, r, Number(w.amount_cents))) continue;
    const row = (await c.query("UPDATE sponsorship_awards SET status='pending_approval', waitlist_rank=NULL, row_version=row_version+1, updated_at=now() WHERE id=$1 AND status='waitlisted' RETURNING *", [w.id])).rows[0];
    await reserve(c, row);
    await logAward(c, w.id, 'promoted', null, row.offer_version, 'Budget became available');
    await settle(c, row, p, sp, null);
    n++;
  }
  return n;
}

/** Worker step: expire issued offers past their deadline. Safe to repeat and to run on many instances. */
export async function expireAwards({ limit = 200 } = {}) {
  const due = (await pool.query("SELECT id, program_id FROM sponsorship_awards WHERE status='issued' AND expires_at <= clock_timestamp() ORDER BY expires_at, id LIMIT $1", [limit])).rows;
  let n = 0;
  for (const d of due) if (await expireOne(d.id, d.program_id)) n++;
  return n;
}

/** Expires one award if it is issued and past its deadline. Takes the program lock first (lock order). */
export async function expireOne(awardId, programId = null) {
  return tx(async (c) => {
    const pid = programId ?? (await c.query('SELECT program_id FROM sponsorship_awards WHERE id=$1', [awardId])).rows[0]?.program_id;
    if (!pid) return false;
    await c.query('SELECT 1 FROM sponsorship_programs WHERE id=$1 FOR UPDATE', [pid]);
    const award = (await c.query("SELECT * FROM sponsorship_awards WHERE id=$1 AND status='issued' AND expires_at <= clock_timestamp() FOR UPDATE", [awardId])).rows[0];
    if (!award) return false;
    const closed = await closeAward(c, award, 'expired', { reason: 'The offer was not accepted in time' });
    if (!closed) return false;
    const a = (await c.query('SELECT applicant_id FROM sponsorship_applications WHERE id=$1', [award.application_id])).rows[0];
    const p = (await c.query('SELECT name, sponsor_id FROM sponsorship_programs WHERE id=$1', [pid])).rows[0];
    await notify(c, a.applicant_id, { kind: 'sponsorship_offer', title: 'Your funding offer expired', body: `The offer from ${p.name} expired before it was accepted.`, data: { award_id: award.id }, dedupe_key: `award-expired:${award.id}` });
    const sp = (await c.query('SELECT * FROM sponsors WHERE id=$1', [p.sponsor_id])).rows[0];
    await notifySponsor(c, sp, 'program', { kind: 'sponsorship_award', title: 'An award offer expired', body: `The offer to an applicant of ${p.name} expired and its budget was released.`, data: { award_id: award.id }, dedupe_key: `award-expired-staff:${award.id}` }, null, null);
    return true;
  });
}

export const assertVersion = (award, v) => {
  if (award.offer_version !== v) throw conflict(`This offer changed (now version ${award.offer_version}); review it again`, { current_offer_version: award.offer_version });
};
export const needVersion = (v) => { if (v == null) throw badRequest('Act on a specific offer version (offer_version)'); };
