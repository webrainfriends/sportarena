// Academy suppliers: maintenance contractors and sporting-goods / kit suppliers an academy works with, across one, several or all of its
// venues, plus the requests sent to them. Owner/admin, or staff holding the "suppliers" permission, manage them; other staff with
// schedule access can read. Contact details are encrypted and every read that decrypts them is audit-logged. Nothing is deleted:
// suppliers are paused or archived, venue links are ended, requests are cancelled.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { opsAccess } from '../academy-ops.js';
import { isSupportedCurrency } from '../currency.js';

const TAG = 'Academy suppliers';
export const SUPPLIER_KINDS = ['maintenance', 'sporting_goods', 'cleaning', 'security', 'technology', 'catering', 'transport', 'other'];
const STATUSES = ['active', 'paused', 'archived'];
export const REQUEST_STATUSES = ['requested', 'quoted', 'approved', 'in_progress', 'delivered', 'done', 'cancelled'];
const NEXT = { requested: ['quoted', 'approved', 'cancelled'], quoted: ['approved', 'cancelled'], approved: ['in_progress', 'delivered', 'cancelled'], in_progress: ['delivered', 'done', 'cancelled'], delivered: ['done'], done: [], cancelled: [] };
const CONTACT = ['contact_name', 'phone', 'email'];
const short = (n) => z.string().trim().min(1).max(n);

const fields = {
  kind: z.enum(SUPPLIER_KINDS), name: short(120), categories: z.array(short(40)).max(20).default([]),
  all_venues: z.boolean().default(false), venue_ids: z.array(id).max(100).default([]),
  contact_name: short(120).optional(), phone: short(40).optional(), email: z.string().trim().email().max(200).optional(),
  address: short(300).optional(), website: short(200).optional(), emergency_24x7: z.boolean().default(false),
  lead_time_days: z.number().int().min(0).max(365).optional(), payment_terms: short(200).optional(), rating: z.number().int().min(1).max(5).optional(), notes: short(2000).optional(),
};

/** Read needs the suppliers permission or schedule access; writes need the suppliers permission (owner/admin always have it). */
async function access(user, orgId, write, c) {
  const a = await opsAccess(user, orgId, { write, c });
  if (write ? !a.has('suppliers') : !(a.has('suppliers') || a.has('schedule'))) throw forbidden('You do not have supplier access to this academy');
  return a;
}
/** Every venue must belong to this academy; 404 otherwise, so nothing leaks about other organisations' venues. */
async function ownVenues(c, orgId, ids) {
  if (!ids.length) return;
  const n = (await c.query('SELECT count(*)::int AS n FROM venues WHERE organisation_id=$1 AND id = ANY($2)', [orgId, ids])).rows[0].n;
  if (n !== new Set(ids).size) throw notFound('Venue');
}
async function setVenues(c, supplierId, ids) {
  await c.query('UPDATE academy_supplier_venues SET ended_at=now() WHERE supplier_id=$1 AND ended_at IS NULL AND NOT (venue_id = ANY($2))', [supplierId, ids]);
  for (const v of ids) await c.query('INSERT INTO academy_supplier_venues(supplier_id, venue_id) VALUES ($1,$2) ON CONFLICT (supplier_id, venue_id) DO UPDATE SET ended_at=NULL, added_at=CASE WHEN academy_supplier_venues.ended_at IS NULL THEN academy_supplier_venues.added_at ELSE now() END', [supplierId, v]);
}
const VENUES_SQL = `(SELECT coalesce(json_agg(json_build_object('id', v.id, 'name', v.name) ORDER BY v.name), '[]') FROM academy_supplier_venues l JOIN venues v ON v.id=l.venue_id WHERE l.supplier_id=s.id AND l.ended_at IS NULL)`;
const out = (r) => { const { contact_name_enc, phone_enc, email_enc, ...rest } = r; return { ...rest, ...decryptFields(r, 'academy_suppliers', CONTACT) }; };

