// Academy fees in the canonical invoices table. A charge (what the family owes, snapshotted at enrolment) gets one numbered invoice owned by the
// organisation; paying the charge pays the invoice, cancelling voids it, and a refund issues a credit note. The numbers are gapless per
// organisation and kind, the same promise venue invoices make. Nothing here moves money: payments, refunds and settlement stay in their modules.
import { encrypt } from './crypto.js';
import { notify } from './notify.js';
import { activateUserPlan } from './booking/plans.js';
import { conflict } from './errors.js';

const ZERO = 0;
/** A short, unique, readable prefix for an organisation's invoices: the profile's own, else 3 letters of the name + a slice of the id. */
async function prefixOf(c, org) {
  const p = (await c.query('SELECT invoice_prefix FROM academy_profiles WHERE organisation_id=$1', [org.id])).rows[0];
  if (p?.invoice_prefix) return p.invoice_prefix;
  const base = org.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
  const hex = org.id.replace(/-/g, '').toUpperCase();
  for (let len = 3; len <= 5; len++) {
    await c.query('SAVEPOINT academy_prefix');
    try {
      await c.query(
        `INSERT INTO academy_profiles(organisation_id, invoice_prefix) VALUES ($1,$2)
         ON CONFLICT (organisation_id) DO UPDATE SET invoice_prefix = coalesce(academy_profiles.invoice_prefix, EXCLUDED.invoice_prefix)`, [org.id, `${base}${hex.slice(0, len)}`]);
      await c.query('RELEASE SAVEPOINT academy_prefix');
      break;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT academy_prefix');
      if (e.code !== '23505' || len === 5) throw e;
    }
  }
  return (await c.query('SELECT invoice_prefix FROM academy_profiles WHERE organisation_id=$1', [org.id])).rows[0].invoice_prefix;
}

async function nextNumber(c, org, kind) {
  const prefix = await prefixOf(c, org);
  const { seq } = (await c.query(
    `INSERT INTO org_invoice_counters(organisation_id, kind, seq) VALUES ($1,$2,1) ON CONFLICT (organisation_id, kind) DO UPDATE SET seq = org_invoice_counters.seq + 1 RETURNING seq`, [org.id, kind])).rows[0];
  return `${kind === 'credit_note' ? 'CN-' : ''}${prefix}-${new Date().getUTCFullYear()}-${String(seq).padStart(6, '0')}`;
}

const chargeContext = async (c, chargeId) => (await c.query(
  `SELECT ch.*, o.name AS org_name, o.id AS org_id, pr.title AS programme, u.display_name AS payer_name
     FROM academy_charges ch JOIN organisations o ON o.id=ch.organisation_id
     LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id
     LEFT JOIN academy_applications a ON a.id=ch.application_id
     LEFT JOIN academy_programmes pr ON pr.id = coalesce(e.programme_id, a.programme_id)
     JOIN users u ON u.id=ch.payer_id WHERE ch.id=$1`, [chargeId])).rows[0];

const KIND = { registration: 'Joining fee', deposit: 'Deposit', tuition: 'Tuition', instalment: 'Instalment', trial: 'Trial fee', pack: 'Session pack', dues: 'Dues', late_fee: 'Late fee' };
const sellerOf = async (c, ctx) => {
  const p = (await c.query('SELECT legal_name, tax_id, billing_address FROM academy_profiles WHERE organisation_id=$1', [ctx.org_id])).rows[0] ?? {};
  return { name: p.legal_name ?? ctx.org_name, tax_id: p.tax_id ?? null, address: p.billing_address ?? null, phone: null, email: null };
};
const linesOf = (ctx) => {
  const t = KIND[ctx.kind] ?? ctx.kind;
  const rows = [{ description: `${ctx.programme ?? 'Academy'} · ${t}`, amount_cents: Number(ctx.gross_minor), tax_cents: Number(ctx.tax_minor) }];
  if (Number(ctx.discount_minor) > 0) rows.push({ description: ctx.terms?.discount_reason === 'promo' ? `Promo code ${ctx.terms.promo?.code ?? ''}`.trim() : `Discount (${String(ctx.terms?.discount_reason ?? 'offer').replace('_', ' ')})`, amount_cents: -Number(ctx.discount_minor), tax_cents: ZERO });
  if (Number(ctx.funded_minor) > 0) rows.push({ description: `Funded by ${ctx.funding_source}${ctx.funding_ref ? ` (${ctx.funding_ref})` : ''}`, amount_cents: -Number(ctx.funded_minor), tax_cents: ZERO });
  return rows;
};

