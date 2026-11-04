// Academy kit (#798): the read models and the stock-side workflows - what is due, shortages against demand, the dashboard, replenishment orders,
// serial-numbered units, scanner lookups, the guardian/student view and the accessible receipt. Writes to stock go through the same ledger as the desk.
import { tx, pool } from './db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { audit } from './helpers.js';
import { encryptFields, decryptFields } from './crypto.js';
import { guardianLink, guardianCan, isYouth } from './youth.js';
import { chargeInfo, academyCurrency, orgVenue, applies, HELD } from './kit.js';
import { receiveSupplyOrder } from './supply-receive.js';
import { slotsForSport } from './kit-slots.js';

// ------------------------------------------------------------------ what is due
const NEED_SQL = `
  SELECT e.id AS enrolment_id, e.user_id AS athlete_id, u.display_name AS athlete, e.cohort_id, k.name AS cohort, e.programme_id, p.title AS programme, p.sport,
         ent.id AS entitlement_id, ent.name AS entitlement, ent.style_key, ent.kit_slot, ent.qty, ent.mode, ent.size_required, ent.fulfil_venue_id, ent.collection_note, ent.return_days, ent.require_payment,
         (e.enrolled_at::date + CASE WHEN ent.due_rule='days_after' THEN ent.due_days ELSE 0 END) AS due_on,
         f.fulfilled, f.ever, s.size_label AS size
    FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id LEFT JOIN academy_programmes p ON p.id=e.programme_id
    JOIN academy_kit_entitlements ent ON ent.organisation_id=k.organisation_id AND ent.archived_at IS NULL
      AND ((ent.scope_type='programme' AND ent.scope_id=e.programme_id) OR (ent.scope_type='cohort' AND ent.scope_id=e.cohort_id) OR (ent.scope_type='team' AND ent.scope_id=k.team_id))
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(i.qty) FILTER (WHERE (i.status = ANY($2) OR (i.status='returned' AND ent.return_days IS NOT NULL))
               AND (ent.replace_after_months IS NULL OR i.issued_at IS NULL OR i.issued_at >= now() - make_interval(months => ent.replace_after_months))), 0)::int AS fulfilled, count(*)::int AS ever
        FROM academy_kit_issues i WHERE i.enrolment_id=e.id AND i.entitlement_id=ent.id) f
    LEFT JOIN academy_kit_sizes s ON s.organisation_id=k.organisation_id AND s.athlete_id=e.user_id AND s.slot=coalesce(ent.kit_slot, ent.style_key) AND s.superseded_at IS NULL
   WHERE k.organisation_id=$1 AND e.status IN ('enrolled','paused')`;

/** Every need (athlete x entitlement) with what has been fulfilled. The scope of scoped staff (their sports / groups) is applied here. */
export async function needs(q, orgId, access, f = {}) {
  const rows = (await q.query(`${NEED_SQL} AND ($3::uuid IS NULL OR e.cohort_id=$3) AND ($4::uuid IS NULL OR e.programme_id=$4) AND ($5::uuid IS NULL OR e.user_id=$5) AND ($6::text IS NULL OR u.display_name ILIKE '%'||$6||'%') ORDER BY due_on, u.display_name`,
    [orgId, HELD, f.cohort_id ?? null, f.programme_id ?? null, f.athlete_id ?? null, f.q ?? null])).rows;
  const a = access?.a;
  const scoped = a && !a.admin && !access.manage ? rows.filter((r) => a.scopeOk({ sport: r.sport, cohort_id: r.cohort_id })) : rows;
  return scoped.map((r) => ({ ...r, outstanding: Math.max(0, r.qty - r.fulfilled), replacement: r.ever > 0 && r.fulfilled < r.qty }));
}

