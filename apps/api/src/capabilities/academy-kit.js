// Academy uniforms, kits & equipment issuance (#798): entitlements by programme / group / squad, fittings, issue, return, exchange, damaged-or-lost approvals,
// the dashboard, replenishment from the academy's suppliers, serial-numbered units, scanner lookups, and the athlete's / guardian's kit status and receipts.
// One definition feeds REST, OpenAPI and MCP. Stock is the venues' own `inventory_items` and its append-only ledger, money is the academy's own charges and
// invoices, orders are `supply_orders`: see src/kit.js. Authorisation is enforced here on the server, never only in the app.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import {
  kitAccess, issueKit, handoverKit, cancelReserved, returnKit, exchangeKit, requestWriteoff, decideWriteoff, finishProviderRefund, listIssues, issueView,
} from '../kit.js';
import {
  dueList, shortages, dashboard, catalogue, listEntitlements, checkScope, checkProduct, setSize, getSizes, addUnits, resolveCode, orderReplenishment, listOrders, updateOrder, familyKit, receipt,
} from '../kit-reports.js';
import { SLOT_KEYS } from '../kit-slots.js';

const TAG = 'Academy kit';
const ref = z.string().trim().min(8).max(80).optional().describe('your own unique key for this action: sending it again returns the first result instead of repeating it');
const short = (n) => z.string().trim().min(1).max(n);
const styleKey = z.string().trim().min(2).max(60).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'letters, numbers, dot, dash or underscore');

/** Run a write inside one transaction with the caller's kit access; a retry carrying the same client_ref after a race returns the first result. */
async function work(user, orgId, need, venueId, fn, replay) {
  try {
    return await tx(async (c) => fn({ c, ...(await kitAccess(user, orgId, { need, venueId, c })) }));
  } catch (e) {
    if (e.code === '23505' && /academy_kit_issues_ref/.test(e.constraint ?? e.message ?? '') && replay) return replay();
    throw e;
  }
}
const strip = (r) => { if (!r) return r; const { _provider_refund, ...rest } = r; return rest; };
async function closeRefund(user, orgId, r) {
  const out = strip(r);
  if (out?.deposit?.provider_refund) out.deposit = await finishProviderRefund(user, out.deposit, out.id, orgId);
  return out;
}

// ------------------------------------------------------------------ entitlements
const entFields = {
  name: short(120), scope_type: z.enum(['programme', 'cohort', 'team']).describe('programme, group (cohort) or squad (team)'), scope_id: id,
  style_key: styleKey.describe('the product: pick it from the stock catalogue; the athlete\'s size picks the stock row'), kit_slot: z.enum(SLOT_KEYS).optional(),
  qty: z.number().int().min(1).max(20).default(1), mode: z.enum(['included', 'charged', 'deposit']).default('included').describe('included in the fee, charged on top, or loaned against a refundable deposit'),
  price_minor: z.number().int().min(0).max(1e9).optional(), deposit_minor: z.number().int().min(0).max(1e9).optional(), require_payment: z.boolean().default(false),
  due_rule: z.enum(['on_enrolment', 'days_after']).default('on_enrolment'), due_days: z.number().int().min(0).max(365).default(0),
  replace_after_months: z.number().int().min(1).max(120).optional(), return_days: z.number().int().min(1).max(1095).optional().describe('loan kit comes back after this many days'),
  size_required: z.boolean().default(true), fulfil_venue_id: id.optional(), collection_note: short(500).optional(),
};
function checkEnt(e) {
  if (e.mode === 'charged' && e.deposit_minor) throw badRequest('A charged item has a price, not a deposit');
  if (e.mode === 'deposit' && e.price_minor) throw badRequest('A deposit item has a deposit, not a price');
  if (e.mode === 'deposit' && !e.return_days) throw badRequest('Say after how many days a deposit item comes back');
  if (e.mode === 'included' && (e.price_minor || e.deposit_minor || e.require_payment)) throw badRequest('Included kit has no price, deposit or payment gate');
}

cap({
  name: 'list_academy_kit_catalogue', method: 'GET', path: '/organisations/:id/academy/kit/catalogue', tag: TAG,
  summary: 'The products the academy\'s venues stock (grouped by product key, with every size and its quantity) and the kit slots suggested for the academy\'s sports, labelled when a sport only has the common-wardrobe fallback. Feeds the entitlement form.',
  input: z.object({ id, venue_id: id.optional().describe('the venue desk you are working at (lets desk staff who are not academy members use this)') }),
  handler: async ({ user }, i) => { await kitAccess(user, i.id, { need: 'read', venueId: i.venue_id ?? null }); return catalogue(pool, i.id); },
});

