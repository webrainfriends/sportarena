// Termination of a sponsorship agreement (#298): notice, reason and effective date, agreed terms, returns of goods, refunds of canonical
// sponsorship payments, disputes and a final settlement. Hangs off the canonical `sponsorships` row and its dues; there is no second ledger.
// The rules live in ../sponsor-termination.js.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { dealContext, logHistory } from '../sponsor-agreements.js';
import { actionsFor } from '../sponsor-access.js';
import { ORG_TARGETS } from '../sponsor-beneficiaries.js';
import { refundPartial } from '../payments/service.js';
import { toCsv } from '../csv.js';
import { REASONS, LIVE, today, ping, impactOf, endDueTerminations, settlementOf, returnableOf, refundableOf, settleRefundRow, concede, stale } from '../sponsor-termination.js';

const date = z.string().date();
const rev = z.coerce.number().int().positive().describe('the revision you reviewed; a stale one is rejected with 409 and changes nothing');

const hidden = (ctx) => ctx.role === 'recipient' && ['pending', 'rejected'].includes(ctx.d.budget_approval);
/** Which side the caller speaks for. Platform admins read (and may resolve a dispute) but never bind either side. */
function sideOf(ctx, need, what) {
  if (ctx.role === 'sponsor') { ctx.need(need, what); return 'sponsor'; }
  if (ctx.role === 'recipient') {
    if (ORG_TARGETS.includes(ctx.d.target_type) && !ctx.beneficiary?.representative) throw forbidden('Only an owner or admin of the organisation can do this');
    return 'recipient';
  }
  throw forbidden('Only the sponsor or the recipient can do this');
}
const may = (ctx, a) => (ctx.role === 'recipient' ? !ORG_TARGETS.includes(ctx.d.target_type) || !!ctx.beneficiary?.representative : ctx.role === 'sponsor' ? actionsFor(ctx.staff).includes(a) : false);

const SUMMARY = `t.id, t.sponsorship_id, t.given_side, t.reason_code, t.reason, t.notice_on::text AS notice_on, t.effective_on::text AS effective_on, t.base_version, t.rev, t.status,
  t.agreed_at, t.dispute_note, t.disputed_at, t.dispute_resolved_at, t.dispute_case_id, t.ended_at, t.settled_at, t.settlement, t.created_at, t.updated_at,
  g.display_name AS given_by_name, d.display_name AS disputed_by_name, (t.disputed_by IS NOT NULL AND t.disputed_by = ANY($2::uuid[])) AS disputed_by_me`;
const FROM = 'FROM sponsorship_terminations t JOIN users g ON g.id=t.given_by LEFT JOIN users d ON d.id=t.disputed_by';

/** Everything the termination screen needs, in one read, scoped to the caller's side. */
async function detail(c, ctx, user) {
  const { d, role } = ctx;
  const all = (await c.query(`SELECT ${SUMMARY} ${FROM} WHERE t.sponsorship_id=$1 ORDER BY t.created_at DESC, t.id DESC LIMIT 20`, [d.id, [user.id]])).rows;
  const t = all.find((x) => x.status !== 'withdrawn') ?? null; // the live notice, or the settled one once it is final
  const side = role === 'sponsor' || role === 'recipient';
  const live = !!t && LIVE.includes(t.status);
  const out = { role, deal_status: d.status, termination: t ? { ...t, mine: t.given_side === role } : null, history: all.filter((x) => x !== t).map((x) => ({ ...x, mine: x.given_side === role })) };
  const openDispute = !!t?.disputed_at && !t.dispute_resolved_at;
  out.can = {
    give: d.status === 'active' && !!d.accepted_version && !t && side && may(ctx, 'end'),
    accept: t?.status === 'notice' && side && t.given_side !== role && may(ctx, 'end'),
    withdraw: t?.status === 'notice' && side && t.given_side === role && may(ctx, 'end'),
    dispute: live && side && !openDispute && may(ctx, 'end'),
    resolve_dispute: openDispute && (role === 'admin' || (side && t.disputed_by_me)),
    return: live && role === 'sponsor' && may(ctx, 'pay'),
    answer_return: live && role === 'recipient' && may(ctx, 'pay'),
    refund: live && role === 'sponsor' && may(ctx, 'pay'),
    answer_refund: live && role === 'recipient' && may(ctx, 'pay'),
    finalise: t?.status === 'ended' && side && may(ctx, 'end'),
    export: side && (role === 'recipient' || actionsFor(ctx.staff).includes('export')),
  };
  if (!t) {
    if (d.status === 'active' && d.accepted_version) out.preview = await impactOf(c, d, await today(c));
    return out;
  }
  out.returns = (await c.query(
    `SELECT r.id, r.delivery_id, r.quantity, r.status, r.note, r.decision_note, r.created_at, l.label FROM sponsorship_returns r JOIN sponsorship_deliveries x ON x.id=r.delivery_id
       JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id WHERE r.termination_id=$1 ORDER BY r.created_at, r.id`, [t.id])).rows;
  out.refunds = (await c.query(
    `SELECT r.id, r.sponsorship_payment_id, r.amount_cents, r.currency, r.status, r.note, r.decision_note, r.created_at, r.refunded_at, x.method, x.paid_on::text AS paid_on, l.label
       FROM sponsorship_refunds r JOIN sponsorship_payments x ON x.id=r.sponsorship_payment_id JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id
      WHERE r.termination_id=$1 ORDER BY r.created_at, r.id`, [t.id])).rows;
  out.returnable = (await returnableOf(c, d)).filter((x) => x.returnable_quantity > 0);
  out.refundable = (await refundableOf(c, d)).filter((x) => x.refundable_cents > 0);
  out.settlement = t.settlement ?? await settlementOf(c, d, t);
  return out;
}

