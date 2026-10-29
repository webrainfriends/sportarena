// Supplier services (#458) 2/5 — buyer side: procurement contexts (organisation, school/academy, venue, event or person), delegated roles and
// approval policy, lots, service requirements and the planning overview. A school buys through its organisation with no event required.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { assertCurrency, checkQty } from '../svc/money.js';
import { CATEGORY, validateSpec, assertUnit } from '../svc/catalogue.js';
import { CREDENTIAL_KINDS } from './svc-supplier.js';
import { buyerAccess, resolveBuyer, myBuyerIds, log } from '../svc/access.js';

const TAG = 'Service procurement';
const cur = z.string().length(3).transform((s) => s.toUpperCase());
const ts = z.string().datetime({ offset: true });
const day = z.string().date();

cap({
  name: 'open_service_buyer', method: 'POST', path: '/service-buyers', tag: TAG, status: 201,
  summary: 'Open (or fetch) the procurement context you buy through: an event you manage, a venue you run, a school/academy organisation you own or administer, or yourself. Idempotent per context.',
  input: z.object({ event_id: id.optional(), venue_id: id.optional(), organisation_id: id.optional(), currency: cur.optional() }),
  async handler({ user }, i) {
    if ([i.event_id, i.venue_id, i.organisation_id].filter(Boolean).length > 1) throw badRequest('Choose one context: an event, a venue or an organisation');
    if (i.currency) assertCurrency(i.currency);
    return resolveBuyer(user, i);
  },
});
cap({
  name: 'list_my_service_buyers', method: 'GET', path: '/me/service-buyers', tag: TAG, summary: 'Procurement contexts you can act in, with your roles.',
  async handler({ user }) {
    const ids = await myBuyerIds(user);
    const rows = await many('SELECT * FROM svc_buyers WHERE id = ANY($1) ORDER BY created_at, id', [ids]);
    return Promise.all(rows.map(async (b) => { const a = await buyerAccess(user, b.id, null); return { ...b, my_roles: [...a.roles], my_limits: a.limits }; }));
  },
});
cap({
  name: 'set_buyer_approval_policy', method: 'PATCH', path: '/service-buyers/:id/policy', tag: TAG,
  summary: 'Set approval thresholds: awards above `up_to_minor` need an approver (not the requester). Empty thresholds = the purchaser may award directly. single_supplier_justification forces a written reason when only one quote is awarded.',
  input: z.object({ id, thresholds: z.array(z.object({ above_minor: money })).max(10).default([]), single_supplier_justification: z.boolean().default(true), require_invoice_match: z.boolean().default(true) }),
  async handler({ user }, i) {
    const a = await buyerAccess(user, i.id, ['purchaser']);
    if (!a.owner) throw forbidden('Only the owner of this procurement context can change its policy');
    const r = await one('UPDATE svc_buyers SET approval_policy=$2 WHERE id=$1 RETURNING *', [i.id, { thresholds: i.thresholds, single_supplier_justification: i.single_supplier_justification, require_invoice_match: i.require_invoice_match }]);
    await log({ query: (t, p) => one(t, p) }, 'buyer', i.id, user.id, 'policy_set', r.approval_policy);
    return r;
  },
});
cap({
  name: 'grant_buyer_role', method: 'POST', path: '/service-buyers/:id/roles', tag: TAG, status: 201,
  summary: 'Delegate a procurement role (requester, evaluator, approver, purchaser, service acceptor, finance), optionally with a spend limit. Organisation membership alone grants none of these.',
  input: z.object({ id, person: z.string().min(1).max(80).optional().describe('handle'), user_id: id.optional().describe('or pick the person by id'), role: z.enum(['requester', 'evaluator', 'approver', 'purchaser', 'acceptor', 'finance']), limit_minor: money.optional() }),
  async handler({ user }, i) {
    const a = await buyerAccess(user, i.id, ['purchaser']);
    if (!a.owner) throw forbidden('Only the owner of this procurement context can delegate roles');
    if (!i.person && !i.user_id) throw badRequest('Say who: a handle or a person');
    const u = await one(i.user_id ? 'SELECT id FROM users WHERE id=$1' : 'SELECT id FROM users WHERE handle=$1', [i.user_id ?? i.person.replace(/^@/, '')]);
    if (!u) throw notFound('Person');
    try { const r = await one('INSERT INTO svc_buyer_roles(buyer_id, user_id, role, limit_minor, granted_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.id, u.id, i.role, i.limit_minor ?? null, user.id]); return r; }
    catch (e) { if (e.code === '23505') throw conflict('They already hold that role'); throw e; }
  },
});
cap({
  name: 'revoke_buyer_role', method: 'DELETE', path: '/service-buyer-roles/:id', tag: TAG, summary: 'Revoke a delegated role at once; their past actions stay on record.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r0 = await one('SELECT * FROM svc_buyer_roles WHERE id=$1', [i.id]);
    if (!r0) throw notFound('Role');
    const a = await buyerAccess(user, r0.buyer_id, ['purchaser']);
    if (!a.owner) throw forbidden('Only the owner can revoke roles');
    return one("UPDATE svc_buyer_roles SET status='revoked', revoked_at=now() WHERE id=$1 RETURNING *", [i.id]);
  },
});
cap({
  name: 'list_buyer_roles', method: 'GET', path: '/service-buyers/:id/roles', tag: TAG, summary: 'Who holds which procurement role here.',
  input: z.object({ id }),
  async handler({ user }, i) { await buyerAccess(user, i.id, null); return many("SELECT r.id, r.role, r.limit_minor, r.user_id, u.display_name, u.handle FROM svc_buyer_roles r JOIN users u ON u.id=r.user_id WHERE r.buyer_id=$1 AND r.status='active' ORDER BY r.created_at", [i.id]); },
});

// ---------------------------------------------------------------- lots
cap({
  name: 'create_service_lot', method: 'POST', path: '/service-buyers/:id/lots', tag: TAG, status: 201,
  summary: 'Split a tournament / programme into lots (pitch preparation, crew, Wi-Fi, transport, rooms). Different suppliers may win different lots.',
  input: z.object({ id, name: z.string().min(1).max(120), budget_minor: money.optional() }),
  async handler({ user }, i) {
    const { buyer } = await buyerAccess(user, i.id, ['requester']);
    try { return await one('INSERT INTO svc_lots(buyer_id, name, budget_minor, currency, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.id, i.name, i.budget_minor ?? null, buyer.currency, user.id]); }
    catch (e) { if (e.code === '23505') throw conflict('A lot with that name already exists'); throw e; }
  },
});
cap({
  name: 'list_service_lots', method: 'GET', path: '/service-buyers/:id/lots', tag: TAG, summary: 'Lots of a procurement context.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) { await buyerAccess(user, i.id, null); return many("SELECT * FROM svc_lots WHERE buyer_id=$1 AND status <> 'archived' ORDER BY created_at, id LIMIT $2 OFFSET $3", [i.id, i.limit, i.offset]); },
});

// ---------------------------------------------------------------- requirements
const reqFields = {
  category: z.string(), subcategory: z.string().max(80).optional(), title: z.string().min(1).max(160), scope: z.record(z.string(), z.any()).default({}),
  quantity: z.number().positive().max(1e9), unit: z.string(), headcount: z.number().int().positive().max(100000).optional(),
  starts_at: ts.optional(), ends_at: ts.optional(), timezone: z.string().max(60).default('UTC'),
  recurrence: z.object({ freq: z.enum(['daily', 'weekly', 'monthly']), by_day: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).max(7).optional(), until: day }).optional(),
  site_access: z.string().max(500).optional(), qualifications: z.array(z.string().max(80)).max(20).default([]), budget_minor: money.optional(), currency: cur.optional(),
  owner_id: id.optional(), depends_on: z.array(id).max(20).default([]), deadline: day.optional(), acceptance_criteria: z.array(z.string().min(1).max(300)).max(20).default([]),
  lot_id: id.optional(), event_id: id.optional(), venue_id: id.optional(), competition_id: id.optional(),
  compliance_kinds: z.array(z.enum(CREDENTIAL_KINDS)).max(9).default([]),
};
const check = async (c, buyer, i) => {
  const cat = CATEGORY[i.category];
  if (!cat) throw badRequest(`Unknown service category: ${i.category}`);
  assertUnit(i.category, i.unit); checkQty(i.quantity); assertCurrency(i.currency ?? buyer.currency);
  if (i.starts_at && i.ends_at && i.ends_at < i.starts_at) throw badRequest('ends_at is before starts_at');
  if (i.recurrence && !i.starts_at) throw badRequest('A recurring requirement needs a start');
  if (i.event_id && buyer.event_id && i.event_id !== buyer.event_id) throw badRequest('That event is not this procurement context');
  if (i.competition_id && !(await c.query('SELECT 1 FROM events WHERE id=$1', [i.competition_id])).rowCount) throw notFound('Competition');
  if (i.lot_id && !(await c.query('SELECT 1 FROM svc_lots WHERE id=$1 AND buyer_id=$2', [i.lot_id, buyer.id])).rowCount) throw notFound('Lot');
  if (i.depends_on?.length && (await c.query('SELECT 1 FROM svc_requirements WHERE id = ANY($1) AND buyer_id=$2', [i.depends_on, buyer.id])).rowCount !== new Set(i.depends_on).size) throw badRequest('A dependency is not a requirement of this procurement context');
  if (i.owner_id && !(await c.query('SELECT 1 FROM users WHERE id=$1', [i.owner_id])).rowCount) throw notFound('Owner');
  return validateSpec(i.category, i.scope);
};

cap({
  name: 'create_service_requirement', method: 'POST', path: '/service-buyers/:id/requirements', tag: TAG, status: 201,
  summary: 'Plan a service requirement with typed scope (validated against the catalogue), quantity/unit, dates & timezone, recurrence, budget, owner, dependencies and measurable acceptance criteria.',
  input: z.object({ id, ...reqFields }),
  async handler({ user }, i) {
    const { id: bid, ...r } = i;
    return tx(async (c) => {
      const { buyer } = await buyerAccess(user, bid, ['requester'], c);
      r.scope = await check(c, buyer, r);
      return (await c.query(
        `INSERT INTO svc_requirements(buyer_id, lot_id, event_id, venue_id, category, subcategory, title, scope, quantity, unit, headcount, starts_at, ends_at, timezone, recurrence, site_access, qualifications, budget_minor, currency, owner_id, depends_on, deadline, acceptance_criteria, created_by, competition_id, compliance_kinds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
        [bid, r.lot_id ?? null, r.event_id ?? buyer.event_id ?? null, r.venue_id ?? buyer.venue_id ?? null, r.category, r.subcategory ?? null, r.title, r.scope, r.quantity, r.unit, r.headcount ?? null, r.starts_at ?? null, r.ends_at ?? null, r.timezone,
          r.recurrence ?? null, r.site_access ?? null, r.qualifications, r.budget_minor ?? null, r.currency ?? buyer.currency, r.owner_id ?? null, r.depends_on, r.deadline ?? null, r.acceptance_criteria, user.id, r.competition_id ?? null, r.compliance_kinds])).rows[0];
    });
  },
});
cap({
  name: 'update_service_requirement', method: 'PATCH', path: '/service-requirements/:id', tag: TAG,
  summary: 'Edit a requirement (row_version checked). Once an RFQ is issued, scope edits go through the RFQ (a new scope version) — only draft requirements are edited here.',
  input: z.object({ id, row_version: z.number().int(), ...Object.fromEntries(Object.entries(reqFields).map(([k, v]) => [k, v.optional()])) }),
  async handler({ user }, i) {
    const { id: rid, row_version, ...rest } = i;
    return tx(async (c) => {
      const cur0 = (await c.query('SELECT * FROM svc_requirements WHERE id=$1 FOR UPDATE', [rid])).rows[0];
      if (!cur0) throw notFound('Requirement');
      const { buyer } = await buyerAccess(user, cur0.buyer_id, ['requester'], c);
      if (cur0.status !== 'draft') throw conflict('This requirement is already out for quotes; change its scope through the RFQ so every supplier quotes the same version');
      const keys = Object.keys(rest).filter((k) => rest[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to change');
      const merged = { ...cur0, ...Object.fromEntries(keys.map((k) => [k, rest[k]])) };
      merged.quantity = Number(merged.quantity);
      const scope = await check(c, buyer, { ...merged, starts_at: merged.starts_at && new Date(merged.starts_at).toISOString(), ends_at: merged.ends_at && new Date(merged.ends_at).toISOString() });
      if (keys.includes('scope') || keys.includes('category')) rest.scope = scope;
      const ks = [...new Set([...keys, ...(rest.scope ? ['scope'] : [])])];
      const set = ks.map((k, n) => `${k}=$${n + 3}`).join(', ');
      const r = (await c.query(`UPDATE svc_requirements SET ${set}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`, [rid, row_version, ...ks.map((k) => rest[k])])).rows[0];
      if (!r) throw conflict('This requirement changed since you opened it — reload and try again');
      return r;
    });
  },
});
cap({
  name: 'list_service_requirements', method: 'GET', path: '/service-buyers/:id/requirements', tag: TAG, summary: 'Requirements of a procurement context, filterable by lot, status, category, event.',
  input: z.object({ id, lot_id: id.optional(), status: z.string().optional(), category: z.string().optional(), event_id: id.optional(), competition_id: id.optional(), ...page }),
  async handler({ user }, i) {
    await buyerAccess(user, i.id, null);
    return many('SELECT * FROM svc_requirements WHERE buyer_id=$1 AND ($8::uuid IS NULL OR competition_id=$8) AND ($2::uuid IS NULL OR lot_id=$2) AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR category=$4) AND ($5::uuid IS NULL OR event_id=$5) ORDER BY coalesce(starts_at, created_at), id LIMIT $6 OFFSET $7',
      [i.id, i.lot_id ?? null, i.status ?? null, i.category ?? null, i.event_id ?? null, i.limit, i.offset, i.competition_id ?? null]);
  },
});
cap({
  name: 'get_service_requirement', method: 'GET', path: '/service-requirements/:id', tag: TAG, summary: 'One requirement.',
  input: z.object({ id }),
  async handler({ user }, i) { const r = await one('SELECT * FROM svc_requirements WHERE id=$1', [i.id]); if (!r) throw notFound('Requirement'); await buyerAccess(user, r.buyer_id, null); return r; },
});
cap({
  name: 'copy_service_requirement', method: 'POST', path: '/service-requirements/:id/copy', tag: TAG, status: 201,
  summary: 'Use a requirement as a template for a repeat programme: copies scope and proposed dates only — never awards, approvals, rosters or paid status. The copy is a draft.',
  input: z.object({ id, title: z.string().min(1).max(160).optional(), shift_days: z.number().int().min(-3650).max(3650).default(0), lot_id: id.optional(), event_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM svc_requirements WHERE id=$1', [i.id])).rows[0];
      if (!s) throw notFound('Requirement');
      const { buyer } = await buyerAccess(user, s.buyer_id, ['requester'], c);
      const shift = (d) => d && new Date(new Date(d).getTime() + i.shift_days * 86400000).toISOString();
      return (await c.query(
        `INSERT INTO svc_requirements(buyer_id, lot_id, event_id, venue_id, category, subcategory, title, scope, quantity, unit, headcount, starts_at, ends_at, timezone, recurrence, site_access, qualifications, budget_minor, currency, acceptance_criteria, copied_from, created_by, compliance_kinds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [buyer.id, i.lot_id ?? null, i.event_id ?? (buyer.event_id ?? null), s.venue_id, s.category, s.subcategory, i.title ?? s.title, s.scope, s.quantity, s.unit, s.headcount, shift(s.starts_at), shift(s.ends_at), s.timezone, s.recurrence, s.site_access, s.qualifications, s.budget_minor, s.currency, s.acceptance_criteria, s.id, user.id, s.compliance_kinds])).rows[0];
    });
  },
});

// ---------------------------------------------------------------- overview: coverage, money in separate states, dependency and readiness checks
cap({
  name: 'get_service_plan', method: 'GET', path: '/service-buyers/:id/plan', tag: TAG,
  summary: 'The required-services dashboard: coverage per lot (unquoted / quoting / unawarded / unconfirmed), money in separate states per currency (estimated, quoted, approved, committed, invoiced, paid, outstanding — an order is counted once), dependency problems and overdue readiness.',
  input: z.object({ id, event_id: id.optional() }),
  async handler({ user }, i) {
    await buyerAccess(user, i.id, null);
    const reqs = await many("SELECT r.*, l.name AS lot_name FROM svc_requirements r LEFT JOIN svc_lots l ON l.id=r.lot_id WHERE r.buyer_id=$1 AND r.status <> 'cancelled' AND ($2::uuid IS NULL OR r.event_id=$2) ORDER BY coalesce(r.starts_at, r.created_at), r.id", [i.id, i.event_id ?? null]);
    const rfqs = await many("SELECT q.requirement_id, q.status, (SELECT count(*)::int FROM svc_quotes z WHERE z.rfq_id=q.id AND z.status IN ('submitted','shortlisted','awarded','partially_awarded')) AS quotes, (SELECT count(*)::int FROM svc_invites v WHERE v.rfq_id=q.id) AS invited FROM svc_rfqs q WHERE q.buyer_id=$1 AND q.status NOT IN ('cancelled','withdrawn')", [i.id]);
    const orders = await many("SELECT requirement_id, status, fulfilment FROM svc_orders WHERE buyer_id=$1 AND status NOT IN ('cancelled','rejected','terminated')", [i.id]);
    const coverage = reqs.map((r) => {
      const rf = rfqs.filter((x) => x.requirement_id === r.id); const od = orders.filter((x) => x.requirement_id === r.id);
      const flag = od.some((o) => ['confirmed', 'in_progress', 'paused', 'completed'].includes(o.status)) ? 'confirmed' : od.length ? 'unconfirmed' : rf.some((x) => x.status === 'awarded' || x.status === 'partially_awarded') ? 'unconfirmed' : rf.some((x) => x.quotes > 0) ? 'unawarded' : rf.length ? 'quoting' : 'unquoted';
      return { requirement_id: r.id, title: r.title, lot: r.lot_name, category: r.category, flag, starts_at: r.starts_at, deadline: r.deadline };
    });
    const money = await many(
      `WITH req AS (SELECT currency, sum(coalesce(budget_minor,0)) AS estimated FROM svc_requirements WHERE buyer_id=$1 AND status <> 'cancelled' GROUP BY currency),
            ord AS (SELECT currency, sum(gross_minor) FILTER (WHERE status IN ('confirmed','in_progress','paused','completed')) AS committed, sum(gross_minor) FILTER (WHERE status = 'pending_supplier') AS approved FROM svc_orders WHERE buyer_id=$1 GROUP BY currency),
            qt AS (SELECT currency, sum(low) AS quoted FROM (SELECT q.currency, min(z.gross_minor) AS low FROM svc_rfqs q JOIN svc_quotes z ON z.rfq_id=q.id AND z.status IN ('submitted','shortlisted') WHERE q.buyer_id=$1 GROUP BY q.id, q.currency) s GROUP BY currency),
            inv AS (SELECT currency, sum(gross_minor) AS invoiced, sum(paid_minor) AS paid FROM svc_invoices WHERE buyer_id=$1 AND status='issued' AND doc_type IN ('invoice','debit_note') GROUP BY currency),
            cr AS (SELECT currency, sum(gross_minor) AS credited FROM svc_invoices WHERE buyer_id=$1 AND status='issued' AND doc_type='credit_note' GROUP BY currency),
            cur AS (SELECT currency FROM req UNION SELECT currency FROM ord UNION SELECT currency FROM qt UNION SELECT currency FROM inv)
       SELECT cur.currency, coalesce(req.estimated,0)::bigint AS estimated, coalesce(qt.quoted,0)::bigint AS quoted, coalesce(ord.approved,0)::bigint AS approved, coalesce(ord.committed,0)::bigint AS committed,
              (coalesce(inv.invoiced,0) - coalesce(cr.credited,0))::bigint AS invoiced, coalesce(inv.paid,0)::bigint AS paid, (coalesce(inv.invoiced,0) - coalesce(cr.credited,0) - coalesce(inv.paid,0))::bigint AS outstanding
         FROM cur LEFT JOIN req USING (currency) LEFT JOIN qt USING (currency) LEFT JOIN ord USING (currency) LEFT JOIN inv USING (currency) LEFT JOIN cr USING (currency) ORDER BY cur.currency`, [i.id]);
    const byId = new Map(reqs.map((r) => [r.id, r]));
    const problems = [];
    for (const r of reqs) for (const d of r.depends_on) { const p = byId.get(d); if (p?.ends_at && r.starts_at && new Date(p.ends_at) > new Date(r.starts_at)) problems.push({ kind: 'dependency', requirement_id: r.id, depends_on: d, detail: `${p.title} ends after ${r.title} starts` }); }
    const today = new Date().toISOString().slice(0, 10);
    const overdue = coverage.filter((x) => x.deadline && x.deadline < today && !['confirmed'].includes(x.flag)).map((x) => ({ kind: 'overdue_readiness', requirement_id: x.requirement_id, detail: `${x.title} is ${x.flag} past its deadline` }));
    return { coverage, money, problems: [...problems, ...overdue], note: 'A maintenance booking records work; it never certifies a venue as safe.' };
  },
});