cap({
  name: 'create_academy_kit_entitlement', method: 'POST', path: '/organisations/:id/academy/kit/entitlements', tag: TAG, status: 201,
  summary: 'Say what a programme, group or squad is owed: the product (stock catalogue), quantity, whether it is included, charged or loaned against a deposit, when it is due, when it must be replaced or returned and where it is collected. Needs the kit permission.',
  input: z.object({ id, ...entFields }),
  handler: ({ user }, i) => work(user, i.id, 'manage', null, async ({ c }) => {
    checkEnt(i);
    await checkScope(c, i.id, i.scope_type, i.scope_id);
    if (i.fulfil_venue_id) await c.query('SELECT 1 FROM venues WHERE id=$1 AND organisation_id=$2', [i.fulfil_venue_id, i.id]).then((r) => { if (!r.rowCount) throw notFound('Venue'); });
    await checkProduct(c, i.id, i.style_key, i.fulfil_venue_id);
    const { id: orgId, ...f } = i;
    try {
      const r = (await c.query(
        `INSERT INTO academy_kit_entitlements(organisation_id, name, scope_type, scope_id, style_key, kit_slot, qty, mode, price_minor, deposit_minor, require_payment, due_rule, due_days, replace_after_months, return_days, size_required, fulfil_venue_id, collection_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [orgId, f.name, f.scope_type, f.scope_id, f.style_key, f.kit_slot ?? null, f.qty, f.mode, f.price_minor ?? null, f.deposit_minor ?? null, f.require_payment, f.due_rule, f.due_days, f.replace_after_months ?? null, f.return_days ?? null, f.size_required, f.fulfil_venue_id ?? null, f.collection_note ?? null, user.id])).rows[0];
      await audit(c, user.id, 'create_academy_kit_entitlement', 'academy_kit_entitlements', r.id);
      return r;
    } catch (e) { if (e.code === '23505') throw conflict('That programme, group or squad already has this product. Edit the existing entitlement.'); throw e; }
  }),
});

cap({
  name: 'list_academy_kit_entitlements', method: 'GET', path: '/organisations/:id/academy/kit/entitlements', tag: TAG,
  summary: 'Kit entitlements by programme, group or squad. Coaches and staff with roster access see what an athlete should have; only kit managers see prices and deposits.',
  input: z.object({ id, include_archived: z.coerce.boolean().optional() }),
  async handler({ user }, i) {
    const acc = await kitAccess(user, i.id, { need: 'read' });
    const rows = await listEntitlements(pool, i.id, i.include_archived);
    return acc.manage ? rows : rows.map(({ price_minor, deposit_minor, require_payment, ...r }) => r);
  },
});

cap({
  name: 'update_academy_kit_entitlement', method: 'PATCH', path: '/academy/kit/entitlements/:id', tag: TAG,
  summary: 'Change an entitlement, or archive it (kit already issued under it keeps its history). The product and the programme/group/squad it applies to cannot change: archive it and add a new one.',
  input: z.object({ id, row_version: z.number().int().min(1), name: short(120).optional(), qty: entFields.qty.optional(), mode: entFields.mode.optional(), price_minor: entFields.price_minor.nullable().optional(), deposit_minor: entFields.deposit_minor.nullable().optional(),
    require_payment: z.boolean().optional(), due_rule: entFields.due_rule.optional(), due_days: entFields.due_days.optional(), replace_after_months: z.number().int().min(1).max(120).nullable().optional(), return_days: z.number().int().min(1).max(1095).nullable().optional(),
    size_required: z.boolean().optional(), fulfil_venue_id: id.nullable().optional(), collection_note: short(500).nullable().optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    const cur = (await pool.query('SELECT * FROM academy_kit_entitlements WHERE id=$1', [i.id])).rows[0];
    if (!cur) throw notFound('Entitlement');
    return work(user, cur.organisation_id, 'manage', null, async ({ c }) => {
      const lock = (await c.query('SELECT * FROM academy_kit_entitlements WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (lock.row_version !== i.row_version) throw conflict('Someone else changed this entitlement. Reload and try again.', { row_version: lock.row_version });
      const pick = (k) => (i[k] === undefined ? lock[k] : i[k]);
      const next = { mode: pick('mode'), price_minor: pick('price_minor'), deposit_minor: pick('deposit_minor'), require_payment: pick('require_payment'), return_days: pick('return_days') };
      checkEnt(next);
      if (i.fulfil_venue_id) await orgVenueCheck(c, lock.organisation_id, i.fulfil_venue_id);
      const r = (await c.query(
        `UPDATE academy_kit_entitlements SET name=$2, qty=$3, mode=$4, price_minor=$5, deposit_minor=$6, require_payment=$7, due_rule=$8, due_days=$9, replace_after_months=$10, return_days=$11, size_required=$12, fulfil_venue_id=$13, collection_note=$14,
                archived_at=CASE WHEN $15::boolean IS NULL THEN archived_at WHEN $15 THEN coalesce(archived_at, now()) ELSE NULL END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [lock.id, pick('name'), pick('qty'), next.mode, next.price_minor, next.deposit_minor, next.require_payment, pick('due_rule'), pick('due_days'), pick('replace_after_months'), next.return_days, pick('size_required'), pick('fulfil_venue_id'), pick('collection_note'), i.archived ?? null])).rows[0];
      await audit(c, user.id, 'update_academy_kit_entitlement', 'academy_kit_entitlements', r.id);
      return r;
    });
  },
});
async function orgVenueCheck(c, orgId, venueId) {
  if (!(await c.query('SELECT 1 FROM venues WHERE id=$1 AND organisation_id=$2', [venueId, orgId])).rowCount) throw notFound('Venue');
}

