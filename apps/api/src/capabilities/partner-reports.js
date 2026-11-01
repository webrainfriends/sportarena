// Platform-side reporting for the partner module: dashboard, revenue, settlement and profit & loss reports, the platform ledger
// (costs / other revenue that are not bookings) and the partner's own earnings statement. All figures are in minor units, grouped
// per currency (a platform can run venues in several). `format: csv` returns the same table as CSV text.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { isPlatform } from '../platform.js';
import { csvEscape } from './partner-contracts.js';
import { audit } from '../helpers.js';

const TAG = 'Partner reports';
const platformOnly = (user) => { if (!isPlatform(user)) throw forbidden('Only the platform team can do that'); };
const day = z.string().date();
const range = z.object({ from: day, to: day }).refine((i) => i.to >= i.from, 'to is before from');
const toCsv = (rows) => (rows.length ? [Object.keys(rows[0]), ...rows.map((r) => Object.values(r))].map((r) => r.map(csvEscape).join(',')).join('\n') : '');
const fmt = z.enum(['json', 'csv']).default('json');
const endOf = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString(); };

cap({
  name: 'platform_dashboard', method: 'GET', path: '/admin/partner-dashboard', tag: TAG,
  summary: 'Platform team: the partner module at a glance — partners by status, venues and price requests waiting for a decision, settlements by status, contracts ending soon, and the last 30 days of booking sales, commission and the top venues.',
  async handler({ user }) {
    platformOnly(user);
    const [partners, queues, settle, expiring, sales, top] = await Promise.all([
      many('SELECT status, count(*)::int AS n FROM partners GROUP BY status'),
      one(`SELECT (SELECT count(*)::int FROM venues WHERE approval_status='pending') AS venues_pending,
                  (SELECT count(*)::int FROM price_requests WHERE status IN ('pending','countered')) AS price_requests_open,
                  (SELECT count(*)::int FROM price_requests WHERE status='pending') AS price_requests_awaiting_platform,
                  (SELECT count(*)::int FROM partner_contracts WHERE status='sent') AS contracts_awaiting_partner,
                  (SELECT count(*)::int FROM partners WHERE status IN ('applied','onboarding')) AS partners_to_onboard`),
      many("SELECT status, currency, count(*)::int AS n, coalesce(sum(net_payable_cents),0)::bigint AS net_payable_cents FROM settlements WHERE status <> 'void' GROUP BY status, currency"),
      many("SELECT k.id, k.contract_no, p.name AS partner_name, k.effective_to FROM partner_contracts k JOIN partners p ON p.id=k.partner_id WHERE k.status='active' AND k.effective_to BETWEEN current_date AND current_date + 30 ORDER BY k.effective_to"),
      many(`SELECT i.currency, coalesce(sum(CASE WHEN i.kind='credit_note' THEN -(i.total_cents - i.tax_cents) ELSE i.total_cents - i.tax_cents END),0)::bigint AS sales_cents,
                   count(*) FILTER (WHERE i.kind='invoice')::int AS invoices
              FROM invoices i WHERE i.venue_id IS NOT NULL AND i.status='paid' AND coalesce(i.paid_at, i.issued_at) > now() - interval '30 days' GROUP BY i.currency`),
      many(`SELECT v.id, v.name, v.city, i.currency, sum(CASE WHEN i.kind='credit_note' THEN -(i.total_cents - i.tax_cents) ELSE i.total_cents - i.tax_cents END)::bigint AS sales_cents
              FROM invoices i JOIN venues v ON v.id=i.venue_id WHERE i.status='paid' AND coalesce(i.paid_at, i.issued_at) > now() - interval '30 days' GROUP BY v.id, i.currency ORDER BY sales_cents DESC LIMIT 5`),
    ]);
    const commission = await many("SELECT currency, coalesce(sum(commission_cents),0)::bigint AS commission_cents FROM settlements WHERE status <> 'void' AND created_at > now() - interval '30 days' GROUP BY currency");
    return { partners: Object.fromEntries(partners.map((p) => [p.status, p.n])), ...queues, settlements: settle, contracts_ending_soon: expiring, last_30_days: { sales, commission_settled: commission }, top_venues: top };
  },
});

