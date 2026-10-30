// Unified Finance control plane (#564): the one canonical, append-only record of every money movement. Modules do not own a financial
// truth: each money path posts here (idempotently, in the same transaction as the movement it records) and the console, dashboards,
// exports and reconciliation read only from here. See docs/finance.md for the model, the module map and what is migrated.
import { many, one, pool, tx } from './db.js';
import { sharesFor } from './settlement.js';

/** payments.purpose_type -> the business module whose money it is. A type missing here is labelled 'other', never dropped. */
export const MODULE_OF = {
  shop_order: 'shop', shop_checkout: 'shop', coach_hire: 'coaching', appointment: 'health', physio_package: 'health', insurance_policy: 'insurance',
  venue_invoice: 'venue', venue_plan: 'venue', pos_sale: 'venue', wallet_topup: 'wallet', gift_card: 'wallet', sponsorship_payment: 'sponsorship',
  academy_charge: 'registration', registration_instalment: 'registration', team_charge: 'registration', team_contribution: 'registration', media_rights_fee: 'media', ad_funding: 'advertising',
  service_invoice: 'suppliers',
};
export const moduleOf = (type) => MODULE_OF[type] ?? 'other';
export const MODULE_LABEL = {
  registration: 'Registration & dues', venue: 'Venue', coaching: 'Coaching', health: 'Doctor & physio', shop: 'Shop', wallet: 'Wallet', sponsorship: 'Sponsorship',
  suppliers: 'Suppliers', insurance: 'Insurance', media: 'Media rights', advertising: 'Advertising', travel: 'Travel', officials: 'Officials', agents: 'Agents', other: 'Other',
};

const q = (c) => c ?? pool;
const n = (x) => Number(x ?? 0);