cap({
  name: 'create_academy_supplier', method: 'POST', path: '/organisations/:id/academy/suppliers', tag: TAG, status: 201,
  summary: 'Add a supplier (maintenance contractor, sporting-goods or kit supplier, cleaning, security …) and say which venues it serves: every venue of the academy (all_venues) or chosen ones. Needs the suppliers permission. Contact name, phone and email are encrypted at rest.',
  input: z.object({ id, ...fields }),
  handler: ({ user }, i) => tx(async (c) => {
    await access(user, i.id, true, c);
    if (i.all_venues && i.venue_ids.length) throw badRequest('Choose either all venues or specific venues');
    await ownVenues(c, i.id, i.venue_ids);
    const e = encryptFields(i, 'academy_suppliers', CONTACT);
    const r = (await c.query(
      `INSERT INTO academy_suppliers(organisation_id, kind, name, categories, all_venues, contact_name_enc, phone_enc, email_enc, address, website, emergency_24x7, lead_time_days, payment_terms, rating, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [i.id, i.kind, i.name, i.categories, i.all_venues, e.contact_name_enc ?? null, e.phone_enc ?? null, e.email_enc ?? null, i.address ?? null, i.website ?? null, i.emergency_24x7, i.lead_time_days ?? null, i.payment_terms ?? null, i.rating ?? null, i.notes ?? null, user.id])).rows[0];
    await setVenues(c, r.id, i.venue_ids);
    await audit(c, user.id, 'create_academy_supplier', 'academy_suppliers', r.id);
    return { ...out(r), venues: (await c.query('SELECT v.id, v.name FROM academy_supplier_venues l JOIN venues v ON v.id=l.venue_id WHERE l.supplier_id=$1 AND l.ended_at IS NULL ORDER BY v.name', [r.id])).rows };
  }),
});

cap({
  name: 'list_academy_suppliers', method: 'GET', path: '/organisations/:id/academy/suppliers', tag: TAG,
  summary: 'The academy\'s suppliers with the venues each serves and open requests. Filter by kind, by venue (suppliers that cover that venue: all-venue ones plus those linked to it) or status. Contacts are decrypted for staff with the suppliers permission only and that read is audit-logged.',
  input: z.object({ id, kind: z.enum(SUPPLIER_KINDS).optional(), venue_id: id.optional(), status: z.enum(STATUSES).optional(), include_archived: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    const a = await access(user, i.id, false);
    const rows = await many(
      `SELECT s.*, ${VENUES_SQL} AS venues, (SELECT count(*)::int FROM academy_supplier_requests q WHERE q.supplier_id=s.id AND q.status IN ('requested','quoted','approved','in_progress','delivered')) AS open_requests
         FROM academy_suppliers s
        WHERE s.organisation_id=$1 AND ($2::text IS NULL OR s.kind=$2) AND ($3::text IS NULL OR s.status=$3) AND ($3::text IS NOT NULL OR $4 OR s.status <> 'archived')
          AND ($5::uuid IS NULL OR s.all_venues OR EXISTS (SELECT 1 FROM academy_supplier_venues l WHERE l.supplier_id=s.id AND l.venue_id=$5 AND l.ended_at IS NULL))
        ORDER BY s.name LIMIT 500`, [i.id, i.kind ?? null, i.status ?? null, i.include_archived, i.venue_id ?? null]);
    if (!a.has('suppliers')) return rows.map(({ contact_name_enc, phone_enc, email_enc, ...r }) => r);
    if (rows.length) await audit(null, user.id, 'read_academy_supplier_contacts', 'organisations', i.id);
    return rows.map(out);
  },
});

cap({
  name: 'update_academy_supplier', method: 'PATCH', path: '/academy/suppliers/:id', tag: TAG,
  summary: 'Edit a supplier, change the venues it serves, or pause / archive it (history is kept). Send row_version; a stale one is a 409.',
  input: z.object({ id, row_version: z.number().int(), status: z.enum(STATUSES).optional(), ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM academy_suppliers WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Supplier');
    await access(user, cur.organisation_id, true, c);
    if (cur.row_version !== i.row_version) throw conflict('This supplier was changed by someone else. Reload and try again.', { row_version: cur.row_version });
    const allVenues = i.all_venues ?? cur.all_venues;
    if (allVenues && i.venue_ids?.length) throw badRequest('Choose either all venues or specific venues');
    if (i.venue_ids) { await ownVenues(c, cur.organisation_id, i.venue_ids); await setVenues(c, cur.id, allVenues ? [] : i.venue_ids); }
    else if (i.all_venues) await setVenues(c, cur.id, []);
    const e = encryptFields(i, 'academy_suppliers', CONTACT);
    const pick = (k) => (i[k] === undefined ? cur[k] : i[k]);
    const r = (await c.query(
      `UPDATE academy_suppliers SET kind=$2, name=$3, categories=$4, all_venues=$5, contact_name_enc=$6, phone_enc=$7, email_enc=$8, address=$9, website=$10, emergency_24x7=$11, lead_time_days=$12, payment_terms=$13, rating=$14, notes=$15, status=$16, row_version=row_version+1, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [cur.id, pick('kind'), pick('name'), pick('categories'), allVenues, e.contact_name_enc ?? cur.contact_name_enc, e.phone_enc ?? cur.phone_enc, e.email_enc ?? cur.email_enc, pick('address'), pick('website'), pick('emergency_24x7'), pick('lead_time_days'), pick('payment_terms'), pick('rating'), pick('notes'), pick('status')])).rows[0];
    await audit(c, user.id, 'update_academy_supplier', 'academy_suppliers', r.id);
    return out(r);
  }),
});

const reqFields = {
  supplier_id: id, venue_id: id.optional(), title: short(160), details: short(2000).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), due_on: z.string().date().optional(),
  currency: z.string().length(3).toUpperCase().optional(), estimated_cost_minor: z.number().int().min(0).max(1e12).optional(),
};

