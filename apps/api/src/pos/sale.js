// The front-desk sale: one cart, many canonical records. Court time is a real reservation (booking engine), goods and rentals draw down the venue's
// own stock and are billed on a numbered invoice, plans are real user_plans, collected fees settle the existing invoice or academy charge.
// The sale itself holds no revenue: it points at those records, and `saleDue` reads what is still owed from them.
import { many, one, tx, pool } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt, encryptFields, decryptFields } from '../crypto.js';
import { toMajor } from '../currency.js';
import { notify } from '../notify.js';
import { createReservation, cancelBookings } from '../booking/engine.js';
import { nextNumber, seller } from '../booking/invoices.js';
import { returnCredits } from '../booking/credits.js';
import { clawBackPoints } from '../booking/loyalty.js';
import { startUserPlan } from '../booking/plans.js';
import { kickRefunds } from '../booking/refunds.js';
import { startCheckout, enabledProviders, settle } from '../payments/service.js';
import { provider } from '../payments/providers.js';
import { posRole, getSettings, requireApproval, assertManualMethod } from './access.js';
import { allocate, discountCents, priceLine, shareOf, taxOf } from './pricing.js';
import { saleDue, applyIfCovered, saleOfCreditNote } from './due.js';

const PENDING_ONLINE_MINUTES = 15;

class QuoteDone extends Error { constructor(view) { super('quote'); this.view = view; } }

/** The venue's open drawer, locked in shared mode: a tender and the shift's close can never interleave (close takes the same row exclusively). */
export const currentShift = async (c, venueId) => (await c.query("SELECT * FROM pos_shifts WHERE venue_id=$1 AND status='open' FOR SHARE", [venueId])).rows[0] ?? null;