/** The deal, its termination and the caller's side, with the row locked and any notice that has run out already applied. */
async function lockedTermination(c, terminationId, user) {
  const t0 = (await c.query('SELECT sponsorship_id FROM sponsorship_terminations WHERE id=$1', [terminationId])).rows[0];
  if (!t0) throw notFound('Termination');
  const ctx = await dealContext(c, t0.sponsorship_id, user, { lock: true }); // the agreement first, then the termination (lock order)
  if (hidden(ctx)) throw notFound('Termination');
  const t = (await c.query('SELECT *, notice_on::text AS notice_on, effective_on::text AS effective_on FROM sponsorship_terminations WHERE id=$1 FOR UPDATE', [terminationId])).rows[0];
  return { ctx, t };
}
const bump = (c, tid) => c.query('UPDATE sponsorship_terminations SET rev=rev+1, updated_at=now() WHERE id=$1', [tid]);
const forSponsorship = async (terminationId) => (await one('SELECT sponsorship_id FROM sponsorship_terminations WHERE id=$1', [terminationId]))?.sponsorship_id;
const settleDue = (sid) => (sid ? endDueTerminations({ sponsorshipId: sid }) : null);

cap({
  name: 'get_sponsorship_termination', method: 'GET', path: '/sponsorships/:id/termination', tag: 'Sponsors',
  summary: 'The termination of an agreement as one side sees it: the notice (reason, notice and effective dates, status, dispute), what is kept and what stops, returns of goods, refunds of confirmed payments, what can still be returned or refunded, the live final settlement with every unresolved item, earlier notices, and what this caller may do. Before any notice it returns the impact preview. Participants only; another tenant gets 403. A notice whose effective date has passed is applied first.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await dealContext(pool, i.id, user); // authorise before anything is applied
    await settleDue(i.id);
    const ctx = await dealContext(pool, i.id, user);
    if (hidden(ctx)) throw notFound('Sponsorship');
    return detail(pool, ctx, user);
  },
});