// ------------------------------------------------------------------ fittings
cap({
  name: 'set_academy_kit_size', method: 'POST', path: '/organisations/:id/academy/kit/sizes', tag: TAG,
  summary: 'Record an athlete\'s fitted size for a kit slot (shirt, boots, racket grip …). The previous size is kept as history. A fitting note about the athlete\'s body is encrypted and only kit managers can read it.',
  input: z.object({ id, athlete_id: id, slot: z.string().trim().min(2).max(60), size_label: short(20), fit_note: short(300).optional(), venue_id: id.optional().describe('the venue desk you are working at (lets desk staff who are not academy members use this)') }),
  handler: ({ user }, i) => work(user, i.id, 'issue', i.venue_id ?? null, ({ c }) => setSize(c, user, i.id, i)),
});

cap({
  name: 'get_academy_kit_sizes', method: 'GET', path: '/organisations/:id/academy/kit/sizes/:athlete_id', tag: TAG,
  summary: 'The sizes on file for one athlete. Fit notes are included only for kit managers, and reading them is audit-logged.',
  input: z.object({ id, athlete_id: id, venue_id: id.optional().describe('the venue desk you are working at (lets desk staff who are not academy members use this)') }),
  async handler({ user }, i) {
    const acc = await kitAccess(user, i.id, { need: 'read', venueId: i.venue_id ?? null });
    return tx((c) => getSizes(c, user, i.id, i.athlete_id, { notes: acc.manage }));
  },
});

// ------------------------------------------------------------------ what is due, issues
cap({
  name: 'list_academy_kit_due', method: 'GET', path: '/organisations/:id/academy/kit/due', tag: TAG,
  summary: 'Kit that is due: each athlete × entitlement still short of what they are owed, with their size on file, whether they still need a fitting, whether the venue has it in stock, due date and collection point. Filter by group, programme, athlete or status (overdue, needs_fitting, short). No addresses, contact details or payment data.',
  input: z.object({ id, cohort_id: id.optional(), programme_id: id.optional(), athlete_id: id.optional(), q: z.string().trim().max(80).optional(), status: z.enum(['overdue', 'needs_fitting', 'short']).optional(), venue_id: id.optional().describe('the venue desk you are working at (lets desk staff who are not academy members use this)'), ...page }),
  async handler({ user }, i) { const acc = await kitAccess(user, i.id, { need: 'read', venueId: i.venue_id ?? null }); return dueList(pool, i.id, acc, i); },
});

