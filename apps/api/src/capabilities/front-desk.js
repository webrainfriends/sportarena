// Sports Front Desk & POS — selling, taking payment, voiding, refunding and receipts. One definition = REST + OpenAPI + MCP.
// The desk orchestrates canonical records (reservations, venue stock, plans, numbered invoices, payments); see docs/front-desk.md and src/pos/.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { createSale, addPayment, startOnlinePayment, confirmOnlinePayment, voidSale, refundSale, completeManualRefund, receiptFor, sendReceipt, listSales, saleView } from '../pos/sale.js';
import { catalogue, duesFor } from '../pos/catalogue.js';
import { posRole, MANUAL_METHODS } from '../pos/access.js';
import { tx, one } from '../db.js';
import { notFound } from '../errors.js';

const TAG = 'Front desk';
const dt = z.string().datetime({ offset: true });
const approvalRef = z.string().trim().min(4).max(40).optional().describe('a manager\'s approval: its 6-digit code (or id)');

const line = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('item'), item_id: id, qty: z.number().int().min(1).max(500).default(1) }).describe('a consumable from the venue stock: merchandise, shuttlecocks, a drink'),
  z.object({ kind: z.literal('rental'), item_id: id, qty: z.number().int().min(1).max(50).default(1) }).describe('rental kit: a fee now, a refundable deposit, and it must come back'),
  z.object({ kind: z.literal('plan'), plan_id: id }).describe('a membership or pass for the customer (needs customer_handle)'),
  z.object({ kind: z.literal('booking'), resource_id: id, starts_at: dt, ends_at: dt, quantity: z.number().int().min(1).default(1), players: z.number().int().min(1).optional() }).describe('court time: a real reservation, priced by the booking engine'),
  z.object({ kind: z.literal('invoice'), invoice_id: id }).describe('collect an existing open venue invoice at the desk'),
  z.object({ kind: z.literal('academy_charge'), charge_id: id }).describe('collect an academy fee that is waiting for payment (the venue belongs to that academy)'),
]);
const tender = z.object({
  method: z.enum(MANUAL_METHODS), amount_cents: money.optional().describe('what to apply to the sale (default: all that is due)'),
  tendered_cents: money.optional().describe('cash handed over; the change is worked out for you'), reference: z.string().trim().min(2).max(80).optional().describe('card-terminal / UPI / bank reference — required for everything except cash'),
});
const saleBody = {
  id, lines: z.array(line).min(1).max(60),
  customer_handle: z.string().optional().describe('the customer\'s Gotmygame handle; leave out for a walk-in guest'),
  guest_name: z.string().trim().max(80).optional(), guest_phone: z.string().trim().max(30).optional(),
  bill_to: z.object({ name: z.string().trim().max(120).optional(), address: z.string().trim().max(300).optional(), tax_id: z.string().trim().max(40).optional() }).optional().describe('business billing details printed on the invoice'),
  promo_codes: z.array(z.string().trim().max(40)).max(5).default([]).describe('the venue\'s own offer codes, applied by the booking engine to court time'),
  discount: z.object({ kind: z.enum(['percent', 'fixed']), value: z.number().positive(), reason: z.string().trim().min(3).max(200), approval_id: approvalRef.describe('a manager approval, when the discount is above the cashier limit') }).optional(),
  payments: z.array(tender).max(6).default([]),
  client_ref: z.string().min(8).max(80).optional().describe('a key made on the device: sending the same sale again returns the same sale, never a second one'),
  captured_offline_at: dt.optional().describe('when the sale was rung up while the device was offline (cash only)'),
  note: z.string().max(300).optional(),
};

cap({
  name: 'get_front_desk', method: 'GET', path: '/venues/:id/front-desk', tag: TAG,
  summary: 'Everything the front desk needs in one call: what can be sold (stock, rental kit, plans, courts), the open drawer shift, enabled payment methods and the desk rules. Venue team only.',
  input: z.object({ id, q: z.string().max(80).optional() }),
  handler: ({ user }, i) => catalogue(user, { venue_id: i.id, q: i.q }),
});

cap({
  name: 'list_pos_dues', method: 'GET', path: '/venues/:id/pos/dues', tag: TAG,
  summary: 'What can be collected at the desk: open venue invoices not yet in a sale and, when you name a customer, the academy fees they owe the venue\'s academy. Add them to a cart as invoice / academy_charge lines.',
  input: z.object({ id, customer_handle: z.string().optional() }),
  handler: ({ user }, i) => duesFor(user, { venue_id: i.id, customer_handle: i.customer_handle }),
});

cap({
  name: 'quote_pos_sale', method: 'POST', path: '/venues/:id/pos/quote', tag: TAG,
  summary: 'Price a cart exactly as create_pos_sale would — stock, court availability, offers, discounts and tax — then roll everything back. Nothing is reserved or charged.',
  input: z.object(saleBody),
  handler: ({ user }, i) => createSale(user, { ...i, venue_id: i.id, payments: [], quote: true, client_ref: undefined }),
});

cap({
  name: 'create_pos_sale', method: 'POST', path: '/venues/:id/pos/sales', tag: TAG, status: 201, scope: 'payment',
  summary: 'Ring up one cart: walk-in court time, merchandise, food and drink, equipment rental (fee + deposit), memberships/passes, and fees collected at the desk. Court time becomes a real reservation, goods are drawn from the venue stock atomically and billed on a numbered invoice. Tenders recorded here are hand-taken (cash, or a card/UPI/bank payment confirmed on the venue\'s own terminal, with its reference); whatever is not covered stays awaiting payment — take another tender or start an online payment. A sale with the same client_ref is never created twice.',
  input: z.object(saleBody),
  handler: ({ user }, i) => createSale(user, { ...i, venue_id: i.id }),
});

