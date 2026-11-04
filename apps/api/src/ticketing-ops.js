// Box office, scanner reconciliation, sell-through analytics and fan segments for spectator ticketing (#587). Reached only through
// src/capabilities/ticketing-ops.js, so REST, OpenAPI and MCP share it. Everything that sells, refunds or scans runs under the same per-event
// advisory lock as the rest of ticketing (src/ticketing.js), so capacity, stock and the till can never be raced.
//   * Box office: a till is one operator's shift. A walk-up sale is an ordinary ticket order on the `box_office` channel, paid by tenders recorded against
//     the till (cash with change, card terminal, UPI, voucher). Each tender is posted to the canonical finance ledger (fin_transactions) as a receipt, so
//     there is no second ledger; a refund at the desk is a refund row on the same ledger. Cash-up compares counted cash with what the till should hold.
//   * Scanner sessions: a device shift. Offline scans replay later (scan_tickets_batch) tagged with the session, so what the device says it scanned can be
//     reconciled with what the server received, and an organiser can sign the result off as an immutable record.
import { many } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { encrypt } from './crypto.js';
import { insert } from './finance.js';
import { NOT_YOUTH_SQL } from './youth.js';
import { claimHash, confirmOrder, createOrder, loadTicket, lockEvent, newClaimCode, record, refundDueFor, tokenFor } from './ticketing.js';

export const TENDER_METHODS = ['cash', 'card_terminal', 'upi', 'voucher', 'other'];
const n = (x) => Number(x ?? 0);

// ---- tills -----------------------------------------------------------------------------------------------------------------------------------------
export const openTillOf = async (c, eventId, userId) => (await c.query("SELECT * FROM ticket_tills WHERE event_id=$1 AND operator_id=$2 AND status='open'", [eventId, userId])).rows[0] ?? null;

/** What a till holds, by tender method: sales, refunds and the cash that should be in the drawer. */
export async function tillTotals(c, till) {
  const rows = (await c.query(
    `SELECT method, kind, count(*)::int AS count, coalesce(sum(amount_minor),0)::bigint AS amount, coalesce(sum(change_minor),0)::bigint AS change FROM ticket_tenders WHERE till_id=$1 GROUP BY method, kind`, [till.id])).rows;
  const by = {};
  for (const r of rows) {
    const m = (by[r.method] ??= { method: r.method, sales: 0, sales_minor: 0, refunds: 0, refunds_minor: 0 });
    if (r.kind === 'sale') { m.sales = r.count; m.sales_minor = n(r.amount); } else { m.refunds = r.count; m.refunds_minor = n(r.amount); }
  }
  const cash = by.cash ?? { sales_minor: 0, refunds_minor: 0 };
  const expected = n(till.opening_float_minor) + cash.sales_minor - cash.refunds_minor;
  return {
    methods: Object.values(by), cash_expected_minor: expected,
    sales_minor: Object.values(by).reduce((s, m) => s + m.sales_minor, 0), refunds_minor: Object.values(by).reduce((s, m) => s + m.refunds_minor, 0),
    orders: n((await c.query("SELECT count(DISTINCT order_id)::int AS n FROM ticket_tenders WHERE till_id=$1 AND kind='sale'", [till.id])).rows[0].n),
  };
}
export const tillView = async (c, till) => ({
  id: till.id, event_id: till.event_id, operator_id: till.operator_id, access_point_id: till.access_point_id, label: till.label, currency: till.currency, status: till.status,
  opening_float_minor: n(till.opening_float_minor), opened_at: till.opened_at, closed_at: till.closed_at,
  counted_cash_minor: till.counted_cash_minor == null ? null : n(till.counted_cash_minor), expected_cash_minor: till.expected_cash_minor == null ? null : n(till.expected_cash_minor),
  variance_minor: till.variance_minor == null ? null : n(till.variance_minor), close_note: till.close_note, totals: await tillTotals(c, till),
});