cap({
  name: 'issue_academy_kit', method: 'POST', path: '/organisations/:id/academy/kit/issues', tag: TAG, status: 201, scope: 'payment',
  summary: 'Hand an athlete their kit from a venue\'s stock. The stock row is locked and decremented atomically, so two desks can never issue the last unit; the movement is written to the stock ledger. Charged kit and deposits are raised on the academy\'s own charges (collect them at the desk or online); if the entitlement requires payment first the item is reserved until it is paid. client_ref makes a retry safe. Desk staff of the venue may issue entitled kit; anything else needs the kit permission.',
  input: z.object({ id, enrolment_id: id, venue_id: id, entitlement_id: id.optional(), item_id: id.optional(), size_label: short(20).optional(), qty: z.number().int().min(1).max(20).default(1), unit_id: id.optional(), serial_no: short(80).optional(), note: short(300).optional(), client_ref: ref }),
  handler: ({ user }, i) => work(user, i.id, 'issue', i.venue_id, (ctx) => issueKit(user, ctx, i.id, i),
    i.client_ref ? async () => ({ ...(await issueView(pool, (await pool.query('SELECT id FROM academy_kit_issues WHERE organisation_id=$1 AND client_ref=$2', [i.id, i.client_ref])).rows[0].id, { money: false })), replayed: true }) : null),
});

cap({
  name: 'handover_academy_kit', method: 'POST', path: '/organisations/:id/academy/kit/issues/:issue_id/handover', tag: TAG,
  summary: 'Hand over an item that was reserved until its fee or deposit was paid. Refused (409 kit_payment_required, with the charge) while anything is still owed.',
  input: z.object({ id, issue_id: id }),
  handler: async ({ user }, i) => work(user, i.id, 'issue', await issueVenue(i.issue_id), (ctx) => handoverKit(user, ctx, i.id, i.issue_id)),
});

cap({
  name: 'cancel_academy_kit_reservation', method: 'POST', path: '/organisations/:id/academy/kit/issues/:issue_id/cancel', tag: TAG,
  summary: 'Release a reserved item before it left the desk: the stock goes back and unpaid charges are cancelled.',
  input: z.object({ id, issue_id: id }),
  handler: async ({ user }, i) => work(user, i.id, 'issue', await issueVenue(i.issue_id), (ctx) => cancelReserved(user, ctx, i.id, i.issue_id)),
});

async function issueVenue(issueId) { return (await pool.query('SELECT venue_id FROM academy_kit_issues WHERE id=$1', [issueId])).rows[0]?.venue_id ?? null; }

cap({
  name: 'return_academy_kit', method: 'POST', path: '/organisations/:id/academy/kit/issues/:issue_id/return', tag: TAG, scope: 'payment',
  summary: 'Take kit back. Good or worn goes back on the shelf (ledger line, serial back in stock) and an unused/paid deposit is released: an unpaid one is cancelled, a paid one is refunded through the academy\'s credit note (online deposits through the provider). Returned damaged goes to a manager for approval instead. Returning twice is refused.',
  input: z.object({ id, issue_id: id, condition: z.enum(['good', 'worn', 'damaged']).default('good'), note: short(300).optional() }),
  handler: async ({ user }, i) => closeRefund(user, i.id, await work(user, i.id, 'issue', await issueVenue(i.issue_id), (ctx) => returnKit(user, ctx, i.id, i.issue_id, i))),
});

cap({
  name: 'exchange_academy_kit', method: 'POST', path: '/organisations/:id/academy/kit/issues/:issue_id/exchange', tag: TAG, status: 201,
  summary: 'Swap issued kit for another size or item in one step: the old unit goes back on the shelf, the new one comes off it, and the fee and deposit stay with the entitlement. Refused if the new size is not in stock.',
  input: z.object({ id, issue_id: id, item_id: id.optional(), size_label: short(20).optional(), unit_id: id.optional(), serial_no: short(80).optional(), reason: z.enum(['wrong_size', 'growth', 'defect', 'other']).default('wrong_size'), client_ref: ref }).refine((v) => v.item_id || v.size_label, 'Choose the new size or item'),
  handler: async ({ user }, i) => work(user, i.id, 'issue', await issueVenue(i.issue_id), (ctx) => exchangeKit(user, ctx, i.id, i.issue_id, i)),
});

cap({
  name: 'report_academy_kit', method: 'POST', path: '/organisations/:id/academy/kit/issues/:issue_id/report', tag: TAG,
  summary: 'Report issued kit damaged or lost. It waits for a manager\'s decision; nothing is written off and no deposit is touched until then.',
  input: z.object({ id, issue_id: id, kind: z.enum(['damaged', 'lost']), note: short(300) }),
  handler: async ({ user }, i) => work(user, i.id, 'issue', await issueVenue(i.issue_id), (ctx) => requestWriteoff(user, ctx, i.id, i.issue_id, i)),
});

