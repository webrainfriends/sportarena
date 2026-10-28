// Team & delegation travel operations (#485), part 6: per diem and travel expenses on top of the canonical event budget ledger.
// Entitlement, claim, payment and balance are separate states (see src/trips-finance.js). This is not payroll: nothing here pays a salary or a fee.
import { z } from 'zod';
import { cap, id, money } from '../registry.js';
import { pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { eventForOrganizer } from './events.js';
import { LIVE_PARTICIPANT, assertOpen, canApproveTrip, record, tripCtx } from '../trips.js';
import { entitlementFor, livePolicy, statements } from '../trips-finance.js';

const TAG = 'Team travel';
const cur = z.string().regex(/^[A-Z]{3}$/);
const key = z.string().min(8).max(80);

cap({
  name: 'set_trip_perdiem_policy', method: 'POST', path: '/trips/:id/perdiem', tag: TAG, status: 201,
  summary: 'Trip manager: propose the per-diem policy (daily amount, currency, which trip roles it covers; no roles = every confirmed traveller). It pays nobody and is not payable until the team owner or organisation admin approves it. A new proposal supersedes the old one (kept in the history) and is refused once per-diem money has been recorded against the old one.',
  input: z.object({ id, currency: cur, daily_minor: money.refine((n) => n > 0, 'must be above 0'), roles: z.array(z.enum(['athlete', 'coach', 'staff', 'official', 'medical', 'manager', 'chaperone', 'guest', 'guardian'])).max(9).default([]) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can propose a per-diem policy');
      assertOpen(ctx.trip);
      if ((await c.query("SELECT 1 FROM trip_payments WHERE trip_id=$1 AND kind='per_diem' AND voided_at IS NULL", [ctx.trip.id])).rowCount) throw conflict('Per-diem money has already been recorded. Void those payments before changing the policy.');
      await c.query('UPDATE trip_perdiem_policies SET superseded_at=now() WHERE trip_id=$1 AND superseded_at IS NULL', [ctx.trip.id]);
      const p = (await c.query('INSERT INTO trip_perdiem_policies(trip_id, currency, daily_minor, roles, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ctx.trip.id, i.currency, i.daily_minor, i.roles, user.id])).rows[0];
      await record(c, ctx.trip, user.id, { entity: 'money', entityId: p.id, action: 'perdiem_proposed', snapshot: { currency: p.currency, daily_minor: Number(p.daily_minor), roles: p.roles } });
      return p;
    });
  },
});

cap({
  name: 'approve_trip_perdiem_policy', method: 'POST', path: '/trips/:id/perdiem/approve', tag: TAG,
  summary: 'Team owner / organisation admin: approve the current per-diem policy so entitlements become payable. Travellers covered by it are told their daily allowance.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!(await canApproveTrip(user, ctx.trip, c))) throw forbidden('Only the team owner or organisation admin can approve a per-diem policy');
      assertOpen(ctx.trip);
      const p = await livePolicy(c, ctx.trip.id);
      if (!p) throw notFound('Per-diem policy');
      if (p.approved_at) return p;
      const row = (await c.query('UPDATE trip_perdiem_policies SET approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *', [p.id, user.id])).rows[0];
      const who = (await c.query("SELECT user_id, role FROM trip_participants WHERE trip_id=$1 AND status='confirmed'", [ctx.trip.id])).rows.filter((r) => !row.roles.length || row.roles.includes(r.role)).map((r) => r.user_id);
      await record(c, ctx.trip, user.id, { entity: 'money', entityId: row.id, action: 'perdiem_approved', snapshot: { currency: row.currency, daily_minor: Number(row.daily_minor) }, affected: who, title: 'Daily allowance approved', body: `${ctx.trip.name}: ${(Number(row.daily_minor) / 100).toFixed(2)} ${row.currency} a day.` });
      return row;
    });
  },
});