cap({
  name: 'give_sponsorship_termination', method: 'POST', path: '/sponsorships/:id/termination', tag: 'Sponsors', status: 201,
  summary: 'Either side gives notice to end an ACTIVE, accepted agreement, with a reason and an effective date (today or later). The agreement keeps running until that date. When it ends only future dues that nothing has happened to are stopped: anything already due, part-paid, dispatched, submitted or fulfilled is kept, and delivered value is never removed. The brand needs the right to end agreements (manager or approver); an organisation recipient must be its owner or admin. One notice can be live at a time.',
  input: z.object({ id, reason_code: z.enum(REASONS), reason: z.string().max(500).optional(), effective_on: date, expected_version: z.coerce.number().int().positive().describe('the accepted terms version you are ending; a stale one is rejected') }),
  async handler({ user }, i) {
    await settleDue(i.id);
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (hidden(ctx)) throw notFound('Sponsorship');
      const side = sideOf(ctx, 'end', 'end agreements');
      const { d } = ctx;
      if (d.status !== 'active' || !d.accepted_version) throw conflict(`Only an active, accepted agreement can be ended (this one is ${d.status})`);
      if (i.expected_version !== d.accepted_version) throw stale(`This agreement is now at version ${d.accepted_version}; review it again before ending it`);
      if (i.effective_on < await today(c)) throw badRequest('The effective date cannot be in the past: dues that are already due are never rewritten');
      if (i.reason_code === 'other' && !i.reason) throw badRequest('Say why the agreement is ending');
      if ((await c.query("SELECT 1 FROM sponsorship_terminations WHERE sponsorship_id=$1 AND status IN ('notice','agreed','ended')", [d.id])).rowCount) throw conflict('A termination is already in progress on this agreement');
      const t = (await c.query(
        `INSERT INTO sponsorship_terminations(sponsorship_id, given_side, given_by, reason_code, reason, notice_on, effective_on, base_version) VALUES ($1,$2,$3,$4,$5,current_date,$6,$7) RETURNING *`,
        [d.id, side, user.id, i.reason_code, i.reason ?? null, i.effective_on, d.accepted_version])).rows[0];
      await logHistory(c, d.id, d.accepted_version, user.id, 'termination_notice', `${i.reason_code.replace(/_/g, ' ')}${i.reason ? `: ${i.reason}` : ''} (effective ${i.effective_on})`);
      await audit(c, user.id, 'sponsorship.termination_notice', 'sponsorship', d.id);
      await ping(c, side === 'sponsor' ? ctx.recipientId : 'sponsor', 'Notice to end a sponsorship agreement', ctx);
      return { id: t.id };
    }).then(async (r) => { await endDueTerminations({ sponsorshipId: i.id }); const ctx = await dealContext(pool, i.id, user); return { ...r, ...(await detail(pool, ctx, user)) }; });
  },
});

cap({
  name: 'answer_sponsorship_termination', method: 'POST', path: '/sponsorship-terminations/:id/answer', tag: 'Sponsors',
  summary: 'Answer a termination. The OTHER side accepts the termination terms (needs the exact `rev`; a stale one fails with 409 and changes nothing). The side that gave notice can withdraw it before the other side accepts and before it takes effect. Either side can dispute (a note is required; optionally link the support case, which must already reference this agreement) and the disputing side, or a platform admin, resolves the dispute. An open dispute blocks the final settlement. Nothing is deleted.',
  input: z.object({ id, action: z.enum(['accept', 'withdraw', 'dispute', 'resolve_dispute']), rev, note: z.string().max(500).optional(), case_id: id.optional() }),
  async handler({ user }, i) {
    await settleDue(await forSponsorship(i.id));
    return tx(async (c) => {
      const { ctx, t } = await lockedTermination(c, i.id, user);
      if (i.rev !== t.rev) throw stale(`This termination changed (now revision ${t.rev}); review it again before answering`);
      const side = ctx.role === 'admin' && i.action === 'resolve_dispute' ? 'admin' : sideOf(ctx, 'end', 'answer a termination');
      const act = i.action;
      if (act === 'accept') {
        if (t.status !== 'notice') throw conflict(`This termination is already ${t.status}`);
        if (t.given_side === side) throw forbidden('You cannot accept your own notice; the other side does');
        await c.query("UPDATE sponsorship_terminations SET status='agreed', agreed_by=$2, agreed_at=now() WHERE id=$1", [t.id, user.id]);
      } else if (act === 'withdraw') {
        if (t.status !== 'notice') throw conflict(t.status === 'agreed' ? 'The other side already accepted this; it can no longer be withdrawn' : `This termination is already ${t.status}`);
        if (t.given_side !== side) throw forbidden('Only the side that gave notice can withdraw it');
        await c.query("UPDATE sponsorship_terminations SET status='withdrawn' WHERE id=$1", [t.id]);
      } else if (act === 'dispute') {
        if (!['notice', 'agreed', 'ended'].includes(t.status)) throw conflict(`This termination is already ${t.status}`);
        if (t.disputed_at && !t.dispute_resolved_at) throw conflict('A dispute is already open on this termination');
        if (!i.note) throw badRequest('Say what you dispute');
        if (i.case_id) {
          const link = await c.query("SELECT 1 FROM case_links WHERE case_id=$1 AND entity_type='sponsorship' AND entity_id=$2", [i.case_id, ctx.d.id]);
          if (!link.rowCount) throw badRequest('That support case does not reference this agreement');
        }
        await c.query('UPDATE sponsorship_terminations SET dispute_note=$2, disputed_by=$3, disputed_at=now(), dispute_resolved_at=NULL, dispute_resolved_by=NULL, dispute_case_id=$4 WHERE id=$1', [t.id, i.note, user.id, i.case_id ?? null]);
      } else {
        if (!t.disputed_at || t.dispute_resolved_at) throw conflict('There is no open dispute');
        if (side !== 'admin' && t.disputed_by !== user.id) throw forbidden('Only the person who disputed it, or a platform admin, can resolve the dispute');
        await c.query('UPDATE sponsorship_terminations SET dispute_resolved_by=$2, dispute_resolved_at=now() WHERE id=$1', [t.id, user.id]);
      }
      await bump(c, t.id);
      await logHistory(c, ctx.d.id, t.base_version, user.id, `termination_${{ accept: 'agreed', withdraw: 'withdrawn', dispute: 'disputed', resolve_dispute: 'dispute_resolved' }[act]}`, i.note);
      await audit(c, user.id, `sponsorship.termination_${act}`, 'sponsorship', ctx.d.id);
      if (side !== 'admin') await ping(c, side === 'sponsor' ? ctx.recipientId : 'sponsor', `A termination notice was answered: ${act.replace('_', ' ')}`, ctx);
      return { ok: true };
    }).then(async (r) => { const sid = await forSponsorship(i.id); const ctx = await dealContext(pool, sid, user); return { ...r, ...(await detail(pool, ctx, user)) }; });
  },
});

