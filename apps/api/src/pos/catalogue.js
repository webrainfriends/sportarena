// What the front desk can sell (the venue's own stock, rental kit, plans, courts), the item terms managers set, desk rules and manager approvals.
import { randomInt } from 'node:crypto';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { enabledProviders } from '../payments/service.js';
import { posRole, mustBeManager, getSettings } from './access.js';
import { isAdmin } from '../helpers.js';
import { restoreStock } from './sale.js';
import { openShiftFor } from './shifts.js';

const ITEM = 'id, name, category, sku, quantity, reorder_level, unit_cost_cents, sellable, sell_price_cents, stock_kind, rental_fee_cents, deposit_cents, damaged_qty, archived_at, (quantity <= reorder_level) AS low_stock';

export async function catalogue(user, { venue_id, q }) {
  const { role } = await posRole(user, venue_id);
  const venue = await one('SELECT id, name, currency, timezone, tax_name, tax_rate_bp, tax_inclusive, organisation_id FROM venues WHERE id=$1', [venue_id]);
  const settings = await tx((c) => getSettings(c, venue_id));
  const items = await many(`SELECT ${ITEM} FROM inventory_items WHERE venue_id=$1 AND sellable AND archived_at IS NULL AND ($2::text IS NULL OR name ILIKE '%'||$2||'%' OR sku ILIKE '%'||$2||'%') ORDER BY stock_kind, category, name LIMIT 500`, [venue_id, q ?? null]);
  const plans = await many('SELECT id, kind, name, price_cents, duration_days, sessions, valid_days, discount_bp FROM venue_plans WHERE venue_id=$1 AND active ORDER BY kind, price_cents', [venue_id]);
  const courts = await many('SELECT id, name, kind, hourly_rate_cents, slot_minutes, min_slots, max_slots, capacity FROM resources WHERE venue_id=$1 ORDER BY name', [venue_id]);
  const strip = (x) => (role === 'manager' ? x : (({ unit_cost_cents, ...rest }) => rest)(x));   // what it costs the venue is the manager's figure
  const offers = await many("SELECT d.code, d.name, d.kind, d.value FROM discounts d WHERE d.venue_id=$1 AND d.active AND d.code IS NOT NULL AND (d.valid_from IS NULL OR d.valid_from <= current_date) AND (d.valid_to IS NULL OR d.valid_to >= current_date) ORDER BY d.name LIMIT 20", [venue_id]);
  return {
    role, venue, offers, shift: await openShiftFor(user, venue_id),
    tenders: { manual: settings.manual_methods, online: enabledProviders() },
    rules: { require_shift: settings.require_shift, cashier_discount_max_bp: settings.cashier_discount_max_bp, offline_cash_allowed: settings.offline_cash_allowed },
    items: items.filter((i) => i.stock_kind === 'consumable').map(strip), rental_items: items.filter((i) => i.stock_kind === 'rental').map(strip), plans, courts,
  };
}

