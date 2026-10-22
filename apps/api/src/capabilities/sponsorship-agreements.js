// Sponsorship agreement operation (#145): schedule preview, exact-version revision, dues, payments, goods and endorsement fulfilment.
// All of it hangs off the canonical `sponsorships` row (see sponsors.js); nothing here is a second sponsorship system.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { LINE, buildSchedule } from '../sponsor-schedule.js';
import { snapshotIdentity } from '../sponsor-access.js';
import { saveLines, loadLines, generateObligations, logHistory, dealContext, obligationContext } from '../sponsor-agreements.js';
import { notifySponsor, sponsorStaffSql, actionsFor } from '../sponsor-access.js';

const date = z.string().date();
const url = z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), 'evidence must be an https link');
const other = (ctx) => (ctx.role === 'sponsor' ? ctx.recipientId : 'sponsor');
// Notifications never carry amounts, references or terms: those stay behind the participant-scoped reads.
// `to` is a user id, or 'sponsor' for the brand's owner and the staff whose role is concerned (`action`).
const ping = (c, to, title, ctx, kind = 'sponsorship_update', action = 'read') => {
  const msg = { kind, title, body: `Open the ${ctx.sp.name} agreement to see the update.`, data: { sponsorship_id: ctx.d.id } };
  return to === 'sponsor' ? notifySponsor(c, ctx.sp, action, msg, ctx.d.department_id) : notify(c, to, msg);
};

cap({
  name: 'preview_sponsorship_schedule', method: 'POST', path: '/sponsorship-schedule/preview', tag: 'Sponsors',
  summary: 'Review the complete dated schedule a set of contribution lines produces, before proposing or accepting. Month-end dates clamp (31 Jan, 28/29 Feb, 31 Mar), both ends of the period are inclusive, nothing may fall outside the period, and a split total puts the rounding remainder on the last instalment. Cash is totalled per currency; estimates are kept separate and are never cash.',
  input: z.object({ lines: z.array(LINE).min(1).max(12), starts_on: date.optional(), ends_on: date.optional() }),
  handler: async (_, i) => {
    if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
    return buildSchedule(i.lines, { starts_on: i.starts_on, ends_on: i.ends_on });
  },
});

cap({
  name: 'revise_sponsorship', method: 'POST', path: '/sponsorships/:id/revise', tag: 'Sponsors',
  summary: 'Sponsor owner: change the terms of an offer that has not been answered. This creates a new numbered version; the recipient can only accept the current exact version, so an acceptance of an older version is rejected. (Changing an accepted agreement needs a mutually accepted amendment, which is not available yet.)',
  input: z.object({ id, lines: z.array(LINE).min(1).max(12), starts_on: date.optional(), ends_on: date.optional(), timezone: z.string().max(60).optional(), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor can revise its offer');
      ctx.need('revise', 'revise the terms of an offer');
      if (ctx.d.status !== 'proposed') throw conflict('Only an unanswered offer can be revised');
      const starts = i.starts_on ?? ctx.d.starts, ends = i.ends_on ?? ctx.d.ends;
      if (starts && ends && ends < starts) throw badRequest('ends_on is before starts_on');
      const plan = buildSchedule(i.lines, { starts_on: starts, ends_on: ends });
      const cash = Object.entries(plan.committed), v = ctx.d.terms_version + 1;
      await saveLines(c, ctx.d.id, v, i.lines);
      await snapshotIdentity(c, ctx.d.id, v, ctx.sp.id, user.id);
      const row = (await c.query('UPDATE sponsorships SET terms_version=$2, starts_on=$3, ends_on=$4, timezone=coalesce($5,timezone), amount_cents=$6, currency=$7, agreement_ref=coalesce(agreement_ref, \'SPA-\'||upper(substr(id::text,1,8))) WHERE id=$1 RETURNING *',
        [ctx.d.id, v, starts ?? null, ends ?? null, i.timezone ?? null, cash.length === 1 ? cash[0][1] : 0, cash.length === 1 ? cash[0][0] : null])).rows[0];
      await logHistory(c, ctx.d.id, v, user.id, 'revised', i.reason);
      await ping(c, ctx.recipientId, 'A sponsorship offer was revised', ctx);
      return { ...row, schedule: plan };
    });
  },
});

