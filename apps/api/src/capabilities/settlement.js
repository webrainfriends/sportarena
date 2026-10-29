// Provider earnings, payout accounts, payouts and payment reconciliation (issue #71). The money rules live in ../settlement.js; this file is the
// API: sellers read their own earnings and manage their payout account, the platform team verifies accounts, records payouts, holds money
// during disputes and works the exception queue. Nobody edits the ledger — every correction is a new line posted by one of these actions.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { config } from '../config.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { recordPayout, resolveDispute } from '../finance.js';
import { balances, explainFailure, payoutBlockers, postChargeback, postPayout, postPayoutReversal, reconcile, reconciliationReport } from '../settlement.js';

const TAG = 'Earnings & settlement';
const day = z.string().date();
const cur = z.string().trim().toUpperCase().length(3).regex(/^[A-Z]{3}$/);
const REASON = z.string().trim().min(5).max(500);
const noSelf = (user, sellerId, what) => { if (sellerId === user.id) throw forbidden(`Another platform team member must ${what} for your own account`); };
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : /^[=+\-@]/.test(s) ? `'${s}` : s; };

const PURPOSE_LABEL = { coach_hire: 'Coaching session', appointment: 'Appointment', physio_package: 'Session package', shop_order: 'Shop order', shop_checkout: 'Shop order', sponsorship_payment: 'Sponsorship' };
const KIND_LABEL = { sale: 'Sale', commission: 'Platform fee', refund: 'Refund to customer', commission_reversal: 'Platform fee returned', chargeback: 'Payment dispute lost', payout: 'Payout', payout_reversal: 'Payout returned to balance' };
const ENTRY_COLS = `l.id, l.created_at, l.kind, l.currency, l.amount_cents, l.gross_cents, l.tax_cents, l.commission_bp, l.available_at, l.purpose_type, l.payment_id, l.payout_id, l.memo, p.status AS payment_status`;
const label = (r) => `${KIND_LABEL[r.kind] ?? r.kind}${r.purpose_type && PURPOSE_LABEL[r.purpose_type] ? ` · ${PURPOSE_LABEL[r.purpose_type]}` : ''}`;
const payoutView = (p) => ({ ...p, ...(p.status === 'failed' ? { explanation: explainFailure(p.failure_code) } : {}) });
const accountView = ({ details_enc, ...a }) => a;

// ------------------------------------------------------------------ seller: payout account
cap({
  name: 'set_payout_account', method: 'POST', path: '/me/payout-accounts', tag: TAG, status: 201, scope: 'payment',
  summary: 'Save the bank account you want earnings paid into, per currency. The details are encrypted; the platform team verifies the account before any payout is sent. Saving again replaces the account for that currency (the old one is kept as history) and it must be verified again.',
  input: z.object({
    currency: cur, holder_name: z.string().trim().min(2).max(120), account_number: z.string().trim().regex(/^[A-Za-z0-9 -]{5,34}$/, 'Enter the account number or IBAN without symbols'),
    bank_code: z.string().trim().regex(/^[A-Za-z0-9 -]{3,20}$/, 'Enter the bank code (IFSC, sort code, SWIFT/BIC or routing number)'),
  }),
  async handler({ user }, i) {
    if (!config.settlement.currencies.includes(i.currency)) throw badRequest(`Payouts are supported in ${config.settlement.currencies.join(', ')} only`);
    const acc = await tx(async (c) => {
      await c.query("UPDATE payout_accounts SET status='superseded' WHERE owner_id=$1 AND currency=$2 AND status IN ('pending','verified')", [user.id, i.currency]);
      const row = (await c.query(
        `INSERT INTO payout_accounts(owner_id, currency, details_enc, last4) VALUES ($1,$2,$3,$4) RETURNING *`,
        [user.id, i.currency, encrypt(JSON.stringify({ holder_name: i.holder_name, account_number: i.account_number, bank_code: i.bank_code }), 'payout_accounts.details'), i.account_number.replace(/[^A-Za-z0-9]/g, '').slice(-4)])).rows[0];
      await audit(c, user.id, 'write_payout_account', 'payout_accounts', row.id);
      return row;
    });
    return accountView(acc);
  },
});

cap({
  name: 'list_payout_accounts', method: 'GET', path: '/me/payout-accounts', tag: TAG,
  summary: 'Your payout accounts (last four characters only) and whether each has been verified.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    return (await many('SELECT * FROM payout_accounts WHERE owner_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset])).map(accountView);
  },
});

