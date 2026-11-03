// Finance control plane, organisation edition (#593): puts the money that does not flow through `payments` onto the same canonical ledger
// (#564) instead of building a second one. Four kinds of source, each read from the module that owns the workflow and posted idempotently:
//   * obligations  - a charge that is owed before it is paid (academy and team charges, registration instalments, supplier invoices,
//                    sponsorship dues). Key `obl:<type>:<id>`; its status follows the source (open -> settled / cancelled); `due_on` drives ageing.
//   * receipts     - money received outside a provider (cash, bank, UPI recorded by staff). Key `receipt:...`; posted as a `payment` against the same source.
//   * spend        - event budget payments made to vendors (a `payment` out of the event's organisation; reversed when the module voids it).
// Everything is keyed, so running it twice, or next to live traffic, posts nothing twice. It never edits an amount and never deletes.
import { many, tx } from './db.js';
import { applyDimensions, insert, setStatus } from './finance.js';

const n = (x) => Number(x ?? 0);

const OBLIGATIONS = [
  {
    type: 'academy_charge', module: 'registration', cumulative: true,
    sql: `SELECT a.id, a.payer_id, NULL::uuid AS payee_id, NULL::uuid AS payer_org, a.organisation_id AS payee_org, a.currency, a.amount_minor AS gross, a.tax_minor AS tax, a.due_on,
            CASE a.status WHEN 'awaiting_payment' THEN 'open' WHEN 'paid' THEN 'settled' WHEN 'refunded' THEN 'settled' ELSE 'cancelled' END AS state,
            NULL::uuid AS event_id, NULL::uuid AS team_id, NULL::uuid AS workspace_id, a.created_at AS at, a.paid_at,
            CASE WHEN a.status IN ('paid','refunded') THEN a.amount_minor ELSE 0 END AS paid_total
          FROM academy_charges a WHERE a.amount_minor > 0`,
  },
  {
    type: 'team_charge', module: 'registration', cumulative: false,
    sql: `SELECT ch.id, ch.payer_id, NULL::uuid AS payee_id, NULL::uuid AS payer_org, t.organisation_id AS payee_org, b.currency, ch.amount_minor - ch.adjusted_minor AS gross, 0::bigint AS tax,
            coalesce(ch.due_on, b.due_on) AS due_on, CASE ch.status WHEN 'awaiting_payment' THEN 'open' WHEN 'paid' THEN 'settled' ELSE 'cancelled' END AS state,
            b.event_id, ch.team_id, NULL::uuid AS workspace_id, ch.created_at AS at, ch.paid_at, 0::bigint AS paid_total
          FROM team_charges ch JOIN team_charge_batches b ON b.id = ch.batch_id JOIN teams t ON t.id = ch.team_id WHERE ch.amount_minor - ch.adjusted_minor > 0`,
  },
  {
    type: 'registration_instalment', module: 'registration', cumulative: true,
    sql: `SELECT i.id, e.submitted_by AS payer_id, NULL::uuid AS payee_id, NULL::uuid AS payer_org, p.organisation_id AS payee_org, i.currency, i.amount_cents AS gross, 0::bigint AS tax, i.due_on,
            CASE i.status WHEN 'unpaid' THEN 'open' WHEN 'paid' THEN 'settled' ELSE 'cancelled' END AS state,
            p.event_id, e.team_id, NULL::uuid AS workspace_id, i.created_at AS at, i.paid_at, CASE WHEN i.status = 'paid' THEN i.amount_cents ELSE 0 END AS paid_total
          FROM rx_instalments i JOIN rx_entries e ON e.id = i.entry_id JOIN rx_programmes p ON p.id = e.programme_id`,
  },
  {
    type: 'service_invoice', module: 'suppliers', cumulative: true,
    sql: `SELECT s.id, b.owner_id AS payer_id, pr.owner_id AS payee_id, b.organisation_id AS payer_org, pr.organisation_id AS payee_org, s.currency, s.gross_minor AS gross, s.tax_minor AS tax, s.due_on,
            CASE WHEN s.status <> 'issued' THEN 'cancelled' WHEN s.pay_status IN ('paid','refunded') THEN 'settled' ELSE 'open' END AS state,
            b.event_id, NULL::uuid AS team_id, NULL::uuid AS workspace_id, coalesce(s.issued_at, s.created_at) AS at, NULL::timestamptz AS paid_at, s.paid_minor AS paid_total
          FROM svc_invoices s JOIN svc_buyers b ON b.id = s.buyer_id JOIN svc_profiles pr ON pr.id = s.profile_id
          WHERE s.doc_type = 'invoice' AND s.status IN ('issued','void','replaced') AND s.gross_minor > 0`,
  },
  {
    type: 'sponsorship_obligation', module: 'sponsorship', cumulative: false,
    sql: `SELECT o.id, sr.owner_id AS payer_id, NULL::uuid AS payee_id, sr.organisation_id AS payer_org,
            CASE sp.target_type WHEN 'event' THEN (SELECT organisation_id FROM events WHERE id = sp.target_id) WHEN 'team' THEN (SELECT organisation_id FROM teams WHERE id = sp.target_id) END AS payee_org,
            o.currency, o.amount_cents AS gross, 0::bigint AS tax, o.due_on,
            CASE WHEN o.status = 'cancelled' THEN 'cancelled'
                 WHEN o.status = 'fulfilled' OR coalesce((SELECT sum(x.amount_cents - x.refunded_cents) FROM sponsorship_payments x WHERE x.obligation_id = o.id AND x.status = 'confirmed'), 0) >= o.amount_cents THEN 'settled'
                 ELSE 'open' END AS state,
            CASE WHEN sp.target_type = 'event' THEN sp.target_id END AS event_id, CASE WHEN sp.target_type = 'team' THEN sp.target_id END AS team_id, sp.department_id AS workspace_id,
            o.created_at AS at, NULL::timestamptz AS paid_at, 0::bigint AS paid_total
          FROM sponsorship_obligations o JOIN sponsorships sp ON sp.id = o.sponsorship_id JOIN sponsors sr ON sr.id = sp.sponsor_id
          WHERE o.kind = 'money' AND o.amount_cents > 0 AND o.currency IS NOT NULL`,
  },
  {
    // what a club owes a player for a payout run (#593): owed once the run is approved, settled when the line is paid; withholding is the tax
    type: 'player_payout_line', module: 'contracts', cumulative: true,
    sql: `SELECT l.id, NULL::uuid AS payer_id, l.payee_id, coalesce(t.organisation_id, e.organisation_id) AS payer_org, NULL::uuid AS payee_org, r.currency, l.gross_cents AS gross, l.withheld_cents AS tax, r.as_of AS due_on,
            CASE WHEN r.status = 'cancelled' THEN 'cancelled' WHEN l.status = 'paid' THEN 'settled' ELSE 'open' END AS state,
            r.event_id, r.team_id, NULL::uuid AS workspace_id, r.created_at AS at, l.paid_at, CASE WHEN l.status = 'paid' THEN l.gross_cents ELSE 0 END AS paid_total
          FROM player_payout_lines l JOIN player_payout_runs r ON r.id = l.run_id LEFT JOIN teams t ON t.id = r.team_id LEFT JOIN events e ON e.id = r.event_id
          WHERE r.status <> 'draft' AND l.gross_cents > 0`,
  },
  {
    // an official's fee the organiser marked due; paid through a payout batch is already a payout row, so only a fee marked paid directly adds a receipt
    type: 'official_fee', module: 'officials', cumulative: true,
    sql: `SELECT fo.id, NULL::uuid AS payer_id, fo.user_id AS payee_id, e.organisation_id AS payer_org, NULL::uuid AS payee_org, fo.fee_currency AS currency, fo.fee_minor AS gross, 0::bigint AS tax, NULL::date AS due_on,
            CASE WHEN fo.status <> 'accepted' THEN 'cancelled' WHEN fo.pay_status = 'paid' THEN 'settled' WHEN fo.pay_status IN ('due','disputed') THEN 'open' ELSE 'cancelled' END AS state,
            fx.event_id, NULL::uuid AS team_id, NULL::uuid AS workspace_id, coalesce(fo.pay_updated_at, now()) AS at, fo.pay_confirmed_at AS paid_at,
            CASE WHEN fo.pay_status = 'paid' AND fo.payout_item_id IS NULL THEN fo.fee_minor ELSE 0 END AS paid_total
          FROM fixture_officials fo JOIN fixtures fx ON fx.id = fo.fixture_id JOIN events e ON e.id = fx.event_id
          WHERE fo.fee_minor > 0 AND fo.fee_currency IS NOT NULL AND e.organisation_id IS NOT NULL`,
  },
  {
    // an approved travel claim the organisation owes a traveller, until it is reimbursed
    type: 'trip_claim', module: 'travel', cumulative: false,
    sql: `SELECT c.id, NULL::uuid AS payer_id, tp.user_id AS payee_id, coalesce(tr.organisation_id, t.organisation_id) AS payer_org, NULL::uuid AS payee_org, c.currency, c.amount_minor AS gross, 0::bigint AS tax, c.incurred_on AS due_on,
            CASE WHEN c.status <> 'approved' THEN 'cancelled' WHEN EXISTS (SELECT 1 FROM trip_payments p WHERE p.claim_id = c.id AND p.voided_at IS NULL) THEN 'settled' ELSE 'open' END AS state,
            (SELECT te.event_id FROM trip_events te WHERE te.trip_id = c.trip_id AND te.unlinked_at IS NULL ORDER BY te.id LIMIT 1) AS event_id, tr.team_id, NULL::uuid AS workspace_id, c.created_at AS at, NULL::timestamptz AS paid_at, 0::bigint AS paid_total
          FROM trip_claims c JOIN trips tr ON tr.id = c.trip_id JOIN trip_participants tp ON tp.id = c.participant_id LEFT JOIN teams t ON t.id = tr.team_id
          WHERE coalesce(tr.organisation_id, t.organisation_id) IS NOT NULL`,
  },
];

