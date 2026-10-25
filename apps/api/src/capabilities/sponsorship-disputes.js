// Sponsorship disputes, complaints and risk controls (#308). One canonical case per dispute (see ../cases.js) linked to the exact agreement,
// payment, delivery or evidence it is about, with contested status, scoped evidence, reasoned risk flags, reviewers, resolutions that use the
// canonical obligation concession, and an appeal. The rules live in ../sponsor-disputes.js. Opening a dispute never changes a debt or evidence.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { notifySponsor } from '../sponsor-access.js';
import { dealContext, logHistory } from '../sponsor-agreements.js';
import { prepEvidence, slaDue } from '../cases.js';
import { toCsv } from '../csv.js';
import { APPEAL_DAYS, FLAG_KINDS, LIVE, SUBJECT_LABEL, applyConcession, enc, resolveSubject, standing } from '../sponsor-disputes.js';

const TAG = 'Sponsors';
const rev = z.coerce.number().int().positive().describe('the revision you reviewed; a stale one is rejected with 409 and changes nothing');
const stale = () => conflict('This dispute changed while you were looking; reload it and try again', { code: 'stale_version' });
const evidenceIn = z.object({
  label: z.string().max(120).optional(), reference: z.string().min(2).max(500).optional().describe('https link or reference number'),
  file_name: z.string().max(120).optional(), data: z.string().max(7_200_000).optional().describe('base64 file: PDF, JPEG, PNG or WebP, up to 5 MB'),
}).refine((e) => e.reference || e.data, 'Give a reference or attach a file');

const hidden = (ctx) => ctx.role === 'recipient' && ['pending', 'rejected'].includes(ctx.d.budget_approval);
const COLS = `x.id, x.case_id, x.sponsorship_id, x.subject_type, x.obligation_id, x.payment_id, x.delivery_id, x.submission_id, x.opened_side, x.disputed_cents, x.currency, x.status,
  x.rev, x.outcome, x.resolution, x.resolved_at, x.appeal_until, x.created_at, x.updated_at, c.case_no, c.subject, (x.status IN ('open','under_review','appealed')) AS contested,
  (SELECT count(*)::int FROM sponsorship_dispute_flags f WHERE f.dispute_id=x.id AND f.cleared_at IS NULL) AS open_flags,
  (SELECT count(*)::int FROM sponsorship_dispute_reviewers r WHERE r.dispute_id=x.id AND r.removed_at IS NULL) AS reviewers`;
const FROM = 'FROM sponsorship_disputes x JOIN cases c ON c.id=x.case_id';