// ------------------------------------------------------------------ seller: earnings
cap({
  name: 'get_earnings', method: 'GET', path: '/me/earnings', tag: TAG,
  summary: 'Your earnings per currency: gross sales, platform fees, tax included in sales, refunds, net earned, what has been paid out, what is on its way, what is held or still in its hold period, and what can be paid now — with exactly what is in the way of a payout. A customer showing as paid never means you have been paid; only a payout does. Venue operators also see their partner settlements. Currencies are never added together.',
  async handler({ user }) {
    const list = await balances(user.id);
    const currencies = [];
    for (const b of list) {
      const blockers = await payoutBlockers(user.id, b.currency, b);
      currencies.push({ ...b, payout_blockers: blockers, payout_ready: blockers.filter((x) => x.code !== 'held').length === 0 });
    }
    const failed = await many("SELECT * FROM provider_payouts WHERE seller_id=$1 AND status='failed' AND decided_at > now() - interval '30 days' ORDER BY decided_at DESC, id DESC LIMIT 5", [user.id]);
    const venues = await many(
      `SELECT v.id AS venue_id, v.name AS venue, s.currency, sum(s.sales_cents)::bigint AS sales_cents, sum(s.commission_cents + s.commission_tax_cents)::bigint AS commission_cents, sum(s.gateway_fee_cents)::bigint AS payment_costs_cents,
              coalesce(sum(s.net_payable_cents) FILTER (WHERE s.status='paid'),0)::bigint AS paid_cents, coalesce(sum(s.net_payable_cents) FILTER (WHERE s.status='approved'),0)::bigint AS due_cents
         FROM settlements s JOIN venues v ON v.id=s.venue_id JOIN partners pt ON pt.id=s.partner_id WHERE pt.owner_id=$1 AND s.status IN ('approved','paid') GROUP BY v.id, v.name, s.currency ORDER BY v.name, s.currency`, [user.id]);
    return {
      currencies,
      attention: failed.map((p) => ({ kind: 'payout_failed', payout_id: p.id, amount_cents: p.amount_cents, currency: p.currency, ...explainFailure(p.failure_code), detail: p.failure_reason })),
      venues, venues_note: venues.length ? 'Venue money is settled through your partner contract; see the settlement statements for the detail.' : undefined,
      supported_currencies: config.settlement.currencies, platform_fee_percent: config.settlement.commissionBp / 100, hold_days: config.settlement.holdDays,
    };
  },
});

const entryFields = { currency: cur.optional(), kind: z.enum(['sale', 'commission', 'refund', 'commission_reversal', 'chargeback', 'payout', 'payout_reversal']).optional(), from: day.optional(), to: day.optional() };
const datesOk = (i) => !i.from || !i.to || i.to >= i.from;
const entryWhere = (user, i) => {
  const args = [user.id], w = ['l.seller_id=$1'];
  if (i.currency) { args.push(i.currency); w.push(`l.currency=$${args.length}`); }
  if (i.kind) { args.push(i.kind); w.push(`l.kind=$${args.length}`); }
  if (i.from) { args.push(i.from); w.push(`l.created_at >= $${args.length}::date`); }
  if (i.to) { args.push(i.to); w.push(`l.created_at < ($${args.length}::date + 1)`); }
  return { args, where: w.join(' AND ') };
};