/** Stock draws down atomically: the row is locked, checked and decremented in one transaction, so two tills can never sell the same last unit. */
async function takeStock(c, venueId, wants, { saleId, actor }) {
  const items = new Map();
  for (const id of [...wants.keys()].sort()) {
    const it = (await c.query('SELECT * FROM inventory_items WHERE id=$1 AND venue_id=$2 FOR UPDATE', [id, venueId])).rows[0];
    if (!it || !it.sellable || it.archived_at) throw notFound('Item');
    const need = wants.get(id).qty;
    if (it.quantity < need) throw conflict(`Not enough ${it.name} in stock (${it.quantity} left)`, { item_id: id, available: it.quantity });
    await c.query('UPDATE inventory_items SET quantity = quantity - $2 WHERE id=$1', [id, need]);
    await c.query('INSERT INTO pos_stock_moves(venue_id, item_id, sale_id, delta, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [venueId, id, saleId, -need, wants.get(id).rental ? 'rental_out' : 'sale', actor.id]);
    items.set(id, it);
  }
  return items;
}

export async function restoreStock(c, venueId, itemId, qty, { saleId, rentalId = null, reason, actor, note = null }) {
  await c.query('UPDATE inventory_items SET quantity = quantity + $2 WHERE id=$1', [itemId, qty]);
  await c.query('INSERT INTO pos_stock_moves(venue_id, item_id, sale_id, rental_id, delta, reason, actor_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [venueId, itemId, saleId, rentalId, qty, reason, actor.id, note]);
}

const buyerBlob = (b) => encrypt(JSON.stringify({ name: b.name ?? null, address: b.address ?? null, tax_id: b.tax_id ?? null }), 'invoices.buyer');

// ------------------------------------------------------------------ ringing up a sale
export async function createSale(user, i) {
  const { role, venue: vref } = await posRole(user, i.venue_id);
  if (i.captured_offline_at && (i.payments ?? []).some((p) => p.method !== 'cash')) throw badRequest('Only cash can be taken while offline; online payments stay pending until the provider confirms them');
  if (i.client_ref) {
    const dup = await one('SELECT id FROM pos_sales WHERE venue_id=$1 AND client_ref=$2', [i.venue_id, i.client_ref]);
    if (dup) return { ...(await tx((c) => saleView(c, dup.id, user))), replayed: true };
  }
  try {
    return await tx(async (c) => {
      const venue = (await c.query('SELECT * FROM venues WHERE id=$1', [i.venue_id])).rows[0];
      const settings = await getSettings(c, i.venue_id);
      if (i.captured_offline_at && !settings.offline_cash_allowed) throw badRequest('This front desk does not accept sales captured offline');
      const shift = await currentShift(c, i.venue_id);
      let customer = null;
      if (i.customer_handle) {
        customer = (await c.query('SELECT id, display_name FROM users WHERE handle=$1', [i.customer_handle.toLowerCase()])).rows[0];
        if (!customer) throw notFound('Customer');
      }
      const guest = (!customer && (i.guest_name || i.guest_phone)) ? encryptFields({ guest_name: i.guest_name, guest_phone: i.guest_phone }, 'pos_sales', ['guest_name', 'guest_phone']) : {};
      const bookingGuest = guest.guest_name_enc || guest.guest_phone_enc ? { name: encryptFields({ guest_name: i.guest_name }, 'bookings', ['guest_name']).guest_name_enc ?? null, phone: encryptFields({ guest_phone: i.guest_phone }, 'bookings', ['guest_phone']).guest_phone_enc ?? null } : undefined;
      const sale = (await c.query(
        `INSERT INTO pos_sales(venue_id, cashier_id, customer_id, guest_name_enc, guest_phone_enc, shift_id, currency, client_ref, captured_offline_at, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [i.venue_id, user.id, customer?.id ?? null, guest.guest_name_enc ?? null, guest.guest_phone_enc ?? null, shift?.id ?? null, venue.currency, i.client_ref ?? null, i.captured_offline_at ?? null, i.note ?? null])).rows[0];

      const rate = venue.tax_rate_bp, inclusive = venue.tax_inclusive;
      const goods = [];                       // lines billed on the sale's own goods invoice
      const booked = [];                      // court bookings (billed by the reservation)
      const collected = [];                   // existing invoices / academy charges settled at the desk
      const wants = new Map();
      const rentals = [];
      const bookingItems = [];

      for (const l of i.lines) {
        if (l.kind === 'item' || l.kind === 'rental') {
          const w = wants.get(l.item_id) ?? { qty: 0, rental: l.kind === 'rental' };
          if (w.rental !== (l.kind === 'rental')) throw badRequest('The same item cannot be both sold and rented in one sale');
          w.qty += l.qty; wants.set(l.item_id, w);
        }
      }
      const stock = await takeStock(c, i.venue_id, wants, { saleId: sale.id, actor: user });

      for (const l of i.lines) {
        if (l.kind === 'item') {
          const it = stock.get(l.item_id);
          if (it.stock_kind !== 'consumable') throw badRequest(`${it.name} is rental kit — add it as a rental`);
          if (it.sell_price_cents == null) throw badRequest(`${it.name} has no selling price yet`);
          goods.push({ kind: 'item', category: it.category, description: it.name, item_id: it.id, qty: l.qty, unit: Number(it.sell_price_cents), cost: it.unit_cost_cents || null, discountable: true });
        } else if (l.kind === 'rental') {
          const it = stock.get(l.item_id);
          if (it.stock_kind !== 'rental') throw badRequest(`${it.name} is not rental kit`);
          if (it.rental_fee_cents == null) throw badRequest(`${it.name} has no rental fee yet`);
          goods.push({ kind: 'rental', category: 'rental', description: `Rental · ${it.name}`, item_id: it.id, qty: l.qty, unit: Number(it.rental_fee_cents), cost: null, discountable: true, rental: true, deposit: Number(it.deposit_cents) });
          if (Number(it.deposit_cents) > 0) goods.push({ kind: 'deposit', category: 'deposit', description: `Refundable deposit · ${it.name}`, item_id: it.id, qty: l.qty, unit: Number(it.deposit_cents), cost: null, discountable: false, taxable: false });
        } else if (l.kind === 'plan') {
          if (!customer) throw badRequest('A membership or pass belongs to a person — look the customer up by handle first');
          const r = await startUserPlan(c, l.plan_id, customer.id);
          if (!r) throw notFound('Plan');
          if (r.error) throw conflict(r.error);
          const plan = (await c.query('SELECT venue_id FROM venue_plans WHERE id=$1', [l.plan_id])).rows[0];
          if (plan.venue_id !== i.venue_id) throw notFound('Plan');
          goods.push({ kind: 'plan', category: r.plan.kind, description: r.plan.name, plan_id: l.plan_id, user_plan_id: r.plan.id, qty: 1, unit: Number(r.plan.price_cents), cost: null, discountable: false, planPrice: true });
        } else if (l.kind === 'booking') {
          bookingItems.push({ resource_id: l.resource_id, starts_at: l.starts_at, ends_at: l.ends_at, quantity: l.quantity ?? 1, players: l.players });
        } else if (l.kind === 'invoice') {
          const inv = (await c.query("SELECT * FROM invoices WHERE id=$1 AND kind='invoice' FOR UPDATE", [l.invoice_id])).rows[0];
          if (!inv || inv.venue_id !== i.venue_id || inv.pos_sale_id) throw notFound('Invoice');
          if (inv.status !== 'open') throw conflict(`Invoice ${inv.number} is not open`);
          if (inv.currency !== venue.currency) throw badRequest(`Invoice ${inv.number} is in ${inv.currency} but the front desk sells in ${venue.currency}`);
          await assertNotInOpenSale(c, { invoiceId: inv.id });
          collected.push({ kind: 'invoice', category: 'fee', description: `Invoice ${inv.number}`, invoice_id: inv.id, total: inv.total_cents - inv.credits_cents, tax: inv.tax_cents });
        } else if (l.kind === 'academy_charge') {
          const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1 FOR UPDATE', [l.charge_id])).rows[0];
          if (!ch || !venue.organisation_id || ch.organisation_id !== venue.organisation_id) throw notFound('Academy charge');
          if (ch.status !== 'awaiting_payment') throw conflict('That academy charge is not waiting for payment');
          if (ch.currency !== venue.currency) throw badRequest(`This charge is in ${ch.currency} but the front desk sells in ${venue.currency}`);
          await assertNotInOpenSale(c, { chargeId: ch.id });
          const credits = Number((await c.query("SELECT coalesce(sum(credits_cents),0) AS n FROM invoices WHERE academy_charge_id=$1 AND kind='invoice' AND status='open'", [ch.id])).rows[0].n);
          const balance = Number(ch.amount_minor) - Number(ch.settled_minor) - Number(ch.adjusted_minor) - credits;   // part payments and waivers already lowered what is owed
          if (balance <= 0) throw conflict('Nothing is left to pay on that academy charge');
          collected.push({ kind: 'academy_charge', category: 'academy', description: `Academy ${ch.kind} fee`, charge_id: ch.id, total: balance, tax: Math.round(Number(ch.tax_minor) * balance / Math.max(1, Number(ch.amount_minor))) });
        }
      }

      // ---- cart discount on the goods that may be discounted (never deposits or plans); a cashier above the venue limit needs a manager's approval
      const base = goods.filter((g) => g.discountable).reduce((s, g) => s + g.unit * g.qty, 0);
      let discount = 0, approvedBy = null, needsApproval = false;
      if (i.discount) {
        if (!base) throw badRequest('There is nothing in this cart that a discount can apply to');
        discount = discountCents(i.discount, base);
        const bp = Math.round((discount * 10000) / base);
        if (role !== 'manager' && bp > settings.cashier_discount_max_bp) {
          // a quote only prices the cart: it reports that an approval will be needed instead of refusing (nothing is committed or consumed)
          if (i.quote && !i.discount.approval_id) needsApproval = true;
          else approvedBy = await requireApproval(c, { role, user, venueId: i.venue_id, kind: 'discount', amountCents: discount, approvalId: i.discount.approval_id, usedFor: sale.id });
        }
        await audit(c, user.id, 'pos_discount', 'pos_sales', sale.id);
      }
      const shares = allocate(discount, goods.map((g) => (g.discountable ? g.unit * g.qty : 0)));
      goods.forEach((g, k) => Object.assign(g, priceLine({ unit: g.unit, qty: g.qty, discount: shares[k], rateBp: rate, inclusive: g.planPrice ? true : inclusive, taxable: g.taxable !== false })));

      // ---- court time: a real reservation, priced, discounted (promo codes, member rates) and invoiced by the booking engine
      let reservationId = null;
      const bookingInvoices = [];
      if (bookingItems.length) {
        const owned = new Set((await c.query('SELECT id FROM resources WHERE venue_id=$1', [i.venue_id])).rows.map((r) => r.id));
        if (bookingItems.some((b) => !owned.has(b.resource_id))) throw badRequest('Every court must belong to this venue');
        // a manager has the venue's override powers (like override_booking); a cashier books a walk-in under every rule except the notice period, and cannot take a slot offered to someone on the waitlist
        const made = await createReservation(c, { user, userId: customer?.id ?? user.id, items: bookingItems, promo_codes: i.promo_codes ?? [], note: i.note, staff: role === 'manager', walkIn: role !== 'manager', walkInGuest: !customer, source: 'admin', guest: bookingGuest, billing: i.bill_to });
        reservationId = made.reservationId;
        const bks = (await c.query("SELECT b.*, r.name AS resource_name FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.reservation_id=$1 AND b.status='confirmed' ORDER BY b.starts_at, b.id", [reservationId])).rows;
        const invs = (await c.query("SELECT id FROM invoices WHERE reservation_id=$1 AND venue_id=$2 AND kind='invoice'", [reservationId, i.venue_id])).rows;
        for (const inv of invs) bookingInvoices.push(inv.id);
        for (const b of bks) booked.push({ kind: 'booking', category: 'court', description: `${b.resource_name}${b.quantity > 1 ? ` × ${b.quantity}` : ''}`, booking_id: b.id, invoice_id: invs[0]?.id ?? null, qty: 1, unit: Number(b.base_cents), gross: Number(b.base_cents), discount: Number(b.discount_cents), tax: Number(b.tax_cents), total: Number(b.payable_cents) });
      }

      // ---- the goods invoice (canonical, numbered, immutable once issued)
      let goodsInvoice = null;
      if (goods.length) {
        const total = goods.reduce((s, g) => s + g.total, 0), tax = goods.reduce((s, g) => s + g.tax, 0);
        const buyer = { ...(i.bill_to ?? {}), name: i.bill_to?.name ?? customer?.display_name ?? i.guest_name ?? null };
        goodsInvoice = (await c.query(
          `INSERT INTO invoices(kind, number, venue_id, pos_sale_id, user_id, walk_in, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines, payment_method)
           VALUES ('invoice',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL) RETURNING id, number`,
          [await nextNumber(c, venue, 'invoice'), i.venue_id, sale.id, customer?.id ?? user.id, !customer, venue.currency, total, tax, venue.tax_name, rate, inclusive, JSON.stringify(seller(venue)), buyerBlob(buyer),
            JSON.stringify(goods.map((g) => ({ description: g.description, category: g.category, kind: g.kind, qty: g.qty, unit_price_cents: g.unit, discount_cents: g.discount, amount_cents: g.total, tax_cents: g.tax, item_id: g.item_id ?? null })))])).rows[0];
        await c.query("INSERT INTO pos_sale_invoices(sale_id, invoice_id, role) VALUES ($1,$2,'goods')", [sale.id, goodsInvoice.id]);
      }
      for (const id of bookingInvoices) await c.query("INSERT INTO pos_sale_invoices(sale_id, invoice_id, role) VALUES ($1,$2,'booking') ON CONFLICT DO NOTHING", [sale.id, id]);
      for (const x of collected.filter((x) => x.invoice_id)) await c.query("INSERT INTO pos_sale_invoices(sale_id, invoice_id, role) VALUES ($1,$2,'collected')", [sale.id, x.invoice_id]);

      // ---- the sale's own lines (what the receipt and the reports read) and the rentals they create
      let position = 0;
      for (const g of [...goods, ...booked, ...collected]) {
        const row = (await c.query(
          `INSERT INTO pos_sale_lines(sale_id, kind, category, description, item_id, plan_id, user_plan_id, booking_id, invoice_id, charge_id, qty, unit_price_cents, unit_cost_cents, discount_cents, tax_cents, total_cents, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
          [sale.id, g.kind, g.category, g.description, g.item_id ?? null, g.plan_id ?? null, g.user_plan_id ?? null, g.booking_id ?? null, g.invoice_id ?? (g.kind === 'academy_charge' ? null : goodsInvoice?.id ?? null), g.charge_id ?? null,
            g.qty ?? 1, g.unit ?? g.total, g.cost ?? null, g.discount ?? 0, g.tax ?? 0, g.total, position++])).rows[0];
        if (g.rental) for (let n = 0; n < g.qty; n++) rentals.push({ line: row.id, item_id: g.item_id, deposit: g.deposit });
      }
      for (const r of rentals) await c.query('INSERT INTO pos_rentals(sale_id, sale_line_id, venue_id, item_id, deposit_cents) VALUES ($1,$2,$3,$4,$5)', [sale.id, r.line, i.venue_id, r.item_id, r.deposit]);

      const sub = [...goods, ...booked].reduce((s, g) => s + (g.gross ?? g.unit * g.qty), 0) + collected.reduce((s, g) => s + g.total, 0);
      const disc = discount + booked.reduce((s, b) => s + b.discount, 0);
      const tax = [...goods, ...booked, ...collected].reduce((s, g) => s + (g.tax ?? 0), 0);
      const total = [...goods, ...booked, ...collected].reduce((s, g) => s + g.total, 0);
      await c.query('UPDATE pos_sales SET reservation_id=$2, subtotal_cents=$3, discount_cents=$4, tax_cents=$5, total_cents=$6, discount_reason=$7, discount_approved_by=$8 WHERE id=$1',
        [sale.id, reservationId, sub, disc, tax, total, i.discount?.reason ?? null, approvedBy]);

      // ---- tenders taken at the desk; whatever is left stays "awaiting payment" (split tender, or an online payment next)
      for (const t of i.payments ?? []) await recordTender(c, { sale: { ...sale, venue_id: i.venue_id }, user, settings, tender: t, offlineAt: i.captured_offline_at });
      if (!(i.payments ?? []).length || (await saleDue(c, sale.id)).total === 0) await applyIfCovered(c, sale.id, { by: user.id });
      await autoIssueRentals(c, sale.id, user);
      await audit(c, user.id, 'pos_sale', 'pos_sales', sale.id);
      const view = await saleView(c, sale.id, user);
      if (i.quote) throw new QuoteDone({ ...view, needs_approval: needsApproval });
      return view;
    });
  } catch (e) {
    if (e instanceof QuoteDone) return { ...e.view, quote: true };
    if (e.code === '23505' && String(e.constraint).includes('pos_sales_client_ref')) {
      const dup = await one('SELECT id FROM pos_sales WHERE venue_id=$1 AND client_ref=$2', [i.venue_id, i.client_ref]);
      if (dup) return { ...(await tx((c) => saleView(c, dup.id, user))), replayed: true };
    }
    throw e;
  }
}

async function assertNotInOpenSale(c, { invoiceId, chargeId }) {
  const q = invoiceId
    ? "SELECT 1 FROM pos_sale_invoices psi JOIN pos_sales s ON s.id=psi.sale_id WHERE psi.invoice_id=$1 AND s.status='awaiting_payment'"
    : "SELECT 1 FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id WHERE l.charge_id=$1 AND s.status='awaiting_payment'";
  if ((await c.query(q, [invoiceId ?? chargeId])).rowCount) throw conflict('That is already in another sale that has not been paid');
}

// ------------------------------------------------------------------ tenders
/** Record one hand-taken tender (cash, or a card/UPI/bank payment confirmed on the venue's own terminal). Online tenders go through the provider instead. */
export async function recordTender(c, { sale, user, settings, tender, offlineAt = null }) {
  assertManualMethod(settings, tender.method);
  const locked = (await c.query('SELECT * FROM pos_sales WHERE id=$1 FOR UPDATE', [sale.id])).rows[0];
  if (locked.status !== 'awaiting_payment') throw conflict('This sale is not waiting for payment');
  const pending = (await c.query("SELECT 1 FROM pos_sale_payments WHERE sale_id=$1 AND kind='payment' AND method='online' AND status='pending' AND created_at > now() - make_interval(mins => $2)", [sale.id, PENDING_ONLINE_MINUTES])).rowCount;
  if (pending) throw conflict('An online payment for this sale is waiting for the customer — let it finish, or wait a few minutes before taking another tender');
  const due = await saleDue(c, sale.id);
  if (due.total <= 0) throw conflict('Nothing is left to pay on this sale');
  const shift = await currentShift(c, locked.venue_id);
  if (tender.method === 'cash' && settings.require_shift && !shift) throw conflict('Open a shift before taking cash — this front desk reconciles its drawer');
  if (tender.method !== 'cash' && !tender.reference) throw badRequest('Enter the terminal, UPI or bank reference so the payment can be matched later');
  const applied = Math.min(tender.amount_cents ?? tender.tendered_cents ?? due.total, due.total);
  if (applied <= 0) throw badRequest('Enter an amount to take');
  if (tender.method === 'cash' && tender.tendered_cents != null && tender.tendered_cents < applied) throw badRequest('The cash handed over is less than the amount being taken');
  const row = (await c.query(
    `INSERT INTO pos_sale_payments(sale_id, shift_id, kind, method, status, amount_cents, tendered_cents, reference, recorded_by, captured_offline_at, confirmed_at)
     VALUES ($1,$2,'payment',$3,'confirmed',$4,$5,$6,$7,$8,now()) RETURNING id, amount_cents, tendered_cents`,
    [sale.id, shift?.id ?? null, tender.method, applied, tender.method === 'cash' ? (tender.tendered_cents ?? applied) : null, tender.reference ?? null, user.id, offlineAt])).rows[0];
  await audit(c, user.id, `pos_tender_${tender.method}`, 'pos_sale_payments', row.id);
  await applyIfCovered(c, sale.id, { by: user.id });
  return row;
}

export async function addPayment(user, saleId, tender) {
  const s = await one('SELECT venue_id FROM pos_sales WHERE id=$1', [saleId]);
  if (!s) throw notFound('Sale');
  await posRole(user, s.venue_id);
  return tx(async (c) => {
    const settings = await getSettings(c, s.venue_id);
    await recordTender(c, { sale: { id: saleId }, user, settings, tender });
    await autoIssueRentals(c, saleId, user);
    return saleView(c, saleId, user);
  });
}

/** Ask the payment provider to collect what is left. The sale only becomes paid when the provider confirms - never because staff picked a label. */
export async function startOnlinePayment(user, saleId, { provider, return_url }) {
  const s = await one('SELECT * FROM pos_sales WHERE id=$1', [saleId]);
  if (!s) throw notFound('Sale');
  await posRole(user, s.venue_id);
  if (!enabledProviders().includes(provider)) throw badRequest(`${provider} is not enabled on this server`);
  const out = await tx(async (c) => {
    const sale = (await c.query('SELECT * FROM pos_sales WHERE id=$1 FOR UPDATE', [saleId])).rows[0];
    if (sale.status !== 'awaiting_payment') throw conflict('This sale is not waiting for payment');
    const recent = (await c.query("SELECT id FROM pos_sale_payments WHERE sale_id=$1 AND kind='payment' AND method='online' AND status='pending' AND created_at > now() - make_interval(mins => $2)", [saleId, PENDING_ONLINE_MINUTES])).rowCount;
    if (recent) throw conflict('An online payment for this sale is already waiting for the customer');
    // an abandoned checkout no longer blocks the desk; if the customer did pay it late, the provider confirmation is still honoured or refunded
    await c.query("UPDATE pos_sale_payments SET status='failed' WHERE sale_id=$1 AND kind='payment' AND method='online' AND status='pending'", [saleId]);
    return { due: await saleDue(c, saleId), shiftId: (await currentShift(c, sale.venue_id))?.id ?? null };
  });
  if (out.due.total <= 0) throw conflict('Nothing is left to pay on this sale');
  const checkout = await startCheckout({ id: s.cashier_id }, { provider, purpose_type: 'pos_sale', purpose_id: saleId, return_url });
  await one("INSERT INTO pos_sale_payments(sale_id, shift_id, kind, method, status, amount_cents, payment_id, recorded_by) VALUES ($1,$2,'payment','online','pending',$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
    [saleId, out.shiftId, checkout.amount_cents, checkout.id, user.id]);
  return { sale_id: saleId, payment_id: checkout.id, provider, amount_cents: checkout.amount_cents, currency: checkout.currency, checkout_url: checkout.checkout_url, status: 'pending' };
}

/** Ask the provider whether the sale's online payment went through (the webhook does this too). Only the provider's answer can settle it. */
export async function confirmOnlinePayment(user, saleId) {
  const s = await one('SELECT venue_id FROM pos_sales WHERE id=$1', [saleId]);
  if (!s) throw notFound('Sale');
  await posRole(user, s.venue_id);
  const p = await one("SELECT * FROM payments WHERE purpose_type='pos_sale' AND purpose_id=$1 AND status='pending' AND provider_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1", [saleId]);
  if (p) {
    const prov = provider(p.provider);
    const result = p.provider === 'paypal' ? await prov.capture(p.provider_ref) : await prov.retrieve(p.provider_ref);
    await settle(p.id, result);
  }
  return tx((c) => saleView(c, saleId, user));
}

// ------------------------------------------------------------------ rentals handed over at the desk
export async function autoIssueRentals(c, saleId, user) {
  const s = (await c.query('SELECT status FROM pos_sales WHERE id=$1', [saleId])).rows[0];
  if (s?.status !== 'paid') return 0;
  const r = await c.query(
    `UPDATE pos_rentals SET status='issued', issued_at=now(), issued_by=$2, due_at=now() + interval '1 day', deposit_status=CASE WHEN deposit_cents > 0 THEN 'held' ELSE 'none' END WHERE sale_id=$1 AND status='reserved'`, [saleId, user.id]);
  return r.rowCount;
}

// ------------------------------------------------------------------ void (before it is paid)
export async function voidSale(user, saleId, { reason, approval_id }) {
  const s = await one('SELECT * FROM pos_sales WHERE id=$1', [saleId]);
  if (!s) throw notFound('Sale');
  const { role } = await posRole(user, s.venue_id);
  return tx(async (c) => {
    const sale = (await c.query('SELECT * FROM pos_sales WHERE id=$1 FOR UPDATE', [saleId])).rows[0];
    if (sale.status === 'void') throw conflict('This sale is already void');
    if (sale.status === 'paid') throw conflict('A paid sale is not voided — refund it instead, so the invoice, the money and the stock all move together');
    if (role !== 'manager' && sale.cashier_id !== user.id) await requireApproval(c, { role, user, venueId: sale.venue_id, kind: 'void', amountCents: sale.total_cents, approvalId: approval_id, usedFor: saleId });
    const shift = await currentShift(c, sale.venue_id);
    // hand-taken money already received goes straight back
    const taken = (await c.query("SELECT * FROM pos_sale_payments WHERE sale_id=$1 AND kind='payment' AND status='confirmed'", [saleId])).rows;
    if (taken.some((p) => p.method === 'online')) throw conflict('Part of this sale was paid online — let it finish or refund it from the provider before voiding');
    for (const p of taken) {
      await c.query("INSERT INTO pos_sale_payments(sale_id, shift_id, kind, method, status, amount_cents, reference, recorded_by, confirmed_at) VALUES ($1,$2,'refund',$3,'confirmed',$4,$5,$6,now())", [saleId, shift?.id ?? null, p.method, p.amount_cents, p.method === 'cash' ? null : `void:${p.id}`, user.id]);
    }
    await c.query("UPDATE pos_sale_payments SET status='failed' WHERE sale_id=$1 AND kind='payment' AND method='online' AND status='pending'", [saleId]);
    const { rows: invs } = await c.query("SELECT i.* FROM pos_sale_invoices psi JOIN invoices i ON i.id=psi.invoice_id WHERE psi.sale_id=$1 AND psi.role='goods' AND i.status='open' FOR UPDATE OF i", [saleId]);
    for (const inv of invs) {
      if (inv.credits_cents > 0) await returnCredits(c, [inv.id], inv.credits_cents, { adjustInvoice: true, note: 'Front-desk sale voided' });
      await c.query("UPDATE invoices SET status='void', voided_at=now() WHERE id=$1", [inv.id]);
    }
    const bks = (await c.query("SELECT b.id FROM pos_sale_lines l JOIN bookings b ON b.id=l.booking_id WHERE l.sale_id=$1 AND b.status='confirmed'", [saleId])).rows.map((x) => x.id);
    if (bks.length) await cancelBookings(c, bks, { actor: user, byVenue: true, waive: true, silent: true, reason: `Front-desk sale voided: ${reason}` });
    await c.query("UPDATE user_plans SET status='cancelled' WHERE id IN (SELECT user_plan_id FROM pos_sale_lines WHERE sale_id=$1 AND user_plan_id IS NOT NULL) AND status='awaiting_payment'", [saleId]);
    const lines = (await c.query("SELECT item_id, kind, sum(qty)::int AS qty FROM pos_sale_lines WHERE sale_id=$1 AND kind IN ('item','rental') GROUP BY item_id, kind", [saleId])).rows;
    for (const l of lines) await restoreStock(c, sale.venue_id, l.item_id, l.qty, { saleId, reason: l.kind === 'rental' ? 'rental_cancel' : 'sale_void', actor: user });
    await c.query("UPDATE pos_rentals SET status='cancelled', closed_at=now(), closed_by=$2 WHERE sale_id=$1 AND status='reserved'", [saleId, user.id]);
    await c.query("UPDATE pos_sales SET status='void', voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1", [saleId, user.id, reason]);
    await audit(c, user.id, 'pos_void', 'pos_sales', saleId);
    return saleView(c, saleId, user);
  });
}

/** Release sales nobody paid for: an online checkout that was started and never completed holds stock only for a while after its last attempt. */
export async function expireStaleSales({ minutes = 60 } = {}) {
  const stale = await many(
    `SELECT s.id, s.cashier_id FROM pos_sales s WHERE s.status='awaiting_payment'
        AND NOT EXISTS (SELECT 1 FROM pos_sale_payments p WHERE p.sale_id=s.id AND p.kind='payment' AND p.status='confirmed')
        AND EXISTS (SELECT 1 FROM pos_sale_payments p WHERE p.sale_id=s.id AND p.method='online')
        AND NOT EXISTS (SELECT 1 FROM pos_sale_payments p WHERE p.sale_id=s.id AND p.method='online' AND p.created_at > now() - make_interval(mins => $1))
        AND s.created_at < now() - make_interval(mins => $1) LIMIT 50`, [minutes]);
  let n = 0;
  for (const s of stale) {
    try { await voidSale({ id: s.cashier_id, roles: ['admin'] }, s.id, { reason: 'The online payment was not completed in time' }); n++; } catch { /* retried next cycle */ }
  }
  return n;
}

// ------------------------------------------------------------------ returns & refunds
/**
 * Give money back for part of a paid sale as a linked credit note (the issued invoice is never edited). Credit that paid the bill (wallet, points,
 * passes) goes back where it came from; the rest is returned in cash at the desk or to the original online payment.
 */
export async function issueCreditNote(c, { sale, user, invoiceId, amount, tax, lines, method, reason }) {
  const inv = (await c.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId])).rows[0];
  const venue = (await c.query('SELECT * FROM venues WHERE id=$1', [sale.venue_id])).rows[0];
  if (!inv.walk_in) await clawBackPoints(c, [inv.id], amount);   // the points this money earned go back too (the engine takes back only what is still unspent)
  const toWallet = inv.walk_in ? 0 : await returnCredits(c, [inv.id], amount, { note: `Refund · ${inv.number}` });
  const rest = amount - toWallet;
  const online = rest > 0 && (await c.query("SELECT 1 FROM payments WHERE purpose_type='pos_sale' AND purpose_id=$1 AND status IN ('paid','refunded') AND amount_cents > refunded_cents", [sale.id])).rowCount > 0;
  const mode = rest === 0 ? 'done' : method === 'original' && online ? 'pending' : method === 'original' ? 'manual' : 'done';
  const cn = (await c.query(
    `INSERT INTO invoices(kind, number, venue_id, pos_sale_id, user_id, walk_in, parent_id, currency, status, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines, paid_at, refund_status, refund_to_credits_cents, refunded_at)
     VALUES ('credit_note',$1,$2,$3,$4,$5,$6,$7,'paid',$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17, CASE WHEN $16='done' THEN now() END) RETURNING id, number, refund_status`,
    [await nextNumber(c, venue, 'credit_note'), sale.venue_id, sale.id, inv.user_id, inv.walk_in, inv.id, inv.currency, amount, tax, inv.tax_name, inv.tax_rate_bp, inv.tax_inclusive, JSON.stringify(inv.seller), inv.buyer_enc, JSON.stringify(lines), mode, toWallet])).rows[0];
  if (mode === 'pending') c.afterCommit?.(() => kickRefunds());
  // cash that physically leaves the drawer is part of the shift's expected cash
  if (mode === 'done' && rest > 0) {
    const shift = await currentShift(c, sale.venue_id);
    const settings = await getSettings(c, sale.venue_id);
    if (settings.require_shift && !shift) throw conflict('Open a shift before paying cash back — this front desk reconciles its drawer');
    await c.query("INSERT INTO pos_sale_payments(sale_id, shift_id, kind, method, status, amount_cents, credit_note_id, recorded_by, confirmed_at) VALUES ($1,$2,'refund','cash','confirmed',$3,$4,$5,now())", [sale.id, shift?.id ?? null, rest, cn.id, user.id]);
  }
  await audit(c, user.id, 'pos_credit_note', 'invoices', cn.id);
  return { ...cn, cash_back_cents: mode === 'done' ? rest : 0, to_wallet_cents: toWallet, reason };
}