cap({
  name: 'request_sponsorship_return', method: 'POST', path: '/sponsorship-terminations/:id/returns', tag: 'Sponsors', status: 201,
  summary: 'The sponsor asks for goods to be sent back after notice is given. The quantity is checked under a lock against the goods the recipient actually CONFIRMED as received for that delivery, less every return of it that was not declined, so it can never exceed what was received. The recipient accepts or declines; the sponsor confirms when the goods arrive.',
  input: z.object({ id, delivery_id: id, quantity: z.coerce.number().int().positive(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    await settleDue(await forSponsorship(i.id));
    return tx(async (c) => {
      const { ctx, t } = await lockedTermination(c, i.id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor asks for goods back');
      ctx.need('pay', 'ask for goods to be returned');
      if (!LIVE.includes(t.status)) throw conflict(`This termination is ${t.status}`);
      const x = (await c.query('SELECT x.* FROM sponsorship_deliveries x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE x.id=$1 AND o.sponsorship_id=$2 FOR UPDATE OF x', [i.delivery_id, ctx.d.id])).rows[0];
      if (!x) throw notFound('Delivery');
      if (x.status !== 'received') throw conflict('Only goods the recipient confirmed as received can be returned');
      const sent = Number((await c.query("SELECT coalesce(sum(quantity),0) AS n FROM sponsorship_returns WHERE delivery_id=$1 AND status <> 'declined'", [x.id])).rows[0].n);
      const left = x.received_quantity - sent;
      if (i.quantity > left) throw conflict(left > 0 ? `Only ${left} of the ${x.received_quantity} received can still be returned` : 'Everything received has already been asked back', { code: 'return_exceeds_received', returnable: Math.max(0, left) });
      const r = (await c.query('INSERT INTO sponsorship_returns(termination_id, delivery_id, quantity, requested_side, requested_by, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [t.id, x.id, i.quantity, 'sponsor', user.id, i.note ?? null])).rows[0];
      await bump(c, t.id);
      await logHistory(c, ctx.d.id, t.base_version, user.id, 'return_requested', `${i.quantity} of ${x.received_quantity} received`);
      await ping(c, ctx.recipientId, 'Goods return requested', ctx);
      return r;
    });
  },
});

cap({
  name: 'decide_sponsorship_return', method: 'PATCH', path: '/sponsorship-returns/:id', tag: 'Sponsors',
  summary: 'The recipient accepts or declines a return (declining needs a reason). Once accepted, the sponsor confirms the goods arrived (`received`); only that confirmation counts them as returned. Each step is allowed once, in order.',
  input: z.object({ id, status: z.enum(['accepted', 'declined', 'received']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const r0 = await one('SELECT termination_id FROM sponsorship_returns WHERE id=$1', [i.id]);
    if (!r0) throw notFound('Return');
    await settleDue(await forSponsorship(r0.termination_id));
    return tx(async (c) => {
      const { ctx, t } = await lockedTermination(c, r0.termination_id, user);
      const r = (await c.query('SELECT * FROM sponsorship_returns WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (i.status === 'received') {
        if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor confirms goods arrived');
        ctx.need('pay', 'confirm returned goods');
        if (r.status !== 'accepted') throw conflict(`This return is ${r.status}; it can be confirmed only once the recipient accepted it`);
      } else {
        sideOf(ctx, 'pay', 'answer a return');
        if (ctx.role !== 'recipient') throw forbidden('Only the recipient accepts or declines a return');
        if (r.status !== 'requested') throw conflict(`This return is already ${r.status}`);
        if (i.status === 'declined' && !i.note) throw badRequest('Give a reason');
      }
      if (!LIVE.includes(t.status)) throw conflict(`This termination is ${t.status}`);
      const row = (await c.query('UPDATE sponsorship_returns SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1 RETURNING *', [r.id, i.status, user.id, i.note ?? null])).rows[0];
      await bump(c, t.id);
      await logHistory(c, ctx.d.id, t.base_version, user.id, `return_${i.status}`, i.note);
      await ping(c, ctx.role === 'sponsor' ? ctx.recipientId : 'sponsor', `A goods return was ${i.status}`, ctx);
      return row;
    });
  },
});

cap({
  name: 'request_sponsorship_refund', method: 'POST', path: '/sponsorship-terminations/:id/refunds', tag: 'Sponsors', status: 201,
  summary: 'The sponsor asks for money back against ONE confirmed sponsorship payment of this agreement (the canonical payment; for online money this is the provider payment behind it). The amount is in that payment\'s own currency and cannot exceed what was paid, less what was already refunded and what other open refund requests already claim. Nothing is refunded until the recipient approves it and the money actually moves.',
  input: z.object({ id, sponsorship_payment_id: id, amount_cents: z.coerce.number().int().positive(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    await settleDue(await forSponsorship(i.id));
    return tx(async (c) => {
      const { ctx, t } = await lockedTermination(c, i.id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor asks for money back');
      ctx.need('pay', 'ask for a refund');
      if (!LIVE.includes(t.status)) throw conflict(`This termination is ${t.status}`);
      const p = (await c.query('SELECT x.* FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE x.id=$1 AND o.sponsorship_id=$2 FOR UPDATE OF x', [i.sponsorship_payment_id, ctx.d.id])).rows[0];
      if (!p) throw notFound('Payment');
      if (p.status !== 'confirmed') throw conflict('Only a payment the recipient confirmed (or the provider verified) can be refunded');
      const open = Number((await c.query("SELECT coalesce(sum(amount_cents),0) AS n FROM sponsorship_refunds WHERE sponsorship_payment_id=$1 AND status IN ('requested','approved')", [p.id])).rows[0].n);
      const left = Number(p.amount_cents) - Number(p.refunded_cents) - open;
      if (i.amount_cents > left) throw conflict(left > 0 ? `At most ${left} can still be refunded on this payment` : 'This payment is already fully refunded or claimed by an open refund', { code: 'refund_exceeds_payment', refundable_cents: Math.max(0, left) });
      const r = (await c.query('INSERT INTO sponsorship_refunds(termination_id, sponsorship_payment_id, amount_cents, currency, requested_side, requested_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [t.id, p.id, i.amount_cents, p.currency, 'sponsor', user.id, i.note ?? null])).rows[0];
      await bump(c, t.id);
      await logHistory(c, ctx.d.id, t.base_version, user.id, 'refund_requested', `${i.amount_cents} ${p.currency}`);
      await ping(c, ctx.recipientId, 'A refund was requested', ctx);
      return r;
    });
  },
});

/** The provider refund of an approved online payment. Idempotent per refund, so a retry can never give the money back twice. */
async function payBackOnline(c0, refundId, actorId) {
  const r = await one('SELECT r.*, x.payment_id FROM sponsorship_refunds r JOIN sponsorship_payments x ON x.id=r.sponsorship_payment_id WHERE r.id=$1', [refundId]);
  if (r.status !== 'approved') return { done: r.status === 'refunded' };
  const pay = await one('SELECT * FROM payments WHERE id=$1', [r.payment_id]);
  if (!pay || pay.status !== 'paid') return { done: false, error: 'The online payment cannot be refunded in its current state' };
  try { await refundPartial(pay, Number(r.amount_cents), `sponsorship-refund-${r.id}`); } catch (e) { return { done: false, error: e.message }; }
  await tx(async (c) => {
    const row = (await c.query("UPDATE sponsorship_refunds SET status='refunded', refunded_at=now() WHERE id=$1 AND status='approved' RETURNING *", [r.id])).rows[0];
    if (row) await logHistory(c, (await c.query('SELECT o.sponsorship_id FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE x.id=$1', [r.sponsorship_payment_id])).rows[0].sponsorship_id, null, actorId, 'refund_paid_back', `${r.amount_cents} ${r.currency}`);
  });
  return { done: true };
}

cap({
  name: 'decide_sponsorship_refund', method: 'PATCH', path: '/sponsorship-refunds/:id', tag: 'Sponsors',
  summary: 'The recipient approves or declines a refund (declining needs a reason). Approving concedes that amount of the due, so the refund never re-opens it as a debt, and for ONLINE money the refund is then made at the payment provider (idempotent; if the provider refuses it stays approved and can be retried with status `refunded`). For bank / cash money the sponsor confirms (`refunded`) once the money is actually back; only that confirmation records it. A payment is never marked refunded from an unverified claim.',
  input: z.object({ id, status: z.enum(['approved', 'declined', 'refunded']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const r0 = await one('SELECT termination_id FROM sponsorship_refunds WHERE id=$1', [i.id]);
    if (!r0) throw notFound('Refund');
    await settleDue(await forSponsorship(r0.termination_id));
    let online = false;
    const out = await tx(async (c) => {
      const { ctx, t } = await lockedTermination(c, r0.termination_id, user);
      const r = (await c.query('SELECT * FROM sponsorship_refunds WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const p = (await c.query('SELECT * FROM sponsorship_payments WHERE id=$1 FOR UPDATE', [r.sponsorship_payment_id])).rows[0];
      if (!LIVE.includes(t.status)) throw conflict(`This termination is ${t.status}`);
      online = p.method === 'online';
      if (i.status === 'refunded') {
        if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor confirms that the money is back');
        ctx.need('pay', 'confirm a refund');
        if (r.status !== 'approved') throw conflict(`This refund is ${r.status}; it can be confirmed only once the recipient approved it`);
        if (!online) await settleRefundRow(c, r, p, user.id);
      } else {
        sideOf(ctx, 'pay', 'answer a refund');
        if (ctx.role !== 'recipient') throw forbidden('Only the recipient approves or declines a refund');
        if (r.status !== 'requested') throw conflict(`This refund is already ${r.status}`);
        if (i.status === 'declined' && !i.note) throw badRequest('Give a reason');
        if (i.status === 'approved') {
          if (Number(p.amount_cents) - Number(p.refunded_cents) < Number(r.amount_cents)) throw conflict('That payment no longer has this much left to refund');
          await concede(c, p.obligation_id, Number(r.amount_cents));
        }
        await c.query('UPDATE sponsorship_refunds SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1', [r.id, i.status, user.id, i.note ?? null]);
      }
      await bump(c, t.id);
      await logHistory(c, ctx.d.id, t.base_version, user.id, `refund_${i.status}`, i.note);
      await audit(c, user.id, `sponsorship.refund_${i.status}`, 'sponsorship', ctx.d.id);
      await ping(c, ctx.role === 'sponsor' ? ctx.recipientId : 'sponsor', `A refund was ${i.status}`, ctx);
      return { id: r.id };
    });
    // online money moves at the provider, outside the transaction (idempotent key), after the approval is safely recorded
    let provider = null;
    if (online && ['approved', 'refunded'].includes(i.status)) {
      const done = await payBackOnline(null, i.id, user.id);
      if (!done.done) provider = { refunded: false, error: done.error ?? 'The provider has not refunded it yet' };
    }
    const row = await one('SELECT * FROM sponsorship_refunds WHERE id=$1', [out.id]);
    return provider ? { ...row, provider } : row;
  },
});

cap({
  name: 'finalise_sponsorship_settlement', method: 'POST', path: '/sponsorship-terminations/:id/settlement', tag: 'Sponsors',
  summary: 'Finalise the settlement of an ENDED agreement. Blocked while anything is unresolved and blocking: an unverified payment, goods in transit, evidence awaiting review, an open return or refund, or an open dispute (409 with the list). Dues that are still owed do not block but must be acknowledged (`carry_forward`); they stay on record as owed and are never erased. The settlement is frozen as a snapshot, per currency, with every carried-forward item.',
  input: z.object({ id, rev, carry_forward: z.boolean().optional().describe('acknowledge dues that remain owed after settlement; they are recorded, not cancelled') }),
  async handler({ user }, i) {
    await settleDue(await forSponsorship(i.id));
    return tx(async (c) => {
      const { ctx, t } = await lockedTermination(c, i.id, user);
      sideOf(ctx, 'end', 'finalise a settlement');
      if (i.rev !== t.rev) throw stale(`This termination changed (now revision ${t.rev}); review the settlement again`);
      if (t.status !== 'ended') throw conflict(t.status === 'settled' ? 'This settlement is already final' : 'The agreement has not ended yet; it can be settled once the effective date has passed');
      const s = await settlementOf(c, ctx.d, t);
      if (s.blocking) throw conflict(`${s.blocking} item${s.blocking === 1 ? ' is' : 's are'} still unresolved`, { code: 'unresolved_items', items: s.items.filter((x) => x.blocking) });
      if (s.carried && !i.carry_forward) throw conflict(`${s.carried} due${s.carried === 1 ? ' is' : 's are'} still owed; acknowledge that they stay on record`, { code: 'dues_owed', items: s.items.filter((x) => !x.blocking) });
      const frozen = { ...s, status: 'settled', settled_on: await today(c), carried_forward: s.items.filter((x) => !x.blocking) };
      await c.query("UPDATE sponsorship_terminations SET status='settled', settled_by=$2, settled_at=now(), settlement=$3::jsonb, rev=rev+1, updated_at=now() WHERE id=$1", [t.id, user.id, JSON.stringify(frozen)]);
      await logHistory(c, ctx.d.id, t.base_version, user.id, 'settlement_final', s.carried ? `${s.carried} due(s) carried forward` : null);
      await audit(c, user.id, 'sponsorship.settlement_final', 'sponsorship', ctx.d.id);
      await ping(c, ctx.role === 'sponsor' ? ctx.recipientId : 'sponsor', 'The final settlement was recorded', ctx);
      return frozen;
    });
  },
});

cap({
  name: 'export_sponsorship_settlement', method: 'GET', path: '/sponsorships/:id/termination/export', tag: 'Sponsors',
  summary: 'CSV of the final settlement: per currency the committed, received, refunded, conceded and still-owed amounts, and every unresolved item (blocking or carried). Same participants as the reads; a brand needs the export right (manager, finance or auditor). No payee, contact or private note is exported.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await dealContext(pool, i.id, user);
    await settleDue(i.id);
    const ctx = await dealContext(pool, i.id, user);
    if (hidden(ctx)) throw notFound('Sponsorship');
    if (ctx.role === 'sponsor') ctx.need('export', 'export the settlement');
    if (ctx.role === 'recipient' && ORG_TARGETS.includes(ctx.d.target_type) && !ctx.beneficiary?.representative) throw forbidden('Only an owner or admin of the organisation can export this');
    const t = (await many("SELECT *, notice_on::text AS notice_on, effective_on::text AS effective_on FROM sponsorship_terminations WHERE sponsorship_id=$1 AND status IN ('notice','agreed','ended','settled') ORDER BY created_at DESC, id DESC LIMIT 1", [ctx.d.id]))[0];
    if (!t) throw notFound('Termination');
    const s = t.settlement ?? await settlementOf(pool, ctx.d, t);
    const rows = [
      ...s.currencies.map((x) => ({ section: 'currency', currency: x.currency, item: 'summary', status: t.status, committed: x.committed_cents, received: x.received_cents, refunded: x.refunded_cents, conceded: x.conceded_cents, still_owed: x.still_owed_cents, detail: '' })),
      ...s.items.map((x) => ({ section: 'unresolved', currency: x.currency ?? '', item: x.kind, status: x.blocking ? 'blocking' : 'carried forward', committed: '', received: '', refunded: '', conceded: '', still_owed: x.amount_cents ?? x.quantity ?? '', detail: x.label })),
    ];
    const cols = ['section', 'currency', 'item', 'status', 'committed', 'received', 'refunded', 'conceded', 'still_owed', 'detail'];
    return { filename: `settlement-${ctx.d.agreement_ref ?? ctx.d.id}.csv`, rows: rows.length, csv: toCsv(cols, rows) };
  },
});
