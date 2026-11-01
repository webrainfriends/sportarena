// Unified Finance control plane (#564): the one canonical, append-only record of every money movement. Modules do not own a financial
// truth: each money path posts here (idempotently, in the same transaction as the movement it records) and the console, dashboards,
// exports and reconciliation read only from here. See docs/finance.md for the model, the module map and what is migrated.
import { many, one, pool, tx } from './db.js';
import { sharesFor } from './settlement.js';

/** payments.purpose_type -> the business module whose money it is. A type missing here is labelled 'other', never dropped. */
export const MODULE_OF = {
  shop_order: 'shop', shop_checkout: 'shop', coach_hire: 'coaching', coach_class_seat: 'coaching', coach_subscription_period: 'coaching', coach_package: 'coaching', appointment: 'health', physio_package: 'health', insurance_policy: 'insurance',
  venue_invoice: 'venue', venue_plan: 'venue', pos_sale: 'venue', wallet_topup: 'wallet', gift_card: 'wallet', sponsorship_payment: 'sponsorship',
  academy_charge: 'registration', registration_instalment: 'registration', team_charge: 'registration', team_contribution: 'registration', media_rights_fee: 'media', ad_funding: 'advertising',
  service_invoice: 'suppliers', ticket_order: 'tickets',
};
export const moduleOf = (type) => MODULE_OF[type] ?? 'other';
export const MODULE_LABEL = {
  registration: 'Registration & dues', venue: 'Venue', coaching: 'Coaching', health: 'Doctor & physio', shop: 'Shop', wallet: 'Wallet', sponsorship: 'Sponsorship',
  suppliers: 'Suppliers', insurance: 'Insurance', media: 'Media rights', advertising: 'Advertising', travel: 'Travel', officials: 'Officials', agents: 'Agents', tickets: 'Spectator tickets', events: 'Event budget', payouts: 'Payouts', contracts: 'Player contracts', other: 'Other',
};

