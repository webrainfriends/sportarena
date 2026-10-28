// Convergence of the Tender zone (#460) and Supplier services (#458), issue #520. An accepted tender award keeps its contract record in
// proc_orders (award snapshot, framework terms, renewals, notice) and gets exactly ONE service order (svc_orders) that carries everything
// downstream: scheduling, receiving/acceptance, change orders, invoices and matching, payments and the event-budget commitment.
// No second delivery, invoice, payment or commitment record is ever created for a tender.
import { priced } from './money.js';
import { findOrCreateBuyer, nextNumber, log } from './access.js';
import { reserveForOrder, q1 } from './orders.js';
import { committedOf, recommit, commitOrder } from './budget.js';
import { unsealJson } from '../tender/core.js';
import { conflict } from '../errors.js';

const milli = (n) => Math.round(Number(n) * 1000) / 1000;

/** The services profile for a supplier entity: reuse the one that already exists for the same owner and organisation, else create it once. */
export async function profileForEntity(c, ent) {
  if (ent.svc_profile_id) return q1(c, 'SELECT * FROM svc_profiles WHERE id=$1', [ent.svc_profile_id]);
  let p = await q1(c, "SELECT * FROM svc_profiles WHERE owner_id=$1 AND organisation_id IS NOT DISTINCT FROM $2 AND status <> 'archived'", [ent.owner_user_id, ent.organisation_id ?? null]);
  if (!p) {
    p = await q1(c, `INSERT INTO svc_profiles(owner_id, organisation_id, supplier_type, legal_name, trading_name, currencies, description)
      VALUES ($1,$2,$3,$4,$5,$6,'Created from a tender award; complete the profile to invoice.') RETURNING *`,
      [ent.owner_user_id, ent.organisation_id ?? null, ent.kind, ent.legal_name, ent.trading_name ?? null, ent.currencies ?? []]);
  }
  await c.query('UPDATE supplier_entities SET svc_profile_id=$2 WHERE id=$1', [ent.id, p.id]);
  return p;
}

/** The buyer context of a tender: its event, else its venue, else its organisation, else the person who owns it. */
export async function buyerForProject(c, p) {
  if (p.event_id) {
    const e = await q1(c, 'SELECT * FROM events WHERE id=$1', [p.event_id]);
    return findOrCreateBuyer(c, { col: 'event_id', val: p.event_id, name: e.name, currency: p.currency, owner: e.organizer_id ?? p.owner_user_id, org: e.organisation_id ?? null, ev: p.event_id });
  }
  if (p.venue_id) {
    const v = await q1(c, 'SELECT * FROM venues WHERE id=$1', [p.venue_id]);
    return findOrCreateBuyer(c, { col: 'venue_id', val: p.venue_id, name: v.name, currency: p.currency, owner: v.owner_id ?? p.owner_user_id, org: v.organisation_id ?? null, ven: p.venue_id });
  }
  if (p.organisation_id) {
    const o = await q1(c, 'SELECT * FROM organisations WHERE id=$1', [p.organisation_id]);
    return findOrCreateBuyer(c, { col: 'organisation_id', val: p.organisation_id, name: o.name, currency: p.currency, owner: p.owner_user_id, org: p.organisation_id });
  }
  const u = await q1(c, 'SELECT display_name FROM users WHERE id=$1', [p.owner_user_id]);
  return findOrCreateBuyer(c, { col: 'owner_id', val: p.owner_user_id, name: u?.display_name ?? 'Personal', currency: p.currency, owner: p.owner_user_id });
}

/**
 * Order lines for one award line: the winning bid's own priced lines for the lot, scaled to the quantity awarded (a partial award keeps the
 * bid's rates). Falls back to one summary line at the awarded amount when the bid cannot be priced line by line (other currency, no lines).
 */