/** Optional link to the canonical event budget ledger: only for an event this trip is linked to, and only if the caller organises it. */
async function ledger(c, user, trip, lineId, amount, ref, note) {
  if (!lineId) return { source: 'external_record', budget_payment_id: null };
  const l = (await c.query('SELECT * FROM event_budget_lines WHERE id=$1', [lineId])).rows[0];
  if (!l) throw notFound('Budget line');
  if (!(await c.query('SELECT 1 FROM trip_events WHERE trip_id=$1 AND event_id=$2 AND unlinked_at IS NULL', [trip.id, l.event_id])).rowCount) throw badRequest('That budget line belongs to an event this trip is not linked to');
  await eventForOrganizer(user, l.event_id, c);
  if (l.direction !== 'expense' || ['closed', 'void'].includes(l.status)) throw conflict('That budget line cannot take a payment');
  const bp = (await c.query("INSERT INTO event_budget_payments(event_id, line_id, amount_cents, method, reference, note, recorded_by) VALUES ($1,$2,$3,'other',$4,$5,$6) RETURNING id", [l.event_id, l.id, amount, ref ?? null, note, user.id])).rows[0];
  return { source: 'event_budget', budget_payment_id: bp.id };
}

cap({
  name: 'record_trip_payment', method: 'POST', path: '/trips/:id/payments', tag: TAG, status: 201, scope: 'payment',
  summary: 'Trip manager: record money actually paid to a traveller: an advance, or their per diem (approved policy only, never more than the entitlement). Give a budget_line_id to also post it to the canonical event budget ledger (event organiser); otherwise it is kept as an external record. Recording is not entitlement and not a claim. The same idempotency_key never records twice.',
  input: z.object({ id, participant_id: id, kind: z.enum(['advance', 'per_diem']), amount_minor: money.refine((n) => n > 0, 'must be above 0'), currency: cur, reference: z.string().trim().max(80).optional(), budget_line_id: id.optional(), idempotency_key: key }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can record payments');
      assertOpen(ctx.trip);
      const dup = (await c.query('SELECT * FROM trip_payments WHERE trip_id=$1 AND idempotency_key=$2', [ctx.trip.id, i.idempotency_key])).rows[0];
      if (dup) return dup;
      const p = (await c.query('SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status=\'confirmed\'', [i.participant_id, ctx.trip.id])).rows[0];
      if (!p) throw notFound('Traveller');
      if (i.kind === 'per_diem') {
        const pol = await livePolicy(c, ctx.trip.id), ent = entitlementFor(ctx.trip, pol, p);
        if (!ent) throw conflict('This traveller has no per-diem entitlement on this trip');
        if (!ent.approved) throw conflict('The per-diem policy is not approved yet, so nothing is payable');
        if (ent.currency !== i.currency) throw badRequest(`Per diem is paid in ${ent.currency}`);
        const paid = Number((await c.query("SELECT coalesce(sum(amount_minor),0) AS n FROM trip_payments WHERE participant_id=$1 AND kind='per_diem' AND voided_at IS NULL", [p.id])).rows[0].n);
        if (paid + i.amount_minor > ent.amount_minor) throw conflict(`That would pay more than the entitlement (${(ent.amount_minor / 100).toFixed(2)} ${ent.currency}, ${(paid / 100).toFixed(2)} already paid)`);
      }
      const l = await ledger(c, user, ctx.trip, i.budget_line_id, i.amount_minor, i.reference, `Trip ${ctx.trip.name}: ${i.kind.replace('_', ' ')}`);
      const row = (await c.query('INSERT INTO trip_payments(trip_id, participant_id, kind, amount_minor, currency, reference, source, budget_payment_id, idempotency_key, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [ctx.trip.id, p.id, i.kind, i.amount_minor, i.currency, i.reference ?? null, l.source, l.budget_payment_id, i.idempotency_key, user.id])).rows[0];
      await audit(c, user.id, `record_trip_${i.kind}`, 'trip_payments', row.id);
      await record(c, ctx.trip, user.id, { entity: 'money', entityId: row.id, action: `payment_${i.kind}`, snapshot: { amount_minor: i.amount_minor, currency: i.currency, source: l.source }, affected: [p.user_id], title: i.kind === 'advance' ? 'An advance was recorded' : 'Per diem was paid', body: `${ctx.trip.name}: ${(i.amount_minor / 100).toFixed(2)} ${i.currency}` });
      return row;
    });
  },
});