const entryOf = (d, r, extra) => ({
  module: d.module, sourceType: d.type, sourceId: r.id, payerId: r.payer_id, payeeId: r.payee_id, payerOrgId: r.payer_org, payeeOrgId: r.payee_org, currency: r.currency,
  eventId: r.event_id, teamId: r.team_id, workspaceId: r.workspace_id, ...extra,
});

/** Obligations: one open charge per owed item, with its due date, following the source's status. */
async function syncObligations(d, limit) {
  const rows = await many(
    `SELECT s.*, f.id AS fin_id FROM (${d.sql}) s LEFT JOIN fin_transactions f ON f.idem_key = 'obl:${d.type}:' || s.id
      WHERE (f.id IS NULL AND s.state <> 'cancelled') OR (f.id IS NOT NULL AND f.status <> s.state) ORDER BY s.at, s.id LIMIT $1`, [limit]);
  let posted = 0, updated = 0;
  for (const r of rows) {
    await tx(async (c) => {
      const key = `obl:${d.type}:${r.id}`;
      if (r.fin_id) { if (await setStatus(c, key, r.state, null, { source: 'sync' })) updated++; return; }
      const id = await insert(c, { ...entryOf(d, r, {}), kind: 'charge', status: r.state, gross: n(r.gross), tax: n(r.tax), net: n(r.gross), dueOn: r.due_on, at: r.at, key, meta: { origin: 'obligation' } });
      if (id) {
        posted++;
        // a checkout that was started for the same source raised its own open charge: this obligation replaces it, so the receivable is counted once
        await c.query("UPDATE fin_transactions SET status='cancelled' WHERE kind='charge' AND status='open' AND source_type=$1 AND source_id=$2 AND idem_key LIKE 'charge:%'", [d.type, r.id]);
      }
    });
  }
  return { posted, updated, more: rows.length >= limit };
}