cap({
  name: 'list_earnings_entries', method: 'GET', path: '/me/earnings/entries', tag: TAG,
  summary: 'Your earnings statement line by line, newest first: each sale, platform fee, refund, dispute and payout with its amount, the payment status and when it becomes payable. Buyers are not identified here.',
  input: z.object({ ...entryFields, ...page }).refine(datesOk, 'The end date is before the start'),
  async handler({ user }, i) {
    const { args, where } = entryWhere(user, i);
    const rows = await many(`SELECT ${ENTRY_COLS} FROM provider_ledger l LEFT JOIN payments p ON p.id=l.payment_id WHERE ${where} ORDER BY l.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, label: label(r) }));
  },
});

cap({
  name: 'export_earnings', method: 'GET', path: '/me/earnings/export', tag: TAG,
  summary: 'Your earnings statement as a CSV (date, line, currency, amount, gross, tax included, payment status, reference) for your own accounts. Up to 5000 lines per export; narrow the dates for more. Returns { filename, rows, csv }.',
  input: z.object(entryFields).refine(datesOk, 'The end date is before the start'),
  async handler({ user }, i) {
    const { args, where } = entryWhere(user, i);
    const rows = await many(`SELECT ${ENTRY_COLS} FROM provider_ledger l LEFT JOIN payments p ON p.id=l.payment_id WHERE ${where} ORDER BY l.id ASC LIMIT 5001`, args);
    if (rows.length > 5000) throw badRequest('More than 5000 lines: choose a shorter period');
    const head = ['date', 'line', 'currency', 'amount', 'gross', 'tax_included', 'payment_status', 'payable_from', 'payment_ref', 'payout_ref'];
    const lines = rows.map((r) => [r.created_at.toISOString(), label(r), r.currency, (r.amount_cents / 100).toFixed(2), r.gross_cents == null ? '' : (r.gross_cents / 100).toFixed(2), (r.tax_cents / 100).toFixed(2), r.payment_status ?? '', r.available_at ? r.available_at.toISOString() : '', r.payment_id ?? '', r.payout_id ?? '']);
    return { filename: `earnings${i.from ? `-${i.from}` : ''}${i.to ? `-to-${i.to}` : ''}.csv`, rows: lines.length, csv: [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n') };
  },
});

cap({
  name: 'list_my_payouts', method: 'GET', path: '/me/payouts', tag: TAG,
  summary: 'Payouts sent (or being sent) to you, newest first. A failed payout says why and what to do; your balance is never lost when a payout fails.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    return (await many('SELECT id, currency, amount_cents, status, reference, failure_code, failure_reason, created_at, decided_at FROM provider_payouts WHERE seller_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset])).map(payoutView);
  },
});

// ------------------------------------------------------------------ platform team: accounts
cap({
  name: 'list_payout_accounts_for_review', method: 'GET', path: '/admin/payout-accounts', tag: TAG, auth: ['admin'],
  summary: 'Platform team: payout accounts waiting for verification (oldest first), or by status. Bank details are not shown here.',
  input: z.object({ status: z.enum(['pending', 'verified', 'rejected', 'superseded']).default('pending'), ...page }),
  handler: (_ctx, i) => many(
    `SELECT a.id, a.owner_id, u.display_name AS owner, a.currency, a.method, a.last4, a.status, a.created_at, a.decided_at, a.decision_reason FROM payout_accounts a JOIN users u ON u.id=a.owner_id
      WHERE a.status=$1 ORDER BY a.created_at, a.id LIMIT $2 OFFSET $3`, [i.status, i.limit, i.offset]),
});

cap({
  name: 'decide_payout_account', method: 'POST', path: '/admin/payout-accounts/:id/decision', tag: TAG, auth: ['admin'],
  summary: 'Platform team: verify or reject a seller\'s payout account after checking it (the holder name should match the seller). You cannot decide your own account. The seller is told the outcome.',
  input: z.object({ id, decision: z.enum(['verify', 'reject']), reason: REASON }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM payout_accounts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('Payout account');
      noSelf(user, a.owner_id, 'verify the account');
      if (a.status !== 'pending') throw conflict(`This account is already ${a.status}`);
      const status = i.decision === 'verify' ? 'verified' : 'rejected';
      const row = (await c.query('UPDATE payout_accounts SET status=$2, decided_by=$3, decided_at=now(), decision_reason=$4 WHERE id=$1 RETURNING *', [a.id, status, user.id, i.reason])).rows[0];
      await audit(c, user.id, 'decide_payout_account', 'payout_accounts', a.id);
      await notify(c, a.owner_id, status === 'verified'
        ? { kind: 'payout_account_verified', title: 'Your payout account is verified', body: `Your ${a.currency} account ending ${a.last4} can now receive payouts.`, data: { account_id: a.id } }
        : { kind: 'payout_account_rejected', title: 'Your payout account was not accepted', body: `${i.reason} Add the account again with corrected details.`, data: { account_id: a.id } });
      return accountView(row);
    });
  },
});

cap({
  name: 'reveal_payout_account', method: 'GET', path: '/admin/payout-accounts/:id/details', tag: TAG, auth: ['admin'],
  summary: 'Platform team: read the full bank details of a pending or verified payout account in order to send a transfer. Every read is audit-logged. You cannot read your own account.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await one("SELECT * FROM payout_accounts WHERE id=$1 AND status IN ('pending','verified')", [i.id]);
    if (!a) throw notFound('Payout account');
    noSelf(user, a.owner_id, 'read the details');
    await audit(null, user.id, 'read_payout_account', 'payout_accounts', a.id);
    return { id: a.id, owner_id: a.owner_id, currency: a.currency, status: a.status, ...JSON.parse(decrypt(a.details_enc, 'payout_accounts.details')) };
  },
});

// ------------------------------------------------------------------ platform team: payouts
cap({
  name: 'create_provider_payout', method: 'POST', path: '/admin/provider-payouts', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: start a payout of everything currently available to a seller in one currency. Needs payouts switched on (SETTLEMENT_PAYOUTS), a verified account in that currency and an available balance; held money and sales still in their hold period are excluded. The amount leaves the seller\'s balance at once and is returned if the payout fails. Send the transfer, then record the result. `idempotency_key` makes a retry return the same payout instead of starting a second one.',
  input: z.object({ seller_id: id, currency: cur, idempotency_key: z.string().trim().min(8).max(80) }),
  async handler({ user }, i) {
    noSelf(user, i.seller_id, 'start a payout');
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout:${i.seller_id}:${i.currency}`]);
      const prior = (await c.query('SELECT * FROM provider_payouts WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
      if (prior) {
        if (prior.seller_id !== i.seller_id || prior.currency !== i.currency) throw conflict('That idempotency key was used for a different payout');
        return { ...payoutView(prior), replayed: true };
      }
      const bal = (await balances(i.seller_id, { c })).find((b) => b.currency === i.currency);
      const blockers = bal ? await payoutBlockers(i.seller_id, i.currency, bal) : [{ code: 'nothing_available', message: 'There is nothing available to pay out yet.' }];
      const hard = blockers.filter((b) => b.code !== 'held');
      if (hard.length) throw conflict(hard.map((b) => b.message).join(' '));
      const open = (await c.query("SELECT 1 FROM provider_payouts WHERE seller_id=$1 AND currency=$2 AND status='processing'", [i.seller_id, i.currency])).rowCount;
      if (open) throw conflict('A payout to this seller is already in progress: record its result first');
      const acc = (await c.query("SELECT id FROM payout_accounts WHERE owner_id=$1 AND currency=$2 AND status='verified'", [i.seller_id, i.currency])).rows[0];
      const p = (await c.query('INSERT INTO provider_payouts(seller_id, currency, amount_cents, account_id, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.seller_id, i.currency, bal.available_cents, acc.id, i.idempotency_key, user.id])).rows[0];
      await postPayout(c, { sellerId: p.seller_id, currency: p.currency, payoutId: p.id, amount: Number(p.amount_cents) });
      await recordPayout(c, p, 'open');
      await audit(c, user.id, 'create_provider_payout', 'provider_payouts', p.id);
      return payoutView(p);
    });
  },
});

cap({
  name: 'record_provider_payout_result', method: 'POST', path: '/admin/provider-payouts/:id/result', tag: TAG, auth: ['admin'],
  summary: 'Platform team: record what happened to a payout. `paid` needs the transfer reference (each reference can be used once). `failed` needs a reason code and an explanation the seller will see; the amount returns to their balance and an exception is opened. Repeating the same result is harmless; a different result for a finished payout is refused.',
  input: z.object({ id, outcome: z.enum(['paid', 'failed']), reference: z.string().trim().min(4).max(80).optional(), failure_code: z.enum(['invalid_account', 'account_closed', 'bank_rejected', 'name_mismatch', 'other']).optional(), reason: REASON.optional() }),
  async handler({ user }, i) {
    if (i.outcome === 'paid' && !i.reference) throw badRequest('Enter the transfer reference');
    if (i.outcome === 'failed' && (!i.failure_code || !i.reason)) throw badRequest('Give the reason code and an explanation for the seller');
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM provider_payouts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!p) throw notFound('Payout');
      noSelf(user, p.seller_id, 'record the result');
      if (p.status === i.outcome) return { ...payoutView(p), replayed: true };
      if (p.status !== 'processing') throw conflict(`This payout already ${p.status === 'paid' ? 'completed' : 'failed'}`);
      if (i.outcome === 'paid') {
        const dup = (await c.query('SELECT 1 FROM provider_payouts WHERE reference=$1 AND id<>$2', [i.reference, p.id])).rowCount;
        if (dup) throw conflict('That transfer reference is already recorded on another payout');
        const row = (await c.query("UPDATE provider_payouts SET status='paid', reference=$2, decided_by=$3, decided_at=now() WHERE id=$1 RETURNING *", [p.id, i.reference, user.id])).rows[0];
        await recordPayout(c, row, 'settled');
        await audit(c, user.id, 'record_payout_paid', 'provider_payouts', p.id);
        await notify(c, p.seller_id, { kind: 'payout_paid', title: 'Your payout was sent', body: `${(p.amount_cents / 100).toFixed(2)} ${p.currency} was sent to your bank account (reference ${i.reference}).`, data: { payout_id: p.id }, dedupe_key: `payout_paid:${p.id}` });
        return payoutView(row);
      }
      const row = (await c.query("UPDATE provider_payouts SET status='failed', failure_code=$2, failure_reason=$3, decided_by=$4, decided_at=now() WHERE id=$1 RETURNING *", [p.id, i.failure_code, i.reason, user.id])).rows[0];
      await postPayoutReversal(c, { sellerId: p.seller_id, currency: p.currency, payoutId: p.id, amount: Number(p.amount_cents) });
      await recordPayout(c, row, 'failed');
      await c.query(`INSERT INTO settlement_exceptions(kind, dedupe_key, seller_id, payout_id, currency, amount_cents, detail) VALUES ('payout_failed',$1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) WHERE status='open' DO NOTHING`,
        [`payout_failed:${p.id}`, p.seller_id, p.id, p.currency, p.amount_cents, JSON.stringify({ failure_code: i.failure_code, reason: i.reason })]);
      await audit(c, user.id, 'record_payout_failed', 'provider_payouts', p.id);
      const why = explainFailure(i.failure_code);
      await notify(c, p.seller_id, { kind: 'payout_failed', title: 'Your payout could not be completed', body: `${why.title}. ${why.next_step}`, data: { payout_id: p.id }, dedupe_key: `payout_failed:${p.id}` });
      return payoutView(row);
    });
  },
});

