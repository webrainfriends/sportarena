// Invoices, credit notes, currencies and the multi-currency owner summary.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, mustFind, isAdmin } from '../helpers.js';
import { canManage, mustManage } from '../booking/engine.js';
import { markInvoicePaid, buyerOf } from '../booking/invoices.js';
import { notify } from '../notify.js';
import { CURRENCIES, toMajor } from '../currency.js';
import { enabledProviders } from '../payments/service.js';

const TAG = 'Invoices & payments';
const day = z.string().date();
const METHODS = ['cash', 'card', 'upi', 'bank', 'other'];

cap({
  name: 'list_currencies', method: 'GET', path: '/currencies', tag: TAG, auth: 'public',
  summary: 'Currencies a venue can price and invoice in, with symbol and minor-unit exponent (JPY 0, most others 2). Amounts everywhere are integers in minor units.',
  handler: () => Object.entries(CURRENCIES).map(([code, c]) => ({ code, name: c.name, symbol: c.symbol, exponent: c.exp })),
});

const summaryCols = 'i.id, i.number, i.kind, i.status, i.venue_id, v.name AS venue_name, i.reservation_id, rs.code AS reservation_code, i.currency, i.total_cents, i.credits_cents, i.tax_cents, i.issued_at, i.paid_at, i.payment_method, i.refund_status, i.parent_id';
cap({
  name: 'list_invoices', method: 'GET', path: '/invoices', tag: TAG,
  summary: 'Your invoices and credit notes (newest first). The venue team passes venue_id to list that venue\'s, filtered by status, kind or date.',
  input: z.object({ venue_id: id.optional(), reservation_id: id.optional(), kind: z.enum(['invoice', 'credit_note']).optional(), status: z.enum(['open', 'paid', 'void']).optional(), from: day.optional(), to: day.optional(), ...page }),
  async handler({ user }, i) {
    if (i.venue_id) await mustManage(user, i.venue_id);
    return many(
      `SELECT ${summaryCols} FROM invoices i JOIN venues v ON v.id=i.venue_id JOIN reservations rs ON rs.id=i.reservation_id
        WHERE ($1::uuid IS NULL AND i.user_id=$2 OR i.venue_id=$1) AND ($3::uuid IS NULL OR i.reservation_id=$3) AND ($4::text IS NULL OR i.kind=$4) AND ($5::text IS NULL OR i.status=$5)
          AND ($6::date IS NULL OR i.issued_at >= $6) AND ($7::date IS NULL OR i.issued_at < $7::date + 1)
        ORDER BY i.issued_at DESC, i.number DESC LIMIT $8 OFFSET $9`,
      [i.venue_id ?? null, user.id, i.reservation_id ?? null, i.kind ?? null, i.status ?? null, i.from ?? null, i.to ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_invoice', method: 'GET', path: '/invoices/:id', tag: TAG,
  summary: 'One invoice or credit note, complete and printable: seller (legal name, tax id, address), bill-to (decrypted; audit-logged), lines, tax breakdown, payments and any credit notes against it. The buyer or the venue team only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const inv = await one(`SELECT i.*, v.name AS venue_name, rs.code AS reservation_code FROM invoices i JOIN venues v ON v.id=i.venue_id JOIN reservations rs ON rs.id=i.reservation_id WHERE i.id=$1`, [i.id]);
    if (!inv) throw notFound('Invoice');
    const team = await canManage(user, inv.venue_id);
    if (inv.user_id !== user.id && !team && !isAdmin(user)) throw forbidden();
    await audit(null, user.id, 'read_pii', 'invoices', inv.id);
    const [payments, credits] = await Promise.all([
      many("SELECT id, provider, amount_cents, currency, status, paid_at, refunded_cents FROM payments WHERE purpose_type='venue_invoice' AND purpose_id=$1 ORDER BY created_at", [inv.id]),
      inv.kind === 'invoice' ? many("SELECT id, number, total_cents, status, refund_status, issued_at FROM invoices WHERE kind='credit_note' AND reservation_id=$1 AND venue_id=$2 ORDER BY issued_at", [inv.reservation_id, inv.venue_id]) : [],
    ]);
    const { buyer_enc, ...rest } = inv;
    const online = (await one('SELECT payment_mode FROM venues WHERE id=$1', [inv.venue_id])).payment_mode !== 'pay_at_venue' && enabledProviders().length > 0;
    return { ...rest, amount_due_cents: inv.status === 'open' ? inv.total_cents - inv.credits_cents : 0, buyer: buyerOf(inv), payments, credit_notes: credits, can_pay_online: online && inv.kind === 'invoice' && inv.status === 'open' && inv.user_id === user.id, providers: enabledProviders(), amount: toMajor(inv.total_cents, inv.currency) };
  },
});

cap({
  name: 'mark_invoice_paid', method: 'POST', path: '/invoices/:id/paid', tag: TAG,
  summary: 'The venue team records that an open invoice was paid at the venue (cash, card, UPI, bank transfer …). The customer gets a receipt notification and their bookings show as paid.',
  input: z.object({ id, method: z.enum(METHODS).default('cash') }),
  async handler({ user }, i) {
    const inv = await mustFind('invoices', i.id);
    if (inv.kind !== 'invoice') throw badRequest('Only invoices are paid; a credit note is refunded');
    await mustManage(user, inv.venue_id);
    return tx(async (c) => {
      if (!(await markInvoicePaid(c, i.id, { method: i.method, by: user.id }))) throw conflict('That invoice is not open (already paid or void)');
      await audit(c, user.id, 'mark_invoice_paid', 'invoices', i.id);
      return (await c.query('SELECT id, number, status, payment_method, paid_at FROM invoices WHERE id=$1', [i.id])).rows[0];
    });
  },
});

cap({
  name: 'mark_credit_note_refunded', method: 'POST', path: '/invoices/:id/refunded', tag: TAG,
  summary: 'The venue team records that it handed a refund back (cash paid at the venue, or the part of a refund the card could not take). Online refunds are paid automatically.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cn = await mustFind('invoices', i.id);
    if (cn.kind !== 'credit_note') throw badRequest('That is not a credit note');
    await mustManage(user, cn.venue_id);
    return tx(async (c) => {
      const r = await c.query("UPDATE invoices SET refund_status='done', refunded_at=now(), refund_error=NULL WHERE id=$1 AND refund_status IN ('manual','failed') RETURNING id, number, refund_status, refunded_at", [i.id]);
      if (!r.rowCount) throw conflict('Nothing to mark: this refund is already done or is being paid automatically');
      await c.query("UPDATE bookings b SET payment_status='refunded' FROM resources x WHERE x.id=b.resource_id AND x.venue_id=$2 AND b.reservation_id=$1 AND b.payment_status='refund_due'", [cn.reservation_id, cn.venue_id]);
      await notify(c, cn.user_id, { kind: 'refund_issued', title: `Refund handed back · ${cn.number}`, body: `${cn.currency} ${toMajor(cn.total_cents, cn.currency)} was returned by the venue.`, data: { invoice_id: cn.id, reservation_id: cn.reservation_id } });
      return r.rows[0];
    });
  },
});

cap({
  name: 'owner_summary', method: 'GET', path: '/me/venue-summary', tag: TAG,
  summary: 'Everything you run in one view, multi-currency: per venue (currency, bookings, revenue, tax, invoiced, collected, outstanding, refunds owed) and grand totals per currency — currencies are never added together.',
  input: z.object({ from: day, to: day }).refine((i) => i.to >= i.from, 'to is before from'),
  async handler({ user }, i) {
    const rows = await many(
      `WITH mine AS (SELECT v.id, v.name, v.emoji, v.currency, 'owner' AS role FROM venues v WHERE v.owner_id=$1
                      UNION SELECT v.id, v.name, v.emoji, v.currency, s.role FROM venue_staff s JOIN venues v ON v.id=s.venue_id WHERE s.user_id=$1 AND s.removed_at IS NULL)
       SELECT m.*,
         (SELECT count(*)::int FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=m.id AND b.status IN ('confirmed','no_show') AND b.starts_at >= $2 AND b.starts_at < $3::date + 1) AS bookings,
         (SELECT coalesce(sum(b.price_cents),0)::int FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=m.id AND b.status IN ('confirmed','no_show') AND b.starts_at >= $2 AND b.starts_at < $3::date + 1) AS revenue_cents,
         (SELECT coalesce(sum(b.tax_cents),0)::int FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=m.id AND b.status IN ('confirmed','no_show') AND b.starts_at >= $2 AND b.starts_at < $3::date + 1) AS tax_cents,
         (SELECT coalesce(sum(total_cents) FILTER (WHERE status='paid'),0)::int FROM invoices i WHERE i.venue_id=m.id AND i.kind='invoice' AND i.issued_at >= $2 AND i.issued_at < $3::date + 1) AS collected_cents,
         (SELECT coalesce(sum(total_cents) FILTER (WHERE status='open'),0)::int FROM invoices i WHERE i.venue_id=m.id AND i.kind='invoice' AND i.issued_at >= $2 AND i.issued_at < $3::date + 1) AS outstanding_cents,
         (SELECT coalesce(sum(total_cents) FILTER (WHERE refund_status IN ('pending','manual','failed')),0)::int FROM invoices i WHERE i.venue_id=m.id AND i.kind='credit_note') AS refunds_owed_cents
       FROM mine m ORDER BY m.name`, [user.id, i.from, i.to]);
    const by = new Map();
    for (const r of rows) {
      const t = by.get(r.currency) ?? { currency: r.currency, venues: 0, bookings: 0, revenue_cents: 0, tax_cents: 0, collected_cents: 0, outstanding_cents: 0, refunds_owed_cents: 0 };
      t.venues++;
      for (const k of ['bookings', 'revenue_cents', 'tax_cents', 'collected_cents', 'outstanding_cents', 'refunds_owed_cents']) t[k] += r[k];
      by.set(r.currency, t);
    }
    return { from: i.from, to: i.to, venues: rows, by_currency: [...by.values()] };
  },
});