/** The canonical views an organisation reads its books by (#593). Every module maps to exactly one; an unmapped module is 'other', never dropped. */
export const CATEGORY_LABEL = {
  registration: 'Registration & membership', tickets: 'Event & ticket income', venue_service: 'Venue & service income', sponsorship: 'Sponsorship',
  suppliers: 'Supplier spend', event_budget: 'Event budget spend', payouts: 'Settlements & payouts', commissions: 'Agent commissions', contracts: 'Player & official pay', travel: 'Travel & trips', other: 'Other',
};
const CATEGORY_OF_MODULE = {
  registration: 'registration', tickets: 'tickets', venue: 'venue_service', coaching: 'venue_service', health: 'venue_service', insurance: 'venue_service', shop: 'venue_service',
  sponsorship: 'sponsorship', suppliers: 'suppliers', events: 'event_budget', payouts: 'payouts', officials: 'contracts', contracts: 'contracts', agents: 'commissions', travel: 'travel', wallet: 'venue_service',
};
export const categoryOf = (module) => CATEGORY_OF_MODULE[module] ?? 'other';

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
  } else if (t === 'sponsorship_payment') {
    const r = await get(`SELECT sr.owner_id, sr.organisation_id AS payer_org,
        CASE sp.target_type WHEN 'event' THEN (SELECT organisation_id FROM events WHERE id = sp.target_id) WHEN 'team' THEN (SELECT organisation_id FROM teams WHERE id = sp.target_id) END AS payee_org
      FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id = x.obligation_id JOIN sponsorships sp ON sp.id = o.sponsorship_id JOIN sponsors sr ON sr.id = sp.sponsor_id WHERE x.id=$1`);
    if (r) { out.payerOrgId = r.payer_org; out.payeeOrgId = r.payee_org; }
  } else if (t === 'ticket_order') {
    const r = await get('SELECT e.organizer_id, e.organisation_id FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1');
    if (r) { out.payeeId = r.organizer_id; out.payeeOrgId = r.organisation_id; }
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

export const insert = async (c, e) => {
  const r = (await q(c).query(
    `INSERT INTO fin_transactions(kind, status, source_module, source_type, source_id, payer_id, payee_id, payer_org_id, payee_org_id, currency, gross_minor, tax_minor, fee_minor, discount_minor, net_minor,
       provider, provider_ref, payment_id, payout_id, parent_id, idem_key, occurred_at, meta, category, due_on, event_id, team_id, workspace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,coalesce($22, now()),$23,$24,$25,$26,$27,$28)
     ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    [e.kind, e.status ?? 'settled', e.module, e.sourceType, e.sourceId ?? null, e.payerId ?? null, e.payeeId ?? null, e.payerOrgId ?? null, e.payeeOrgId ?? null, e.currency, e.gross,
      e.tax ?? 0, e.fee ?? 0, e.discount ?? 0, e.net ?? e.gross - (e.tax ?? 0) - (e.fee ?? 0), e.provider ?? null, e.providerRef ?? null, e.paymentId ?? null, e.payoutId ?? null,
      e.parentId ?? null, e.key, e.at ?? null, JSON.stringify(e.meta ?? {}), categoryOf(e.module), e.dueOn ?? null, e.eventId ?? null, e.teamId ?? null, e.workspaceId ?? null])).rows[0];
  if (r) {
    await q(c).query("INSERT INTO fin_tx_events(tx_id, actor_id, action, data) VALUES ($1,$2,$3,$4)", [r.id, e.actorId ?? null, 'posted', JSON.stringify({ kind: e.kind, status: e.status ?? 'settled' })]);
    await safe(c, (k) => applyDimensions(k, [r.id]), null);   // season / event / team / workspace, read from the source record; a miss never blocks the posting
  }
  return r?.id ?? null;
};

/**
 * Fill the filter dimensions of ledger rows from the record that caused them. Only ever sets a NULL (never overwrites), touches no amount or party,
 * and is safe to repeat. `ids` limits it to new rows; without it every row still missing a dimension is caught up (reconciliation).
 */
export async function applyDimensions(c, ids = null) {
  const k = q(c);
  const sel = ids ? 'f.id = ANY($1::uuid[])' : '($1::uuid[] IS NULL AND (f.category IS NULL OR f.season_id IS NULL OR (f.event_id IS NULL AND f.team_id IS NULL AND f.workspace_id IS NULL)))';
  const arg = [ids];
  await k.query(`UPDATE fin_transactions f SET category = CASE ${Object.entries(CATEGORY_OF_MODULE).map(([m, v]) => `WHEN f.source_module = '${m}' THEN '${v}'`).join(' ')} ELSE 'other' END WHERE f.category IS NULL AND ${sel}`, arg);
  const set = (sql) => k.query(sql.replace('/*SEL*/', sel), arg);
  await set(`UPDATE fin_transactions f SET event_id = coalesce(f.event_id, o.event_id) FROM ticket_orders o WHERE f.source_type='ticket_order' AND o.id=f.source_id AND f.event_id IS NULL AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET team_id = coalesce(f.team_id, ch.team_id), event_id = coalesce(f.event_id, b.event_id) FROM team_charges ch JOIN team_charge_batches b ON b.id = ch.batch_id
              WHERE f.source_type='team_charge' AND ch.id=f.source_id AND (f.team_id IS NULL OR f.event_id IS NULL) AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET team_id = coalesce(f.team_id, fr.team_id) FROM team_contributions tc JOIN team_fundraisers fr ON fr.id = tc.fundraiser_id
              WHERE f.source_type='team_contribution' AND tc.id=f.source_id AND f.team_id IS NULL AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET event_id = coalesce(f.event_id, p.event_id), team_id = coalesce(f.team_id, e.team_id) FROM rx_instalments i JOIN rx_entries e ON e.id = i.entry_id JOIN rx_programmes p ON p.id = e.programme_id
              WHERE f.source_type='registration_instalment' AND i.id=f.source_id AND (f.event_id IS NULL OR f.team_id IS NULL) AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET event_id = coalesce(f.event_id, b.event_id) FROM svc_invoices s JOIN svc_buyers b ON b.id = s.buyer_id
              WHERE f.source_type='service_invoice' AND s.id=f.source_id AND f.event_id IS NULL AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET event_id = coalesce(f.event_id, CASE WHEN sp.target_type='event' THEN sp.target_id END), team_id = coalesce(f.team_id, CASE WHEN sp.target_type='team' THEN sp.target_id END),
                workspace_id = coalesce(f.workspace_id, sp.department_id)
              FROM sponsorship_obligations o JOIN sponsorships sp ON sp.id = o.sponsorship_id
              WHERE f.source_type='sponsorship_obligation' AND o.id=f.source_id AND (f.event_id IS NULL OR f.team_id IS NULL OR f.workspace_id IS NULL) AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET event_id = coalesce(f.event_id, CASE WHEN sp.target_type='event' THEN sp.target_id END), team_id = coalesce(f.team_id, CASE WHEN sp.target_type='team' THEN sp.target_id END),
                workspace_id = coalesce(f.workspace_id, sp.department_id)
              FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id = x.obligation_id JOIN sponsorships sp ON sp.id = o.sponsorship_id
              WHERE f.source_type='sponsorship_payment' AND x.id=f.source_id AND (f.event_id IS NULL OR f.team_id IS NULL OR f.workspace_id IS NULL) AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET payer_org_id = coalesce(f.payer_org_id, sr.organisation_id),
                payee_org_id = coalesce(f.payee_org_id, CASE sp.target_type WHEN 'event' THEN (SELECT organisation_id FROM events WHERE id = sp.target_id) WHEN 'team' THEN (SELECT organisation_id FROM teams WHERE id = sp.target_id) END)
              FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id = x.obligation_id JOIN sponsorships sp ON sp.id = o.sponsorship_id JOIN sponsors sr ON sr.id = sp.sponsor_id
              WHERE f.source_type='sponsorship_payment' AND x.id=f.source_id AND (f.payer_org_id IS NULL OR f.payee_org_id IS NULL) AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET payer_org_id = coalesce(f.payer_org_id, e.organisation_id), event_id = coalesce(f.event_id, fx.event_id)
              FROM payout_items pi JOIN fixture_officials fo ON fo.id = pi.source_id JOIN fixtures fx ON fx.id = fo.fixture_id JOIN events e ON e.id = fx.event_id
              WHERE f.source_type='payout_item' AND pi.id=f.source_id AND pi.source_type='official_fee' AND (f.payer_org_id IS NULL OR f.event_id IS NULL) AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET event_id = coalesce(f.event_id, bp.event_id) FROM event_budget_payments bp WHERE f.source_type='event_budget_payment' AND bp.id=f.source_id AND f.event_id IS NULL AND /*SEL*/`);
  await set(`UPDATE fin_transactions f SET season_id = (SELECT s.id FROM org_seasons s WHERE s.organisation_id = coalesce(f.payee_org_id, f.payer_org_id) AND f.occurred_at::date BETWEEN s.starts_on AND s.ends_on ORDER BY s.starts_on DESC LIMIT 1)
              WHERE f.season_id IS NULL AND coalesce(f.payee_org_id, f.payer_org_id) IS NOT NULL AND /*SEL*/`);
}

export const setStatus = async (c, idem, status, actorId = null, data = {}) => {
  const r = (await q(c).query('UPDATE fin_transactions SET status=$2 WHERE idem_key=$1 AND status <> $2 RETURNING id', [idem, status])).rows[0];
  if (r) await q(c).query('INSERT INTO fin_tx_events(tx_id, actor_id, action, data) VALUES ($1,$2,$3,$4)', [r.id, actorId, `status_${status}`, JSON.stringify(data)]);
  return !!r;
};

/** A charge: money someone owes for a thing, open until paid. Posted when checkout starts. */
export async function recordCharge(c, p) {
  // a source that already carries a canonical obligation (academy / team charge, instalment, supplier invoice ...) is one receivable, never two
  if ((await q(c).query('SELECT 1 FROM fin_transactions WHERE idem_key=$1', [`obl:${p.purpose_type}:${p.purpose_id}`])).rowCount) return null;
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

/** A payout item that settles an officials fee or a venue settlement (provider balances post through recordPayout). Open until the transfer is recorded. */
export async function recordPayoutItem(c, it, status = 'open', batchRail = 'bank_file') {
  const key = `payout_item:${it.id}:${it.attempt}`;
  const id = await insert(c, { kind: 'payout', status, module: it.source_type === 'official_fee' ? 'officials' : 'venue', sourceType: 'payout_item', sourceId: it.id, payeeId: it.payee_id, currency: it.currency,
    gross: n(it.gross_minor), tax: n(it.tax_minor), fee: n(it.fee_minor), net: n(it.net_minor), provider: batchRail === 'stripe' ? 'stripe' : 'manual_transfer', providerRef: it.reference ?? null, key,
    meta: { batch_id: it.batch_id, source_type: it.source_type, source_id: it.source_id } });
  if (!id) await setStatus(c, key, status);
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
  // sources that do not flow through payments (obligations, staff-recorded receipts, event budget spend) and the filter dimensions (#593)
  const { syncLedger } = await import('./finance-sync.js');
  const synced = await syncLedger({ limit });
  return { backfilled, payouts_backfilled: payoutsBackfilled, refunds_repaired: repaired, open_items: open, closed_items: closed, more: missing.length > limit || synced.more, synced };
}

// ------------------------------------------------------------------------------------------------ read models

/** Who is looking: one organisation's books, or (platform admin) every entity's. */
const scopeSql = (scope, params) => {
  if (scope.orgId) { params.push(scope.orgId); return `(f.payee_org_id = $${params.length} OR f.payer_org_id = $${params.length})`; }
  return 'TRUE';
};
const side = (scope, params) => {   // 'in' = money to the organisation, 'out' = money it pays; platform view counts customer money as 'in'
  if (!scope.orgId) return { inn: "f.source_module <> 'events'", out: 'FALSE' };   // customer money; an organisation's own event-budget spend is not platform revenue
  params.push(scope.orgId);
  const i = params.length;
  return { inn: `f.payee_org_id = $${i}`, out: `(f.payer_org_id = $${i} AND f.payee_org_id IS DISTINCT FROM $${i})` };
};

/** What is still owed on an open charge: its amount less the payments the ledger already holds for the same source (online or recorded by staff). */
export const OUTSTANDING = `greatest(f.gross_minor
  - coalesce((SELECT sum(p.gross_minor) FROM fin_transactions p WHERE p.kind IN ('payment','credit_note') AND p.status = 'settled' AND p.source_type = f.source_type AND p.source_id = f.source_id), 0)
  - CASE WHEN f.source_type = 'sponsorship_obligation' THEN coalesce((SELECT sum(p.gross_minor) FROM fin_transactions p JOIN sponsorship_payments x ON x.id = p.source_id WHERE p.kind = 'payment' AND p.status = 'settled' AND p.source_type = 'sponsorship_payment' AND x.obligation_id = f.source_id), 0) ELSE 0 END
  + CASE WHEN f.source_type = 'sponsorship_obligation' THEN coalesce((SELECT sum(r.gross_minor) FROM fin_transactions r WHERE r.kind = 'refund' AND r.status = 'settled' AND (r.source_type = f.source_type AND r.source_id = f.source_id
        OR (r.source_type = 'sponsorship_payment' AND r.source_id IN (SELECT x.id FROM sponsorship_payments x WHERE x.obligation_id = f.source_id)))), 0) ELSE 0 END, 0)`;

/** The organisation filters (#593): season, event, team, workspace and revenue category, each one value or a list. Returns SQL to AND onto a query on `f`. */
export const DIMENSIONS = { season_id: 'uuid', event_id: 'uuid', team_id: 'uuid', workspace_id: 'uuid', category: 'text' };
export function dimSql(params, filters = {}) {
  let sql = '';
  for (const [k, type] of Object.entries(DIMENSIONS)) {
    const v = filters[k];
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    params.push(Array.isArray(v) ? v : [v]);
    sql += ` AND f.${k} = ANY($${params.length}::${type}[])`;
  }
  return sql;
}

export async function summary(scope, { from, to, currency, module, ...dims } = {}) {
  const params = [from ?? '1970-01-01', to ? `${to}T23:59:59.999Z` : '9999-12-31'];
  const sd = side(scope, params);
  let extra = '';
  if (currency) { params.push(currency); extra += ` AND f.currency = $${params.length}`; }
  if (module) { params.push(module); extra += ` AND f.source_module = $${params.length}`; }
  extra += dimSql(params, dims);
  const sum = (kind, status, cond, col) => `coalesce(sum(${col === 'outstanding' ? OUTSTANDING : `f.${col}`}) FILTER (WHERE f.kind='${kind}' AND f.status IN (${status}) AND ${cond}),0)::bigint`;
  const rows = await many(
    `SELECT f.currency,
        ${sum('payment', "'settled'", sd.inn, 'gross_minor')} AS gross, ${sum('payment', "'settled'", sd.inn, 'tax_minor')} AS tax, ${sum('payment', "'settled'", sd.inn, 'fee_minor')} AS fee,
        ${sum('payment', "'settled'", sd.inn, 'net_minor')} AS paid_net, ${sum('refund', "'settled'", sd.inn, 'gross_minor')} AS refunds, ${sum('refund', "'settled'", sd.inn, 'net_minor')} AS refunds_net,
        ${sum('chargeback', "'settled'", sd.inn, 'net_minor')} AS chargebacks_net, ${sum('chargeback', "'disputed'", sd.inn, 'gross_minor')} AS disputed,
        ${sum('charge', "'open'", sd.inn, 'outstanding')} AS receivable, ${sum('charge', "'open'", sd.out, 'outstanding')} AS payable,
        ${sum('payment', "'settled'", sd.out, 'gross_minor')} AS spend,
        count(*) FILTER (WHERE f.kind='payment' AND f.status='settled' AND ${sd.inn})::int AS payments
       FROM fin_transactions f WHERE f.occurred_at >= $1 AND f.occurred_at <= $2 AND ${scope.orgId ? `(${sd.inn} OR ${sd.out})` : 'TRUE'}${extra} GROUP BY f.currency ORDER BY f.currency`, params);
  const byParams = [...params];
  const by = await many(
    `SELECT f.currency, f.source_module AS module,
        ${sum('payment', "'settled'", sd.inn, 'gross_minor')} AS gross, ${sum('refund', "'settled'", sd.inn, 'gross_minor')} AS refunds,
        (${sum('payment', "'settled'", sd.inn, 'net_minor')} - ${sum('refund', "'settled'", sd.inn, 'net_minor')} - ${sum('chargeback', "'settled'", sd.inn, 'net_minor')})::bigint AS net,
        ${sum('payment', "'settled'", sd.out, 'gross_minor')} AS spend, ${sum('charge', "'open'", sd.inn, 'outstanding')} AS receivable
       FROM fin_transactions f WHERE f.occurred_at >= $1 AND f.occurred_at <= $2 AND ${scope.orgId ? `(${sd.inn} OR ${sd.out})` : 'TRUE'}${extra}
      GROUP BY f.currency, f.source_module ORDER BY f.currency, f.source_module`, byParams);
  const cats = await many(
    `SELECT f.currency, coalesce(f.category, 'other') AS category,
        ${sum('payment', "'settled'", sd.inn, 'gross_minor')} AS gross, ${sum('refund', "'settled'", sd.inn, 'gross_minor')} AS refunds, ${sum('payment', "'settled'", sd.inn, 'tax_minor')} AS tax, ${sum('payment', "'settled'", sd.inn, 'fee_minor')} AS fee,
        (${sum('payment', "'settled'", sd.inn, 'net_minor')} - ${sum('refund', "'settled'", sd.inn, 'net_minor')} - ${sum('chargeback', "'settled'", sd.inn, 'net_minor')})::bigint AS net,
        ${sum('payment', "'settled'", sd.out, 'gross_minor')} AS spend, ${sum('charge', "'open'", sd.inn, 'outstanding')} AS receivable, ${sum('charge', "'open'", sd.out, 'outstanding')} AS payable
       FROM fin_transactions f WHERE f.occurred_at >= $1 AND f.occurred_at <= $2 AND ${scope.orgId ? `(${sd.inn} OR ${sd.out})` : 'TRUE'}${extra}
      GROUP BY f.currency, coalesce(f.category, 'other') ORDER BY f.currency, 2`, [...params]);
  const review = await needsReview(scope);
  return {
    currencies: rows.map((r) => ({
      currency: r.currency, gross: n(r.gross), tax: n(r.tax), fee: n(r.fee), refunds: n(r.refunds), chargebacks: n(r.chargebacks_net), disputed: n(r.disputed),
      net: n(r.paid_net) - n(r.refunds_net) - n(r.chargebacks_net), receivable: n(r.receivable), payable: n(r.payable), spend: n(r.spend), payments: r.payments,
      commissions: n(r.fee), taxes: n(r.tax),   // provider / platform commission taken from the payee, and tax contained in gross
      by_category: cats.filter((b) => b.currency === r.currency).map((b) => ({ category: b.category, label: CATEGORY_LABEL[b.category] ?? b.category, gross: n(b.gross), refunds: n(b.refunds), tax: n(b.tax), fee: n(b.fee), net: n(b.net), spend: n(b.spend), receivable: n(b.receivable), payable: n(b.payable) })),
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

export async function listTransactions(scope, { from, to, module, kind, status, currency, direction, limit = 25, offset = 0, ...dims } = {}) {
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
  const dimWhere = dimSql(params, dims);
  params.push(limit, offset);
  const rows = await many(
    `SELECT f.id, f.kind, f.status, f.source_module, f.source_type, f.source_id, f.currency, f.gross_minor, f.tax_minor, f.fee_minor, f.discount_minor, f.net_minor, f.provider, f.provider_ref,
            f.payment_id, f.parent_id, f.occurred_at, f.payer_id, f.payee_id, f.payer_org_id, f.payee_org_id, f.category, f.due_on, f.season_id, f.event_id, f.team_id, f.workspace_id, f.idem_key, pu.display_name AS payer, eu.display_name AS payee
       FROM fin_transactions f LEFT JOIN users pu ON pu.id = f.payer_id LEFT JOIN users eu ON eu.id = f.payee_id
      WHERE ${where.join(' AND ')}${dimWhere} ORDER BY f.occurred_at DESC, f.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map((r) => view(r, scope));
}

const view = (r, scope) => ({
  id: r.id, kind: r.kind, status: r.status, module: r.source_module, module_label: MODULE_LABEL[r.source_module] ?? r.source_module, source_type: r.source_type, source_id: r.source_id,
  currency: r.currency, gross_minor: n(r.gross_minor), tax_minor: n(r.tax_minor), fee_minor: n(r.fee_minor), discount_minor: n(r.discount_minor), net_minor: n(r.net_minor),
  provider: r.provider, provider_ref: r.provider_ref, payment_id: r.payment_id, parent_id: r.parent_id, occurred_at: r.occurred_at,
  category: r.category ?? null, category_label: CATEGORY_LABEL[r.category] ?? null, due_on: r.due_on ?? null, season_id: r.season_id ?? null, event_id: r.event_id ?? null, team_id: r.team_id ?? null, workspace_id: r.workspace_id ?? null, ledger_key: r.idem_key ?? null, payer: r.payer ?? null, payee: r.payee ?? null,
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

// ------------------------------------------------------------------------------------------------ ageing, obligations, settlements (#593)

export const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];
const bucketSql = "CASE WHEN current_date - coalesce(f.due_on, f.occurred_at::date) <= 0 THEN 'current' WHEN current_date - coalesce(f.due_on, f.occurred_at::date) <= 30 THEN 'd1_30' WHEN current_date - coalesce(f.due_on, f.occurred_at::date) <= 60 THEN 'd31_60' WHEN current_date - coalesce(f.due_on, f.occurred_at::date) <= 90 THEN 'd61_90' ELSE 'd90_plus' END";

/** Open charges (receivables and payables) in scope with what is still outstanding on each; the one base for ageing, upcoming cash and the drill-down. */
function openCharges(scope, { currency, module, from_due, to_due, direction, bucket, ...dims } = {}) {
  const params = [];
  const where = ["f.kind = 'charge'", "f.status = 'open'", scopeSql(scope, params)];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (currency) add('f.currency = ?', currency);
  if (module) add('f.source_module = ?', module);
  if (from_due) add('coalesce(f.due_on, f.occurred_at::date) >= ?', from_due);
  if (to_due) add('coalesce(f.due_on, f.occurred_at::date) <= ?', to_due);
  let dir = "'in'";
  if (scope.orgId) {
    params.push(scope.orgId);
    dir = `CASE WHEN f.payee_org_id = $${params.length} THEN 'in' ELSE 'out' END`;
    if (direction) where.push(`(${dir}) = '${direction === 'out' ? 'out' : 'in'}'`);
  } else if (direction === 'out') where.push('FALSE');
  if (bucket) where.push(`(${bucketSql}) = '${BUCKETS.includes(bucket) ? bucket : 'current'}'`);
  const sql = `SELECT f.id, f.currency, f.source_module, f.source_type, f.source_id, f.category, f.due_on, f.occurred_at, f.gross_minor, ${OUTSTANDING} AS outstanding, ${dir} AS direction, ${bucketSql} AS bucket,
      coalesce(f.due_on, f.occurred_at::date) AS effective_due, current_date - coalesce(f.due_on, f.occurred_at::date) AS days_overdue, f.idem_key, pu.display_name AS payer, eu.display_name AS payee
    FROM fin_transactions f LEFT JOIN users pu ON pu.id = f.payer_id LEFT JOIN users eu ON eu.id = f.payee_id WHERE ${where.join(' AND ')}${dimSql(params, dims)}`;
  return { sql, params };
}

/** Receivable and payable ageing per currency (never summed across currencies): current, 1-30, 31-60, 61-90, 90+ days past due. */
export async function ageing(scope, filters = {}) {
  const { sql, params } = openCharges(scope, filters);
  const rows = await many(`SELECT currency, direction, bucket, count(*)::int AS items, coalesce(sum(outstanding),0)::bigint AS outstanding FROM (${sql}) o WHERE outstanding > 0 GROUP BY currency, direction, bucket`, params);
  const out = new Map();
  for (const r of rows) {
    const c = out.get(r.currency) ?? { currency: r.currency, receivable: { total: 0, items: 0, buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])) }, payable: { total: 0, items: 0, buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])) } };
    const side = r.direction === 'in' ? c.receivable : c.payable;
    side.buckets[r.bucket] = n(r.outstanding); side.total += n(r.outstanding); side.items += r.items;
    out.set(r.currency, c);
  }
  return { as_of: new Date().toISOString().slice(0, 10), buckets: BUCKETS, currencies: [...out.values()].sort((a, b) => a.currency.localeCompare(b.currency)) };
}