export async function refundSale(user, saleId, i) {
  const s = await one('SELECT * FROM pos_sales WHERE id=$1', [saleId]);
  if (!s) throw notFound('Sale');
  const { role } = await posRole(user, s.venue_id);
  return tx(async (c) => {
    const sale = (await c.query('SELECT * FROM pos_sales WHERE id=$1 FOR UPDATE', [saleId])).rows[0];
    if (sale.status !== 'paid') throw conflict('Only a paid sale can be refunded');
    const settings = await getSettings(c, sale.venue_id);
    const picks = [];
    let total = 0;
    for (const pick of i.lines) {
      const l = (await c.query('SELECT * FROM pos_sale_lines WHERE id=$1 AND sale_id=$2 FOR UPDATE', [pick.line_id, saleId])).rows[0];
      if (!l) throw notFound('Sale line');
      if (!['item', 'booking'].includes(l.kind)) throw badRequest(`${l.description}: ${l.kind === 'deposit' ? 'a rental deposit is paid back when the kit is returned' : 'this line is not refunded at the desk'}`);
      const qty = l.kind === 'booking' ? 1 : pick.qty ?? 1;
      if (l.returned_qty + qty > l.qty) throw conflict(`${l.description}: only ${l.qty - l.returned_qty} left to return`);
      const amount = shareOf(Number(l.total_cents), l.qty, l.returned_qty, qty), tax = shareOf(Number(l.tax_cents), l.qty, l.returned_qty, qty);
      picks.push({ l, qty, amount, tax, restock: pick.restock !== false });
      total += amount;
    }
    if (role !== 'manager' && (settings.refund_limit_cents == null || total > settings.refund_limit_cents)) await requireApproval(c, { role, user, venueId: sale.venue_id, kind: 'refund', amountCents: total, approvalId: i.approval_id, usedFor: saleId });
    const credit = [];
    // goods: one credit note against the sale's goods invoice
    const goodsPicks = picks.filter((p) => p.l.kind === 'item');
    if (goodsPicks.length) {
      const inv = (await c.query("SELECT i.id FROM pos_sale_invoices psi JOIN invoices i ON i.id=psi.invoice_id WHERE psi.sale_id=$1 AND psi.role='goods'", [saleId])).rows[0];
      const amount = goodsPicks.reduce((x, p) => x + p.amount, 0), tax = goodsPicks.reduce((x, p) => x + p.tax, 0);
      const cn = await issueCreditNote(c, { sale, user, invoiceId: inv.id, amount, tax, method: i.method, reason: i.reason,
        lines: goodsPicks.map((p) => ({ description: `Return · ${p.l.description}`, qty: p.qty, amount_cents: p.amount, tax_cents: p.tax, category: p.l.category })) });
      credit.push(cn);
      for (const p of goodsPicks) {
        await c.query('UPDATE pos_sale_lines SET returned_qty = returned_qty + $2 WHERE id=$1', [p.l.id, p.qty]);
        if (p.restock) await restoreStock(c, sale.venue_id, p.l.item_id, p.qty, { saleId, reason: 'return', actor: user, note: i.reason });
      }
    }
    // court time: cancelled through the booking engine, which refunds by the venue's own rules (a venue-initiated cancel refunds in full) and issues its credit note
    const bookingPicks = picks.filter((p) => p.l.kind === 'booking');
    if (bookingPicks.length) {
      const before = new Set((await c.query("SELECT id FROM invoices WHERE reservation_id=$1 AND kind='credit_note'", [sale.reservation_id])).rows.map((r) => r.id));
      await cancelBookings(c, bookingPicks.map((p) => p.l.booking_id), { actor: user, byVenue: true, reason: `Front-desk refund: ${i.reason}` });
      for (const p of bookingPicks) await c.query('UPDATE pos_sale_lines SET returned_qty = 1 WHERE id=$1', [p.l.id]);
      const fresh = (await c.query("SELECT id, number, total_cents, refund_status FROM invoices WHERE reservation_id=$1 AND kind='credit_note'", [sale.reservation_id])).rows.filter((r) => !before.has(r.id));
      // hand-back in cash: finish the credit note and put the cash on the shift
      for (const cn of fresh) {
        if (i.method === 'cash' && cn.refund_status === 'manual') {
          await c.query("UPDATE invoices SET refund_status='done', refunded_at=now() WHERE id=$1", [cn.id]);
          const shift = await currentShift(c, sale.venue_id);
          if (settings.require_shift && !shift) throw conflict('Open a shift before paying cash back — this front desk reconciles its drawer');
          await c.query("INSERT INTO pos_sale_payments(sale_id, shift_id, kind, method, status, amount_cents, credit_note_id, recorded_by, confirmed_at) VALUES ($1,$2,'refund','cash','confirmed',$3,$4,$5,now())", [saleId, shift?.id ?? null, cn.total_cents, cn.id, user.id]);
        }
        credit.push({ id: cn.id, number: cn.number, refund_status: cn.refund_status });
      }
    }
    await audit(c, user.id, 'pos_refund', 'pos_sales', saleId);
    return { ...(await saleView(c, saleId, user)), credit_notes_issued: credit };
  });
}

