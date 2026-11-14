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
    sql: `SELECT l.id, NULL::uuid AS payer_id, l.payee_id, coalesce(t.organisation_id, e.organisation_id) AS payer_org, NULL::uuid AS payee_org, r.currency, l.gross_cents AS gross, 0::bigint AS tax, l.withheld_cents AS withheld, r.as_of AS due_on,
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
  {
    // an approved player expense the club has not yet paid out. Once it sits on a live payout line that line's obligation carries it, so this one steps aside
    // (cancelled) and comes back if the run is cancelled or the line fails.
    type: 'player_contract_expense', module: 'contracts', cumulative: false,
    sql: `SELECT x.id, NULL::uuid AS payer_id, x.payee_id, coalesce(t.organisation_id, e.organisation_id) AS payer_org, NULL::uuid AS payee_org, x.currency, x.amount_cents AS gross, 0::bigint AS tax,
            (coalesce(x.decided_at, x.created_at)::date + coalesce((SELECT v.pay_terms_days FROM player_contract_versions v WHERE v.contract_id = c.id ORDER BY v.version DESC LIMIT 1), 7)) AS due_on,
            CASE WHEN x.status = 'approved' AND (x.run_line_id IS NULL OR r.status IN ('draft','cancelled') OR l.status = 'failed') THEN 'open' ELSE 'cancelled' END AS state,
            c.event_id, c.team_id, NULL::uuid AS workspace_id, coalesce(x.decided_at, x.created_at) AS at, NULL::timestamptz AS paid_at, 0::bigint AS paid_total
          FROM player_contract_expenses x JOIN player_contracts c ON c.id = x.contract_id LEFT JOIN teams t ON t.id = c.team_id LEFT JOIN events e ON e.id = c.event_id
          LEFT JOIN player_payout_lines l ON l.id = x.run_line_id LEFT JOIN player_payout_runs r ON r.id = l.run_id
          WHERE coalesce(t.organisation_id, e.organisation_id) IS NOT NULL`,
  },
  {
    type: 'physio_package', module: 'physio', cumulative: false,
    sql: `SELECT p.id, NULL::uuid AS payer_id, p.physio_id AS payee_id, p.organisation_id AS payer_org, NULL::uuid AS payee_org, p.currency,
            p.price_cents AS gross, 0::bigint AS tax,
            p.created_at::date AS due_on,
            CASE WHEN p.status = 'active' THEN 'open' ELSE 'cancelled' END AS state,
            NULL::uuid AS event_id, NULL::uuid AS team_id, NULL::uuid AS workspace_id, p.created_at AS at, NULL::timestamptz AS paid_at, 0::bigint AS paid_total
          FROM physio_packages p WHERE p.price_cents > 0`,
  },
  {
    type: 'physio_appointment', module: 'physio', cumulative: true,
    sql: `SELECT a.id, a.client_id AS payer_id, a.physio_id AS payee_id, a.organisation_id AS payer_org, NULL::uuid AS payee_org, a.currency,
            a.amount_cents AS gross, 0::bigint AS tax,
            a.scheduled_at::date AS due_on,
            CASE WHEN a.status IN ('completed','confirmed') THEN 'open' WHEN a.status = 'cancelled' THEN 'cancelled' ELSE 'open' END AS state,
            NULL::uuid AS event_id, NULL::uuid AS team_id, NULL::uuid AS workspace_id, a.created_at AS at, a.paid_at, coalesce(a.amount_cents,0) AS paid_total
          FROM physio_appointments a WHERE a.amount_cents > 0`,
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
      const id = await insert(c, { ...entryOf(d, r, {}), kind: 'charge', status: r.state, gross: n(r.gross), tax: n(r.tax), withheld: n(r.withheld), net: n(r.gross), dueOn: r.due_on, at: r.at, key, meta: { origin: 'obligation' } });
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
    if (await tx((c) => insert(c, { ...entryOf(d, r, {}), kind: 'payment', status: 'settled', gross: delta, tax: gross ? Math.round((n(r.tax) * delta) / gross) : 0, withheld: gross ? Math.round((n(r.withheld) * delta) / gross) : 0, provider: 'offline', dueOn: null,
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

// A booking invoice a venue raised (not one that belongs to an academy, a team, a supplier order or a front-desk sale: those have their own owner above).
const PLAIN_VENUE_INVOICE = `i.kind = 'invoice' AND i.venue_id IS NOT NULL AND i.reservation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pos_sale_invoices psi WHERE psi.invoice_id = i.id)`;
const INVOICE_STATE = "CASE i.status WHEN 'open' THEN 'open' WHEN 'paid' THEN 'settled' ELSE 'cancelled' END";

/**
 * Venue invoices as obligations: an open invoice is a receivable of the venue's organisation (payer = the bill-to, none for a walk-in), settled when paid, cancelled when void.
 * An open invoice that is edited in place (the booking changed) has its charge cancelled and re-posted at the new amount under `:r<revision>`: a posted amount never changes,
 * and only one charge is ever open for the invoice. Points and pass credits settle it but are not money, so they never become a receipt.
 */
async function syncVenueInvoices(limit) {
  const rows = await many(
    `SELECT i.id, i.revision, i.total_cents, i.tax_cents, i.currency, i.status, i.issued_at, i.due_on, i.walk_in, i.user_id, v.owner_id AS payee_id, v.organisation_id AS payee_org, ${INVOICE_STATE} AS state,
            cur.idem_key AS cur_key, cur.status AS cur_status, cur.gross_minor AS cur_gross
       FROM invoices i JOIN venues v ON v.id = i.venue_id
       LEFT JOIN LATERAL (SELECT f.idem_key, f.status, f.gross_minor FROM fin_transactions f WHERE f.kind = 'charge' AND f.source_type = 'venue_invoice' AND f.source_id = i.id AND f.idem_key LIKE 'obl:%' ORDER BY f.created_at DESC, f.id DESC LIMIT 1) cur ON true
      WHERE ${PLAIN_VENUE_INVOICE} AND i.total_cents > 0
        AND ((cur.idem_key IS NULL AND i.status <> 'void') OR (cur.idem_key IS NOT NULL AND (cur.status <> ${INVOICE_STATE} OR (i.status = 'open' AND cur.gross_minor <> i.total_cents))))
      ORDER BY i.issued_at, i.id LIMIT $1`, [limit]);
  let posted = 0, updated = 0, revised = 0;
  for (const r of rows) {
    await tx(async (c) => {
      const post = async (key, meta) => {
        const id = await insert(c, { module: 'venue', kind: 'charge', status: r.state, sourceType: 'venue_invoice', sourceId: r.id, payerId: r.walk_in ? null : r.user_id, payeeId: r.payee_id, payeeOrgId: r.payee_org, currency: r.currency,
          gross: n(r.total_cents), tax: n(r.tax_cents), net: n(r.total_cents), dueOn: r.due_on, at: r.issued_at, key, meta: { origin: 'obligation', revision: r.revision, ...meta } });
        if (id) await c.query("UPDATE fin_transactions SET status='cancelled' WHERE kind='charge' AND status='open' AND source_type='venue_invoice' AND source_id=$1 AND idem_key LIKE 'charge:%'", [r.id]);   // a checkout charge for the same invoice is replaced
        return id;
      };
      if (!r.cur_key) { if (r.state !== 'cancelled' && (await post(`obl:venue_invoice:${r.id}`))) posted++; return; }
      if (r.status === 'open' && n(r.cur_gross) !== n(r.total_cents)) {
        await setStatus(c, r.cur_key, 'cancelled', null, { source: 'sync', reason: 'invoice revised' });
        if (await post(`obl:venue_invoice:${r.id}:r${r.revision}`, { supersedes: r.cur_key })) revised++;
        return;
      }
      if (await setStatus(c, r.cur_key, r.state, null, { source: 'sync' })) updated++;
    });
  }
  return { posted: posted + revised, updated };
}

// Receipts for a venue invoice paid at the venue (cash, card, UPI, bank, other): what the invoice says is paid, less points/pass credits (not money), less the payments the ledger already holds.
const VENUE_INVOICE_RECEIPTS = {
  type: 'venue_invoice', module: 'venue',
  sql: `SELECT i.id, CASE WHEN i.walk_in THEN NULL ELSE i.user_id END AS payer_id, v.owner_id AS payee_id, NULL::uuid AS payer_org, v.organisation_id AS payee_org, i.currency, i.total_cents AS gross, i.tax_cents AS tax, i.due_on,
          CASE i.status WHEN 'paid' THEN 'settled' ELSE 'cancelled' END AS state, NULL::uuid AS event_id, NULL::uuid AS team_id, NULL::uuid AS workspace_id, i.issued_at AS at, i.paid_at,
          i.total_cents - coalesce((SELECT sum(ic.amount_cents - ic.returned_cents) FROM invoice_credits ic WHERE ic.invoice_id = i.id AND ic.source IN ('points','pass')), 0) AS paid_total
        FROM invoices i JOIN venues v ON v.id = i.venue_id WHERE ${PLAIN_VENUE_INVOICE} AND i.status = 'paid' AND coalesce(i.payment_method, '') NOT IN ('online', 'points', 'pass')`,
};

/** A credit note whose money went back by hand (cash, bank): the part that did not go to the customer's wallet, for a booking nobody paid online. Provider refunds are posted from payments. */
async function syncVenueCreditNotes(limit) {
  const rows = await many(
    `SELECT cn.id, cn.parent_id, cn.currency, cn.total_cents, cn.tax_cents, cn.refund_to_credits_cents, coalesce(cn.refunded_at, cn.paid_at) AS at, cn.walk_in, cn.user_id, v.owner_id AS payee_id, v.organisation_id AS payee_org
       FROM invoices cn JOIN venues v ON v.id = cn.venue_id
      WHERE cn.kind = 'credit_note' AND cn.refund_status = 'done' AND cn.parent_id IS NOT NULL AND cn.total_cents > cn.refund_to_credits_cents
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.status IN ('paid','refunded') AND p.purpose_type = 'venue_invoice' AND p.purpose_id = cn.parent_id)
        AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.idem_key = 'refund:venue_credit_note:' || cn.id) ORDER BY cn.paid_at, cn.id LIMIT $1`, [limit]);
  let posted = 0;
  for (const r of rows) {
    const amount = n(r.total_cents) - n(r.refund_to_credits_cents);
    const tax = n(r.total_cents) ? Math.round((n(r.tax_cents) * amount) / n(r.total_cents)) : 0;
    if (await tx((c) => insert(c, { module: 'venue', kind: 'refund', status: 'settled', sourceType: 'venue_invoice', sourceId: r.parent_id, payerId: r.walk_in ? null : r.user_id, payeeId: r.payee_id, payeeOrgId: r.payee_org, currency: r.currency,
      gross: amount, tax, provider: 'offline', at: r.at, key: `refund:venue_credit_note:${r.id}`, meta: { origin: 'refund', credit_note_id: r.id, recorded_outside_provider: true } }))) posted++;
  }
  return { posted };
}

/**
 * A credit note on a player contract means the player now owes the club that amount. It is a receivable of the club's organisation that ages, and it settles two ways:
 * the player repays it (a `refund` entry on the contract: real money, posted as a payment) or a later payout is reduced by it (netting: a credit_note row, not income).
 * What is still owed is the contract balance (all entries); what has been cleared is the credit notes' total less that, applied oldest note first, cash repayments first.
 */
async function syncContractCreditNotes(limit) {
  const notes = await many(
    `SELECT n.id, n.contract_id, n.payee_id, n.currency, abs(n.gross_cents) AS amount, n.issued_at, coalesce(t.organisation_id, e.organisation_id) AS club_org, c.event_id, c.team_id,
            (n.issued_at::date + coalesce((SELECT v.pay_terms_days FROM player_contract_versions v WHERE v.contract_id = c.id ORDER BY v.version DESC LIMIT 1), 7)) AS due_on
       FROM player_contract_invoices n JOIN player_contracts c ON c.id = n.contract_id LEFT JOIN teams t ON t.id = c.team_id LEFT JOIN events e ON e.id = c.event_id
      WHERE n.kind = 'credit_note' AND n.gross_cents < 0 AND coalesce(t.organisation_id, e.organisation_id) IS NOT NULL ORDER BY n.contract_id, n.issued_at, n.id LIMIT $1`, [limit * 4]);
  if (!notes.length) return { posted: 0 };
  const ids = [...new Set(notes.map((x) => x.contract_id))];
  const bal = new Map((await many("SELECT contract_id, sum(amount_cents)::bigint AS balance, coalesce(sum(amount_cents) FILTER (WHERE kind = 'refund'), 0)::bigint AS repaid FROM player_contract_entries WHERE contract_id = ANY($1) GROUP BY contract_id", [ids])).map((r) => [r.contract_id, r]));
  const byContract = new Map();
  for (const x of notes) { if (!byContract.has(x.contract_id)) byContract.set(x.contract_id, []); byContract.get(x.contract_id).push(x); }
  let posted = 0;
  for (const [contractId, list] of byContract) {
    const total = list.reduce((t, x) => t + n(x.amount), 0);
    const b = bal.get(contractId) ?? { balance: 0, repaid: 0 };
    const owes = Math.max(0, -n(b.balance));
    let cleared = Math.max(0, total - owes), cashLeft = Math.min(n(b.repaid), cleared);
    for (const x of list) {
      const take = Math.min(cleared, n(x.amount)); cleared -= take;
      const cash = Math.min(cashLeft, take); cashLeft -= cash;
      const net = take - cash;
      const state = take >= n(x.amount) ? 'settled' : 'open';
      const src = { module: 'contracts', sourceType: 'player_contract_credit_note', sourceId: x.id, payerId: x.payee_id, payeeOrgId: x.club_org, currency: x.currency, eventId: x.event_id, teamId: x.team_id };
      await tx(async (c) => {
        const key = `obl:player_contract_credit_note:${x.id}`;
        const have = (await c.query('SELECT status FROM fin_transactions WHERE idem_key=$1', [key])).rows[0];
        if (!have) { if (await insert(c, { ...src, kind: 'charge', status: state, gross: n(x.amount), net: n(x.amount), dueOn: x.due_on, at: x.issued_at, key, meta: { origin: 'obligation', contract_id: contractId } })) posted++; }
        else if (have.status !== state) await setStatus(c, key, state, null, { source: 'sync' });
        const sum = async (kind) => n((await c.query("SELECT coalesce(sum(gross_minor),0)::bigint AS s FROM fin_transactions WHERE kind=$1 AND status='settled' AND source_type='player_contract_credit_note' AND source_id=$2", [kind, x.id])).rows[0].s);
        const cashDelta = cash - (await sum('payment')), netDelta = net - (await sum('credit_note'));
        if (cashDelta > 0 && (await insert(c, { ...src, kind: 'payment', status: 'settled', gross: cashDelta, provider: 'offline', key: `receipt:player_contract_credit_note:${x.id}:${cash}`, meta: { origin: 'receipt', recorded_outside_provider: true } }))) posted++;
        if (netDelta > 0 && (await insert(c, { ...src, kind: 'credit_note', status: 'settled', gross: netDelta, key: `crn:player_contract_credit_note:${x.id}:${net}`, meta: { origin: 'netting' } }))) posted++;
      });
    }
  }
  return { posted };
}

/**
 * Idempotently writes fin_role_links rows that connect ledger entries back to their
 * role-domain entity (coach, referee, academy, organisation, sponsor, physio).
 * Called at the end of syncLedger so any new transactions from this cycle are covered.
 */
async function syncCrossRoleLinks() {
  const queries = [
    // Coach: coach_sessions fee_transactions → coaching module transactions
    `INSERT INTO fin_role_links (transaction_id, role, entity_id, entity_type)
      SELECT f.id, 'coach', cs.coach_id, 'coach_profile'
      FROM fin_transactions f
      JOIN coach_sessions cs ON cs.id = f.source_id AND f.source_type = 'coach_session'
      WHERE NOT EXISTS (SELECT 1 FROM fin_role_links l WHERE l.transaction_id = f.id AND l.role = 'coach' AND l.entity_id = cs.coach_id)`,
    // Referee: official_assignments → referee_profiles
    `INSERT INTO fin_role_links (transaction_id, role, entity_id, entity_type)
      SELECT f.id, 'referee', oa.official_id, 'referee_profile'
      FROM fin_transactions f
      JOIN official_assignments oa ON oa.id = f.source_id AND f.source_type IN ('official_fee','referee_fee')
      WHERE NOT EXISTS (SELECT 1 FROM fin_role_links l WHERE l.transaction_id = f.id AND l.role = 'referee' AND l.entity_id = oa.official_id)`,
    // Academy: academy_enrolments obligation → organisation (academy kind)
    `INSERT INTO fin_role_links (transaction_id, role, entity_id, entity_type)
      SELECT f.id, 'academy', f.payer_org_id, 'organisation'
      FROM fin_transactions f
      WHERE f.source_type IN ('academy_enrolment','academy_package','academy_subscription')
        AND f.payer_org_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_role_links l WHERE l.transaction_id = f.id AND l.role = 'academy')`,
    // Organisation: venue_invoice → organisations
    `INSERT INTO fin_role_links (transaction_id, role, entity_id, entity_type)
      SELECT f.id, 'organisation', coalesce(f.payer_org_id, f.payee_org_id), 'organisation'
      FROM fin_transactions f
      WHERE f.source_type = 'venue_invoice'
        AND coalesce(f.payer_org_id, f.payee_org_id) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin_role_links l WHERE l.transaction_id = f.id AND l.role = 'organisation')`,
    // Sponsor: sponsorship_deal_term → sponsor entity
    `INSERT INTO fin_role_links (transaction_id, role, entity_id, entity_type)
      SELECT f.id, 'sponsor', sd.id, 'sponsor_deal'
      FROM fin_transactions f
      JOIN sponsorship_deal_terms sdt ON sdt.id = f.source_id AND f.source_type = 'sponsorship_deal_term'
      JOIN sponsorship_deals sd ON sd.id = sdt.deal_id
      WHERE NOT EXISTS (SELECT 1 FROM fin_role_links l WHERE l.transaction_id = f.id AND l.role = 'sponsor' AND l.entity_id = sd.id)`,
    // Physio: physio_appointment → physio entity
    `INSERT INTO fin_role_links (transaction_id, role, entity_id, entity_type)
      SELECT f.id, 'physio', a.physio_id, 'physio_profile'
      FROM fin_transactions f
      JOIN physio_appointments a ON a.id = f.source_id AND f.source_type = 'physio_appointment'
      WHERE NOT EXISTS (SELECT 1 FROM fin_role_links l WHERE l.transaction_id = f.id AND l.role = 'physio' AND l.entity_id = a.physio_id)`,
  ];
  let linked = 0;
  for (const q of queries) {
    const r = await many(q, []);
    linked += r.length;
  }
  return { linked };
}

/** Sync confirmed offline receipts that haven't yet reached the ledger. */
async function syncOfflineReceipts(limit = 500) {
  const rows = await many(
    `SELECT r.*, r.organisation_id, r.customer_id, r.currency, r.amount, r.method, r.confirmed_at
       FROM fin_offline_receipts r WHERE r.status = 'confirmed' AND r.tx_id IS NULL LIMIT $1`,
    [limit]
  );
  let posted = 0;
  for (const r of rows) {
    await tx(async (client) => {
      const txId = await insert(client, {
        kind: 'payment', status: 'settled', module: 'other',
        sourceType: 'offline_receipt', sourceId: r.id,
        payeeOrgId: r.organisation_id, payerId: r.customer_id ?? null,
        currency: r.currency, gross: Math.round(Number(r.amount) * 100),
        provider: r.method, key: `offline_receipt:${r.id}`, at: r.confirmed_at,
      });
      if (txId) await client.query('UPDATE fin_offline_receipts SET tx_id=$2 WHERE id=$1', [r.id, txId]);
    });
    posted++;
  }
  return { posted };
}

/** Mark overdue instalment items and post paid items missing ledger entries. */
async function syncInstalments(limit = 500) {
  await many(`UPDATE fin_instalment_items SET status='overdue' WHERE status='pending' AND due_date < CURRENT_DATE`, []);
  const rows = await many(
    `SELECT ii.*, s.organisation_id, s.currency FROM fin_instalment_items ii
       JOIN fin_instalments s ON s.id = ii.instalment_id
       WHERE ii.status = 'paid' AND ii.tx_id IS NULL LIMIT $1`,
    [limit]
  );
  let posted = 0;
  for (const r of rows) {
    await tx(async (client) => {
      const txId = await insert(client, {
        kind: 'payment', status: 'settled', module: 'other',
        sourceType: 'fin_instalment_item', sourceId: r.id,
        payeeOrgId: r.organisation_id, currency: r.currency,
        gross: Math.round(Number(r.paid_amount ?? r.amount) * 100),
        key: `instalment_item:${r.id}`, at: r.paid_at,
      });
      if (txId) await client.query('UPDATE fin_instalment_items SET tx_id=$2 WHERE id=$1', [r.id, txId]);
    });
    posted++;
  }
  return { posted };
}

/** Sync deposit receipts that have been received but not yet ledgered. */
async function syncDeposits(limit = 500) {
  const rows = await many(
    `SELECT * FROM fin_deposits WHERE status IN ('received','partially_released','released','forfeited')
       AND receipt_tx_id IS NULL AND received_at IS NOT NULL LIMIT $1`,
    [limit]
  );
  let posted = 0;
  for (const r of rows) {
    await tx(async (client) => {
      const txId = await insert(client, {
        kind: 'payment', status: 'settled', module: 'other',
        sourceType: 'fin_deposit', sourceId: r.id,
        payeeOrgId: r.organisation_id, payerId: r.customer_id ?? null,
        currency: r.currency, gross: Math.round(Number(r.amount) * 100),
        key: `deposit:${r.id}:payment`, at: r.received_at,
      });
      if (txId) await client.query('UPDATE fin_deposits SET receipt_tx_id=$2 WHERE id=$1', [r.id, txId]);
    });
    posted++;
  }
  return { posted };
}

/** Catch the canonical ledger up with every source above and fill the filter dimensions. Idempotent; called by reconcileFinance (worker step `finance`). */
export async function syncLedger({ limit = 500 } = {}) {
  const out = { obligations: 0, obligations_updated: 0, receipts: 0, spend: 0, spend_reversed: 0, more: false, commissions: 0, contract_credit_notes: 0, venue_credit_notes: 0, pos: 0, wallet: 0, credit_notes: 0, trip_payments: 0, sponsorship_refunds: 0, offline_receipts: 0, instalments: 0, deposits: 0 };
  for (const d of OBLIGATIONS) {
    const o = await syncObligations(d, limit);
    out.obligations += o.posted; out.obligations_updated += o.updated; out.more ||= o.more;
    if (d.cumulative) out.receipts += (await syncCumulativeReceipts(d, limit)).posted;
  }
  out.receipts += (await syncTeamReceipts(limit)).posted;
  out.receipts += (await syncSponsorshipReceipts(limit)).posted;
  const s = await syncEventSpend(limit);
  out.spend = s.posted; out.spend_reversed = s.reversed;
  const vi = await syncVenueInvoices(limit);
  out.obligations += vi.posted; out.obligations_updated += vi.updated;
  const parts = [['commissions', syncCommissions], ['contract_credit_notes', syncContractCreditNotes], ['pos', syncPosTenders], ['venue_credit_notes', syncVenueCreditNotes], ['wallet', syncWalletTenders], ['credit_notes', syncCreditNotes], ['trip_payments', syncTripPayments], ['sponsorship_refunds', syncSponsorshipRefunds]];
  for (const [name, fn] of parts) { const r = await fn(limit); out[name] = (r.posted ?? 0) + (r.receipts ?? 0); }
  // after the wallet and front-desk tenders, so what they already hold is netted before the rest is treated as paid at the venue
  out.receipts += (await syncCumulativeReceipts(VENUE_INVOICE_RECEIPTS, limit)).posted;
  const or = await syncOfflineReceipts(limit); out.offline_receipts = or.posted;
  const ins = await syncInstalments(limit); out.instalments = ins.posted;
  const dep = await syncDeposits(limit); out.deposits = dep.posted;
  await applyDimensions(null, null);
  const links = await syncCrossRoleLinks();
  out.role_links = links.linked;
  return out;
}