cap({
  name: 'list_payable_sellers', method: 'GET', path: '/admin/provider-payouts/due', tag: TAG, auth: ['admin'],
  summary: 'Platform team: sellers with something available to pay out, per currency, with the one thing in the way of paying each (no or unverified payout account, a payout already in flight, payouts switched off). Largest balance first.',
  input: z.object({ ...page }),
  async handler(_ctx, i) {
    const rows = await many(
      `WITH bal AS (
         SELECT l.seller_id, l.currency, sum(l.amount_cents) FILTER (WHERE l.available_at IS NULL OR l.available_at <= now())::bigint AS vested FROM provider_ledger l GROUP BY l.seller_id, l.currency)
       SELECT b.seller_id, u.display_name AS seller, b.currency,
              greatest(0, b.vested - coalesce((SELECT sum(h.amount_cents) FROM settlement_holds h WHERE h.seller_id=b.seller_id AND h.currency=b.currency AND h.released_at IS NULL), 0))::bigint AS available_cents,
              a.id AS account_id, a.status AS account_status, a.last4,
              EXISTS (SELECT 1 FROM provider_payouts p WHERE p.seller_id=b.seller_id AND p.currency=b.currency AND p.status='processing') AS payout_in_progress
         FROM bal b JOIN users u ON u.id=b.seller_id LEFT JOIN payout_accounts a ON a.owner_id=b.seller_id AND a.currency=b.currency AND a.status IN ('pending','verified')
        WHERE b.vested - coalesce((SELECT sum(h.amount_cents) FROM settlement_holds h WHERE h.seller_id=b.seller_id AND h.currency=b.currency AND h.released_at IS NULL), 0) >= $1
        ORDER BY available_cents DESC, b.seller_id LIMIT $2 OFFSET $3`, [config.settlement.minPayoutCents, i.limit, i.offset]);
    return rows.map((r) => ({
      ...r,
      blocker: r.payout_in_progress ? 'payout_in_progress' : !r.account_id ? 'no_account' : r.account_status !== 'verified' ? 'account_pending' : !config.settlement.payoutsEnabled ? 'payouts_off' : !config.settlement.currencies.includes(r.currency) ? 'currency_unsupported' : null,
    }));
  },
});

