// Agreement deliverables (#519): appearances, content, social posts, hospitality, challenge rewards and activations that are NOT dated money/goods dues.
// Each has an owner side, a due date, an evidence requirement and a reviewer: the OTHER side. It is accepted only by that reviewer's decision after evidence
// exists; the end of an event, a due date or a term never completes anything. Exceptions (postpone / waive) are requests the other side decides.
// Dated endorsements, goods and money stay in the canonical dues of sponsorship-agreements.js; this does not duplicate them.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { prepEvidence } from '../cases.js';
import { dealContext } from '../sponsor-agreements.js';
import { notifySponsor } from '../sponsor-access.js';
import { notifyRecipient } from '../youth-sponsorship.js';
import { DELIVERABLE_KINDS, RUNNING, deliverableState, today } from '../sponsor-roi.js';

const TAG = 'Sponsors';
const date = z.string().date();
const https = z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), 'evidence must be an https link');
const fileIn = z.object({ label: z.string().max(120).optional(), file_name: z.string().max(120).optional(), data: z.string().min(16).max(7_200_000).describe('base64 file: PDF, JPEG, PNG or WebP, up to 5 MB') });
const stale = () => conflict('This changed while you were looking; reload it and try again', { code: 'stale_version' });
const log = (c, id, actor, action, note) => c.query('INSERT INTO sponsorship_deliverable_log(deliverable_id, actor_id, action, note) VALUES ($1,$2,$3,$4)', [id, actor, action, note ?? null]);
const COLS = "d.id, d.sponsorship_id, d.booking_id, d.kind, d.title, d.brief, d.owed_by, d.owner_user_id, d.due_on::text AS due_on, d.evidence_required, d.status, d.rev, d.reviewed_at, d.review_note, d.created_at";

// notices carry no title or note: the people on the other side open the agreement to read it
const ping = (c, to, ctx) => {
  const msg = { kind: 'sponsorship_deliverable', title: 'A deliverable needs your attention', body: `Open the ${ctx.sp.name} agreement to see it.`, data: { sponsorship_id: ctx.d.id } };
  return to === 'sponsor' ? notifySponsor(c, ctx.sp, 'performance', msg, ctx.d.department_id) : notifyRecipient(c, ctx.recipientId, msg);
};

/** The side that acts as deliverable owner / reviewer, and what that side may do. */
function side(ctx, x) {
  if (ctx.role === 'admin') throw forbidden('Admins read deliverables; the two sides act on them');
  const mine = ctx.role;
  const owner = x.owed_by === mine;
  return { mine, owner, reviewer: !owner };
}
async function load(c, did, user, { write = true } = {}) {
  const x = (await c.query('SELECT * FROM sponsorship_deliverables WHERE id=$1 FOR UPDATE', [did])).rows[0];
  if (!x) throw notFound('Deliverable');
  const ctx = await dealContext(c, x.sponsorship_id, user, { lock: write });
  if (ctx.role === 'sponsor') ctx.need(write ? 'evaluate' : 'roi', write ? 'act on deliverables' : 'read deliverables');
  return { x, ctx };
}
const running = (ctx) => { if (!RUNNING.includes(ctx.d.status)) throw conflict(`The agreement is ${ctx.d.status}; deliverables can be worked once it has been accepted`); };

cap({
  name: 'create_sponsorship_deliverable', method: 'POST', path: '/sponsorships/:id/deliverables', tag: TAG, status: 201,
  summary: 'Add a deliverable to an accepted agreement: an agreed appearance, content, social post, hospitality, challenge reward or activation. Name who owes it (`recipient` or `sponsor`), the due date (inside the agreement term), what evidence completes it (a link, a file or either) and optionally the inventory booking it belongs to. The other side reviews it; it is never complete just because a date or an event has passed. Either side can add one; the sponsor side needs the evaluate permission.',
  input: z.object({ id, kind: z.enum(DELIVERABLE_KINDS), title: z.string().trim().min(2).max(160), brief: z.string().trim().max(1000).optional(), owed_by: z.enum(['recipient', 'sponsor']), due_on: date,
    evidence_required: z.enum(['link', 'file', 'either']).default('either'), booking_id: id.optional(), owner_user_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role === 'admin') throw forbidden('Admins read deliverables; the two sides add them');
      if (ctx.role === 'sponsor') ctx.need('evaluate', 'add deliverables');
      if (ctx.d.status !== 'active') throw conflict('Deliverables are added to an active agreement');
      if ((ctx.d.starts && i.due_on < ctx.d.starts) || (ctx.d.ends && i.due_on > ctx.d.ends)) throw badRequest('The due date is outside the agreement term');
      if (i.booking_id && !(await c.query("SELECT 1 FROM sponsor_inventory_bookings WHERE id=$1 AND sponsorship_id=$2 AND status='confirmed'", [i.booking_id, ctx.d.id])).rowCount) throw badRequest('That booking is not a live booking of this agreement');
      const owner = i.owner_user_id ?? user.id;
      if (![user.id, ctx.recipientId, ctx.sp.owner_id].includes(owner)) throw badRequest('The named owner must be you or the main contact of either side');
      const row = (await c.query(`INSERT INTO sponsorship_deliverables(sponsorship_id, booking_id, kind, title, brief, owed_by, owner_user_id, due_on, evidence_required, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS.replace(/d\./g, '').replace('due_on::text AS due_on', 'due_on::text AS due_on')}`,
        [ctx.d.id, i.booking_id ?? null, i.kind, i.title, i.brief ?? null, i.owed_by, owner, i.due_on, i.evidence_required, user.id])).rows[0];
      await log(c, row.id, user.id, 'created', i.title);
      await ping(c, ctx.role === 'sponsor' ? 'recipient' : 'sponsor', ctx);
      return { ...row, state: deliverableState(row) };
    });
  },
});

