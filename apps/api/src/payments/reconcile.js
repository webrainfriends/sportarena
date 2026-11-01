// Razorpay settlement reconciliation (#694). For each day, read the provider's settlement lines (payments, refunds, adjustments), store them, and
// match every payment and refund against our canonical `payments` rows. Anything that does not match is raised as a settlement exception for the
// platform team; nothing is ever changed on a payment from here (reconciliation observes, it does not move money).
import { one, tx } from '../db.js';
import { raiseException } from '../settlement.js';
import { provider } from './providers.js';

const iso = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString() : null);
const dayParts = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });

/** Classify one provider line against our payments. Returns { entity, paymentId, match } and raises exceptions inside the caller's transaction. */
async function matchLine(c, line, settlementRef) {
  const entity = line.type === 'payment' ? 'payment' : line.type === 'refund' ? 'refund' : line.type === 'adjustment' ? 'adjustment' : 'other';
  if (entity === 'adjustment' || entity === 'other') return { entity, paymentId: null, match: 'info' };
  const payRef = entity === 'payment' ? line.entity_id : line.payment_id ?? line.entity_id;
  const p = payRef ? (await c.query("SELECT id, amount_cents, refunded_cents, currency, status FROM payments WHERE provider='razorpay' AND provider_payment_ref=$1", [payRef])).rows[0] : null;
  const dedupe = (kind) => `${kind}:${settlementRef}:${line.entity_id}`;
  if (!p) {
    await raiseException(c, { kind: 'settlement_unknown_payment', dedupeKey: dedupe('settle_unknown'), currency: String(line.currency ?? 'INR').toUpperCase(), amount: Number(line.amount), detail: { settlement: settlementRef, entity, provider_ref: line.entity_id, payment_ref: payRef } });
    return { entity, paymentId: null, match: 'unknown_payment' };
  }
  if (entity === 'payment') {
    if (Number(line.amount) !== Number(p.amount_cents) || String(line.currency).toUpperCase() !== p.currency) {
      await raiseException(c, { kind: 'settlement_amount_mismatch', dedupeKey: dedupe('settle_amount'), paymentId: p.id, currency: p.currency, amount: Number(p.amount_cents), detail: { settlement: settlementRef, provider_amount: Number(line.amount), provider_currency: line.currency, ours: Number(p.amount_cents) } });
      return { entity, paymentId: p.id, match: 'amount_mismatch' };
    }
    return { entity, paymentId: p.id, match: 'matched' };
  }
  // a refund line: our payment must show a refund too
  if (Number(p.refunded_cents) <= 0) {
    await raiseException(c, { kind: 'settlement_refund_unrecorded', dedupeKey: dedupe('settle_refund'), paymentId: p.id, currency: p.currency, amount: Number(line.amount), detail: { settlement: settlementRef, provider_refund: line.entity_id } });
    return { entity, paymentId: p.id, match: 'refund_unrecorded' };
  }
  return { entity, paymentId: p.id, match: 'matched' };
}

/** Reconcile the settlement lines for `days` (YYYY-MM-DD strings). Safe to run again for the same days: items are upserted by (settlement, entity). */
export async function reconcileSettlements(days) {
  const summary = { days: days.length, settlements: 0, items: 0, flagged: 0 };
  for (const day of days) {
    const lines = await provider('razorpay').reconciliation(dayParts(new Date(`${day}T00:00:00Z`)));
    const by = new Map();
    for (const l of lines) { const k = l.settlement_id ?? 'unsettled'; if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
    for (const [ref, items] of by) {
      if (ref === 'unsettled') continue;
      await tx(async (c) => {
        let flagged = 0, fees = 0, tax = 0, net = 0;
        const first = items[0];
        const s = (await c.query(
          `INSERT INTO provider_settlements(provider, provider_ref, utr, currency, settled_at) VALUES ('razorpay',$1,$2,$3,$4)
           ON CONFLICT (provider, provider_ref) DO UPDATE SET utr=coalesce(EXCLUDED.utr, provider_settlements.utr), reconciled_at=now() RETURNING id`,
          [ref, first.settlement_utr ?? null, String(first.currency ?? 'INR').toUpperCase(), iso(first.settled_at)])).rows[0];
        for (const l of items) {
          const m = await matchLine(c, l, ref);
          if (!['matched', 'info'].includes(m.match)) flagged++;
          const fee = Number(l.fee ?? 0), tx_ = Number(l.tax ?? 0);
          fees += fee; tax += tx_; net += Number(l.credit ?? 0) - Number(l.debit ?? 0);
          await c.query(
            `INSERT INTO provider_settlement_items(settlement_id, entity_ref, entity, provider_payment_ref, payment_id, amount_minor, fee_minor, tax_minor, occurred_at, match) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (settlement_id, entity_ref, entity) DO UPDATE SET payment_id=EXCLUDED.payment_id, match=EXCLUDED.match, fee_minor=EXCLUDED.fee_minor, tax_minor=EXCLUDED.tax_minor`,
            [s.id, l.entity_id, m.entity, l.payment_id ?? (m.entity === 'payment' ? l.entity_id : null), m.paymentId, Number(l.amount ?? 0), fee, tx_, iso(l.created_at), m.match]);
        }
        await c.query('UPDATE provider_settlements SET amount_minor=$2, fees_minor=$3, tax_minor=$4, items_total=$5, items_flagged=$6, reconciled_at=now() WHERE id=$1', [s.id, net, fees, tax, items.length, flagged]);
        summary.items += items.length; summary.flagged += flagged; summary.settlements++;
      });
    }
  }
  return summary;
}

/** Worker step: once a day, when Razorpay is configured, reconcile yesterday's settlement lines. Cheap no-op the rest of the time. */
export async function autoReconcile() {
  const { razorpayEnabled } = await import('./providers.js');
  if (!razorpayEnabled()) return 0;
  const recent = await one("SELECT 1 AS x FROM provider_settlements WHERE provider='razorpay' AND reconciled_at > now() - interval '20 hours'");
  if (recent) return 0;
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  return (await reconcileSettlements([y])).settlements;
}