/**
 * Bring the invoice in line with the charge: create it when the charge first needs payment, revise it while still open, void it when the charge
 * is cancelled or fully covered. A paid invoice is never edited. Safe to call again.
 */
export async function syncChargeInvoice(c, chargeId) {
  const ctx = await chargeContext(c, chargeId);
  if (!ctx) return null;
  const inv = (await c.query("SELECT * FROM invoices WHERE academy_charge_id=$1 AND kind='invoice' AND status IN ('open','paid') FOR UPDATE", [chargeId])).rows[0];
  if (inv?.status === 'paid') return inv;
  const wanted = ctx.status === 'awaiting_payment' && Number(ctx.amount_minor) > 0;
  if (!wanted) {
    if (inv) await c.query("UPDATE invoices SET status='void', voided_at=now() WHERE id=$1", [inv.id]);
    return null;
  }
  const rate = Number(ctx.terms?.tax_rate_bp ?? 0);
  const org = { id: ctx.org_id, name: ctx.org_name };
  if (inv) {
    const changed = Number(inv.total_cents) !== Number(ctx.amount_minor);
    return (await c.query('UPDATE invoices SET lines=$2, total_cents=$3, tax_cents=$4, revision=revision+$5, seller=$6 WHERE id=$1 RETURNING *',
      [inv.id, JSON.stringify(linesOf(ctx)), Number(ctx.amount_minor), Number(ctx.tax_minor), changed ? 1 : 0, JSON.stringify(await sellerOf(c, ctx))])).rows[0];
  }
  return (await c.query(
    `INSERT INTO invoices(kind, number, organisation_id, academy_charge_id, user_id, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines)
     VALUES ('invoice',$1,$2,$3,$4,$5,$6,$7,'Tax',$8,true,$9,$10,$11) RETURNING *`,
    [await nextNumber(c, org, 'invoice'), ctx.org_id, chargeId, ctx.payer_id, ctx.currency, Number(ctx.amount_minor), Number(ctx.tax_minor), rate, JSON.stringify(await sellerOf(c, ctx)),
      encrypt(JSON.stringify({ name: ctx.payer_name, address: null, tax_id: null }), 'invoices.buyer'), JSON.stringify(linesOf(ctx))])).rows[0];
}

/** What is still owed on a charge: the amount less what was received and what was waived or conceded. */
export const balanceOf = (ch) => Number(ch.amount_minor) - Number(ch.settled_minor ?? 0) - Number(ch.adjusted_minor ?? 0);

/** Finish a charge whose balance reached zero: the invoice is settled, a linked pack/membership period starts, the payer is told. */
async function closeCharge(c, ch, { method, paid }) {
  if (paid) {
    await syncChargeInvoice(c, ch.id);            // make sure there is an invoice to settle (a free-standing charge may not have one yet)
    await c.query("UPDATE invoices SET status='paid', paid_at=now(), payment_method=$2 WHERE academy_charge_id=$1 AND kind='invoice' AND status='open'", [ch.id, method]);
    await c.query("UPDATE academy_charges SET status='paid', paid_at=now() WHERE id=$1", [ch.id]);
  } else {
    await c.query("UPDATE academy_charges SET status='waived' WHERE id=$1", [ch.id]);
    await syncChargeInvoice(c, ch.id);            // nothing is left to pay: the open invoice is voided
  }
  if (ch.user_plan_id) await activateUserPlan(c, ch.user_plan_id);
}

/**
 * Money received against a charge: a desk payment (the whole balance, or a part when `amountMinor` is given) or an online payment. Every receipt is a
 * row (append-only); the charge keeps the running total, and when the balance reaches zero the charge and its invoice become paid. Idempotent per
 * `key` and per payment, so a retry, a replayed webhook or a double tap adds nothing. The original charge and invoice are never edited.
 * Returns { applied, replay, completed, balance_minor, receipt_id } - applied is false when the charge can no longer be paid.
 */