cap({
  name: 'get_sponsorship', method: 'GET', path: '/sponsorships/:id', tag: 'Sponsors',
  summary: 'One agreement, for its sponsor or its recipient (or an admin): the exact terms version, contribution lines, the schedule (a preview until accepted, then the real dues with payments, deliveries and endorsement submissions), and the history. Estimates are labelled as such and never counted as cash.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    const { d, sp } = ctx;
    const version = d.accepted_version ?? d.terms_version;
    const lines = await many('SELECT id, position, kind, label, currency, amount_cents, total_cents, estimate_cents, quantity, unit, cadence, first_due_on, instalments, custom_dates, promoter, terms FROM sponsorship_lines WHERE sponsorship_id=$1 AND version=$2 ORDER BY position', [d.id, version]);
    const out = { id: d.id, agreement_ref: d.agreement_ref, status: d.status, role: ctx.role, my_sponsor_role: ctx.staff, can: ctx.staff ? actionsFor(ctx.staff) : undefined, sponsor: { id: sp.id, name: sp.name }, target_type: d.target_type, target_id: d.target_id, starts_on: d.starts_on, ends_on: d.ends_on, timezone: d.timezone, terms_version: d.terms_version, accepted_version: d.accepted_version, currency: d.currency, legacy_amount_cents: lines.length ? undefined : d.amount_cents, legacy_in_kind: lines.length ? undefined : d.in_kind, objectives: d.objectives, deliverables: d.deliverables, lines };
    if (d.program_id) out.program = await one('SELECT p.id, p.name, r.seq AS round_seq, r.name AS round_name FROM sponsorship_programs p JOIN sponsorship_rounds r ON r.id=$2 WHERE p.id=$1', [d.program_id, d.round_id]);
    // who the sponsor was at this exact version (frozen): later renames or representative changes never alter it. Never registration/tax/billing data.
    out.sponsor_identity = (await pool.query('SELECT s.display_name, s.legal_name, s.sponsor_type, u.display_name AS signed_by FROM sponsorship_identity_snapshots s LEFT JOIN users u ON u.id=s.signed_by WHERE s.sponsorship_id=$1 AND s.version=$2', [d.id, version])).rows[0] ?? null;
    if (!d.accepted_version && lines.length) out.schedule = buildSchedule(await loadLines(pool, d.id, version), { starts_on: d.starts, ends_on: d.ends });
    if (d.accepted_version) {
      out.obligations = await obligationRows('o.sponsorship_id = $1', [d.id]);
      const kids = (t, cols) => many(`SELECT x.obligation_id, ${cols} FROM ${t} x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE o.sponsorship_id=$1 ORDER BY x.created_at, x.id`, [d.id]);
      const [pay, del, sub] = await Promise.all([
        kids('sponsorship_payments', 'x.id, x.amount_cents, x.currency, x.method, x.reference, x.paid_on::text AS paid_on, x.evidence_url, x.status, x.decision_note'),
        kids('sponsorship_deliveries', 'x.id, x.quantity, x.reference, x.note, x.status, x.received_quantity, x.decision_note'),
        kids('sponsorship_submissions', 'x.id, x.evidence_url, x.note, x.status, x.review_note')]);
      for (const o of out.obligations) {
        o.payments = pay.filter((r) => r.obligation_id === o.id); o.deliveries = del.filter((r) => r.obligation_id === o.id); o.submissions = sub.filter((r) => r.obligation_id === o.id);
        o.promoter = lines.find((l) => l.id === o.line_id)?.promoter ?? null;
      }
    }
    out.history = await many('SELECT h.id, h.version, h.action, h.reason, h.created_at, u.display_name AS actor FROM sponsorship_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.sponsorship_id=$1 ORDER BY h.id', [d.id]);
    return out;
  },
});

