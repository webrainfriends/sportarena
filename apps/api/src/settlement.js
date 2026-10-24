// Provider earnings and settlement. `payments` records what a customer paid the platform; this module records what the platform then
// owes the person who sold the thing (coach, physio/doctor, shop seller) in an append-only ledger, and what has been paid out.
// Rules: every line is posted with an idempotency key (a replayed webhook, retry or reconcile run cannot post twice), the ledger is never
// edited (a trigger enforces it; corrections are compensating lines), and each currency stands alone. Venue operators settle through partner
// contracts (settlements table) and wallet top-ups / gift cards are platform value, so neither is posted here.
import { pool, many, one, tx } from './db.js';
import { config } from './config.js';
import { conflict } from './errors.js';
import { inclusiveTax } from './capabilities/provider-tax.js';
import { syncSponsorshipRefund, targetOwner } from './sponsor-agreements.js';

/** Who ends up owning the money of a paid payment. */
export const PROVIDER_PURPOSES = ['coach_hire', 'appointment', 'physio_package', 'shop_order', 'shop_checkout', 'sponsorship_payment'];
export function fundsClass(purposeType) {
  if (PROVIDER_PURPOSES.includes(purposeType)) return 'provider';
  if (purposeType === 'venue_invoice' || purposeType === 'venue_plan') return 'partner_settlement';   // settled through the venue's partner contract
  if (purposeType === 'wallet_topup' || purposeType === 'gift_card') return 'platform_wallet';          // stored value owed to the customer, not provider money
  if (purposeType === 'academy_charge') return 'organisation_receivable';                               // owed to the academy; not a provider payout until a settlement confirms it
  return 'insurer_premium';
}

const q = (c) => c ?? pool;
const sum = (a, f) => a.reduce((t, x) => t + Number(f(x)), 0);

/** Split `total` over weights so the parts add up exactly (cumulative rounding). */
export function allocate(total, weights) {
  const all = sum(weights, (w) => w);
  let before = 0, given = 0;
  return weights.map((w) => {
    before += Number(w);
    const upTo = all ? Math.round((total * before) / all) : 0;
    const part = upTo - given;
    given = upTo;
    return part;
  });
}

async function providerTax(c, sellerId, taxClass, gross, at) {
  if (taxClass !== 'taxable') return 0;
  const profile = (await c.query('SELECT registration_status FROM provider_tax_profiles WHERE provider_id=$1 AND effective_from <= $2 ORDER BY effective_from DESC, created_at DESC LIMIT 1', [sellerId, at])).rows[0];
  const rate = (await c.query("SELECT rate_bp FROM provider_tax_rates WHERE provider_id=$1 AND tax_class='taxable' AND effective_from <= $2 ORDER BY effective_from DESC, created_at DESC LIMIT 1", [sellerId, at])).rows[0];
  return profile?.registration_status === 'registered' && rate ? inclusiveTax(gross, rate.rate_bp) : 0;
}

/** [{ sellerId, amount, taxClass }] for a paid payment, read from the record that was paid for. */
export async function sharesFor(c, p) {
  const one1 = async (sql) => (await c.query(sql, [p.purpose_id])).rows[0];
  if (p.purpose_type === 'coach_hire') { const h = await one1('SELECT coach_id FROM coach_hires WHERE id=$1'); return h ? [{ sellerId: h.coach_id, amount: Number(p.amount_cents) }] : []; }
  if (p.purpose_type === 'appointment') { const a = await one1('SELECT provider_id, tax_class FROM appointments WHERE id=$1'); return a ? [{ sellerId: a.provider_id, amount: Number(p.amount_cents), taxClass: a.tax_class }] : []; }
  if (p.purpose_type === 'physio_package') { const k = await one1('SELECT provider_id, tax_class FROM patient_packages WHERE id=$1'); return k ? [{ sellerId: k.provider_id, amount: Number(p.amount_cents), taxClass: k.tax_class }] : []; }
  if (p.purpose_type === 'shop_order') { const o = await one1('SELECT seller_id FROM shop_orders WHERE id=$1'); return o ? [{ sellerId: o.seller_id, amount: Number(p.amount_cents) }] : []; }
  if (p.purpose_type === 'sponsorship_payment') {   // the recipient of the sponsorship is the seller; sponsorship money is never mixed with another purpose
    const d = (await c.query('SELECT s.target_type, s.target_id, x.payee_guardian_id FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorships s ON s.id=o.sponsorship_id WHERE x.id=$1', [p.purpose_id])).rows[0];
    const to = d && (d.payee_guardian_id ?? await targetOwner(c, d.target_type, d.target_id)); // a young athlete's money goes to their guardian payee, never to the minor (#307)
    return to ? [{ sellerId: to, amount: Number(p.amount_cents) }] : [];
  }
  if (p.purpose_type === 'shop_checkout') {
    const rows = (await c.query("SELECT seller_id, sum(total_cents)::bigint AS amount FROM shop_orders WHERE checkout_id=$1 AND status <> 'cancelled' GROUP BY seller_id ORDER BY seller_id", [p.purpose_id])).rows;
    return rows.map((r) => ({ sellerId: r.seller_id, amount: Number(r.amount) }));
  }
  return [];
}