/** What falls due, soonest first (overdue items first): the receivables and payables behind the ageing numbers, each with its source for drill-down. */
export async function obligations(scope, { limit = 25, offset = 0, ...filters } = {}) {
  const { sql, params } = openCharges(scope, filters);
  params.push(limit, offset);
  const rows = await many(`SELECT * FROM (${sql}) o WHERE outstanding > 0 ORDER BY effective_due, id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map((r) => ({
    id: r.id, direction: r.direction, currency: r.currency, outstanding_minor: n(r.outstanding), gross_minor: n(r.gross_minor), due_on: r.effective_due, days_overdue: Math.max(0, n(r.days_overdue)), overdue: n(r.days_overdue) > 0,
    bucket: r.bucket, module: r.source_module, module_label: MODULE_LABEL[r.source_module] ?? r.source_module, category: r.category, source_type: r.source_type, source_id: r.source_id, ledger_key: r.idem_key,
    payer: r.payer ?? null, payee: r.payee ?? null,
  }));
}

/**
 * Settlement status of the money that reaches the organisation: provider payouts (and payout items) with where each one stands, plus what is
 * received but not yet paid out. A payout belongs to an organisation when it names the organisation or one of its active owners / admins / finance staff.
 */
export async function settlements(scope, { from, to, currency, limit = 25, offset = 0 } = {}) {
  const params = [];
  const where = ["f.kind IN ('payout','payout_reversal')"];
  if (scope.orgId) {
    params.push(scope.orgId);
    where.push(`(f.payee_org_id = $1 OR f.payer_org_id = $1 OR f.payee_id IN (SELECT user_id FROM organisation_members WHERE organisation_id = $1 AND status = 'active' AND role IN ('owner','admin','finance')))`);
  }
  if (from) { params.push(from); where.push(`f.occurred_at >= $${params.length}`); }
  if (to) { params.push(`${to}T23:59:59.999Z`); where.push(`f.occurred_at <= $${params.length}`); }
  if (currency) { params.push(currency); where.push(`f.currency = $${params.length}`); }
  const totals = await many(
    `SELECT f.currency, f.status, count(*)::int AS items, coalesce(sum(f.gross_minor),0)::bigint AS gross, coalesce(sum(f.net_minor),0)::bigint AS net FROM fin_transactions f WHERE ${where.join(' AND ')} GROUP BY f.currency, f.status ORDER BY f.currency`, params);
  const list = [...params, limit, offset];
  const rows = await many(
    `SELECT f.id, f.kind, f.status, f.source_module, f.source_type, f.source_id, f.currency, f.gross_minor, f.tax_minor, f.fee_minor, f.net_minor, f.provider, f.provider_ref, f.payout_id, f.occurred_at, f.idem_key, eu.display_name AS payee
       FROM fin_transactions f LEFT JOIN users eu ON eu.id = f.payee_id WHERE ${where.join(' AND ')} ORDER BY f.occurred_at DESC, f.id DESC LIMIT $${list.length - 1} OFFSET $${list.length}`, list);
  return {
    totals: totals.map((t) => ({ currency: t.currency, status: t.status, items: t.items, gross_minor: n(t.gross), net_minor: n(t.net) })),
    items: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, state: { open: 'in_progress', settled: 'paid', failed: 'failed', reversed: 'reversed', cancelled: 'cancelled', disputed: 'on_hold' }[r.status] ?? r.status, module: r.source_module,
      module_label: MODULE_LABEL[r.source_module] ?? r.source_module, source_type: r.source_type, source_id: r.source_id, currency: r.currency, gross_minor: n(r.gross_minor), tax_minor: n(r.tax_minor), fee_minor: n(r.fee_minor), net_minor: n(r.net_minor),
      provider: r.provider, provider_ref: r.provider_ref, payout_id: r.payout_id, occurred_at: r.occurred_at, ledger_key: r.idem_key, payee: r.payee ?? null })),
  };
}

// ------------------------------------------------------------------------------------------------ access and audit (#593)

/** Finance levels. Owner / admin keep full control, the finance role keeps what it always had (read, export, close items); a grant adds a level for anyone else. */
export const LEVELS = ['viewer', 'accountant', 'controller'];
const RANK = { viewer: 1, accountant: 2, controller: 3 };
const ROLE_LEVEL = { owner: 'controller', admin: 'controller', finance: 'accountant' };
export const atLeast = (level, need) => (RANK[level] ?? 0) >= RANK[need];

/** The caller's finance level in an organisation: platform admin and owner/admin -> controller, finance -> accountant, else an active grant, else null. Read live on every call. */
export async function financeLevel(user, orgId) {
  if (user?.roles?.includes('admin')) return 'controller';
  const m = await one("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, user.id]);
  const byRole = m ? ROLE_LEVEL[m.role] ?? null : null;
  const g = await one("SELECT level FROM fin_finance_access WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, user.id]);
  const best = [byRole, g?.level].filter(Boolean).sort((a, b) => RANK[b] - RANK[a])[0];
  return best ?? null;
}

/** Finance-related history of an organisation: who viewed, exported, closed items or changed access (audit log) and every status change on its ledger rows. Newest first. */
export async function auditTrail(orgId, { limit = 25, offset = 0 } = {}) {
  return many(
    `SELECT * FROM (
       SELECT 'audit'::text AS source, a.id::text AS ref, a.action, a.at AS at, u.display_name AS actor, a.entity, a.entity_id
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE (a.entity = 'organisations' AND a.entity_id = $1 AND (a.action LIKE '%finance%'))
           OR (a.entity = 'fin_transactions' AND a.entity_id IN (SELECT id FROM fin_transactions WHERE payee_org_id = $1 OR payer_org_id = $1))
       UNION ALL
       SELECT 'ledger'::text, e.id::text, e.action, e.created_at, u.display_name, 'fin_transactions'::text, e.tx_id
         FROM fin_tx_events e JOIN fin_transactions f ON f.id = e.tx_id LEFT JOIN users u ON u.id = e.actor_id
        WHERE (f.payee_org_id = $1 OR f.payer_org_id = $1) AND e.action <> 'posted'
     ) h ORDER BY at DESC, ref DESC LIMIT $2 OFFSET $3`, [orgId, limit, offset]);
}

/** The values the organisation can filter by, taken from its own data: its seasons and workspaces, and the events and teams that actually appear in its books. */
export async function filterOptions(scope) {
  const params = [];
  const sc = scopeSql(scope, params);
  const seasons = scope.orgId ? await many('SELECT id, name, starts_on, ends_on, status FROM org_seasons WHERE organisation_id = $1 ORDER BY starts_on DESC LIMIT 100', [scope.orgId]) : [];
  const workspaces = scope.orgId ? await many('SELECT id, name FROM org_departments WHERE organisation_id = $1 AND archived_at IS NULL ORDER BY lower(name) LIMIT 100', [scope.orgId]) : [];
  const events = await many(`SELECT e.id, e.name FROM events e WHERE e.id IN (SELECT f.event_id FROM fin_transactions f WHERE f.event_id IS NOT NULL AND ${sc}) ORDER BY e.name LIMIT 200`, params);
  const teams = await many(`SELECT t.id, t.name FROM teams t WHERE t.id IN (SELECT f.team_id FROM fin_transactions f WHERE f.team_id IS NOT NULL AND ${sc}) ORDER BY t.name LIMIT 200`, params);
  return {
    seasons: seasons.map((x) => ({ id: x.id, name: x.name, starts_on: x.starts_on, ends_on: x.ends_on, status: x.status })), events, teams, workspaces,
    categories: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
  };
}
