// Mutually accepted amendments of an accepted sponsorship agreement (#296). Hangs off the canonical `sponsorships` row and its dues
// (see sponsorship-agreements.js); there is no second agreement or ledger. The rules live in ../sponsor-amendments.js.
import { z } from 'zod';
import { notifyRecipient, assertYouthAuthority, assertYouthContact } from '../youth-sponsorship.js';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { LINE } from '../sponsor-schedule.js';
import { dealContext, logHistory } from '../sponsor-agreements.js';
import { notifySponsor, actionsFor } from '../sponsor-access.js';
import { ORG_TARGETS } from '../sponsor-beneficiaries.js';
import { checkProposal, applyAmendment, impactOf, assertChanges } from '../sponsor-amendments.js';
import { toCsv } from '../csv.js';

const date = z.string().date();
const PROPOSAL = {
  lines: z.array(LINE).min(1).max(12).describe('the FULL set of contribution lines after the amendment (value, recurrence, deliverables, rights)'),
  starts_on: date.optional(), ends_on: date.optional(), timezone: z.string().max(60).optional(),
  effective_from: date.describe('only dues on or after this date change; earlier dues, and any due that already has a payment, delivery or evidence, never do'),
  allocations: z.array(z.object({
    beneficiary_type: z.enum(['organisation', 'group', 'team']), beneficiary_id: id, share_bp: z.number().int().min(1).max(10000), payee_user_id: id,
  })).max(20).optional().describe('organisation / group agreements: who is paid after the amendment; omit to leave the payees unchanged'),
  reason: z.string().max(500).optional(),
};

/** Notifications never carry terms or amounts; the participant-scoped reads do. */
const ping = (c, to, title, ctx) => {
  const msg = { kind: 'sponsorship_update', title, body: `Open the ${ctx.sp.name} agreement to see the amendment.`, data: { sponsorship_id: ctx.d.id } };
  return to === 'sponsor' ? notifySponsor(c, ctx.sp, 'sign_off', msg, ctx.d.department_id) : notifyRecipient(c, to, msg);
};

/** Which side of the agreement the caller speaks for on an amendment. Platform admins read, but never bind either side. */
function sideOf(ctx, need) {
  if (ctx.role === 'sponsor') { ctx.need(need, need === 'sign_off' ? 'agree to an amendment for the brand' : 'propose an amendment for the brand'); return 'sponsor'; }
  if (ctx.role === 'recipient') {
    if (ORG_TARGETS.includes(ctx.d.target_type) && !ctx.beneficiary?.representative) throw forbidden('Only an owner or admin of the organisation can amend this agreement');
    return 'recipient';
  }
  throw forbidden('Only the sponsor or the recipient can amend an agreement');
}
const hiddenFromRecipient = (ctx) => ctx.role === 'recipient' && ['pending', 'rejected'].includes(ctx.d.budget_approval);
const seeAllocations = (ctx) => ctx.role === 'recipient' || ctx.role === 'admin';

const SUMMARY = `a.id, a.sponsorship_id, a.seq, a.status, a.proposed_side, a.rev, a.base_version, a.resulting_version, a.effective_from::text AS effective_from,
  a.starts_on::text AS starts_on, a.ends_on::text AS ends_on, a.timezone, a.reason, a.decision_note, a.created_at, a.updated_at, a.decided_at,
  (a.allocations IS NOT NULL) AS changes_payees, p.display_name AS proposed_by_name, u.display_name AS decided_by_name`;
const FROM = 'FROM sponsorship_amendments a JOIN users p ON p.id=a.proposed_by LEFT JOIN users u ON u.id=a.decided_by';

async function detail(c, ctx, am) {
  const out = { ...am, mine: am.proposed_side === ctx.role };
  const full = (await c.query('SELECT lines, allocations, base_allocation_rev FROM sponsorship_amendments WHERE id=$1', [am.id])).rows[0];
  out.lines = full.lines;
  if (full.allocations) out.allocations = full.allocations.map((a) => (seeAllocations(ctx) ? a : { beneficiary_type: a.beneficiary_type, beneficiary_name: a.beneficiary_name, share_bp: a.share_bp }));
  if (am.status === 'proposed') {
    try { out.impact = await impactOf(c, ctx.d, { lines: full.lines, starts_on: am.starts_on, ends_on: am.ends_on, effective_from: am.effective_from }); }
    catch (e) { out.impact_error = e.message; }
    const may = (a) => (ctx.role === 'recipient' ? !ORG_TARGETS.includes(ctx.d.target_type) || !!ctx.beneficiary?.representative : ctx.role === 'sponsor' ? actionsFor(ctx.staff).includes(a) : false);
    out.can_answer = am.proposed_side !== ctx.role && ctx.d.status === 'active' && may('sign_off');
    out.can_edit = am.proposed_side === ctx.role && ctx.d.status === 'active' && may('revise');
  }
  return out;
}

