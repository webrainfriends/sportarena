// Tender zone parties: supplier legal entities (individual, sole trader, company) with collaborators and credentials, and the buyer side's
// procurement mandates, approval-threshold policy and reusable templates. Procurement authority is explicit: a generic organisation
// membership, a supplier role or personal access never grants it.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { orgFor, hasOrgGrant } from '../org-access.js';
import { isSupportedCurrency } from '../currency.js';
import { requireEntity } from '../tender/core.js';
import { rubricSchema, rubricIssues } from '../tender/scoring.js';

const TAG = 'Tender zone';
const handle = z.string().min(2).max(40);
const userByHandle = async (h) => { const u = await one('SELECT id, handle, display_name FROM users WHERE lower(handle)=lower($1)', [h.replace(/^@/, '')]); if (!u) throw notFound('Person'); return u; };

// ------------------------------------------------------------------ supplier entities
const ENTITY_COLS = 'id, kind, legal_name, trading_name, country, categories, coverage, currencies, capacity_note, organisation_id, owner_user_id, status, row_version, created_at';

cap({
  name: 'create_supplier_entity', method: 'POST', path: '/supplier-entities', tag: TAG, status: 201,
  summary: 'Register the legal entity you bid as: an individual, sole trader or company. You become its owner and can add bid managers, contributors and an authorised signatory. One entity submits one proposal per tender, however many people work on it.',
  input: z.object({ kind: z.enum(['individual', 'sole_trader', 'company']), legal_name: z.string().min(2).max(120), trading_name: z.string().max(120).optional(), country: z.string().length(2).optional(), tax_id: z.string().max(40).optional().describe('stored encrypted; never shown to other suppliers'),
    categories: z.array(z.string().max(40)).max(20).default([]), coverage: z.string().max(300).optional(), currencies: z.array(z.string().length(3)).max(10).default([]), capacity_note: z.string().max(500).optional(), organisation_id: id.optional() }),
  async handler({ user }, i) {
    if (i.currencies.some((c) => !isSupportedCurrency(c))) throw badRequest('Unsupported currency');
    if (i.organisation_id) await orgFor(user, i.organisation_id, ['owner', 'admin'], { write: true });
    return tx(async (c) => {
      const e = (await c.query(`INSERT INTO supplier_entities(kind, legal_name, trading_name, country, tax_id_enc, categories, coverage, currencies, capacity_note, organisation_id, owner_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${ENTITY_COLS}`,
        [i.kind, i.legal_name, i.trading_name ?? null, i.country?.toUpperCase() ?? null, i.tax_id ? encrypt(i.tax_id, 'supplier_entities.tax_id') : null, i.categories, i.coverage ?? null, i.currencies, i.capacity_note ?? null, i.organisation_id ?? null, user.id])).rows[0];
      await c.query("INSERT INTO supplier_entity_members(entity_id, user_id, role, added_by) VALUES ($1,$2,'owner',$2)", [e.id, user.id]);
      return e;
    });
  },
});