/** Receipts recorded outside a provider: the part of what the source says is paid that the ledger does not hold as a payment yet. */
async function syncCumulativeReceipts(d, limit) {
  const rows = await many(
    `SELECT s.*, s.paid_total - coalesce((SELECT sum(p.gross_minor) FROM fin_transactions p WHERE p.kind = 'payment' AND p.status = 'settled' AND p.source_type = '${d.type}' AND p.source_id = s.id), 0) AS delta
       FROM (${d.sql}) s WHERE s.paid_total > 0 AND s.state <> 'cancelled'
        AND s.paid_total > coalesce((SELECT sum(p.gross_minor) FROM fin_transactions p WHERE p.kind = 'payment' AND p.status = 'settled' AND p.source_type = '${d.type}' AND p.source_id = s.id), 0)
      ORDER BY s.at, s.id LIMIT $1`, [limit]);
  let posted = 0;
  for (const r of rows) {
    const delta = n(r.delta), gross = n(r.gross);
    if (await tx((c) => insert(c, { ...entryOf(d, r, {}), kind: 'payment', status: 'settled', gross: delta, tax: gross ? Math.round((n(r.tax) * delta) / gross) : 0, provider: 'offline', dueOn: null,
      at: r.paid_at ?? null, key: `receipt:${d.type}:${r.id}:${n(r.paid_total)}`, meta: { origin: 'receipt', recorded_outside_provider: true } }))) posted++;
  }
  return { posted };
}