cap({
  name: 'decide_academy_kit_report', method: 'POST', path: '/organisations/:id/academy/kit/issues/:issue_id/decision', tag: TAG, scope: 'payment',
  summary: 'A kit manager approves or rejects a damaged/lost report. Approving takes the unit out of circulation, keeps forfeit_minor of the deposit (default all) and refunds the rest; replacement_minor raises a replacement fee on the academy\'s charges. A different manager must decide (owners/admins may decide their own, which is flagged in the audit trail).',
  input: z.object({ id, issue_id: id, decision: z.enum(['approved', 'rejected']), forfeit_minor: z.number().int().min(0).max(1e9).optional(), replacement_minor: z.number().int().min(1).max(1e9).optional(), note: short(300).optional() }),
  handler: async ({ user }, i) => closeRefund(user, i.id, await work(user, i.id, 'manage', null, (ctx) => decideWriteoff(user, ctx, i.id, i.issue_id, i))),
});

cap({
  name: 'list_academy_kit_issues', method: 'GET', path: '/organisations/:id/academy/kit/issues', tag: TAG,
  summary: 'Issued kit and its state (reserved, issued, returned, exchanged, waiting for a decision, written off). Filter by status, athlete, venue, overdue returns or text. Amounts appear only for kit managers.',
  input: z.object({ id, status: z.enum(['reserved', 'issued', 'returned', 'exchanged', 'writeoff_pending', 'written_off', 'cancelled']).optional(), athlete_id: id.optional(), venue_id: id.optional(), overdue: z.coerce.boolean().optional(), q: z.string().trim().max(80).optional(), ...page }),
  async handler({ user }, i) { const acc = await kitAccess(user, i.id, { need: 'read', venueId: i.venue_id ?? null }); return listIssues(pool, i.id, i, { money: acc.money }); },
});

cap({
  name: 'get_academy_kit_issue', method: 'GET', path: '/organisations/:id/academy/kit/issues/:issue_id', tag: TAG,
  summary: 'One issue with its full history (who did what, when). Amounts only for kit managers.',
  input: z.object({ id, issue_id: id }),
  async handler({ user }, i) {
    const acc = await kitAccess(user, i.id, { need: 'read', venueId: await issueVenue(i.issue_id) });
    if (!(await pool.query('SELECT 1 FROM academy_kit_issues WHERE id=$1 AND organisation_id=$2', [i.issue_id, i.id])).rowCount) throw notFound('Kit issue');
    const events = (await pool.query('SELECT e.kind, e.data, e.created_at, u.display_name AS actor FROM academy_kit_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.issue_id=$1 ORDER BY e.created_at, e.id', [i.issue_id])).rows;
    return { ...(await issueView(pool, i.issue_id, { money: acc.money })), events: acc.manage ? events : events.map(({ data, ...r }) => r) };
  },
});

// ------------------------------------------------------------------ stock side
cap({
  name: 'get_academy_kit_dashboard', method: 'GET', path: '/organisations/:id/academy/kit/dashboard', tag: TAG,
  summary: 'Kit at a glance: coverage of what athletes are owed, what is due or overdue, athletes waiting for a fitting, kit on loan and overdue returns, reports waiting for a decision, low stock, and shortages by size against stock and orders. Kit managers also see deposits held and unpaid kit fees.',
  input: z.object({ id, venue_id: id.optional().describe('the venue desk you are working at (lets desk staff who are not academy members use this)') }),
  async handler({ user }, i) { const acc = await kitAccess(user, i.id, { need: 'read', venueId: i.venue_id ?? null }); return dashboard(pool, i.id, acc); },
});

cap({
  name: 'get_academy_kit_replenishment', method: 'GET', path: '/organisations/:id/academy/kit/replenishment', tag: TAG,
  summary: 'What to reorder: demand by product and size (athletes still owed kit) against stock on hand and quantities already on order, the short fall, sizes that are not stocked at all, and the open orders.',
  input: z.object({ id }),
  async handler({ user }, i) { const acc = await kitAccess(user, i.id, { need: 'read' }); return { lines: await shortages(pool, i.id, acc), orders: acc.manage ? await listOrders(pool, i.id) : [], suppliers: acc.manage ? (await pool.query("SELECT id, name, kind FROM academy_suppliers WHERE organisation_id=$1 AND status='active' ORDER BY name", [i.id])).rows : [] }; },
});