cap({
  name: 'preview_sponsorship_amendment', method: 'POST', path: '/sponsorships/:id/amendments/preview', tag: 'Sponsors', scope: 'read',
  summary: 'Impact preview of a change to an ACCEPTED agreement, before anyone proposes or accepts it: which earlier dues stay exactly as they are (retained), which untouched future dues would be replaced, the new dues, the cash before and after per currency (never combined) and whether it is blocked because a future due already has a payment, delivery, evidence or fulfilment. Saves nothing.',
  input: z.object({ id, ...PROPOSAL }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (hiddenFromRecipient(ctx)) throw notFound('Sponsorship');
    if (ctx.role === 'admin') throw forbidden('Only the sponsor or the recipient can amend an agreement');
    if (ctx.role === 'sponsor') ctx.need('read', 'see this agreement');
    const { d } = ctx;
    if (d.status !== 'active' || !d.accepted_version) throw conflict(`Only an active, accepted agreement can be amended (this one is ${d.status})`);
    const starts = i.starts_on ?? d.starts ?? null, ends = i.ends_on ?? d.ends ?? null;
    if (starts && ends && ends < starts) throw badRequest('ends_on is before starts_on');
    await assertChanges(pool, d, { lines: i.lines, starts_on: starts, ends_on: ends, timezone: i.timezone ?? d.timezone ?? null, allocations: i.allocations ?? null });
    return impactOf(pool, d, { lines: i.lines, starts_on: starts, ends_on: ends, effective_from: i.effective_from });
  },
});

cap({
  name: 'propose_sponsorship_amendment', method: 'POST', path: '/sponsorships/:id/amendments', tag: 'Sponsors', status: 201,
  summary: 'Either side proposes a change to the value, dates, payee, recurrence, deliverables or rights of an ACCEPTED agreement. It is a versioned proposal: nothing changes (no due, payment, delivery or payee) until the other side accepts the exact revision. One proposal can be open at a time. The brand needs the right to revise terms; an organisation recipient needs to be its owner or admin.',
  input: z.object({ id, ...PROPOSAL, expected_version: z.coerce.number().int().positive().describe('the accepted terms version you are changing; a stale one is rejected') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (hiddenFromRecipient(ctx)) throw notFound('Sponsorship');
      const side = sideOf(ctx, 'revise');
      if (i.expected_version !== ctx.d.accepted_version) throw conflict(`This agreement is now at version ${ctx.d.accepted_version}; review it again before proposing changes`);
      if ((await c.query("SELECT 1 FROM sponsorship_amendments WHERE sponsorship_id=$1 AND status='proposed'", [ctx.d.id])).rowCount) throw conflict('An amendment is already open on this agreement; answer or withdraw it first');
      const { p } = await checkProposal(c, ctx, i);
      const seq = Number((await c.query('SELECT coalesce(max(seq),0)+1 AS n FROM sponsorship_amendments WHERE sponsorship_id=$1', [ctx.d.id])).rows[0].n);
      const a = (await c.query(
        `INSERT INTO sponsorship_amendments(sponsorship_id, seq, base_version, proposed_side, proposed_by, effective_from, starts_on, ends_on, timezone, lines, allocations, base_allocation_rev, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13) RETURNING id`,
        [ctx.d.id, seq, ctx.d.accepted_version, side, user.id, p.effective_from, p.starts_on, p.ends_on, p.timezone, JSON.stringify(p.lines), p.allocations ? JSON.stringify(p.allocations) : null, p.allocations ? ctx.d.allocation_rev : null, i.reason ?? null])).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.accepted_version, user.id, 'amendment_proposed', `Amendment ${seq}${i.reason ? `: ${i.reason}` : ''}`);
      await ping(c, side === 'sponsor' ? ctx.recipientId : 'sponsor', 'An amendment to a sponsorship agreement needs your answer', ctx);
      const am = (await c.query(`SELECT ${SUMMARY} ${FROM} WHERE a.id=$1`, [a.id])).rows[0];
      return detail(c, ctx, am);
    });
  },
});

