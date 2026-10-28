// Order state: access, fulfilment roll-up, variations (applied only when the counterparty has accepted and any spending approval is granted).
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { priced } from './money.js';
import { supplierAccess, buyerAccess, log } from './access.js';
import { reserve, hold, release, occurrences, daysBetween } from './capacity.js';
import { recommit, committedOf, voidCommitment } from './budget.js';

export const LIVE = ['pending_supplier', 'changes_proposed', 'confirmed', 'in_progress', 'paused', 'completed'];
export const q1 = async (c, t, a) => (await c.query(t, a)).rows[0];

export async function loadOrder(c, id, { lock = false } = {}) {
  const o = await q1(c, `SELECT * FROM svc_orders WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!o) throw notFound('Order');
  return o;
}
/** Which side the caller acts on for this order. A person who is on both sides can only act as the side the action needs (never accept their own work). */
export async function orderSide(user, order, { buyer = null, supplier = null }, c) {
  let sup = null, buy = null;
  if (supplier !== false) { try { sup = await supplierAccess(user, order.profile_id, supplier, c); } catch (e) { if (e.status === 403) throw e; } }
  if (buyer !== false) { try { buy = await buyerAccess(user, order.buyer_id, buyer, c); } catch (e) { if (e.status === 403) throw e; } }
  return { sup, buy };
}
export async function anySide(user, order, c) {
  let s = null, b = null;
  try { s = await supplierAccess(user, order.profile_id, null, c); } catch { /* no */ }
  try { b = await buyerAccess(user, order.buyer_id, null, c); } catch { /* no */ }
  if (!s && !b) throw notFound('Order');
  return { sup: s, buy: b };
}
export const isOwnSupplier = async (c, user, order) => { try { await supplierAccess(user, order.profile_id, null, c); return true; } catch { return false; } };

export const activeLines = async (c, orderId) => (await c.query("SELECT * FROM svc_order_lines WHERE order_id=$1 AND status='active' ORDER BY line_no", [orderId])).rows;
/** Re-price the order from its active lines using the tax snapshot taken at award; returns totals. */
export const repriceLines = (order, lines) => priced(lines.map((l) => ({ ...l, quantity: Number(l.qty_ordered), rate_minor: Number(l.rate_minor), discount_minor: Number(l.discount_minor) })), { inclusive: !!order.tax_snapshot?.inclusive, rounding: order.tax_snapshot?.rounding ?? 'per_line' });

/** Roll acceptance up to the order: fulfilment state, and completed once every active line is fully accepted. Never touches billing or settlement. */
export async function refreshOrder(c, orderId) {
  const o = await loadOrder(c, orderId);
  if (['cancelled', 'rejected', 'terminated'].includes(o.status)) { await syncTenderOrder(c, o); return o; }
  const lines = await activeLines(c, orderId);
  const ordered = lines.reduce((s, l) => s + Number(l.qty_ordered), 0);
  const accepted = lines.reduce((s, l) => s + Number(l.qty_accepted), 0);
  const v = (await c.query("SELECT status, count(*)::int AS n FROM svc_visits WHERE order_id=$1 AND status NOT IN ('cancelled') GROUP BY status", [orderId])).rows.reduce((m, r) => ({ ...m, [r.status]: r.n }), {});
  let f = o.fulfilment;
  if (lines.length && accepted >= ordered - 1e-9) f = 'accepted';
  else if (v.rework || v.rejected) f = 'rework';
  else if (v.submitted_for_acceptance) f = 'submitted_for_acceptance';
  else if (accepted > 0) f = 'partially_accepted';
  else if (v.in_progress) f = 'in_progress';
  else if (v.scheduled || v.confirmed) f = 'scheduled';
  const status = f === 'accepted' && ['confirmed', 'in_progress'].includes(o.status) ? 'completed' : (v.in_progress || accepted > 0) && o.status === 'confirmed' ? 'in_progress' : o.status;
  const row = await q1(c, 'UPDATE svc_orders SET fulfilment=$2, status=$3, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *', [orderId, f, status]);
  await syncTenderOrder(c, row);
  if (status === 'completed') await c.query("UPDATE svc_requirements SET status='delivered', updated_at=now() WHERE id=$1 AND status IN ('confirmed','awarded')", [o.requirement_id]);
  return row;
}

const dateWindow = (order, rfqScope) => {
  const t = order.terms ?? {};
  const starts = t.starts_at ?? rfqScope?.starts_at, ends = t.ends_at ?? rfqScope?.ends_at;
  return { starts, ends, recurrence: t.recurrence ?? rfqScope?.recurrence ?? null, units: Number(t.headcount ?? rfqScope?.headcount ?? 1) };
};
/** Set days aside (expiring hold) for a freshly placed order; null when nothing could be held. */
export async function holdForOrder(c, order) {
  const rfq = order.rfq_id ? await q1(c, 'SELECT scope FROM svc_rfqs WHERE id=$1', [order.rfq_id]) : null;
  const w = dateWindow(order, rfq?.scope);
  if (!w.starts) return null;
  const profile = await q1(c, 'SELECT * FROM svc_profiles WHERE id=$1', [order.profile_id]);
  return hold(c, profile, order.id, occurrences(w.starts, w.recurrence, w.ends), w.units);
}
export async function reserveForOrder(c, order) {
  const rfq = order.rfq_id ? await q1(c, 'SELECT scope FROM svc_rfqs WHERE id=$1', [order.rfq_id]) : null;
  const w = dateWindow(order, rfq?.scope);
  if (!w.starts) return [];
  const profile = await q1(c, 'SELECT * FROM svc_profiles WHERE id=$1', [order.profile_id]);
  return reserve(c, profile, order.id, occurrences(w.starts, w.recurrence, w.ends), w.units);
}

const tz = (d) => new Date(d).toISOString();
/** What a variation would do, without doing it: new totals and the delta against the current order. */
export async function previewVariation(c, order, changes) {
  const lines = (await activeLines(c, order.id)).map((l) => ({ ...l }));
  for (const ch of changes.lines ?? []) {
    const l = lines.find((x) => x.line_no === ch.line_no);
    if (!l) throw badRequest(`Order has no line ${ch.line_no}`);
    if (ch.qty_ordered !== undefined) {
      if (ch.qty_ordered < Number(l.qty_accepted) - 1e-9 || ch.qty_ordered < Number(l.qty_invoiced) - 1e-9) throw conflict(`Line ${l.line_no}: cannot go below what is already accepted or invoiced`);
      l.qty_ordered = ch.qty_ordered; l.__changed = true;
    }
    if (ch.rate_minor !== undefined) { if (Number(l.qty_accepted) > 0) throw conflict(`Line ${l.line_no}: part of it is already accepted; add a new line for the changed rate`); l.rate_minor = ch.rate_minor; l.__changed = true; }
  }
  let next = Math.max(0, ...lines.map((l) => l.line_no));
  const rules = order.tax_snapshot?.rules ?? {};
  for (const a of changes.add_lines ?? []) {
    const r = a.tax_code ? rules[a.tax_code] : null;
    if (a.tax_code && !r) throw badRequest(`Tax code ${a.tax_code} is not part of this order’s tax snapshot`);
    lines.push({ line_no: ++next, line_type: a.line_type, charge_kind: a.charge_kind ?? 'labour', description: a.description, unit: a.unit, rate_minor: a.rate_minor, discount_minor: a.discount_minor ?? 0, tax_code: a.tax_code ?? null, tax_bp: r?.rate_bp ?? 0, tax_treatment: r?.treatment ?? 'standard', qty_ordered: a.quantity, qty_accepted: 0, qty_invoiced: 0, milestone: a.milestone ?? null, __new: true });
  }
  const t = repriceLines(order, lines);
  return { lines, totals: t, delta: { net: t.net - Number(order.net_minor), tax: t.tax - Number(order.tax_minor), gross: t.gross - Number(order.gross_minor) } };
}

/** Apply an accepted (and where needed approved) variation. Original commitments stay on record: the variation row keeps the before/after. */
export async function applyVariation(c, order, v, actor) {
  const ch = v.changes ?? {};
  let impact = { before: { net: Number(order.net_minor), tax: Number(order.tax_minor), gross: Number(order.gross_minor), status: order.status } };
  if (['scope', 'cost', 'headcount', 'partial_cancellation', 'date', 'reschedule'].includes(v.kind) && (ch.lines || ch.add_lines)) {
    const p = await previewVariation(c, order, ch);
    for (const l of p.lines) {
      if (l.__new) await c.query('INSERT INTO svc_order_lines(order_id, line_no, line_type, charge_kind, description, unit, rate_minor, discount_minor, tax_code, tax_bp, tax_treatment, qty_ordered, milestone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [order.id, l.line_no, l.line_type, l.charge_kind, l.description, l.unit, l.rate_minor, l.discount_minor, l.tax_code, l.tax_bp, l.tax_treatment, l.qty_ordered, l.milestone]);
      else if (l.__changed) await c.query('UPDATE svc_order_lines SET qty_ordered=$2, rate_minor=$3 WHERE id=$1', [l.id, l.qty_ordered, l.rate_minor]);
    }
    await c.query('UPDATE svc_orders SET net_minor=$2, tax_minor=$3, gross_minor=$4 WHERE id=$1', [order.id, p.totals.net, p.totals.tax, p.totals.gross]);
    impact.after = { net: p.totals.net, tax: p.totals.tax, gross: p.totals.gross };
  }
  if (ch.starts_at || ch.ends_at || ch.shift_days || ch.headcount) {
    const rfq = order.rfq_id ? await q1(c, 'SELECT scope FROM svc_rfqs WHERE id=$1', [order.rfq_id]) : null;
    const w = dateWindow(order, rfq?.scope);
    const shift = (d) => d && tz(new Date(d).getTime() + (ch.shift_days ?? 0) * 86400000);
    const terms = { ...order.terms, starts_at: ch.starts_at ?? shift(w.starts), ends_at: ch.ends_at ?? shift(w.ends), recurrence: w.recurrence, headcount: ch.headcount ?? w.units };
    await c.query('UPDATE svc_orders SET terms=$2 WHERE id=$1', [order.id, terms]);
    order = { ...order, terms };
    if (['confirmed', 'in_progress', 'paused'].includes(order.status)) { await release(c, order.id); await reserveForOrder(c, order); }
    if (ch.shift_days) await c.query("UPDATE svc_visits SET starts_at=starts_at + ($2 || ' days')::interval, ends_at=ends_at + ($2 || ' days')::interval, row_version=row_version+1 WHERE order_id=$1 AND status IN ('planned','confirmed','scheduled')", [order.id, String(ch.shift_days)]);
    impact.dates = { starts_at: terms.starts_at, ends_at: terms.ends_at };
  }
  if (v.kind === 'pause') {
    if (!['confirmed', 'in_progress'].includes(order.status)) throw conflict(`Order is ${order.status}`);
    await c.query("UPDATE svc_orders SET status='paused', reason=$2 WHERE id=$1", [order.id, v.reason]);
    await c.query("UPDATE svc_visits SET status='paused', row_version=row_version+1 WHERE order_id=$1 AND status IN ('planned','confirmed','scheduled') AND starts_at >= coalesce($2::date, current_date)", [order.id, v.effective_on]);
    impact.resumes_to = order.status;
  } else if (v.kind === 'resume') {
    if (order.status !== 'paused') throw conflict('Order is not paused');
    const prior = (await q1(c, "SELECT impact->>'resumes_to' AS s FROM svc_variations WHERE order_id=$1 AND kind='pause' AND status='applied' ORDER BY version DESC LIMIT 1", [order.id]))?.s ?? 'confirmed';
    await c.query('UPDATE svc_orders SET status=$2 WHERE id=$1', [order.id, prior]);
    await c.query("UPDATE svc_visits SET status='scheduled', row_version=row_version+1 WHERE order_id=$1 AND status='paused'", [order.id]);
  } else if (v.kind === 'termination') {
    if (!['confirmed', 'in_progress', 'paused', 'pending_supplier'].includes(order.status)) throw conflict(`Order is ${order.status}`);
    const lines = await activeLines(c, order.id);
    for (const l of lines) {
      if (Number(l.qty_accepted) === 0) await c.query("UPDATE svc_order_lines SET status='cancelled', qty_ordered=0 WHERE id=$1", [l.id]);
      else await c.query('UPDATE svc_order_lines SET qty_ordered=qty_accepted WHERE id=$1', [l.id]);
    }
    const t = repriceLines(order, await activeLines(c, order.id));
    const cancelled = await c.query("UPDATE svc_visits SET status='cancelled', row_version=row_version+1 WHERE order_id=$1 AND status IN ('planned','confirmed','scheduled','paused') AND starts_at >= coalesce($2::date, current_date) RETURNING id", [order.id, v.effective_on]);
    await release(c, order.id, v.effective_on);
    await c.query("UPDATE svc_orders SET status='terminated', net_minor=$2, tax_minor=$3, gross_minor=$4, reason=$5, effective_on=$6, fulfilment=CASE WHEN fulfilment IN ('planned','scheduled','in_progress') THEN 'cancelled' ELSE fulfilment END WHERE id=$1", [order.id, t.net, t.tax, t.gross, v.reason, v.effective_on]);
    const paid = Number((await q1(c, "SELECT coalesce(sum(paid_minor),0)::bigint AS p FROM svc_invoices WHERE order_id=$1 AND status='issued' AND doc_type IN ('invoice','debit_note')", [order.id])).p);
    impact.after = { net: t.net, tax: t.tax, gross: t.gross }; impact.cancelled_visits = cancelled.rowCount; impact.accepted_work_kept = true; impact.paid_minor = paid; impact.refund_due_minor = Math.max(0, paid - t.gross);
  }
  const fresh = await loadOrder(c, order.id);
  if (fresh.event_id) await recommit(c, fresh, Math.max(committedOf(fresh), 0));
  await c.query("UPDATE svc_variations SET status='applied', applied_at=now(), impact=$2 WHERE id=$1", [v.id, impact]);
  await c.query('UPDATE svc_orders SET row_version=row_version+1, updated_at=now() WHERE id=$1', [order.id]);
  await log(c, 'order', order.id, actor.id, `variation_${v.kind}_applied`, { variation: v.version, reason: v.reason });
  return refreshOrder(c, order.id);
}
export { daysBetween };

/** Cancel an order that has no accepted or invoiced work: capacity released, event commitment ended (the budget line is voided, never deleted), visits cancelled, the order kept on record. */
export async function cancelOrderRecords(c, o, reason) {
  await release(c, o.id);
  await voidCommitment(c, o);
  await c.query("UPDATE svc_visits SET status='cancelled', row_version=row_version+1 WHERE order_id=$1 AND status NOT IN ('accepted','partially_accepted')", [o.id]);
  await c.query("UPDATE svc_quotes SET status='rejected' WHERE id=$1 AND status IN ('awarded','partially_awarded')", [o.quote_id]);
  const row = await q1(c, "UPDATE svc_orders SET status='cancelled', fulfilment='cancelled', reason=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [o.id, reason]);
  await c.query("UPDATE svc_rfqs SET status=CASE WHEN EXISTS (SELECT 1 FROM svc_orders WHERE rfq_id=$1 AND status NOT IN ('cancelled','rejected','terminated') AND id <> $2) THEN 'partially_awarded' ELSE 'evaluation' END, row_version=row_version+1 WHERE id=$1 AND status IN ('awarded','partially_awarded')", [o.rfq_id, o.id]);
  await syncTenderOrder(c, row);
  return row;
}

/** A tender order is the contract record for a service order; its status follows the delivery record so the two never disagree. */
export async function syncTenderOrder(c, o) {
  if (!o.proc_order_id) return;
  const status = ['cancelled', 'rejected', 'terminated'].includes(o.status) ? 'cancelled' : o.status === 'completed' ? 'completed' : o.status === 'in_progress' ? 'in_progress' : 'confirmed';
  await c.query("UPDATE proc_orders SET status=$2, cancelled_reason=CASE WHEN $2='cancelled' THEN coalesce($3, cancelled_reason) ELSE cancelled_reason END, updated_at=now() WHERE id=$1 AND status <> $2 AND status <> 'cancelled'", [o.proc_order_id, status, o.reason ?? null]);
}