/** Team charges keep one `receipt` entry per payment; the ones without a provider payment are cash / bank / UPI taken by a manager. */
async function syncTeamReceipts(limit) {
  const rows = await many(
    `SELECT en.id, en.amount_minor, en.method, en.created_at, ch.id AS charge_id, ch.payer_id, ch.team_id, t.organisation_id AS payee_org, b.currency, b.event_id
       FROM team_charge_entries en JOIN team_charges ch ON ch.id = en.charge_id JOIN team_charge_batches b ON b.id = ch.batch_id JOIN teams t ON t.id = ch.team_id
      WHERE en.kind = 'receipt' AND en.payment_id IS NULL AND en.amount_minor > 0
        AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key = 'receipt:team_charge_entry:' || en.id) ORDER BY en.created_at, en.id LIMIT $1`, [limit]);
  let posted = 0;
  for (const r of rows) {
    if (await tx((c) => insert(c, { kind: 'payment', status: 'settled', module: 'registration', sourceType: 'team_charge', sourceId: r.charge_id, payerId: r.payer_id, payeeOrgId: r.payee_org, currency: r.currency,
      gross: n(r.amount_minor), provider: 'offline', teamId: r.team_id, eventId: r.event_id, at: r.created_at, key: `receipt:team_charge_entry:${r.id}`, meta: { origin: 'receipt', method: r.method, recorded_outside_provider: true } }))) posted++;
  }
  return { posted };
}

/** A sponsor's confirmed payment that did not go through the provider (bank transfer, cash): received by the organisation behind the event or team. */
async function syncSponsorshipReceipts(limit) {
  const rows = await many(
    `SELECT x.id, x.amount_cents, x.method, x.paid_on, x.currency, o.id AS obligation_id, sr.owner_id AS payer_id, sr.organisation_id AS payer_org,
            CASE sp.target_type WHEN 'event' THEN (SELECT organisation_id FROM events WHERE id = sp.target_id) WHEN 'team' THEN (SELECT organisation_id FROM teams WHERE id = sp.target_id) END AS payee_org,
            CASE WHEN sp.target_type = 'event' THEN sp.target_id END AS event_id, CASE WHEN sp.target_type = 'team' THEN sp.target_id END AS team_id, sp.department_id AS workspace_id
       FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id = x.obligation_id JOIN sponsorships sp ON sp.id = o.sponsorship_id JOIN sponsors sr ON sr.id = sp.sponsor_id
      WHERE x.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.source_type = 'sponsorship_payment' AND f.source_id = x.id AND f.kind = 'payment')
        AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key = 'receipt:sponsorship_payment:' || x.id) ORDER BY x.paid_on, x.id LIMIT $1`, [limit]);
  let posted = 0;
  for (const r of rows) {
    if (await tx((c) => insert(c, { kind: 'payment', status: 'settled', module: 'sponsorship', sourceType: 'sponsorship_obligation', sourceId: r.obligation_id, payerId: r.payer_id, payerOrgId: r.payer_org,
      payeeOrgId: r.payee_org, currency: r.currency, gross: n(r.amount_cents), provider: 'offline', eventId: r.event_id, teamId: r.team_id, workspaceId: r.workspace_id, at: r.paid_on,
      key: `receipt:sponsorship_payment:${r.id}`, meta: { origin: 'receipt', method: r.method, sponsorship_payment_id: r.id, recorded_outside_provider: true } }))) posted++;
  }
  return { posted };
}