cap({
  name: 'create_academy_supplier_request', method: 'POST', path: '/organisations/:id/academy/supplier-requests', tag: TAG, status: 201,
  summary: 'Ask a supplier for work or goods (repair, servicing, kit, equipment) for one venue or the whole academy. The supplier must be active and cover that venue.',
  input: z.object({ id, ...reqFields }),
  handler: ({ user }, i) => tx(async (c) => {
    await access(user, i.id, true, c);
    const s = (await c.query('SELECT * FROM academy_suppliers WHERE id=$1 AND organisation_id=$2', [i.supplier_id, i.id])).rows[0];
    if (!s) throw notFound('Supplier');
    if (s.status !== 'active') throw conflict('This supplier is not active');
    if (i.venue_id) {
      await ownVenues(c, i.id, [i.venue_id]);
      if (!s.all_venues && !(await c.query('SELECT 1 FROM academy_supplier_venues WHERE supplier_id=$1 AND venue_id=$2 AND ended_at IS NULL', [s.id, i.venue_id])).rowCount) throw conflict('This supplier does not serve that venue');
    }
    if (i.estimated_cost_minor != null && !i.currency) throw badRequest('Choose a currency for the estimate');
    if (i.currency && !isSupportedCurrency(i.currency)) throw badRequest('Unsupported currency');
    const r = (await c.query(
      `INSERT INTO academy_supplier_requests(organisation_id, supplier_id, venue_id, title, details, priority, due_on, currency, estimated_cost_minor, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.id, s.id, i.venue_id ?? null, i.title, i.details ?? null, i.priority, i.due_on ?? null, i.currency ?? null, i.estimated_cost_minor ?? null, user.id])).rows[0];
    await audit(c, user.id, 'create_academy_supplier_request', 'academy_supplier_requests', r.id);
    return r;
  }),
});

cap({
  name: 'list_academy_supplier_requests', method: 'GET', path: '/organisations/:id/academy/supplier-requests', tag: TAG,
  summary: 'Requests sent to suppliers, newest first. Filter by status, supplier or venue.',
  input: z.object({ id, status: z.enum(REQUEST_STATUSES).optional(), supplier_id: id.optional(), venue_id: id.optional(), open_only: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    await access(user, i.id, false);
    return many(
      `SELECT q.*, s.name AS supplier, s.kind AS supplier_kind, v.name AS venue
         FROM academy_supplier_requests q JOIN academy_suppliers s ON s.id=q.supplier_id LEFT JOIN venues v ON v.id=q.venue_id
        WHERE q.organisation_id=$1 AND ($2::text IS NULL OR q.status=$2) AND ($3::uuid IS NULL OR q.supplier_id=$3) AND ($4::uuid IS NULL OR q.venue_id=$4)
          AND (NOT $5 OR q.status IN ('requested','quoted','approved','in_progress','delivered'))
        ORDER BY q.created_at DESC LIMIT 500`, [i.id, i.status ?? null, i.supplier_id ?? null, i.venue_id ?? null, i.open_only]);
  },
});

cap({
  name: 'update_academy_supplier_request', method: 'PATCH', path: '/academy/supplier-requests/:id', tag: TAG,
  summary: 'Move a request along (requested → quoted → approved → in progress → delivered → done, or cancelled), record the quote and the final cost. The server enforces the allowed moves.',
  input: z.object({ id, row_version: z.number().int(), status: z.enum(REQUEST_STATUSES).optional(), due_on: z.string().date().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), details: short(2000).optional(), currency: z.string().length(3).toUpperCase().optional(), estimated_cost_minor: z.number().int().min(0).max(1e12).optional(), actual_cost_minor: z.number().int().min(0).max(1e12).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM academy_supplier_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Request');
    await access(user, cur.organisation_id, true, c);
    if (cur.row_version !== i.row_version) throw conflict('This request was changed by someone else. Reload and try again.', { row_version: cur.row_version });
    if (i.status && i.status !== cur.status && !NEXT[cur.status].includes(i.status)) throw conflict(`A ${cur.status.replace('_', ' ')} request cannot become ${i.status.replace('_', ' ')}`);
    const currency = i.currency ?? cur.currency;
    if ((i.estimated_cost_minor != null || i.actual_cost_minor != null) && !currency) throw badRequest('Choose a currency for the amounts');
    if (currency && !isSupportedCurrency(currency)) throw badRequest('Unsupported currency');
    const r = (await c.query(
      `UPDATE academy_supplier_requests SET status=$2, due_on=$3, priority=$4, details=$5, currency=$6, estimated_cost_minor=$7, actual_cost_minor=$8, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, i.status ?? cur.status, i.due_on ?? cur.due_on, i.priority ?? cur.priority, i.details ?? cur.details, currency ?? null, i.estimated_cost_minor ?? cur.estimated_cost_minor, i.actual_cost_minor ?? cur.actual_cost_minor])).rows[0];
    await audit(c, user.id, 'update_academy_supplier_request', 'academy_supplier_requests', r.id, { from: cur.status, to: r.status });
    return r;
  }),
});

cap({
  name: 'list_academy_venues', method: 'GET', path: '/organisations/:id/academy/venues', tag: TAG,
  summary: 'The venues this academy runs (for choosing where a supplier works).',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    await access(user, i.id, false);
    return many('SELECT id, name, city FROM venues WHERE organisation_id=$1 ORDER BY name LIMIT 200', [i.id]);
  },
});