export async function dueList(q, orgId, access, f) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await needs(q, orgId, access, f)).filter((r) => r.outstanding > 0);
  const stock = await stockMap(q, orgId);
  let out = rows.map((r) => {
    const venueIds = r.fulfil_venue_id ? [r.fulfil_venue_id] : null;
    const size = r.size_required ? r.size : null;
    const available = stockFor(stock, r.style_key, size, venueIds);
    const due = String(r.due_on?.toISOString?.().slice(0, 10) ?? r.due_on);
    return {
      enrolment_id: r.enrolment_id, athlete_id: r.athlete_id, athlete: r.athlete, cohort: r.cohort, programme: r.programme, entitlement_id: r.entitlement_id, entitlement: r.entitlement,
      style_key: r.style_key, kit_slot: r.kit_slot, qty: r.qty, outstanding: r.outstanding, mode: access.manage ? r.mode : undefined, size: r.size, needs_fitting: r.size_required && !r.size,
      due_on: due, overdue: due < today, reason: r.replacement ? 'replacement' : 'new', available, short: r.size_required && !r.size ? null : available < r.outstanding,
      collect_at: r.fulfil_venue_id, collection_note: r.collection_note, loan_days: r.return_days,
    };
  });
  if (f.status === 'overdue') out = out.filter((r) => r.overdue);
  if (f.status === 'needs_fitting') out = out.filter((r) => r.needs_fitting);
  if (f.status === 'short') out = out.filter((r) => r.short);
  return out.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 50));
}

// ------------------------------------------------------------------ stock against demand
async function stockMap(q, orgId) {
  const rows = (await q.query(
    `SELECT it.id, it.venue_id, v.name AS venue, it.name, it.style_key, it.size_label, it.kit_slot, it.quantity, it.reorder_level, it.damaged_qty, it.serialised, it.barcode,
            coalesce((SELECT sum(o.quantity) FROM supply_orders o WHERE o.item_id=it.id AND o.status IN ('ordered','shipped')),0)::int AS on_order
       FROM inventory_items it JOIN venues v ON v.id=it.venue_id WHERE v.organisation_id=$1 AND it.style_key IS NOT NULL AND it.archived_at IS NULL ORDER BY it.style_key, it.size_label NULLS FIRST`, [orgId])).rows;
  return rows;
}
const sameSize = (a, b) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
const stockFor = (rows, style, size, venueIds) => rows.filter((r) => r.style_key === style && (size == null || sameSize(r.size_label, size)) && (!venueIds || venueIds.includes(r.venue_id))).reduce((n, r) => n + r.quantity, 0);

/** Demand by product and size against stock and what is on order. Athletes with no size on file are counted separately as "awaiting fitting". */
export async function shortages(q, orgId, access) {
  const stock = await stockMap(q, orgId);
  const rows = (await needs(q, orgId, access)).filter((r) => r.outstanding > 0);
  const demand = new Map(), unfitted = new Map();
  for (const r of rows) {
    if (r.size_required && !r.size) { unfitted.set(r.style_key, (unfitted.get(r.style_key) ?? 0) + r.outstanding); continue; }
    const key = `${r.style_key}|${(r.size_required ? r.size : '').toLowerCase()}`;
    demand.set(key, { style_key: r.style_key, size_label: r.size_required ? r.size : null, demand: (demand.get(key)?.demand ?? 0) + r.outstanding });
  }
  const out = [];
  for (const d of demand.values()) {
    const have = stock.filter((s) => s.style_key === d.style_key && (d.size_label == null || sameSize(s.size_label, d.size_label)));
    const onHand = have.reduce((n, s) => n + s.quantity, 0), onOrder = have.reduce((n, s) => n + s.on_order, 0);
    out.push({ ...d, name: have[0]?.name ?? stock.find((x) => x.style_key === d.style_key)?.name ?? d.style_key, on_hand: onHand, on_order: onOrder, short: Math.max(0, d.demand - onHand - onOrder), item_id: have[0]?.id ?? null, venue_id: have[0]?.venue_id ?? null, missing_stock_row: have.length === 0 });
  }
  for (const [style_key, n] of unfitted) out.push({ style_key, name: stock.find((x) => x.style_key === style_key)?.name ?? style_key, size_label: null, awaiting_fitting: n, demand: 0, on_hand: stockFor(stock, style_key, null, null), on_order: 0, short: 0, item_id: null, venue_id: null, missing_stock_row: false });
  return out.sort((a, b) => b.short - a.short || a.style_key.localeCompare(b.style_key));
}

