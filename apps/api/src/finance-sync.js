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
                 WHEN o.status = 'fulfilled' OR coalesce((SELECT sum(x.amount_cents) FROM sponsorship_payments x WHERE x.obligation_id = o.id AND x.status = 'confirmed'), 0) >= o.amount_cents THEN 'settled'
                 ELSE 'open' END AS state,
            CASE WHEN sp.target_type = 'event' THEN sp.target_id END AS event_id, CASE WHEN sp.target_type = 'team' THEN sp.target_id END AS team_id, sp.department_id AS workspace_id,
            o.created_at AS at, NULL::timestamptz AS paid_at, 0::bigint AS paid_total
          FROM sponsorship_obligations o JOIN sponsorships sp ON sp.id = o.sponsorship_id JOIN sponsors sr ON sr.id = sp.sponsor_id
          WHERE o.kind = 'money' AND o.amount_cents > 0 AND o.currency IS NOT NULL`,
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

/** Catch the canonical ledger up with every source above and fill the filter dimensions. Idempotent; called by reconcileFinance (worker step `finance`). */
export async function syncLedger({ limit = 500 } = {}) {
  const out = { obligations: 0, obligations_updated: 0, receipts: 0, spend: 0, spend_reversed: 0, more: false };
  for (const d of OBLIGATIONS) {
    const o = await syncObligations(d, limit);
    out.obligations += o.posted; out.obligations_updated += o.updated; out.more ||= o.more;
    if (d.cumulative) out.receipts += (await syncCumulativeReceipts(d, limit)).posted;
  }
  out.receipts += (await syncTeamReceipts(limit)).posted;
  out.receipts += (await syncSponsorshipReceipts(limit)).posted;
  const s = await syncEventSpend(limit);
  out.spend = s.posted; out.spend_reversed = s.reversed;
  await applyDimensions(null, null);
  return out;
}