cap({
  name: 'list_provider_payouts', method: 'GET', path: '/admin/provider-payouts', tag: TAG, auth: ['admin'],
  summary: 'Platform team: payouts to sellers, newest first, optionally by status or seller.',
  input: z.object({ status: z.enum(['processing', 'paid', 'failed']).optional(), seller_id: id.optional(), ...page }),
  handler: (_ctx, i) => many(
    `SELECT p.id, p.seller_id, u.display_name AS seller, p.currency, p.amount_cents, p.status, p.reference, p.failure_code, p.failure_reason, p.created_at, p.decided_at
       FROM provider_payouts p JOIN users u ON u.id=p.seller_id WHERE ($1::text IS NULL OR p.status=$1) AND ($2::uuid IS NULL OR p.seller_id=$2) ORDER BY p.created_at DESC, p.id DESC LIMIT $3 OFFSET $4`, [i.status ?? null, i.seller_id ?? null, i.limit, i.offset]),
});

// ------------------------------------------------------------------ platform team: holds
cap({
  name: 'place_settlement_hold', method: 'POST', path: '/admin/settlement-holds', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: hold part of a seller\'s balance while a payment or case is reviewed. Held money cannot be paid out and stays in the ledger; release it when the review ends. Pass case_id (it must link the payment) to record the hold on the case timeline. You cannot hold your own balance.',
  input: z.object({ seller_id: id, currency: cur, amount_cents: z.coerce.number().int().min(1), reason: REASON, payment_id: id.optional(), case_id: id.optional() }),
  async handler({ user }, i) {
    noSelf(user, i.seller_id, 'place a hold');
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout:${i.seller_id}:${i.currency}`]);
      const bal = (await balances(i.seller_id, { c })).find((b) => b.currency === i.currency);
      if (!bal || bal.payable_cents - bal.held_cents < i.amount_cents) throw conflict(`Only ${Math.max(0, (bal?.payable_cents ?? 0) - (bal?.held_cents ?? 0))} ${i.currency} of this seller's balance can still be held`);
      if (i.case_id) await assertCaseLinksPayment(c, user, i.case_id, i.payment_id);
      const h = (await c.query('INSERT INTO settlement_holds(seller_id, currency, amount_cents, reason, payment_id, case_id, placed_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.seller_id, i.currency, i.amount_cents, i.reason, i.payment_id ?? null, i.case_id ?? null, user.id])).rows[0];
      if (i.case_id) await c.query("INSERT INTO case_events(case_id, actor_id, action, reason, data) VALUES ($1,$2,'settlement_hold',$3,$4)", [i.case_id, user.id, i.reason, JSON.stringify({ hold_id: h.id, amount_cents: h.amount_cents, currency: h.currency })]);
      await audit(c, user.id, 'place_settlement_hold', 'settlement_holds', h.id);
      return h;
    });
  },
});