cap({
  name: 'void_trip_payment', method: 'POST', path: '/trips/:id/payments/:payment_id/void', tag: TAG, scope: 'payment',
  summary: 'Trip manager: cancel a payment recorded in error. It stays in the history; a payment posted to the event budget ledger is voided there too.',
  input: z.object({ id, payment_id: id, reason: z.string().trim().min(2).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can void payments');
      const p = (await c.query('UPDATE trip_payments SET voided_at=now(), voided_by=$3 WHERE id=$1 AND trip_id=$2 AND voided_at IS NULL RETURNING *', [i.payment_id, ctx.trip.id, user.id])).rows[0];
      if (!p) throw notFound('Payment');
      if (p.budget_payment_id) await c.query('UPDATE event_budget_payments SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1 AND voided_at IS NULL', [p.budget_payment_id, user.id, i.reason]);
      await audit(c, user.id, 'void_trip_payment', 'trip_payments', p.id);
      await record(c, ctx.trip, user.id, { entity: 'money', entityId: p.id, action: 'payment_voided', note: i.reason, snapshot: { kind: p.kind, amount_minor: Number(p.amount_minor) } });
      return { ok: true };
    });
  },
});

cap({
  name: 'submit_trip_claim', method: 'POST', path: '/trips/:id/claims', tag: TAG, status: 201,
  summary: 'A traveller (or a young traveller\'s verified guardian) submits a travel expense with a receipt reference (stored encrypted). It is only a claim: approval and reimbursement are separate steps. The same idempotency_key never submits twice.',
  input: z.object({ id, participant_id: id.optional().describe('defaults to you; a guardian names their ward'), category: z.enum(['meals', 'transport', 'lodging', 'visa_fees', 'baggage', 'other']), description: z.string().trim().min(2).max(300), amount_minor: money.refine((n) => n > 0, 'must be above 0'), currency: cur, incurred_on: z.string().date(), receipt_ref: z.string().trim().min(2).max(200).optional(), idempotency_key: key }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);
      const pid = i.participant_id ?? ctx.mine?.id;
      if (!pid || !(pid === ctx.mine?.id || ctx.wardIds.has(pid))) throw forbidden('You can claim only for yourself, or for a young traveller you are a verified guardian of');
      const p = (await c.query("SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status='confirmed'", [pid, ctx.trip.id])).rows[0];
      if (!p) throw conflict('Only a confirmed traveller can claim expenses');
      const dup = (await c.query('SELECT * FROM trip_claims WHERE participant_id=$1 AND idempotency_key=$2', [p.id, i.idempotency_key])).rows[0];
      if (dup) return claimOut(dup);
      const row = (await c.query('INSERT INTO trip_claims(trip_id, participant_id, category, description, amount_minor, currency, incurred_on, receipt_ref_enc, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [ctx.trip.id, p.id, i.category, i.description, i.amount_minor, i.currency, i.incurred_on, i.receipt_ref ? encrypt(i.receipt_ref, 'trip_claims.receipt_ref') : null, i.idempotency_key, user.id])).rows[0];
      await record(c, ctx.trip, user.id, { entity: 'money', entityId: row.id, action: 'claim_submitted', snapshot: { category: i.category, amount_minor: i.amount_minor, currency: i.currency }, affected: [ctx.trip.manager_id], title: 'An expense claim was submitted', body: ctx.trip.name });
      return claimOut(row);
    });
  },
});
const claimOut = ({ receipt_ref_enc, idempotency_key, ...r }) => ({ ...r, has_receipt: !!receipt_ref_enc });

