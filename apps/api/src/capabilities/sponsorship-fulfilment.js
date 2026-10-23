// Sponsored goods returns / replacements and service vouchers (#300). Built on the canonical dues of sponsorship-agreements.js:
// a return hangs off a received delivery, a replacement is an ordinary delivery that names the return, a voucher is one funded unit of a 'service' due.
// Dispatch is never receipt, goods value is an estimate (never cash), and funding a service never opens anyone's health or private data.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { obligationContext, logHistory, settleGoods, settleService, servicePosition } from '../sponsor-agreements.js';
import { ping, open } from './sponsorship-agreements.js';

const url = z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), 'evidence must be an https link');
const REASON = z.enum(['damaged', 'wrong_item', 'not_as_described', 'other']);
const stale = () => conflict('This changed while you were looking; reload it and try again', { code: 'stale_version' });

cap({
  name: 'request_sponsorship_return', method: 'POST', path: '/sponsorship-deliveries/:id/returns', tag: 'Sponsors', status: 201,
  summary: 'Recipient (or admin): report that part of a RECEIVED delivery is damaged, wrong or not as described, with optional evidence (https link). Returned quantity can never exceed what was received and not already returned. Nothing changes the received count until the sponsor accepts. `idempotency_key` makes a retry return the same request instead of a second one.',
  input: z.object({ id, quantity: z.coerce.number().int().positive(), reason: REASON, resolution: z.enum(['replace', 'credit']).default('replace').describe('what the recipient is asking for; the sponsor may answer differently'),
    note: z.string().max(500).optional(), evidence_url: url.optional(), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d0 = (await c.query('SELECT obligation_id FROM sponsorship_deliveries WHERE id=$1', [i.id])).rows[0];
      if (!d0) throw notFound('Delivery');
      const ctx = await obligationContext(c, d0.obligation_id, user);
      if (ctx.role !== 'recipient' && ctx.role !== 'admin') throw forbidden('Only the recipient reports a return');
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
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'goods_return_requested', i.note);
      await ping(c, 'sponsor', 'A return of sponsored goods was reported', ctx, 'sponsorship_delivery', 'pay');
      return row;
    });
  },
});

cap({
  name: 'decide_sponsorship_return', method: 'PATCH', path: '/sponsorship-returns/:id', tag: 'Sponsors',
  summary: 'Sponsor (pay permission): accept a return (choosing replace or credit) or dispute it (reason required). The recipient may cancel its own open request. Accepting reduces the net received quantity and re-opens a fulfilled due that is now short; a replacement is then dispatched against it. `expected_version` refuses a stale decision.',
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
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, `goods_return_${i.status}`, i.note);
      await ping(c, i.status === 'cancelled' ? 'sponsor' : ctx.recipientId, `A return of sponsored goods was ${i.status}`, ctx, 'sponsorship_delivery', 'pay');
      return row;
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
  input: z.object({ id, idempotency_key: z.string().min(8).max(80), booking_id: id.optional(), reference: z.string().max(120).optional() }),
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
      if (v.service_type === 'medical' && (i.booking_id || i.reference)) throw badRequest('A medical voucher carries no detail: it funds the service only');
      if (i.booking_id) {
        if (v.service_type !== 'venue') throw badRequest('Only a venue voucher can name a venue booking');
        const b = (await c.query("SELECT user_id, status FROM bookings WHERE id=$1", [i.booking_id])).rows[0];
        if (!b || b.user_id !== user.id || b.status !== 'confirmed') throw badRequest('Choose one of your own confirmed bookings');
        if ((await c.query('SELECT 1 FROM sponsorship_voucher_redemptions WHERE booking_id=$1', [i.booking_id])).rowCount) throw conflict('That booking already used a voucher');
      }
      await c.query('INSERT INTO sponsorship_voucher_redemptions(voucher_id, redeemed_by, idempotency_key, booking_id, reference) VALUES ($1,$2,$3,$4,$5)', [v.id, user.id, i.idempotency_key, i.booking_id ?? null, i.reference ?? null]);
      const row = (await c.query("UPDATE sponsorship_vouchers SET status='redeemed', version=version+1 WHERE id=$1 RETURNING id, status, service_type, version", [v.id])).rows[0];
      await settleService(c, ctx.o);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'voucher_redeemed');
      await ping(c, 'sponsor', 'A sponsored service voucher was redeemed', ctx, 'sponsorship_delivery', 'pay');
      return { ...row, replayed: false };
    });
  },
});