cap({
  name: 'release_settlement_hold', method: 'POST', path: '/admin/settlement-holds/:id/release', tag: TAG, auth: ['admin'],
  summary: 'Platform team: release a hold so the money becomes payable again. Releasing twice is harmless. You cannot release a hold on your own balance.',
  input: z.object({ id, reason: REASON }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const h = (await c.query('SELECT * FROM settlement_holds WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!h) throw notFound('Hold');
      noSelf(user, h.seller_id, 'release a hold');
      if (h.released_at) return { ...h, replayed: true };
      const row = (await c.query('UPDATE settlement_holds SET released_at=now(), released_by=$2, release_reason=$3 WHERE id=$1 RETURNING *', [h.id, user.id, i.reason])).rows[0];
      await audit(c, user.id, 'release_settlement_hold', 'settlement_holds', h.id);
      return row;
    });
  },
});

async function assertCaseLinksPayment(c, user, caseId, paymentId) {
  if (!paymentId) throw badRequest('case_id needs the payment the case is about');
  const cs = (await c.query("SELECT c.requester_id FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type='payment' AND l.entity_id=$2 WHERE c.id=$1", [caseId, paymentId])).rows[0];
  if (!cs) throw badRequest('That case does not link this payment');
  if (cs.requester_id === user.id) throw forbidden('Another platform team member must handle your own case');
}

