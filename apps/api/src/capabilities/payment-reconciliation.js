// Platform admin: reconcile Razorpay settlements against our payments (#694). Observes only; it raises settlement exceptions, it never changes a payment.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { reconcileSettlements } from '../payments/reconcile.js';

const TAG = 'Payments';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

cap({
  name: 'reconcile_provider_settlements', method: 'POST', path: '/admin/payments/reconcile', tag: TAG, auth: ['admin'], scope: 'admin',
  summary: 'Platform admin only. Pull the Razorpay settlement lines for a date range (at most 31 days) and match every payment and refund against our payments. Lines that do not match (unknown payment, different amount, refund we never recorded) are raised as settlement exceptions for the platform team. Safe to run again for the same days. Returns how many settlements, lines and flagged lines were seen.',
  input: z.object({ from: day, to: day }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const a = new Date(`${i.from}T00:00:00Z`), b = new Date(`${i.to}T00:00:00Z`);
    if (!(a <= b) || (b - a) / 864e5 > 30) throw badRequest('Choose a range of at most 31 days, from before to');
    const days = []; for (let d = new Date(a); d <= b; d = new Date(+d + 864e5)) days.push(d.toISOString().slice(0, 10));
    const out = await reconcileSettlements(days);
    await audit(null, user.id, 'reconcile_provider_settlements', 'provider_settlements', null);
    return out;
  },
});

cap({
  name: 'list_provider_settlements', method: 'GET', path: '/admin/payments/settlements', tag: TAG, auth: ['admin'], scope: 'admin',
  summary: 'Platform admin only. Provider settlements already reconciled, newest first, with the net paid out, fees, tax and how many lines still need attention.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    return many('SELECT id, provider_ref, utr, currency, amount_minor, fees_minor, tax_minor, settled_at, items_total, items_flagged, reconciled_at FROM provider_settlements ORDER BY settled_at DESC NULLS LAST, reconciled_at DESC LIMIT $1 OFFSET $2', [i.limit, i.offset]);
  },
});

cap({
  name: 'get_provider_settlement', method: 'GET', path: '/admin/payments/settlements/:id', tag: TAG, auth: ['admin'], scope: 'admin',
  summary: 'Platform admin only. One settlement with every line and whether it matched our payments (matched, amount_mismatch, unknown_payment, refund_unrecorded, info).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const s = await one('SELECT * FROM provider_settlements WHERE id=$1', [i.id]);
    if (!s) throw notFound('Settlement');
    const items = await many('SELECT entity_ref, entity, provider_payment_ref, payment_id, amount_minor, fee_minor, tax_minor, occurred_at, match FROM provider_settlement_items WHERE settlement_id=$1 ORDER BY occurred_at, entity_ref', [s.id]);
    return { settlement: s, items };
  },
});