cap({
  name: 'decide_trip_claim', method: 'POST', path: '/trips/:id/claims/:claim_id/decide', tag: TAG, scope: 'payment',
  summary: 'Trip manager: approve or reject a submitted claim with a note. Approving does not pay it. You cannot decide your own claim; another manager, the team owner or an organisation admin does.',
  input: z.object({ id, claim_id: id, decision: z.enum(['approve', 'reject']), note: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can decide claims');
      assertOpen(ctx.trip);
      const cl = (await c.query('SELECT cl.*, p.user_id FROM trip_claims cl JOIN trip_participants p ON p.id=cl.participant_id WHERE cl.id=$1 AND cl.trip_id=$2 FOR UPDATE OF cl', [i.claim_id, ctx.trip.id])).rows[0];
      if (!cl) throw notFound('Claim');
      if (cl.status !== 'submitted') throw conflict(`This claim is already ${cl.status}`);
      if (cl.user_id === user.id) throw forbidden('You cannot decide your own claim. Another trip manager, the team owner or an organisation admin does.');
      if (i.decision === 'reject' && !i.note) throw badRequest('Say why the claim is rejected');
      const row = (await c.query('UPDATE trip_claims SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1 RETURNING *', [cl.id, i.decision === 'approve' ? 'approved' : 'rejected', user.id, i.note ?? null])).rows[0];
      await record(c, ctx.trip, user.id, { entity: 'money', entityId: row.id, action: `claim_${row.status}`, note: i.note, snapshot: { amount_minor: Number(row.amount_minor), currency: row.currency }, affected: [cl.user_id], title: `Your expense claim was ${row.status}`, body: ctx.trip.name });
      return claimOut(row);
    });
  },
});

cap({
  name: 'reimburse_trip_claim', method: 'POST', path: '/trips/:id/claims/:claim_id/reimburse', tag: TAG, scope: 'payment',
  summary: 'Trip manager: record that an approved claim was actually paid back (one reimbursement per claim, idempotent). Give a budget_line_id to post it to the canonical event budget ledger, otherwise it is an external record.',
  input: z.object({ id, claim_id: id, reference: z.string().trim().max(80).optional(), budget_line_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can record reimbursements');
      const cl = (await c.query('SELECT cl.*, p.user_id FROM trip_claims cl JOIN trip_participants p ON p.id=cl.participant_id WHERE cl.id=$1 AND cl.trip_id=$2 FOR UPDATE OF cl', [i.claim_id, ctx.trip.id])).rows[0];
      if (!cl) throw notFound('Claim');
      const prior = (await c.query('SELECT * FROM trip_payments WHERE claim_id=$1 AND voided_at IS NULL', [cl.id])).rows[0];
      if (prior) return prior;
      if (cl.status !== 'approved') throw conflict('Only an approved claim can be reimbursed');
      const l = await ledger(c, user, ctx.trip, i.budget_line_id, Number(cl.amount_minor), i.reference, `Trip ${ctx.trip.name}: reimbursement`);
      const row = (await c.query("INSERT INTO trip_payments(trip_id, participant_id, kind, claim_id, amount_minor, currency, reference, source, budget_payment_id, recorded_by) VALUES ($1,$2,'reimbursement',$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [ctx.trip.id, cl.participant_id, cl.id, cl.amount_minor, cl.currency, i.reference ?? null, l.source, l.budget_payment_id, user.id])).rows[0];
      await audit(c, user.id, 'reimburse_trip_claim', 'trip_payments', row.id);
      await record(c, ctx.trip, user.id, { entity: 'money', entityId: row.id, action: 'claim_reimbursed', snapshot: { amount_minor: Number(cl.amount_minor), currency: cl.currency, source: l.source }, affected: [cl.user_id], title: 'Your expense claim was paid', body: ctx.trip.name });
      return row;
    });
  },
});

cap({
  name: 'get_trip_finance', method: 'GET', path: '/trips/:id/finance', tag: TAG,
  summary: 'Per-diem policy and, per traveller, the four states side by side: entitlement, claims (submitted / approved / rejected), payments recorded (advance, per diem, reimbursement) and the balance. Trip staff see everyone; a traveller or guardian sees only their own.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const only = ctx.ops ? null : [ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean);
    const s = await statements(pool, ctx.trip, only);
    return { policy: s.policy ? { currency: s.policy.currency, daily_minor: Number(s.policy.daily_minor), roles: s.policy.roles, approved: !!s.policy.approved_at, approved_at: s.policy.approved_at } : null, travellers: s.rows, can_manage: ctx.manager };
  },
});