/** Obligations with what has actually happened to them. Reported (unverified) money is shown apart from confirmed money. */
async function obligationRows(where, params, tail = '') {
  return many(
    `SELECT o.id, o.sponsorship_id, o.line_id, o.version, o.seq, o.kind, o.due_on::text AS due_on, o.amount_cents, o.currency, o.quantity, o.status,
            (o.status = 'scheduled' AND o.due_on < current_date) AS overdue, l.label,
            coalesce((SELECT sum(amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed'),0)::bigint AS confirmed_cents,
            coalesce((SELECT sum(amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reported'),0)::bigint AS reported_unverified_cents,
            coalesce((SELECT sum(CASE x.status WHEN 'received' THEN x.received_quantity WHEN 'dispatched' THEN 0 ELSE 0 END) FROM sponsorship_deliveries x WHERE x.obligation_id=o.id),0)::int AS received_quantity,
            coalesce((SELECT sum(x.quantity) FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status='dispatched'),0)::int AS in_transit_quantity,
            (SELECT s.status FROM sponsorship_submissions s WHERE s.obligation_id=o.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS submission_status
       FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id WHERE ${where} ORDER BY o.due_on, o.id ${tail}`, params);
}

const SCOPE = `(${sponsorStaffSql(1)} OR $2::boolean
  OR (ss.target_type='event' AND ss.target_id IN (SELECT id FROM events WHERE organizer_id=$1))
  OR (ss.target_type='team' AND ss.target_id IN (SELECT id FROM teams WHERE owner_id=$1)) OR (ss.target_type='athlete' AND ss.target_id=$1))`;

cap({
  name: 'list_sponsorship_obligations', method: 'GET', path: '/sponsorship-obligations', tag: 'Sponsors',
  summary: 'Dues across your agreements (as sponsor or recipient). Filters: agreement, brand, target type, kind, state (upcoming / overdue / open / fulfilled), due-date range. `totals` is per currency over every match, not just the page: committed, confirmed received, reported-but-unverified, outstanding. Currencies are never added together.',
  input: z.object({ sponsorship_id: id.optional(), sponsor_id: id.optional(), target_type: z.enum(['event', 'team', 'athlete']).optional(), kind: z.enum(['money', 'goods', 'endorsement']).optional(), state: z.enum(['upcoming', 'overdue', 'open', 'fulfilled', 'cancelled']).optional(), from: date.optional(), to: date.optional(), ...page }),
  async handler({ user }, i) {
    const params = [user.id, !!isAdmin(user), i.sponsorship_id ?? null, i.sponsor_id ?? null, i.target_type ?? null, i.kind ?? null, i.state ?? null, i.from ?? null, i.to ?? null];
    const where = `${SCOPE} AND ($3::uuid IS NULL OR o.sponsorship_id=$3) AND ($4::uuid IS NULL OR ss.sponsor_id=$4) AND ($5::text IS NULL OR ss.target_type=$5) AND ($6::text IS NULL OR o.kind=$6)
      AND ($8::date IS NULL OR o.due_on >= $8) AND ($9::date IS NULL OR o.due_on <= $9)
      AND ($7::text IS NULL OR ($7='overdue' AND o.status='scheduled' AND o.due_on < current_date) OR ($7='upcoming' AND o.status='scheduled' AND o.due_on >= current_date)
           OR ($7='open' AND o.status='scheduled') OR ($7='fulfilled' AND o.status='fulfilled') OR ($7='cancelled' AND o.status='cancelled'))`;
    const base = `FROM sponsorship_obligations o JOIN sponsorships ss ON ss.id=o.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${where}`;
    const ids = (await many(`SELECT o.id ${base} ORDER BY o.due_on, o.id LIMIT $10 OFFSET $11`, [...params, i.limit, i.offset])).map((r) => r.id);
    const rows = ids.length ? await obligationRows('o.id = ANY($1::uuid[])', [ids]) : [];
    const totals = await many(
      `SELECT o.currency, sum(o.amount_cents) FILTER (WHERE o.status <> 'cancelled')::bigint AS committed_cents,
              coalesce(sum((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed')),0)::bigint AS confirmed_cents,
              coalesce(sum((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reported')),0)::bigint AS reported_unverified_cents,
              coalesce(sum(o.amount_cents) FILTER (WHERE o.status='scheduled' AND o.due_on < current_date),0)::bigint AS overdue_cents
         ${base} AND o.kind='money' GROUP BY o.currency ORDER BY o.currency`, params);
    for (const t of totals) t.outstanding_cents = t.committed_cents - t.confirmed_cents;
    return { obligations: rows, totals };
  },
});