export async function closeTill(c, user, till, { counted_cash_minor, note }) {
  const totals = await tillTotals(c, till);
  const variance = counted_cash_minor - totals.cash_expected_minor;
  if (variance !== 0 && !note) throw badRequest('The drawer does not match: say why (a note is needed when cash is over or short)', { code: 'variance_note', variance_minor: variance });
  const closed = (await c.query(
    `UPDATE ticket_tills SET status='closed', closed_at=now(), closed_by=$2, counted_cash_minor=$3, expected_cash_minor=$4, variance_minor=$5, close_note=$6 WHERE id=$1 AND status='open' RETURNING *`,
    [till.id, user.id, counted_cash_minor, totals.cash_expected_minor, variance, note ?? null])).rows[0];
  if (!closed) throw conflict('This till is already closed');
  return closed;
}

// ---- walk-up sale ----------------------------------------------------------------------------------------------------------------------------------
/** Post one tender to the canonical ledger: a receipt for a sale, a refund for money paid back. Idempotent on the tender id. */
async function postTender(c, ev, order, tender) {
  const share = n(order.total_minor) ? Math.round((n(order.tax_minor) * n(tender.amount_minor)) / n(order.total_minor)) : 0;
  const refund = tender.kind === 'refund';
  await insert(c, {
    module: 'tickets', kind: refund ? 'refund' : 'payment', status: 'settled', sourceType: 'ticket_order', sourceId: order.id, payerId: null, payeeId: ev.organizer_id ?? null, payeeOrgId: ev.organisation_id ?? null,
    currency: tender.currency, gross: n(tender.amount_minor), tax: share, provider: tender.method, at: null, eventId: ev.id, actorId: tender.created_by,
    key: `${refund ? 'refund' : 'receipt'}:ticket_tender:${tender.id}`, meta: { origin: refund ? 'refund' : 'receipt', method: tender.method, till_id: tender.till_id, recorded_outside_provider: true },
  });
}

/**
 * Sell at the desk. An ordinary order on the box_office channel (same stock, seats, capacity, promo and bundle rules as online), paid by tenders that must add
 * up to the total exactly (cash may be handed over in excess; the change is recorded). Issued and posted to the ledger in one transaction: a failure leaves
 * no ticket, no tender and no ledger row.
 */