/** Event budget payments: money the organisation paid to vendors. A payment the module later voids is reversed on the ledger, not removed. */
async function syncEventSpend(limit) {
  const rows = await many(
    `SELECT bp.id, bp.event_id, bp.amount_cents, bp.paid_on, bp.method, bp.reference, bp.voided_at, e.organisation_id AS org, b.currency, f.id AS fin_id, f.status AS fin_status
       FROM event_budget_payments bp JOIN events e ON e.id = bp.event_id JOIN event_budgets b ON b.event_id = bp.event_id LEFT JOIN fin_transactions f ON f.idem_key = 'ebp:' || bp.id
      WHERE e.organisation_id IS NOT NULL AND ((f.id IS NULL AND bp.voided_at IS NULL) OR (f.id IS NOT NULL AND bp.voided_at IS NOT NULL AND f.status <> 'reversed'))
      ORDER BY bp.created_at, bp.id LIMIT $1`, [limit]);
  let posted = 0, reversed = 0;
  for (const r of rows) {
    await tx(async (c) => {
      if (r.fin_id) { if (await setStatus(c, `ebp:${r.id}`, 'reversed', null, { source: 'sync', voided_at: r.voided_at })) reversed++; return; }
      if (await insert(c, { kind: 'payment', status: 'settled', module: 'events', sourceType: 'event_budget_payment', sourceId: r.id, payerOrgId: r.org, currency: r.currency, gross: n(r.amount_cents),
        provider: r.method ?? 'offline', providerRef: r.reference ?? null, eventId: r.event_id, at: r.paid_on, key: `ebp:${r.id}`, meta: { origin: 'event_budget' } })) posted++;
    });
  }
  return { posted, reversed };
}

/** Agent commission: one open charge per issued statement (athlete pays agent). Settled payments are not tied to a statement, so they are allocated oldest statement first, the same way every time. */
async function syncCommissions(limit) {
  const stmts = await many(
    `SELECT st.id, st.deal_id, st.amount_cents, st.due_on, st.status, st.issued_at, st.currency, m.athlete_id AS payer_id, ap.user_id AS payee_id, ap.organisation_id AS payee_org,
            coalesce(pc.team_id, CASE WHEN sp.target_type = 'team' THEN sp.target_id END) AS team_id, coalesce(pc.event_id, CASE WHEN sp.target_type = 'event' THEN sp.target_id END) AS event_id, sp.department_id AS workspace_id
       FROM representation_statements st JOIN representation_deals d ON d.id = st.deal_id JOIN representation_mandates m ON m.id = d.mandate_id JOIN agent_profiles ap ON ap.id = m.agent_id
       LEFT JOIN player_contracts pc ON d.deal_type = 'player_contract' AND pc.id = d.deal_id LEFT JOIN sponsorships sp ON d.deal_type = 'sponsorship' AND sp.id = d.deal_id
      ORDER BY st.deal_id, st.issued_at, st.id LIMIT $1`, [limit * 4]);
  const entries = await many("SELECT id, deal_id, kind, amount_cents, created_at FROM representation_commission_entries WHERE kind IN ('payment_settled','refund') ORDER BY deal_id, seq");
  const byDeal = new Map();
  for (const st of stmts) { if (!byDeal.has(st.deal_id)) byDeal.set(st.deal_id, []); byDeal.get(st.deal_id).push({ ...st, left: n(st.amount_cents) }); }
  let posted = 0, receipts = 0;
  for (const [dealId, list] of byDeal) {
    const live = list.filter((x) => x.status === 'issued');
    const allocations = [];
    for (const en of entries.filter((e) => e.deal_id === dealId && e.kind === 'payment_settled')) {
      let a = n(en.amount_cents);
      for (const st of live) { if (a <= 0) break; const take = Math.min(a, st.left); if (take > 0) { allocations.push({ en, st, take }); st.left -= take; a -= take; } }
    }
    for (const st of list) {
      const state = st.status === 'void' ? 'cancelled' : st.left <= 0 ? 'settled' : 'open';
      const key = `obl:representation_statement:${st.id}`;
      await tx(async (c) => {
        const have = (await c.query('SELECT status FROM fin_transactions WHERE idem_key=$1', [key])).rows[0];
        if (have) { if (have.status !== state) await setStatus(c, key, state, null, { source: 'sync' }); return; }
        if (state === 'cancelled') return;
        if (await insert(c, { module: 'agents', kind: 'charge', status: state, sourceType: 'representation_statement', sourceId: st.id, payerId: st.payer_id, payeeId: st.payee_id, payeeOrgId: st.payee_org, currency: st.currency,
          gross: n(st.amount_cents), net: n(st.amount_cents), dueOn: st.due_on, at: st.issued_at, eventId: st.event_id, teamId: st.team_id, workspaceId: st.workspace_id, key, meta: { origin: 'obligation', deal_id: dealId } })) posted++;
      });
    }
    for (const al of allocations) {
      if (await tx((c) => insert(c, { module: 'agents', kind: 'payment', status: 'settled', sourceType: 'representation_statement', sourceId: al.st.id, payerId: al.st.payer_id, payeeId: al.st.payee_id, payeeOrgId: al.st.payee_org, currency: al.st.currency,
        gross: al.take, provider: 'offline', at: al.en.created_at, eventId: al.st.event_id, teamId: al.st.team_id, workspaceId: al.st.workspace_id, key: `receipt:representation_commission_entry:${al.en.id}:${al.st.id}`, meta: { origin: 'receipt', recorded_outside_provider: true } }))) receipts++;
    }
  }
  // a refund of commission already settled
  for (const en of entries.filter((e) => e.kind === 'refund')) {
    const any = list0(byDeal, en.deal_id);
    if (!any) continue;
    if (await tx((c) => insert(c, { module: 'agents', kind: 'refund', status: 'settled', sourceType: 'representation_deal', sourceId: en.deal_id, payerId: any.payee_id, payeeId: any.payer_id, payerOrgId: any.payee_org, currency: any.currency,
      gross: Math.abs(n(en.amount_cents)), provider: 'offline', at: en.created_at, key: `refund:representation_commission_entry:${en.id}`, meta: { origin: 'refund' } }))) receipts++;
  }
  return { posted, receipts };
}
const list0 = (byDeal, dealId) => byDeal.get(dealId)?.[0] ?? null;