cap({
  name: 'list_my_supplier_entities', method: 'GET', path: '/supplier-entities', tag: TAG, summary: 'The supplier entities you belong to, with your role in each and the credentials that are close to expiring.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${ENTITY_COLS.split(', ').map((x) => `e.${x}`).join(', ')}, m.role AS my_role,
       (SELECT count(*)::int FROM supplier_credentials k WHERE k.entity_id=e.id AND k.archived_at IS NULL AND k.valid_to IS NOT NULL AND k.valid_to < current_date + 30) AS credentials_expiring
       FROM supplier_entities e JOIN supplier_entity_members m ON m.entity_id=e.id AND m.user_id=$1 AND m.status='active' ORDER BY e.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'update_supplier_entity', method: 'PATCH', path: '/supplier-entities/:id', tag: TAG, summary: 'Change a supplier entity (owner or bid manager). Send the row_version you read; a stale one is a 409.',
  input: z.object({ id, row_version: z.number().int(), trading_name: z.string().max(120).optional(), coverage: z.string().max(300).optional(), categories: z.array(z.string().max(40)).max(20).optional(), currencies: z.array(z.string().length(3)).max(10).optional(), capacity_note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    await requireEntity(user, i.id, ['owner', 'bid_manager']);
    if (i.currencies?.some((c) => !isSupportedCurrency(c))) throw badRequest('Unsupported currency');
    const f = ['trading_name', 'coverage', 'categories', 'currencies', 'capacity_note'].filter((k) => i[k] !== undefined);
    const row = await one(`UPDATE supplier_entities SET ${f.map((k, n) => `${k}=$${n + 3}`).join(', ')}${f.length ? ',' : ''} row_version=row_version+1 WHERE id=$1 AND row_version=$2 RETURNING ${ENTITY_COLS}`, [i.id, i.row_version, ...f.map((k) => i[k])]);
    if (!row) throw conflict('Someone else changed this supplier; reload and try again');
    return row;
  },
});

cap({
  name: 'update_supplier_member', method: 'POST', path: '/supplier-entities/:id/members', tag: TAG,
  summary: 'Add a collaborator to your supplier entity by handle, change their role (bid_manager, contributor, signatory) or remove them (status removed). Only the owner can do this. Removal takes effect on their next request.',
  input: z.object({ id, handle, role: z.enum(['bid_manager', 'contributor', 'signatory']).default('contributor'), status: z.enum(['active', 'removed']).default('active') }),
  async handler({ user }, i) {
    await requireEntity(user, i.id, ['owner']);
    const u = await userByHandle(i.handle);
    const cur = await one('SELECT role FROM supplier_entity_members WHERE entity_id=$1 AND user_id=$2', [i.id, u.id]);
    if (cur?.role === 'owner') throw badRequest('The owner cannot be changed here');
    await pool.query(`INSERT INTO supplier_entity_members(entity_id, user_id, role, status, added_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (entity_id, user_id) DO UPDATE SET role=EXCLUDED.role, status=EXCLUDED.status`, [i.id, u.id, i.role, i.status, user.id]);
    return many("SELECT m.user_id, u.handle, u.display_name, m.role, m.status FROM supplier_entity_members m JOIN users u ON u.id=m.user_id WHERE m.entity_id=$1 ORDER BY m.created_at", [i.id]);
  },
});

cap({
  name: 'list_supplier_members', method: 'GET', path: '/supplier-entities/:id/members', tag: TAG, summary: 'Collaborators on a supplier entity you belong to.', input: z.object({ id }),
  async handler({ user }, i) {
    await requireEntity(user, i.id);
    return many("SELECT m.user_id, u.handle, u.display_name, m.role, m.status FROM supplier_entity_members m JOIN users u ON u.id=m.user_id WHERE m.entity_id=$1 AND m.status='active' ORDER BY m.created_at", [i.id]);
  },
});

cap({
  name: 'add_supplier_credential', method: 'POST', path: '/supplier-entities/:id/credentials', tag: TAG, status: 201,
  summary: 'Declare a certificate, insurance, licence or registration with its validity dates. It counts as declared until a platform administrator verifies what was checked; a tender qualification gate states which it needs. Expiry is checked at the gates and again before award.',
  input: z.object({ id, kind: z.enum(['insurance', 'safeguarding', 'safety_certificate', 'trade_licence', 'tax_registration', 'qualification', 'other']), title: z.string().min(2).max(120), number: z.string().max(60).optional(), issuer: z.string().max(120).optional(), valid_from: z.string().date().optional(), valid_to: z.string().date().optional() }),
  async handler({ user }, i) {
    await requireEntity(user, i.id, ['owner', 'bid_manager']);
    if (i.valid_from && i.valid_to && i.valid_to < i.valid_from) throw badRequest('The credential ends before it starts');
    return one('INSERT INTO supplier_credentials(entity_id, kind, title, number_enc, issuer, valid_from, valid_to) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, entity_id, kind, title, issuer, valid_from, valid_to, status, verified_what, verified_at',
      [i.id, i.kind, i.title, i.number ? encrypt(i.number, 'supplier_credentials.number') : null, i.issuer ?? null, i.valid_from ?? null, i.valid_to ?? null]);
  },
});

cap({
  name: 'list_supplier_credentials', method: 'GET', path: '/supplier-entities/:id/credentials', tag: TAG, summary: 'Credentials of a supplier entity you belong to, with validity and verification status.', input: z.object({ id }),
  async handler({ user }, i) {
    await requireEntity(user, i.id);
    return many('SELECT id, kind, title, issuer, valid_from, valid_to, status, verified_what, verified_at, (valid_to IS NOT NULL AND valid_to < current_date) AS expired FROM supplier_credentials WHERE entity_id=$1 AND archived_at IS NULL ORDER BY valid_to NULLS LAST', [i.id]);
  },
});

cap({
  name: 'verify_supplier_credential', method: 'POST', path: '/admin/supplier-credentials/:id/verify', tag: TAG, auth: ['admin'],
  summary: 'Platform administrator: record that a declared credential was checked, and say exactly what was checked (document seen, registry looked up). A verified badge is never universal supplier approval.',
  input: z.object({ id, result: z.enum(['verified', 'rejected']), what_was_checked: z.string().min(5).max(300) }),
  async handler({ user }, i) {
    const r = await one('UPDATE supplier_credentials SET status=$2, verified_by=$3, verified_at=now(), verified_what=$4 WHERE id=$1 RETURNING id, entity_id, kind, title, status, verified_what, verified_at', [i.id, i.result, user.id, i.what_was_checked]);
    if (!r) throw notFound('Credential');
    return r;
  },
});

cap({
  name: 'find_supplier_entities', method: 'GET', path: '/supplier-entities/search', tag: TAG,
  summary: 'Search supplier entities to invite to a tender (buyers with procurement authority only). Returns the public profile and which credential kinds are verified; never tax ids or other tenders.',
  input: z.object({ q: z.string().max(80).optional(), category: z.string().max(40).optional(), organisation_id: id.optional().describe('your organisation, to prove procurement authority'), ...page }),
  async handler({ user }, i) {
    if (!isAdmin(user)) {
      const ok = i.organisation_id ? await hasOrgGrant(user, i.organisation_id, ['owner', 'admin']) || (await one("SELECT 1 FROM proc_mandates WHERE organisation_id=$1 AND user_id=$2 AND revoked_at IS NULL AND role IN ('procurement_admin','author')", [i.organisation_id, user.id])) : await one('SELECT 1 FROM proc_projects WHERE owner_user_id=$1 LIMIT 1', [user.id]);
      if (!ok) throw forbidden('Supplier search is for people who run a tender');
    }
    return many(`SELECT e.id, e.kind, e.legal_name, e.trading_name, e.country, e.categories, e.coverage, e.currencies,
        coalesce((SELECT array_agg(DISTINCT k.kind) FROM supplier_credentials k WHERE k.entity_id=e.id AND k.status='verified' AND k.archived_at IS NULL AND (k.valid_to IS NULL OR k.valid_to >= current_date)), '{}') AS verified_credentials
      FROM supplier_entities e WHERE e.status='active' AND ($1::text IS NULL OR e.legal_name ILIKE $1 OR e.trading_name ILIKE $1) AND ($2::text IS NULL OR $2 = ANY(e.categories)) ORDER BY e.legal_name LIMIT $3 OFFSET $4`,
    [i.q ? `%${i.q}%` : null, i.category ?? null, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ buyer mandates & policy
cap({
  name: 'grant_procurement_mandate', method: 'POST', path: '/procurement/mandates', tag: TAG, status: 201,
  summary: 'Organisation owner or admin: give someone explicit procurement authority (procurement_admin, author, approver, evaluator, auditor), for the whole organisation or one event, optionally until a date. Revocation applies on their next request and keeps the history.',
  input: z.object({ organisation_id: id, handle, role: z.enum(['procurement_admin', 'author', 'approver', 'evaluator', 'auditor']), event_id: id.optional(), expires_at: z.string().datetime({ offset: true }).optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, ['owner', 'admin'], { write: true });
    if (i.event_id && !(await one('SELECT 1 FROM events WHERE id=$1 AND organisation_id=$2', [i.event_id, i.organisation_id]))) throw badRequest('That event does not belong to this organisation');
    const u = await userByHandle(i.handle);
    if (!(await one("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.organisation_id, u.id]))) throw badRequest('They must be an active member of the organisation first');
    return one('INSERT INTO proc_mandates(organisation_id, user_id, role, event_id, expires_at, granted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.organisation_id, u.id, i.role, i.event_id ?? null, i.expires_at ?? null, user.id]);
  },
});

cap({
  name: 'revoke_procurement_mandate', method: 'POST', path: '/procurement/mandates/:id/revoke', tag: TAG, summary: 'Revoke a procurement mandate. Takes effect on the holder\'s next request; tender history and audit are kept.', input: z.object({ id }),
  async handler({ user }, i) {
    const m = await one('SELECT * FROM proc_mandates WHERE id=$1', [i.id]);
    if (!m) throw notFound('Mandate');
    await orgFor(user, m.organisation_id, ['owner', 'admin'], { write: true });
    return one('UPDATE proc_mandates SET revoked_at = coalesce(revoked_at, now()) WHERE id=$1 RETURNING *', [i.id]);
  },
});

cap({
  name: 'list_procurement_mandates', method: 'GET', path: '/procurement/mandates', tag: TAG, summary: 'Mandates in an organisation you own or administer, or your own mandates.',
  input: z.object({ organisation_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (i.organisation_id) {
      await orgFor(user, i.organisation_id, ['owner', 'admin']);
      return many('SELECT m.*, u.handle, u.display_name FROM proc_mandates m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 ORDER BY m.created_at DESC LIMIT $2 OFFSET $3', [i.organisation_id, i.limit, i.offset]);
    }
    return many('SELECT m.*, o.name AS organisation FROM proc_mandates m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id=$1 AND m.revoked_at IS NULL ORDER BY m.created_at DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'set_procurement_policy', method: 'POST', path: '/procurement/policies', tag: TAG,
  summary: 'Organisation owner or admin: set approval thresholds. A tender whose budget reaches the publish threshold needs extra approvals before publishing; an award reaching the award threshold needs extra approvals before it is issued. Separation of duties always applies: the requester never approves their own request.',
  input: z.object({ organisation_id: id, publish_threshold_minor: z.number().int().min(0).optional(), award_threshold_minor: z.number().int().min(0).optional(), extra_approvals: z.number().int().min(0).max(3).default(1), currency: z.string().length(3).default('INR') }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, ['owner', 'admin'], { write: true });
    if (!isSupportedCurrency(i.currency)) throw badRequest('Unsupported currency');
    return one(`INSERT INTO proc_policies(organisation_id, publish_threshold_minor, award_threshold_minor, extra_approvals, currency, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (organisation_id) DO UPDATE SET publish_threshold_minor=EXCLUDED.publish_threshold_minor, award_threshold_minor=EXCLUDED.award_threshold_minor, extra_approvals=EXCLUDED.extra_approvals, currency=EXCLUDED.currency, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING *`,
      [i.organisation_id, i.publish_threshold_minor ?? null, i.award_threshold_minor ?? null, i.extra_approvals, i.currency, user.id]);
  },
});
cap({
  name: 'get_procurement_policy', method: 'GET', path: '/procurement/policies', tag: TAG, summary: 'Approval thresholds of an organisation you belong to (empty when none are set).', input: z.object({ organisation_id: id }),
  async handler({ user }, i) { await orgFor(user, i.organisation_id); return (await one('SELECT * FROM proc_policies WHERE organisation_id=$1', [i.organisation_id])) ?? { organisation_id: i.organisation_id, extra_approvals: 0 }; },
});

// ------------------------------------------------------------------ templates (empty structures only)
const lotT = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), title: z.string().min(2).max(120), description: z.string().max(1000).optional(), service_family: z.string().max(40).optional(), qty: z.number().positive().max(1e7), unit: z.string().max(30).optional(), allow_partial: z.boolean().default(true), bundle_with: z.array(z.string()).max(20).default([]) });
const QTYPES = ['yes_no', 'single_select', 'multi_select', 'text', 'number', 'date', 'currency', 'table', 'attachment'];
export const questionT = z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), section: z.enum(['qualification', 'technical', 'commercial', 'legal']), prompt: z.string().min(3).max(1000), type: z.enum(QTYPES), options: z.array(z.string().max(120)).max(30).optional(), unit: z.string().max(20).optional(), required: z.boolean().default(true), pass_fail: z.boolean().default(false), pass_value: z.any().optional(), evidence_required: z.boolean().default(false), lot_code: z.string().optional(), show_if: z.object({ key: z.string(), equals: z.any() }).optional() });
export const templateBody = z.object({ category: z.string().max(40).optional(), contract_type: z.enum(['one_off', 'fixed_term', 'recurring', 'framework']).optional(), envelope_mode: z.enum(['open', 'sealed_single', 'sealed_dual']).optional(), lots: z.array(lotT).max(200).default([]), questions: z.array(questionT).max(300).default([]), rubric: rubricSchema.optional() });

cap({
  name: 'create_tender_template', method: 'POST', path: '/tender-templates', tag: TAG, status: 201,
  summary: 'Save a reusable, versioned template: lot structure, typed questionnaire (yes/no, selection, text, number/unit, date, currency, table, attachment, conditional) and an evaluation rubric. A template is an empty structure and carries no suppliers, prices or people. Use kind question_set for a reusable question library.',
  input: z.object({ name: z.string().min(2).max(80), kind: z.enum(['rfp_template', 'question_set']).default('rfp_template'), organisation_id: id.optional(), body: templateBody }),
  async handler({ user }, i) {
    if (i.organisation_id) await orgFor(user, i.organisation_id, ['owner', 'admin'], { write: true });
    if (i.body.rubric) { const p = rubricIssues(i.body.rubric); if (p.length) throw badRequest(p[0], { issues: p }); }
    return one('INSERT INTO proc_templates(organisation_id, owner_user_id, kind, name, body) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.organisation_id ?? null, user.id, i.kind, i.name, i.body]);
  },
});
cap({
  name: 'list_tender_templates', method: 'GET', path: '/tender-templates', tag: TAG, summary: 'Your templates and those of your organisations.', input: z.object({ kind: z.enum(['rfp_template', 'question_set']).optional(), ...page }),
  handler: ({ user }, i) => many(`SELECT * FROM proc_templates t WHERE archived_at IS NULL AND ($1::text IS NULL OR kind=$1) AND (owner_user_id=$2 OR organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$2 AND status='active')) ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [i.kind ?? null, user.id, i.limit, i.offset]),
});
cap({
  name: 'update_tender_template', method: 'PATCH', path: '/tender-templates/:id', tag: TAG, summary: 'Publish a new version of a template (the version number increases; tenders already created from it are not changed), or archive it.',
  input: z.object({ id, name: z.string().min(2).max(80).optional(), body: templateBody.optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    const t = await one('SELECT * FROM proc_templates WHERE id=$1', [i.id]);
    if (!t || (t.owner_user_id !== user.id && !(t.organisation_id && await hasOrgGrant(user, t.organisation_id, ['owner', 'admin'])))) throw notFound('Template');
    if (i.body?.rubric) { const p = rubricIssues(i.body.rubric); if (p.length) throw badRequest(p[0], { issues: p }); }
    return one('UPDATE proc_templates SET name=coalesce($2,name), body=coalesce($3,body), version=version + CASE WHEN $3::jsonb IS NULL THEN 0 ELSE 1 END, archived_at = CASE WHEN $4::boolean IS NULL THEN archived_at WHEN $4 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 RETURNING *', [i.id, i.name ?? null, i.body ?? null, i.archived ?? null]);
  },
});
