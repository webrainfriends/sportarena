// Sponsored goods returns / replacements and service vouchers (#300). Built on the canonical dues of sponsorship-agreements.js:
// a return hangs off a received delivery, a replacement is an ordinary delivery that names the return, a voucher is one funded unit of a 'service' due.
// Dispatch is never receipt, goods value is an estimate (never cash), and funding a service never opens anyone's health or private data.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, one, many, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { obligationContext, dealContext, logHistory, settleGoods, settleService, servicePosition } from '../sponsor-agreements.js';
import { prepEvidence } from '../cases.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { toCsv } from '../csv.js';
import { createDispute } from './sponsorship-disputes.js';
import { ping, open } from './sponsorship-agreements.js';

const url = z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), 'evidence must be an https link');
const REASON = z.enum(['damaged', 'wrong_item', 'not_as_described', 'other']);
const fileIn = z.object({ label: z.string().max(120).optional(), file_name: z.string().max(120).optional(), data: z.string().min(16).max(7_200_000).describe('base64 file: PDF, JPEG, PNG or WebP, up to 5 MB') });
const FILE_COLS = 'id, label, file_name, content_type, size_bytes, created_at';
/** Store evidence files for a return (validated and encrypted like case evidence). The uploader must consent to the other side and case reviewers seeing them; a case already opened for the return receives a copy. */
async function storeFiles(c, ret, userId, files, consent) {
  if (!files.length) return [];
  if (!consent) throw badRequest('Confirm that the other side and case reviewers may see the file (consent)');
  const rows = [];
  for (const f of files) {
    const p = prepEvidence({ label: f.label, file_name: f.file_name, data: f.data });
    rows.push((await c.query(`INSERT INTO sponsorship_return_files(return_id, label, file_name, content_type, size_bytes, sha256, file_enc, added_by, consent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING ${FILE_COLS}`,
      [ret.id, p.label, p.file_name, p.content_type, p.size_bytes, p.sha256, p.file_enc, userId])).rows[0]);
    const dsp = (await c.query('SELECT case_id FROM sponsorship_disputes WHERE return_id=$1', [ret.id])).rows[0];
    if (dsp) await c.query('INSERT INTO case_evidence(case_id, label, file_name, content_type, size_bytes, sha256, file_enc, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [dsp.case_id, p.label, p.file_name, p.content_type, p.size_bytes, p.sha256, p.file_enc, userId]);
  }
  return rows;
}
const hidden = (ctx) => ctx.role === 'recipient' && ['pending', 'rejected'].includes(ctx.d.budget_approval); // the recipient sees nothing of a deal its sponsor budget has not cleared
const stale = () => conflict('This changed while you were looking; reload it and try again', { code: 'stale_version' });

cap({
  name: 'request_sponsorship_delivery_return', method: 'POST', path: '/sponsorship-deliveries/:id/returns', tag: 'Sponsors', status: 201,
  summary: 'Recipient (or admin): report that part of a RECEIVED delivery is damaged, wrong or not as described, with optional evidence (https link). Returned quantity can never exceed what was received and not already returned. Nothing changes the received count until the sponsor accepts. `idempotency_key` makes a retry return the same request instead of a second one.',
  input: z.object({ id, quantity: z.coerce.number().int().positive(), reason: REASON, resolution: z.enum(['replace', 'credit']).default('replace').describe('what the recipient is asking for; the sponsor may answer differently'),
    note: z.string().max(500).optional(), evidence_url: url.optional(), files: z.array(fileIn).max(3).default([]).describe('up to 3 photos or documents (PDF, JPEG, PNG, WebP; 5 MB each); needs consent'), consent: z.boolean().optional().describe('required with files: the other side and case reviewers may see them'),
    idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d0 = (await c.query('SELECT obligation_id FROM sponsorship_deliveries WHERE id=$1', [i.id])).rows[0];
      if (!d0) throw notFound('Delivery');
      const ctx = await obligationContext(c, d0.obligation_id, user);
      if (ctx.role !== 'recipient' && ctx.role !== 'admin') throw forbidden('Only the recipient reports a return');
      if (i.files.length && ctx.role !== 'recipient') throw forbidden('Only the recipient adds evidence files');
      const dl = (await c.query('SELECT * FROM sponsorship_deliveries WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (i.idempotency_key) {
        const again = (await c.query('SELECT * FROM sponsorship_delivery_returns WHERE delivery_id=$1 AND idempotency_key=$2', [dl.id, i.idempotency_key])).rows[0];
        if (again) return again;
      }
      if (dl.status !== 'received') throw conflict('Only goods that were received can be returned; a dispatched shipment is received or rejected instead');
      if (ctx.o.status === 'cancelled') throw conflict('This obligation was cancelled');
      const used = Number((await c.query("SELECT coalesce(sum(quantity),0) AS s FROM sponsorship_delivery_returns WHERE delivery_id=$1 AND status IN ('requested','accepted')", [dl.id])).rows[0].s);
      if (i.quantity > dl.received_quantity - used) throw conflict(`At most ${dl.received_quantity - used} more can be returned from this delivery`);
      const row = (await c.query('INSERT INTO sponsorship_delivery_returns(delivery_id, obligation_id, quantity, reason, resolution, note, evidence_url, idempotency_key, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [dl.id, ctx.o.id, i.quantity, i.reason, i.resolution, i.note ?? null, i.evidence_url ?? null, i.idempotency_key ?? null, user.id])).rows[0];
      await storeFiles(c, row, user.id, i.files, i.consent);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'goods_return_requested', i.note);
      await ping(c, 'sponsor', 'A return of sponsored goods was reported', ctx, 'sponsorship_delivery', 'pay');
      return row;
    });
  },
});

cap({
  name: 'decide_sponsorship_delivery_return', method: 'PATCH', path: '/sponsorship-delivery-returns/:id', tag: 'Sponsors',
  summary: 'Sponsor (pay permission): accept a return (choosing replace or credit) or dispute it (reason required): a dispute opens a case in the sponsorship dispute system linked to this return, and both sides then see its number and status on the return. The recipient may cancel its own open request. Accepting reduces the net received quantity and re-opens a fulfilled due that is now short; a replacement is then dispatched against it. `expected_version` refuses a stale decision.',
  input: z.object({ id, status: z.enum(['accepted', 'disputed', 'cancelled']), resolution: z.enum(['replace', 'credit']).optional(), note: z.string().max(500).optional(), expected_version: z.coerce.number().int().positive().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r0 = (await c.query('SELECT obligation_id FROM sponsorship_delivery_returns WHERE id=$1', [i.id])).rows[0];
      if (!r0) throw notFound('Return');
      const ctx = await obligationContext(c, r0.obligation_id, user);
      if (i.status === 'cancelled') { if (ctx.role !== 'recipient' && ctx.role !== 'admin') throw forbidden('Only the recipient cancels its own request'); }
      else if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor answers a return');
      else ctx.need('pay', 'answer a return');
      const r = (await c.query('SELECT * FROM sponsorship_delivery_returns WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (i.expected_version != null && i.expected_version !== r.version) throw stale();
      if (r.status !== 'requested') throw conflict(`This return is already ${r.status}`);
      if (i.status === 'disputed' && !i.note) throw badRequest('Say why the return is disputed');
      const row = (await c.query('UPDATE sponsorship_delivery_returns SET status=$2, resolution=coalesce($3, resolution), decided_by=$4, decided_at=now(), decision_note=$5, version=version+1 WHERE id=$1 RETURNING *',
        [r.id, i.status, i.status === 'accepted' ? i.resolution ?? null : null, user.id, i.note ?? null])).rows[0];
      if (i.status === 'accepted') await settleGoods(c, ctx.o);
      let dispute = null;
      if (i.status === 'disputed') {
        // a disputed return is escalated into the existing dispute system as a goods dispute linked to this return; the files already on it go with it
        const files = (await c.query('SELECT label, file_name, content_type, size_bytes, sha256, file_enc FROM sponsorship_return_files WHERE return_id=$1 ORDER BY created_at, id', [r.id])).rows.map((f) => ({ ...f, reference_enc: null }));
        if (r.evidence_url) files.push({ label: 'Link from the return request', reference_enc: encrypt(r.evidence_url, 'case_evidence.reference'), file_name: null, content_type: null, size_bytes: null, sha256: null, file_enc: null });
        const x = await createDispute(c, ctx, 'sponsor', user, { id: ctx.d.id, subject_type: 'goods', subject_id: r.delivery_id, title: `Return of ${r.quantity} disputed`, description: i.note, evidence: [] }, files, r.id);
        dispute = { id: x.id, case_no: x.case_no, status: x.status };
      }
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, `goods_return_${i.status}`, i.note);
      await ping(c, i.status === 'cancelled' ? 'sponsor' : ctx.recipientId, `A return of sponsored goods was ${i.status}`, ctx, 'sponsorship_delivery', 'pay');
      return { ...row, dispute };
    });
  },
});

cap({
  name: 'issue_sponsorship_vouchers', method: 'POST', path: '/sponsorship-obligations/:id/vouchers', tag: 'Sponsors', status: 201,
  summary: 'Sponsor (pay permission): issue vouchers against a funded service due (coaching, venue, travel or medical). Issued-and-usable plus redeemed vouchers can never exceed the committed units; void or expired vouchers free their unit. A voucher pays for the service only: it never carries or grants access to health, clinical or other private information.',
  input: z.object({ id, count: z.coerce.number().int().min(1).max(50).default(1), valid_until: z.string().date().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await obligationContext(c, i.id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor issues vouchers');
      ctx.need('pay', 'issue vouchers');
      open(ctx, 'service');
      if (i.valid_until && (await c.query('SELECT $1::date < current_date AS past', [i.valid_until])).rows[0].past) throw badRequest('valid_until is in the past');
      const pos = await servicePosition(c, ctx.o);
      if (i.count > pos.to_issue) throw conflict(`Only ${pos.to_issue} more voucher(s) can be issued against this due`);
      const type = (await c.query('SELECT service_type FROM sponsorship_lines WHERE id=$1', [ctx.o.line_id])).rows[0].service_type;
      const rows = [];
      for (let n = 0; n < i.count; n++) rows.push((await c.query('INSERT INTO sponsorship_vouchers(obligation_id, service_type, valid_until, issued_by) VALUES ($1,$2,$3,$4) RETURNING *', [ctx.o.id, type, i.valid_until ?? null, user.id])).rows[0]);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'vouchers_issued');
      await ping(c, ctx.recipientId, 'Sponsored service vouchers were issued', ctx, 'sponsorship_delivery');
      return { vouchers: rows };
    });
  },
});

cap({
  name: 'void_sponsorship_voucher', method: 'PATCH', path: '/sponsorship-vouchers/:id', tag: 'Sponsors',
  summary: 'Sponsor (pay permission): void a voucher that has not been redeemed (reason required); its unit can then be re-issued. A redeemed voucher can never be voided. `expected_version` refuses a stale change.',
  input: z.object({ id, reason: z.string().min(1).max(500), expected_version: z.coerce.number().int().positive().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v0 = (await c.query('SELECT obligation_id FROM sponsorship_vouchers WHERE id=$1', [i.id])).rows[0];
      if (!v0) throw notFound('Voucher');
      const ctx = await obligationContext(c, v0.obligation_id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor voids a voucher');
      ctx.need('pay', 'void vouchers');
      const v = (await c.query('SELECT * FROM sponsorship_vouchers WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (i.expected_version != null && i.expected_version !== v.version) throw stale();
      if (v.status !== 'issued') throw conflict(`This voucher is already ${v.status}`);
      const row = (await c.query("UPDATE sponsorship_vouchers SET status='void', void_reason=$2, voided_by=$3, version=version+1 WHERE id=$1 RETURNING *", [v.id, i.reason, user.id])).rows[0];
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'voucher_voided', i.reason);
      return row;
    });
  },
});

cap({
  name: 'redeem_sponsorship_voucher', method: 'POST', path: '/sponsorship-vouchers/:id/redeem', tag: 'Sponsors',
  summary: 'Authorised recipient: redeem one voucher. Safe to retry: the same `idempotency_key` from the same person returns the original redemption (replayed), anything else on a redeemed voucher is refused, and the database allows one redemption per voucher even under a race. A venue voucher may name one of your own confirmed venue bookings (each booking funds one voucher); coaching and travel vouchers take a short reference. Medical vouchers take no detail at all and give the sponsor no access to health or clinical information.',
  input: z.object({ id, idempotency_key: z.string().min(8).max(80), booking_id: id.optional(), hire_id: id.optional().describe('coaching voucher: one of your own confirmed or completed coaching sessions (see list_my_hires)'), reference: z.string().max(120).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v0 = (await c.query('SELECT obligation_id FROM sponsorship_vouchers WHERE id=$1', [i.id])).rows[0];
      if (!v0) throw notFound('Voucher');
      const ctx = await obligationContext(c, v0.obligation_id, user);
      if (ctx.role !== 'recipient') throw forbidden('Only the authorised recipient redeems a voucher');
      const v = (await c.query('SELECT * FROM sponsorship_vouchers WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const done = (await c.query('SELECT * FROM sponsorship_voucher_redemptions WHERE voucher_id=$1', [v.id])).rows[0];
      if (done) {
        if (done.idempotency_key === i.idempotency_key && done.redeemed_by === user.id) return { voucher_id: v.id, status: 'redeemed', redeemed_at: done.redeemed_at, replayed: true };
        throw conflict('This voucher has already been redeemed');
      }
      if (v.status === 'void') throw conflict('This voucher was voided');
      if ((await c.query('SELECT valid_until < current_date AS lapsed FROM sponsorship_vouchers WHERE id=$1', [v.id])).rows[0].lapsed) throw conflict('This voucher has expired');
      open(ctx, 'service');
      if (v.service_type === 'medical' && (i.booking_id || i.hire_id || i.reference)) throw badRequest('A medical voucher carries no detail: it funds the service only');
      if (i.booking_id) {
        if (v.service_type !== 'venue') throw badRequest('Only a venue voucher can name a venue booking');
        const b = (await c.query("SELECT user_id, status FROM bookings WHERE id=$1", [i.booking_id])).rows[0];
        if (!b || b.user_id !== user.id || b.status !== 'confirmed') throw badRequest('Choose one of your own confirmed bookings');
        if ((await c.query('SELECT 1 FROM sponsorship_voucher_redemptions WHERE booking_id=$1', [i.booking_id])).rowCount) throw conflict('That booking already used a voucher');
      }
      if (i.hire_id) {
        if (v.service_type !== 'coaching') throw badRequest('Only a coaching voucher can name a coaching session');
        const h = (await c.query('SELECT hirer_id, status FROM coach_hires WHERE id=$1', [i.hire_id])).rows[0];
        if (!h || h.hirer_id !== user.id || !['confirmed', 'completed'].includes(h.status)) throw badRequest('Choose one of your own confirmed coaching sessions');
        if ((await c.query('SELECT 1 FROM sponsorship_voucher_redemptions WHERE hire_id=$1', [i.hire_id])).rowCount) throw conflict('That coaching session already used a voucher');
      }
      await c.query('INSERT INTO sponsorship_voucher_redemptions(voucher_id, redeemed_by, idempotency_key, booking_id, hire_id, reference) VALUES ($1,$2,$3,$4,$5,$6)', [v.id, user.id, i.idempotency_key, i.booking_id ?? null, i.hire_id ?? null, i.reference ?? null]);
      const row = (await c.query("UPDATE sponsorship_vouchers SET status='redeemed', version=version+1 WHERE id=$1 RETURNING id, status, service_type, version", [v.id])).rows[0];
      await settleService(c, ctx.o);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'voucher_redeemed');
      await ping(c, 'sponsor', 'A sponsored service voucher was redeemed', ctx, 'sponsorship_delivery', 'pay');
      return { ...row, replayed: false };
    });
  },
});

cap({
  name: 'add_sponsorship_return_files', method: 'POST', path: '/sponsorship-delivery-returns/:id/files', tag: 'Sponsors', status: 201,
  summary: 'Either side adds photos or documents (PDF, JPEG, PNG, WebP; up to 5 MB, 3 at a time, 10 per return) to an open or disputed return. `consent` must be true: the other side and case reviewers may see the file. Files are encrypted, record who added them and when, and are copied to the return\'s dispute case if there is one. A young person\'s guardian adds them, never the young person.',
  input: z.object({ id, files: z.array(fileIn).min(1).max(3), consent: z.literal(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r0 = (await c.query('SELECT obligation_id FROM sponsorship_delivery_returns WHERE id=$1', [i.id])).rows[0];
      if (!r0) throw notFound('Return');
      const ctx = await obligationContext(c, r0.obligation_id, user);
      if (ctx.role !== 'recipient' && ctx.role !== 'sponsor') throw forbidden('Only the sponsor or the recipient adds evidence');
      if (ctx.role === 'sponsor') ctx.need('pay', 'add evidence to a return');
      const r = (await c.query('SELECT * FROM sponsorship_delivery_returns WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!['requested', 'disputed'].includes(r.status)) throw conflict(`A ${r.status} return takes no more evidence`);
      if ((await c.query('SELECT count(*)::int AS n FROM sponsorship_return_files WHERE return_id=$1', [r.id])).rows[0].n + i.files.length > 10) throw conflict('A return holds at most 10 files');
      const rows = await storeFiles(c, r, user.id, i.files, i.consent);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'goods_return_evidence_added');
      await audit(c, user.id, 'sponsorship.return_files_add', 'sponsorship_delivery_return', r.id);
      return { files: rows };
    });
  },
});

cap({
  name: 'get_sponsorship_return_file', method: 'GET', path: '/sponsorship-delivery-returns/:id/files/:file_id', tag: 'Sponsors',
  summary: 'The decrypted file (base64) of one return evidence file. Only the sponsor side and the recipient side of that agreement; every read is audit-logged. Files of other returns can not be reached from here.',
  input: z.object({ id, file_id: id }),
  async handler({ user }, i) {
    const r = await one('SELECT obligation_id FROM sponsorship_delivery_returns WHERE id=$1', [i.id]);
    if (!r) throw notFound('Return');
    const sid = (await one('SELECT sponsorship_id FROM sponsorship_obligations WHERE id=$1', [r.obligation_id])).sponsorship_id;
    const ctx = await dealContext(pool, sid, user);
    if (ctx.role === 'admin' || hidden(ctx)) throw notFound('File');
    if (ctx.role === 'sponsor') ctx.need('pay', 'read return evidence');
    const f = await one('SELECT * FROM sponsorship_return_files WHERE id=$1 AND return_id=$2', [i.file_id, i.id]);
    if (!f) throw notFound('File');
    await audit(null, user.id, 'sponsorship.return_file_read', 'sponsorship_delivery_return', i.id);
    return { id: f.id, label: f.label, file_name: f.file_name, content_type: f.content_type, size_bytes: f.size_bytes, sha256: f.sha256, created_at: f.created_at, data: decrypt(f.file_enc, 'case_evidence.file') };
  },
});

cap({
  name: 'export_sponsorship_fulfilment', method: 'GET', path: '/sponsorships/:id/fulfilment/export', tag: 'Sponsors',
  summary: 'CSV of an agreement\'s deliveries, returns and vouchers: kind, line, status, quantity and dates. Only the sponsor side (export permission) and the recipient side of that agreement; others get 404/403. Never includes evidence, notes, references, bookings, coaching sessions or anything medical.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (hidden(ctx)) throw notFound('Sponsorship');
    if (ctx.role === 'admin') throw forbidden('Only the sponsor or the recipient can export');
    if (ctx.role === 'sponsor') ctx.need('export', 'export deliveries, returns and vouchers');
    const rows = await many(
      `SELECT 'delivery' AS kind, l.label, x.status, x.quantity, x.received_quantity AS settled_quantity, NULL::text AS service, x.created_at AS recorded_at, NULL::timestamptz AS closed_at
         FROM sponsorship_deliveries x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1
       UNION ALL
       SELECT 'return', l.label, x.status, x.quantity, CASE WHEN x.status='accepted' THEN x.quantity END, NULL, x.created_at, x.decided_at
         FROM sponsorship_delivery_returns x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1
       UNION ALL
       SELECT 'voucher', l.label, (CASE WHEN x.status='issued' AND x.valid_until < current_date THEN 'expired' ELSE x.status END), 1, CASE WHEN x.status='redeemed' THEN 1 END, x.service_type, x.created_at,
              (SELECT r.redeemed_at FROM sponsorship_voucher_redemptions r WHERE r.voucher_id=x.id)
         FROM sponsorship_vouchers x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1
       ORDER BY recorded_at, kind`, [i.id]);
    await audit(null, user.id, 'sponsorship.fulfilment_export', 'sponsorship', i.id);
    const cols = ['kind', 'label', 'status', 'quantity', 'settled_quantity', 'service', 'recorded_at', 'closed_at'];
    return { filename: `fulfilment-${ctx.d.agreement_ref ?? ctx.d.id}.csv`, rows: rows.length, csv: toCsv(cols, rows) };
  },
});