/** What is waiting to be paid at this venue, so it can be collected at the desk: open venue invoices (not already in a sale) and, for a customer, the academy fees they owe the venue's academy. */
export async function duesFor(user, { venue_id, customer_handle }) {
  await posRole(user, venue_id);
  const cust = customer_handle ? await one('SELECT id, display_name FROM users WHERE handle=$1', [customer_handle.toLowerCase()]) : null;
  if (customer_handle && !cust) throw notFound('Customer');
  const invoices = await many(
    `SELECT i.id, i.number, i.total_cents - i.credits_cents AS due_cents, i.currency, i.issued_at, rs.code AS reservation_code, u.display_name AS customer
       FROM invoices i JOIN users u ON u.id=i.user_id LEFT JOIN reservations rs ON rs.id=i.reservation_id
      WHERE i.venue_id=$1 AND i.kind='invoice' AND i.status='open' AND i.pos_sale_id IS NULL AND ($2::uuid IS NULL OR i.user_id=$2)
        AND NOT EXISTS (SELECT 1 FROM pos_sale_invoices psi JOIN pos_sales s ON s.id=psi.sale_id WHERE psi.invoice_id=i.id AND s.status='awaiting_payment')
      ORDER BY i.issued_at DESC LIMIT 50`, [venue_id, cust?.id ?? null]);
  const charges = cust ? await many(
    `SELECT ch.id, ch.kind, ch.amount_minor - ch.settled_minor - ch.adjusted_minor AS due_cents, ch.currency, ch.due_on FROM academy_charges ch JOIN venues v ON v.organisation_id=ch.organisation_id
      WHERE v.id=$1 AND ch.payer_id=$2 AND ch.status='awaiting_payment'
        AND NOT EXISTS (SELECT 1 FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id WHERE l.charge_id=ch.id AND s.status='awaiting_payment') ORDER BY ch.due_on LIMIT 50`, [venue_id, cust.id]) : [];
  return { customer: cust ? { id: cust.id, name: cust.display_name } : null, invoices, academy_charges: charges };
}

/** Manager's stock list with sale terms, including items not offered at the desk. */
export async function listItems(user, i) {
  await mustBeManager(user, i.venue_id);
  return many(`SELECT ${ITEM} FROM inventory_items WHERE venue_id=$1 AND ($2::boolean OR archived_at IS NULL) AND ($3::text IS NULL OR name ILIKE '%'||$3||'%') ORDER BY name LIMIT $4 OFFSET $5`, [i.venue_id, i.include_archived ?? false, i.q ?? null, i.limit, i.offset]);
}

/** Stock belongs to its venue's managers (or to its owner when it is not tied to a venue). */
async function itemAccess(user, item) {
  if (item.venue_id) return mustBeManager(user, item.venue_id);
  if (item.owner_id !== user.id && !isAdmin(user)) throw forbidden('Not your item');
  return null;
}

function checkTerms(t) {
  if (t.stock_kind === 'rental' && t.sell_price_cents != null) throw badRequest('Rental kit is rented, not sold — clear the selling price or make it a consumable');
  if (t.stock_kind !== 'rental' && (t.rental_fee_cents != null || (t.deposit_cents ?? 0) > 0)) throw badRequest('Only rental kit has a rental fee or a deposit');
  if (t.sellable && t.stock_kind !== 'rental' && t.sell_price_cents == null) throw badRequest('Set a selling price before offering this at the desk');
  if (t.sellable && t.stock_kind === 'rental' && t.rental_fee_cents == null) throw badRequest('Set a rental fee (0 for free loan kit) before offering this at the desk');
}

export async function createItem(user, i) {
  const { venue } = await mustBeManager(user, i.venue_id);
  checkTerms(i);
  return tx(async (c) => {
    const it = (await c.query(
      `INSERT INTO inventory_items(owner_id, venue_id, name, category, sku, quantity, reorder_level, unit_cost_cents, sellable, sell_price_cents, stock_kind, rental_fee_cents, deposit_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${ITEM}`,
      [venue.owner_id, i.venue_id, i.name, i.category, i.sku ?? null, i.quantity, i.reorder_level ?? 0, i.unit_cost_cents ?? 0, i.sellable ?? (i.sell_price_cents != null || i.rental_fee_cents != null), i.sell_price_cents ?? null, i.stock_kind, i.rental_fee_cents ?? null, i.deposit_cents ?? 0])).rows[0];
    if (i.quantity > 0) await c.query("INSERT INTO pos_stock_moves(venue_id, item_id, delta, reason, actor_id, note) VALUES ($1,$2,$3,'adjust',$4,'Opening stock')", [i.venue_id, it.id, i.quantity, user.id]);
    await audit(c, user.id, 'pos_create_item', 'inventory_items', it.id);
    return it;
  });
}