export async function applyReceipt(c, chargeId, { amountMinor = null, method = 'online', payment = null, actor = null, key = null } = {}) {
  const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1 FOR UPDATE', [chargeId])).rows[0];
  if (!ch) return { applied: false };
  const prior = payment
    ? (await c.query('SELECT * FROM charge_receipts WHERE payment_id=$1', [payment.id])).rows[0]
    : key ? (await c.query('SELECT * FROM charge_receipts WHERE charge_id=$1 AND idempotency_key=$2', [chargeId, key])).rows[0] : null;
  if (prior) return { applied: true, replay: true, completed: ch.status === 'paid', balance_minor: balanceOf(ch), receipt_id: prior.id };
  if (ch.status !== 'awaiting_payment') return { applied: false };
  const balance = balanceOf(ch);
  let amount = amountMinor ?? (payment ? Number(payment.amount_cents) : balance);
  if (amount > balance) {
    if (!payment) throw conflict(`Only ${balance} is still owed on this charge`, { balance_minor: balance });
    // the balance shrank (a desk payment or a waiver) after this checkout started: take what is owed and put the difference in front of finance
    const { raiseException } = await import('./settlement.js');
    await raiseException(c, { kind: 'amount_mismatch', dedupeKey: `charge_balance_changed:${payment.id}`, paymentId: payment.id, currency: payment.currency, amount: amount - balance, detail: { reason: 'charge_balance_changed', charge_id: chargeId, paid_minor: amount, balance_minor: balance } });
    amount = balance;
  }
  if (amount <= 0) return { applied: false };
  const receipt = (await c.query(
    'INSERT INTO charge_receipts(charge_id, amount_minor, method, payment_id, recorded_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [chargeId, amount, method, payment?.id ?? null, actor, key])).rows[0];
  const after = (await c.query('UPDATE academy_charges SET settled_minor = settled_minor + $2 WHERE id=$1 RETURNING *', [chargeId, amount])).rows[0];
  const left = balanceOf(after);
  if (left === 0) {
    await closeCharge(c, after, { method, paid: true });
    await notify(c, ch.payer_id, { kind: 'academy_payment_received', title: 'Payment received', body: 'Open Gotmygame to see your receipt.', data: { organisation_id: ch.organisation_id, charge_id: ch.id }, dedupe_key: `academy:paid:${ch.id}` });
  } else {
    await notify(c, ch.payer_id, { kind: 'academy_payment_part', title: 'Part payment received', body: 'Open Gotmygame to see what is still due.', data: { organisation_id: ch.organisation_id, charge_id: ch.id }, dedupe_key: `academy:part:${receipt.id}` });
  }
  return { applied: true, replay: false, completed: left === 0, balance_minor: left, receipt_id: receipt.id, amount_minor: amount };
}

/**
 * The charge was paid in full (online by the provider, or recorded by staff). Marks the charge and its invoice paid, starts a linked pack/membership
 * period and tells the payer. Idempotent: false when the charge can no longer be paid.
 */
export async function fulfilChargePaid(c, chargeId, { method = 'online', payment = null } = {}) {
  return (await applyReceipt(c, chargeId, { method, payment })).applied;
}

/**
 * A waiver (forgiven) or concession (goodwill reduction) against an unpaid charge: an explicit, attributed row that lowers the balance. The price is
 * not edited and the invoice is not rewritten. When the balance reaches zero the charge is waived (nothing was paid) or paid (it was part paid).
 */
export async function applyAdjustment(c, chargeId, { kind, amountMinor, reasonEnc, actor, key }) {
  const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1 FOR UPDATE', [chargeId])).rows[0];
  if (!ch) return null;
  const prior = (await c.query('SELECT * FROM charge_adjustments WHERE charge_id=$1 AND idempotency_key=$2', [chargeId, key])).rows[0];
  if (prior) return { replay: true, adjustment_id: prior.id, balance_minor: balanceOf(ch), charge_status: ch.status };
  if (ch.status !== 'awaiting_payment') throw conflict('Only an unpaid charge can be waived or reduced');
  const balance = balanceOf(ch);
  if (amountMinor > balance) throw conflict(`Only ${balance} is still owed on this charge`, { balance_minor: balance });
  const row = (await c.query('INSERT INTO charge_adjustments(charge_id, kind, amount_minor, reason_enc, actor_id, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [chargeId, kind, amountMinor, reasonEnc, actor, key])).rows[0];
  const after = (await c.query('UPDATE academy_charges SET adjusted_minor = adjusted_minor + $2 WHERE id=$1 RETURNING *', [chargeId, amountMinor])).rows[0];
  const left = balanceOf(after);
  if (left === 0) {
    await closeCharge(c, after, { method: 'settled', paid: Number(after.settled_minor) > 0 });
    if (kind === 'waiver') {
      // forgiving the fee forgives the lateness: an unpaid late fee on it goes with it (a fee already part paid or adjusted is left for staff to decide)
      const fees = (await c.query("UPDATE academy_charges SET status='cancelled' WHERE parent_charge_id=$1 AND kind='late_fee' AND status='awaiting_payment' AND settled_minor=0 AND adjusted_minor=0 RETURNING id", [chargeId])).rows;
      for (const f of fees) await syncChargeInvoice(c, f.id);
    }
  }
  await notify(c, ch.payer_id, { kind: 'academy_balance_adjusted', title: left === 0 ? 'Nothing more to pay' : 'Your balance was reduced', body: 'Open Gotmygame to see the details.', data: { organisation_id: ch.organisation_id, charge_id: ch.id }, dedupe_key: `academy:adjust:${row.id}` });
  return { replay: false, adjustment_id: row.id, balance_minor: left, charge_status: left === 0 ? (Number(after.settled_minor) > 0 ? 'paid' : 'waived') : 'awaiting_payment' };
}

/** Cancel what is unpaid for a set of charges (a withdrawal): the charge, its invoice and the plan period it would have bought. */
export async function cancelUnpaidCharges(c, where, params) {
  const rows = (await c.query(`UPDATE academy_charges SET status='cancelled' WHERE status='awaiting_payment' AND ${where} RETURNING id, user_plan_id`, params)).rows;
  for (const r of rows) {
    await c.query("UPDATE invoices SET status='void', voided_at=now() WHERE academy_charge_id=$1 AND kind='invoice' AND status='open'", [r.id]);
    if (r.user_plan_id) await c.query("UPDATE user_plans SET status='cancelled' WHERE id=$1 AND status='awaiting_payment'", [r.user_plan_id]);
  }
  return rows.length;
}

/** A refund went back to the payer: a credit note against the invoice (gapless numbering, its own kind). Idempotent per refund key. */
export async function creditChargeInvoice(c, chargeId, amountMinor, key) {
  const ctx = await chargeContext(c, chargeId);
  const inv = (await c.query("SELECT * FROM invoices WHERE academy_charge_id=$1 AND kind='invoice' AND status='paid'", [chargeId])).rows[0];
  if (!ctx || !inv) return null;
  const again = (await c.query('SELECT * FROM invoices WHERE academy_charge_id=$1 AND academy_refund_key=$2', [chargeId, key])).rows[0];
  if (again) return again;
  const tax = inv.total_cents ? Math.round((Number(inv.tax_cents) * amountMinor) / Number(inv.total_cents)) : 0;
  return (await c.query(
    `INSERT INTO invoices(kind, number, organisation_id, academy_charge_id, user_id, parent_id, currency, status, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines, paid_at, refund_status, refunded_at, academy_refund_key)
     VALUES ('credit_note',$1,$2,$3,$4,$5,$6,'paid',$7,$8,$9,$10,$11,$12,$13,$14,now(),'done',now(),$15) RETURNING *`,
    [await nextNumber(c, { id: ctx.org_id, name: ctx.org_name }, 'credit_note'), ctx.org_id, chargeId, inv.user_id, inv.id, inv.currency, amountMinor, tax, inv.tax_name, inv.tax_rate_bp, inv.tax_inclusive, JSON.stringify(inv.seller), inv.buyer_enc,
      JSON.stringify([{ description: `Refund · ${ctx.programme ?? 'Academy'} · ${KIND[ctx.kind] ?? ctx.kind}`, amount_cents: amountMinor, tax_cents: tax }]), key])).rows[0];
}
