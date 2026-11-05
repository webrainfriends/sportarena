// International admissions & relocation readiness (#799). An additive layer on Academy applications (#392): a per-application checklist made from a versioned,
// data-driven template (programme and/or origin country), guardian legal permissions and other evidence linked BY REFERENCE to the compliance engine,
// a passport/visa vault reusing the #485 model (numbers encrypted, revealed only to the holder or a verified guardian, never to staff), owner-approved
// offer conditions, a pre-arrival task board and an append-only decision trail. The enrol gate (academy.js -> assertReadyToEnrol) refuses an international
// athlete while any mandatory item or condition is unmet. School, residence and transport are linked by reference to their own domains.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { guardianLink, isYouth, guardiansOf } from '../youth.js';
import { notify } from '../notify.js';
import { orgFor } from '../org-access.js';
import { STAFF, actFor } from '../academy.js';
import { caseState, plain, today, PASSPORT_STATUS, VISA_STATUS } from '../intl-readiness.js';

const TAG = 'Academy international admissions';
const KINDS = ['eligibility', 'guardian_permission', 'travel_document', 'school', 'residence', 'transport', 'medical', 'custom'];
const NEVER_WAIVED = ['eligibility', 'guardian_permission', 'travel_document'];
const DEAD = ['withdrawn', 'declined', 'expired'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const iso2 = z.string().regex(/^[A-Z]{2}$/, 'use a two-letter country code');
const stale = () => conflict('This case was changed by someone else. Reload and try again.');
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const tplItem = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/), kind: z.enum(KINDS), label: z.string().trim().min(2).max(200), mandatory: z.boolean().default(true),
  lead_days: z.number().int().min(0).max(730).default(30).describe('deadline = arrival date minus this many days'),
  expiry_months: z.number().int().min(0).max(120).optional().describe('evidence must stay valid this many months after arrival'),
});

const event = (c, orgId, caseId, kind, actor, data = {}) => c.query('INSERT INTO academy_intl_events(organisation_id, case_id, kind, actor_id, data) VALUES ($1,$2,$3,$4,$5)', [orgId, caseId, kind, actor, JSON.stringify(data)]);

/** Staff (owner/admin) or, failing that, the athlete's family (adult athlete, or live-verified guardian). 404 for everyone else. */
async function access(user, kase, { write = false, c = pool } = {}) {
  try { const { role } = await orgFor(user, kase.organisation_id, STAFF, { write, c }); return { staff: true, role, owner: role === 'owner' }; }
  catch (e) { if (e.status !== 404) throw e; }
  if (kase.athlete_id === user.id) { if (await isYouth(user.id, c)) throw notFound('Case'); return { staff: false, holder: true }; }
  if (await guardianLink(user.id, kase.athlete_id, c)) return { staff: false, holder: true, guardian: true };
  throw notFound('Case');
}
async function caseFor(user, caseId, opts = {}) {
  const c = opts.c ?? pool;
  const kase = (await c.query(`SELECT * FROM academy_intl_cases WHERE id=$1${opts.lock ? ' FOR UPDATE' : ''}`, [caseId])).rows[0];
  if (!kase) throw notFound('Case');
  return { kase, ...(await access(user, kase, opts)) };
}
async function caseByApp(user, appId, opts = {}) {
  const c = opts.c ?? pool;
  const kase = (await c.query('SELECT * FROM academy_intl_cases WHERE application_id=$1', [appId])).rows[0];
  if (!kase) throw notFound('Case');
  return caseFor(user, kase.id, opts);
}
async function familyOf(c, kase) {
  const app = (await c.query('SELECT applicant_id FROM academy_applications WHERE id=$1', [kase.application_id])).rows[0];
  const set = new Set([app.applicant_id]);
  if (await isYouth(kase.athlete_id, c)) for (const g of await guardiansOf(kase.athlete_id, c)) set.add(g); else set.add(kase.athlete_id);
  return [...set];
}
/** Generic wording on purpose, like every academy message: no names, countries or document details in a lock-screen preview. */
async function tellFamily(c, kase, kind, title, key) {
  for (const uid of await familyOf(c, kase)) await notify(c, uid, { kind: `academy_intl_${kind}`, title, body: 'Open Gotmygame to see the details.', data: { organisation_id: kase.organisation_id, application_id: kase.application_id, case_id: kase.id }, dedupe_key: `intl:${kind}:${kase.id}:${key}:${uid}` });
}
const touch = async (c, kase) => (await c.query('UPDATE academy_intl_cases SET row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version', [kase.id])).rows[0].row_version;