export async function raiseException(c, { kind, dedupeKey, sellerId = null, paymentId = null, payoutId = null, currency = null, amount = null, detail = {} }) {
  const r = await q(c).query(
    `INSERT INTO settlement_exceptions(kind, dedupe_key, seller_id, payment_id, payout_id, currency, amount_cents, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) WHERE status = 'open' DO NOTHING RETURNING id`, [kind, dedupeKey, sellerId, paymentId, payoutId, currency, amount, JSON.stringify(detail)]);
  return r.rows[0]?.id ?? null;
}

const post = (c, e) => c.query(
  `INSERT INTO provider_ledger(seller_id, currency, kind, amount_cents, gross_cents, tax_cents, commission_bp, payment_id, purpose_type, purpose_id, payout_id, available_at, idempotency_key, memo)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
  [e.sellerId, e.currency, e.kind, e.amount, e.gross ?? null, e.tax ?? 0, e.bp ?? null, e.paymentId ?? null, e.purposeType ?? null, e.purposeId ?? null, e.payoutId ?? null, e.availableAt ?? null, e.key, e.memo ?? null]);

/**
 * Post the sale (and the platform fee) for a payment that has just been marked paid. Call inside the settle transaction.
 * Safe to call again: nothing is posted twice. A payment whose sellers cannot be determined, or whose shares do not add up
 * to the amount paid, posts nothing and raises an exception instead of guessing.
 */
export async function recordSale(c, payment) {
  const klass = fundsClass(payment.purpose_type);
  if (klass !== 'provider') return { recorded: false, class: klass };
  const shares = await sharesFor(c, payment);
  if (!shares.length || sum(shares, (s) => s.amount) !== Number(payment.amount_cents)) {
    await raiseException(c, { kind: 'share_mismatch', dedupeKey: `share_mismatch:${payment.id}`, paymentId: payment.id, currency: payment.currency, amount: Number(payment.amount_cents),
      detail: { purpose_type: payment.purpose_type, purpose_id: payment.purpose_id, seller_shares: sum(shares, (s) => s.amount), paid: Number(payment.amount_cents) } });
    return { recorded: false, class: klass, exception: 'share_mismatch' };
  }
  const paidAt = payment.paid_at ?? new Date();
  const availableAt = new Date(+new Date(paidAt) + config.settlement.holdDays * 864e5);
  const bp = config.settlement.commissionBp;
  for (const s of shares) {
    const tax = await providerTax(c, s.sellerId, s.taxClass, s.amount, paidAt);
    const base = { sellerId: s.sellerId, currency: payment.currency, paymentId: payment.id, purposeType: payment.purpose_type, purposeId: payment.purpose_id, availableAt };
    await post(c, { ...base, kind: 'sale', amount: s.amount, gross: s.amount, tax, key: `sale:${payment.id}:${s.sellerId}` });
    const fee = Math.round((s.amount * bp) / 10000);
    if (fee > 0) await post(c, { ...base, kind: 'commission', amount: -fee, bp, key: `commission:${payment.id}:${s.sellerId}` });
  }
  return { recorded: true, class: klass };
}

/**
 * Bring the ledger's refund lines in line with `payments.refunded_cents`. The new refund comes out of `sellerId` when the refund is
 * about that seller's goods (one line of a cart), otherwise out of every seller pro rata to what they still have un-refunded; the
 * platform fee is returned in proportion. Call it in the same transaction that raised `refunded_cents`.
 */
export async function syncRefunds(c, paymentId, { sellerId = null } = {}) {
  const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
  if (!p) return 0;
  const refunded = Math.min(Number(p.refunded_cents), Number(p.amount_cents));
  await c.query(
    `UPDATE settlement_exceptions SET status='resolved', resolution='The refund is now recorded in the ledger', resolved_at=now()
      WHERE kind='refund_unrecorded' AND payment_id=$1 AND status='open' AND (detail->>'provider_refunded_cents')::bigint <= $2`, [p.id, refunded]);
  if (refunded <= 0) return 0;
  await syncSponsorshipRefund(c, p);   // an online sponsorship payment: the due is net of what was given back
  const lines = (await c.query('SELECT seller_id, kind, amount_cents, gross_cents, tax_cents FROM provider_ledger WHERE payment_id=$1 ORDER BY id', [p.id])).rows;
  const sales = lines.filter((l) => l.kind === 'sale').sort((a, b) => (a.seller_id < b.seller_id ? -1 : 1));
  if (!sales.length) return 0;
  const of = (s, kind) => lines.filter((l) => l.seller_id === s.seller_id && l.kind === kind);
  const done = sales.map((s) => -sum(of(s, 'refund'), (l) => l.amount_cents));
  const left = sales.map((s, n) => Number(s.gross_cents) - done[n]);
  const delta = refunded - sum(done, (x) => x);
  if (delta <= 0) return 0;
  const parts = sales.map(() => 0);
  let rest = delta;
  const mine = sales.findIndex((s) => s.seller_id === sellerId);
  if (mine >= 0) { parts[mine] = Math.min(rest, left[mine]); rest -= parts[mine]; }
  if (rest > 0) {
    const w = left.map((x, n) => (n === mine ? 0 : x - parts[n]));
    allocate(rest, w).forEach((x, n) => { parts[n] += x; });
  }
  let posted = 0;
  for (const [n, s] of sales.entries()) {
    if (parts[n] <= 0) continue;
    const share = Number(s.gross_cents), total = done[n] + parts[n];
    const taxDone = -sum(of(s, 'refund'), (l) => l.tax_cents);
    const tax = Number(s.tax_cents) ? Math.round((Number(s.tax_cents) * total) / share) - taxDone : 0;
    const base = { sellerId: s.seller_id, currency: p.currency, paymentId: p.id, purposeType: p.purpose_type, purposeId: p.purpose_id };
    if ((await post(c, { ...base, kind: 'refund', amount: -parts[n], gross: -parts[n], tax: -tax, key: `refund:${p.id}:${s.seller_id}:${refunded}` })).rowCount) posted++;
    const fee = -sum(of(s, 'commission'), (l) => l.amount_cents);
    const back = Math.round((fee * total) / share) - sum(of(s, 'commission_reversal'), (l) => l.amount_cents);
    if (fee > 0 && back > 0) await post(c, { ...base, kind: 'commission_reversal', amount: back, key: `commission_reversal:${p.id}:${s.seller_id}:${refunded}` });
  }
  return posted;
}

/** A lost dispute: the money is gone from the platform, so the sellers' share is taken back (and the fee with it). Idempotent per exception. */
export async function postChargeback(c, { exceptionId, paymentId, amount }) {
  const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
  const lines = (await c.query('SELECT * FROM provider_ledger WHERE payment_id=$1 ORDER BY id', [paymentId])).rows;
  const sales = lines.filter((l) => l.kind === 'sale').sort((a, b) => (a.seller_id < b.seller_id ? -1 : 1));
  if (!p || !sales.length) throw conflict('That payment has nothing recorded in the ledger yet — run reconciliation first');
  const open = Number(p.amount_cents) - Number(p.refunded_cents) - sum(lines.filter((l) => l.kind === 'chargeback'), (l) => -l.amount_cents);
  const total = Math.min(Number(amount), open);
  if (total <= 0) return 0;
  const parts = allocate(total, sales.map((s) => s.gross_cents));
  for (const [n, s] of sales.entries()) {
    if (parts[n] <= 0) continue;
    const base = { sellerId: s.seller_id, currency: p.currency, paymentId: p.id, purposeType: p.purpose_type, purposeId: p.purpose_id };
    await post(c, { ...base, kind: 'chargeback', amount: -parts[n], gross: -parts[n], key: `chargeback:${exceptionId}:${s.seller_id}` });
    const fee = -sum(lines.filter((l) => l.seller_id === s.seller_id && l.kind === 'commission'), (l) => l.amount_cents);
    const back = Math.round((fee * parts[n]) / Number(s.gross_cents));
    if (back > 0) await post(c, { ...base, kind: 'commission_reversal', amount: back, key: `chargeback_fee:${exceptionId}:${s.seller_id}` });
  }
  return total;
}

export const postPayout = (c, { sellerId, currency, payoutId, amount }) => post(c, { sellerId, currency, kind: 'payout', amount: -amount, payoutId, key: `payout:${payoutId}`, memo: 'Payout started' });
export const postPayoutReversal = (c, { sellerId, currency, payoutId, amount }) => post(c, { sellerId, currency, kind: 'payout_reversal', amount, payoutId, key: `payout_reversal:${payoutId}`, memo: 'Payout failed — returned to balance' });

/** Earnings per currency for one seller, all derived from the ledger, payouts and open holds. */
export async function balances(sellerId, { c } = {}) {
  const db = q(c);
  const rows = (await db.query(
    `SELECT currency,
       coalesce(sum(gross_cents) FILTER (WHERE kind='sale'),0)::bigint AS gross_cents,
       (coalesce(-sum(amount_cents) FILTER (WHERE kind='commission'),0) - coalesce(sum(amount_cents) FILTER (WHERE kind IN ('commission_reversal')),0))::bigint AS commission_cents,
       coalesce(sum(tax_cents) FILTER (WHERE kind IN ('sale','refund')),0)::bigint AS tax_cents,
       coalesce(-sum(amount_cents) FILTER (WHERE kind='refund'),0)::bigint AS refunds_cents,
       coalesce(-sum(amount_cents) FILTER (WHERE kind='chargeback'),0)::bigint AS chargebacks_cents,
       coalesce(sum(amount_cents) FILTER (WHERE kind NOT IN ('payout','payout_reversal')),0)::bigint AS net_earned_cents,
       coalesce(sum(amount_cents),0)::bigint AS payable_cents,
       coalesce(sum(amount_cents) FILTER (WHERE available_at IS NULL OR available_at <= now()),0)::bigint AS vested_cents,
       min(available_at) FILTER (WHERE available_at > now()) AS next_release_at
     FROM provider_ledger WHERE seller_id=$1 GROUP BY currency ORDER BY currency`, [sellerId])).rows;
  const pay = (await db.query("SELECT currency, status, sum(amount_cents)::bigint AS amount FROM provider_payouts WHERE seller_id=$1 AND status IN ('paid','processing') GROUP BY currency, status", [sellerId])).rows;
  const holds = (await db.query('SELECT currency, sum(amount_cents)::bigint AS amount FROM settlement_holds WHERE seller_id=$1 AND released_at IS NULL GROUP BY currency', [sellerId])).rows;
  const accounts = (await db.query("SELECT currency, status FROM payout_accounts WHERE owner_id=$1 AND status IN ('pending','verified')", [sellerId])).rows;
  return rows.map((r) => {
    const paid = Number(pay.find((x) => x.currency === r.currency && x.status === 'paid')?.amount ?? 0);
    const processing = Number(pay.find((x) => x.currency === r.currency && x.status === 'processing')?.amount ?? 0);
    const held = Number(holds.find((x) => x.currency === r.currency)?.amount ?? 0);
    const owed = Number(r.net_earned_cents) - paid - processing;       // what the platform still owes, whatever the hold period
    const available = Math.max(0, Number(r.vested_cents) - held);
    const gross = Number(r.gross_cents), commission = Number(r.commission_cents), refunds = Number(r.refunds_cents), chargebacks = Number(r.chargebacks_cents);
    return {
      currency: r.currency, gross_cents: gross, commission_cents: commission, tax_included_cents: Number(r.tax_cents), refunds_cents: refunds, chargebacks_cents: chargebacks,
      net_earned_cents: Number(r.net_earned_cents), paid_out_cents: paid, payout_in_progress_cents: processing, payable_cents: owed,
      held_cents: Math.min(held, Math.max(0, owed)), in_hold_period_cents: Math.max(0, owed - Number(r.vested_cents)), available_cents: available, next_release_at: r.next_release_at,
      account: accounts.find((a) => a.currency === r.currency)?.status ?? null,
      reconciles: gross - commission - refunds - chargebacks === Number(r.net_earned_cents) && owed === Number(r.payable_cents),
    };
  });
}

export const FAILURES = {
  invalid_account: { title: 'The bank details could not be matched to an account', next_step: 'Check the account number and bank code, then save your payout account again. Your balance is unchanged and is sent once the new details are verified.' },
  account_closed: { title: 'The bank account is closed or cannot receive money', next_step: 'Add an account that is open and can receive transfers in this currency. Your balance is unchanged.' },
  bank_rejected: { title: 'Your bank rejected the transfer', next_step: 'Ask your bank why it refused an incoming transfer, or add a different account. Your balance is unchanged.' },
  name_mismatch: { title: 'The account holder name did not match', next_step: 'Use an account held in the same name as your seller profile or registered business, then save it again. Your balance is unchanged.' },
  other: { title: 'The transfer could not be completed', next_step: 'Contact support with the payout reference. Your balance is unchanged and nothing was lost.' },
};
export const explainFailure = (code) => FAILURES[code] ?? FAILURES.other;

/** Can this seller be paid in this currency right now, and if not, what exactly is in the way? */
export async function payoutBlockers(sellerId, currency, bal) {
  const out = [];
  const s = config.settlement;
  if (!s.currencies.includes(currency)) out.push({ code: 'currency_unsupported', message: `Payouts are not available in ${currency} yet. Your earnings stay safely in your balance.` });
  const acc = await one("SELECT status FROM payout_accounts WHERE owner_id=$1 AND currency=$2 AND status IN ('pending','verified')", [sellerId, currency]);
  if (!acc) out.push({ code: 'no_account', message: `Add a bank account in ${currency} to be paid.` });
  else if (acc.status === 'pending') out.push({ code: 'account_pending', message: 'Your payout account is waiting for the platform team to verify it.' });
  if (!s.payoutsEnabled) out.push({ code: 'payouts_off', message: 'Payouts have not been switched on by the platform yet. Your earnings stay safely in your balance.' });
  if (bal && bal.held_cents > 0) out.push({ code: 'held', message: 'Part of your balance is on hold while a payment is reviewed.' });
  if (bal && bal.available_cents < s.minPayoutCents) out.push({ code: 'nothing_available', message: bal.in_hold_period_cents > 0 ? 'Recent sales become payable after the hold period.' : 'There is nothing available to pay out yet.' });
  return out;
}

/** A verified provider event says more was refunded than we have recorded (a refund made in the provider's dashboard, or one still in flight). */
export async function onProviderRefund(c, payment, providerRefundedCents) {
  if (Number(providerRefundedCents) <= Number(payment.refunded_cents)) return false;
  return !!(await raiseException(c, { kind: 'refund_unrecorded', dedupeKey: `refund_unrecorded:${payment.id}`, paymentId: payment.id, currency: payment.currency, amount: Number(providerRefundedCents) - Number(payment.refunded_cents),
    detail: { provider_refunded_cents: Number(providerRefundedCents), recorded_refunded_cents: Number(payment.refunded_cents), note: 'Resolves itself when our own refund is recorded; otherwise review in the provider dashboard.' } }));
}

/**
 * A verified provider event says the customer disputed the payment. Each seller's share is held at once (held money cannot be paid
 * out) and an exception is raised for the platform team, who release it (won) or reverse it (lost) — no one edits the ledger.
 */
export async function onProviderDispute(c, payment, { disputeId, amountCents }) {
  const sales = (await c.query("SELECT seller_id, gross_cents FROM provider_ledger WHERE payment_id=$1 AND kind='sale' ORDER BY seller_id", [payment.id])).rows;
  const remaining = Number(payment.amount_cents) - Number(payment.refunded_cents);
  const disputed = Math.min(Number(amountCents ?? remaining), remaining);
  const held = [];
  if (sales.length && disputed > 0) {
    const parts = allocate(disputed, sales.map((s) => s.gross_cents));
    for (const [n, s] of sales.entries()) {
      if (parts[n] <= 0) continue;
      const exists = (await c.query("SELECT 1 FROM settlement_holds WHERE payment_id=$1 AND seller_id=$2 AND reason LIKE 'Dispute %' AND released_at IS NULL", [payment.id, s.seller_id])).rowCount;
      if (!exists) await c.query('INSERT INTO settlement_holds(seller_id, currency, amount_cents, reason, payment_id) VALUES ($1,$2,$3,$4,$5)', [s.seller_id, payment.currency, parts[n], `Dispute ${disputeId} on a customer payment`, payment.id]);
      held.push({ seller_id: s.seller_id, amount_cents: parts[n] });
    }
  }
  return !!(await raiseException(c, { kind: 'provider_dispute', dedupeKey: `dispute:${payment.provider}:${disputeId}`, paymentId: payment.id, currency: payment.currency, amount: disputed,
    detail: { dispute_id: disputeId, provider: payment.provider, amount_cents: disputed, held, recorded_in_ledger: sales.length > 0 } }));
}

const CLASS_SQL = `CASE WHEN p.purpose_type = ANY($1) THEN 'provider' WHEN p.purpose_type IN ('venue_invoice','venue_plan') THEN 'partner_settlement' WHEN p.purpose_type IN ('wallet_topup','gift_card') THEN 'platform_wallet' ELSE 'insurer_premium' END`;

/**
 * Catch the ledger up with the payments table: post sales for paid provider payments that have none (payments made before settlement
 * existed, or whose posting failed), bring refunds in line, and raise an exception for anything that still does not add up.
 * Idempotent — running it twice, or at the same time as live traffic, posts nothing twice.
 */
export async function reconcile({ limit = 500 } = {}) {
  const missing = await many(
    `SELECT p.* FROM payments p WHERE p.purpose_type = ANY($1) AND p.status IN ('paid','refunded') AND p.paid_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM provider_ledger l WHERE l.payment_id = p.id AND l.kind = 'sale') ORDER BY p.paid_at, p.id LIMIT $2`, [PROVIDER_PURPOSES, limit + 1]);
  let backfilled = 0, unresolved = 0;
  for (const p of missing.slice(0, limit)) {
    const r = await tx(async (c) => { const out = await recordSale(c, p); if (out.recorded) await syncRefunds(c, p.id); return out; });
    if (r.recorded) backfilled++; else unresolved++;
  }
  const drift = await many(
    `SELECT p.id, p.currency, p.amount_cents, p.refunded_cents, coalesce(sum(l.gross_cents) FILTER (WHERE l.kind IN ('sale','refund')),0)::bigint AS ledger_net
       FROM payments p JOIN provider_ledger l ON l.payment_id = p.id AND l.kind IN ('sale','refund')
      GROUP BY p.id HAVING coalesce(sum(l.gross_cents) FILTER (WHERE l.kind IN ('sale','refund')),0) <> p.amount_cents - p.refunded_cents ORDER BY p.id LIMIT $1`, [limit]);
  let repaired = 0, drifting = 0;
  for (const d of drift) {
    await tx((c) => syncRefunds(c, d.id));
    const again = await one("SELECT coalesce(sum(gross_cents),0)::bigint AS n FROM provider_ledger WHERE payment_id=$1 AND kind IN ('sale','refund')", [d.id]);
    if (Number(again.n) === Number(d.amount_cents) - Number(d.refunded_cents)) { repaired++; continue; }
    drifting++;
    await raiseException(null, { kind: 'ledger_drift', dedupeKey: `ledger_drift:${d.id}`, paymentId: d.id, currency: d.currency, amount: Number(d.amount_cents) - Number(d.refunded_cents) - Number(again.n),
      detail: { payment_amount_cents: Number(d.amount_cents), payment_refunded_cents: Number(d.refunded_cents), ledger_net_cents: Number(again.n) } });
  }
  return { backfilled, unresolved, refunds_repaired: repaired, drifting, more: missing.length > limit };
}

/** Money in vs money owed, per currency, with every open exception — the numbers an operator checks before sending payouts. */
export async function reconciliationReport() {
  const collected = await many(
    `SELECT p.currency, ${CLASS_SQL} AS class, count(*)::int AS payments, sum(p.amount_cents)::bigint AS paid_cents, sum(p.refunded_cents)::bigint AS refunded_cents
       FROM payments p WHERE p.status IN ('paid','refunded') GROUP BY p.currency, 2 ORDER BY p.currency, 2`, [PROVIDER_PURPOSES]);
  const unrecorded = await many(
    `SELECT currency, count(*)::int AS payments, sum(amount_cents - refunded_cents)::bigint AS cents FROM payments p WHERE p.purpose_type = ANY($1) AND p.status IN ('paid','refunded')
        AND NOT EXISTS (SELECT 1 FROM provider_ledger l WHERE l.payment_id = p.id AND l.kind='sale') GROUP BY currency ORDER BY currency`, [PROVIDER_PURPOSES]);
  const ledger = await many(
    `SELECT currency,
       coalesce(sum(gross_cents) FILTER (WHERE kind='sale'),0)::bigint AS sales_cents,
       coalesce(-sum(amount_cents) FILTER (WHERE kind='refund'),0)::bigint AS refunds_cents,
       coalesce(-sum(amount_cents) FILTER (WHERE kind='chargeback'),0)::bigint AS chargebacks_cents,
       (coalesce(-sum(amount_cents) FILTER (WHERE kind='commission'),0) - coalesce(sum(amount_cents) FILTER (WHERE kind='commission_reversal'),0))::bigint AS commission_cents,
       coalesce(sum(amount_cents) FILTER (WHERE kind NOT IN ('payout','payout_reversal')),0)::bigint AS earned_cents,
       coalesce(sum(amount_cents),0)::bigint AS owed_cents
     FROM provider_ledger GROUP BY currency ORDER BY currency`);
  const payouts = await many("SELECT currency, status, count(*)::int AS n, sum(amount_cents)::bigint AS cents FROM provider_payouts GROUP BY currency, status ORDER BY currency, status");
  const holds = await many('SELECT currency, count(*)::int AS n, sum(amount_cents)::bigint AS cents FROM settlement_holds WHERE released_at IS NULL GROUP BY currency ORDER BY currency');
  const exceptions = await many("SELECT kind, count(*)::int AS n FROM settlement_exceptions WHERE status='open' GROUP BY kind ORDER BY kind");
  const currencies = [...new Set([...collected, ...ledger].map((r) => r.currency))].sort();
  return {
    currencies: currencies.map((cur) => {
      const prov = collected.find((r) => r.currency === cur && r.class === 'provider');
      const l = ledger.find((r) => r.currency === cur);
      const u = unrecorded.find((r) => r.currency === cur);
      const customerNet = Number(prov?.paid_cents ?? 0) - Number(prov?.refunded_cents ?? 0);
      const ledgerNet = Number(l?.sales_cents ?? 0) - Number(l?.refunds_cents ?? 0);
      const sum1 = (s) => payouts.filter((x) => x.currency === cur && x.status === s).reduce((t, x) => t + Number(x.cents), 0);
      return {
        currency: cur,
        customer_payments_net_cents: customerNet, ledger_net_sales_cents: ledgerNet, unrecorded_payments: u?.payments ?? 0, unrecorded_cents: Number(u?.cents ?? 0),
        difference_cents: customerNet - ledgerNet - Number(u?.cents ?? 0),   // what is still unexplained after the unrecorded payments
        platform_commission_cents: Number(l?.commission_cents ?? 0), chargebacks_cents: Number(l?.chargebacks_cents ?? 0),
        owed_to_sellers_cents: Number(l?.owed_cents ?? 0), payouts_in_progress_cents: sum1('processing'), paid_out_cents: sum1('paid'), failed_payouts: payouts.filter((x) => x.currency === cur && x.status === 'failed').reduce((t, x) => t + x.n, 0),
        held_cents: Number(holds.find((h) => h.currency === cur)?.cents ?? 0),
        balanced: customerNet - ledgerNet === 0 && !u?.payments,   // every customer payment for provider sales is in the ledger, to the cent
        other_funds: collected.filter((r) => r.currency === cur && r.class !== 'provider').map((r) => ({ class: r.class, payments: r.payments, net_cents: Number(r.paid_cents) - Number(r.refunded_cents) })),
      };
    }),
    open_exceptions: exceptions,
    note: 'Customer payments (money the platform collected) are not provider payouts. Wallet top-ups and gift cards are platform stored value; venue money settles through partner contracts.',
  };
}