cap({
  name: 'revise_sponsorship_amendment', method: 'POST', path: '/sponsorship-amendments/:id/revise', tag: 'Sponsors',
  summary: 'The proposing side edits its own open proposal. This creates a new revision (rev + 1); an answer based on an older revision is rejected, so the other side can only ever accept exactly what they saw.',
  input: z.object({ id, ...PROPOSAL, rev: z.coerce.number().int().positive().describe('the revision you are editing; a stale one is rejected') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = (await c.query('SELECT sponsorship_id FROM sponsorship_amendments WHERE id=$1', [i.id])).rows[0];
      if (!a0) throw notFound('Amendment');
      const ctx = await dealContext(c, a0.sponsorship_id, user, { lock: true });
      if (hiddenFromRecipient(ctx)) throw notFound('Amendment');
      const side = sideOf(ctx, 'revise');
      const am = (await c.query('SELECT *, effective_from::text AS effective_from, starts_on::text AS starts_on, ends_on::text AS ends_on FROM sponsorship_amendments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (am.status !== 'proposed') throw conflict(`This amendment is already ${am.status}`);
      if (am.proposed_side !== side) throw forbidden('Only the side that proposed this amendment can edit it');
      if (i.rev !== am.rev) throw conflict(`This amendment changed (now revision ${am.rev}); review it again`);
      const { p } = await checkProposal(c, ctx, i);
      await c.query(
        `UPDATE sponsorship_amendments SET rev=rev+1, base_version=$2, effective_from=$3, starts_on=$4, ends_on=$5, timezone=$6, lines=$7::jsonb, allocations=$8::jsonb, base_allocation_rev=$9, reason=$10, updated_at=now() WHERE id=$1`,
        [am.id, ctx.d.accepted_version, p.effective_from, p.starts_on, p.ends_on, p.timezone, JSON.stringify(p.lines), p.allocations ? JSON.stringify(p.allocations) : null, p.allocations ? ctx.d.allocation_rev : null, i.reason ?? null]);
      await logHistory(c, ctx.d.id, ctx.d.accepted_version, user.id, 'amendment_revised', `Amendment ${am.seq}, revision ${am.rev + 1}`);
      await ping(c, side === 'sponsor' ? ctx.recipientId : 'sponsor', 'A proposed amendment was updated', ctx);
      return detail(c, ctx, (await c.query(`SELECT ${SUMMARY} ${FROM} WHERE a.id=$1`, [am.id])).rows[0]);
    });
  },
});

cap({
  name: 'decide_sponsorship_amendment', method: 'POST', path: '/sponsorship-amendments/:id/decision', tag: 'Sponsors',
  summary: 'Answer an open amendment. The OTHER side accepts or rejects (accepting needs the exact `rev` and the agreement `version` they reviewed; a stale one fails with 409 and changes nothing). The proposing side can withdraw. Accepting writes one new terms version and, once, replaces only the untouched future dues from the effective date: fulfilled, part-paid, dispatched, submitted and earlier dues stay as they are. A brand\'s acceptance needs the sign-off right (manager or approver). Nothing is deleted.',
  input: z.object({ id, decision: z.enum(['accept', 'reject', 'withdraw']), rev: z.coerce.number().int().positive(), version: z.coerce.number().int().positive().optional().describe('required to accept: the accepted terms version you reviewed'), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = (await c.query('SELECT sponsorship_id FROM sponsorship_amendments WHERE id=$1', [i.id])).rows[0];
      if (!a0) throw notFound('Amendment');
      const ctx = await dealContext(c, a0.sponsorship_id, user, { lock: true });
      if (hiddenFromRecipient(ctx)) throw notFound('Amendment');
      const side = sideOf(ctx, i.decision === 'withdraw' ? 'revise' : 'sign_off');
      const am = (await c.query('SELECT *, effective_from::text AS effective_from, starts_on::text AS starts_on, ends_on::text AS ends_on FROM sponsorship_amendments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (am.status !== 'proposed') throw conflict(`This amendment is already ${am.status}`);
      if (i.rev !== am.rev) throw conflict(`This amendment changed (now revision ${am.rev}); review it again before answering`);
      if (i.decision === 'withdraw') { if (am.proposed_side !== side) throw forbidden('Only the side that proposed this amendment can withdraw it'); }
      else if (am.proposed_side === side) throw forbidden('You cannot answer your own proposal; the other side does');
      if (i.decision === 'reject' && !i.note) throw badRequest('Say why you are rejecting it');
      let applied = null, status = { accept: 'accepted', reject: 'rejected', withdraw: 'withdrawn' }[i.decision];
      if (i.decision === 'accept') {
        if (i.version == null) throw badRequest('Accept a specific version of the agreement (version)');
        if (ctx.d.status !== 'active' || ctx.d.accepted_version !== am.base_version || i.version !== ctx.d.accepted_version) throw conflict(`This agreement is now at version ${ctx.d.accepted_version}; review the amendment again`, { code: 'stale_version' });
        applied = await applyAmendment(c, ctx, am, user);
      } else await logHistory(c, ctx.d.id, ctx.d.accepted_version, user.id, `amendment_${status}`, `Amendment ${am.seq}${i.note ? `: ${i.note}` : ''}`);
      await c.query('UPDATE sponsorship_amendments SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, resulting_version=$5, updated_at=now() WHERE id=$1', [am.id, status, user.id, i.note ?? null, applied?.version ?? null]);
      await ping(c, side === 'sponsor' ? ctx.recipientId : 'sponsor', `A proposed amendment was ${status}`, ctx);
      const out = await detail(c, ctx, (await c.query(`SELECT ${SUMMARY} ${FROM} WHERE a.id=$1`, [am.id])).rows[0]);
      if (applied) out.applied = { version: applied.version, dues_replaced: applied.replaced, dues_created: applied.created };
      return out;
    });
  },
});

cap({
  name: 'list_sponsorship_amendments', method: 'GET', path: '/sponsorships/:id/amendments', tag: 'Sponsors',
  summary: 'The amendments of an agreement, newest first (stable order), for its sponsor, its recipient or an admin: status, who proposed it, revision, effective date and the version it created. Participants only; another tenant gets 403.',
  input: z.object({ id, status: z.enum(['proposed', 'accepted', 'rejected', 'withdrawn', 'superseded']).optional(), ...page }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (hiddenFromRecipient(ctx)) throw notFound('Sponsorship');
    const where = 'a.sponsorship_id=$1 AND ($2::text IS NULL OR a.status=$2)';
    const [rows, total] = await Promise.all([
      many(`SELECT ${SUMMARY} ${FROM} WHERE ${where} ORDER BY a.seq DESC LIMIT $3 OFFSET $4`, [ctx.d.id, i.status ?? null, i.limit, i.offset]),
      one(`SELECT count(*)::int AS n FROM sponsorship_amendments a WHERE ${where}`, [ctx.d.id, i.status ?? null])]);
    return { amendments: rows.map((a) => ({ ...a, mine: a.proposed_side === ctx.role })), total: total.n };
  },
});

cap({
  name: 'get_sponsorship_amendment', method: 'GET', path: '/sponsorship-amendments/:id', tag: 'Sponsors',
  summary: 'One amendment with its proposed lines and, while it is open, the live impact preview: retained, replaced and new dues, cash before and after per currency, and whether it is blocked. Payee details are shown to the recipient only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a0 = await one('SELECT sponsorship_id FROM sponsorship_amendments WHERE id=$1', [i.id]);
    if (!a0) throw notFound('Amendment');
    const ctx = await dealContext(pool, a0.sponsorship_id, user);
    if (hiddenFromRecipient(ctx)) throw notFound('Amendment');
    return detail(pool, ctx, (await pool.query(`SELECT ${SUMMARY} ${FROM} WHERE a.id=$1`, [i.id])).rows[0]);
  },
});

cap({
  name: 'export_sponsorship_amendments', method: 'GET', path: '/sponsorships/:id/amendments/export', tag: 'Sponsors',
  summary: 'CSV of an agreement\'s amendment history (number, status, who proposed it, effective date, versions, dates, reason, outcome). Same participants as the reads; a brand needs the export right (manager, finance or auditor). No payee, contact or private note is exported.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (hiddenFromRecipient(ctx)) throw notFound('Sponsorship');
    if (ctx.role === 'sponsor') ctx.need('export', 'export amendment history');
    if (ctx.role === 'recipient' && ORG_TARGETS.includes(ctx.d.target_type) && !ctx.beneficiary?.representative) throw forbidden('Only an owner or admin of the organisation can export this');
    const rows = await many(`SELECT ${SUMMARY} ${FROM} WHERE a.sponsorship_id=$1 ORDER BY a.seq`, [ctx.d.id]);
    const cols = ['agreement_ref', 'amendment', 'status', 'proposed_by_side', 'revision', 'base_version', 'resulting_version', 'effective_from', 'starts_on', 'ends_on', 'changes_payees', 'reason', 'decision_note', 'proposed_at', 'decided_at'];
    const out = rows.map((a) => ({ agreement_ref: ctx.d.agreement_ref, amendment: a.seq, status: a.status, proposed_by_side: a.proposed_side, revision: a.rev, base_version: a.base_version, resulting_version: a.resulting_version,
      effective_from: a.effective_from, starts_on: a.starts_on, ends_on: a.ends_on, changes_payees: a.changes_payees ? 'yes' : 'no', reason: a.reason, decision_note: a.decision_note, proposed_at: a.created_at?.toISOString?.() ?? a.created_at, decided_at: a.decided_at?.toISOString?.() ?? a.decided_at }));
    return { filename: `amendments-${ctx.d.agreement_ref ?? ctx.d.id}.csv`, rows: out.length, csv: toCsv(cols, out) };
  },
});