/** Cash, card-terminal, UPI and bank tenders taken at the front desk (online tenders are already on the ledger through payments), and the refunds paid back from the till. */
async function syncPosTenders(limit) {
  const rows = await many(
    `SELECT pp.id, pp.kind, pp.method, pp.amount_cents, coalesce(pp.confirmed_at, pp.created_at) AS at, s.id AS sale_id, s.currency, s.customer_id AS payer_id, v.owner_id AS payee_id, v.organisation_id AS payee_org, s.tax_cents, s.total_cents
       FROM pos_sale_payments pp JOIN pos_sales s ON s.id = pp.sale_id JOIN venues v ON v.id = s.venue_id
      WHERE pp.status = 'confirmed' AND pp.method <> 'online' AND pp.payment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key IN ('receipt:pos_sale_payment:' || pp.id, 'refund:pos_sale_payment:' || pp.id)) ORDER BY pp.created_at, pp.id LIMIT $1`, [limit]);
  let posted = 0;
  for (const r of rows) {
    const tax = n(r.total_cents) ? Math.round((n(r.tax_cents) * n(r.amount_cents)) / n(r.total_cents)) : 0;
    const refund = r.kind === 'refund';
    if (await tx((c) => insert(c, { module: 'venue', kind: refund ? 'refund' : 'payment', status: 'settled', sourceType: 'pos_sale', sourceId: r.sale_id, payerId: r.payer_id, payeeId: r.payee_id, payeeOrgId: r.payee_org, currency: r.currency,
      gross: n(r.amount_cents), tax, provider: r.method, at: r.at, key: `${refund ? 'refund' : 'receipt'}:pos_sale_payment:${r.id}`, meta: { origin: refund ? 'refund' : 'receipt', method: r.method, recorded_outside_provider: true } }))) posted++;
  }
  return { posted };
}