export function orderLines({ lot, award, bidLines }) {
  const mine = (bidLines ?? []).filter((l) => l.lot_code === lot.code && (l.currency ?? award.currency) === award.currency);
  const bidQty = mine.reduce((s, l) => s + Number(l.qty), 0);
  const kind = lot.supply_kind === 'goods' ? 'goods' : 'service';
  if (mine.length && bidQty > 0) {
    const ratio = Number(award.qty) / bidQty;
    const inclusive = mine.every((l) => l.tax_inclusive);
    const lines = mine.map((l) => {
      const q = milli(Number(l.qty) * ratio);
      const listed = inclusive || !l.tax_inclusive ? Number(l.rate_minor) : Math.round(Number(l.rate_minor) * 10000 / (10000 + Number(l.tax_bp ?? 0)));
      const base = Math.round(q * listed);
      return { line_type: kind, charge_kind: kind === 'goods' ? 'material' : 'labour', description: `${lot.title}${l.notes ? ` — ${l.notes}` : ''}`.slice(0, 400), unit: l.unit || lot.unit || 'job', quantity: q, rate_minor: listed,
        discount_minor: Math.round(base * Number(l.discount_bp ?? 0) / 10000), tax_bp: Number(l.tax_bp ?? 0), tax_treatment: 'standard', milestone: null };
    });
    return { lines, inclusive };
  }
  // one summary line: qty × rate − discount is exactly the awarded amount (discount absorbs the rounding of the unit rate)
  const q = milli(award.qty) || 1, amount = Number(award.amount_minor);
  const rate = Math.ceil(amount / q);
  return { lines: [{ line_type: kind, charge_kind: kind === 'goods' ? 'material' : 'labour', description: lot.title.slice(0, 400), unit: lot.unit || 'job', quantity: q, rate_minor: rate, discount_minor: Math.max(0, Math.round(q * rate) - amount), tax_bp: 0, tax_treatment: 'standard', milestone: null }], inclusive: false };
}

/**
 * Create (or return) the service order behind a tender order, and move the event-budget commitment onto it: one commitment, never two.
 * Runs inside the caller's transaction. `actor` is the user whose action caused it (the accepting supplier, or the buyer linking an older order).
 */