export async function updateItem(user, itemId, i) {
  const cur = await one('SELECT * FROM inventory_items WHERE id=$1', [itemId]);
  if (!cur) throw notFound('Item');
  await itemAccess(user, cur);
  const next = { stock_kind: i.stock_kind ?? cur.stock_kind, sellable: i.sellable ?? cur.sellable, sell_price_cents: i.sell_price_cents === undefined ? cur.sell_price_cents : i.sell_price_cents,
    rental_fee_cents: i.rental_fee_cents === undefined ? cur.rental_fee_cents : i.rental_fee_cents, deposit_cents: i.deposit_cents ?? cur.deposit_cents };
  checkTerms(next);
  return tx(async (c) => {
    const out = (await c.query(
      `UPDATE inventory_items SET name=coalesce($2,name), category=coalesce($3,category), sku=coalesce($4,sku), reorder_level=coalesce($5,reorder_level), unit_cost_cents=coalesce($6,unit_cost_cents),
              sellable=$7, sell_price_cents=$8, stock_kind=$9, rental_fee_cents=$10, deposit_cents=$11, archived_at=CASE WHEN $12::boolean IS NULL THEN archived_at WHEN $12 THEN coalesce(archived_at, now()) ELSE NULL END
        WHERE id=$1 RETURNING ${ITEM}`,
      [itemId, i.name ?? null, i.category ?? null, i.sku ?? null, i.reorder_level ?? null, i.unit_cost_cents ?? null, next.sellable, next.sell_price_cents, next.stock_kind, next.rental_fee_cents, next.deposit_cents, i.archived ?? null])).rows[0];
    await audit(c, user.id, 'pos_update_item', 'inventory_items', itemId);
    return out;
  });
}

/** Receive stock, count it, or write off breakage. For a venue's items every change is a ledger line with a reason; it never goes below zero. */
export async function adjustStock(user, itemId, { delta, reason }) {
  const cur = await one('SELECT * FROM inventory_items WHERE id=$1', [itemId]);
  if (!cur) throw notFound('Item');
  await itemAccess(user, cur);
  return tx(async (c) => {
    const r = await c.query('UPDATE inventory_items SET quantity = quantity + $2 WHERE id=$1 AND quantity + $2 >= 0 RETURNING quantity', [itemId, delta]);
    if (!r.rowCount) throw conflict('Not enough stock');
    if (cur.venue_id) {
      await c.query("INSERT INTO pos_stock_moves(venue_id, item_id, delta, reason, actor_id, note) VALUES ($1,$2,$3,'adjust',$4,$5)", [cur.venue_id, itemId, delta, user.id, reason ?? null]);
      await audit(c, user.id, 'adjust_stock', 'inventory_items', itemId);
    }
    return { ...(await c.query('SELECT * FROM inventory_items WHERE id=$1', [itemId])).rows[0], quantity: r.rows[0].quantity };
  });
}

export async function stockHistory(user, itemId, { limit, offset }) {
  const cur = await one('SELECT * FROM inventory_items WHERE id=$1', [itemId]);
  if (!cur) throw notFound('Item');
  await itemAccess(user, cur);
  return many('SELECT m.id, m.delta, m.reason, m.note, m.created_at, m.sale_id, m.rental_id, u.display_name AS actor FROM pos_stock_moves m LEFT JOIN users u ON u.id=m.actor_id WHERE m.item_id=$1 ORDER BY m.created_at DESC, m.id LIMIT $2 OFFSET $3', [itemId, limit, offset]);
}

export const readSettings = async (user, venueId) => { await posRole(user, venueId); return tx((c) => getSettings(c, venueId)); };