/** A venue invoice paid (partly or fully) from the customer's wallet: a tender with no provider payment behind it. Points and passes are not money and stay out. */
async function syncWalletTenders(limit) {
  const rows = await many(
    `SELECT ic.id, ic.user_id, ic.amount_cents, ic.returned_cents, ic.created_at AS at, i.id AS invoice_id, i.currency, i.tax_cents, i.total_cents, v.owner_id AS payee_id, v.organisation_id AS payee_org,
            coalesce((SELECT sum(f.gross_minor) FROM fin_transactions f WHERE f.kind = 'refund' AND f.meta ->> 'invoice_credit_id' = ic.id::text), 0) AS refunded,
            EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key = 'receipt:invoice_credit:' || ic.id) AS posted
       FROM invoice_credits ic JOIN invoices i ON i.id = ic.invoice_id JOIN venues v ON v.id = i.venue_id
      WHERE ic.source = 'wallet' AND (NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key = 'receipt:invoice_credit:' || ic.id)
         OR ic.returned_cents > coalesce((SELECT sum(f.gross_minor) FROM fin_transactions f WHERE f.kind = 'refund' AND f.meta ->> 'invoice_credit_id' = ic.id::text), 0)) ORDER BY ic.created_at, ic.id LIMIT $1`, [limit]);
  let posted = 0;
  for (const r of rows) {
    const share = (amt) => (n(r.total_cents) ? Math.round((n(r.tax_cents) * amt) / n(r.total_cents)) : 0);
    await tx(async (c) => {
      const base = { module: 'wallet', status: 'settled', sourceType: 'venue_invoice', sourceId: r.invoice_id, payerId: r.user_id, payeeId: r.payee_id, payeeOrgId: r.payee_org, currency: r.currency, provider: 'wallet', at: r.at };
      if (!r.posted && (await insert(c, { ...base, kind: 'payment', gross: n(r.amount_cents), tax: share(n(r.amount_cents)), key: `receipt:invoice_credit:${r.id}`, meta: { origin: 'receipt', invoice_credit_id: r.id } }))) posted++;
      const back = n(r.returned_cents) - n(r.refunded);
      if (back > 0 && (await insert(c, { ...base, kind: 'refund', gross: back, tax: share(back), at: null, key: `refund:invoice_credit:${r.id}:${n(r.returned_cents)}`, meta: { origin: 'refund', invoice_credit_id: r.id } }))) posted++;
    });
  }
  return { posted };
}

/** A supplier credit note reduces what the buyer owes on the invoice it adjusts: a canonical credit_note against the same source, so the outstanding amount nets it. */
async function syncCreditNotes(limit) {
  const rows = await many(
    `SELECT cn.id, cn.parent_id, cn.gross_minor, cn.tax_minor, cn.currency, coalesce(cn.issued_at, cn.created_at) AS at, o.payer_id, o.payee_id, o.payer_org_id, o.payee_org_id, o.event_id
       FROM svc_invoices cn JOIN fin_transactions o ON o.idem_key = 'obl:service_invoice:' || cn.parent_id
      WHERE cn.doc_type = 'credit_note' AND cn.status = 'issued' AND cn.gross_minor > 0
        AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key = 'crn:service_invoice:' || cn.id) ORDER BY cn.created_at, cn.id LIMIT $1`, [limit]);
  let posted = 0;
  for (const r of rows) {
    if (await tx((c) => insert(c, { module: 'suppliers', kind: 'credit_note', status: 'settled', sourceType: 'service_invoice', sourceId: r.parent_id, payerId: r.payer_id, payeeId: r.payee_id, payerOrgId: r.payer_org_id, payeeOrgId: r.payee_org_id,
      currency: r.currency, gross: n(r.gross_minor), tax: n(r.tax_minor), eventId: r.event_id, at: r.at, key: `crn:service_invoice:${r.id}`, meta: { origin: 'credit_note', credit_note_id: r.id } }))) posted++;
  }
  return { posted };
}

/** Travel payments recorded outside the event budget (those already post as event spend): money paid to a traveller, reversed when voided. */
async function syncTripPayments(limit) {
  const rows = await many(
    `SELECT p.id, p.kind, p.claim_id, p.amount_minor, p.currency, p.reference, p.created_at AS at, p.voided_at, tp.user_id AS payee_id, coalesce(tr.organisation_id, t.organisation_id) AS org, tr.team_id,
            (SELECT te.event_id FROM trip_events te WHERE te.trip_id = p.trip_id AND te.unlinked_at IS NULL ORDER BY te.id LIMIT 1) AS event_id, f.id AS fin_id
       FROM trip_payments p JOIN trips tr ON tr.id = p.trip_id JOIN trip_participants tp ON tp.id = p.participant_id LEFT JOIN teams t ON t.id = tr.team_id LEFT JOIN fin_transactions f ON f.idem_key = 'receipt:trip_payment:' || p.id
      WHERE p.source = 'external_record' AND coalesce(tr.organisation_id, t.organisation_id) IS NOT NULL
        AND ((f.id IS NULL AND p.voided_at IS NULL) OR (f.id IS NOT NULL AND p.voided_at IS NOT NULL AND f.status <> 'reversed')) ORDER BY p.created_at, p.id LIMIT $1`, [limit]);
  let posted = 0, reversed = 0;
  for (const r of rows) {
    await tx(async (c) => {
      const key = `receipt:trip_payment:${r.id}`;
      if (r.fin_id) { if (await setStatus(c, key, 'reversed', null, { source: 'sync', voided_at: r.voided_at })) reversed++; return; }
      if (await insert(c, { module: 'travel', kind: 'payment', status: 'settled', sourceType: r.claim_id ? 'trip_claim' : 'trip_payment', sourceId: r.claim_id ?? r.id, payeeId: r.payee_id, payerOrgId: r.org, currency: r.currency, gross: n(r.amount_minor),
        provider: 'offline', providerRef: r.reference ?? null, eventId: r.event_id, teamId: r.team_id, at: r.at, key, meta: { origin: 'receipt', trip_payment_kind: r.kind, recorded_outside_provider: true } })) posted++;
    });
  }
  return { posted, reversed };
}