const event = (c, caseId, actor, action, from, to, reason, { data = {}, visibility = 'public' } = {}) => c.query(
  'INSERT INTO case_events(case_id, actor_id, action, from_status, to_status, reason, data, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [caseId, actor, action, from, to, reason ?? null, JSON.stringify(data), visibility]);
const message = (c, caseId, author, body, visibility = 'public') => c.query('INSERT INTO case_messages(case_id, author_id, visibility, kind, body_enc) VALUES ($1,$2,$3,$4,$5)', [caseId, author, visibility, 'message', enc(body)]);
const evidence = (c, caseId, userId, items) => Promise.all(items.map((p) => c.query(
  'INSERT INTO case_evidence(case_id, label, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [caseId, p.label, p.reference_enc, p.file_name, p.content_type, p.size_bytes, p.sha256, p.file_enc, userId])));
const bump = (c, did, status) => c.query('UPDATE sponsorship_disputes SET rev=rev+1, updated_at=now(), status=coalesce($2,status) WHERE id=$1', [did, status ?? null]);

/** Tell the other side(s) without terms or amounts; the participant-scoped reads carry the detail. */
async function ping(c, ctx, from, title, dispute) {
  const msg = { kind: 'sponsorship_update', title, body: `Open the ${ctx.sp.name} agreement to see the dispute.`, data: { sponsorship_id: ctx.d.id, dispute_id: dispute.id } };
  if (from !== 'sponsor') await notifySponsor(c, ctx.sp, 'dispute', msg, ctx.d.department_id);
  if (from !== 'recipient' && ctx.recipientId) await notify(c, ctx.recipientId, msg);
  for (const r of (await c.query('SELECT user_id FROM sponsorship_dispute_reviewers WHERE dispute_id=$1 AND removed_at IS NULL', [dispute.id])).rows) await notify(c, r.user_id, msg);
}

/** Lock the agreement, then the dispute (always in this order), and work out who the caller is on it. */
async function locked(c, disputeId, user, { write = true } = {}) {
  const sid = (await c.query('SELECT sponsorship_id FROM sponsorship_disputes WHERE id=$1', [disputeId])).rows[0]?.sponsorship_id;
  if (!sid) throw notFound('Dispute');
  const ctx = await dealContext(c, sid, user, { lock: write });
  if (hidden(ctx)) throw notFound('Dispute');
  const x = (await c.query('SELECT * FROM sponsorship_disputes WHERE id=$1 FOR UPDATE', [disputeId])).rows[0];
  return { ctx, x, side: await standing(c, ctx, x, user, { write: write && ctx.role !== 'admin' }) };
}
const live = (x) => LIVE.includes(x.status);

function canOf(x, side, user, appeals) {
  const party = side !== 'reviewer', reviewer = side === 'reviewer';
  const inWindow = x.status === 'resolved' && x.appeal_until && new Date(x.appeal_until) > new Date() && appeals < 1;
  return {
    reply: live(x), flag: live(x), clear_flag: reviewer && live(x), reviewers: reviewer, resolve: reviewer && live(x) && x.resolved_by !== user.id,
    appeal: party && inWindow, withdraw: party && side === x.opened_side && ['open', 'under_review'].includes(x.status), export: true,
  };
}

async function detail(c, x, ctx, side, user) {
  const reviewer = side === 'reviewer';
  const vis = reviewer ? ['public', 'internal'] : ['public'];
  const [thread, ev, events, flags, reviewers, appeals, adjustments, people] = await Promise.all([
    c.query('SELECT m.id, m.visibility, m.body_enc, m.created_at, u.display_name AS author FROM case_messages m JOIN users u ON u.id=m.author_id WHERE m.case_id=$1 AND m.visibility = ANY($2) ORDER BY m.created_at, m.id', [x.case_id, vis]),
    c.query('SELECT e.id, e.label, e.file_name, e.content_type, e.size_bytes, e.sha256, e.created_at, (e.reference_enc IS NOT NULL) AS has_reference, u.display_name AS added_by FROM case_evidence e JOIN users u ON u.id=e.added_by WHERE e.case_id=$1 ORDER BY e.created_at, e.id', [x.case_id]),
    c.query('SELECT e.action, e.from_status, e.to_status, e.reason, e.created_at, u.display_name AS actor FROM case_events e JOIN users u ON u.id=e.actor_id WHERE e.case_id=$1 AND e.visibility = ANY($2) ORDER BY e.created_at, e.id', [x.case_id, vis]),
    c.query('SELECT f.id, f.kind, f.reason, f.raised_side, f.created_at, f.cleared_at, f.cleared_reason, u.display_name AS raised_by FROM sponsorship_dispute_flags f JOIN users u ON u.id=f.raised_by WHERE f.dispute_id=$1 ORDER BY f.created_at, f.id', [x.id]),
    reviewer ? c.query('SELECT r.id, r.user_id, r.reason, r.created_at, r.removed_at, u.display_name AS name FROM sponsorship_dispute_reviewers r JOIN users u ON u.id=r.user_id WHERE r.dispute_id=$1 ORDER BY r.created_at, r.id', [x.id]) : { rows: [] },
    c.query('SELECT a.side, a.reason, a.decision_before, a.created_at, u.display_name AS appealed_by FROM sponsorship_dispute_appeals a JOIN users u ON u.id=a.appealed_by WHERE a.dispute_id=$1 ORDER BY a.created_at, a.id', [x.id]),
    c.query('SELECT a.round, a.obligation_id, a.amount_cents, a.currency, a.created_at FROM sponsorship_dispute_adjustments a WHERE a.dispute_id=$1 ORDER BY a.round', [x.id]),
    c.query('SELECT display_name FROM users WHERE id=$1', [x.opened_by]),
  ]);
  const head = (await c.query(`SELECT ${COLS} ${FROM} WHERE x.id=$1`, [x.id])).rows[0];
  return {
    ...head, role: ctx.role, side, opened_by: people.rows[0]?.display_name ?? null,
    thread: thread.rows.map(({ body_enc, ...m }) => ({ ...m, body: decrypt(body_enc, 'case_messages.body') })),
    evidence: ev.rows, history: events.rows, flags: flags.rows, reviewers: reviewers.rows, appeals: appeals.rows, adjustments: adjustments.rows,
    can: canOf(x, side, user, appeals.rows.length),
  };
}

// ------------------------------------------------------------------ agreement side
cap({
  name: 'list_sponsorship_disputes', method: 'GET', path: '/sponsorships/:id/disputes', tag: TAG,
  summary: 'The disputes and complaints raised on an agreement (newest first, deterministic paging), what the caller may do, and the records of this agreement a dispute can be about (payments, goods deliveries, endorsement evidence, money dues). Sponsor staff need a dispute-permitted role (manager, finance, legal, approver; auditors read); the recipient side is the athlete/organisation owner or guardian; platform admins only see disputes they are an assigned reviewer on. Nothing else can read it.',
  input: z.object({ id, status: z.enum(['active', 'resolved', 'appealed', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (hidden(ctx)) throw notFound('Sponsorship');
    const side = ctx.role === 'admin' ? 'reviewer' : await standing(pool, ctx, null, user);
    const rows = await many(
      `SELECT ${COLS} ${FROM} WHERE x.sponsorship_id=$1
         AND ($2::text IS NULL OR x.status=$2 OR ($2='active' AND x.status = ANY($3)))
         AND ($4::boolean = false OR EXISTS (SELECT 1 FROM sponsorship_dispute_reviewers r WHERE r.dispute_id=x.id AND r.user_id=$5 AND r.removed_at IS NULL))
       ORDER BY x.created_at DESC, x.id DESC LIMIT $6 OFFSET $7`, [i.id, i.status ?? null, LIVE, side === 'reviewer', user.id, i.limit, i.offset]);
    const mayOpen = side !== 'reviewer' && (ctx.role !== 'sponsor' || (() => { try { ctx.need('dispute', 'raise a dispute'); return true; } catch { return false; } })());
    const subjects = mayOpen ? {
      payments: await many("SELECT x.id, l.label, x.amount_cents, x.currency, x.method, x.status, x.paid_on::text AS paid_on, x.reference FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1 ORDER BY x.created_at DESC, x.id", [i.id]),
      deliveries: await many('SELECT x.id, l.label, x.quantity, x.received_quantity, x.status, x.reference FROM sponsorship_deliveries x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1 ORDER BY x.created_at DESC, x.id', [i.id]),
      evidence: await many('SELECT s.id, l.label, s.status, s.created_at FROM sponsorship_submissions s JOIN sponsorship_obligations o ON o.id=s.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1 ORDER BY s.created_at DESC, s.id', [i.id]),
      dues: await many("SELECT o.id, l.label, o.due_on::text AS due_on, o.amount_cents, o.currency FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1 AND o.kind='money' AND o.status <> 'cancelled' ORDER BY o.due_on, o.id", [i.id]),
    } : null;
    return { role: ctx.role, side, can_open: mayOpen && ['active', 'paused', 'ended', 'term_expired', 'completed'].includes(ctx.d.status), subjects, disputes: rows, flag_kinds: FLAG_KINDS, appeal_days: APPEAL_DAYS };
  },
});

/** The shared core of opening a dispute: validates the subject, opens the canonical case, links it and tells the other side. `returnId` ties it to a disputed goods return (#389); the caller has already authorised `side`. */
export async function createDispute(c, ctx, side, user, i, prepared, returnId = null) {
      if (!['active', 'paused', 'ended', 'term_expired', 'completed'].includes(ctx.d.status)) throw conflict(`An agreement that is ${ctx.d.status} has nothing to dispute yet`);
      const s = await resolveSubject(c, ctx.d, i);
      let currency = null;
      if (i.subject_type === 'payment') {
        if (i.disputed_cents === undefined) throw badRequest('Say how much of the payment is disputed (disputed_cents)');
        if (i.disputed_cents > s.ceiling.cents) throw badRequest('The disputed amount is more than the payment');
        currency = s.ceiling.currency;
      }
      const dup = (await c.query(`SELECT c.case_no FROM sponsorship_disputes x JOIN cases c ON c.id=x.case_id WHERE x.status = ANY($1) AND x.sponsorship_id=$2 AND (
        (x.payment_id IS NOT NULL AND x.payment_id=$3) OR (x.delivery_id IS NOT NULL AND x.delivery_id=$4 AND x.return_id IS NULL AND $8::uuid IS NULL) OR (x.submission_id IS NOT NULL AND x.submission_id=$5) OR (x.subject_type='agreement' AND $6::text='agreement' AND x.opened_side=$7) OR ($8::uuid IS NOT NULL AND x.return_id=$8))`,
        [LIVE, ctx.d.id, s.payment_id ?? null, s.delivery_id ?? null, s.submission_id ?? null, i.subject_type, side, returnId])).rows[0];
      if (dup) throw conflict(`There is already an open dispute (#${dup.case_no}) about this`);
      const due = slaDue('normal');
      const cs = (await c.query(
        `INSERT INTO cases(kind, category, priority, subject, requester_id, details, first_response_due, resolution_due) VALUES ('dispute','sponsorship','normal',$1,$2,$3,$4,$5) RETURNING id, case_no`,
        [i.title, user.id, JSON.stringify(currency ? { disputed_amount_cents: i.disputed_cents, currency } : {}), due.first, due.resolution])).rows[0];
      for (const l of [{ type: 'sponsorship', id: ctx.d.id }, s.link]) await c.query('INSERT INTO case_links(case_id, entity_type, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [cs.id, l.type, l.id]);
      const x = (await c.query(
        `INSERT INTO sponsorship_disputes(case_id, sponsorship_id, subject_type, obligation_id, payment_id, delivery_id, submission_id, opened_side, opened_by, disputed_cents, currency, idempotency_key, return_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [cs.id, ctx.d.id, i.subject_type, s.obligation_id ?? null, s.payment_id ?? null, s.delivery_id ?? null, s.submission_id ?? null, side, user.id, i.disputed_cents ?? null, currency, i.idempotency_key ?? null, returnId])).rows[0];
      await message(c, cs.id, user.id, i.description);
      await evidence(c, cs.id, user.id, prepared);
      await event(c, cs.id, user.id, 'open', null, 'open', null, { data: { subject: i.subject_type, evidence: prepared.length } });
      await logHistory(c, ctx.d.id, ctx.d.accepted_version ?? ctx.d.terms_version, user.id, 'dispute_opened', `${SUBJECT_LABEL[i.subject_type]}: ${i.title}`);
      await audit(c, user.id, 'sponsorship.dispute_open', 'sponsorship', ctx.d.id);
      await ping(c, ctx, side, 'A sponsorship dispute was raised', x);
      for (const a of (await c.query("SELECT id FROM users WHERE 'admin' = ANY(roles) AND id <> $1", [user.id])).rows) await notify(c, a.id, { kind: 'case_update', title: `New sponsorship dispute #${cs.case_no}`, body: 'Open the case queue to claim a review.', data: { case_id: cs.id, case_no: cs.case_no } });
      return (await c.query(`SELECT ${COLS} ${FROM} WHERE x.id=$1`, [x.id])).rows[0];
}

cap({
  name: 'open_sponsorship_dispute', method: 'POST', path: '/sponsorships/:id/disputes', tag: TAG, status: 201,
  summary: 'Either side of an agreement disputes a payment, a goods delivery, endorsement evidence or the agreement itself. This opens a canonical support case linked to that exact record, marks it contested and notifies the other side; it NEVER changes a due, a payment, a delivery or any evidence. The disputed amount of a payment can not exceed that payment and takes its currency. One live dispute per record. Retry-safe with idempotency_key.',
  input: z.object({
    id, subject_type: z.enum(['agreement', 'payment', 'goods', 'evidence']), subject_id: id.optional().describe('the payment, delivery or evidence being disputed'), obligation_id: id.optional().describe('for an agreement dispute: the due it concerns'),
    disputed_cents: z.coerce.number().int().positive().optional(), title: z.string().min(3).max(160), description: z.string().min(5).max(4000),
    evidence: z.array(evidenceIn).max(5).default([]), idempotency_key: z.string().min(8).max(80).optional(),
  }),
  async handler({ user }, i) {
    const need = { payment: 'payment', goods: 'delivery', evidence: 'evidence record' }[i.subject_type];
    if (need && !i.subject_id) throw badRequest(`Choose the ${need} you are disputing`);
    if (!need && i.subject_id) throw badRequest('An agreement dispute does not name a payment, delivery or evidence');
    if (i.disputed_cents !== undefined && i.subject_type !== 'payment') throw badRequest('Only a payment dispute has a disputed amount');
    if (i.obligation_id && i.subject_type !== 'agreement') throw badRequest('obligation_id is only for an agreement dispute');
    const prepared = i.evidence.map(prepEvidence);
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (hidden(ctx)) throw notFound('Sponsorship');
      if (ctx.role === 'admin') throw forbidden('Only the sponsor or the recipient can open a dispute');
      const side = await standing(c, ctx, null, user, { write: true });
      if (i.idempotency_key) {
        const again = (await c.query(`SELECT ${COLS} ${FROM} WHERE x.opened_by=$1 AND x.idempotency_key=$2`, [user.id, i.idempotency_key])).rows[0];
        if (again) return again;
      }
      return createDispute(c, ctx, side, user, i, prepared);
    });
  },
});

cap({
  name: 'export_sponsorship_disputes', method: 'GET', path: '/sponsorships/:id/disputes/export', tag: TAG,
  summary: 'CSV of an agreement\'s disputes: status, subject, disputed amount and currency, open flags, outcome and the concession applied. Same participants as the reads (sponsor staff with dispute read access, the recipient side, assigned reviewers for their own disputes). Evidence and thread text are never exported.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (hidden(ctx)) throw notFound('Sponsorship');
    const side = ctx.role === 'admin' ? 'reviewer' : await standing(pool, ctx, null, user);
    if (ctx.role === 'sponsor') ctx.need('export', 'export disputes');
    const rows = await many(
      `SELECT c.case_no, x.subject_type, x.status, x.opened_side, x.disputed_cents, x.currency, x.outcome, x.created_at, x.resolved_at, (SELECT count(*) FROM sponsorship_dispute_flags f WHERE f.dispute_id=x.id AND f.cleared_at IS NULL) AS open_flags,
              (SELECT sum(a.amount_cents) FROM sponsorship_dispute_adjustments a WHERE a.dispute_id=x.id) AS conceded_cents
         ${FROM} WHERE x.sponsorship_id=$1 AND ($2::boolean = false OR EXISTS (SELECT 1 FROM sponsorship_dispute_reviewers r WHERE r.dispute_id=x.id AND r.user_id=$3 AND r.removed_at IS NULL)) ORDER BY x.created_at, x.id`, [i.id, side === 'reviewer', user.id]);
    if (side === 'reviewer') await audit(null, user.id, 'sponsorship.dispute_export', 'sponsorship', i.id);
    const cols = ['case_no', 'subject_type', 'status', 'opened_side', 'disputed_cents', 'currency', 'outcome', 'conceded_cents', 'open_flags', 'created_at', 'resolved_at'];
    return { filename: `disputes-${ctx.d.agreement_ref ?? ctx.d.id}.csv`, rows: rows.length, csv: toCsv(cols, rows) };
  },
});

// ------------------------------------------------------------------ one dispute
cap({
  name: 'get_sponsorship_dispute', method: 'GET', path: '/sponsorship-disputes/:id', tag: TAG,
  summary: 'One dispute as the caller sees it: the case thread (the platform reviewers also see their internal notes), evidence metadata scoped to this dispute, the timeline, reasoned risk flags, reviewers (reviewers only), appeals, the concession a resolution applied, and what the caller can do. The `rev` to send with every change is in the result.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const sid = (await one('SELECT sponsorship_id FROM sponsorship_disputes WHERE id=$1', [i.id]))?.sponsorship_id;
    if (!sid) throw notFound('Dispute');
    const ctx = await dealContext(pool, sid, user);
    if (hidden(ctx)) throw notFound('Dispute');
    const x = await one('SELECT * FROM sponsorship_disputes WHERE id=$1', [i.id]);
    const side = await standing(pool, ctx, x, user);
    if (side === 'reviewer') await audit(null, user.id, 'sponsorship.dispute_read', 'sponsorship_dispute', i.id);
    return detail(pool, x, ctx, side, user);
  },
});

cap({
  name: 'get_sponsorship_dispute_evidence', method: 'GET', path: '/sponsorship-disputes/:id/evidence/:evidence_id', tag: TAG,
  summary: 'The decrypted reference and file (base64) of one evidence item of this dispute. Same participants as the dispute; every read is audit-logged. Evidence of other cases or disputes can not be reached from here.',
  input: z.object({ id, evidence_id: id }),
  async handler({ user }, i) {
    const sid = (await one('SELECT sponsorship_id FROM sponsorship_disputes WHERE id=$1', [i.id]))?.sponsorship_id;
    if (!sid) throw notFound('Dispute');
    const ctx = await dealContext(pool, sid, user);
    if (hidden(ctx)) throw notFound('Dispute');
    const x = await one('SELECT * FROM sponsorship_disputes WHERE id=$1', [i.id]);
    await standing(pool, ctx, x, user);
    const r = await one('SELECT * FROM case_evidence WHERE id=$1 AND case_id=$2', [i.evidence_id, x.case_id]);
    if (!r) throw notFound('Evidence');
    await audit(null, user.id, 'sponsorship.dispute_evidence_read', 'sponsorship_dispute', i.id);
    return { id: r.id, label: r.label, reference: r.reference_enc ? decrypt(r.reference_enc, 'case_evidence.reference') : null, file_name: r.file_name, content_type: r.content_type, size_bytes: r.size_bytes, sha256: r.sha256, created_at: r.created_at,
      data: r.file_enc ? decrypt(r.file_enc, 'case_evidence.file') : null };
  },
});

cap({
  name: 'reply_sponsorship_dispute', method: 'POST', path: '/sponsorship-disputes/:id/replies', tag: TAG, status: 201,
  summary: 'Add a reply and/or evidence to a live dispute. Either side and the assigned reviewers can reply; a reviewer can mark a note internal (never shown to the sponsor or recipient). Needs the current `rev`.',
  input: z.object({ id, rev, body: z.string().min(1).max(4000), internal: z.boolean().default(false), evidence: z.array(evidenceIn).max(5).default([]) }),
  async handler({ user }, i) {
    const prepared = i.evidence.map(prepEvidence);
    return tx(async (c) => {
      const { ctx, x, side } = await locked(c, i.id, user);
      if (i.rev !== x.rev) throw stale();
      if (!live(x)) throw conflict(`This dispute is ${x.status}`);
      if (i.internal && side !== 'reviewer') throw forbidden('Only reviewers write internal notes');
      await message(c, x.case_id, user.id, i.body, i.internal ? 'internal' : 'public');
      if (!i.internal) await evidence(c, x.case_id, user.id, prepared);
      await event(c, x.case_id, user.id, i.internal ? 'internal_note' : 'reply', x.status, x.status, null, { visibility: i.internal ? 'internal' : 'public', data: { evidence: i.internal ? 0 : prepared.length } });
      await bump(c, x.id);
      if (!i.internal) await ping(c, ctx, side, 'There is a new reply on a sponsorship dispute', x);
      return { id: x.id, rev: x.rev + 1 };
    });
  },
});

cap({
  name: 'flag_sponsorship_dispute', method: 'POST', path: '/sponsorship-disputes/:id/flags', tag: TAG, status: 201,
  summary: 'Raise a risk flag on a live dispute (amount mismatch, suspected fraud, duplicate claim, evidence or consent concern). A reason is required and the flag is attributed, timestamped and never deleted. Either side or a reviewer can raise one; only a reviewer can clear it. A flag informs the review; it never blocks a payment by itself.',
  input: z.object({ id, rev, kind: z.enum(FLAG_KINDS), reason: z.string().min(5).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, x, side } = await locked(c, i.id, user);
      if (i.rev !== x.rev) throw stale();
      if (!live(x)) throw conflict(`This dispute is ${x.status}`);
      const f = (await c.query('INSERT INTO sponsorship_dispute_flags(dispute_id, kind, reason, raised_by, raised_side) VALUES ($1,$2,$3,$4,$5) RETURNING id', [x.id, i.kind, i.reason.trim(), user.id, side])).rows[0];
      await event(c, x.case_id, user.id, 'flag', x.status, x.status, i.reason, { data: { kind: i.kind, flag_id: f.id } });
      await audit(c, user.id, 'sponsorship.dispute_flag', 'sponsorship_dispute', x.id);
      await bump(c, x.id);
      await ping(c, ctx, side, 'A risk flag was raised on a sponsorship dispute', x);
      return { id: f.id, rev: x.rev + 1 };
    });
  },
});

cap({
  name: 'clear_sponsorship_dispute_flag', method: 'POST', path: '/sponsorship-disputes/:id/flags/:flag_id/clear', tag: TAG,
  summary: 'Reviewer: clear a risk flag, saying why. The flag stays on record with who cleared it, when and why.',
  input: z.object({ id, flag_id: id, rev, reason: z.string().min(5).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { x, side } = await locked(c, i.id, user);
      if (side !== 'reviewer') throw forbidden('Only an assigned reviewer can clear a flag');
      if (i.rev !== x.rev) throw stale();
      const r = await c.query('UPDATE sponsorship_dispute_flags SET cleared_by=$3, cleared_at=now(), cleared_reason=$4 WHERE id=$1 AND dispute_id=$2 AND cleared_at IS NULL', [i.flag_id, x.id, user.id, i.reason.trim()]);
      if (!r.rowCount) throw conflict('That flag does not exist or is already cleared');
      await event(c, x.case_id, user.id, 'flag_cleared', x.status, x.status, i.reason, { data: { flag_id: i.flag_id } });
      await audit(c, user.id, 'sponsorship.dispute_flag_clear', 'sponsorship_dispute', x.id);
      await bump(c, x.id);
      return { ok: true, rev: x.rev + 1 };
    });
  },
});

cap({
  name: 'assign_sponsorship_dispute_reviewer', method: 'POST', path: '/sponsorship-disputes/:id/reviewers', tag: TAG, auth: ['admin'],
  summary: 'Platform team: take (claim) a dispute for review, or add / remove another platform team member. The first reviewer claims it (a reason is required and the claim is visible to both sides in the timeline); afterwards only an assigned reviewer can add or remove reviewers. Platform members who are not assigned cannot see the dispute at all. The sides\' own people are never added here.',
  input: z.object({ id, rev, action: z.enum(['claim', 'add', 'remove']), user_id: id.optional(), reason: z.string().min(5).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const sid = (await c.query('SELECT sponsorship_id FROM sponsorship_disputes WHERE id=$1', [i.id])).rows[0]?.sponsorship_id;
      if (!sid) throw notFound('Dispute');
      const ctx = await dealContext(c, sid, user, { lock: true });
      const x = (await c.query('SELECT * FROM sponsorship_disputes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (i.rev !== x.rev) throw stale();
      const mine = (await c.query('SELECT 1 FROM sponsorship_dispute_reviewers WHERE dispute_id=$1 AND user_id=$2 AND removed_at IS NULL', [x.id, user.id])).rowCount > 0;
      const anyone = (await c.query('SELECT 1 FROM sponsorship_dispute_reviewers WHERE dispute_id=$1 AND removed_at IS NULL', [x.id])).rowCount > 0;
      const target = i.action === 'claim' ? user.id : i.user_id;
      if (!target) throw badRequest('user_id is required');
      if (i.action === 'claim') { if (anyone) throw conflict('A reviewer is already assigned; ask them to add you'); }
      else if (!mine) throw notFound('Dispute');
      if (['claim', 'add'].includes(i.action)) {
        if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND 'admin' = ANY(roles)", [target])).rowCount) throw badRequest('Reviewers must be platform team members');
        if ([x.opened_by].includes(target) || target === ctx.recipientId) throw badRequest('A party to the dispute cannot review it');
        if (!live(x)) throw conflict(`This dispute is ${x.status}`);
        const ins = await c.query('INSERT INTO sponsorship_dispute_reviewers(dispute_id, user_id, added_by, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [x.id, target, user.id, i.reason.trim()]);
        if (!ins.rowCount) throw conflict('Already a reviewer');
        await c.query("UPDATE cases SET status=CASE WHEN status='open' THEN 'in_progress' ELSE status END, assignee_id=coalesce(assignee_id,$2), first_responded_at=coalesce(first_responded_at, now()), updated_at=now() WHERE id=$1", [x.case_id, target]);
      } else {
        const r = await c.query('UPDATE sponsorship_dispute_reviewers SET removed_at=now(), removed_by=$3 WHERE dispute_id=$1 AND user_id=$2 AND removed_at IS NULL', [x.id, target, user.id]);
        if (!r.rowCount) throw conflict('That person is not a reviewer');
      }
      await event(c, x.case_id, user.id, `reviewer_${i.action}`, x.status, x.status, i.reason, { data: { reviewer_id: target } });
      await audit(c, user.id, `sponsorship.dispute_reviewer_${i.action}`, 'sponsorship_dispute', x.id);
      await bump(c, x.id, x.status === 'open' && i.action !== 'remove' ? 'under_review' : null);
      if (i.action !== 'remove') await ping(c, ctx, 'reviewer', 'A platform reviewer was assigned to a sponsorship dispute', x);
      return { ok: true, rev: x.rev + 1 };
    });
  },
});

cap({
  name: 'resolve_sponsorship_dispute', method: 'POST', path: '/sponsorship-disputes/:id/resolve', tag: TAG,
  summary: 'Assigned reviewer: decide a dispute with a reason both sides will read. Outcome `concession` waives part of a money due through the canonical obligation (never more than is still owed on it or than was disputed, in the due\'s own currency); `no_financial_change` and `dismissed` change no money. Debts, payments and evidence stay on record either way. Opens a ' + APPEAL_DAYS + '-day appeal window. After an appeal a different reviewer must decide, and that decision is final. Needs the current `rev`.',
  input: z.object({ id, rev, outcome: z.enum(['concession', 'no_financial_change', 'dismissed']), reason: z.string().min(5).max(2000), obligation_id: id.optional(), amount_cents: z.coerce.number().int().positive().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, x, side } = await locked(c, i.id, user);
      if (side !== 'reviewer') throw forbidden('Only an assigned reviewer can decide a dispute');
      if (i.rev !== x.rev) throw stale();
      if (!live(x)) throw conflict(`This dispute is ${x.status}`);
      const round = x.status === 'appealed' ? 2 : 1;
      if (round === 2 && x.resolved_by === user.id) throw forbidden('An appeal is decided by a different reviewer than the first decision');
      if (i.outcome === 'concession') {
        const oid = i.obligation_id ?? x.obligation_id;
        if (!oid || !i.amount_cents) throw badRequest('A concession needs the money due and the amount');
        const r = await applyConcession(c, x, { obligation_id: oid, amount_cents: i.amount_cents }, round, user.id);
        if (r.error) throw badRequest(r.error);
      } else if (i.obligation_id || i.amount_cents) throw badRequest('Only a concession moves money');
      await c.query("UPDATE sponsorship_disputes SET outcome=$2, resolution=$3, resolved_by=$4, resolved_at=now(), appeal_until=CASE WHEN $5=1 THEN now() + make_interval(days => $6) ELSE NULL END WHERE id=$1", [x.id, i.outcome, i.reason.trim(), user.id, round, APPEAL_DAYS]);
      await c.query("UPDATE cases SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now(), first_responded_at=coalesce(first_responded_at, now()), updated_at=now() WHERE id=$1", [x.case_id, i.reason.trim(), user.id]);
      await event(c, x.case_id, user.id, 'resolve', x.status, 'resolved', i.reason, { data: { outcome: i.outcome, round } });
      await bump(c, x.id, 'resolved');
      await audit(c, user.id, 'sponsorship.dispute_resolve', 'sponsorship_dispute', x.id);
      await ping(c, ctx, 'reviewer', 'A sponsorship dispute was decided', x);
      return { id: x.id, status: 'resolved', rev: x.rev + 1, round };
    });
  },
});

cap({
  name: 'appeal_sponsorship_dispute', method: 'POST', path: '/sponsorship-disputes/:id/appeal', tag: TAG,
  summary: `Either side appeals a decision once, within ${APPEAL_DAYS} days, saying why and optionally adding new evidence. The first decision stays in the history; a different reviewer decides the appeal. Needs the current \`rev\`.`,
  input: z.object({ id, rev, reason: z.string().min(5).max(2000), evidence: z.array(evidenceIn).max(5).default([]) }),
  async handler({ user }, i) {
    const prepared = i.evidence.map(prepEvidence);
    return tx(async (c) => {
      const { ctx, x, side } = await locked(c, i.id, user);
      if (side === 'reviewer') throw forbidden('Only the sponsor or the recipient can appeal');
      if (i.rev !== x.rev) throw stale();
      if (x.status !== 'resolved') throw conflict(x.status === 'appealed' ? 'This dispute is already under appeal' : `This dispute is ${x.status}; only a decided dispute can be appealed`);
      if (!x.appeal_until || new Date(x.appeal_until) < new Date()) throw conflict(`The ${APPEAL_DAYS}-day appeal window has closed`);
      if ((await c.query('SELECT 1 FROM sponsorship_dispute_appeals WHERE dispute_id=$1', [x.id])).rowCount) throw conflict('A decision can be appealed once');
      await c.query('INSERT INTO sponsorship_dispute_appeals(dispute_id, appealed_by, side, reason, decision_before) VALUES ($1,$2,$3,$4,$5)', [x.id, user.id, side, i.reason.trim(), x.resolution]);
      const due = slaDue('high');
      await c.query("UPDATE cases SET status='escalated', priority='high', resolution=NULL, resolved_by=NULL, resolved_at=NULL, escalated_at=now(), resolution_due=$2, updated_at=now() WHERE id=$1", [x.case_id, due.resolution]);
      await message(c, x.case_id, user.id, i.reason);
      await evidence(c, x.case_id, user.id, prepared);
      await event(c, x.case_id, user.id, 'appeal', 'resolved', 'escalated', i.reason, { data: { evidence: prepared.length } });
      await bump(c, x.id, 'appealed');
      await audit(c, user.id, 'sponsorship.dispute_appeal', 'sponsorship_dispute', x.id);
      await ping(c, ctx, side, 'A sponsorship dispute decision was appealed', x);
      return { id: x.id, status: 'appealed', rev: x.rev + 1 };
    });
  },
});

cap({
  name: 'withdraw_sponsorship_dispute', method: 'POST', path: '/sponsorship-disputes/:id/withdraw', tag: TAG,
  summary: 'The side that raised a dispute withdraws it before it is decided. The dispute, its evidence and its history are kept; the record stops being contested. Needs the current `rev`.',
  input: z.object({ id, rev, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, x, side } = await locked(c, i.id, user);
      if (side !== x.opened_side) throw forbidden('Only the side that raised the dispute can withdraw it');
      if (i.rev !== x.rev) throw stale();
      if (!['open', 'under_review'].includes(x.status)) throw conflict(`This dispute is ${x.status}`);
      await c.query("UPDATE cases SET status='withdrawn', updated_at=now() WHERE id=$1", [x.case_id]);
      await event(c, x.case_id, user.id, 'withdraw', x.status, 'withdrawn', i.reason);
      await bump(c, x.id, 'withdrawn');
      await ping(c, ctx, side, 'A sponsorship dispute was withdrawn', x);
      return { id: x.id, status: 'withdrawn', rev: x.rev + 1 };
    });
  },
});