cap({
  name: 'list_sponsorship_deliverables', method: 'GET', path: '/sponsorships/:id/deliverables', tag: TAG,
  summary: 'The deliverables of an agreement (both sides; sponsor-side members need the roi permission) with their derived state (upcoming, overdue, awaiting_review, rework, accepted, excepted, cancelled), evidence items (metadata only), exceptions and history. Evidence files are fetched one at a time and audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tx((c) => dealContext(c, i.id, user));
    if (ctx.role === 'sponsor') ctx.need('roi', 'read deliverables');
    const rows = await many(`SELECT ${COLS}, (SELECT coalesce(json_agg(json_build_object('id', e.id, 'label', e.label, 'url', e.url, 'file_name', e.file_name, 'content_type', e.content_type, 'size_bytes', e.size_bytes, 'sha256', e.sha256, 'submitted_by', e.submitted_by, 'created_at', e.created_at) ORDER BY e.created_at), '[]') FROM sponsorship_deliverable_evidence e WHERE e.deliverable_id=d.id) AS evidence,
        (SELECT coalesce(json_agg(json_build_object('id', x.id, 'kind', x.kind, 'reason', x.reason, 'new_due_on', x.new_due_on::text, 'status', x.status, 'requested_at', x.requested_at, 'decided_at', x.decided_at, 'decision_note', x.decision_note) ORDER BY x.requested_at), '[]') FROM sponsorship_deliverable_exceptions x WHERE x.deliverable_id=d.id) AS exceptions,
        (SELECT coalesce(json_agg(json_build_object('action', l.action, 'note', l.note, 'at', l.created_at) ORDER BY l.id), '[]') FROM sponsorship_deliverable_log l WHERE l.deliverable_id=d.id) AS history
      FROM sponsorship_deliverables d WHERE d.sponsorship_id=$1 ORDER BY d.due_on, d.id`, [ctx.d.id]);
    return rows.map((r) => ({ ...r, state: deliverableState(r), you_owe: r.owed_by === ctx.role, you_review: ctx.role !== 'admin' && r.owed_by !== ctx.role }));
  },
});

cap({
  name: 'submit_deliverable_evidence', method: 'POST', path: '/sponsorship-deliverables/:id/evidence', tag: TAG, status: 201,
  summary: 'The side that owes a deliverable submits evidence (an https link and/or up to 3 files: PDF, JPEG, PNG, WebP, 5 MB each, encrypted at rest). The evidence must meet what the deliverable requires (link, file or either); it then waits for the other side\'s review. Files are shown only to the two sides of the agreement. `expected_rev` refuses a stale submission.',
  input: z.object({ id, url: https.optional(), label: z.string().trim().max(120).optional(), files: z.array(fileIn).max(3).default([]), expected_rev: z.coerce.number().int().min(1).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { x, ctx } = await load(c, i.id, user);
      running(ctx);
      if (!side(ctx, x).owner) throw forbidden('Only the side that owes this deliverable submits evidence');
      if (!['planned', 'rework', 'submitted'].includes(x.status)) throw conflict(`This deliverable is ${x.status}`);
      if (i.expected_rev && i.expected_rev !== x.rev) throw stale();
      if (!i.url && !i.files.length) throw badRequest('Add a link or a file as evidence');
      for (const f of i.files) {
        const p = prepEvidence({ label: f.label ?? i.label, file_name: f.file_name, data: f.data });
        await c.query('INSERT INTO sponsorship_deliverable_evidence(deliverable_id, label, file_name, content_type, size_bytes, sha256, file_enc, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [x.id, p.label, p.file_name, p.content_type, p.size_bytes, p.sha256, p.file_enc, user.id]);
      }
      if (i.url) await c.query('INSERT INTO sponsorship_deliverable_evidence(deliverable_id, label, url, submitted_by) VALUES ($1,$2,$3,$4)', [x.id, i.label ?? null, i.url, user.id]);
      const have = (await c.query('SELECT count(*) FILTER (WHERE url IS NOT NULL)::int AS links, count(*) FILTER (WHERE file_enc IS NOT NULL)::int AS files FROM sponsorship_deliverable_evidence WHERE deliverable_id=$1', [x.id])).rows[0];
      const met = x.evidence_required === 'link' ? have.links > 0 : x.evidence_required === 'file' ? have.files > 0 : have.links + have.files > 0;
      const status = met ? 'submitted' : x.status;
      const row = (await c.query(`UPDATE sponsorship_deliverables d SET status=$2, rev=rev+1, updated_at=now() WHERE id=$1 RETURNING ${COLS}`, [x.id, status])).rows[0];
      await log(c, x.id, user.id, met ? 'evidence_submitted' : 'evidence_added', met ? null : `still needs ${x.evidence_required === 'link' ? 'a link' : 'a file'}`);
      if (met) await ping(c, ctx.role === 'sponsor' ? 'recipient' : 'sponsor', ctx);
      return { ...row, state: deliverableState(row), evidence_met: met };
    });
  },
});