/** A credit note the card could not take back (part was paid in cash) is paid out by the desk. */
export async function completeManualRefund(user, creditNoteId, { method, reference }) {
  const cn = await one("SELECT * FROM invoices WHERE id=$1 AND kind='credit_note'", [creditNoteId]);
  const saleId = cn && await saleOfCreditNote((t, p) => pool.query(t, p), cn);
  if (!saleId) throw notFound('Credit note');
  await posRole(user, cn.venue_id);
  return tx(async (c) => {
    const cur = (await c.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [creditNoteId])).rows[0];
    if (cur.refund_status !== 'manual') throw conflict('This refund is not waiting for the desk');
    const settings = await getSettings(c, cur.venue_id);
    assertManualMethod(settings, method);
    if (method !== 'cash' && !reference) throw badRequest('Enter the reference of the payment you made');
    const shift = await currentShift(c, cur.venue_id);
    if (method === 'cash' && settings.require_shift && !shift) throw conflict('Open a shift before paying cash back — this front desk reconciles its drawer');
    const online = Number((await c.query("SELECT coalesce(sum(r.amount_cents),0) AS n FROM refund_intents r WHERE r.invoice_id=$1 AND r.status='recorded'", [cur.id])).rows[0].n);
    const owed = cur.total_cents - cur.refund_to_credits_cents - online;
    if (owed > 0) await c.query("INSERT INTO pos_sale_payments(sale_id, shift_id, kind, method, status, amount_cents, reference, credit_note_id, recorded_by, confirmed_at) VALUES ($1,$2,'refund',$3,'confirmed',$4,$5,$6,$7,now())", [saleId, shift?.id ?? null, method, owed, reference ?? null, cur.id, user.id]);
    await c.query("UPDATE invoices SET refund_status='done', refunded_at=now() WHERE id=$1", [cur.id]);
    if (cur.reservation_id) await c.query("UPDATE bookings b SET payment_status='refunded' FROM resources x WHERE x.id=b.resource_id AND x.venue_id=$2 AND b.reservation_id=$1 AND b.payment_status='refund_due'", [cur.reservation_id, cur.venue_id]);
    await audit(c, user.id, 'pos_complete_refund', 'invoices', cur.id);
    return { id: cur.id, number: cur.number, refund_status: 'done', paid_back_cents: Math.max(0, owed) };
  });
}