export async function writeSettings(user, venueId, i) {
  await mustBeManager(user, venueId);
  return tx(async (c) => {
    const cur = await getSettings(c, venueId);
    const n = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => k !== 'venue_id' && v !== undefined)) };
    if (!n.manual_methods.includes('cash') && n.require_shift) throw badRequest('A drawer shift only makes sense while cash is enabled');
    await c.query(
      `INSERT INTO pos_settings(venue_id, require_shift, cashier_discount_max_bp, refund_limit_cents, paid_out_limit_cents, variance_tolerance_cents, manual_methods, offline_cash_allowed, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (venue_id) DO UPDATE SET require_shift=$2, cashier_discount_max_bp=$3, refund_limit_cents=$4, paid_out_limit_cents=$5, variance_tolerance_cents=$6, manual_methods=$7, offline_cash_allowed=$8, updated_by=$9, updated_at=now()`,
      [venueId, n.require_shift, n.cashier_discount_max_bp, n.refund_limit_cents, n.paid_out_limit_cents, n.variance_tolerance_cents, n.manual_methods, n.offline_cash_allowed, user.id]);
    await audit(c, user.id, 'pos_update_settings', 'pos_settings', venueId);
    return getSettings(c, venueId);
  });
}

export async function grantApproval(user, i) {
  await mustBeManager(user, i.venue_id);
  if (i.granted_to) await posRole({ id: i.granted_to, roles: [] }, i.venue_id).catch(() => { throw badRequest('That person is not on this venue\'s team'); });
  return tx(async (c) => {
    // a short code a manager can read out; unique among the venue's unused approvals (retry on the rare clash)
    for (let attempt = 0; ; attempt++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await c.query('SAVEPOINT approval_code');
      try {
        const a = (await c.query(
          `INSERT INTO pos_approvals(venue_id, kind, max_amount_cents, reason, granted_by, granted_to, expires_at, code) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7), $8) RETURNING id, code, kind, max_amount_cents, expires_at`,
          [i.venue_id, i.kind, i.max_amount_cents, i.reason, user.id, i.granted_to ?? null, i.valid_minutes, code])).rows[0];
        await c.query('RELEASE SAVEPOINT approval_code');
        await audit(c, user.id, 'pos_grant_approval', 'pos_approvals', a.id);
        return a;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT approval_code');
        if (e.code !== '23505' || attempt > 5) throw e;
      }
    }
  });
}

export { restoreStock };

// ------------------------------------------------------------------ the desk's team
export async function addCashier(user, venueId, handle) {
  const { venue } = await mustBeManager(user, venueId);
  const u = await one('SELECT id, handle, display_name FROM users WHERE handle=$1', [handle.toLowerCase()]);
  if (!u) throw notFound('User');
  if (u.id === venue.owner_id) throw badRequest('The owner already runs the desk as a manager');
  return tx(async (c) => {
    await c.query('INSERT INTO pos_cashiers(venue_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT (venue_id, user_id) DO UPDATE SET removed_at=NULL, added_by=$3', [venueId, u.id, user.id]);
    await audit(c, user.id, 'pos_add_cashier', 'pos_cashiers', u.id);
    await notify(c, u.id, { kind: 'pos_cashier_added', title: 'You can work the front desk', body: `${user.display_name} added you as a cashier. Find it under Workspace → Front desk.`, data: { venue_id: venueId } });
    return { ...u, role: 'cashier' };
  });
}

export async function removeCashier(user, venueId, userId) {
  await mustBeManager(user, venueId);
  const r = await one('UPDATE pos_cashiers SET removed_at=now() WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL RETURNING user_id', [venueId, userId]);
  if (!r) throw notFound('Cashier');
  await audit(null, user.id, 'pos_remove_cashier', 'pos_cashiers', userId);
  return { ok: true };
}

export async function listCashiers(user, venueId) {
  await mustBeManager(user, venueId);
  return many('SELECT u.id, u.handle, u.display_name, \'cashier\' AS role, pc.created_at FROM pos_cashiers pc JOIN users u ON u.id=pc.user_id WHERE pc.venue_id=$1 AND pc.removed_at IS NULL ORDER BY u.display_name', [venueId]);
}