cap({
  name: 'get_deliverable_evidence_file', method: 'GET', path: '/sponsorship-deliverable-evidence/:id', tag: TAG,
  summary: 'Open one evidence file of a deliverable (base64). Only the two sides of the agreement (sponsor side with the roi permission); the read is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query('SELECT * FROM sponsorship_deliverable_evidence WHERE id=$1', [i.id])).rows[0];
      if (!e) throw notFound('Evidence');
      const { ctx } = await load(c, e.deliverable_id, user, { write: false });
      if (!e.file_enc) return { id: e.id, label: e.label, url: e.url };
      await audit(c, user.id, 'sponsorship.deliverable_evidence.read', 'sponsorship_deliverable_evidence', e.id);
      return { id: e.id, label: e.label, file_name: e.file_name, content_type: e.content_type, size_bytes: e.size_bytes, sha256: e.sha256, data: decrypt(e.file_enc, 'case_evidence.file') };
    });
  },
});

cap({
  name: 'review_sponsorship_deliverable', method: 'PATCH', path: '/sponsorship-deliverables/:id/review', tag: TAG,
  summary: 'The OTHER side from the one that owes the deliverable accepts it or sends it back for rework (a note is required). Acceptance needs evidence that meets the requirement and records who accepted and when; the owner cannot accept their own work, and nothing completes by time or by the event ending. The sponsor side needs the evaluate permission. `expected_rev` refuses a stale decision.',
  input: z.object({ id, decision: z.enum(['accept', 'rework']), note: z.string().trim().max(500).optional(), expected_rev: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { x, ctx } = await load(c, i.id, user);
      running(ctx);
      if (!side(ctx, x).reviewer) throw forbidden('The other side reviews: you cannot accept your own deliverable');
      if (x.rev !== i.expected_rev) throw stale();
      if (x.status !== 'submitted') throw conflict(`Only a submitted deliverable is reviewed (it is ${x.status})`);
      if (i.decision === 'rework' && !i.note) throw badRequest('Say what needs to change (note)');
      const ev = (await c.query('SELECT count(*) FILTER (WHERE url IS NOT NULL)::int AS links, count(*) FILTER (WHERE file_enc IS NOT NULL)::int AS files FROM sponsorship_deliverable_evidence WHERE deliverable_id=$1', [x.id])).rows[0];
      const met = x.evidence_required === 'link' ? ev.links > 0 : x.evidence_required === 'file' ? ev.files > 0 : ev.links + ev.files > 0;
      if (i.decision === 'accept' && !met) throw conflict('The evidence required for this deliverable is not in yet');
      const row = (await c.query(`UPDATE sponsorship_deliverables d SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4, rev=rev+1, updated_at=now() WHERE id=$1 RETURNING ${COLS}`, [x.id, i.decision === 'accept' ? 'accepted' : 'rework', user.id, i.note ?? null])).rows[0];
      await log(c, x.id, user.id, i.decision === 'accept' ? 'accepted' : 'sent_back', i.note);
      await ping(c, ctx.role === 'sponsor' ? 'recipient' : 'sponsor', ctx);
      return { ...row, state: deliverableState(row) };
    });
  },
});

