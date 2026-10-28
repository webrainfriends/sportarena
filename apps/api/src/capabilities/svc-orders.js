// Supplier services (#458) 4/5 — purchase / service orders: confirmation (with capacity), agreement acknowledgement, variations, pause / resume /
// reschedule / partial cancellation / termination, and the order views for both sides. Procurement, fulfilment, billing and settlement stay separate states.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { myBuyerIds, myProfileIds, log, supplierAccess, buyerAccess } from '../svc/access.js';
import { approvalNeeded, handlers } from '../svc/approvals.js';
import { loadOrder, orderSide, anySide, isOwnSupplier, activeLines, previewVariation, applyVariation, refreshOrder, reserveForOrder, cancelOrderRecords, q1 } from '../svc/orders.js';
import { commitOrder } from '../svc/budget.js';
import { release } from '../svc/capacity.js';
import { supplierAudience, buyerAudience } from './svc-rfq.js';
import { notify } from '../notify.js';

const TAG = 'Service orders';
const ts = z.string().datetime({ offset: true });
const day = z.string().date();
const tell = async (c, users, msg, actor) => { for (const u of new Set(users)) if (u !== actor) await notify(c, u, msg); };

// ---------------------------------------------------------------- reading
cap({
  name: 'list_service_orders', method: 'GET', path: '/service-orders', tag: TAG,
  summary: 'Orders you can see: as a buyer (side=buyer, optionally one procurement context) or as a supplier (side=supplier, optionally one profile). Procurement, fulfilment, billing and settlement are separate fields.',
  input: z.object({ side: z.enum(['buyer', 'supplier']), buyer_id: id.optional(), profile_id: id.optional(), status: z.string().optional(), event_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const bs = i.side === 'buyer' ? await myBuyerIds(user) : [];
    const ps = i.side === 'supplier' ? await myProfileIds(user) : [];
    if (i.buyer_id && !bs.includes(i.buyer_id)) throw notFound('Buyer');
    if (i.profile_id && !ps.includes(i.profile_id)) throw notFound('Supplier');
    return many(
      `SELECT o.id, o.number, o.status, o.fulfilment, o.billing, o.settlement, o.currency, o.net_minor, o.tax_minor, o.gross_minor, o.event_id, o.venue_id, o.buyer_id, o.profile_id, o.created_at, o.confirmed_at,
              coalesce(p.trading_name, p.legal_name) AS supplier_name, b.name AS buyer_name, r.scope->>'category' AS category, r.title
         FROM svc_orders o JOIN svc_profiles p ON p.id=o.profile_id JOIN svc_buyers b ON b.id=o.buyer_id LEFT JOIN svc_rfqs r ON r.id=o.rfq_id
        WHERE (($1='buyer' AND o.buyer_id = ANY($2)) OR ($1='supplier' AND o.profile_id = ANY($3))) AND ($4::uuid IS NULL OR o.buyer_id=$4) AND ($5::uuid IS NULL OR o.profile_id=$5)
          AND ($6::text IS NULL OR o.status=$6) AND ($7::uuid IS NULL OR o.event_id=$7) ORDER BY o.created_at DESC, o.id LIMIT $8 OFFSET $9`,
      [i.side, bs, ps, i.buyer_id ?? null, i.profile_id ?? null, i.status ?? null, i.event_id ?? null, i.limit, i.offset]);
  },
});
cap({
  name: 'get_service_order', method: 'GET', path: '/service-orders/:id', tag: TAG,
  summary: 'One order with typed goods/service lines (ordered / accepted / invoiced quantities), variations, capacity, visits and invoices. Supplier staff never see the buyer’s other bids or finance.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const o = await one('SELECT * FROM svc_orders WHERE id=$1', [i.id]);
    if (!o) throw notFound('Order');
    const { sup, buy } = await tx((cc) => anySide(user, o, cc));
    const [lines, variations, allocations, visits, invoices] = await Promise.all([
      many('SELECT * FROM svc_order_lines WHERE order_id=$1 ORDER BY line_no', [o.id]),
      many('SELECT id, version, kind, reason, effective_on, delta_net_minor, delta_tax_minor, proposed_side, counterparty_status, status, impact, created_at, applied_at FROM svc_variations WHERE order_id=$1 ORDER BY version', [o.id]),
      many("SELECT day, units, status FROM svc_allocations WHERE order_id=$1 AND status <> 'released' ORDER BY day", [o.id]),
      many('SELECT id, starts_at, ends_at, status, planned_qty, actual_qty, site_label FROM svc_visits WHERE order_id=$1 ORDER BY starts_at LIMIT 200', [o.id]),
      many("SELECT id, doc_type, supplier_number, status, kind, currency, gross_minor, paid_minor, pay_status, match_status, due_on FROM svc_invoices WHERE order_id=$1 AND (status <> 'draft' OR profile_id = ANY($2)) ORDER BY created_at", [o.id, sup ? [o.profile_id] : []]),
    ]);
    const prof = await one('SELECT id, legal_name, trading_name, status FROM svc_profiles WHERE id=$1', [o.profile_id]);
    const buyer = await one('SELECT id, name, currency FROM svc_buyers WHERE id=$1', [o.buyer_id]);
    const { terms: tm, ...oo } = o;
    const terms = buy ? tm : Object.fromEntries(Object.entries(tm ?? {}).filter(([k]) => k !== 'justification'));   // the buyer's award rationale is internal
    return { ...oo, terms, lines, variations, allocations: sup ? allocations : allocations.map(({ day: d, status }) => ({ day: d, status })), visits, invoices, supplier: prof, buyer, my_sides: [sup && 'supplier', buy && 'buyer'].filter(Boolean), my_roles: { supplier: sup?.roles ?? [], buyer: buy ? [...buy.roles] : [] } };
  },
});