// ------------------------------------------------------------------ reading a sale
/** `guest: true` decrypts the walk-in guest's name and phone for the team (and audit-logs the read); everything else gets the sale without personal details. */
export async function saleView(c, saleId, viewer, { guest: withGuest = false } = {}) {
  const s = (await c.query('SELECT s.*, cu.display_name AS customer_name, ca.display_name AS cashier_name, v.name AS venue_name FROM pos_sales s JOIN venues v ON v.id=s.venue_id JOIN users ca ON ca.id=s.cashier_id LEFT JOIN users cu ON cu.id=s.customer_id WHERE s.id=$1', [saleId])).rows[0];
  if (!s) throw notFound('Sale');
  const lines = (await c.query('SELECT id, kind, category, description, qty, unit_price_cents, discount_cents, tax_cents, total_cents, returned_qty, item_id, booking_id, invoice_id, user_plan_id FROM pos_sale_lines WHERE sale_id=$1 ORDER BY position', [saleId])).rows;
  const documents = (await c.query(
    `SELECT i.id, i.number, i.kind, i.status, i.total_cents, i.credits_cents, i.tax_cents, i.issued_at, i.paid_at, i.payment_method, i.refund_status, psi.role
       FROM pos_sale_invoices psi JOIN invoices i ON i.id=psi.invoice_id WHERE psi.sale_id=$1 ORDER BY i.issued_at, i.number`, [saleId])).rows;
  const refunds = (await c.query(
    `SELECT i.id, i.number, i.total_cents, i.tax_cents, i.refund_status, i.refund_to_credits_cents, i.issued_at FROM invoices i
      WHERE i.kind='credit_note' AND (i.pos_sale_id=$1 OR ($2::uuid IS NOT NULL AND i.reservation_id=$2 AND i.venue_id=$3)) ORDER BY i.issued_at, i.number`, [saleId, s.reservation_id, s.venue_id])).rows;
  const payments = (await c.query('SELECT id, kind, method, status, amount_cents, tendered_cents, reference, shift_id, payment_id, credit_note_id, created_at, confirmed_at FROM pos_sale_payments WHERE sale_id=$1 ORDER BY created_at, id', [saleId])).rows;
  const rentals = (await c.query('SELECT r.id, r.status, r.deposit_cents, r.deposit_status, r.forfeited_cents, r.issued_at, r.due_at, r.closed_at, r.condition_note, it.name AS item_name FROM pos_rentals r JOIN inventory_items it ON it.id=r.item_id WHERE r.sale_id=$1 ORDER BY r.created_at, r.id', [saleId])).rows;
  const due = s.status === 'awaiting_payment' ? await saleDue(c, saleId) : { total: 0, received: 0, outstanding: 0 };
  let guest = null;
  if (withGuest && (s.guest_name_enc || s.guest_phone_enc)) {
    guest = { name: s.guest_name_enc ? decryptFields({ guest_name_enc: s.guest_name_enc }, 'pos_sales', ['guest_name']).guest_name : null, phone: s.guest_phone_enc ? decryptFields({ guest_phone_enc: s.guest_phone_enc }, 'pos_sales', ['guest_phone']).guest_phone : null };
    if (viewer) await audit(c, viewer.id, 'read_pii', 'pos_sales', saleId);
  }
  const { guest_name_enc, guest_phone_enc, ...rest } = s;
  return { ...rest, customer: s.customer_id ? { id: s.customer_id, name: s.customer_name } : null, guest, has_guest: !!(guest_name_enc || guest_phone_enc), lines, documents, refunds, payments, rentals,
    amount_due_cents: due.total, received_cents: due.received,
    refunded_cents: refunds.reduce((x, r) => x + Number(r.total_cents), 0), pending_online: payments.some((p) => p.method === 'online' && p.status === 'pending') };
}