cap({
  name: 'request_deliverable_exception', method: 'POST', path: '/sponsorship-deliverables/:id/exception', tag: TAG, status: 201,
  summary: 'The side that owes a deliverable asks the other side to postpone it (a new due date) or waive it, with a reason. Until the other side approves, nothing changes and an overdue deliverable stays overdue. One open request per deliverable.',
  input: z.object({ id, kind: z.enum(['postpone', 'waive']), reason: z.string().trim().min(3).max(500), new_due_on: date.optional() }).refine((x) => (x.kind === 'postpone') === !!x.new_due_on, 'A postponement names the new due date; a waiver does not'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { x, ctx } = await load(c, i.id, user);
      running(ctx);
      if (!side(ctx, x).owner) throw forbidden('Only the side that owes this deliverable asks for an exception');
      if (!['planned', 'rework', 'submitted'].includes(x.status)) throw conflict(`This deliverable is ${x.status}`);
      if (i.new_due_on && (i.new_due_on <= x.due_on || (ctx.d.ends && i.new_due_on > ctx.d.ends))) throw badRequest('The new due date must be later than the current one and inside the agreement term');
      try {
        const row = (await c.query('INSERT INTO sponsorship_deliverable_exceptions(deliverable_id, kind, reason, new_due_on, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, reason, new_due_on::text AS new_due_on, status, requested_at', [x.id, i.kind, i.reason, i.new_due_on ?? null, user.id])).rows[0];
        await log(c, x.id, user.id, `exception_requested_${i.kind}`, i.reason);
        await ping(c, ctx.role === 'sponsor' ? 'recipient' : 'sponsor', ctx);
        return row;
      } catch (e) { if (e.code === '23505') throw conflict('There is already an open exception request for this deliverable'); throw e; }
    });
  },
});

cap({
  name: 'decide_deliverable_exception', method: 'PATCH', path: '/sponsorship-deliverable-exceptions/:id', tag: TAG,
  summary: 'The other side approves or declines an exception request. Approving a postponement moves the due date; approving a waiver marks the deliverable excepted (counted separately from completed, never as accepted). A decline note is required.',
  input: z.object({ id, decision: z.enum(['approve', 'decline']), note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query('SELECT * FROM sponsorship_deliverable_exceptions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!e) throw notFound('Exception');
      const { x, ctx } = await load(c, e.deliverable_id, user);
      running(ctx);
      if (!side(ctx, x).reviewer) throw forbidden('The other side decides an exception');
      if (e.status !== 'requested') throw conflict(`This request was already ${e.status}`);
      if (i.decision === 'decline' && !i.note) throw badRequest('Say why it is declined (note)');
      await c.query('UPDATE sponsorship_deliverable_exceptions SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1', [e.id, i.decision === 'approve' ? 'approved' : 'declined', user.id, i.note ?? null]);
      if (i.decision === 'approve') {
        if (e.kind === 'postpone') await c.query('UPDATE sponsorship_deliverables SET due_on=$2, rev=rev+1, updated_at=now() WHERE id=$1', [x.id, e.new_due_on]);
        else await c.query("UPDATE sponsorship_deliverables SET status='excepted', rev=rev+1, updated_at=now() WHERE id=$1", [x.id]);
      }
      await log(c, x.id, user.id, `exception_${i.decision === 'approve' ? 'approved' : 'declined'}`, i.note);
      await ping(c, ctx.role === 'sponsor' ? 'recipient' : 'sponsor', ctx);
      const row = (await c.query(`SELECT ${COLS} FROM sponsorship_deliverables d WHERE id=$1`, [x.id])).rows[0];
      return { ...row, state: deliverableState(row) };
    });
  },
});

cap({
  name: 'cancel_sponsorship_deliverable', method: 'POST', path: '/sponsorship-deliverables/:id/cancel', tag: TAG,
  summary: 'Cancel a deliverable (kept as history, counted as cancelled). The side it is owed TO may cancel it at any time before acceptance; the side that owes it may only cancel one it created itself that has no evidence yet — otherwise it asks for a waiver. A reason is required.',
  input: z.object({ id, reason: z.string().trim().min(3).max(500), expected_rev: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { x, ctx } = await load(c, i.id, user);
      running(ctx);
      const s = side(ctx, x);
      if (x.rev !== i.expected_rev) throw stale();
      if (!['planned', 'rework', 'submitted'].includes(x.status)) throw conflict(`This deliverable is ${x.status}`);
      if (s.owner) {
        const evid = (await c.query('SELECT 1 FROM sponsorship_deliverable_evidence WHERE deliverable_id=$1', [x.id])).rowCount;
        if (x.created_by !== user.id || evid) throw forbidden('The side that owes a deliverable asks for a waiver instead of cancelling it');
      }
      const row = (await c.query(`UPDATE sponsorship_deliverables d SET status='cancelled', rev=rev+1, updated_at=now() WHERE id=$1 RETURNING ${COLS}`, [x.id])).rows[0];
      await log(c, x.id, user.id, 'cancelled', i.reason);
      return { ...row, state: deliverableState(row), today: today() };
    });
  },
});