// ------------------------------------------------------------------ platform team: reconciliation and exceptions
cap({
  name: 'get_settlement_reconciliation', method: 'GET', path: '/admin/settlement/reconciliation', tag: TAG, auth: ['admin'],
  summary: 'Platform team: per currency, what customers paid for provider sales (net of refunds) against what the ledger recorded, what the platform owes sellers, fees, payouts in progress and paid, holds, and every open exception. Other funds (wallet top-ups, gift cards, venue and insurance money) are listed separately because they are not provider money. Read-only.',
  handler: () => reconciliationReport(),
});

cap({
  name: 'reconcile_settlement', method: 'POST', path: '/admin/settlement/reconcile', tag: TAG, auth: ['admin'],
  summary: 'Platform team: catch the ledger up with the payments table — post sales for provider payments that have none (for example payments made before settlement existed), bring refunds in line, and open an exception for anything that still does not add up. Safe to run repeatedly and while customers are paying; processes up to 500 payments per run and says if more remain.',
  input: z.object({ limit: z.coerce.number().int().min(1).max(500).default(500) }),
  async handler({ user }, i) {
    const out = await reconcile({ limit: i.limit });
    await audit(null, user.id, 'reconcile_settlement', 'provider_ledger', null);
    return out;
  },
});

cap({
  name: 'list_settlement_exceptions', method: 'GET', path: '/admin/settlement/exceptions', tag: TAG, auth: ['admin'],
  summary: 'Platform team: settlement exceptions that need a person — amount mismatches, shares that do not add up, ledger drift, refunds made at the provider but not recorded, disputes and failed payouts. Newest first.',
  input: z.object({ status: z.enum(['open', 'resolved']).default('open'), kind: z.enum(['paid_without_ledger', 'amount_mismatch', 'refund_unrecorded', 'provider_dispute', 'payout_failed', 'ledger_drift', 'share_mismatch']).optional(), ...page }),
  handler: (_ctx, i) => many(
    `SELECT id, kind, seller_id, payment_id, payout_id, currency, amount_cents, detail, status, resolution, resolved_at, created_at FROM settlement_exceptions
      WHERE status=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`, [i.status, i.kind ?? null, i.limit, i.offset]),
});

cap({
  name: 'resolve_settlement_exception', method: 'POST', path: '/admin/settlement/exceptions/:id/resolution', tag: TAG, auth: ['admin'],
  summary: 'Platform team: close an exception with a reason. For a provider dispute choose `release` (dispute won: the held money becomes payable again) or `reverse` (dispute lost: the sellers\' share is taken back through chargeback lines and the holds end). Anything else is closed with `note` once the underlying cause is fixed. Pass case_id to record it on the dispute timeline. The ledger is never edited.',
  input: z.object({ id, action: z.enum(['note', 'release', 'reverse']), reason: REASON, case_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query('SELECT * FROM settlement_exceptions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!e) throw notFound('Exception');
      if (e.status === 'resolved') return { ...e, replayed: true };
      const isDispute = e.kind === 'provider_dispute';
      if ((i.action === 'release' || i.action === 'reverse') && !isDispute) throw badRequest('Only a provider dispute can be released or reversed');
      if (isDispute && i.action === 'note') throw badRequest('Choose release (dispute won) or reverse (dispute lost)');
      for (const s of (e.detail.held ?? [])) noSelf(user, s.seller_id, 'resolve a dispute');
      if (i.case_id) await assertCaseLinksPayment(c, user, i.case_id, e.payment_id);
      if (isDispute) {
        if (i.action === 'reverse') await postChargeback(c, { exceptionId: e.id, paymentId: e.payment_id, amount: e.amount_cents });
        await resolveDispute(c, e, i.action);
        await c.query("UPDATE settlement_holds SET released_at=now(), released_by=$2, release_reason=$3 WHERE payment_id=$1 AND released_at IS NULL AND reason LIKE 'Dispute %'", [e.payment_id, user.id, i.reason]);
      }
      const row = (await c.query("UPDATE settlement_exceptions SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now() WHERE id=$1 RETURNING *", [e.id, `${i.action}: ${i.reason}`, user.id])).rows[0];
      if (i.case_id) await c.query("INSERT INTO case_events(case_id, actor_id, action, reason, data) VALUES ($1,$2,'settlement_exception',$3,$4)", [i.case_id, user.id, i.reason, JSON.stringify({ exception_id: e.id, kind: e.kind, action: i.action })]);
      await audit(c, user.id, 'resolve_settlement_exception', 'settlement_exceptions', e.id);
      return row;
    });
  },
});