async function view(c, kase, who) {
  const st = await caseState(c, kase);
  const app = (await c.query('SELECT a.id, a.stage, a.programme_id, p.title AS programme_title, p.sport, u.display_name AS athlete_name FROM academy_applications a JOIN academy_programmes p ON p.id=a.programme_id JOIN users u ON u.id=a.athlete_id WHERE a.id=$1', [kase.application_id])).rows[0];
  const tasks = (await c.query('SELECT t.id, t.item_key, t.title, to_char(t.due_on,\'YYYY-MM-DD\') AS due_on, t.owner_id, o.display_name AS owner_name, t.status, t.done_at FROM academy_arrival_tasks t LEFT JOIN users o ON o.id=t.owner_id WHERE t.case_id=$1 ORDER BY t.status, t.due_on NULLS LAST, t.created_at', [kase.id])).rows;
  const link = (await c.query('SELECT (SELECT name FROM organisations WHERE id=$1) AS school, (SELECT name FROM academy_residences WHERE id=$2) AS residence', [kase.school_org_id, kase.residence_id])).rows[0];
  const reviewer = kase.reviewer_id ? (await c.query('SELECT id, display_name FROM users WHERE id=$1', [kase.reviewer_id])).rows[0] : null;
  const history = who.staff ? (await c.query('SELECT e.kind, e.actor_id, u.display_name AS actor_name, e.data, e.created_at FROM academy_intl_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.case_id=$1 ORDER BY e.created_at DESC, e.id LIMIT 100', [kase.id])).rows : undefined;
  // a proposed condition is internal until an owner approves it; the family never sees the draft wording
  const conditions = st.conditions.filter((x) => who.staff || x.status !== 'proposed').map((x) => ({ id: x.id, item_key: x.item_key, text: x.text, status: x.status, approved_at: x.approved_at, met_at: x.met_at }));
  const blocking = who.staff ? st.readiness.blocking : st.readiness.blocking.map((b) => (b.issues[0] === 'awaiting_owner_approval' ? { ...b, label: 'Offer terms are being finalised' } : b));
  return {
    id: kase.id, application_id: kase.application_id, organisation_id: kase.organisation_id, athlete_id: kase.athlete_id, application: app,
    origin_country: kase.origin_country, arrival_on: plain(kase.arrival_on), template: { id: kase.template_id, version: kase.template_version },
    school_org_id: kase.school_org_id, school_name: link.school, residence_id: kase.residence_id, residence_name: link.residence, reviewer, row_version: kase.row_version,
    readiness: { ...st.readiness, blocking },
    items: st.items,
    // status and expiry only, never a number or an evidence reference
    documents: ['passport', 'visa'].map((k) => st.documents.find((d) => d.kind === k) ?? null).map((d, i) => (d ? { kind: d.kind, status: d.status, expires_on: plain(d.expires_on) } : { kind: ['passport', 'visa'][i], status: null, expires_on: null })),
    conditions, tasks, history,
  };
}

// ------------------------------------------------------------------ residences (the one domain that did not exist)
cap({
  name: 'save_academy_residence', method: 'POST', path: '/organisations/:id/academy/residences', tag: TAG, status: 201,
  summary: 'Add or update a residence (hall, host family, apartment) an international athlete can be placed in. Address and contact are encrypted. Archive instead of deleting.',
  input: z.object({ id, residence_id: id.optional(), name: z.string().trim().min(2).max(120), kind: z.enum(['residence_hall', 'host_family', 'apartment', 'partner_hotel', 'other']), capacity: z.number().int().min(0).max(5000).optional(), address: z.string().trim().max(300).optional(), contact: z.string().trim().max(200).optional(), status: z.enum(['active', 'archived']).default('active') }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    const enc = [i.address ? encrypt(i.address, 'academy_residences.address') : null, i.contact ? encrypt(i.contact, 'academy_residences.contact') : null];
    const r = i.residence_id
      ? (await c.query('UPDATE academy_residences SET name=$3, kind=$4, capacity=$5, address_enc=coalesce($6,address_enc), contact_enc=coalesce($7,contact_enc), status=$8 WHERE id=$1 AND organisation_id=$2 RETURNING id,name,kind,capacity,status', [i.residence_id, i.id, i.name, i.kind, i.capacity ?? null, ...enc, i.status])).rows[0]
      : (await c.query('INSERT INTO academy_residences(organisation_id,name,kind,capacity,address_enc,contact_enc,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,kind,capacity,status', [i.id, i.name, i.kind, i.capacity ?? null, ...enc, i.status, user.id])).rows[0];
    if (!r) throw notFound('Residence');
    return r;
  }),
});
cap({
  name: 'list_academy_residences', method: 'GET', path: '/organisations/:id/academy/residences', tag: TAG,
  summary: 'Residences with how many international athletes are placed in each.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    return many("SELECT r.id, r.name, r.kind, r.capacity, r.status, (SELECT count(*)::int FROM academy_intl_cases k WHERE k.residence_id=r.id) AS placed FROM academy_residences r WHERE r.organisation_id=$1 ORDER BY r.status, r.name", [i.id]);
  },
});