/** Offline sponsorship money given back to the sponsor: the refunded part of a confirmed payment recorded outside the provider (online refunds are posted from payments). */
async function syncSponsorshipRefunds(limit) {
  const rows = await many(
    `SELECT x.id, x.obligation_id, x.refunded_cents, x.currency, x.decided_at AS at, o.id AS ob_id, f0.payer_id, f0.payee_id, f0.payer_org_id, f0.payee_org_id, f0.event_id, f0.team_id, f0.workspace_id,
            coalesce((SELECT sum(f.gross_minor) FROM fin_transactions f WHERE f.kind = 'refund' AND f.meta ->> 'sponsorship_payment_id' = x.id::text), 0) AS refunded
       FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id = x.obligation_id JOIN fin_transactions f0 ON f0.idem_key = 'receipt:sponsorship_payment:' || x.id
      WHERE x.refunded_cents > coalesce((SELECT sum(f.gross_minor) FROM fin_transactions f WHERE f.kind = 'refund' AND f.meta ->> 'sponsorship_payment_id' = x.id::text), 0) LIMIT $1`, [limit]);
  let posted = 0;
  for (const r of rows) {
    const delta = n(r.refunded_cents) - n(r.refunded);
    if (await tx((c) => insert(c, { module: 'sponsorship', kind: 'refund', status: 'settled', sourceType: 'sponsorship_obligation', sourceId: r.obligation_id, payerId: r.payee_id, payeeId: r.payer_id, payerOrgId: r.payee_org_id, payeeOrgId: r.payer_org_id,
      currency: r.currency, gross: delta, provider: 'offline', eventId: r.event_id, teamId: r.team_id, workspaceId: r.workspace_id, at: r.at, key: `refund:sponsorship_payment:${r.id}:${n(r.refunded_cents)}`, meta: { origin: 'refund', sponsorship_payment_id: r.id } }))) posted++;
  }
  return { posted };
}

/** Catch the canonical ledger up with every source above and fill the filter dimensions. Idempotent; called by reconcileFinance (worker step `finance`). */
export async function syncLedger({ limit = 500 } = {}) {
  const out = { obligations: 0, obligations_updated: 0, receipts: 0, spend: 0, spend_reversed: 0, more: false, commissions: 0, pos: 0, wallet: 0, credit_notes: 0, trip_payments: 0, sponsorship_refunds: 0 };
  for (const d of OBLIGATIONS) {
    const o = await syncObligations(d, limit);
    out.obligations += o.posted; out.obligations_updated += o.updated; out.more ||= o.more;
    if (d.cumulative) out.receipts += (await syncCumulativeReceipts(d, limit)).posted;
  }
  out.receipts += (await syncTeamReceipts(limit)).posted;
  out.receipts += (await syncSponsorshipReceipts(limit)).posted;
  const s = await syncEventSpend(limit);
  out.spend = s.posted; out.spend_reversed = s.reversed;
  const parts = [['commissions', syncCommissions], ['pos', syncPosTenders], ['wallet', syncWalletTenders], ['credit_notes', syncCreditNotes], ['trip_payments', syncTripPayments], ['sponsorship_refunds', syncSponsorshipRefunds]];
  for (const [name, fn] of parts) { const r = await fn(limit); out[name] = (r.posted ?? 0) + (r.receipts ?? 0); }
  await applyDimensions(null, null);
  return out;
}
