// One executable payout path (#701). Officials fees, venue settlements and coach/provider balances are paid as items in a batch:
// eligibility -> maker-checker -> bank file or Stripe transfer -> recorded result -> source updated + canonical ledger posted.
// Money rules live here; src/capabilities/payouts.js is the API. Nothing here deletes data: every correction is a new state + an event.
import { many, one, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { audit } from './helpers.js';
import { decrypt, encrypt } from './crypto.js';
import { notify } from './notify.js';
import { config } from './config.js';
import { recordPayout, recordPayoutItem } from './finance.js';
import { balances, explainFailure, payoutBlockers, postPayout, postPayoutReversal, raiseException } from './settlement.js';
import { stripe, stripeEnabled } from './payments/providers.js';

export const SOURCES = ['official_fee', 'venue_settlement', 'provider_balance'];
const ev = (c, batchId, itemId, actor, action, detail = {}) => c.query('INSERT INTO payout_events(batch_id, item_id, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5)', [batchId, itemId, actor, action, JSON.stringify(detail)]);

export async function settingsFor(currency, c) {
  const r = c ? (await c.query('SELECT * FROM payout_settings WHERE currency=$1', [currency])).rows[0] : await one('SELECT * FROM payout_settings WHERE currency=$1', [currency]);
  return { withholding_bp: Number(r?.withholding_bp ?? 0), fee_bp: Number(r?.fee_bp ?? 0), fee_flat_minor: Number(r?.fee_flat_minor ?? 0), approval_threshold_minor: r?.approval_threshold_minor == null ? null : Number(r.approval_threshold_minor) };
}

/** Withholding applies to fees and settlements that the platform pays on someone's behalf; a seller balance was already netted by the ledger. */
export function amounts(source, gross, s) {
  const tax = source === 'provider_balance' ? 0 : Math.round((gross * s.withholding_bp) / 10000);
  const fee = Math.min(gross - tax - 1 < 0 ? 0 : gross - tax - 1, Math.round((gross * s.fee_bp) / 10000) + s.fee_flat_minor);
  return { gross, tax, fee, net: gross - tax - fee };
}

const liveAccount = async (c, owner, currency) => (await c.query("SELECT id, status, last4 FROM payout_accounts WHERE owner_id=$1 AND currency=$2 AND status='verified'", [owner, currency])).rows[0];

// ------------------------------------------------------------------ what can be paid
export async function listObligations({ currency, source, limit = 50, offset = 0 }) {
  const out = [];
  const take = (r, s) => out.push(...r.map((x) => ({ ...x, source_type: s })));
  if (!source || source === 'official_fee') {
    take(await many(
      `SELECT fo.id AS source_id, fo.user_id AS payee_id, u.display_name AS payee, fo.fee_currency AS currency, fo.fee_minor::bigint AS gross_minor, e.name AS label, fo.pay_updated_at AS since,
              a.id AS account_id, a.status AS account_status
         FROM fixture_officials fo JOIN users u ON u.id=fo.user_id JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id
         LEFT JOIN payout_accounts a ON a.owner_id=fo.user_id AND a.currency=fo.fee_currency AND a.status IN ('pending','verified')
        WHERE fo.pay_status='due' AND fo.status='accepted' AND fo.fee_minor > 0 AND ($1::text IS NULL OR fo.fee_currency=$1)
          AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.source_type='official_fee' AND i.source_id=fo.id AND i.status IN ('pending','paid'))
        ORDER BY fo.pay_updated_at, fo.id LIMIT $2 OFFSET $3`, [currency ?? null, limit, offset]), 'official_fee');
  }
  if (!source || source === 'venue_settlement') {
    take(await many(
      `SELECT s.id AS source_id, p.owner_id AS payee_id, u.display_name AS payee, s.currency, s.net_payable_cents::bigint AS gross_minor, ('Settlement ' || s.settlement_no) AS label, s.approved_at AS since,
              a.id AS account_id, a.status AS account_status
         FROM settlements s JOIN partners p ON p.id=s.partner_id JOIN users u ON u.id=p.owner_id
         LEFT JOIN payout_accounts a ON a.owner_id=p.owner_id AND a.currency=s.currency AND a.status IN ('pending','verified')
        WHERE s.status='approved' AND s.net_payable_cents > 0 AND ($1::text IS NULL OR s.currency=$1)
          AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.source_type='venue_settlement' AND i.source_id=s.id AND i.status IN ('pending','paid'))
        ORDER BY s.approved_at, s.id LIMIT $2 OFFSET $3`, [currency ?? null, limit, offset]), 'venue_settlement');
  }
  if (!source || source === 'provider_balance') {
    take(await many(
      `WITH bal AS (SELECT l.seller_id, l.currency, sum(l.amount_cents) FILTER (WHERE l.available_at IS NULL OR l.available_at <= now())::bigint AS vested FROM provider_ledger l GROUP BY l.seller_id, l.currency)
       SELECT NULL::uuid AS source_id, b.seller_id AS payee_id, u.display_name AS payee, b.currency,
              greatest(0, b.vested - coalesce((SELECT sum(h.amount_cents) FROM settlement_holds h WHERE h.seller_id=b.seller_id AND h.currency=b.currency AND h.released_at IS NULL),0))::bigint AS gross_minor,
              'Available earnings' AS label, NULL::timestamptz AS since, a.id AS account_id, a.status AS account_status
         FROM bal b JOIN users u ON u.id=b.seller_id LEFT JOIN payout_accounts a ON a.owner_id=b.seller_id AND a.currency=b.currency AND a.status IN ('pending','verified')
        WHERE ($1::text IS NULL OR b.currency=$1)
          AND b.vested - coalesce((SELECT sum(h.amount_cents) FROM settlement_holds h WHERE h.seller_id=b.seller_id AND h.currency=b.currency AND h.released_at IS NULL),0) >= $4
          AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.source_type='provider_balance' AND i.payee_id=b.seller_id AND i.currency=b.currency AND i.status='pending')
        ORDER BY gross_minor DESC, b.seller_id LIMIT $2 OFFSET $3`, [currency ?? null, limit, offset, config.settlement.minPayoutCents]), 'provider_balance');
  }
  return out.map((o) => ({ ...o, gross_minor: Number(o.gross_minor), blocker: !o.account_id ? 'no_account' : o.account_status !== 'verified' ? 'account_pending' : null }));
}

// ------------------------------------------------------------------ create
/** Lock + validate one source inside the batch transaction; returns { payee, gross, ref } or throws a conflict the operator can act on. */
async function resolveSource(c, currency, it, user) {
  if (it.source_type === 'official_fee') {
    const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1 FOR UPDATE', [it.source_id])).rows[0];
    if (!fo) throw notFound('Official assignment');
    if (fo.pay_status !== 'due' || fo.status !== 'accepted') throw conflict('That fee is not due: the organiser must mark an accepted official\'s fee as due first');
    if (fo.fee_currency !== currency) throw badRequest('That fee is in a different currency than the batch');
    return { payee: fo.user_id, gross: Number(fo.fee_minor), sourceId: fo.id };
  }
  if (it.source_type === 'venue_settlement') {
    const s = (await c.query('SELECT s.*, p.owner_id FROM settlements s JOIN partners p ON p.id=s.partner_id WHERE s.id=$1 FOR UPDATE OF s', [it.source_id])).rows[0];
    if (!s) throw notFound('Settlement');
    if (s.status !== 'approved' || Number(s.net_payable_cents) <= 0) throw conflict('Only an approved settlement with an amount payable to the partner can be paid');
    if (s.currency !== currency) throw badRequest('That settlement is in a different currency than the batch');
    return { payee: s.owner_id, gross: Number(s.net_payable_cents), sourceId: s.id };
  }
  if (!it.payee_id) throw badRequest('Choose the seller to pay');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout:${it.payee_id}:${currency}`]);
  const bal = (await balances(it.payee_id, { c })).find((b) => b.currency === currency);
  if (!bal || !bal.reconciles) throw conflict('That seller\'s balance does not reconcile: resolve the exception first');
  const blockers = (await payoutBlockers(it.payee_id, currency, bal)).filter((b) => b.code !== 'held');
  if (blockers.length) throw conflict(blockers.map((b) => b.message).join(' '));
  if ((await c.query("SELECT 1 FROM provider_payouts WHERE seller_id=$1 AND currency=$2 AND status='processing'", [it.payee_id, currency])).rowCount) throw conflict('A payout to this seller is already in progress');
  return { payee: it.payee_id, gross: bal.available_cents, sourceId: null };
}

export async function createBatch(user, { currency, rail, client_key, items }) {
  if (rail === 'stripe' && !stripeEnabled()) throw badRequest('Stripe transfers are not switched on: choose the bank file');
  if (!config.settlement.payoutsEnabled) throw conflict('Payouts have not been switched on (SETTLEMENT_PAYOUTS)');
  return tx(async (c) => {
    const prior = (await c.query('SELECT * FROM payout_batches WHERE client_key=$1', [client_key])).rows[0];
    if (prior) return { ...(await batchView(prior.id, c)), replayed: true };
    const s = await settingsFor(currency, c);
    const b = (await c.query('INSERT INTO payout_batches(currency, rail, client_key, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [currency, rail, client_key, user.id])).rows[0];
    const seen = new Set();
    let g = 0, t = 0, f = 0, n = 0;
    for (const it of items) {
      const dupKey = `${it.source_type}:${it.source_id ?? it.payee_id}`;
      if (seen.has(dupKey)) throw badRequest('The same payment is listed twice');
      seen.add(dupKey);
      const src = await resolveSource(c, currency, it, user);
      if (src.payee === user.id) throw conflict('Another platform team member must pay your own earnings');
      const acc = await liveAccount(c, src.payee, currency);
      if (!acc) throw conflict('A payee has no verified payout account in this currency');
      const a = amounts(it.source_type, src.gross, s);
      if (a.net <= 0) throw conflict('The fees and withholding leave nothing to pay for one item');
      const row = (await c.query(
        `INSERT INTO payout_items(batch_id, source_type, source_id, payee_id, account_id, currency, gross_minor, tax_minor, fee_minor, net_minor, idem_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, gen_random_uuid()::text) RETURNING *`,
        [b.id, it.source_type, src.sourceId, src.payee, acc.id, currency, a.gross, a.tax, a.fee, a.net])).rows[0];
      await c.query('UPDATE payout_items SET idem_key=$2 WHERE id=$1', [row.id, `item:${row.id}:1`]);
      row.idem_key = `item:${row.id}:1`;
      if (it.source_type === 'provider_balance') await openProviderPayout(c, row, user);
      else await recordPayoutItem(c, row, 'open', rail);
      await ev(c, b.id, row.id, user.id, 'item_added', { source_type: it.source_type, gross_minor: a.gross });
      g += a.gross; t += a.tax; f += a.fee; n += a.net;
    }
    await c.query('UPDATE payout_batches SET gross_minor=$2, tax_minor=$3, fee_minor=$4, net_minor=$5 WHERE id=$1', [b.id, g, t, f, n]);
    await ev(c, b.id, null, user.id, 'created', { items: items.length, net_minor: n });
    await audit(c, user.id, 'create_payout_batch', 'payout_batches', b.id);
    return batchView(b.id, c);
  });
}

/** A seller balance leaves the ledger the moment the item exists (as a payout in progress), exactly like the older single payout. */
async function openProviderPayout(c, item, user) {
  const p = (await c.query('INSERT INTO provider_payouts(seller_id, currency, amount_cents, account_id, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [item.payee_id, item.currency, item.gross_minor, item.account_id, item.idem_key, user.id])).rows[0];
  await postPayout(c, { sellerId: p.seller_id, currency: p.currency, payoutId: p.id, amount: Number(p.amount_cents) });
  await recordPayout(c, p, 'open');
  await c.query('UPDATE payout_items SET provider_payout_id=$2 WHERE id=$1', [item.id, p.id]);
  item.provider_payout_id = p.id;
}

// ------------------------------------------------------------------ read
const itemView = ({ idem_key, ...i }) => ({ ...i, ...(i.status === 'failed' ? { explanation: explainFailure(i.failure_code) } : {}) });
export async function batchView(id, c) {
  const run = c ? (sql, a) => c.query(sql, a).then((r) => r.rows) : many;
  const b = (await run('SELECT * FROM payout_batches WHERE id=$1', [id]))[0];
  if (!b) throw notFound('Payout batch');
  const items = await run(
    `SELECT i.*, u.display_name AS payee, a.last4 FROM payout_items i JOIN users u ON u.id=i.payee_id JOIN payout_accounts a ON a.id=i.account_id WHERE i.batch_id=$1 ORDER BY i.created_at, i.id`, [id]);
  const events = await run('SELECT e.action, e.detail, e.at, u.display_name AS actor FROM payout_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.batch_id=$1 ORDER BY e.id', [id]);
  return { ...b, items: items.map(itemView), events };
}

// ------------------------------------------------------------------ approve (maker-checker)
export async function approveBatch(user, { id, row_version }) {
  return tx(async (c) => {
    const b = (await c.query('SELECT * FROM payout_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!b) throw notFound('Payout batch');
    if (row_version != null && b.row_version !== row_version) throw conflict('This batch changed since you opened it: reload and check it again');
    if (b.status === 'approved') return { ...(await batchView(id, c)), replayed: true };
    if (b.status !== 'pending_approval') throw conflict(`A ${b.status} batch cannot be approved`);
    if ((await c.query("SELECT 1 FROM payout_items WHERE batch_id=$1 AND payee_id=$2", [id, user.id])).rowCount) throw conflict('You cannot approve a batch that pays you');
    const s = await settingsFor(b.currency, c);
    let basis = 'second_person';
    if (b.created_by === user.id) {
      if (s.approval_threshold_minor != null && Number(b.net_minor) <= s.approval_threshold_minor) basis = 'below_threshold';
      else if ((await c.query("SELECT count(*)::int AS n FROM users WHERE roles && ARRAY['admin','platform_admin']::text[]")).rows[0].n <= 1) basis = 'sole_authority';
      else throw conflict('A second platform team member must approve this batch');
    }
    await c.query("UPDATE payout_batches SET status='approved', approved_by=$2, approved_at=now(), approval_basis=$3, row_version=row_version+1 WHERE id=$1", [id, user.id, basis]);
    await ev(c, id, null, user.id, 'approved', { basis });
    await audit(c, user.id, 'approve_payout_batch', 'payout_batches', id);
    return batchView(id, c);
  });
}

// ------------------------------------------------------------------ execute
const accountDetails = (a) => JSON.parse(decrypt(a.details_enc, 'payout_accounts.details'));
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : /^[=+\-@]/.test(s) ? `'${s}` : s; };

/** The bank file: one row per pending item with the decrypted verified account. Every decrypt is audit-logged. Repeating the export is harmless. */
export async function exportBatch(user, id) {
  return tx(async (c) => {
    const b = (await c.query('SELECT * FROM payout_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!b) throw notFound('Payout batch');
    if (b.rail !== 'bank_file') throw conflict('This batch is paid by Stripe transfer, not a bank file');
    if (!['approved', 'exported'].includes(b.status)) throw conflict('Approve the batch before exporting it');
    const items = (await c.query("SELECT i.*, a.details_enc FROM payout_items i JOIN payout_accounts a ON a.id=i.account_id WHERE i.batch_id=$1 AND i.status='pending' ORDER BY i.created_at, i.id", [id])).rows;
    const head = ['payout_ref', 'payee', 'account_holder', 'account_number', 'bank_code', 'currency', 'amount', 'gross', 'tax_withheld', 'fee', 'source'];
    const rows = [];
    for (const i of items) {
      if ((await c.query('SELECT 1 FROM payout_items WHERE id=$1 AND payee_id=$2', [i.id, user.id])).rowCount) throw conflict('You cannot export a batch that pays you');
      const d = accountDetails(i);
      await audit(c, user.id, 'read_payout_account', 'payout_accounts', i.account_id);
      rows.push([i.idem_key, i.payee_id, d.holder_name, d.account_number, d.bank_code, i.currency, (i.net_minor / 100).toFixed(2), (i.gross_minor / 100).toFixed(2), (i.tax_minor / 100).toFixed(2), (i.fee_minor / 100).toFixed(2), i.source_type]);
    }
    await c.query("UPDATE payout_batches SET status='exported', row_version=row_version+1 WHERE id=$1 AND status='approved'", [id]);
    await ev(c, id, null, user.id, 'exported', { items: rows.length });
    await audit(c, user.id, 'export_payout_batch', 'payout_batches', id);
    return { filename: `payout-batch-${b.batch_no}.csv`, rows: rows.length, csv: [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') };
  });
}

/** Stripe Connect: transfer every pending item. The transfer idempotency key is the item's, so a retry never pays twice. */
export async function executeBatch(user, id) {
  const b0 = await one('SELECT * FROM payout_batches WHERE id=$1', [id]);
  if (!b0) throw notFound('Payout batch');
  if (b0.rail !== 'stripe') throw conflict('This batch is paid from a bank file: export it instead');
  if (!stripeEnabled()) throw conflict('Stripe transfers are not switched on');
  if (!['approved', 'executing'].includes(b0.status)) throw conflict('Approve the batch before executing it');
  await tx(async (c) => { await c.query("UPDATE payout_batches SET status='executing', row_version=row_version+1 WHERE id=$1 AND status='approved'", [id]); await ev(c, id, null, user.id, 'executing'); });
  const items = await many("SELECT i.*, a.details_enc FROM payout_items i JOIN payout_accounts a ON a.id=i.account_id WHERE i.batch_id=$1 AND i.status='pending' ORDER BY i.created_at, i.id", [id]);
  for (const i of items) {
    await audit(null, user.id, 'read_payout_account', 'payout_accounts', i.account_id);
    const dest = accountDetails(i).stripe_account_id;
    if (!dest) { await recordItemResult(user, { item_id: i.id, outcome: 'failed', failure_code: 'invalid_account', reason: 'The payee has not saved a Stripe connected account' }); continue; }
    try {
      const t = await stripe.transfer({ amount: Number(i.net_minor), currency: i.currency, destination: dest, key: i.idem_key, itemId: i.id });
      await recordItemResult(user, { item_id: i.id, outcome: 'paid', reference: t.ref });
    } catch (e) {
      if (e.status && e.status < 500 && e.code === 'payment_provider_error') await recordItemResult(user, { item_id: i.id, outcome: 'failed', failure_code: 'bank_rejected', reason: String(e.message).slice(0, 300) });
      // an unreachable provider leaves the item pending: executing again is safe because the transfer key is stable
    }
  }
  return batchView(id);
}

// ------------------------------------------------------------------ results
export async function recordItemResult(user, { item_id, outcome, reference, failure_code, reason }) {
  if (outcome === 'paid' && !reference) throw badRequest('Enter the transfer reference');
  if (outcome === 'failed' && (!failure_code || !reason)) throw badRequest('Give the reason code and an explanation for the payee');
  return tx(async (c) => {
    const it = (await c.query('SELECT * FROM payout_items WHERE id=$1 FOR UPDATE', [item_id])).rows[0];
    if (!it) throw notFound('Payout item');
    const b = (await c.query('SELECT * FROM payout_batches WHERE id=$1 FOR UPDATE', [it.batch_id])).rows[0];
    if (user && it.payee_id === user.id) throw conflict('Another platform team member must record the result for your own payout');
    if (it.status === outcome) {
      if (outcome === 'paid' && it.reference !== reference) throw conflict('This item was already paid with another reference');
      return { ...(await batchView(b.id, c)), replayed: true };
    }
    if (it.status !== 'pending') throw conflict(`This payout item is already ${it.status}`);
    if (!['exported', 'executing'].includes(b.status)) throw conflict('Export or execute the approved batch before recording results');
    if (outcome === 'paid') {
      if ((await c.query("SELECT 1 FROM payout_items WHERE reference=$1 AND status='paid' AND id<>$2", [reference, it.id])).rowCount) throw conflict('That transfer reference is already recorded on another payout');
      const row = (await c.query("UPDATE payout_items SET status='paid', reference=$2, decided_by=$3, decided_at=now() WHERE id=$1 RETURNING *", [it.id, reference, user?.id ?? null])).rows[0];
      await settleSource(c, row, user);
      await notify(c, it.payee_id, { kind: 'payout_paid', title: 'Your payout was sent', body: `${(it.net_minor / 100).toFixed(2)} ${it.currency} was sent to your bank account (reference ${reference}).`, data: { payout_item_id: it.id }, dedupe_key: `payout_item_paid:${it.id}:${it.attempt}` });
    } else {
      const row = (await c.query("UPDATE payout_items SET status='failed', failure_code=$2, failure_reason=$3, decided_by=$4, decided_at=now() WHERE id=$1 RETURNING *", [it.id, failure_code, reason, user?.id ?? null])).rows[0];
      await failSource(c, row, user, failure_code, reason);
      const why = explainFailure(failure_code);
      await notify(c, it.payee_id, { kind: 'payout_failed', title: 'Your payout could not be completed', body: `${why.title}. ${why.next_step}`, data: { payout_item_id: it.id }, dedupe_key: `payout_item_failed:${it.id}:${it.attempt}` });
    }
    await ev(c, b.id, it.id, user?.id ?? null, `item_${outcome}`, { reference: reference ?? null, failure_code: failure_code ?? null });
    await audit(c, user?.id ?? null, `record_payout_item_${outcome}`, 'payout_items', it.id);
    await closeIfDone(c, b.id, user);
    return batchView(b.id, c);
  });
}

async function settleSource(c, it, user) {
  if (it.source_type === 'official_fee') {
    const fo = (await c.query("UPDATE fixture_officials SET pay_status='paid', pay_updated_at=now(), pay_updated_by=$2, pay_confirmed_at=NULL, payout_item_id=$3 WHERE id=$1 RETURNING *", [it.source_id, user?.id ?? null, it.id])).rows[0];
    await c.query("INSERT INTO fixture_official_pay_log(fixture_official_id, actor_id, fee_minor, fee_currency, from_status, to_status, note, payout_item_id) VALUES ($1,$2,$3,$4,'due','paid',$5,$6)",
      [fo.id, user?.id ?? fo.user_id, fo.fee_minor, fo.fee_currency, `Paid by payout ${it.reference}`, it.id]);
    await recordPayoutItem(c, it, 'settled');
  } else if (it.source_type === 'venue_settlement') {
    const s = (await c.query("UPDATE settlements SET status='paid', payout_ref=$2, paid_at=now(), payout_item_id=$3 WHERE id=$1 RETURNING *", [it.source_id, it.reference, it.id])).rows[0];
    await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [s.partner_id, user?.id ?? null, 'settlement_mark_paid', JSON.stringify({ settlement_no: s.settlement_no, payout_ref: it.reference, payout_item_id: it.id })]);
    await recordPayoutItem(c, it, 'settled');
  } else {
    const row = (await c.query("UPDATE provider_payouts SET status='paid', reference=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='processing' RETURNING *", [it.provider_payout_id, it.reference, user?.id ?? null])).rows[0];
    if (row) await recordPayout(c, row, 'settled');
  }
}

async function failSource(c, it, user, code, reason) {
  if (it.source_type === 'provider_balance') {
    const row = (await c.query("UPDATE provider_payouts SET status='failed', failure_code=$2, failure_reason=$3, decided_by=$4, decided_at=now() WHERE id=$1 AND status='processing' RETURNING *", [it.provider_payout_id, code, reason, user?.id ?? null])).rows[0];
    if (row) { await postPayoutReversal(c, { sellerId: row.seller_id, currency: row.currency, payoutId: row.id, amount: Number(row.amount_cents) }); await recordPayout(c, row, 'failed'); }
  } else {
    await recordPayoutItem(c, it, 'failed');
  }
  await raiseException(c, { kind: 'payout_failed', dedupeKey: `payout_item_failed:${it.id}:${it.attempt}`, sellerId: it.payee_id, payoutId: it.provider_payout_id ?? null, currency: it.currency, amount: Number(it.gross_minor), detail: { payout_item_id: it.id, batch_id: it.batch_id, source_type: it.source_type, failure_code: code, reason } });
}

async function closeIfDone(c, batchId, user) {
  const open = (await c.query("SELECT count(*)::int AS n FROM payout_items WHERE batch_id=$1 AND status='pending'", [batchId])).rows[0].n;
  if (open) return;
  const r = await c.query("UPDATE payout_batches SET status='closed', closed_at=now(), row_version=row_version+1 WHERE id=$1 AND status IN ('exported','executing')", [batchId]);
  if (r.rowCount) await ev(c, batchId, null, user?.id ?? null, 'closed');
}

// ------------------------------------------------------------------ retry / cancel
/** A failed item is tried again as a new attempt with a new key (the failed one stays in history). The batch goes back to approved to be exported or executed again. */
export async function retryItem(user, { item_id }) {
  return tx(async (c) => {
    const it = (await c.query('SELECT * FROM payout_items WHERE id=$1 FOR UPDATE', [item_id])).rows[0];
    if (!it) throw notFound('Payout item');
    const b = (await c.query('SELECT * FROM payout_batches WHERE id=$1 FOR UPDATE', [it.batch_id])).rows[0];
    if (it.status === 'pending') return { ...(await batchView(b.id, c)), replayed: true };
    if (it.status !== 'failed') throw conflict(`A ${it.status} item cannot be retried`);
    if (it.payee_id === user.id) throw conflict('Another platform team member must retry your own payout');
    if (b.status === 'cancelled') throw conflict('This batch was cancelled');
    const src = await resolveSource(c, it.currency, { source_type: it.source_type, source_id: it.source_id, payee_id: it.payee_id }, user);
    const acc = await liveAccount(c, it.payee_id, it.currency);
    if (!acc) throw conflict('The payee has no verified payout account in this currency');
    const s = await settingsFor(it.currency, c);
    const a = amounts(it.source_type, src.gross, s);
    const attempt = it.attempt + 1;
    const row = (await c.query("UPDATE payout_items SET status='pending', attempt=$2, idem_key=$3, account_id=$4, gross_minor=$5, tax_minor=$6, fee_minor=$7, net_minor=$8, failure_code=NULL, failure_reason=NULL, reference=NULL, decided_by=NULL, decided_at=NULL WHERE id=$1 RETURNING *",
      [it.id, attempt, `item:${it.id}:${attempt}`, acc.id, a.gross, a.tax, a.fee, a.net])).rows[0];
    if (it.source_type === 'provider_balance') {
      const p = (await c.query('INSERT INTO provider_payouts(seller_id, currency, amount_cents, account_id, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [it.payee_id, it.currency, a.gross, acc.id, row.idem_key, user.id])).rows[0];
      await postPayout(c, { sellerId: p.seller_id, currency: p.currency, payoutId: p.id, amount: Number(p.amount_cents) });
      await recordPayout(c, p, 'open');
      await c.query('UPDATE payout_items SET provider_payout_id=$2 WHERE id=$1', [it.id, p.id]);
    } else await recordPayoutItem(c, row, 'open', b.rail);
    await c.query("UPDATE payout_batches SET status='approved', closed_at=NULL, row_version=row_version+1 WHERE id=$1 AND status IN ('exported','executing','closed')", [b.id]);
    await ev(c, b.id, it.id, user.id, 'item_retried', { attempt });
    await audit(c, user.id, 'retry_payout_item', 'payout_items', it.id);
    return batchView(b.id, c);
  });
}

export async function cancelBatch(user, { id, reason }) {
  return tx(async (c) => {
    const b = (await c.query('SELECT * FROM payout_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!b) throw notFound('Payout batch');
    if (b.status === 'cancelled') return { ...(await batchView(id, c)), replayed: true };
    if (!['pending_approval', 'approved'].includes(b.status)) throw conflict(`A ${b.status} batch can no longer be cancelled: record each item\'s result instead`);
    const items = (await c.query("SELECT * FROM payout_items WHERE batch_id=$1 AND status='pending' FOR UPDATE", [id])).rows;
    for (const it of items) {
      await c.query("UPDATE payout_items SET status='cancelled', decided_by=$2, decided_at=now() WHERE id=$1", [it.id, user.id]);
      if (it.source_type === 'provider_balance') {
        const row = (await c.query("UPDATE provider_payouts SET status='failed', failure_code='other', failure_reason=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='processing' RETURNING *", [it.provider_payout_id, `Batch cancelled: ${reason}`, user.id])).rows[0];
        if (row) { await postPayoutReversal(c, { sellerId: row.seller_id, currency: row.currency, payoutId: row.id, amount: Number(row.amount_cents) }); await recordPayout(c, row, 'cancelled'); }
      } else await recordPayoutItem(c, it, 'cancelled');
    }
    await c.query("UPDATE payout_batches SET status='cancelled', closed_at=now(), row_version=row_version+1 WHERE id=$1", [id]);
    await ev(c, id, null, user.id, 'cancelled', { reason });
    await audit(c, user.id, 'cancel_payout_batch', 'payout_batches', id);
    return batchView(id, c);
  });
}

// ------------------------------------------------------------------ reconciliation
/** Payout items against the ledgers: a paid item must have its source settled and its canonical posting; an open item must not exceed what the source says. Findings go to the existing exceptions queue. */
export async function reconcilePayouts() {
  const found = [];
  const flag = async (kind, key, it, detail) => {
    found.push({ kind, ...detail });
    await raiseException(null, { kind: 'ledger_drift', dedupeKey: `payout_${kind}:${key}`, sellerId: it.payee_id, currency: it.currency, amount: Number(it.gross_minor), detail: { payout_item_id: it.id, check: kind, ...detail } });
  };
  const paid = await many("SELECT * FROM payout_items WHERE status='paid' ORDER BY created_at LIMIT 1000");
  for (const it of paid) {
    if (it.source_type === 'official_fee') {
      const fo = await one('SELECT pay_status, payout_item_id FROM fixture_officials WHERE id=$1', [it.source_id]);
      if (fo?.pay_status !== 'paid' || fo.payout_item_id !== it.id) await flag('source_unsettled', it.id, it, { source: 'official_fee' });
    } else if (it.source_type === 'venue_settlement') {
      const s = await one('SELECT status, payout_item_id FROM settlements WHERE id=$1', [it.source_id]);
      if (s?.status !== 'paid' || s.payout_item_id !== it.id) await flag('source_unsettled', it.id, it, { source: 'venue_settlement' });
    }
    const key = it.source_type === 'provider_balance' ? `payout:${it.provider_payout_id}` : `payout_item:${it.id}:${it.attempt}`;
    const tx1 = await one("SELECT status, gross_minor FROM fin_transactions WHERE idem_key=$1", [key]);
    if (!tx1 || tx1.status !== 'settled' || Number(tx1.gross_minor) !== Number(it.gross_minor)) await flag('ledger_unposted', it.id, it, { expected_key: key });
    if (Number(it.gross_minor) - Number(it.tax_minor) - Number(it.fee_minor) !== Number(it.net_minor)) await flag('amount_mismatch', it.id, it, {});
  }
  const over = await many(
    `SELECT l.seller_id, l.currency, sum(l.amount_cents)::bigint AS owed FROM provider_ledger l GROUP BY l.seller_id, l.currency HAVING sum(l.amount_cents) < 0`);
  for (const o of over) { found.push({ kind: 'over_paid', seller_id: o.seller_id }); await raiseException(null, { kind: 'ledger_drift', dedupeKey: `payout_over_paid:${o.seller_id}:${o.currency}`, sellerId: o.seller_id, currency: o.currency, amount: Number(o.owed), detail: { check: 'over_paid' } }); }
  return { checked: paid.length, findings: found.length, details: found };
}

// ------------------------------------------------------------------ Stripe transfer events (verified signature, no session)
/**
 * A verified Stripe transfer event for a transfer we made. `transfer.created` settles an item whose synchronous result was lost (the provider was
 * unreachable after accepting the transfer); `transfer.reversed` never edits a paid item — it opens an exception for the platform team.
 * Idempotent: a replayed event is a no-op.
 */
export async function onStripeTransfer(event) {
  const t = event.data?.object ?? {};
  const itemId = t.metadata?.payout_item_id;
  if (!itemId || !/^[0-9a-f-]{36}$/.test(itemId)) return { handled: false };
  const it = await one('SELECT * FROM payout_items WHERE id=$1', [itemId]);
  if (!it) return { handled: false };
  if (event.type === 'transfer.created') {
    if (it.status !== 'pending') return { handled: true, noop: true };
    if (Number(t.amount) !== Number(it.net_minor) || String(t.currency).toUpperCase() !== it.currency) {
      await raiseException(null, { kind: 'amount_mismatch', dedupeKey: `payout_transfer_amount:${it.id}:${t.id}`, sellerId: it.payee_id, currency: it.currency, amount: Number(it.net_minor), detail: { payout_item_id: it.id, transfer: t.id, transfer_amount: t.amount } });
      return { handled: true, mismatch: true };
    }
    await recordItemResult(null, { item_id: it.id, outcome: 'paid', reference: t.id });
    return { handled: true, settled: true };
  }
  if (event.type === 'transfer.reversed') {
    await raiseException(null, { kind: 'payout_failed', dedupeKey: `payout_transfer_reversed:${it.id}:${t.id}`, sellerId: it.payee_id, payoutId: it.provider_payout_id ?? null, currency: it.currency, amount: Number(it.net_minor),
      detail: { payout_item_id: it.id, transfer: t.id, note: 'Stripe reversed the transfer after it was recorded as paid. Check the connected account, then retry or write it off in the exceptions queue.' } });
    return { handled: true, reversed: true };
  }
  return { handled: false };
}

// ------------------------------------------------------------------ organiser view (read only: platform staff move the money)
export async function eventOfficialPayouts(eventId) {
  return many(
    `SELECT fo.id AS assignment_id, fo.role, fo.user_id, u.display_name AS official, fo.fee_minor::bigint AS fee_minor, fo.fee_currency, fo.pay_status, f.id AS fixture_id,
            i.id AS payout_item_id, i.status AS payout_status, i.net_minor, i.reference, i.decided_at AS paid_at, i.failure_code
       FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN users u ON u.id=fo.user_id
       LEFT JOIN LATERAL (SELECT * FROM payout_items x WHERE x.source_type='official_fee' AND x.source_id=fo.id ORDER BY x.created_at DESC LIMIT 1) i ON true
      WHERE f.event_id=$1 AND fo.fee_minor IS NOT NULL AND fo.pay_status <> 'none' ORDER BY f.scheduled_at, fo.id`, [eventId]);
}

// ------------------------------------------------------------------ venue bank details -> the one payee account store
/**
 * Venue partners saved bank details on the partner record (partners.payout_enc). Copy them, re-encrypted, into payout_accounts as *pending* so the
 * platform team verifies them like any other payee account. Idempotent; the partner record is left untouched and nothing is overwritten:
 * an owner who already has any account in that currency (live or historic) is skipped.
 */
export async function backfillPartnerAccounts() {
  const rows = await many(
    `SELECT p.id, p.owner_id, p.payout_enc, p.payout_last4,
            coalesce((SELECT s.currency FROM settlements s WHERE s.partner_id=p.id ORDER BY s.created_at DESC LIMIT 1), $1) AS currency
       FROM partners p WHERE p.payout_enc IS NOT NULL`, [config.settlement.currencies[0] ?? 'INR']);
  let n = 0;
  for (const p of rows) {
    if (!/^[A-Z]{3}$/.test(p.currency)) continue;
    let d; try { d = JSON.parse(decrypt(p.payout_enc, 'partners.payout')); } catch { continue; }
    const made = await tx(async (c) => {
      if ((await c.query('SELECT 1 FROM payout_accounts WHERE owner_id=$1 AND currency=$2', [p.owner_id, p.currency])).rowCount) return false;
      const a = (await c.query('INSERT INTO payout_accounts(owner_id, currency, details_enc, last4) VALUES ($1,$2,$3,$4) RETURNING id',
        [p.owner_id, p.currency, encrypt(JSON.stringify({ holder_name: d.account_holder, account_number: d.account_number, bank_code: d.bank_code ?? '' }), 'payout_accounts.details'), String(d.account_number).replace(/[^A-Za-z0-9]/g, '').slice(-4)])).rows[0];
      await audit(c, null, 'backfill_payout_account', 'payout_accounts', a.id);
      return true;
    });
    if (made) n++;
  }
  return n;
}