// ------------------------------------------------------------------ templates
cap({
  name: 'save_intl_template', method: 'POST', path: '/organisations/:id/academy/international/templates', tag: TAG, status: 201,
  summary: 'Create a checklist template, or publish a new version of one (versions are append-only, cases stay pinned to the version they started on). Scope it to a programme and/or origin countries; leave both empty for every international applicant. Rules are data: nothing about any country is built in.',
  input: z.object({ id, template_id: id.optional(), name: z.string().trim().min(2).max(120), programme_id: id.nullable().optional(), countries: z.array(iso2).max(60).default([]), items: z.array(tplItem).min(1).max(60), note: z.string().trim().max(300).optional(), status: z.enum(['active', 'archived']).default('active') }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    if (new Set(i.items.map((x) => x.key)).size !== i.items.length) throw badRequest('Checklist item keys must be unique');
    for (const x of i.items) if (x.kind === 'travel_document' && !['passport', 'visa'].includes(x.key)) throw badRequest('A travel document item uses the key "passport" or "visa"');
    if (i.programme_id && !(await c.query('SELECT 1 FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [i.programme_id, i.id])).rows.length) throw notFound('Programme');
    let t;
    if (i.template_id) {
      const cur = (await c.query('SELECT * FROM academy_intl_templates WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.template_id, i.id])).rows[0];
      if (!cur) throw notFound('Template');
      t = (await c.query('UPDATE academy_intl_templates SET name=$2, programme_id=$3, countries=$4, status=$5, current_version=current_version+1 WHERE id=$1 RETURNING *', [cur.id, i.name, i.programme_id ?? null, i.countries, i.status])).rows[0];
    } else t = (await c.query('INSERT INTO academy_intl_templates(organisation_id,name,programme_id,countries,status,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, i.name, i.programme_id ?? null, i.countries, i.status, user.id])).rows[0];
    await c.query('INSERT INTO academy_intl_template_versions(template_id,version,items,note,created_by) VALUES ($1,$2,$3,$4,$5)', [t.id, t.current_version, JSON.stringify(i.items), i.note ?? null, user.id]);
    await event(c, i.id, null, 'template_published', user.id, { template_id: t.id, version: t.current_version, items: i.items.length });
    return { id: t.id, name: t.name, version: t.current_version, status: t.status };
  }),
});
cap({
  name: 'list_intl_templates', method: 'GET', path: '/organisations/:id/academy/international/templates', tag: TAG,
  summary: 'Checklist templates with the items of their current version and how many cases use them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    return many(`SELECT t.id, t.name, t.programme_id, p.title AS programme_title, t.countries, t.status, t.current_version AS version, v.items, v.note, (SELECT count(*)::int FROM academy_intl_cases k WHERE k.template_id=t.id) AS cases
                   FROM academy_intl_templates t JOIN academy_intl_template_versions v ON v.template_id=t.id AND v.version=t.current_version LEFT JOIN academy_programmes p ON p.id=t.programme_id
                  WHERE t.organisation_id=$1 ORDER BY t.status, t.name`, [i.id]);
  },
});

// ------------------------------------------------------------------ the case
cap({
  name: 'start_intl_case', method: 'POST', path: '/academy/applications/:id/international', tag: TAG, status: 201,
  summary: 'Open the international checklist for an application. The template is matched by programme and origin country (or chosen), pinned at its current version, and items get deadlines counted back from the arrival date. A young athlete always gets a mandatory guardian legal-permission item. The family is told in generic wording.',
  input: z.object({ id, origin_country: iso2, arrival_on: day.optional(), template_id: id.optional(), reviewer_id: id.optional(), school_org_id: id.optional(), residence_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM academy_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!a) throw notFound('Application');
    await orgFor(user, a.organisation_id, STAFF, { write: true, c });
    if (DEAD.includes(a.stage)) throw conflict('This application is closed');
    if ((await c.query('SELECT 1 FROM academy_intl_cases WHERE application_id=$1', [a.id])).rows.length) throw conflict('This application already has an international checklist');
    const t = i.template_id
      ? (await c.query("SELECT * FROM academy_intl_templates WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.template_id, a.organisation_id])).rows[0]
      : (await c.query(`SELECT * FROM academy_intl_templates WHERE organisation_id=$1 AND status='active' AND (programme_id IS NULL OR programme_id=$2) AND (cardinality(countries)=0 OR $3 = ANY(countries))
                         ORDER BY (programme_id IS NOT NULL) DESC, (cardinality(countries)>0) DESC, created_at LIMIT 1`, [a.organisation_id, a.programme_id, i.origin_country])).rows[0];
    if (!t) throw conflict('No active checklist template matches this programme and country. Create one first.');
    const v = (await c.query('SELECT items FROM academy_intl_template_versions WHERE template_id=$1 AND version=$2', [t.id, t.current_version])).rows[0];
    if (i.reviewer_id) await orgFor({ id: i.reviewer_id }, a.organisation_id, STAFF, { c }).catch(() => { throw badRequest('The reviewer must be an owner or admin of this academy'); });
    if (i.school_org_id && !(await c.query("SELECT 1 FROM organisations WHERE id=$1 AND kind='school' AND status='active'", [i.school_org_id])).rows.length) throw badRequest('That school is not an active school organisation');
    if (i.residence_id && !(await c.query("SELECT 1 FROM academy_residences WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.residence_id, a.organisation_id])).rows.length) throw badRequest('That residence is not available');
    const items = [...v.items];
    if (await isYouth(a.athlete_id, c) && !items.some((x) => x.kind === 'guardian_permission' && x.mandatory)) items.push({ key: 'guardian_legal_permission', kind: 'guardian_permission', label: 'Parent or guardian legal permission to live and study abroad', mandatory: true, lead_days: 45, expiry_months: 12 });
    const k = (await c.query(
      'INSERT INTO academy_intl_cases(organisation_id,application_id,athlete_id,template_id,template_version,origin_country,arrival_on,school_org_id,residence_id,reviewer_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [a.organisation_id, a.id, a.athlete_id, t.id, t.current_version, i.origin_country, i.arrival_on ?? null, i.school_org_id ?? null, i.residence_id ?? null, i.reviewer_id ?? null, user.id])).rows[0];
    for (const x of items) await c.query('INSERT INTO academy_intl_items(case_id,key,kind,label,mandatory,due_on) VALUES ($1,$2,$3,$4,$5,$6)', [k.id, x.key, x.kind, x.label, x.mandatory, i.arrival_on ? addDays(i.arrival_on, -(x.lead_days ?? 30)) : null]);
    await event(c, k.organisation_id, k.id, 'case_started', user.id, { template_id: t.id, version: t.current_version, origin_country: i.origin_country, items: items.length });
    await tellFamily(c, k, 'checklist', 'Your relocation checklist is ready', 'start');
    return view(c, k, { staff: true });
  }),
});

cap({
  name: 'get_intl_case', method: 'GET', path: '/academy/applications/:id/international', tag: TAG,
  summary: 'The international checklist with live readiness. Staff see the full case and decision history; the athlete or a verified guardian see their own checklist (approved offer conditions only). Document numbers are never returned; use the reveal capability.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { kase, staff } = await caseByApp(user, i.id);
    return view(pool, kase, { staff });
  },
});

cap({
  name: 'update_intl_case', method: 'PATCH', path: '/academy/international/:id', tag: TAG,
  summary: 'Change the arrival date, reviewer, school or residence. Moving the arrival date re-counts open deadlines from the template.',
  input: z.object({ id, row_version: z.number().int().min(1), arrival_on: day.nullable().optional(), reviewer_id: id.nullable().optional(), school_org_id: id.nullable().optional(), residence_id: id.nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { kase } = await caseFor(user, i.id, { c, write: true, lock: true });
    if (kase.row_version !== i.row_version) throw stale();
    const set = {};
    for (const k of ['arrival_on', 'reviewer_id', 'school_org_id', 'residence_id']) if (i[k] !== undefined) set[k] = i[k];
    if (set.reviewer_id) await orgFor({ id: set.reviewer_id }, kase.organisation_id, STAFF, { c }).catch(() => { throw badRequest('The reviewer must be an owner or admin of this academy'); });
    if (set.school_org_id && !(await c.query("SELECT 1 FROM organisations WHERE id=$1 AND kind='school' AND status='active'", [set.school_org_id])).rows.length) throw badRequest('That school is not an active school organisation');
    if (set.residence_id && !(await c.query("SELECT 1 FROM academy_residences WHERE id=$1 AND organisation_id=$2 AND status='active'", [set.residence_id, kase.organisation_id])).rows.length) throw badRequest('That residence is not available');
    const keys = Object.keys(set);
    if (!keys.length) return view(c, kase, { staff: true });
    const k = (await c.query(`UPDATE academy_intl_cases SET ${keys.map((x, n) => `${x}=$${n + 3}`).join(', ')}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`, [kase.id, kase.row_version, ...keys.map((x) => set[x])])).rows[0];
    if (!k) throw stale();
    if ('arrival_on' in set && set.arrival_on) {
      const v = (await c.query('SELECT items FROM academy_intl_template_versions WHERE template_id=$1 AND version=$2', [k.template_id, k.template_version])).rows[0];
      for (const x of v.items) await c.query("UPDATE academy_intl_items SET due_on=$3 WHERE case_id=$1 AND key=$2 AND status IN ('open','rejected')", [k.id, x.key, addDays(set.arrival_on, -(x.lead_days ?? 30))]);
    }
    await event(c, k.organisation_id, k.id, 'case_updated', user.id, { fields: keys });
    if ('arrival_on' in set) await tellFamily(c, k, 'arrival', 'Your arrival plan was updated', String(k.row_version));
    return view(c, k, { staff: true });
  }),
});

// ------------------------------------------------------------------ items
cap({
  name: 'submit_intl_item', method: 'POST', path: '/academy/international/items/:id/submit', tag: TAG,
  summary: 'The athlete or verified guardian says an item is ready for review (optionally with the expiry date of the evidence and a compliance record they hold). It does not count as met until the reviewer verifies it.',
  input: z.object({ id, expires_on: day.optional(), comp_record_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const it = (await c.query('SELECT * FROM academy_intl_items WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!it) throw notFound('Item');
    const { kase, holder } = await caseFor(user, it.case_id, { c });
    if (!holder) throw forbidden('The athlete or a verified guardian submits their own evidence; staff verify it');
    if (!['open', 'rejected'].includes(it.status)) throw conflict('This item is already with the reviewer or decided');
    if (i.comp_record_id && !(await c.query("SELECT 1 FROM comp_records WHERE id=$1 AND subject_kind='person' AND subject_id=$2", [i.comp_record_id, kase.athlete_id])).rows.length) throw notFound('Record');
    await c.query("UPDATE academy_intl_items SET status='submitted', expires_on=coalesce($2,expires_on), comp_record_id=coalesce($3,comp_record_id), row_version=row_version+1 WHERE id=$1", [it.id, i.expires_on ?? null, i.comp_record_id ?? null]);
    await touch(c, kase);
    await event(c, kase.organisation_id, kase.id, 'item_submitted', user.id, { key: it.key });
    return { id: it.id, key: it.key, status: 'submitted' };
  }),
});

cap({
  name: 'decide_intl_item', method: 'POST', path: '/academy/international/items/:id/decision', tag: TAG,
  summary: 'The responsible reviewer (or an owner) verifies, rejects, waives or reopens an item. Guardian permission needs an evidence expiry date or a valid compliance record. Only an owner can waive, never an eligibility, guardian-permission or travel-document item. Every decision is written to the immutable trail and the family is told.',
  input: z.object({ id, decision: z.enum(['verify', 'reject', 'waive', 'reopen']), expires_on: day.optional(), comp_record_id: id.optional(), reason: z.string().trim().min(3).max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const it = (await c.query('SELECT * FROM academy_intl_items WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!it) throw notFound('Item');
    const { kase, owner, staff } = await caseFor(user, it.case_id, { c, write: true });
    if (!staff) throw forbidden('Only academy staff decide checklist items');
    if (kase.reviewer_id && kase.reviewer_id !== user.id && !owner) throw forbidden('Only the responsible reviewer or an owner can decide this case');
    let status;
    if (i.decision === 'verify') {
      if (it.status === 'verified') throw conflict('Already verified');
      let exp = i.expires_on ?? plain(it.expires_on);
      if (i.comp_record_id) {
        const r = (await c.query("SELECT status, expires_on FROM comp_records WHERE id=$1 AND subject_kind='person' AND subject_id=$2", [i.comp_record_id, kase.athlete_id])).rows[0];
        if (!r) throw notFound('Record');
        if (r.status !== 'valid') throw conflict('That compliance record is not valid');
        exp = plain(r.expires_on) ?? exp;
      }
      if (it.kind === 'guardian_permission' && !exp && !i.comp_record_id && !it.comp_record_id) throw badRequest('Guardian permission needs an evidence expiry date or a valid compliance record');
      if (it.kind === 'travel_document' && !(await c.query('SELECT 1 FROM academy_intl_documents WHERE case_id=$1 AND kind=$2', [kase.id, it.key])).rows.length) throw conflict(`Record the ${it.key} status first`);
      status = 'verified';
      await c.query("UPDATE academy_intl_items SET status='verified', expires_on=$2, comp_record_id=coalesce($3,comp_record_id), decided_by=$4, decided_at=now(), row_version=row_version+1 WHERE id=$1", [it.id, exp ?? null, i.comp_record_id ?? null, user.id]);
    } else if (i.decision === 'reject') {
      if (!i.reason) throw badRequest('Say what is missing so the family can fix it');
      status = 'rejected';
      await c.query("UPDATE academy_intl_items SET status='rejected', decided_by=$2, decided_at=now(), decision_note_enc=$3, row_version=row_version+1 WHERE id=$1", [it.id, user.id, encrypt(i.reason, 'academy_intl_items.decision_note')]);
    } else if (i.decision === 'waive') {
      if (!owner) throw forbidden('Only an owner can waive an item');
      if (NEVER_WAIVED.includes(it.kind)) throw conflict('Eligibility, guardian permission and travel documents cannot be waived');
      if (!i.reason) throw badRequest('A waiver needs a reason');
      status = 'waived';
      await c.query("UPDATE academy_intl_items SET status='waived', decided_by=$2, decided_at=now(), decision_note_enc=$3, row_version=row_version+1 WHERE id=$1", [it.id, user.id, encrypt(i.reason, 'academy_intl_items.decision_note')]);
    } else {
      status = 'open';
      await c.query("UPDATE academy_intl_items SET status='open', decided_by=NULL, decided_at=NULL, row_version=row_version+1 WHERE id=$1", [it.id]);
    }
    await touch(c, kase);
    await event(c, kase.organisation_id, kase.id, `item_${i.decision}`, user.id, { key: it.key, kind: it.kind, ...(i.reason ? { reason: i.reason } : {}) });
    if (['verify', 'reject'].includes(i.decision)) await tellFamily(c, kase, i.decision === 'verify' ? 'item_verified' : 'item_rejected', i.decision === 'verify' ? 'A relocation item was verified' : 'A relocation item needs your attention', `${it.key}:${it.row_version + 1}`);
    await audit(c, user.id, 'decide_intl_item', 'academy_intl_items', it.id);
    return { id: it.id, key: it.key, status };
  }),
});

// ------------------------------------------------------------------ passport / visa (reuses the #485 vault model)
const holderOf = async (c, user, kase) => user.id === kase.athlete_id ? !(await isYouth(user.id, c)) : !!(await guardianLink(user.id, kase.athlete_id, c));
cap({
  name: 'set_intl_document', method: 'POST', path: '/academy/international/:id/documents/:kind', tag: TAG,
  summary: 'Record passport or visa readiness. The holder (or a young holder\'s verified guardian) may also store the number and an evidence reference, encrypted and never shown to staff or in any list, notification or document. Academy staff can set status and expiry only.',
  input: z.object({ id, kind: z.enum(['passport', 'visa']), status: z.string(), expires_on: day.nullable().optional(), number: z.string().trim().min(3).max(40).nullable().optional(), evidence_ref: z.string().trim().min(2).max(200).nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    if (!(i.kind === 'passport' ? PASSPORT_STATUS : VISA_STATUS).includes(i.status)) throw badRequest(`Status for a ${i.kind} must be one of ${(i.kind === 'passport' ? PASSPORT_STATUS : VISA_STATUS).join(', ')}`);
    const { kase, staff } = await caseFor(user, i.id, { c, write: undefined });
    const own = await holderOf(c, user, kase);
    if (staff) await orgFor(user, kase.organisation_id, STAFF, { write: true, c });
    if (!staff && !own) throw notFound('Case');
    if ((i.number !== undefined || i.evidence_ref !== undefined) && !own) throw forbidden('Only the holder or their verified guardian can store a document number or evidence reference');
    const prev = (await c.query('SELECT * FROM academy_intl_documents WHERE case_id=$1 AND kind=$2', [kase.id, i.kind])).rows[0];
    const numberEnc = i.number === undefined ? prev?.number_enc ?? null : i.number ? encrypt(i.number, 'academy_intl_documents.number') : null;
    const evEnc = i.evidence_ref === undefined ? prev?.evidence_ref_enc ?? null : i.evidence_ref ? encrypt(i.evidence_ref, 'academy_intl_documents.evidence_ref') : null;
    const expires = i.expires_on === undefined ? prev?.expires_on ?? null : i.expires_on;
    const d = (await c.query(
      `INSERT INTO academy_intl_documents(case_id,kind,status,expires_on,number_enc,evidence_ref_enc,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (case_id,kind) DO UPDATE SET status=EXCLUDED.status, expires_on=EXCLUDED.expires_on, number_enc=EXCLUDED.number_enc, evidence_ref_enc=EXCLUDED.evidence_ref_enc, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING *`,
      [kase.id, i.kind, i.status, expires, numberEnc, evEnc, user.id])).rows[0];
    // a changed document no longer matches what a reviewer verified, so the matching item goes back to review
    await c.query("UPDATE academy_intl_items SET status='submitted', row_version=row_version+1 WHERE case_id=$1 AND key=$2 AND kind='travel_document' AND status='verified'", [kase.id, i.kind]);
    await touch(c, kase);
    await event(c, kase.organisation_id, kase.id, 'document_recorded', user.id, { kind: i.kind, status: d.status, expires_on: plain(d.expires_on) });
    return { kind: d.kind, status: d.status, expires_on: plain(d.expires_on), has_number: !!d.number_enc, has_evidence: !!d.evidence_ref_enc };
  }),
});
cap({
  name: 'reveal_intl_document', method: 'GET', path: '/academy/international/:id/documents/:kind/reveal', tag: TAG,
  summary: 'The holder (or a young holder\'s verified guardian) reads back the stored number and evidence reference. Audit-logged. Academy staff get 404.',
  input: z.object({ id, kind: z.enum(['passport', 'visa']) }),
  async handler({ user }, i) {
    const kase = (await pool.query('SELECT * FROM academy_intl_cases WHERE id=$1', [i.id])).rows[0];
    if (!kase || !(await holderOf(pool, user, kase))) throw notFound('Document');
    const d = (await pool.query('SELECT * FROM academy_intl_documents WHERE case_id=$1 AND kind=$2', [kase.id, i.kind])).rows[0];
    if (!d) throw notFound('Document');
    await audit(null, user.id, 'reveal_intl_document', 'academy_intl_documents', d.id);
    return { kind: d.kind, status: d.status, expires_on: plain(d.expires_on), number: d.number_enc ? decrypt(d.number_enc, 'academy_intl_documents.number') : null, evidence_ref: d.evidence_ref_enc ? decrypt(d.evidence_ref_enc, 'academy_intl_documents.evidence_ref') : null };
  },
});

// ------------------------------------------------------------------ offer conditions (an owner approves them)
cap({
  name: 'add_offer_condition', method: 'POST', path: '/academy/international/:id/conditions', tag: TAG, status: 201,
  summary: 'Propose a condition on the offer (for example "visa granted before the place is confirmed"). It stays internal and does not bind until an owner approves it; the athlete cannot be enrolled while an approved condition is unmet.',
  input: z.object({ id, text: z.string().trim().min(3).max(300), item_key: z.string().max(40).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { kase, staff } = await caseFor(user, i.id, { c, write: true });
    if (!staff) throw forbidden('Only academy staff set offer conditions');
    if (i.item_key && !(await c.query('SELECT 1 FROM academy_intl_items WHERE case_id=$1 AND key=$2', [kase.id, i.item_key])).rows.length) throw notFound('Item');
    const r = (await c.query('INSERT INTO academy_offer_conditions(case_id,organisation_id,item_key,text,proposed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id,text,status,item_key', [kase.id, kase.organisation_id, i.item_key ?? null, i.text, user.id])).rows[0];
    await event(c, kase.organisation_id, kase.id, 'condition_proposed', user.id, { condition_id: r.id });
    return r;
  }),
});
cap({
  name: 'decide_offer_condition', method: 'POST', path: '/academy/international/conditions/:id/decision', tag: TAG,
  summary: 'An owner approves a proposed condition (the family is then told the terms of the offer); staff mark an approved condition met or withdraw one. Each step is recorded in the immutable trail.',
  input: z.object({ id, decision: z.enum(['approve', 'met', 'withdraw']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const k = (await c.query('SELECT * FROM academy_offer_conditions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!k) throw notFound('Condition');
    const { kase, owner, staff } = await caseFor(user, k.case_id, { c, write: true });
    if (!staff) throw forbidden('Only academy staff decide offer conditions');
    let status;
    if (i.decision === 'approve') {
      if (!owner) throw forbidden('Only an owner can approve an offer condition');
      if (k.status !== 'proposed') throw conflict('Only a proposed condition can be approved');
      status = 'approved';
      await c.query("UPDATE academy_offer_conditions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1", [k.id, user.id]);
      await tellFamily(c, kase, 'offer_terms', 'The terms of your offer were updated', k.id);
    } else if (i.decision === 'met') {
      if (k.status !== 'approved') throw conflict('Only an approved condition can be marked met');
      status = 'met';
      await c.query("UPDATE academy_offer_conditions SET status='met', met_by=$2, met_at=now() WHERE id=$1", [k.id, user.id]);
    } else {
      if (['met', 'withdrawn'].includes(k.status)) throw conflict('That condition is already closed');
      if (k.status === 'approved' && !owner) throw forbidden('Only an owner can withdraw an approved condition');
      status = 'withdrawn';
      await c.query("UPDATE academy_offer_conditions SET status='withdrawn' WHERE id=$1", [k.id]);
    }
    await event(c, kase.organisation_id, kase.id, `condition_${i.decision}`, user.id, { condition_id: k.id });
    return { id: k.id, status };
  }),
});

// ------------------------------------------------------------------ pre-arrival task board
cap({
  name: 'add_arrival_task', method: 'POST', path: '/academy/international/:id/tasks', tag: TAG, status: 201,
  summary: 'Add a pre-arrival task (airport pickup, SIM card, bank account, orientation) with a deadline and an owner from the academy staff.',
  input: z.object({ id, title: z.string().trim().min(2).max(200), due_on: day.optional(), owner_id: id.optional(), item_key: z.string().max(40).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { kase, staff } = await caseFor(user, i.id, { c, write: true });
    if (!staff) throw forbidden('Only academy staff manage the arrival board');
    if (i.owner_id) await orgFor({ id: i.owner_id }, kase.organisation_id, undefined, { c }).catch(() => { throw badRequest('The task owner must be a member of this academy'); });
    const t = (await c.query('INSERT INTO academy_arrival_tasks(case_id,organisation_id,item_key,title,due_on,owner_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,due_on,owner_id,status', [kase.id, kase.organisation_id, i.item_key ?? null, i.title, i.due_on ?? null, i.owner_id ?? null, user.id])).rows[0];
    await event(c, kase.organisation_id, kase.id, 'task_added', user.id, { task_id: t.id });
    return t;
  }),
});
cap({
  name: 'update_arrival_task', method: 'PATCH', path: '/academy/international/tasks/:id', tag: TAG,
  summary: 'Complete, cancel or reschedule an arrival task.',
  input: z.object({ id, status: z.enum(['open', 'done', 'cancelled']).optional(), due_on: day.nullable().optional(), owner_id: id.nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = (await c.query('SELECT * FROM academy_arrival_tasks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!t) throw notFound('Task');
    const { kase, staff } = await caseFor(user, t.case_id, { c, write: true });
    if (!staff) throw forbidden('Only academy staff manage the arrival board');
    const r = (await c.query(
      "UPDATE academy_arrival_tasks SET status=coalesce($2,status), due_on=CASE WHEN $3::boolean THEN $4 ELSE due_on END, owner_id=CASE WHEN $5::boolean THEN $6 ELSE owner_id END, done_by=CASE WHEN $2='done' THEN $7 ELSE done_by END, done_at=CASE WHEN $2='done' THEN now() ELSE done_at END WHERE id=$1 RETURNING id,title,due_on,owner_id,status",
      [t.id, i.status ?? null, i.due_on !== undefined, i.due_on ?? null, i.owner_id !== undefined, i.owner_id ?? null, user.id])).rows[0];
    await event(c, kase.organisation_id, kase.id, 'task_updated', user.id, { task_id: t.id, status: r.status });
    return r;
  }),
});

// ------------------------------------------------------------------ the board
cap({
  name: 'get_intl_board', method: 'GET', path: '/organisations/:id/academy/international/board', tag: TAG,
  summary: 'Every international applicant of the academy with readiness, what blocks them, the next deadline and days to arrival, plus overdue tasks. Staff only. Never contains document numbers.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    const cases = await many('SELECT k.*, u.display_name AS athlete_name, p.title AS programme_title, a.stage FROM academy_intl_cases k JOIN users u ON u.id=k.athlete_id JOIN academy_applications a ON a.id=k.application_id JOIN academy_programmes p ON p.id=a.programme_id WHERE k.organisation_id=$1 ORDER BY k.arrival_on NULLS LAST, k.created_at', [i.id]);
    const rows = [];
    for (const k of cases) {
      const st = await caseState(pool, k);
      const next = st.items.filter((x) => !x.met && x.due_on).sort((a, b) => a.due_on.localeCompare(b.due_on))[0] ?? null;
      const tasks = await many("SELECT count(*) FILTER (WHERE status='open')::int AS open, count(*) FILTER (WHERE status='open' AND due_on < CURRENT_DATE)::int AS overdue FROM academy_arrival_tasks WHERE case_id=$1", [k.id]);
      rows.push({ case_id: k.id, application_id: k.application_id, athlete_id: k.athlete_id, athlete_name: k.athlete_name, programme_title: k.programme_title, stage: k.stage, origin_country: k.origin_country, arrival_on: plain(k.arrival_on), days_to_arrival: k.arrival_on ? Math.round((new Date(`${plain(k.arrival_on)}T12:00:00Z`) - new Date(`${today()}T12:00:00Z`)) / 864e5) : null, ready: st.readiness.ready, mandatory_met: st.readiness.mandatory_met, mandatory_total: st.readiness.mandatory_total, blocking: st.readiness.blocking.length, overdue_items: st.items.filter((x) => x.overdue).length, next_deadline: next ? { key: next.key, label: next.label, due_on: next.due_on } : null, tasks_open: tasks[0].open, tasks_overdue: tasks[0].overdue });
    }
    return { summary: { total: rows.length, ready: rows.filter((r) => r.ready).length, blocked: rows.filter((r) => !r.ready).length, arriving_30d: rows.filter((r) => r.days_to_arrival != null && r.days_to_arrival >= 0 && r.days_to_arrival <= 30).length, overdue: rows.reduce((n, r) => n + r.overdue_items + r.tasks_overdue, 0) }, cases: rows };
  },
});