export async function dashboard(q, orgId, access) {
  const all = await needs(q, orgId, access);
  const required = all.reduce((n, r) => n + r.qty, 0), fulfilled = all.reduce((n, r) => n + Math.min(r.qty, r.fulfilled), 0);
  const today = new Date().toISOString().slice(0, 10);
  const open = all.filter((r) => r.outstanding > 0);
  const tallies = (await q.query(
    `SELECT count(*) FILTER (WHERE status='issued' AND due_back_at IS NOT NULL)::int AS on_loan,
            count(*) FILTER (WHERE status='issued' AND due_back_at IS NOT NULL AND due_back_at < now())::int AS overdue_returns,
            count(*) FILTER (WHERE status='writeoff_pending')::int AS pending_approvals, count(*) FILTER (WHERE status='reserved')::int AS awaiting_handover,
            count(*) FILTER (WHERE status='issued')::int AS with_athletes
       FROM academy_kit_issues WHERE organisation_id=$1`, [orgId])).rows[0];
  const stock = await stockMap(q, orgId);
  const plan = await shortages(q, orgId, access);
  const out = {
    athletes: new Set(all.map((r) => r.athlete_id)).size, required, fulfilled, coverage_pct: required ? Math.round((fulfilled / required) * 100) : null,
    due: open.length, overdue_due: open.filter((r) => String(r.due_on?.toISOString?.().slice(0, 10) ?? r.due_on) < today).length, awaiting_fitting: open.filter((r) => r.size_required && !r.size).length,
    ...tallies, low_stock: stock.filter((s) => s.quantity <= s.reorder_level).length, short_lines: plan.filter((p) => p.short > 0).length,
    stock: stock.map((s) => ({ item_id: s.id, venue_id: s.venue_id, venue: s.venue, name: s.name, style_key: s.style_key, size_label: s.size_label, kit_slot: s.kit_slot, quantity: s.quantity, reorder_level: s.reorder_level, damaged: s.damaged_qty, on_order: s.on_order, serialised: s.serialised, low: s.quantity <= s.reorder_level })),
    shortages: plan,
  };
  if (access.finance) {
    out.deposits_held = (await q.query(
      `SELECT ch.currency, coalesce(sum(ch.settled_minor),0)::bigint AS minor FROM academy_kit_issues i JOIN academy_charges ch ON ch.id=i.deposit_charge_id
        WHERE i.organisation_id=$1 AND i.status IN ('issued','writeoff_pending') AND ch.status='paid' GROUP BY ch.currency`, [orgId])).rows.map((r) => ({ currency: r.currency, minor: Number(r.minor) }));
    out.unpaid_kit_charges = (await q.query(
      `SELECT currency, coalesce(sum(amount_minor - settled_minor - adjusted_minor),0)::bigint AS minor, count(*)::int AS n FROM academy_charges WHERE organisation_id=$1 AND kind IN ('kit','kit_deposit') AND status='awaiting_payment' GROUP BY currency`, [orgId])).rows.map((r) => ({ currency: r.currency, minor: Number(r.minor), count: r.n }));
  }
  return out;
}