export async function listSales(user, i) {
  await posRole(user, i.venue_id);
  return many(
    `SELECT s.id, s.status, s.total_cents, s.currency, s.created_at, s.paid_at, ca.display_name AS cashier, coalesce(cu.display_name, 'Walk-in') AS customer,
            (SELECT string_agg(DISTINCT p.method, ',') FROM pos_sale_payments p WHERE p.sale_id=s.id AND p.kind='payment' AND p.status='confirmed') AS methods,
            (SELECT count(*)::int FROM pos_sale_lines l WHERE l.sale_id=s.id) AS line_count
       FROM pos_sales s JOIN users ca ON ca.id=s.cashier_id LEFT JOIN users cu ON cu.id=s.customer_id
      WHERE s.venue_id=$1 AND ($2::uuid IS NULL OR s.shift_id=$2) AND ($3::text IS NULL OR s.status=$3) AND ($4::timestamptz IS NULL OR s.created_at >= $4) AND ($5::timestamptz IS NULL OR s.created_at < $5)
      ORDER BY s.created_at DESC LIMIT $6 OFFSET $7`,
    [i.venue_id, i.shift_id ?? null, i.status ?? null, i.from ?? null, i.to ?? null, i.limit, i.offset]);
}

// ------------------------------------------------------------------ receipts
const METHOD_LABEL = { cash: 'Cash', card_terminal: 'Card (terminal)', upi_manual: 'UPI (recorded by staff)', bank_manual: 'Bank transfer (recorded by staff)', other_manual: 'Other (recorded by staff)', online: 'Online (confirmed by provider)' };