cap({
  name: 'revenue_report', method: 'GET', path: '/admin/reports/revenue', tag: TAG,
  summary: 'Platform team: booking revenue over a date range from paid invoices and credit notes — ex-tax sales, refunds, tax, bookings, how much the platform collected vs the venues at the counter, and the commission this earns under each venue\'s active contract. Group over time (day/week/month) and by partner, venue, city or nothing.',
  input: z.object({ from: day, to: day, group_by: z.enum(['day', 'week', 'month']).default('month'), dimension: z.enum(['none', 'partner', 'venue', 'city']).default('none'), format: fmt }).refine((i) => i.to >= i.from, 'to is before from'),
  async handler({ user }, i) {
    platformOnly(user);
    const dim = { none: "'all'", partner: "coalesce(p.name,'(no partner)')", venue: 'v.name', city: "coalesce(v.city,'(unknown)')" }[i.dimension];
    const rows = await many(
      `SELECT i.currency, to_char(date_trunc($3, at), 'YYYY-MM-DD') AS period, ${dim} AS dimension,
              count(*) FILTER (WHERE i.kind='invoice')::int AS bookings_invoices,
              coalesce(sum(sign * (i.total_cents - i.tax_cents)),0)::bigint AS sales_cents,
              coalesce(sum(i.total_cents - i.tax_cents) FILTER (WHERE i.kind='credit_note'),0)::bigint AS refunds_cents,
              coalesce(sum(sign * i.tax_cents),0)::bigint AS tax_cents,
              coalesce(sum(i.total_cents) FILTER (WHERE i.kind='invoice' AND i.payment_method IN ('online','wallet')),0)::bigint AS collected_by_platform_cents,
              coalesce(sum(i.total_cents) FILTER (WHERE i.kind='invoice' AND coalesce(i.payment_method,'') NOT IN ('online','wallet')),0)::bigint AS collected_by_venue_cents,
              coalesce(round(sum(sign * (i.total_cents - i.tax_cents) * coalesce(c.bp,0) / 10000.0)),0)::bigint AS estimated_commission_cents
         FROM (SELECT i.*, CASE WHEN i.kind='credit_note' THEN i.issued_at ELSE i.paid_at END AS at, CASE WHEN i.kind='credit_note' THEN -1 ELSE 1 END AS sign FROM invoices i WHERE i.status='paid') i
         JOIN venues v ON v.id=i.venue_id LEFT JOIN partners p ON p.id=v.partner_id
         LEFT JOIN LATERAL (SELECT (k.terms->>'commission_bp')::int AS bp FROM partner_contracts k WHERE k.partner_id=v.partner_id AND k.status='active' AND (k.venue_id=v.id OR k.venue_id IS NULL) ORDER BY (k.venue_id IS NOT NULL) DESC, k.version DESC LIMIT 1) c ON true
        WHERE i.at >= $1 AND i.at < $2 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [`${i.from}T00:00:00Z`, endOf(i.to), i.group_by]);
    return i.format === 'csv' ? { csv: toCsv(rows) } : { from: i.from, to: i.to, rows, totals: Object.values(rows.reduce((a, r) => {
      const t = (a[r.currency] ??= { currency: r.currency, sales_cents: 0, refunds_cents: 0, tax_cents: 0, bookings_invoices: 0, estimated_commission_cents: 0 });
      for (const k of ['sales_cents', 'refunds_cents', 'tax_cents', 'bookings_invoices', 'estimated_commission_cents']) t[k] += r[k];
      return a;
    }, {})) };
  },
});

cap({
  name: 'settlement_report', method: 'GET', path: '/admin/reports/settlements', tag: TAG,
  summary: 'Platform team: settlement report for a date range (by period end) — every settlement with sales, commission, costs, reserve and net payable, totals per status and per partner. `format: csv` for finance.',
  input: z.object({ from: day, to: day, partner_id: id.optional(), format: fmt }).refine((i) => i.to >= i.from, 'to is before from'),
  async handler({ user }, i) {
    platformOnly(user);
    const rows = await many(
      `SELECT s.settlement_no, p.name AS partner, v.name AS venue, s.currency, s.period_start, s.period_end, s.status, s.invoices_count, s.sales_cents, s.platform_collected_cents, s.venue_collected_cents, s.commission_cents,
              s.commission_tax_cents, s.gateway_fee_cents, s.reserve_held_cents, s.reserve_released_cents, s.adjustments_cents, s.net_payable_cents, s.payout_ref, s.paid_at
         FROM settlements s JOIN partners p ON p.id=s.partner_id JOIN venues v ON v.id=s.venue_id
        WHERE s.status <> 'void' AND s.period_end BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR s.partner_id=$3) ORDER BY s.period_end, p.name`, [i.from, i.to, i.partner_id ?? null]);
    if (i.format === 'csv') return { csv: toCsv(rows) };
    const by = (key) => Object.values(rows.reduce((a, r) => {
      const k = `${r[key]}|${r.currency}`;
      const t = (a[k] ??= { [key]: r[key], currency: r.currency, settlements: 0, sales_cents: 0, commission_cents: 0, net_payable_cents: 0 });
      t.settlements++; t.sales_cents += r.sales_cents; t.commission_cents += r.commission_cents; t.net_payable_cents += r.net_payable_cents;
      return a;
    }, {}));
    return { from: i.from, to: i.to, rows, by_status: by('status'), by_partner: by('partner') };
  },
});

cap({
  name: 'pnl_report', method: 'GET', path: '/admin/reports/pnl', tag: TAG,
  summary: 'Platform team: profit & loss per currency for a date range. Revenue = commission on settlements (commission tax is a pass-through liability, not income), payment costs recovered from partners and other revenue entries; costs = ledger cost entries (payment gateway actuals, marketing, onboarding incentives…) and manual settlement debits owed to partners; with margin and a per-partner contribution table. Record non-booking revenue/cost with add_ledger_entry.',
  input: z.object({ from: day, to: day, format: fmt }).refine((i) => i.to >= i.from, 'to is before from'),
  async handler({ user }, i) {
    platformOnly(user);
    const [sett, ledger, perPartner] = await Promise.all([
      many(`SELECT currency, coalesce(sum(sales_cents),0)::bigint AS gross_sales_cents, coalesce(sum(commission_cents),0)::bigint AS commission_cents, coalesce(sum(commission_tax_cents),0)::bigint AS commission_tax_cents,
                   coalesce(sum(gateway_fee_cents),0)::bigint AS payment_costs_recovered_cents, coalesce(sum(adjustments_cents) FILTER (WHERE adjustments_cents > 0),0)::bigint AS credits_to_partners_cents,
                   coalesce(sum(-adjustments_cents) FILTER (WHERE adjustments_cents < 0),0)::bigint AS penalties_from_partners_cents
              FROM settlements WHERE status <> 'void' AND period_end BETWEEN $1 AND $2 GROUP BY currency`, [i.from, i.to]),
      many('SELECT currency, kind, category, sum(amount_cents)::bigint AS amount_cents FROM platform_ledger WHERE entry_date BETWEEN $1 AND $2 GROUP BY currency, kind, category ORDER BY currency, kind, category', [i.from, i.to]),
      many(`SELECT p.name AS partner, s.currency, sum(s.commission_cents)::bigint AS commission_cents, sum(s.sales_cents)::bigint AS sales_cents,
                   coalesce((SELECT sum(CASE WHEN l.kind='revenue' THEN l.amount_cents ELSE -l.amount_cents END) FROM platform_ledger l WHERE l.partner_id=p.id AND l.currency=s.currency AND l.entry_date BETWEEN $1 AND $2),0)::bigint AS ledger_net_cents
              FROM settlements s JOIN partners p ON p.id=s.partner_id WHERE s.status <> 'void' AND s.period_end BETWEEN $1 AND $2 GROUP BY p.id, p.name, s.currency ORDER BY commission_cents DESC`, [i.from, i.to]),
    ]);
    const currencies = [...new Set([...sett.map((s) => s.currency), ...ledger.map((l) => l.currency)])];
    const out = currencies.map((cur) => {
      const s = sett.find((x) => x.currency === cur) ?? { gross_sales_cents: 0, commission_cents: 0, commission_tax_cents: 0, payment_costs_recovered_cents: 0, credits_to_partners_cents: 0, penalties_from_partners_cents: 0 };
      const L = ledger.filter((l) => l.currency === cur);
      const otherRevenue = L.filter((l) => l.kind === 'revenue');
      const costs = L.filter((l) => l.kind === 'cost');
      const revenue = s.commission_cents + s.payment_costs_recovered_cents + s.penalties_from_partners_cents + otherRevenue.reduce((t, x) => t + x.amount_cents, 0);
      const cost = s.credits_to_partners_cents + costs.reduce((t, x) => t + x.amount_cents, 0);
      return { currency: cur, gross_booking_sales_cents: s.gross_sales_cents, revenue: { commission_cents: s.commission_cents, payment_costs_recovered_cents: s.payment_costs_recovered_cents, penalties_cents: s.penalties_from_partners_cents, other: otherRevenue.map(({ category, amount_cents }) => ({ category, amount_cents })), total_cents: revenue },
        costs: { credits_to_partners_cents: s.credits_to_partners_cents, entries: costs.map(({ category, amount_cents }) => ({ category, amount_cents })), total_cents: cost },
        net_profit_cents: revenue - cost, margin_pct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null, take_rate_pct: s.gross_sales_cents ? Math.round((s.commission_cents / s.gross_sales_cents) * 1000) / 10 : null,
        commission_tax_liability_cents: s.commission_tax_cents };
    });
    if (i.format === 'csv') return { csv: toCsv(out.map((o) => ({ currency: o.currency, gross_booking_sales: o.gross_booking_sales_cents, revenue: o.revenue.total_cents, costs: o.costs.total_cents, net_profit: o.net_profit_cents, margin_pct: o.margin_pct ?? '' }))) };
    return { from: i.from, to: i.to, by_currency: out, by_partner: perPartner };
  },
});

cap({
  name: 'add_ledger_entry', method: 'POST', path: '/admin/ledger', tag: TAG, status: 201,
  summary: 'Platform team: record platform revenue or cost that is not a booking (payment-gateway actuals, marketing, onboarding incentive, subscription fee…), optionally against a partner or venue, so the P&L is complete. Entries are never edited or removed — record a correcting entry instead.',
  input: z.object({ entry_date: day, kind: z.enum(['revenue', 'cost']), category: z.string().min(2).max(40).regex(/^[a-z0-9_]+$/, 'lower_snake_case'), amount_cents: z.number().int().min(1), currency: z.string().length(3).transform((x) => x.toUpperCase()), partner_id: id.optional(), venue_id: id.optional(), description: z.string().max(300).optional() }),
  async handler({ user }, i) {
    platformOnly(user);
    return one('INSERT INTO platform_ledger(entry_date, kind, category, amount_cents, currency, partner_id, venue_id, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [i.entry_date, i.kind, i.category, i.amount_cents, i.currency, i.partner_id ?? null, i.venue_id ?? null, i.description ?? null, user.id]);
  },
});
cap({
  name: 'list_ledger_entries', method: 'GET', path: '/admin/ledger', tag: TAG,
  summary: 'Platform team: ledger entries, newest first, optionally within a date range.',
  input: z.object({ from: day.optional(), to: day.optional(), ...page }),
  async handler({ user }, i) {
    platformOnly(user);
    return many('SELECT * FROM platform_ledger WHERE ($1::date IS NULL OR entry_date >= $1) AND ($2::date IS NULL OR entry_date <= $2) ORDER BY entry_date DESC, created_at DESC LIMIT $3 OFFSET $4', [i.from ?? null, i.to ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'partner_statement', method: 'GET', path: '/partners/:id/statement', tag: TAG,
  summary: 'A partner\'s earnings for a date range: sales, refunds, commission and costs, what has been paid and what is still due, per venue — from approved and paid settlements. The platform team and the partner owner can read it.',
  input: z.object({ id, from: day, to: day }).refine((i) => i.to >= i.from, 'to is before from'),
  async handler({ user }, i) {
    const p = await one('SELECT id, name, owner_id FROM partners WHERE id=$1', [i.id]);
    if (!p || (!isPlatform(user) && p.owner_id !== user.id)) throw notFound('Partner');
    const rows = await many(
      `SELECT v.id AS venue_id, v.name AS venue, s.currency, count(*)::int AS settlements, sum(s.sales_cents)::bigint AS sales_cents, sum(s.commission_cents + s.commission_tax_cents)::bigint AS commission_cents,
              sum(s.gateway_fee_cents)::bigint AS payment_costs_cents, sum(s.net_payable_cents) FILTER (WHERE s.status='paid')::bigint AS paid_cents, sum(s.net_payable_cents) FILTER (WHERE s.status='approved')::bigint AS due_cents
         FROM settlements s JOIN venues v ON v.id=s.venue_id WHERE s.partner_id=$1 AND s.status IN ('approved','paid') AND s.period_end BETWEEN $2 AND $3 GROUP BY v.id, s.currency ORDER BY sales_cents DESC`, [i.id, i.from, i.to]);
    if (!rows) throw badRequest('No data');
    return { partner: p.name, from: i.from, to: i.to, venues: rows.map((r) => ({ ...r, paid_cents: r.paid_cents ?? 0, due_cents: r.due_cents ?? 0 })) };
  },
});

// The venue owner's payout view (benchmark gap 10): one read that reconciles what was booked and collected with what the platform keeps, what is
// refunded and what has been or will be paid out. It composes the existing invoices, settlements and contracts (no second store) and is scoped
// to venues the caller owns, manages (venue manager or organisation owner/admin) or runs as the partner owner. Draft settlements stay hidden.
const SCOPE = `SELECT v.id FROM venues v WHERE v.owner_id=$1
  UNION SELECT s.venue_id FROM venue_staff s WHERE s.user_id=$1 AND s.role='manager' AND s.removed_at IS NULL
  UNION SELECT v.id FROM venues v JOIN partners p ON p.id=v.partner_id WHERE p.owner_id=$1
  UNION SELECT v.id FROM venues v JOIN organisations o ON o.id=v.organisation_id AND o.status='active' JOIN organisation_members m ON m.organisation_id=o.id AND m.status='active' AND m.role IN ('owner','admin') WHERE m.user_id=$1`;
const ADD = { weekly: 7, biweekly: 14, monthly: 30 };

cap({
  name: 'get_my_payouts', method: 'GET', path: '/me/venue-payouts', tag: TAG,
  summary: 'Your venue payouts in one view, per currency (never added together): what was booked and collected, refunds owed and done, the platform commission, tax and payment costs taken, what has been paid out, what is approved and on its way, and the expected next payout date from your contract cycle. Lists your approved and paid settlements and, with detail, every invoice and credit note in the range with its settlement and refund state. Bank details are masked. `format: csv` returns the lines as CSV text. Draft settlements are never shown.',
  input: z.object({ from: day, to: day, venue_ids: z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(id).max(50).optional()).describe('limit to these venues'), detail: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).default(false), format: fmt }).refine((i) => i.to >= i.from, 'to is before from'),
  async handler({ user }, i) {
    const ids = i.venue_ids?.length ? i.venue_ids : null;
    const args = [user.id, i.from, i.to, ids];
    const venues = await many(
      `WITH mine AS (${SCOPE})
       SELECT v.id, v.name, v.emoji, v.currency, p.id AS partner_id, p.name AS partner, p.payout_last4,
         (SELECT count(*)::int FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=v.id AND b.status IN ('confirmed','no_show') AND b.starts_at >= $2 AND b.starts_at < $3::date + 1) AS bookings,
         (SELECT coalesce(sum(total_cents) FILTER (WHERE status='paid'),0)::bigint FROM invoices x WHERE x.venue_id=v.id AND x.kind='invoice' AND x.issued_at >= $2 AND x.issued_at < $3::date + 1) AS collected_cents,
         (SELECT coalesce(sum(total_cents) FILTER (WHERE status='open'),0)::bigint FROM invoices x WHERE x.venue_id=v.id AND x.kind='invoice' AND x.issued_at >= $2 AND x.issued_at < $3::date + 1) AS outstanding_cents,
         (SELECT coalesce(sum(total_cents) FILTER (WHERE refund_status IN ('pending','manual','failed')),0)::bigint FROM invoices x WHERE x.venue_id=v.id AND x.kind='credit_note' AND x.issued_at >= $2 AND x.issued_at < $3::date + 1) AS refunds_owed_cents,
         (SELECT coalesce(sum(total_cents) FILTER (WHERE refund_status='done'),0)::bigint FROM invoices x WHERE x.venue_id=v.id AND x.kind='credit_note' AND x.issued_at >= $2 AND x.issued_at < $3::date + 1) AS refunds_done_cents
       FROM venues v JOIN mine ON mine.id=v.id LEFT JOIN partners p ON p.id=v.partner_id
       WHERE ($4::uuid[] IS NULL OR v.id = ANY($4)) ORDER BY v.name`, args);
    if (!venues.length) return { from: i.from, to: i.to, venues: [], by_currency: [], settlements: [], lines: [] };
    const scoped = venues.map((v) => v.id);
    // settlements visible to the partner owner only (the existing rule), never drafts
    const settlements = await many(
      `SELECT s.id, s.settlement_no, s.venue_id, v.name AS venue, s.currency, s.period_start, s.period_end, s.status, s.sales_cents, s.commission_cents, s.commission_tax_cents,
              s.gateway_fee_cents, s.reserve_held_cents, s.reserve_released_cents, s.adjustments_cents, s.net_payable_cents, s.payout_ref, s.paid_at, s.approved_at
         FROM settlements s JOIN partners p ON p.id=s.partner_id JOIN venues v ON v.id=s.venue_id
        WHERE p.owner_id=$1 AND s.venue_id = ANY($4) AND s.status IN ('approved','paid') AND s.period_end BETWEEN $2 AND $3 ORDER BY s.period_end DESC, s.settlement_no DESC LIMIT 200`, [user.id, i.from, i.to, scoped]);
    const contracts = await many(`SELECT DISTINCT ON (venue_id) venue_id, terms FROM partner_contracts WHERE status='active' AND venue_id = ANY($1) ORDER BY venue_id, created_at DESC`, [scoped]);
    const last = await many(`SELECT venue_id, max(period_end) AS period_end FROM settlements WHERE status IN ('approved','paid') AND venue_id = ANY($1) GROUP BY venue_id`, [scoped]);
    const lastBy = new Map(last.map((r) => [r.venue_id, r.period_end]));
    const termsBy = new Map(contracts.map((c) => [c.venue_id, c.terms ?? {}]));
    const by = new Map();
    for (const v of venues) {
      const t = termsBy.get(v.id); const end = lastBy.get(v.id);
      v.next_payout_on = t && end ? new Date(new Date(end).getTime() + ((ADD[t.settlement_cycle] ?? 7) + Number(t.settlement_delay_days ?? 0)) * 86400000).toISOString().slice(0, 10) : null;
      v.payout_account = v.payout_last4 ? `•••• ${v.payout_last4}` : null;
      delete v.payout_last4;
      const row = by.get(v.currency) ?? { currency: v.currency, venues: 0, bookings: 0, collected_cents: 0, outstanding_cents: 0, refunds_owed_cents: 0, refunds_done_cents: 0, commission_cents: 0, payment_costs_cents: 0, paid_cents: 0, on_its_way_cents: 0 };
      row.venues++; for (const k of ['bookings', 'collected_cents', 'outstanding_cents', 'refunds_owed_cents', 'refunds_done_cents']) row[k] += Number(v[k]);
      by.set(v.currency, row);
    }
    for (const s of settlements) {
      const row = by.get(s.currency) ?? { currency: s.currency, venues: 0, bookings: 0, collected_cents: 0, outstanding_cents: 0, refunds_owed_cents: 0, refunds_done_cents: 0, commission_cents: 0, payment_costs_cents: 0, paid_cents: 0, on_its_way_cents: 0 };
      row.commission_cents += Number(s.commission_cents) + Number(s.commission_tax_cents); row.payment_costs_cents += Number(s.gateway_fee_cents);
      if (s.status === 'paid') row.paid_cents += Number(s.net_payable_cents); else row.on_its_way_cents += Number(s.net_payable_cents);
      by.set(s.currency, row);
    }
    const lines = i.detail || i.format === 'csv' ? await many(
      `SELECT x.number, x.kind, v.name AS venue, x.currency, to_char(x.issued_at,'YYYY-MM-DD') AS issued_on, x.total_cents::bigint AS total_cents, x.tax_cents::bigint AS tax_cents, x.status, x.refund_status, st.settlement_no
         FROM invoices x JOIN venues v ON v.id=x.venue_id
         LEFT JOIN LATERAL (SELECT s.settlement_no FROM settlement_lines l JOIN settlements s ON s.id=l.settlement_id WHERE l.invoice_id=x.id AND l.live AND s.status IN ('approved','paid') LIMIT 1) st ON true
        WHERE x.venue_id = ANY($1) AND x.issued_at >= $2 AND x.issued_at < $3::date + 1 ORDER BY x.issued_at DESC, x.number DESC LIMIT 500`, [scoped, i.from, i.to]) : [];
    if (i.format === 'csv') {
      await audit(null, user.id, 'export_payouts', 'venues', scoped[0]);
      return { csv: toCsv(lines.map((l) => ({ invoice: l.number, kind: l.kind, venue: l.venue, currency: l.currency, issued_on: l.issued_on, total: l.total_cents, tax: l.tax_cents, status: l.status, refund: l.refund_status ?? '', settlement: l.settlement_no ?? '' }))) };
    }
    return { from: i.from, to: i.to, venues, by_currency: [...by.values()], settlements, lines };
  },
});