export async function boxOfficeSale(c, user, ev, till, i) {
  if (till.status !== 'open') throw conflict('Open your till first', { code: 'till_closed' });
  const buyer = i.buyer ?? null;
  const codes = [];
  const cache = [];
  const one = () => {
    const code = newClaimCode(); codes.push(code);
    return { guest_name_enc: encrypt(buyer.name, 'tickets.guest_name'), guest_email_enc: buyer.email ? encrypt(buyer.email, 'tickets.guest_email') : null, claim_hash: claimHash(code) };
  };
  // one guest holder (with their own claim code) per ticket, made as createOrder asks for each
  const recipients = buyer ? new Proxy([], { get: (_, k) => (/^\d+$/.test(String(k)) ? (cache[k] ??= one()) : undefined) }) : null;
  const r = await createOrder(c, user, ev, { idempotency_key: i.idempotency_key, lines: i.lines ?? [], bundles: i.bundles, addons: i.addons, promo_codes: i.promo_codes }, { channel: 'box_office', recipients, hold: true });
  if (r.replayed) return { order_id: r.order_id, replayed: true };
  const order = (await c.query('SELECT * FROM ticket_orders WHERE id=$1 FOR UPDATE', [r.order_id])).rows[0];
  if (order.currency !== till.currency && n(order.total_minor) > 0) throw badRequest(`This till takes ${till.currency}; the tickets are priced in ${order.currency}`);
  const total = n(order.total_minor);
  const tenders = i.tenders ?? [];
  if (total === 0 && tenders.length) throw badRequest('This sale is free: no payment to take');
  if (total > 0) {
    if (!tenders.length) throw badRequest(`Take payment: the total is ${total}`, { code: 'tender_required', total_minor: total });
    const sum = tenders.reduce((s, t) => s + t.amount_minor, 0);
    if (sum !== total) throw badRequest(`The tenders add up to ${sum} but the total is ${total}`, { code: 'tender_mismatch', total_minor: total, tendered_minor: sum });
  }
  const made2 = [];
  for (const t of tenders) {
    if (t.method !== 'cash' && t.tendered_minor != null && t.tendered_minor !== t.amount_minor) throw badRequest('Only cash can be handed over in excess');
    if (['card_terminal', 'upi', 'voucher'].includes(t.method) && !t.reference) throw badRequest(`Enter the ${t.method === 'card_terminal' ? 'terminal slip' : t.method === 'upi' ? 'UPI' : 'voucher'} reference`, { code: 'reference_required' });
    const given = t.method === 'cash' ? (t.tendered_minor ?? t.amount_minor) : t.amount_minor;
    const row = (await c.query(
      `INSERT INTO ticket_tenders(event_id, till_id, order_id, kind, method, amount_minor, tendered_minor, change_minor, currency, reference, created_by) VALUES ($1,$2,$3,'sale',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ev.id, till.id, order.id, t.method, t.amount_minor, given, given - t.amount_minor, order.currency, t.reference ?? null, user.id])).rows[0];
    made2.push(row);
  }
  await c.query('UPDATE ticket_orders SET till_id=$2 WHERE id=$1', [order.id, till.id]);
  if (buyer?.marketing_opt_in) await c.query('UPDATE tickets SET marketing_opt_in=true WHERE order_id=$1', [order.id]);
  if (!(await confirmOrder(c, order.id, user.id, { locked: true }))) throw conflict('The tickets could not be issued (stock changed): nothing was charged', { code: 'sold_out' });
  for (const t of made2) await postTender(c, ev, order, t);
  // a walk-up order is held by the operator account; the buyer-guest is the ticket holder. Only the codes for the tickets actually made are returned.
  const tickets = (await c.query('SELECT id, serial, token_version, class, seat_label, claim_hash FROM tickets WHERE order_id=$1 AND supersedes_id IS NULL ORDER BY created_at, id', [order.id])).rows;
  const byHash = new Map(codes.map((cd) => [claimHash(cd), cd]));
  return {
    order_id: order.id, replayed: false, total_minor: total, currency: order.currency, change_minor: made2.reduce((s, t) => s + n(t.change_minor), 0),
    tickets: tickets.map((t) => ({ id: t.id, serial: t.serial, class: t.class, seat: t.seat_label, token: tokenFor(t.serial, t.token_version), claim_code: byHash.get(t.claim_hash) ?? null })),
  };
}

/** Pay a walk-up buyer back at the desk. The ticket becomes refunded only once the refund tender is recorded against a till (cash) and on the ledger. */
export async function refundAtDesk(c, user, ev, ticketId, { method, reason }) {
  await lockEvent(c, ev.id);
  const t0 = await loadTicket(c, ticketId, { lock: true });
  if (!t0 || t0.event_id !== ev.id) throw notFound('Ticket');
  if (!['issued', 'refund_due'].includes(t0.status)) throw conflict('This ticket cannot be refunded');
  const sale = (await c.query("SELECT * FROM ticket_tenders WHERE order_id=$1 AND kind='sale' ORDER BY created_at, id", [t0.order_id])).rows;
  if (!sale.length) throw conflict('This ticket was not paid at the box office: refund it from the ticket', { code: 'not_box_office' });
  const used = (await c.query('SELECT 1 FROM ticket_attendance WHERE entitlement_id=$1', [t0.entitlement_id])).rowCount;
  if (used) throw conflict('This ticket has been used', { code: 'already_used' });
  const pay = method ?? sale[0].method;
  let till = null;
  if (pay === 'cash') {
    till = await openTillOf(c, ev.id, user.id);
    if (!till) throw conflict('Open your till to pay cash back', { code: 'till_closed' });
  }
  if (t0.status === 'issued') await refundDueFor(c, 't.id=$1', [t0.id], reason, user.id, 'refund_requested');
  const amount = n(t0.price_minor) - n(t0.discount_minor) - n(t0.refunded_minor);
  let tender = null;
  if (amount > 0) {
    tender = (await c.query(
      `INSERT INTO ticket_tenders(event_id, till_id, order_id, ticket_id, kind, method, amount_minor, currency, created_by) VALUES ($1,$2,$3,$4,'refund',$5,$6,$7,$8) RETURNING *`,
      [ev.id, till?.id ?? null, t0.order_id, t0.id, pay, amount, t0.currency, user.id])).rows[0];
    const order = (await c.query('SELECT * FROM ticket_orders WHERE id=$1', [t0.order_id])).rows[0];
    await postTender(c, ev, order, tender);
  }
  await c.query("UPDATE tickets SET status = CASE WHEN $2::bigint > 0 THEN 'refunded' ELSE 'void' END, refunded_minor = refunded_minor + $2 WHERE id=$1 AND status='refund_due'", [t0.id, amount]);
  await record(c, t0.id, user.id, 'refunded', 'refund_due', amount > 0 ? 'refunded' : 'void', { amount_minor: amount, currency: t0.currency, method: pay, box_office: true });
  return { ticket_id: t0.id, status: amount > 0 ? 'refunded' : 'void', refunded_minor: amount, method: pay, currency: t0.currency };
}

// ---- scanner sessions and reconciliation -------------------------------------------------------------------------------------------------------------
export async function sessionFor(c, ev, user, sessionId, { organiser = false } = {}) {
  const s = (await c.query('SELECT * FROM ticket_scan_sessions WHERE id=$1 AND event_id=$2', [sessionId, ev.id])).rows[0];
  if (!s || (!organiser && s.operator_id !== user.id)) throw notFound('Scan session');
  return s;
}
export async function openSessionFor(c, ev, user, sessionId) {
  const s = await sessionFor(c, ev, user, sessionId, { organiser: false });
  if (s.status !== 'open') throw conflict('This scanner session is closed', { code: 'session_closed' });
  return s;
}

/** Scans per session, what each device says it did, and the tickets that more than one device admitted or flagged. Read only. */
export async function reconciliation(c, ev, fixtureId = null) {
  const f = fixtureId ?? null;
  const sessions = await many(
    `SELECT s.*, u.display_name AS operator, ap.name AS gate,
            count(sc.id)::int AS received, count(sc.id) FILTER (WHERE sc.result IN ('valid','re_entry'))::int AS admitted, count(sc.id) FILTER (WHERE sc.result='duplicate')::int AS duplicates,
            count(sc.id) FILTER (WHERE sc.result NOT IN ('valid','re_entry','exit','duplicate'))::int AS refused, count(sc.id) FILTER (WHERE sc.method='offline')::int AS offline,
            min(sc.scanned_at) AS first_scan, max(sc.scanned_at) AS last_scan
       FROM ticket_scan_sessions s JOIN users u ON u.id=s.operator_id LEFT JOIN access_points ap ON ap.id=s.access_point_id
       LEFT JOIN ticket_scans sc ON sc.session_id=s.id AND ($2::uuid IS NULL OR sc.fixture_id=$2)
      WHERE s.event_id=$1 AND ($2::uuid IS NULL OR s.fixture_id IS NULL OR s.fixture_id=$2) GROUP BY s.id, u.display_name, ap.name ORDER BY s.started_at`, [ev.id, f]);
  const out = sessions.map((s) => ({
    id: s.id, device_label: s.device_label, operator: s.operator, gate: s.gate, fixture_id: s.fixture_id, status: s.status, started_at: s.started_at, ended_at: s.ended_at, manifest_at: s.manifest_at, manifest_count: s.manifest_count,
    received: s.received, admitted: s.admitted, duplicates: s.duplicates, refused: s.refused, offline: s.offline, first_scan: s.first_scan, last_scan: s.last_scan,
    reported_scans: s.reported_scans, reported_admitted: s.reported_admitted,
    missing: s.reported_scans == null ? null : Math.max(s.reported_scans - s.received, 0),   // the device scanned these but they never reached the server
    unsynced_warning: s.status === 'open' || (s.reported_scans != null && s.reported_scans > s.received),
    close_note: s.close_note,
  }));
  const conflicts = await many(
    `SELECT t.serial, t.short_code, t.class, count(*)::int AS scans, count(*) FILTER (WHERE sc.result IN ('valid','re_entry'))::int AS admitted, count(*) FILTER (WHERE sc.result='duplicate')::int AS duplicates,
            count(DISTINCT sc.session_id)::int AS devices, min(sc.scanned_at) AS first_at, max(sc.scanned_at) AS last_at,
            array_agg(DISTINCT s.device_label) FILTER (WHERE s.device_label IS NOT NULL) AS device_labels
       FROM ticket_scans sc JOIN tickets t ON t.id=sc.ticket_id LEFT JOIN ticket_scan_sessions s ON s.id=sc.session_id
      WHERE sc.event_id=$1 AND sc.direction='in' AND sc.result IN ('valid','re_entry','duplicate') AND ($2::uuid IS NULL OR sc.fixture_id=$2)
      GROUP BY t.id HAVING count(*) FILTER (WHERE sc.result='duplicate') > 0 AND count(DISTINCT sc.session_id) > 1 ORDER BY max(sc.scanned_at) DESC LIMIT 100`, [ev.id, f]);
  const sum = (k) => out.reduce((s, x) => s + n(x[k]), 0);
  const totals = (await c.query(
    `SELECT (SELECT count(*)::int FROM tickets t WHERE t.event_id=$1 AND t.status='issued') AS issued,
            (SELECT count(*)::int FROM ticket_attendance a WHERE a.event_id=$1 AND ($2::uuid IS NULL OR a.fixture_id=$2)) AS attended,
            (SELECT count(*)::int FROM ticket_scans sc WHERE sc.event_id=$1 AND sc.session_id IS NULL AND ($2::uuid IS NULL OR sc.fixture_id=$2)) AS without_session`, [ev.id, f])).rows[0];
  const open = out.filter((s) => s.status === 'open').length;
  const missing = sum('missing');
  return {
    event_id: ev.id, fixture_id: f, sessions: out, conflicts,
    totals: { issued: totals.issued, attended: totals.attended, no_show: Math.max(totals.issued - totals.attended, 0), scans_received: sum('received'), scans_without_session: totals.without_session,
      offline_scans: sum('offline'), duplicates: sum('duplicates'), reported_scans: out.reduce((s, x) => s + n(x.reported_scans), 0), missing_scans: missing, open_sessions: open },
    ready_to_sign: open === 0 && missing === 0,
    blockers: [...(open ? [`${open} scanner session${open === 1 ? ' is' : 's are'} still open`] : []), ...(missing ? [`${missing} scan${missing === 1 ? '' : 's'} reported by a device never reached the server`] : [])],
    signed: await many('SELECT r.id, r.signed_at, r.note, u.display_name AS signed_by, r.fixture_id FROM ticket_reconciliations r JOIN users u ON u.id=r.signed_by WHERE r.event_id=$1 ORDER BY r.signed_at DESC LIMIT 10', [ev.id]),
  };
}

// ---- analytics -------------------------------------------------------------------------------------------------------------------------------------
/** Sell-through, sales velocity, channel mix, no-show and arrival profile. Counts only; no person is identified. */
export async function analytics(c, ev, fixtureId = null) {
  const f = fixtureId ?? null;
  const base = `WITH o AS (SELECT t.*, od.channel, od.confirmed_at FROM tickets t JOIN ticket_orders od ON od.id=t.order_id WHERE t.event_id=$1 AND t.supersedes_id IS NULL AND t.issued_at IS NOT NULL),
                     cur AS (SELECT DISTINCT ON (entitlement_id) entitlement_id, status FROM tickets WHERE event_id=$1 ORDER BY entitlement_id, created_at DESC, id DESC)`;
  const products = await many(
    `${base} SELECT p.id, p.name, p.class, p.kind, p.allocation, count(o.id) FILTER (WHERE cur.status IN ('issued','transferred'))::int AS sold,
            (SELECT count(*)::int FROM tickets t WHERE t.product_id=p.id AND (t.status='reserved' AND t.hold_expires_at > now())) AS held
       FROM ticket_products p LEFT JOIN o ON o.product_id=p.id LEFT JOIN cur ON cur.entitlement_id=o.entitlement_id WHERE p.event_id=$1 AND p.status <> 'archived' GROUP BY p.id ORDER BY p.created_at`, [ev.id]);
  const settings = (await c.query('SELECT spectator_capacity FROM ticket_settings WHERE event_id=$1', [ev.id])).rows[0];
  const fixtures = await many(
    `SELECT fx.id, fx.scheduled_at, fx.status, coalesce(l.spectator_capacity, $3::int) AS capacity,
            (SELECT count(*)::int FROM tickets t WHERE t.event_id=$1 AND t.status='issued' AND (NOT EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id)
               OR EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id AND x.fixture_id=fx.id))) AS sold,
            (SELECT count(*)::int FROM ticket_attendance a WHERE a.fixture_id=fx.id) AS attended
       FROM fixtures fx LEFT JOIN ticket_fixture_limits l ON l.fixture_id=fx.id WHERE fx.event_id=$1 AND ($2::uuid IS NULL OR fx.id=$2) ORDER BY fx.scheduled_at`, [ev.id, f, settings?.spectator_capacity ?? null]);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const velocity = await many(
    `SELECT o.confirmed_at::date AS day, od.channel, count(*)::int AS tickets, coalesce(sum(t.price_minor - t.discount_minor),0)::bigint AS revenue_minor, t.currency
       FROM tickets t JOIN ticket_orders od ON od.id=t.order_id JOIN ticket_orders o ON o.id=od.id
      WHERE t.event_id=$1 AND t.supersedes_id IS NULL AND t.issued_at IS NOT NULL AND o.confirmed_at > now() - interval '60 days' GROUP BY 1, 2, t.currency ORDER BY 1`, [ev.id]);
  const holds = (await c.query(`SELECT count(*) FILTER (WHERE status='confirmed')::int AS confirmed, count(*) FILTER (WHERE status='expired')::int AS expired, count(*) FILTER (WHERE status='cancelled')::int AS cancelled FROM ticket_orders WHERE event_id=$1 AND channel='online'`, [ev.id])).rows[0];
  const arrival = await many(
    `SELECT extract(hour from first_in_at)::int AS hour, count(*)::int AS admitted FROM ticket_attendance WHERE event_id=$1 AND ($2::uuid IS NULL OR fixture_id=$2) GROUP BY 1 ORDER BY 1`, [ev.id, f]);
  const bundles = await many(
    `SELECT b.id, b.name, b.kind, b.currency, b.stock, coalesce(sum(bo.qty) FILTER (WHERE o.status='confirmed'),0)::int AS sold, coalesce(sum(bo.charged_minor) FILTER (WHERE o.status='confirmed'),0)::bigint AS revenue_minor,
            coalesce(sum(bo.discount_minor) FILTER (WHERE o.status='confirmed'),0)::bigint AS saving_minor
       FROM ticket_bundles b LEFT JOIN ticket_bundle_orders bo ON bo.bundle_id=b.id LEFT JOIN ticket_orders o ON o.id=bo.order_id WHERE b.event_id=$1 AND b.status <> 'archived' GROUP BY b.id ORDER BY b.created_at`, [ev.id]);
  const aov = await many(`SELECT currency, round(avg(total_minor))::bigint AS avg_minor, count(*)::int AS orders FROM ticket_orders WHERE event_id=$1 AND status='confirmed' AND total_minor > 0 GROUP BY currency`, [ev.id]);
  const done = fixtures.filter((x) => ['completed', 'finished'].includes(x.status));
  const peak = [...arrival].sort((a, b) => b.admitted - a.admitted)[0] ?? null;
  return {
    sell_through: {
      overall_pct: pct(fixtures.reduce((s, x) => s + (x.capacity != null ? Math.min(x.sold, x.capacity) : 0), 0), fixtures.reduce((s, x) => s + (x.capacity ?? 0), 0)),
      products: products.map((p) => ({ id: p.id, name: p.name, class: p.class, kind: p.kind, allocation: p.allocation, sold: p.sold, held: p.held, pct: p.allocation ? pct(p.sold, p.allocation) : null })),
      fixtures: fixtures.map((x) => ({ fixture_id: x.id, scheduled_at: x.scheduled_at, status: x.status, capacity: x.capacity, sold: x.sold, attended: x.attended, pct: x.capacity ? pct(x.sold, x.capacity) : null, attendance_pct: x.sold ? pct(x.attended, x.sold) : null })),
    },
    no_show: { completed_fixtures: done.length, issued: done.reduce((s, x) => s + x.sold, 0), attended: done.reduce((s, x) => s + x.attended, 0), rate_pct: done.length && done.reduce((s, x) => s + x.sold, 0) ? pct(done.reduce((s, x) => s + Math.max(x.sold - x.attended, 0), 0), done.reduce((s, x) => s + x.sold, 0)) : null },
    velocity: velocity.map((v) => ({ day: v.day, channel: v.channel, tickets: v.tickets, revenue_minor: n(v.revenue_minor), currency: v.currency })),
    online_conversion: { confirmed: holds.confirmed, expired: holds.expired, cancelled: holds.cancelled, pct: pct(holds.confirmed, holds.confirmed + holds.expired + holds.cancelled) },
    arrival: { by_hour: arrival, peak_hour: peak?.hour ?? null },
    bundles: bundles.map((b) => ({ ...b, revenue_minor: n(b.revenue_minor), saving_minor: n(b.saving_minor), left: b.stock == null ? null : Math.max(b.stock - b.sold, 0) })),
    average_order: aov.map((a) => ({ currency: a.currency, avg_minor: n(a.avg_minor), orders: a.orders })),
  };
}

// ---- fan segments (CRM) ----------------------------------------------------------------------------------------------------------------------------
export const SEGMENTS = ['new', 'returning', 'pass_holder', 'vip', 'no_show', 'guest'];

/**
 * The people behind the tickets of an event, with what a club's marketing and operations team need: how often they came, what they spent, whether they
 * are new or returning to this organiser, and whether they have agreed to be contacted. No email, phone or date of birth is returned; contact goes
 * through the communications module, which honours consent. A young person is never listed.
 */
export async function fans(c, ev, { segment = null, q = null, limit = 50, offset = 0 } = {}) {
  const rows = await many(
    `WITH mine AS (
       SELECT t.holder_id AS user_id, t.entitlement_id, t.class, t.currency, t.price_minor - t.discount_minor - t.refunded_minor AS net, p.kind AS product_kind,
              EXISTS (SELECT 1 FROM ticket_attendance a WHERE a.entitlement_id=t.entitlement_id) AS attended, t.issued_at,
              (SELECT fx.status FROM fixtures fx WHERE fx.event_id=t.event_id ORDER BY fx.scheduled_at LIMIT 1) AS first_status
         FROM tickets t JOIN ticket_products p ON p.id=t.product_id
        WHERE t.event_id=$1 AND t.status='issued' AND t.holder_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ticket_orders od WHERE od.id=t.order_id AND od.channel='box_office' AND t.guest_name_enc IS NULL)),   -- an anonymous walk-up is held by the desk operator: not a fan
     agg AS (
       SELECT user_id, count(*)::int AS tickets, count(*) FILTER (WHERE attended)::int AS attended, count(*) FILTER (WHERE NOT attended)::int AS not_attended,
              bool_or(class='vip') AS vip, bool_or(product_kind='pass') AS pass_holder, max(issued_at) AS last_purchase,
              jsonb_object_agg(currency, net) FILTER (WHERE currency IS NOT NULL) AS spend_hint
         FROM mine GROUP BY user_id)
     SELECT a.*, u.display_name,
            (SELECT coalesce(bool_or(fx.status IN ('completed','finished')), false) FROM fixtures fx WHERE fx.event_id=$1) AS played,
            EXISTS (SELECT 1 FROM tickets t2 JOIN events e2 ON e2.id=t2.event_id WHERE t2.holder_id=a.user_id AND t2.event_id <> $1 AND t2.status IN ('issued','refunded','transferred')
                    AND e2.organizer_id = $2 AND e2.organisation_id IS NOT DISTINCT FROM $3) AS returning,
            (SELECT action='opt_in' FROM comm_consents cc WHERE cc.user_id=a.user_id ORDER BY cc.created_at DESC LIMIT 1) AS may_contact
       FROM agg a JOIN users u ON u.id=a.user_id WHERE ${NOT_YOUTH_SQL}
        AND ($4::text IS NULL OR u.display_name ILIKE '%' || $4 || '%') ORDER BY a.last_purchase DESC, a.user_id`, [ev.id, ev.organizer_id, ev.organisation_id ?? null, q]);
  const spend = await many(
    `SELECT t.holder_id AS user_id, t.currency, coalesce(sum(t.price_minor - t.discount_minor - t.refunded_minor) FILTER (WHERE t.status='issued'),0)::bigint AS net_minor
       FROM tickets t WHERE t.event_id=$1 AND t.holder_id = ANY($2::uuid[]) GROUP BY 1, 2`, [ev.id, rows.map((r) => r.user_id)]);
  const spendOf = new Map();
  for (const s of spend) spendOf.set(s.user_id, [...(spendOf.get(s.user_id) ?? []), { currency: s.currency, net_minor: n(s.net_minor) }]);
  const guests = n((await c.query("SELECT count(*)::int AS n FROM tickets WHERE event_id=$1 AND status='issued' AND holder_id IS NULL AND guest_name_enc IS NOT NULL", [ev.id])).rows[0].n);
  const guestOptIn = n((await c.query("SELECT count(*)::int AS n FROM tickets WHERE event_id=$1 AND status='issued' AND holder_id IS NULL AND guest_name_enc IS NOT NULL AND marketing_opt_in", [ev.id])).rows[0].n);
  const people = rows.map((r) => {
    const segs = [r.returning ? 'returning' : 'new', ...(r.pass_holder ? ['pass_holder'] : []), ...(r.vip ? ['vip'] : []), ...(r.played && r.not_attended > 0 && r.attended === 0 ? ['no_show'] : [])];
    return { user_id: r.user_id, display_name: r.display_name, tickets: r.tickets, attended: r.attended, not_attended: r.not_attended, spend: spendOf.get(r.user_id) ?? [], last_purchase: r.last_purchase, segments: segs, may_contact: r.may_contact === true };
  });
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, s === 'guest' ? guests : people.filter((p) => p.segments.includes(s)).length]));
  const filtered = segment && segment !== 'guest' ? people.filter((p) => p.segments.includes(segment)) : segment === 'guest' ? [] : people;
  return { event_id: ev.id, total: filtered.length, segments: counts, guests: { tickets: guests, opted_in: guestOptIn }, may_contact: people.filter((p) => p.may_contact).length, items: filtered.slice(offset, offset + limit), limit, offset };
}