// ---------------------------------------------------------------- supplier response
cap({
  name: 'respond_service_order', method: 'POST', path: '/service-orders/:id/respond', tag: TAG,
  summary: 'Supplier: confirm the order (reserves capacity atomically — it fails if the days are full or blacked out), reject it with a reason, or propose changes. Quote acceptance alone never guarantees staffing; confirmation does. Third-party travel/hotel orders only record a supplier booking confirmation or a reference — never live inventory.',
  input: z.object({ id, action: z.enum(['confirm', 'reject', 'propose_changes']), reason: z.string().max(1000).optional(), third_party_ref: z.string().max(120).optional(), changes: z.object({ lines: z.array(z.object({ line_no: z.number().int(), qty_ordered: z.number().min(0).optional(), rate_minor: z.number().int().min(0).optional() })).max(50).optional() }).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id, { lock: true });
      const { sup } = await orderSide(user, o, { buyer: false, supplier: ['owner', 'sales'] }, c);
      if (!sup) throw notFound('Order');
      if (!['pending_supplier', 'changes_proposed'].includes(o.status)) throw conflict(`Order is ${o.status}`);
      if (i.action === 'reject') {
        if (!i.reason) throw badRequest('Give a reason');
        await release(c, o.id);                              // free the held days
        const row = await q1(c, "UPDATE svc_orders SET status='rejected', reason=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [o.id, i.reason]);
        await c.query("UPDATE svc_quotes SET status='rejected' WHERE id=$1", [o.quote_id]);
        const live = (await c.query("SELECT 1 FROM svc_orders WHERE rfq_id=$1 AND status NOT IN ('cancelled','rejected','terminated') AND id <> $2", [o.rfq_id, o.id])).rowCount;
        await c.query("UPDATE svc_rfqs SET status=$2, row_version=row_version+1 WHERE id=$1 AND status IN ('awarded','partially_awarded')", [o.rfq_id, live ? 'partially_awarded' : 'evaluation']);
        await tell(c, await buyerAudience(c, o.buyer_id, ['purchaser', 'requester']), { kind: 'svc_order_rejected', title: 'A supplier declined your order', body: `Order ${o.number} was declined. Open Gotmygame to re-award.`, data: { order_id: o.id }, dedupe_key: `svc:orderrej:${o.id}` }, user.id);
        return row;
      }
      if (i.action === 'propose_changes') {
        if (!i.reason || !i.changes?.lines?.length) throw badRequest('Say what you want to change, and why');
        const p = await previewVariation(c, o, i.changes);
        const ver = Number((await q1(c, 'SELECT coalesce(max(version),0)+1 AS v FROM svc_variations WHERE order_id=$1', [o.id])).v);
        await c.query("INSERT INTO svc_variations(order_id, version, kind, reason, changes, delta_net_minor, delta_tax_minor, proposed_by, proposed_side) VALUES ($1,$2,'scope',$3,$4,$5,$6,$7,'supplier')", [o.id, ver, i.reason, i.changes, p.delta.net, p.delta.tax, user.id]);
        const row = await q1(c, "UPDATE svc_orders SET status='changes_proposed', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [o.id]);
        await tell(c, await buyerAudience(c, o.buyer_id, ['purchaser', 'requester']), { kind: 'svc_order_changes', title: 'A supplier proposed changes', body: `Order ${o.number} has proposed changes to review.`, data: { order_id: o.id }, dedupe_key: `svc:orderchg:${o.id}:${ver}` }, user.id);
        return row;
      }
      if (o.status === 'changes_proposed') throw conflict('Resolve the proposed changes first');
      if (await q1(c, "SELECT 1 FROM svc_variations WHERE order_id=$1 AND status='proposed'", [o.id])) throw conflict('Resolve the open variation first');
      await reserveForOrder(c, o);                                   // throws 409 when the days are blacked out or over capacity
      const cat = (await q1(c, "SELECT scope->>'category' AS c FROM svc_rfqs WHERE id=$1", [o.rfq_id]))?.c;
      const travel = ['travel', 'accommodation'].includes(cat);
      const row = await q1(c, `UPDATE svc_orders SET status='confirmed', confirmed_at=now(), fulfilment='scheduled', travel_confirmation=$2, third_party_ref=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [o.id, travel ? (i.third_party_ref ? 'third_party_reference_recorded' : 'supplier_booking_confirmed') : null, i.third_party_ref ?? null]);
      await commitOrder(c, row, user);
      await c.query("UPDATE svc_requirements SET status='confirmed', updated_at=now() WHERE id=$1", [o.requirement_id]);
      await tell(c, await buyerAudience(c, o.buyer_id, ['purchaser', 'requester']), { kind: 'svc_order_confirmed', title: 'Your service order was confirmed', body: `Order ${o.number} is confirmed.`, data: { order_id: o.id }, dedupe_key: `svc:orderok:${o.id}` }, user.id);
      await log(c, 'order', o.id, user.id, 'confirmed');
      return row;
    });
  },
});

cap({
  name: 'sign_service_agreement', method: 'POST', path: '/service-orders/:id/agreement', tag: TAG,
  summary: 'Record that your side has reviewed and agreed the service agreement / statement of work (order terms). This is an audited acknowledgement by a signed-in user — not a qualified electronic signature, and an uploaded signature image is not treated as one.',
  input: z.object({ id, typed_name: z.string().min(2).max(120) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id, { lock: true });
      const { sup, buy } = await orderSide(user, o, { buyer: ['purchaser'], supplier: ['owner', 'sales'] }, c);
      if (!sup && !buy) throw notFound('Order');
      const side = sup && !buy ? 'supplier' : buy && !sup ? 'buyer' : null;
      if (!side) throw forbidden('You act for both sides of this order; a different person must sign for the other side');
      if (['not_required', 'fully_signed'].includes(o.agreement_status)) throw conflict(`Agreement is ${o.agreement_status}`);
      const has = { buyer: ['signed_by_buyer', 'fully_signed'].includes(o.agreement_status), supplier: ['signed_by_supplier', 'fully_signed'].includes(o.agreement_status) };
      if (has[side]) throw conflict('Your side has already signed');
      has[side] = true;
      const status = has.buyer && has.supplier ? 'fully_signed' : has.buyer ? 'signed_by_buyer' : 'signed_by_supplier';
      await log(c, 'order', o.id, user.id, `agreement_ack_${side}`, { typed_name: i.typed_name, qualified_signature: false });
      return q1(c, 'UPDATE svc_orders SET agreement_status=$2, row_version=row_version+1 WHERE id=$1 RETURNING *', [o.id, status]);
    });
  },
});

// ---------------------------------------------------------------- variations
const lineChange = z.object({ line_no: z.number().int().positive(), qty_ordered: z.number().min(0).max(1e9).optional(), rate_minor: z.number().int().min(0).optional() });
const addLine = z.object({ line_type: z.enum(['service', 'goods']), charge_kind: z.enum(['labour', 'material', 'travel', 'equipment', 'other']).optional(), description: z.string().min(1).max(400), quantity: z.number().positive().max(1e9), unit: z.string(), rate_minor: z.number().int().min(0), discount_minor: z.number().int().min(0).optional(), tax_code: z.string().max(24).optional(), milestone: z.string().max(80).optional() });
const KINDS = ['scope', 'cost', 'date', 'headcount', 'pause', 'resume', 'reschedule', 'partial_cancellation', 'termination'];

/** Apply now, or open the spending approval first when this raises the buyer's commitment above policy. */
async function settleVariation(c, order, v, buyerUser) {
  const delta = Number(v.delta_net_minor) + Number(v.delta_tax_minor);
  if (delta > 0) {
    const acc = await buyerAccess(buyerUser, order.buyer_id, ['purchaser'], c);
    if (approvalNeeded(acc.buyer, acc, delta, order.currency)) {
      const ap = await q1(c, "INSERT INTO svc_approvals(buyer_id, subject_type, subject_id, amount_minor, currency, requested_by, payload) VALUES ($1,'variation',$2,$3,$4,$5,$6) RETURNING *", [order.buyer_id, v.id, delta, order.currency, buyerUser.id, { order_id: order.id }]);
      await c.query('UPDATE svc_variations SET approval_id=$2 WHERE id=$1', [v.id, ap.id]);
      await tell(c, await buyerAudience(c, order.buyer_id, ['approver']), { kind: 'svc_approval_requested', title: 'A change needs your approval', body: 'Open Gotmygame to review and decide.', data: { approval_id: ap.id }, dedupe_key: `svc:ap:${ap.id}` }, buyerUser.id);
      return { variation: v, approval: ap, order };
    }
  }
  return { variation: v, order: await applyVariation(c, order, v, buyerUser) };
}

cap({
  name: 'propose_service_variation', method: 'POST', path: '/service-orders/:id/variations', tag: TAG, status: 201,
  summary: 'Propose a variation: scope/cost/date/headcount changes, pause, resume, reschedule, partial cancellation or termination. A reason is required; the counterparty must accept; a cost increase above policy also needs a separate approver. A buyer-side termination takes effect at once and records its impact (accepted work kept, remaining commitment ended, capacity released, refund due). Original commitments stay on record. Idempotent per key.',
  input: z.object({ id, kind: z.enum(KINDS), reason: z.string().min(1).max(2000), effective_on: day.optional(), idempotency_key: z.string().min(1).max(64).optional(),
    changes: z.object({ lines: z.array(lineChange).max(50).optional(), add_lines: z.array(addLine).max(20).optional(), starts_at: ts.optional(), ends_at: ts.optional(), shift_days: z.number().int().min(-365).max(365).optional(), headcount: z.number().int().positive().max(100000).optional() }).default({}) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id, { lock: true });
      const { sup, buy } = await orderSide(user, o, { buyer: ['purchaser'], supplier: ['owner', 'sales', 'scheduler'] }, c);
      if (!sup && !buy) throw notFound('Order');
      if (sup && buy) throw forbidden('You act for both sides of this order; a different person must propose or accept the change');
      const side = sup ? 'supplier' : 'buyer';
      if (i.idempotency_key) { const dup = await q1(c, 'SELECT * FROM svc_variations WHERE order_id=$1 AND idempotency_key=$2', [o.id, i.idempotency_key]); if (dup) return { variation: dup, replayed: true }; }
      if (!['confirmed', 'in_progress', 'paused', 'pending_supplier'].includes(o.status)) throw conflict(`Order is ${o.status}`);
      if (await q1(c, "SELECT 1 FROM svc_variations WHERE order_id=$1 AND status='proposed'", [o.id])) throw conflict('Another variation is already waiting; resolve it first');
      if (['pause', 'termination', 'reschedule', 'partial_cancellation'].includes(i.kind) && !i.effective_on) throw badRequest('Give the effective date');
      if (i.kind === 'resume' && o.status !== 'paused') throw conflict('Order is not paused');
      if (i.kind === 'pause' && o.status === 'paused') throw conflict('Order is already paused');
      if (side === 'supplier' && sup.roles.includes('scheduler') && !sup.roles.includes('owner') && !sup.roles.includes('sales') && !['date', 'reschedule', 'pause', 'resume'].includes(i.kind)) throw forbidden('A scheduler may only propose schedule changes');
      const p = ['pause', 'resume', 'termination'].includes(i.kind) ? { delta: { net: 0, tax: 0 } } : await previewVariation(c, o, i.changes);
      const ver = Number((await q1(c, 'SELECT coalesce(max(version),0)+1 AS v FROM svc_variations WHERE order_id=$1', [o.id])).v);
      const v = await q1(c, 'INSERT INTO svc_variations(order_id, version, kind, reason, effective_on, changes, delta_net_minor, delta_tax_minor, proposed_by, proposed_side, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [o.id, ver, i.kind, i.reason, i.effective_on ?? null, i.changes, p.delta.net, p.delta.tax, user.id, side, i.idempotency_key ?? null]);
      await log(c, 'order', o.id, user.id, `variation_${i.kind}_proposed`, { version: ver, reason: i.reason });
      if (side === 'buyer' && i.kind === 'termination') {
        await c.query("UPDATE svc_variations SET counterparty_status='accepted' WHERE id=$1", [v.id]);
        const done = await applyVariation(c, o, { ...v, counterparty_status: 'accepted' }, user);
        await tell(c, await supplierAudience(c, o.profile_id), { kind: 'svc_order_terminated', title: 'An order was ended by the buyer', body: `Order ${o.number} was terminated. Accepted work remains billable.`, data: { order_id: o.id }, dedupe_key: `svc:term:${o.id}` }, user.id);
        return { variation: await q1(c, 'SELECT * FROM svc_variations WHERE id=$1', [v.id]), order: done };
      }
      await tell(c, side === 'buyer' ? await supplierAudience(c, o.profile_id) : await buyerAudience(c, o.buyer_id, ['purchaser']), { kind: 'svc_variation_proposed', title: 'A change was proposed on an order', body: `Order ${o.number}: open Gotmygame to review.`, data: { order_id: o.id, variation_id: v.id }, dedupe_key: `svc:var:${v.id}` }, user.id);
      return { variation: v };
    });
  },
});

cap({
  name: 'respond_service_variation', method: 'POST', path: '/service-variations/:id/respond', tag: TAG,
  summary: 'The other side accepts or rejects a proposed variation. Accepting applies it immediately, unless it raises spending above policy — then a separate approver must approve first.',
  input: z.object({ id, accept: z.boolean(), reason: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v0 = await q1(c, 'SELECT * FROM svc_variations WHERE id=$1', [i.id]);
      if (!v0) throw notFound('Variation');
      const o = await loadOrder(c, v0.order_id, { lock: true });
      const v = await q1(c, 'SELECT * FROM svc_variations WHERE id=$1 FOR UPDATE', [i.id]);
      const need = v.proposed_side === 'buyer' ? { buyer: false, supplier: ['owner', 'sales', 'scheduler'] } : { buyer: ['purchaser'], supplier: false };
      const { sup, buy } = await orderSide(user, o, need, c);
      if (!(v.proposed_side === 'buyer' ? sup : buy)) throw notFound('Variation');
      if (v.status !== 'proposed' || v.counterparty_status !== 'pending') throw conflict(`Variation is ${v.status}`);
      if (user.id === v.proposed_by) throw forbidden('You cannot accept your own proposal');
      if (!i.accept) {
        if (!i.reason) throw badRequest('Give a reason when rejecting');
        await c.query("UPDATE svc_variations SET counterparty_status='rejected', status='rejected' WHERE id=$1", [v.id]);
        if (o.status === 'changes_proposed') await c.query("UPDATE svc_orders SET status='pending_supplier' WHERE id=$1", [o.id]);
        await log(c, 'order', o.id, user.id, 'variation_rejected', { version: v.version, reason: i.reason });
        return { variation: await q1(c, 'SELECT * FROM svc_variations WHERE id=$1', [v.id]), order: await loadOrder(c, o.id) };
      }
      await c.query("UPDATE svc_variations SET counterparty_status='accepted' WHERE id=$1", [v.id]);
      if (o.status === 'changes_proposed') await c.query("UPDATE svc_orders SET status='pending_supplier' WHERE id=$1", [o.id]);
      const fresh = await q1(c, 'SELECT * FROM svc_variations WHERE id=$1', [v.id]);
      const buyerUser = v.proposed_side === 'buyer' ? { id: v.proposed_by, roles: [] } : user;
      return settleVariation(c, await loadOrder(c, o.id), fresh, buyerUser.id === user.id ? user : await q1(c, 'SELECT id, roles, display_name FROM users WHERE id=$1', [v.proposed_by]));
    });
  },
});
handlers.set('variation', async (c, ap, actor) => {
  const v = await q1(c, 'SELECT * FROM svc_variations WHERE id=$1 FOR UPDATE', [ap.subject_id]);
  if (!v || v.status !== 'proposed') throw conflict('That variation is no longer open');
  return applyVariation(c, await loadOrder(c, v.order_id, { lock: true }), v, actor);
});

cap({
  name: 'cancel_service_order', method: 'POST', path: '/service-orders/:id/cancel', tag: TAG,
  summary: 'Buyer (purchaser): cancel an order before any work was accepted or invoiced. Capacity is released and the event commitment ends; the order stays on record. Use a termination variation once work has started.',
  input: z.object({ id, reason: z.string().min(1).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id, { lock: true });
      const { buy } = await orderSide(user, o, { buyer: ['purchaser'], supplier: false }, c);
      if (!buy) throw notFound('Order');
      if (await isOwnSupplier(c, user, o)) throw forbidden('You act for both sides of this order');
      if (!['pending_supplier', 'changes_proposed', 'confirmed'].includes(o.status)) throw conflict(`Order is ${o.status}; use a termination variation`);
      if ((await activeLines(c, o.id)).some((l) => Number(l.qty_accepted) > 0 || Number(l.qty_invoiced) > 0) || (await q1(c, "SELECT 1 FROM svc_invoices WHERE order_id=$1 AND status='issued'", [o.id]))) throw conflict('Work was already accepted or invoiced; terminate instead');
      const row = await cancelOrderRecords(c, o, i.reason);
      await tell(c, await supplierAudience(c, o.profile_id), { kind: 'svc_order_cancelled', title: 'An order was cancelled', body: `Order ${o.number} was cancelled by the buyer.`, data: { order_id: o.id }, dedupe_key: `svc:cancel:${o.id}` }, user.id);
      return row;
    });
  },
});