cap({
  name: 'order_academy_kit_replenishment', method: 'POST', path: '/organisations/:id/academy/kit/orders', tag: TAG, status: 201,
  summary: 'Order stock from one of the academy\'s own suppliers: a supplier request with one supply-order line per size row. Receiving a line adds it to stock and the ledger. Needs the kit permission.',
  input: z.object({ id, academy_supplier_id: id, lines: z.array(z.object({ item_id: id, quantity: z.number().int().min(1).max(100000), unit_cost_cents: z.number().int().min(0).max(1e9).optional() })).min(1).max(60), expected_on: z.string().date().optional(), note: short(300).optional() }),
  handler: ({ user }, i) => work(user, i.id, 'manage', null, ({ c }) => orderReplenishment(c, user, i.id, i)),
});

cap({
  name: 'update_academy_kit_order', method: 'PATCH', path: '/organisations/:id/academy/kit/orders/:order_id', tag: TAG,
  summary: 'Move a kit supply-order line along: shipped, received (adds the quantity to stock and the ledger; serial-numbered kit is received with add_academy_kit_units instead) or cancelled.',
  input: z.object({ id, order_id: id, status: z.enum(['shipped', 'received', 'cancelled']) }),
  handler: ({ user }, i) => work(user, i.id, 'manage', null, async ({ c }) => { const r = await updateOrder(c, user, i.id, i.order_id, i.status); await audit(c, user.id, 'kit_update_order', 'supply_orders', i.order_id); return r; }),
});

cap({
  name: 'add_academy_kit_units', method: 'POST', path: '/organisations/:id/academy/kit/units', tag: TAG, status: 201,
  summary: 'Register serial-numbered units (rackets, goalkeeper gloves, trackers) into stock, optionally closing the supply-order line they arrived on. Each serial is unique per venue; stock and the ledger move together.',
  input: z.object({ id, item_id: id, serials: z.array(short(80)).min(1).max(500), order_id: id.optional(), note: short(200).optional() }),
  handler: ({ user }, i) => work(user, i.id, 'manage', null, ({ c }) => addUnits(c, user, i.id, i)),
});

cap({
  name: 'resolve_academy_kit_code', method: 'GET', path: '/organisations/:id/academy/kit/resolve', tag: TAG,
  summary: 'What a barcode, QR code or serial number refers to: a stock row, a serial-numbered unit (and who holds it) or an issue. Used by the mobile scanner and by keyboard-style scanners at a desk.',
  input: z.object({ id, code: z.string().trim().min(1).max(120), venue_id: id.optional() }),
  async handler({ user }, i) { await kitAccess(user, i.id, { need: 'issue', venueId: i.venue_id ?? null }); return resolveCode(pool, i.id, i.code); },
});

// ------------------------------------------------------------------ the athlete / guardian
cap({
  name: 'get_my_academy_kit', method: 'GET', path: '/me/academy/kit', tag: TAG,
  summary: 'Your kit (or, with athlete_id, a young person you are a verified guardian of): what is to collect and where, what you hold and when it is due back, your sizes and, if you can pay for them, what is owed. Guardian authority is checked live; other athletes and staff notes are never shown.',
  input: z.object({ athlete_id: id.optional(), organisation_id: id.optional() }),
  handler: ({ user }, i) => familyKit(user, i.athlete_id ?? user.id, i.organisation_id ?? null),
});

cap({
  name: 'get_academy_kit_receipt', method: 'GET', path: '/academy/kit/issues/:id/receipt', tag: TAG,
  summary: 'The issue receipt as structured data and as plain text with labelled lines (readable by a screen reader and shareable anywhere): who, what, size, serial, where, return date, collection instructions and, for those who may see it, the fee and deposit. Available to the athlete, their verified guardian and the academy\'s kit staff.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = (await pool.query('SELECT organisation_id, venue_id FROM academy_kit_issues WHERE id=$1', [i.id])).rows[0];
    if (!row) throw notFound('Kit issue');
    let acc = null;
    try { acc = await kitAccess(user, row.organisation_id, { need: 'read', venueId: row.venue_id }); } catch { acc = null; }
    return receipt(user, i.id, { viewerAccess: acc });
  },
});