export async function receiptFor(user, saleId) {
  const s = await one('SELECT venue_id FROM pos_sales WHERE id=$1', [saleId]);
  if (!s) throw notFound('Sale');
  await posRole(user, s.venue_id);
  return tx(async (c) => {
    const v = await saleView(c, saleId, user);
    const venue = (await c.query('SELECT * FROM venues WHERE id=$1', [v.venue_id])).rows[0];
    const first = (await c.query("SELECT i.buyer_enc, i.tax_name, i.tax_rate_bp, i.tax_inclusive, i.seller FROM pos_sale_invoices psi JOIN invoices i ON i.id=psi.invoice_id WHERE psi.sale_id=$1 ORDER BY i.issued_at LIMIT 1", [saleId])).rows[0];
    let buyer = null;
    try { buyer = first?.buyer_enc ? JSON.parse(decrypt(first.buyer_enc, 'invoices.buyer')) : null; } catch { buyer = null; }
    const m = (n) => `${v.currency} ${toMajor(Number(n), v.currency)}`;
    const paid = v.payments.filter((p) => p.kind === 'payment' && p.status === 'confirmed').map((p) => ({ method: p.method, label: METHOD_LABEL[p.method], confirmed_by: p.method === 'online' ? 'payment provider' : 'staff (recorded by hand)', amount_cents: Number(p.amount_cents), tendered_cents: p.tendered_cents == null ? null : Number(p.tendered_cents), change_cents: p.tendered_cents == null ? 0 : Number(p.tendered_cents) - Number(p.amount_cents), reference: p.reference }));
    const receipt = {
      sale_id: v.id, status: v.status, issued_at: v.paid_at ?? v.created_at, currency: v.currency,
      seller: seller(venue), tax: { name: venue.tax_name, rate_bp: venue.tax_rate_bp, inclusive: venue.tax_inclusive, amount_cents: Number(v.tax_cents), profile: 'venue_basic' },
      customer: buyer ? { name: buyer.name ?? v.customer?.name ?? null, tax_id: buyer.tax_id ?? null } : (v.customer ? { name: v.customer.name, tax_id: null } : null),
      cashier: v.cashier_name,
      documents: v.documents.map((d) => ({ number: d.number, kind: d.kind, role: d.role, status: d.status })),
      lines: v.lines.map((l) => ({ description: l.description, qty: l.qty, unit_price_cents: Number(l.unit_price_cents), discount_cents: Number(l.discount_cents), tax_cents: Number(l.tax_cents), total_cents: Number(l.total_cents) })),
      totals: { subtotal_cents: Number(v.subtotal_cents), discount_cents: Number(v.discount_cents), tax_cents: Number(v.tax_cents), total_cents: Number(v.total_cents), paid_cents: paid.reduce((x, p) => x + p.amount_cents, 0), due_cents: Number(v.amount_due_cents), refunded_cents: Number(v.refunded_cents) },
      payments: paid, credit_notes: v.refunds.map((r) => ({ number: r.number, total_cents: Number(r.total_cents), refund_status: r.refund_status })),
      notice: 'Shows the venue\'s configured tax name, rate and tax ID. India GST fields (HSN/SAC, CGST/SGST/IGST split) arrive with the shared GST billing profile (#503).',
    };
    receipt.text = [
      `${receipt.seller.name}`, receipt.seller.address, receipt.seller.tax_id ? `${venue.tax_name ?? 'Tax'} ID: ${receipt.seller.tax_id}` : null, '',
      `Receipt ${receipt.documents.map((d) => d.number).join(', ')}`, ...receipt.lines.map((l) => `${l.qty > 1 ? `${l.qty} × ` : ''}${l.description}  ${m(l.total_cents)}`), '',
      receipt.totals.discount_cents ? `Discount −${m(receipt.totals.discount_cents)}` : null, receipt.totals.tax_cents ? `${venue.tax_name ?? 'Tax'} ${venue.tax_inclusive ? 'included' : 'added'}: ${m(receipt.totals.tax_cents)}` : null,
      `Total ${m(receipt.totals.total_cents)}`, ...paid.map((p) => `Paid ${m(p.amount_cents)} · ${p.label}${p.reference ? ` (${p.reference})` : ''}`), receipt.totals.due_cents ? `Still due ${m(receipt.totals.due_cents)}` : null, 'Thank you!',
    ].filter((x) => x !== null).join('\n');
    return receipt;
  });
}

export async function sendReceipt(user, saleId, { channel }) {
  const r = await receiptFor(user, saleId);
  const sale = await one('SELECT customer_id, venue_id, guest_phone_enc FROM pos_sales WHERE id=$1', [saleId]);
  const out = { channel, text: r.text, delivered: false };
  if (channel === 'app') {
    if (!sale.customer_id) throw badRequest('This customer has no account — share the receipt as a message instead');
    await tx((c) => notify(c, sale.customer_id, { kind: 'pos_receipt', title: `Receipt · ${r.documents[0]?.number ?? ''}`, body: r.text, data: { sale_id: saleId, venue_id: sale.venue_id } }));
    out.delivered = true;
  } else if (channel === 'whatsapp') {
    let phone = null;
    if (sale.guest_phone_enc) { phone = decryptFields({ guest_phone_enc: sale.guest_phone_enc }, 'pos_sales', ['guest_phone']).guest_phone; await tx((c) => audit(c, user.id, 'read_pii', 'pos_sales', saleId)); }
    const digits = phone ? phone.replace(/[^\d]/g, '') : '';
    out.whatsapp_url = `https://wa.me/${digits}?text=${encodeURIComponent(r.text)}`;
  }
  return out;
}