cap({
  name: 'get_sponsorship_summary', method: 'GET', path: '/sponsorship-summary', tag: 'Sponsors',
  summary: 'Sponsor / recipient home: agreements by status, dues in the next 30 days, overdue dues, goods still outstanding, endorsements waiting for your review and payments waiting for your confirmation.',
  async handler({ user }) {
    const a = [user.id, !!isAdmin(user)];
    const base = `FROM sponsorship_obligations o JOIN sponsorships ss ON ss.id=o.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${SCOPE}`;
    const recipient = `(ss.target_type='event' AND ss.target_id IN (SELECT id FROM events WHERE organizer_id=$1) OR ss.target_type='team' AND ss.target_id IN (SELECT id FROM teams WHERE owner_id=$1) OR ss.target_type='athlete' AND ss.target_id=$1)`;
    const [agreements, counts] = await Promise.all([
      many(`SELECT ss.status, count(*)::int AS n FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${SCOPE} GROUP BY ss.status ORDER BY ss.status`, a),
      one(`SELECT count(*) FILTER (WHERE o.status='scheduled' AND o.due_on < current_date)::int AS overdue,
                  count(*) FILTER (WHERE o.status='scheduled' AND o.due_on BETWEEN current_date AND current_date + 30)::int AS due_30_days,
                  count(*) FILTER (WHERE o.kind='goods' AND o.status='scheduled')::int AS goods_outstanding,
                  (SELECT count(*) FROM sponsorship_payments p JOIN sponsorship_obligations po ON po.id=p.obligation_id JOIN sponsorships pss ON pss.id=po.sponsorship_id WHERE p.status='reported' AND ${recipient.replace(/ss\./g, 'pss.')})::int AS payments_to_confirm,
                  (SELECT count(*) FROM sponsorship_submissions s JOIN sponsorship_obligations so ON so.id=s.obligation_id JOIN sponsorship_lines sl ON sl.id=so.line_id JOIN sponsorships sss ON sss.id=so.sponsorship_id JOIN sponsors ssp ON ssp.id=sss.sponsor_id
                    WHERE s.status='submitted' AND ((sl.promoter='recipient' AND ${sponsorStaffSql(1, 'evaluate', 'ssp', 'sss')}) OR (sl.promoter='sponsor' AND ${recipient.replace(/ss\./g, 'sss.')})))::int AS endorsements_to_review
             ${base}`, a)]);
    return { agreements, ...counts };
  },
});

/** Money state of an obligation after any change: fulfilled once confirmed payments cover it, reopened if a reversal uncovers it. */
async function settleMoney(c, o) {
  const paid = Number((await c.query("SELECT coalesce(sum(amount_cents),0) AS s FROM sponsorship_payments WHERE obligation_id=$1 AND status='confirmed'", [o.id])).rows[0].s);
  if (paid >= o.amount_cents) await c.query("UPDATE sponsorship_obligations SET status='fulfilled', fulfilled_at=coalesce(fulfilled_at, now()) WHERE id=$1 AND status='scheduled'", [o.id]);
  else await c.query("UPDATE sponsorship_obligations SET status='scheduled', fulfilled_at=NULL WHERE id=$1 AND status='fulfilled'", [o.id]);
}
const open = (ctx, kind) => {
  if (ctx.o.kind !== kind) throw badRequest(`This obligation is ${ctx.o.kind}, not ${kind}`);
  if (ctx.o.status !== 'scheduled') throw conflict(`This obligation is already ${ctx.o.status}`);
  if (!['active', 'ended'].includes(ctx.d.status)) throw conflict('The agreement is not active');
};