export async function ensureServiceOrder(c, procOrderId, actor) {
  const po = await q1(c, 'SELECT * FROM proc_orders WHERE id=$1 FOR UPDATE', [procOrderId]);
  if (po.svc_order_id) return { order: await q1(c, 'SELECT * FROM svc_orders WHERE id=$1', [po.svc_order_id]), created: false };
  const [p, l, ent] = await Promise.all([q1(c, 'SELECT * FROM proc_projects WHERE id=$1', [po.project_id]), q1(c, 'SELECT * FROM proc_award_lines WHERE id=$1', [po.award_line_id]), q1(c, 'SELECT * FROM supplier_entities WHERE id=$1', [po.entity_id])]);
  const lot = await q1(c, 'SELECT * FROM proc_lots WHERE project_id=$1 AND code=$2', [p.id, po.lot_code]);
  const sub = await q1(c, 'SELECT * FROM proc_submissions WHERE id=$1', [l.submission_id]);
  // the buyer's own bid is the contract basis: read it for the order lines (the award is approved, the envelope already opened); recorded in the tender audit trail
  const bid = sub?.comm_enc ? unsealJson(sub.comm_enc, 'comm_enc', sub.id) : null;
  const profile = await profileForEntity(c, ent);
  const buyer = await buyerForProject(c, p);
  const { lines, inclusive } = orderLines({ lot, award: l, bidLines: bid?.lines });
  const t = priced(lines, { inclusive, rounding: 'per_line' });
  const number = await nextNumber(c, buyer.id, 'po', `PO-${buyer.id.replace(/-/g, '').slice(0, 5).toUpperCase()}`);
  const terms = { starts_at: po.service_start ?? undefined, ends_at: po.service_end ?? undefined, commit_basis: p.cost_basis ?? 'net', award_amount_minor: Number(l.amount_minor), tender_ref: p.ref, tender_order_ref: po.ref, lot_code: po.lot_code, contract_type: po.contract_type };
  const order = await q1(c, `INSERT INTO svc_orders(number, buyer_id, profile_id, event_id, venue_id, currency, net_minor, tax_minor, gross_minor, tax_snapshot, terms, agreement_status, status, fulfilment, confirmed_at, source, proc_order_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'not_required','confirmed','scheduled',now(),'tender',$12,$13) RETURNING *`,
    [number, buyer.id, profile.id, buyer.event_id, buyer.venue_id, l.currency, t.net, t.tax, t.gross, { inclusive, rules: {}, rounding: 'per_line', source: 'tender' }, terms, po.id, actor.id]);
  let n = 0;
  for (const x of t.lines) await c.query('INSERT INTO svc_order_lines(order_id, line_no, line_type, charge_kind, description, unit, rate_minor, discount_minor, tax_code, tax_bp, tax_treatment, qty_ordered, milestone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [order.id, ++n, x.line_type, x.charge_kind, x.description, x.unit, x.rate_minor, x.discount_minor, null, x.tax_bp, x.tax_treatment, x.quantity, x.milestone]);
  await c.query('UPDATE proc_orders SET svc_order_id=$2 WHERE id=$1', [po.id, order.id]);
  // supplier days: reserved when free; a clash does not undo the award, it is shown on the order for the buyer and supplier to resolve
  let warning = null;
  await c.query('SAVEPOINT reserve_tender_days');
  try { await reserveForOrder(c, order); } catch (e) { await c.query('ROLLBACK TO SAVEPOINT reserve_tender_days'); warning = e.message; }
  if (warning) await c.query('UPDATE svc_orders SET terms = terms || $2::jsonb WHERE id=$1', [order.id, { capacity_warning: warning }]);
  await log(c, 'order', order.id, actor.id, 'placed_from_tender', { tender: p.ref, proc_order: po.ref, award_line_id: l.id });
  return { order: await q1(c, 'SELECT * FROM svc_orders WHERE id=$1', [order.id]), created: true, warning };
}

/**
 * The commitment of a tender order on the event budget. A line that already exists for the tender order (older orders) is taken over by
 * the service order instead of creating a second one. Returns { line, note }.
 */
export async function commitTenderOrder(c, order, p, category, actor) {
  if (!order.event_id) return { line: null, note: null };
  const eb = await q1(c, 'SELECT * FROM event_budgets WHERE event_id=$1 FOR UPDATE', [order.event_id]);
  if (eb && eb.currency !== order.currency) return { line: null, note: `The event budget is in ${eb.currency}; the commitment is recorded in ${order.currency} on the order only` };
  if (!eb) await c.query('INSERT INTO event_budgets(event_id, currency) VALUES ($1,$2) ON CONFLICT DO NOTHING', [order.event_id, order.currency]);
  const amount = committedOf(order);
  const existing = await q1(c, "SELECT * FROM event_budget_lines WHERE proc_order_id=$1 AND status <> 'void' FOR UPDATE", [order.proc_order_id]);
  if (existing) {
    await c.query('UPDATE event_budget_lines SET svc_order_id=$2 WHERE id=$1', [existing.id, order.id]);
    return { line: await recommit(c, order, amount), note: null };
  }
  if (eb?.spend_cap_cents !== null && eb?.spend_cap_cents !== undefined) {
    const used = Number((await q1(c, "SELECT coalesce(sum(committed_cents),0)::bigint AS s FROM event_budget_lines WHERE event_id=$1 AND direction='expense' AND status <> 'void'", [order.event_id])).s);
    if (used + amount > Number(eb.spend_cap_cents)) throw conflict('Accepting would exceed the event spend cap. Ask the buyer to review the budget.');
  }
  const line = await commitOrder(c, order, actor, { budgetCategory: category, currencyChecked: true });
  if (line) await c.query("UPDATE event_budget_lines SET proc_order_id=$2, notes=$3 WHERE id=$1", [line.id, order.proc_order_id, `Tender ${order.terms.tender_ref}, lot ${order.terms.lot_code}. A commitment, not proof of delivery or payment.`]);
  return { line, note: null };
}

/**
 * A framework call-off becomes its own line on the service order, so it can be received/accepted, invoiced and paid like any other line,
 * and the event commitment follows the order total. Tax follows the order's lines (a single common rate) or none; amounts are the call-off's.
 */
export async function addCallOffLine(c, procOrderId, callOff) {
  const order = await q1(c, 'SELECT * FROM svc_orders WHERE proc_order_id=$1 FOR UPDATE', [procOrderId]);
  if (!order) return null;
  const lines = (await c.query("SELECT * FROM svc_order_lines WHERE order_id=$1 AND status='active' ORDER BY line_no", [order.id])).rows;
  const rates = [...new Set(lines.map((x) => x.tax_bp))];
  const bp = rates.length === 1 ? rates[0] : 0;
  const next = Math.max(0, ...lines.map((x) => x.line_no)) + 1;
  await c.query("INSERT INTO svc_order_lines(order_id, line_no, line_type, charge_kind, description, unit, rate_minor, discount_minor, tax_bp, tax_treatment, qty_ordered) VALUES ($1,$2,$3,'other',$4,'call-off',$5,0,$6,'standard',1)",
    [order.id, next, lines[0]?.line_type ?? 'service', `Call-off: ${callOff.description}`.slice(0, 400), callOff.amount_minor, bp]);
  const all = (await c.query("SELECT * FROM svc_order_lines WHERE order_id=$1 AND status='active'", [order.id])).rows;
  const t = priced(all.map((x) => ({ ...x, quantity: Number(x.qty_ordered), rate_minor: Number(x.rate_minor), discount_minor: Number(x.discount_minor) })), { inclusive: !!order.tax_snapshot?.inclusive, rounding: order.tax_snapshot?.rounding ?? 'per_line' });
  const row = await q1(c, 'UPDATE svc_orders SET net_minor=$2, tax_minor=$3, gross_minor=$4, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [order.id, t.net, t.tax, t.gross]);
  if (row.event_id) await recommit(c, row, committedOf(row));
  return row;
}