cap({
  name: 'list_pos_sales', method: 'GET', path: '/venues/:id/pos/sales', tag: TAG,
  summary: 'Sales rung up at this front desk, newest first. Filter by shift, status or date.',
  input: z.object({ id, shift_id: id.optional(), status: z.enum(['awaiting_payment', 'paid', 'void']).optional(), from: dt.optional(), to: dt.optional(), ...page }),
  handler: ({ user }, i) => listSales(user, { ...i, venue_id: i.id }),
});

cap({
  name: 'get_pos_sale', method: 'GET', path: '/pos/sales/:id', tag: TAG,
  summary: 'One sale with its lines, the invoices and credit notes that hold its money, every tender (manual vs provider-confirmed), what is still due, and its rentals. Guest details are decrypted for the team and the read is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT venue_id FROM pos_sales WHERE id=$1', [i.id]);
    if (!s) throw notFound('Sale');
    await posRole(user, s.venue_id);
    return tx((c) => saleView(c, i.id, user, { guest: true }));
  },
});

cap({
  name: 'add_pos_payment', method: 'POST', path: '/pos/sales/:id/payments', tag: TAG, scope: 'payment',
  summary: 'Take another hand-recorded tender on a sale that is awaiting payment (split payment). Only tenders the venue has switched on are accepted; everything except cash needs the terminal / UPI / bank reference. An online payment can never be recorded here — the provider confirms it.',
  input: z.object({ id, ...tender.shape }),
  handler: ({ user }, { id: saleId, ...t }) => addPayment(user, saleId, t),
});

cap({
  name: 'start_pos_online_payment', method: 'POST', path: '/pos/sales/:id/online-payment', tag: TAG, scope: 'payment',
  summary: 'Start a provider checkout for what is still due (card / UPI wallet via the enabled provider). Returns a checkout_url to show the customer (open it, or show it as a QR). The sale stays awaiting payment — pending — until the provider itself confirms; staff cannot mark it paid.',
  input: z.object({ id, provider: z.enum(['stripe', 'paypal']), return_url: z.string().url().optional() }),
  handler: ({ user }, i) => startOnlinePayment(user, i.id, { provider: i.provider, return_url: i.return_url }),
});

cap({
  name: 'confirm_pos_online_payment', method: 'POST', path: '/pos/sales/:id/online-payment/confirm', tag: TAG, scope: 'payment',
  summary: 'Ask the payment provider whether the sale\'s online payment went through, and finish the sale if it did. The provider\'s answer is the only thing that can mark an online payment paid. Safe to call repeatedly.',
  input: z.object({ id }),
  handler: ({ user }, i) => confirmOnlinePayment(user, i.id),
});

cap({
  name: 'void_pos_sale', method: 'POST', path: '/pos/sales/:id/void', tag: TAG,
  summary: 'Cancel a sale that has not been paid: stock goes back, the court slots are released, open invoices are voided and hand-taken money is handed back. A cashier may void their own sales; voiding someone else\'s needs a manager approval. A paid sale is refunded, not voided.',
  input: z.object({ id, reason: z.string().trim().min(3).max(200), approval_id: approvalRef }),
  handler: ({ user }, i) => voidSale(user, i.id, { reason: i.reason, approval_id: i.approval_id }),
});

cap({
  name: 'refund_pos_sale', method: 'POST', path: '/pos/sales/:id/refund', tag: TAG, scope: 'payment',
  summary: 'Return goods or cancel court time from a paid sale. The issued invoice is never edited: a linked credit note is issued, credit that paid the bill (wallet, points, passes) goes back to where it came from, the rest is returned in cash at the desk or to the original online payment, and returned goods go back into stock (restock:false writes them off). A cashier above the venue\'s refund limit needs a manager approval.',
  input: z.object({
    id, lines: z.array(z.object({ line_id: id, qty: z.number().int().min(1).max(500).default(1), restock: z.boolean().default(true) })).min(1).max(60),
    method: z.enum(['cash', 'original']).default('original').describe('cash from the drawer, or back to however it was paid'), reason: z.string().trim().min(3).max(200), approval_id: approvalRef,
  }),
  handler: ({ user }, i) => refundSale(user, i.id, i),
});

cap({
  name: 'complete_pos_refund', method: 'POST', path: '/pos/credit-notes/:id/paid-back', tag: TAG, scope: 'payment',
  summary: 'A credit note the card could not take back (it was paid in cash or on the venue\'s terminal) is paid back by the desk. Records how, on the open shift if cash.',
  input: z.object({ id, method: z.enum(MANUAL_METHODS), reference: z.string().trim().min(2).max(80).optional() }),
  handler: ({ user }, i) => completeManualRefund(user, i.id, { method: i.method, reference: i.reference }),
});

cap({
  name: 'get_pos_receipt', method: 'GET', path: '/pos/sales/:id/receipt', tag: TAG,
  summary: 'The receipt for a sale as data (seller with tax ID, lines, tax, tenders and how each was confirmed, credit notes) plus a plain-text version ready to print or share.',
  input: z.object({ id }),
  handler: ({ user }, i) => receiptFor(user, i.id),
});

cap({
  name: 'send_pos_receipt', method: 'POST', path: '/pos/sales/:id/receipt', tag: TAG,
  summary: 'Send the receipt: `app` notifies a customer who has an account; `whatsapp` returns a wa.me link prefilled with the receipt for a guest\'s phone (the number is decrypted for the team and the read is audit-logged). Email goes through the customer\'s notification preferences.',
  input: z.object({ id, channel: z.enum(['app', 'whatsapp']) }),
  handler: ({ user }, i) => sendReceipt(user, i.id, { channel: i.channel }),
});