/** Run a read that is allowed to fail without poisoning the surrounding transaction (a savepoint, then a fallback). */
async function safe(c, fn, fallback) {
  if (!c || c === pool) { try { return await fn(q(c)); } catch { return fallback; } }
  await c.query('SAVEPOINT fin_safe');
  try { const r = await fn(c); await c.query('RELEASE SAVEPOINT fin_safe'); return r; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT fin_safe'); await c.query('RELEASE SAVEPOINT fin_safe'); return fallback; }
}

/** Who received / paid in organisation terms, read from the record that was paid for. Best effort: a miss leaves the org null, never blocks the posting. */
async function parties(c, p) {
  const out = { payeeId: null, payeeOrgId: null, payerOrgId: null };
  const get = (sql, params = [p.purpose_id]) => safe(c, async (k) => (await k.query(sql, params)).rows[0] ?? null, null);
  const t = p.purpose_type;
  if (t === 'venue_invoice') {
    const r = await get('SELECT v.owner_id, v.organisation_id FROM invoices i JOIN venues v ON v.id=i.venue_id WHERE i.id=$1');
    if (r) { out.payeeId = r.owner_id; out.payeeOrgId = r.organisation_id; }
  } else if (t === 'venue_plan') {
    const r = await get('SELECT v.owner_id, v.organisation_id FROM user_plans up JOIN venues v ON v.id=up.venue_id WHERE up.id=$1');
    if (r) { out.payeeId = r.owner_id; out.payeeOrgId = r.organisation_id; }
  } else if (t === 'academy_charge') {
    const r = await get('SELECT organisation_id FROM academy_charges WHERE id=$1');
    if (r) out.payeeOrgId = r.organisation_id;
  } else if (t === 'registration_instalment') {
    const r = await get('SELECT p.owner_id, p.organisation_id FROM rx_instalments i JOIN rx_entries e ON e.id=i.entry_id JOIN rx_programmes p ON p.id=e.programme_id WHERE i.id=$1');
    if (r) { out.payeeId = r.owner_id; out.payeeOrgId = r.organisation_id; }
  } else if (t === 'team_charge') {
    const r = await get('SELECT t.owner_id, t.organisation_id FROM team_charges ch JOIN teams t ON t.id=ch.team_id WHERE ch.id=$1');
    if (r) { out.payeeId = r.owner_id; out.payeeOrgId = r.organisation_id; }
  } else if (t === 'team_contribution') {
    const r = await get('SELECT t.owner_id, t.organisation_id FROM team_contributions c JOIN team_fundraisers f ON f.id=c.fundraiser_id JOIN teams t ON t.id=f.team_id WHERE c.id=$1');
    if (r) { out.payeeId = r.owner_id; out.payeeOrgId = r.organisation_id; }
  } else if (t === 'media_rights_fee') {
    const r = await get('SELECT m.organisation_id FROM mr_fees f JOIN mr_licences l ON l.id=f.licence_id JOIN media_partners m ON m.id=l.partner_id WHERE f.id=$1');
    if (r) out.payerOrgId = r.organisation_id;
  } else if (t === 'service_invoice') {
    const r = await get('SELECT p.owner_id, p.organisation_id FROM svc_invoices s JOIN svc_profiles p ON p.id=s.profile_id WHERE s.id=$1');
    if (r) { out.payeeId = r.owner_id; out.payeeOrgId = r.organisation_id; }
    const b = await get('SELECT b.organisation_id FROM svc_invoices s JOIN svc_buyers b ON b.id=s.buyer_id WHERE s.id=$1');
    if (b?.organisation_id) out.payerOrgId = b.organisation_id;
  } else {
    const shares = await safe(c, (k) => sharesFor(k, p), []);
    if (shares.length === 1) out.payeeId = shares[0].sellerId;   // a single seller: the money is theirs
  }
  return out;
}

const insert = async (c, e) => {
  const r = (await q(c).query(
    `INSERT INTO fin_transactions(kind, status, source_module, source_type, source_id, payer_id, payee_id, payer_org_id, payee_org_id, currency, gross_minor, tax_minor, fee_minor, discount_minor, net_minor,
       provider, provider_ref, payment_id, payout_id, parent_id, idem_key, occurred_at, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,coalesce($22, now()),$23)
     ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    [e.kind, e.status ?? 'settled', e.module, e.sourceType, e.sourceId ?? null, e.payerId ?? null, e.payeeId ?? null, e.payerOrgId ?? null, e.payeeOrgId ?? null, e.currency, e.gross,
      e.tax ?? 0, e.fee ?? 0, e.discount ?? 0, e.net ?? e.gross - (e.tax ?? 0) - (e.fee ?? 0), e.provider ?? null, e.providerRef ?? null, e.paymentId ?? null, e.payoutId ?? null,
      e.parentId ?? null, e.key, e.at ?? null, JSON.stringify(e.meta ?? {})])).rows[0];
  if (r) await q(c).query("INSERT INTO fin_tx_events(tx_id, actor_id, action, data) VALUES ($1,$2,$3,$4)", [r.id, e.actorId ?? null, 'posted', JSON.stringify({ kind: e.kind, status: e.status ?? 'settled' })]);
  return r?.id ?? null;
};

const setStatus = async (c, idem, status, actorId = null, data = {}) => {
  const r = (await q(c).query('UPDATE fin_transactions SET status=$2 WHERE idem_key=$1 AND status <> $2 RETURNING id', [idem, status])).rows[0];
  if (r) await q(c).query('INSERT INTO fin_tx_events(tx_id, actor_id, action, data) VALUES ($1,$2,$3,$4)', [r.id, actorId, `status_${status}`, JSON.stringify(data)]);
  return !!r;
};

/** A charge: money someone owes for a thing, open until paid. Posted when checkout starts. */
export async function recordCharge(c, p) {
  const who = await parties(c, p);
  return insert(c, { kind: 'charge', status: 'open', module: moduleOf(p.purpose_type), sourceType: p.purpose_type, sourceId: p.purpose_id, payerId: p.payer_id, payeeId: who.payeeId,
    payerOrgId: who.payerOrgId, payeeOrgId: who.payeeOrgId, currency: p.currency, gross: n(p.amount_cents), net: n(p.amount_cents), provider: p.provider, providerRef: p.provider_ref, paymentId: p.id, key: `charge:${p.id}` });
}
export const closeCharge = (c, paymentId, status) => setStatus(c, `charge:${paymentId}`, status);

/** The customer's payment, once the provider confirmed it. Tax and fee come from what the settlement ledger posted for the same payment. */
export async function recordPayment(c, p) {
  const who = await parties(c, p);
  const led = (await safe(c, async (k) => (await k.query("SELECT coalesce(sum(tax_cents) FILTER (WHERE kind='sale'),0)::bigint AS tax, coalesce(-sum(amount_cents) FILTER (WHERE kind='commission'),0)::bigint AS fee FROM provider_ledger WHERE payment_id=$1", [p.id])).rows[0], null)) ?? { tax: 0, fee: 0 };
  let tax = n(led.tax);
  if (!tax && p.purpose_type === 'venue_invoice') tax = n((await safe(c, async (k) => (await k.query('SELECT tax_cents FROM invoices WHERE id=$1', [p.purpose_id])).rows[0], null))?.tax_cents);
  const id = await insert(c, { kind: 'payment', module: moduleOf(p.purpose_type), sourceType: p.purpose_type, sourceId: p.purpose_id, payerId: p.payer_id, payeeId: who.payeeId, payerOrgId: who.payerOrgId,
    payeeOrgId: who.payeeOrgId, currency: p.currency, gross: n(p.amount_cents), tax, fee: n(led.fee), provider: p.provider, providerRef: p.provider_payment_ref ?? p.provider_ref, paymentId: p.id, key: `payment:${p.id}`, at: p.paid_at });
  await setStatus(c, `charge:${p.id}`, 'settled');
  return id;
}

/** Bring the canonical refunds in line with payments.refunded_cents: posts the missing difference once. Call in the same transaction that raised it. */
export async function recordRefund(c, p) {
  const refunded = n(p.refunded_cents);
  if (refunded <= 0) return null;
  const pay = (await q(c).query("SELECT * FROM fin_transactions WHERE idem_key=$1", [`payment:${p.id}`])).rows[0] ?? null;
  const done = n((await q(c).query("SELECT coalesce(sum(gross_minor),0)::bigint AS s FROM fin_transactions WHERE payment_id=$1 AND kind='refund'", [p.id])).rows[0].s);
  const delta = Math.min(refunded, n(p.amount_cents)) - done;
  if (delta <= 0) return null;
  const share = (v) => (pay && n(pay.gross_minor) ? Math.round((n(v) * delta) / n(pay.gross_minor)) : 0);
  const who = pay ?? { ...(await parties(c, p)), payee_id: null };
  return insert(c, { kind: 'refund', module: moduleOf(p.purpose_type), sourceType: p.purpose_type, sourceId: p.purpose_id, payerId: p.payer_id, payeeId: pay?.payee_id ?? who.payeeId ?? null,
    payerOrgId: pay?.payer_org_id ?? who.payerOrgId ?? null, payeeOrgId: pay?.payee_org_id ?? who.payeeOrgId ?? null, currency: p.currency, gross: delta, tax: share(pay?.tax_minor), fee: share(pay?.fee_minor),
    provider: p.provider, providerRef: p.provider_payment_ref, paymentId: p.id, parentId: pay?.id ?? null, key: `refund:${p.id}:${Math.min(refunded, n(p.amount_cents))}` });
}

/** A customer dispute: held ('disputed') when the provider reports it, 'settled' when lost, 'cancelled' when won. */
export async function recordChargeback(c, p, { key, amount, status }) {
  const exists = await setStatus(c, `chargeback:${key}`, status);
  if (exists) return null;
  const pay = (await q(c).query('SELECT * FROM fin_transactions WHERE idem_key=$1', [`payment:${p.id}`])).rows[0] ?? null;
  return insert(c, { kind: 'chargeback', status, module: moduleOf(p.purpose_type), sourceType: p.purpose_type, sourceId: p.purpose_id, payerId: p.payer_id, payeeId: pay?.payee_id ?? null,
    payerOrgId: pay?.payer_org_id ?? null, payeeOrgId: pay?.payee_org_id ?? null, currency: p.currency, gross: n(amount), provider: p.provider, providerRef: p.provider_payment_ref, paymentId: p.id, parentId: pay?.id ?? null, key: `chargeback:${key}` });
}

/** A dispute exception was resolved: lost ('reverse') -> the chargeback is final; won ('release') -> it is cancelled. */
export async function resolveDispute(c, exception, outcome) {
  const key = `${exception.detail?.provider}:${exception.detail?.dispute_id}`;
  const p = (await q(c).query('SELECT * FROM payments WHERE id=$1', [exception.payment_id])).rows[0];
  if (!p) return null;
  return recordChargeback(c, p, { key, amount: n(exception.amount_cents), status: outcome === 'reverse' ? 'settled' : 'cancelled' });
}

/** A payout to a seller: open while processing, settled when the transfer is recorded, failed (and reversed) when it bounces. */
export async function recordPayout(c, po, status = 'open') {
  const id = await insert(c, { kind: 'payout', status, module: 'payouts', sourceType: 'provider_payout', sourceId: po.id, payeeId: po.seller_id, currency: po.currency, gross: n(po.amount_cents), net: n(po.amount_cents), provider: 'manual_transfer',
    providerRef: po.reference ?? null, payoutId: po.id, key: `payout:${po.id}` });
  if (!id) await setStatus(c, `payout:${po.id}`, status);
  return id;
}

// ------------------------------------------------------------------------------------------------ reconciliation

/**
 * Catch the canonical ledger up with the payments table (payments made before the control plane existed, or whose posting failed), bring
 * refunds in line, and open an item for anything that still does not add up. Idempotent and safe next to live traffic: every posting is
 * keyed, and each payment is handled under its own row lock.
 */
export async function reconcileFinance({ limit = 500 } = {}) {
  const missing = await many(
    `SELECT p.id FROM payments p WHERE p.status IN ('paid','refunded') AND p.paid_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key = 'payment:' || p.id) ORDER BY p.paid_at, p.id LIMIT $1`, [limit + 1]);
  let backfilled = 0;
  for (const m of missing.slice(0, limit)) {
    await tx(async (c) => {
      const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [m.id])).rows[0];
      if (await recordPayment(c, p)) backfilled++;
      await recordRefund(c, p);
    });
  }
  const payouts = await many("SELECT * FROM provider_payouts po WHERE NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key = 'payout:' || po.id) ORDER BY created_at LIMIT $1", [limit]);
  let payoutsBackfilled = 0;
  for (const po of payouts) if (await tx((c) => recordPayout(c, po, po.status === 'paid' ? 'settled' : po.status === 'failed' ? 'failed' : 'open'))) payoutsBackfilled++;
  const drift = await many(
    `SELECT p.id FROM payments p JOIN fin_transactions f ON f.idem_key = 'payment:' || p.id
      WHERE least(p.refunded_cents, p.amount_cents) <> coalesce((SELECT sum(r.gross_minor) FROM fin_transactions r WHERE r.payment_id = p.id AND r.kind = 'refund'), 0)
         OR f.gross_minor <> p.amount_cents OR f.currency <> p.currency ORDER BY p.id LIMIT $1`, [limit]);
  let repaired = 0, open = 0;
  for (const d of drift) {
    const state = await tx(async (c) => {
      const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [d.id])).rows[0];
      await recordRefund(c, p);
      const f = (await c.query("SELECT gross_minor, currency FROM fin_transactions WHERE idem_key=$1", [`payment:${p.id}`])).rows[0];
      const sum = n((await c.query("SELECT coalesce(sum(gross_minor),0)::bigint AS s FROM fin_transactions WHERE payment_id=$1 AND kind='refund'", [p.id])).rows[0].s);
      const refundOk = sum === Math.min(n(p.refunded_cents), n(p.amount_cents));
      const amountOk = n(f.gross_minor) === n(p.amount_cents) && f.currency === p.currency;
      if (refundOk && amountOk) return 'ok';
      await c.query(
        `INSERT INTO fin_recon_items(kind, dedupe_key, payment_id, currency, amount_minor, detail) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) WHERE status='open' DO NOTHING`,
        [amountOk ? 'refund_drift' : 'amount_drift', `${amountOk ? 'refund_drift' : 'amount_drift'}:${p.id}`, p.id, p.currency, n(p.amount_cents) - n(f.gross_minor),
          JSON.stringify({ payment_amount_minor: n(p.amount_cents), canonical_amount_minor: n(f.gross_minor), payment_refunded_minor: n(p.refunded_cents), canonical_refunded_minor: sum })]);
      return 'open';
    });
    if (state === 'ok') repaired++; else open++;
  }
  // items that are consistent again close themselves
  const closed = (await pool.query(
    `UPDATE fin_recon_items i SET status='resolved', resolution='Consistent again after reconciliation', resolved_at=now()
      WHERE i.status='open' AND i.payment_id IS NOT NULL AND EXISTS (SELECT 1 FROM payments p JOIN fin_transactions f ON f.idem_key='payment:'||p.id WHERE p.id=i.payment_id
        AND f.gross_minor = p.amount_cents AND f.currency = p.currency
        AND least(p.refunded_cents, p.amount_cents) = coalesce((SELECT sum(r.gross_minor) FROM fin_transactions r WHERE r.payment_id=p.id AND r.kind='refund'),0))`)).rowCount;
  return { backfilled, payouts_backfilled: payoutsBackfilled, refunds_repaired: repaired, open_items: open, closed_items: closed, more: missing.length > limit };
}

// ------------------------------------------------------------------------------------------------ read models

/** Who is looking: one organisation's books, or (platform admin) every entity's. */
const scopeSql = (scope, params) => {
  if (scope.orgId) { params.push(scope.orgId); return `(f.payee_org_id = $${params.length} OR f.payer_org_id = $${params.length})`; }
  return 'TRUE';
};
const side = (scope, params) => {   // 'in' = money to the organisation, 'out' = money it pays; platform view counts customer money as 'in'
  if (!scope.orgId) return { inn: 'TRUE', out: 'FALSE' };
  params.push(scope.orgId);
  const i = params.length;
  return { inn: `f.payee_org_id = $${i}`, out: `(f.payer_org_id = $${i} AND f.payee_org_id IS DISTINCT FROM $${i})` };
};

export async function summary(scope, { from, to, currency, module } = {}) {
  const params = [from ?? '1970-01-01', to ? `${to}T23:59:59.999Z` : '9999-12-31'];
  const sd = side(scope, params);
  let extra = '';
  if (currency) { params.push(currency); extra += ` AND f.currency = $${params.length}`; }
  if (module) { params.push(module); extra += ` AND f.source_module = $${params.length}`; }
  const sum = (kind, status, cond, col) => `coalesce(sum(f.${col}) FILTER (WHERE f.kind='${kind}' AND f.status IN (${status}) AND ${cond}),0)::bigint`;
  const rows = await many(
    `SELECT f.currency,
        ${sum('payment', "'settled'", sd.inn, 'gross_minor')} AS gross, ${sum('payment', "'settled'", sd.inn, 'tax_minor')} AS tax, ${sum('payment', "'settled'", sd.inn, 'fee_minor')} AS fee,
        ${sum('payment', "'settled'", sd.inn, 'net_minor')} AS paid_net, ${sum('refund', "'settled'", sd.inn, 'gross_minor')} AS refunds, ${sum('refund', "'settled'", sd.inn, 'net_minor')} AS refunds_net,
        ${sum('chargeback', "'settled'", sd.inn, 'net_minor')} AS chargebacks_net, ${sum('chargeback', "'disputed'", sd.inn, 'gross_minor')} AS disputed,
        ${sum('charge', "'open'", sd.inn, 'gross_minor')} AS receivable, ${sum('charge', "'open'", sd.out, 'gross_minor')} AS payable,
        ${sum('payment', "'settled'", sd.out, 'gross_minor')} AS spend,
        count(*) FILTER (WHERE f.kind='payment' AND f.status='settled' AND ${sd.inn})::int AS payments
       FROM fin_transactions f WHERE f.occurred_at >= $1 AND f.occurred_at <= $2 AND ${scope.orgId ? `(${sd.inn} OR ${sd.out})` : 'TRUE'}${extra} GROUP BY f.currency ORDER BY f.currency`, params);
  const byParams = [...params];
  const by = await many(
    `SELECT f.currency, f.source_module AS module,
        ${sum('payment', "'settled'", sd.inn, 'gross_minor')} AS gross, ${sum('refund', "'settled'", sd.inn, 'gross_minor')} AS refunds,
        (${sum('payment', "'settled'", sd.inn, 'net_minor')} - ${sum('refund', "'settled'", sd.inn, 'net_minor')} - ${sum('chargeback', "'settled'", sd.inn, 'net_minor')})::bigint AS net,
        ${sum('payment', "'settled'", sd.out, 'gross_minor')} AS spend, ${sum('charge', "'open'", sd.inn, 'gross_minor')} AS receivable
       FROM fin_transactions f WHERE f.occurred_at >= $1 AND f.occurred_at <= $2 AND ${scope.orgId ? `(${sd.inn} OR ${sd.out})` : 'TRUE'}${extra}
      GROUP BY f.currency, f.source_module ORDER BY f.currency, f.source_module`, byParams);
  const review = await needsReview(scope);
  return {
    currencies: rows.map((r) => ({
      currency: r.currency, gross: n(r.gross), tax: n(r.tax), fee: n(r.fee), refunds: n(r.refunds), chargebacks: n(r.chargebacks_net), disputed: n(r.disputed),
      net: n(r.paid_net) - n(r.refunds_net) - n(r.chargebacks_net), receivable: n(r.receivable), payable: n(r.payable), spend: n(r.spend), payments: r.payments,
      by_module: by.filter((b) => b.currency === r.currency).map((b) => ({ module: b.module, label: MODULE_LABEL[b.module] ?? b.module, gross: n(b.gross), refunds: n(b.refunds), net: n(b.net), spend: n(b.spend), receivable: n(b.receivable) })),
    })),
    needs_review: review,
  };
}

/** Open canonical items plus open provider-settlement exceptions about payments inside this scope: one queue. */
async function needsReview(scope) {
  const params = [];
  const sc = scope.orgId ? `AND EXISTS (SELECT 1 FROM fin_transactions f WHERE f.payment_id = x.payment_id AND (f.payee_org_id = $1 OR f.payer_org_id = $1))` : '';
  if (scope.orgId) params.push(scope.orgId);
  const a = await one(`SELECT count(*)::int AS n FROM fin_recon_items x WHERE x.status='open' ${sc}`, params);
  const b = await one(`SELECT count(*)::int AS n FROM settlement_exceptions x WHERE x.status='open' AND x.payment_id IS NOT NULL ${sc}`, params);
  const orphan = scope.orgId ? 0 : n((await one("SELECT count(*)::int AS n FROM settlement_exceptions WHERE status='open' AND payment_id IS NULL")).n);
  return n(a.n) + n(b.n) + orphan;
}

export async function listTransactions(scope, { from, to, module, kind, status, currency, direction, limit = 25, offset = 0 } = {}) {
  const params = [];
  const where = [scopeSql(scope, params)];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (from) add('f.occurred_at >= ?', from);
  if (to) add('f.occurred_at <= ?', `${to}T23:59:59.999Z`);
  if (module) add('f.source_module = ?', module);
  if (kind) add('f.kind = ?', kind);
  if (status) add('f.status = ?', status);
  if (currency) add('f.currency = ?', currency);
  if (direction && scope.orgId) add(direction === 'in' ? 'f.payee_org_id = ?' : '(f.payer_org_id = ? AND f.payee_org_id IS DISTINCT FROM f.payer_org_id)', scope.orgId);
  params.push(limit, offset);
  const rows = await many(
    `SELECT f.id, f.kind, f.status, f.source_module, f.source_type, f.source_id, f.currency, f.gross_minor, f.tax_minor, f.fee_minor, f.discount_minor, f.net_minor, f.provider, f.provider_ref,
            f.payment_id, f.parent_id, f.occurred_at, f.payer_id, f.payee_id, f.payer_org_id, f.payee_org_id, pu.display_name AS payer, eu.display_name AS payee
       FROM fin_transactions f LEFT JOIN users pu ON pu.id = f.payer_id LEFT JOIN users eu ON eu.id = f.payee_id
      WHERE ${where.join(' AND ')} ORDER BY f.occurred_at DESC, f.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map((r) => view(r, scope));
}

const view = (r, scope) => ({
  id: r.id, kind: r.kind, status: r.status, module: r.source_module, module_label: MODULE_LABEL[r.source_module] ?? r.source_module, source_type: r.source_type, source_id: r.source_id,
  currency: r.currency, gross_minor: n(r.gross_minor), tax_minor: n(r.tax_minor), fee_minor: n(r.fee_minor), discount_minor: n(r.discount_minor), net_minor: n(r.net_minor),
  provider: r.provider, provider_ref: r.provider_ref, payment_id: r.payment_id, parent_id: r.parent_id, occurred_at: r.occurred_at, payer: r.payer ?? null, payee: r.payee ?? null,
  direction: scope.orgId ? (r.payee_org_id === scope.orgId ? 'in' : 'out') : 'in',
});

/** One transaction in scope with its trace from source workflow to settlement and reconciliation, and its audit history. null when out of scope. */
export async function getTransaction(scope, txId) {
  const params = [txId];
  const sc = scope.orgId ? (params.push(scope.orgId), 'AND (f.payee_org_id = $2 OR f.payer_org_id = $2)') : '';
  const f = await one(
    `SELECT f.*, pu.display_name AS payer, eu.display_name AS payee FROM fin_transactions f LEFT JOIN users pu ON pu.id=f.payer_id LEFT JOIN users eu ON eu.id=f.payee_id WHERE f.id=$1 ${sc}`, params);
  if (!f) return null;
  const steps = [];
  steps.push({ key: 'source', label: 'Source workflow', status: 'done', module: f.source_module, source_type: f.source_type, source_id: f.source_id, at: null });
  const payId = f.payment_id;
  const pay = payId ? await one('SELECT id, provider, status, amount_cents, refunded_cents, provider_ref, provider_payment_ref, paid_at, created_at FROM payments WHERE id=$1', [payId]) : null;
  const charge = payId ? await one("SELECT id, status, occurred_at FROM fin_transactions WHERE idem_key=$1", [`charge:${payId}`]) : null;
  if (charge) steps.push({ key: 'charge', label: 'Charge raised', status: charge.status === 'settled' ? 'done' : charge.status === 'open' ? 'pending' : 'attention', at: charge.occurred_at });
  const inv = f.source_type === 'venue_invoice' ? await one('SELECT number, status FROM invoices WHERE id=$1', [f.source_id]) : null;
  if (inv) steps.push({ key: 'invoice', label: `Invoice ${inv.number}`, status: inv.status === 'paid' ? 'done' : 'pending', at: null, ref: inv.number });
  if (pay) steps.push({ key: 'payment', label: 'Payment', status: pay.status === 'paid' || pay.status === 'refunded' ? 'done' : pay.status === 'pending' ? 'pending' : 'attention', at: pay.paid_at ?? pay.created_at, ref: pay.provider_payment_ref ?? pay.provider_ref, provider: pay.provider });
  const lines = payId ? await many("SELECT kind, amount_cents, gross_cents, available_at FROM provider_ledger WHERE payment_id=$1 ORDER BY id", [payId]) : [];
  if (lines.length) {
    const sale = lines.find((l) => l.kind === 'sale');
    steps.push({ key: 'allocation', label: 'Allocated to the seller (sale, fee, tax)', status: 'done', at: null, detail: { lines: lines.length } });
    steps.push({ key: 'settlement', label: 'Available for payout', status: sale?.available_at && new Date(sale.available_at) > new Date() ? 'pending' : 'done', at: sale?.available_at ?? null });
  }
  const rel = payId ? await many("SELECT id, kind, status, gross_minor, currency, occurred_at FROM fin_transactions WHERE payment_id=$1 AND kind IN ('refund','chargeback') ORDER BY occurred_at, id", [payId]) : [];
  for (const r of rel) steps.push({ key: r.kind, label: r.kind === 'refund' ? 'Refund' : 'Chargeback', status: r.status === 'settled' ? 'done' : r.status === 'disputed' ? 'attention' : 'pending', at: r.occurred_at, tx_id: r.id, gross_minor: n(r.gross_minor), currency: r.currency });
  const items = payId ? await many("SELECT kind, status FROM fin_recon_items WHERE payment_id=$1 UNION ALL SELECT kind, status FROM settlement_exceptions WHERE payment_id=$1", [payId]) : [];
  const openItems = items.filter((i) => i.status === 'open');
  steps.push({ key: 'reconciliation', label: 'Reconciled with the provider record', status: openItems.length ? 'attention' : pay && (pay.status === 'paid' || pay.status === 'refunded') ? 'done' : 'pending', at: null, detail: { open: openItems.map((i) => i.kind) } });
  const events = await many('SELECT e.action, e.data, e.created_at, u.display_name AS actor FROM fin_tx_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.tx_id=$1 ORDER BY e.id DESC', [f.id]);
  return { ...view(f, scope), steps, history: events };
}

/** Open reconciliation items (canonical drift and provider-settlement exceptions) for a scope, newest first. */
export async function listReconciliation(scope, { status = 'open', limit = 25, offset = 0 } = {}) {
  const params = [status];
  let sc = '';
  if (scope.orgId) { params.push(scope.orgId); sc = `AND x.payment_id IS NOT NULL AND EXISTS (SELECT 1 FROM fin_transactions f WHERE f.payment_id = x.payment_id AND (f.payee_org_id = $2 OR f.payer_org_id = $2))`; }
  params.push(limit, offset);
  return many(
    `SELECT * FROM (
       SELECT x.id, 'canonical'::text AS source, x.kind, x.status, x.payment_id, x.currency, x.amount_minor AS amount_minor, x.detail, x.resolution, x.created_at FROM fin_recon_items x WHERE x.status = $1 ${sc}
       UNION ALL
       SELECT x.id, 'settlement'::text, x.kind, x.status, x.payment_id, x.currency, x.amount_cents, x.detail, x.resolution, x.created_at FROM settlement_exceptions x WHERE x.status = $1 ${sc}
     ) u ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
}