/** The stock the entitlement form picks from: products (style_key) with their sizes, across the academy's venues, and the suggested slots for the academy's sports. */
export async function catalogue(q, orgId) {
  const stock = await stockMap(q, orgId);
  const byStyle = new Map();
  for (const s of stock) {
    const g = byStyle.get(s.style_key) ?? { style_key: s.style_key, name: s.name, kit_slot: s.kit_slot, sizes: [] };
    g.sizes.push({ item_id: s.id, venue_id: s.venue_id, venue: s.venue, size_label: s.size_label, quantity: s.quantity, barcode: s.barcode, serialised: s.serialised });
    byStyle.set(s.style_key, g);
  }
  const sports = (await q.query('SELECT DISTINCT s.id, s.slug, s.name, s.scoring, s.category FROM academy_programmes p JOIN sports s ON s.slug=p.sport WHERE p.organisation_id=$1', [orgId])).rows;
  const scopes = {
    programme: (await q.query('SELECT id, title AS name FROM academy_programmes WHERE organisation_id=$1 ORDER BY title LIMIT 500', [orgId])).rows,
    cohort: (await q.query("SELECT id, name FROM org_cohorts WHERE organisation_id=$1 AND status='active' ORDER BY name LIMIT 500", [orgId])).rows,
    team: (await q.query('SELECT DISTINCT t.id, t.name FROM teams t JOIN org_cohorts k ON k.team_id=t.id WHERE k.organisation_id=$1 ORDER BY t.name LIMIT 500', [orgId])).rows,
  };
  const venues = (await q.query('SELECT id, name FROM venues WHERE organisation_id=$1 ORDER BY name', [orgId])).rows;
  return { styles: [...byStyle.values()], sports: sports.map((s) => ({ slug: s.slug, name: s.name, ...slotsForSport(s) })), currency: await academyCurrency(q, orgId), scopes, venues };
}

// ------------------------------------------------------------------ entitlements
export async function checkScope(c, orgId, scope_type, scope_id) {
  const sql = scope_type === 'programme' ? 'SELECT 1 FROM academy_programmes WHERE id=$1 AND organisation_id=$2'
    : scope_type === 'cohort' ? 'SELECT 1 FROM org_cohorts WHERE id=$1 AND organisation_id=$2' : 'SELECT 1 FROM teams t JOIN org_cohorts k ON k.team_id=t.id WHERE t.id=$1 AND k.organisation_id=$2 LIMIT 1';
  if (!(await c.query(sql, [scope_id, orgId])).rowCount) throw notFound(scope_type === 'team' ? 'Squad' : scope_type === 'cohort' ? 'Group' : 'Programme');
}

export async function checkProduct(c, orgId, style_key, fulfilVenue) {
  const n = (await c.query('SELECT count(*)::int AS n FROM inventory_items it JOIN venues v ON v.id=it.venue_id WHERE v.organisation_id=$1 AND it.style_key=$2 AND ($3::uuid IS NULL OR it.venue_id=$3)', [orgId, style_key, fulfilVenue ?? null])).rows[0].n;
  if (!n) throw new AppError(409, 'unknown_product', 'No stock row has that product key yet. Add the product and its sizes to inventory first (Stock monitor).', { style_key });
}

export const listEntitlements = (q, orgId, includeArchived) => q.query(
  `SELECT e.*, CASE e.scope_type WHEN 'programme' THEN (SELECT title FROM academy_programmes WHERE id=e.scope_id) WHEN 'cohort' THEN (SELECT name FROM org_cohorts WHERE id=e.scope_id) ELSE (SELECT name FROM teams WHERE id=e.scope_id) END AS scope_name,
          (SELECT count(*)::int FROM academy_kit_issues i WHERE i.entitlement_id=e.id AND i.status IN ('reserved','issued','writeoff_pending')) AS in_use
     FROM academy_kit_entitlements e WHERE e.organisation_id=$1 AND ($2::boolean OR e.archived_at IS NULL) ORDER BY e.scope_type, scope_name, e.name`, [orgId, includeArchived ?? false]).then((r) => r.rows);