cap({
  name: 'report_sponsorship_payment', method: 'POST', path: '/sponsorship-obligations/:id/payments', tag: 'Sponsors', status: 201,
  summary: 'Sponsor owner: report a bank/cash payment against a money due (reference, amount, currency, date, optional https evidence). It stays UNVERIFIED until the recipient confirms it. Partial and multiple payments are allowed, bounded by the amount due; the same reference cannot be reported twice. This does not move money; sportarena does not hold funds or pay recipients out here.',
  input: z.object({ id, amount_cents: z.coerce.number().int().positive(), currency: z.string().length(3).toUpperCase(), method: z.enum(['bank_transfer', 'cash', 'other']), reference: z.string().min(2).max(120), paid_on: date, evidence_url: url.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await obligationContext(c, i.id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor reports its payments');
      ctx.need('pay', 'report payments');
      open(ctx, 'money');
      if (i.currency !== ctx.o.currency) throw badRequest(`This due is in ${ctx.o.currency}`);
      const held = Number((await c.query("SELECT coalesce(sum(amount_cents),0) AS s FROM sponsorship_payments WHERE obligation_id=$1 AND status IN ('reported','confirmed')", [ctx.o.id])).rows[0].s);
      if (held + i.amount_cents > ctx.o.amount_cents) throw conflict(`Only ${ctx.o.amount_cents - held} is still due on this instalment`);
      try {
        const p = (await c.query('INSERT INTO sponsorship_payments(obligation_id, amount_cents, currency, method, reference, paid_on, evidence_url, reported_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [ctx.o.id, i.amount_cents, i.currency, i.method, i.reference, i.paid_on, i.evidence_url ?? null, user.id])).rows[0];
        await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'payment_reported');
        await ping(c, ctx.recipientId, 'A sponsorship payment needs your confirmation', ctx, 'sponsorship_payment');
        return p;
      } catch (e) { if (e.code === '23505') throw conflict('That payment reference was already reported for this instalment'); throw e; }
    });
  },
});

cap({
  name: 'decide_sponsorship_payment', method: 'PATCH', path: '/sponsorship-payments/:id', tag: 'Sponsors',
  summary: 'Recipient (or admin): confirm that a reported payment arrived, reject it (reason required), or reverse a confirmed one (reason required, e.g. a refund). The sponsor can never confirm its own payment. A due is fulfilled only by confirmed payments.',
  input: z.object({ id, status: z.enum(['confirmed', 'rejected', 'reversed']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p0 = (await c.query('SELECT obligation_id FROM sponsorship_payments WHERE id=$1', [i.id])).rows[0];
      if (!p0) throw notFound('Payment');
      const ctx = await obligationContext(c, p0.obligation_id, user);
      if (ctx.role !== 'recipient' && ctx.role !== 'admin') throw forbidden('Only the recipient confirms a payment');
      if (i.status !== 'confirmed' && !i.note) throw badRequest('Give a reason');
      const p = (await c.query('SELECT * FROM sponsorship_payments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (i.status === 'reversed' ? p.status !== 'confirmed' : p.status !== 'reported') throw conflict(`This payment is already ${p.status}`);
      const row = (await c.query('UPDATE sponsorship_payments SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1 RETURNING *', [p.id, i.status, user.id, i.note ?? null])).rows[0];
      await settleMoney(c, ctx.o);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, `payment_${i.status}`, i.note);
      await ping(c, 'sponsor', `A sponsorship payment was ${i.status}`, ctx, 'sponsorship_payment', 'pay');
      return row;
    });
  },
});

cap({
  name: 'dispatch_sponsorship_goods', method: 'POST', path: '/sponsorship-obligations/:id/deliveries', tag: 'Sponsors', status: 201,
  summary: 'Sponsor owner: record a dispatch of goods against a goods due. Only the recipient can mark receipt. Dispatched plus received quantity can never exceed the committed quantity (a rejected delivery frees its quantity).',
  input: z.object({ id, quantity: z.coerce.number().int().positive(), reference: z.string().max(120).optional(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await obligationContext(c, i.id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor dispatches goods');
      ctx.need('pay', 'dispatch goods');
      open(ctx, 'goods');
      const held = Number((await c.query("SELECT coalesce(sum(CASE status WHEN 'received' THEN received_quantity WHEN 'dispatched' THEN quantity ELSE 0 END),0) AS s FROM sponsorship_deliveries WHERE obligation_id=$1", [ctx.o.id])).rows[0].s);
      if (held + i.quantity > ctx.o.quantity) throw conflict(`Only ${ctx.o.quantity - held} more can be dispatched against this delivery`);
      const row = (await c.query('INSERT INTO sponsorship_deliveries(obligation_id, quantity, reference, note, dispatched_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ctx.o.id, i.quantity, i.reference ?? null, i.note ?? null, user.id])).rows[0];
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'goods_dispatched');
      await ping(c, ctx.recipientId, 'Sponsored goods were dispatched', ctx, 'sponsorship_delivery');
      return row;
    });
  },
});

cap({
  name: 'decide_sponsorship_delivery', method: 'PATCH', path: '/sponsorship-deliveries/:id', tag: 'Sponsors',
  summary: 'Recipient (or admin): confirm receipt of a dispatched delivery (optionally fewer than dispatched, for a partial delivery) or reject it (reason required). The due is fulfilled when confirmed quantities reach the committed quantity.',
  input: z.object({ id, status: z.enum(['received', 'rejected']), received_quantity: z.coerce.number().int().positive().optional(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d0 = (await c.query('SELECT obligation_id FROM sponsorship_deliveries WHERE id=$1', [i.id])).rows[0];
      if (!d0) throw notFound('Delivery');
      const ctx = await obligationContext(c, d0.obligation_id, user);
      if (ctx.role !== 'recipient' && ctx.role !== 'admin') throw forbidden('Only the recipient confirms receipt');
      const dl = (await c.query('SELECT * FROM sponsorship_deliveries WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (dl.status !== 'dispatched') throw conflict(`This delivery is already ${dl.status}`);
      if (i.status === 'rejected' && !i.note) throw badRequest('Give a reason');
      const got = i.status === 'received' ? (i.received_quantity ?? dl.quantity) : 0;
      if (got > dl.quantity) throw badRequest(`Only ${dl.quantity} were dispatched`);
      const row = (await c.query('UPDATE sponsorship_deliveries SET status=$2, received_quantity=$3, decided_by=$4, decided_at=now(), decision_note=$5 WHERE id=$1 RETURNING *', [dl.id, i.status, got, user.id, i.note ?? null])).rows[0];
      const total = Number((await c.query("SELECT coalesce(sum(received_quantity),0) AS s FROM sponsorship_deliveries WHERE obligation_id=$1 AND status='received'", [ctx.o.id])).rows[0].s);
      if (total >= ctx.o.quantity) await c.query("UPDATE sponsorship_obligations SET status='fulfilled', fulfilled_at=now() WHERE id=$1 AND status='scheduled'", [ctx.o.id]);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, `goods_${i.status}`, i.note);
      await ping(c, 'sponsor', `Sponsored goods were ${i.status}`, ctx, 'sponsorship_delivery', 'pay');
      return row;
    });
  },
});

/** The party that promotes submits evidence; the other party reviews it. */
async function endorsementCtx(c, o, user) {
  const ctx = await obligationContext(c, o, user);
  const promoter = (await c.query('SELECT promoter FROM sponsorship_lines WHERE id=$1', [ctx.o.line_id])).rows[0].promoter;
  return { ...ctx, promoter, reviewer: promoter === 'recipient' ? 'sponsor' : 'recipient' };
}

cap({
  name: 'submit_sponsorship_endorsement', method: 'POST', path: '/sponsorship-obligations/:id/submissions', tag: 'Sponsors', status: 201,
  summary: 'The promoting party submits evidence (an https link and a note) for an endorsement due. The other party reviews it. A new submission is only possible when there is none, or the last was sent back for revision. Delivery here is contractual evidence; reach or impressions are never inferred.',
  input: z.object({ id, evidence_url: url, note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await endorsementCtx(c, i.id, user);
      open(ctx, 'endorsement');
      if (ctx.role !== ctx.promoter) throw forbidden(`Only the ${ctx.promoter} promotes under this agreement`);
      if (ctx.role === 'sponsor') ctx.need('evaluate', 'submit endorsement evidence');
      const last = (await c.query('SELECT status FROM sponsorship_submissions WHERE obligation_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [ctx.o.id])).rows[0];
      if (last && last.status !== 'revision_requested') throw conflict(`The last submission is ${last.status}`);
      const row = (await c.query('INSERT INTO sponsorship_submissions(obligation_id, evidence_url, note, submitted_by) VALUES ($1,$2,$3,$4) RETURNING *', [ctx.o.id, i.evidence_url, i.note ?? null, user.id])).rows[0];
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'endorsement_submitted');
      await ping(c, other(ctx), 'An endorsement is waiting for your review', ctx, 'sponsorship_endorsement');
      return row;
    });
  },
});

cap({
  name: 'review_sponsorship_endorsement', method: 'PATCH', path: '/sponsorship-submissions/:id', tag: 'Sponsors',
  summary: 'The reviewing party (the one that does not promote) accepts a submission or asks for a revision (reason required). Acceptance fulfils the due.',
  input: z.object({ id, status: z.enum(['accepted', 'revision_requested']), note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s0 = (await c.query('SELECT obligation_id FROM sponsorship_submissions WHERE id=$1', [i.id])).rows[0];
      if (!s0) throw notFound('Submission');
      const ctx = await endorsementCtx(c, s0.obligation_id, user);
      if (ctx.role !== ctx.reviewer && ctx.role !== 'admin') throw forbidden(`Only the ${ctx.reviewer} reviews this endorsement`);
      if (ctx.role === 'sponsor') ctx.need('evaluate', 'review endorsements');
      if (i.status === 'revision_requested' && !i.note) throw badRequest('Say what needs to change');
      const s = (await c.query('SELECT * FROM sponsorship_submissions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (s.status !== 'submitted') throw conflict(`This submission is already ${s.status}`);
      const row = (await c.query('UPDATE sponsorship_submissions SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1 RETURNING *', [s.id, i.status, user.id, i.note ?? null])).rows[0];
      if (i.status === 'accepted') await c.query("UPDATE sponsorship_obligations SET status='fulfilled', fulfilled_at=now() WHERE id=$1 AND status='scheduled'", [ctx.o.id]);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, `endorsement_${i.status}`, i.note);
      await ping(c, ctx.promoter === 'sponsor' ? 'sponsor' : ctx.recipientId, `An endorsement was ${i.status === 'accepted' ? 'accepted' : 'sent back for revision'}`, ctx, 'sponsorship_endorsement');
      return row;
    });
  },
});

cap({
  name: 'rebuild_sponsorship_schedule', method: 'POST', path: '/sponsorships/:id/rebuild-schedule', tag: 'Sponsors', auth: ['admin'],
  summary: 'Admin recovery: regenerate the dues of an accepted agreement. Idempotent (unique per agreement/version/line/occurrence), so it only fills in what is missing and never duplicates or rewrites an existing due.',
  input: z.object({ id }),
  handler: async (_, i) => tx(async (c) => ({ created: await generateObligations(c, i.id) })),
});