// ------------------------------------------------------------------ sizes (fitting)
export async function setSize(c, user, orgId, i) {
  const e = (await c.query('SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.user_id=$1 AND k.organisation_id=$2 AND e.status IN (\'enrolled\',\'paused\') LIMIT 1', [i.athlete_id, orgId])).rowCount;
  if (!e) throw notFound('Athlete');
  const cur = (await c.query('SELECT * FROM academy_kit_sizes WHERE organisation_id=$1 AND athlete_id=$2 AND slot=$3 AND superseded_at IS NULL FOR UPDATE', [orgId, i.athlete_id, i.slot])).rows[0];
  if (cur && cur.size_label === i.size_label && i.fit_note === undefined) return view(cur);
  if (cur) await c.query('UPDATE academy_kit_sizes SET superseded_at=now() WHERE id=$1', [cur.id]);
  const enc = i.fit_note ? encryptFields({ fit_note: i.fit_note }, 'academy_kit_sizes', ['fit_note']) : {};
  const row = (await c.query('INSERT INTO academy_kit_sizes(organisation_id, athlete_id, slot, size_label, fit_note_enc, set_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [orgId, i.athlete_id, i.slot, i.size_label, enc.fit_note_enc ?? cur?.fit_note_enc ?? null, user.id])).rows[0];
  await audit(c, user.id, 'kit_set_size', 'academy_kit_sizes', row.id);
  return view(row);
}
const view = (r) => { const { fit_note_enc, ...rest } = r; return { ...rest, has_fit_note: !!fit_note_enc }; };

/** Sizes on file. Fit notes describe a person's body, so they are decrypted only for kit managers and every such read is audited. */
export async function getSizes(c, user, orgId, athleteId, { notes }) {
  const rows = (await c.query('SELECT * FROM academy_kit_sizes WHERE organisation_id=$1 AND athlete_id=$2 AND superseded_at IS NULL ORDER BY slot', [orgId, athleteId])).rows;
  if (notes && rows.some((r) => r.fit_note_enc)) await audit(c, user.id, 'kit_read_fit_notes', 'users', athleteId);
  return rows.map((r) => (notes ? { ...view(r), ...decryptFields(r, 'academy_kit_sizes', ['fit_note']) } : view(r)));
}

// ------------------------------------------------------------------ serial-numbered units and scanner lookups
export async function addUnits(c, user, orgId, i) {
  const item = (await c.query('SELECT it.*, v.organisation_id FROM inventory_items it JOIN venues v ON v.id=it.venue_id WHERE it.id=$1 AND v.organisation_id=$2 FOR UPDATE OF it', [i.item_id, orgId])).rows[0];
  if (!item) throw notFound('Item');
  if (!item.serialised) throw badRequest('This item is counted, not serial-numbered. Turn on serial tracking first.');
  const serials = [...new Set(i.serials.map((s) => s.trim()))];
  if (serials.length !== i.serials.length) throw badRequest('Each serial number can appear only once');
  const added = [];
  for (const serial of serials) {
    const r = await c.query("INSERT INTO inventory_units(item_id, venue_id, serial_no, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (venue_id, serial_no) DO NOTHING RETURNING id, serial_no, status", [item.id, item.venue_id, serial, user.id]);
    if (!r.rowCount) throw conflict(`Serial ${serial} is already registered at this venue`);
    added.push(r.rows[0]);
  }
  await c.query('UPDATE inventory_items SET quantity = quantity + $2 WHERE id=$1', [item.id, added.length]);
  await c.query("INSERT INTO pos_stock_moves(venue_id, item_id, delta, reason, actor_id, note) VALUES ($1,$2,$3,'adjust',$4,$5)", [item.venue_id, item.id, added.length, user.id, i.note ?? 'Units registered']);
  if (i.order_id) {
    const o = (await c.query('SELECT * FROM supply_orders WHERE id=$1 AND item_id=$2 AND ordered_by_org=$3 FOR UPDATE', [i.order_id, item.id, orgId])).rows[0];
    if (!o) throw notFound('Order');
    if (!['received', 'cancelled'].includes(o.status)) await c.query("UPDATE supply_orders SET status='received', received_at=now() WHERE id=$1", [o.id]);
  }
  await audit(c, user.id, 'kit_register_units', 'inventory_items', item.id);
  return { item_id: item.id, units: added };
}

/** Resolve whatever a scanner read: an item barcode, a unit's serial number, or an issue's own code (its id) - so desk and mobile staff land on the right record. */
export async function resolveCode(q, orgId, code) {
  const c = code.trim();
  const item = (await q.query('SELECT it.id, it.name, it.style_key, it.size_label, it.quantity, it.venue_id, v.name AS venue, it.serialised FROM inventory_items it JOIN venues v ON v.id=it.venue_id WHERE v.organisation_id=$1 AND (it.barcode=$2 OR it.sku=$2) LIMIT 1', [orgId, c])).rows[0];
  if (item) return { kind: 'item', item };
  const unit = (await q.query(
    `SELECT un.id, un.serial_no, un.status, it.id AS item_id, it.name, it.size_label, it.style_key, un.venue_id, i.id AS issue_id, i.status AS issue_status, i.athlete_id, u.display_name AS athlete
       FROM inventory_units un JOIN inventory_items it ON it.id=un.item_id JOIN venues v ON v.id=un.venue_id
       LEFT JOIN academy_kit_issues i ON i.unit_id=un.id AND i.status IN ('reserved','issued','writeoff_pending') LEFT JOIN users u ON u.id=i.athlete_id
      WHERE v.organisation_id=$1 AND un.serial_no=$2 LIMIT 1`, [orgId, c])).rows[0];
  if (unit) return { kind: 'unit', unit };
  if (/^[0-9a-f-]{36}$/i.test(c)) {
    const i = (await q.query('SELECT i.id, i.status, i.athlete_id, u.display_name AS athlete, it.name, it.size_label FROM academy_kit_issues i JOIN users u ON u.id=i.athlete_id JOIN inventory_items it ON it.id=i.item_id WHERE i.id=$1 AND i.organisation_id=$2', [c, orgId])).rows[0];
    if (i) return { kind: 'issue', issue: i };
  }
  throw notFound('Code');
}

// ------------------------------------------------------------------ replenishment: the existing supply order, ordered from the academy's own supplier
export async function orderReplenishment(c, user, orgId, i) {
  const sup = (await c.query('SELECT * FROM academy_suppliers WHERE id=$1 AND organisation_id=$2', [i.academy_supplier_id, orgId])).rows[0];
  if (!sup) throw notFound('Supplier');
  if (sup.status !== 'active') throw conflict('This supplier is not active');
  const ids = i.lines.map((l) => l.item_id);
  if (new Set(ids).size !== ids.length) throw badRequest('List each item once');
  const items = (await c.query('SELECT it.*, v.organisation_id FROM inventory_items it JOIN venues v ON v.id=it.venue_id WHERE it.id = ANY($1) AND v.organisation_id=$2 AND it.archived_at IS NULL', [ids, orgId])).rows;
  if (items.length !== ids.length) throw notFound('Item');
  const currency = await academyCurrency(c, orgId);
  const est = i.lines.reduce((n, l) => n + (l.unit_cost_cents ?? 0) * l.quantity, 0);
  const summary = i.lines.map((l) => { const it = items.find((x) => x.id === l.item_id); return `${l.quantity} × ${it.name}${it.size_label ? ` (${it.size_label})` : ''}`; }).join(', ').slice(0, 1800);
  const reqRow = (await c.query(
    `INSERT INTO academy_supplier_requests(organisation_id, supplier_id, venue_id, title, details, priority, due_on, currency, estimated_cost_minor, created_by)
     VALUES ($1,$2,NULL,$3,$4,'normal',$5,$6,$7,$8) RETURNING id`,
    [orgId, sup.id, 'Kit replenishment', summary, i.expected_on ?? null, est > 0 ? currency : null, est > 0 ? est : null, user.id])).rows[0];
  const orders = [];
  for (const l of i.lines) {
    const it = items.find((x) => x.id === l.item_id);
    orders.push((await c.query(
      `INSERT INTO supply_orders(item_id, supplier, quantity, expected_on, ordered_by, academy_supplier_id, supplier_request_id, unit_cost_cents, note, ordered_by_org)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [it.id, sup.name, l.quantity, i.expected_on ?? null, user.id, sup.id, reqRow.id, l.unit_cost_cents ?? null, i.note ?? null, orgId])).rows[0]);
  }
  await audit(c, user.id, 'kit_order_replenishment', 'academy_supplier_requests', reqRow.id);
  return { request_id: reqRow.id, orders };
}

export async function listOrders(q, orgId) {
  return (await q.query(
    `SELECT o.id, o.status, o.quantity, o.expected_on, o.received_at, o.unit_cost_cents, o.note, o.supplier, o.academy_supplier_id, o.supplier_request_id, o.created_at, it.id AS item_id, it.name, it.size_label, it.style_key, it.serialised, v.name AS venue
       FROM supply_orders o JOIN inventory_items it ON it.id=o.item_id JOIN venues v ON v.id=it.venue_id WHERE o.ordered_by_org=$1 ORDER BY o.created_at DESC LIMIT 200`, [orgId])).rows;
}

export async function updateOrder(c, user, orgId, orderId, status) {
  const o = (await c.query('SELECT * FROM supply_orders WHERE id=$1 AND ordered_by_org=$2 FOR UPDATE', [orderId, orgId])).rows[0];
  if (!o) throw notFound('Order');
  if (status === 'received') return receiveSupplyOrder(c, o, user.id, { note: 'Kit supply order received' });
  if (['received', 'cancelled'].includes(o.status)) throw conflict(`Order already ${o.status}`);
  return (await c.query('UPDATE supply_orders SET status=$2 WHERE id=$1 RETURNING *', [o.id, status])).rows[0];
}

// ------------------------------------------------------------------ the athlete's or guardian's view, and the receipt
/**
 * What a student (adult) or a guardian sees: each kit item by status, sizes, collection instructions and, only with the guardian's `pay` scope (or for an adult
 * athlete themself), what is owed. Never other athletes, addresses or staff notes. The guardian link is checked live: revoking it ends access at once.
 */
export async function familyKit(user, athleteId, orgId = null) {
  const youth = await isYouth(athleteId);
  let money = true;
  if (athleteId !== user.id || youth) {
    const link = await guardianLink(user.id, athleteId);
    if (!link || !(await guardianCan(link, 'register', orgId))) throw notFound('Athlete');
    money = await guardianCan(link, 'pay', orgId);
  }
  const orgs = (await pool.query(
    `SELECT DISTINCT o.id, o.name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN organisations o ON o.id=k.organisation_id
      WHERE e.user_id=$1 AND e.status IN ('enrolled','paused') AND ($2::uuid IS NULL OR o.id=$2) ORDER BY o.name`, [athleteId, orgId])).rows;
  const out = [];
  for (const org of orgs) {
    const rows = await needs(pool, org.id, null, { athlete_id: athleteId });
    const venues = new Map((await pool.query('SELECT id, name FROM venues WHERE organisation_id=$1', [org.id])).rows.map((v) => [v.id, v.name]));
    const issues = (await pool.query(
      `SELECT i.id, i.status, i.qty, i.issued_at, i.due_back_at, i.charge_id, i.deposit_charge_id, it.name AS item, it.size_label, v.name AS venue, ent.name AS entitlement
         FROM academy_kit_issues i JOIN inventory_items it ON it.id=i.item_id JOIN venues v ON v.id=i.venue_id LEFT JOIN academy_kit_entitlements ent ON ent.id=i.entitlement_id
        WHERE i.organisation_id=$1 AND i.athlete_id=$2 AND i.status <> 'cancelled' ORDER BY i.created_at DESC LIMIT 100`, [org.id, athleteId])).rows;
    const ch = money ? await chargeInfo(pool, issues.flatMap((r) => [r.charge_id, r.deposit_charge_id]).filter(Boolean)) : new Map();
    out.push({
      organisation: org,
      to_collect: rows.filter((r) => r.outstanding > 0).map((r) => ({ entitlement: r.entitlement, style_key: r.style_key, qty: r.outstanding, size: r.size, needs_fitting: r.size_required && !r.size, due_on: r.due_on, collect_at: r.fulfil_venue_id ? venues.get(r.fulfil_venue_id) : null, collection_note: r.collection_note, pay_first: r.require_payment })),
      items: issues.map(({ charge_id, deposit_charge_id, ...r }) => ({ ...r, overdue: r.status === 'issued' && r.due_back_at && new Date(r.due_back_at) < new Date(), ...(money ? { charge: ch.get(charge_id) ?? null, deposit: ch.get(deposit_charge_id) ?? null } : {}) })),
      sizes: (await pool.query('SELECT slot, size_label FROM academy_kit_sizes WHERE organisation_id=$1 AND athlete_id=$2 AND superseded_at IS NULL ORDER BY slot', [org.id, athleteId])).rows,
    });
  }
  await audit(null, user.id, 'kit_view_family', 'users', athleteId);
  return { athlete_id: athleteId, youth, can_see_money: money, organisations: out };
}

/** The issue receipt: structured data plus a plain-text rendering with labelled lines, so a screen reader reads it top to bottom and it can be shared anywhere. */
export async function receipt(user, issueId, { viewerAccess = null } = {}) {
  const r = (await pool.query(
    `SELECT i.*, o.name AS org_name, u.display_name AS athlete, it.name AS item, it.size_label, it.barcode, un.serial_no, v.name AS venue, ent.collection_note, ent.name AS entitlement, cu.display_name AS issued_by_name
       FROM academy_kit_issues i JOIN organisations o ON o.id=i.organisation_id JOIN users u ON u.id=i.athlete_id JOIN inventory_items it ON it.id=i.item_id JOIN venues v ON v.id=i.venue_id
       LEFT JOIN inventory_units un ON un.id=i.unit_id LEFT JOIN academy_kit_entitlements ent ON ent.id=i.entitlement_id LEFT JOIN users cu ON cu.id=i.issued_by WHERE i.id=$1`, [issueId])).rows[0];
  if (!r) throw notFound('Kit issue');
  let money = false;
  if (viewerAccess) money = viewerAccess.money;
  else if (r.athlete_id === user.id && !(await isYouth(r.athlete_id))) money = true;
  else {
    const link = await guardianLink(user.id, r.athlete_id);
    if (!link || !(await guardianCan(link, 'register', r.organisation_id))) throw notFound('Kit issue');
    money = await guardianCan(link, 'pay', r.organisation_id);
  }
  const ch = money ? await chargeInfo(pool, [r.charge_id, r.deposit_charge_id].filter(Boolean)) : new Map();
  const charge = ch.get(r.charge_id) ?? null, deposit = ch.get(r.deposit_charge_id) ?? null;
  const fmt = (m) => (m ? `${(m.amount_minor / 100).toFixed(2)} ${m.currency}, ${m.status.replace('_', ' ')}` : null);
  const date = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const data = {
    number: `KIT-${r.id.slice(0, 8).toUpperCase()}`, language: 'en', organisation: r.org_name, athlete: r.athlete, item: r.item, size: r.size_label, serial_no: r.serial_no, quantity: r.qty, status: r.status,
    venue: r.venue, issued_at: r.issued_at, issued_by: r.issued_by_name, due_back_at: r.due_back_at, collection_note: r.collection_note, charge, deposit,
  };
  const lines = [`Kit issue receipt ${data.number}`, `Academy: ${r.org_name}`, `Athlete: ${r.athlete}`, `Item: ${r.item}${r.size_label ? `, size ${r.size_label}` : ''}${r.serial_no ? `, serial number ${r.serial_no}` : ''}`, `Quantity: ${r.qty}`,
    `Status: ${r.status.replace('_', ' ')}`, `Issued at: ${r.venue}${r.issued_at ? ` on ${date(r.issued_at)}` : ''}`, r.issued_by_name ? `Issued by: ${r.issued_by_name}` : null,
    r.due_back_at ? `Return by: ${date(r.due_back_at)}` : 'This kit is yours to keep.', fmt(charge) ? `Fee: ${fmt(charge)}` : null, fmt(deposit) ? `Refundable deposit: ${fmt(deposit)}` : null,
    r.collection_note ? `Collection: ${r.collection_note}` : null].filter(Boolean);
  await audit(null, user.id, 'kit_receipt', 'academy_kit_issues', r.id);
  return { ...data, text: lines.join('\n') };
}

export { forbidden, applies };
