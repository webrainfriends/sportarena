// Academy accreditation, audits and corrective-action governance (#806). An academy tracks the external frameworks it is accredited under, links the
// evidence each one requires BY REFERENCE to the compliance engine (comp_records) and credentials (nothing is copied), schedules audits, records
// findings and corrective actions, and keeps an append-only decision trail. The event-level QR accreditation in accreditation.js is a different domain.
// Access is read live: owners and admins manage, auditors read, and an assigned inspector reads and decides on their own audit only.
// Federation-issued licences stay where they are: an audit decision never writes to them.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { orgFor, orgRole } from '../org-access.js';

const TAG = 'Academy accreditation';
const ADMINS = ['owner', 'admin'];
const KINDS = ['coaching_standard', 'safeguarding', 'facility', 'licence', 'quality', 'welfare', 'other'];
const EVIDENCE_KINDS = ['coach_credentials', 'compliance_record', 'policy', 'facility', 'insurance', 'curriculum', 'other'];
const AUDIT_KINDS = ['on_site', 'document_review', 'remote'];
const SEVERITIES = ['high', 'medium', 'low', 'observation'];
const SCOPES = ['coaches', 'premises', 'safeguarding', 'insurance', 'curriculum', 'finance'];
const short = (n, m = 2) => z.string().trim().min(m).max(n);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');
const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (d, m) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const daysTo = (d) => (d ? Math.round((new Date(`${plain(d)}T12:00:00Z`) - new Date(`${today()}T12:00:00Z`)) / 864e5) : null);
const p2 = (n) => String(n).padStart(2, '0');
// pg returns a date column as a Date at local midnight, so read it with local parts
const plain = (d) => (!d ? null : d instanceof Date ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : String(d).slice(0, 10));

/** owners/admins manage; auditors read. `c` joins the caller's transaction. */
async function orgAccess(user, orgId, { write = false, c = pool } = {}) {
  const { org, role } = await orgFor(user, orgId, undefined, { write, c });
  const manage = ADMINS.includes(role);
  if (write && !manage) throw forbidden('Only owners and admins can change accreditation');
  if (!manage && role !== 'auditor') throw forbidden('Accreditation is limited to owners, admins and auditors');
  return { org, role, manage };
}

async function frameworkFor(user, frameworkId, { write = false, c = pool } = {}) {
  const f = (await c.query('SELECT * FROM academy_accreditation_frameworks WHERE id=$1', [frameworkId])).rows[0];
  if (!f) throw notFound('Framework');
  const a = await orgAccess(user, f.organisation_id, { write, c }).catch((e) => { throw e.status === 404 ? notFound('Framework') : e; });
  return { f, ...a };
}

/** An audit is visible to org staff and to its assigned inspector (who is not a member). Anyone else gets 404. */
async function auditFor(user, auditId, { write = false, inspector = false, c = pool } = {}) {
  const a = (await c.query('SELECT * FROM academy_audits WHERE id=$1', [auditId])).rows[0];
  if (!a) throw notFound('Audit');
  const mine = a.inspector_id && a.inspector_id === user.id;
  let acc = null;
  try { acc = await orgAccess(user, a.organisation_id, { write: write && !mine, c }); } catch (e) { if (!mine) throw e.status === 404 ? notFound('Audit') : e; }
  if (write && !acc?.manage && !(inspector && mine)) throw forbidden('Only owners, admins or the assigned inspector can do that');
  return { a, manage: !!acc?.manage, inspector: !!mine, org: acc?.org };
}

const event = (c, orgId, kind, actor, ref = {}, data = {}) => c.query(
  'INSERT INTO academy_accreditation_events(organisation_id, framework_id, audit_id, finding_id, kind, actor_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
  [orgId, ref.framework_id ?? null, ref.audit_id ?? null, ref.finding_id ?? null, kind, actor, JSON.stringify(data)]);

// ------------------------------------------------------------------ evidence state, read live from the records that already exist
const LINK_SQL = `
  SELECT e.id AS link_id, e.requirement_id, e.linked_at,
         CASE WHEN e.comp_record_id IS NOT NULL THEN 'comp_record' ELSE 'credential' END AS ref_kind,
         coalesce(e.comp_record_id, e.credential_id) AS ref_id,
         CASE WHEN e.comp_record_id IS NOT NULL THEN cr.name ELSE c.title END AS label,
         CASE WHEN e.comp_record_id IS NOT NULL THEN r.status ELSE c.status END AS source_status,
         CASE WHEN e.comp_record_id IS NOT NULL THEN r.expires_on ELSE c.expires_on END AS expires_on
    FROM academy_accreditation_evidence e
    LEFT JOIN comp_records r ON r.id=e.comp_record_id LEFT JOIN comp_requirements cr ON cr.id=r.requirement_id
    LEFT JOIN credentials c ON c.id=e.credential_id
   WHERE e.framework_id=$1 AND e.ended_at IS NULL`;

function linkState(l, remind) {
  const okStatus = l.ref_kind === 'comp_record' ? l.source_status === 'valid' : l.source_status === 'issued';
  const left = daysTo(l.expires_on);
  if (!okStatus || (left != null && left < 0)) return 'lapsed';
  return left != null && left <= remind ? 'expiring' : 'valid';
}

async function requirementsOf(c, f) {
  const reqs = (await c.query('SELECT * FROM academy_accreditation_requirements WHERE framework_id=$1 AND retired_at IS NULL ORDER BY sequence, created_at', [f.id])).rows;
  const links = (await c.query(LINK_SQL, [f.id])).rows;
  const out = [];
  for (const q of reqs) {
    let mine = links.filter((l) => l.requirement_id === q.id).map((l) => ({ ...l, expires_on: plain(l.expires_on), state: linkState(l, f.remind_days), derived: false }));
    if (!mine.length && q.comp_requirement_id) {
      // a requirement tied to a compliance requirement reads the organisation's own record for it, without anyone linking it by hand
      const r = (await c.query("SELECT r.id, r.status, r.expires_on, cr.name FROM comp_records r JOIN comp_requirements cr ON cr.id=r.requirement_id WHERE r.requirement_id=$1 AND r.subject_kind='organisation' AND r.subject_id=$2 AND r.status IN ('valid','submitted') ORDER BY r.expires_on DESC NULLS FIRST LIMIT 1", [q.comp_requirement_id, f.organisation_id])).rows[0];
      if (r) { const l = { ref_kind: 'comp_record', source_status: r.status, expires_on: r.expires_on }; mine = [{ link_id: null, requirement_id: q.id, ref_kind: 'comp_record', ref_id: r.id, label: r.name, source_status: r.status, expires_on: plain(r.expires_on), state: linkState(l, f.remind_days), derived: true }]; }
    }
    const best = mine.find((l) => l.state === 'valid') ? 'valid' : mine.find((l) => l.state === 'expiring') ? 'expiring' : mine.length ? 'lapsed' : 'missing';
    out.push({ id: q.id, sequence: q.sequence, title: q.title, evidence_kind: q.evidence_kind, required: q.required, comp_requirement_id: q.comp_requirement_id, state: best, evidence: mine });
  }
  return out;
}

const complianceOf = (reqs) => {
  const need = reqs.filter((r) => r.required);
  const met = need.filter((r) => r.state === 'valid' || r.state === 'expiring').length;
  return { required: need.length, met, missing: need.filter((r) => r.state === 'missing').length, lapsed: need.filter((r) => r.state === 'lapsed').length, expiring: need.filter((r) => r.state === 'expiring').length, pct: need.length ? Math.round((100 * met) / need.length) : null };
};

/** draft / suspended / archived are stored; the rest is read from the dates, so an expiry never needs a sweep to show. */
function health(f) {
  if (f.status !== 'active') return f.status;
  const left = daysTo(f.expires_on ?? f.next_due_on);
  if (left == null) return 'active';
  return left < 0 ? 'expired' : left <= f.remind_days ? 'expiring' : 'active';
}

async function shapeFramework(c, f, { detail = false } = {}) {
  const reqs = await requirementsOf(c, f);
  const openFindings = (await c.query(`SELECT count(*)::int AS n FROM academy_audit_findings x JOIN academy_audits a ON a.id=x.audit_id WHERE a.framework_id=$1 AND x.status='open'`, [f.id])).rows[0].n;
  const openActions = (await c.query(`SELECT count(*)::int AS n FROM academy_audit_actions y JOIN academy_audit_findings x ON x.id=y.finding_id JOIN academy_audits a ON a.id=x.audit_id WHERE a.framework_id=$1 AND y.status='open'`, [f.id])).rows[0].n;
  const owner = f.owner_id ? (await c.query('SELECT display_name FROM users WHERE id=$1', [f.owner_id])).rows[0]?.display_name ?? null : null;
  const base = {
    id: f.id, organisation_id: f.organisation_id, name: f.name, body_name: f.body_name, kind: f.kind, level: f.level, owner_id: f.owner_id, owner_name: owner,
    cycle_months: f.cycle_months, next_due_on: plain(f.next_due_on), expires_on: plain(f.expires_on), days_left: daysTo(f.expires_on ?? f.next_due_on), remind_days: f.remind_days,
    status: f.status, health: health(f), compliance: complianceOf(reqs), open_findings: openFindings, open_actions: openActions, row_version: f.row_version,
  };
  if (!detail) return base;
  return { ...base, notes: f.notes_enc ? decryptFields(f, 'academy_accreditation_frameworks', ['notes']).notes : null, requirements: reqs };
}

// ------------------------------------------------------------------ frameworks
const FrameworkBody = {
  name: short(160), body_name: short(160), kind: z.enum(KINDS), level: short(60, 1).optional(), owner_id: id.optional(),
  cycle_months: z.coerce.number().int().refine((n) => [6, 12, 24, 36, 60].includes(n), 'cycle must be 6, 12, 24, 36 or 60 months').default(12),
  next_due_on: date.optional(), expires_on: date.optional(), remind_days: z.coerce.number().int().min(7).max(365).default(60), notes: z.string().trim().max(4000).optional(),
};
const RequirementIn = z.object({ title: short(160), evidence_kind: z.enum(EVIDENCE_KINDS), required: z.boolean().default(true), comp_requirement_id: id.optional() });

async function ownerMember(c, orgId, ownerId) {
  if (!ownerId) return;
  const m = (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, ownerId])).rowCount;
  if (!m) throw badRequest('The owner must be an active member of this organisation');
}

async function ownCompRequirement(c, orgId, compId) {
  const r = (await c.query('SELECT scope_kind, scope_id FROM comp_requirements WHERE id=$1', [compId])).rows[0];
  if (!r || !((r.scope_kind === 'organisation' && r.scope_id === orgId) || r.scope_kind === 'platform' || r.scope_kind === 'body')) throw notFound('Compliance requirement');
}

cap({
  name: 'create_academy_accreditation_framework', method: 'POST', path: '/organisations/:id/academy/accreditation-frameworks', tag: TAG, status: 201,
  summary: 'Register an external accreditation framework the academy holds or is working towards: the accrediting body, kind, level, owner, renewal cycle, next due and expiry dates, reminder lead time and the checklist of required evidence. A checklist item can point at an existing compliance requirement so its state is read from there. Owners and admins only.',
  input: z.object({ id, ...FrameworkBody, requirements: z.array(RequirementIn).max(60).default([]), status: z.enum(['draft', 'active']).default('active') }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgAccess(user, i.id, { write: true, c });
    await ownerMember(c, i.id, i.owner_id);
    const f = (await c.query(
      `INSERT INTO academy_accreditation_frameworks(organisation_id, name, body_name, kind, level, owner_id, cycle_months, next_due_on, expires_on, remind_days, status, notes_enc, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [i.id, i.name, i.body_name, i.kind, i.level ?? null, i.owner_id ?? null, i.cycle_months, i.next_due_on ?? null, i.expires_on ?? null, i.remind_days, i.status, i.notes ? encryptFields({ notes: i.notes }, 'academy_accreditation_frameworks', ['notes']).notes_enc : null, user.id])).rows[0];
    for (const [n, q] of i.requirements.entries()) {
      if (q.comp_requirement_id) await ownCompRequirement(c, i.id, q.comp_requirement_id);
      await c.query('INSERT INTO academy_accreditation_requirements(framework_id, sequence, title, evidence_kind, required, comp_requirement_id) VALUES ($1,$2,$3,$4,$5,$6)', [f.id, n, q.title, q.evidence_kind, q.required, q.comp_requirement_id ?? null]);
    }
    await event(c, i.id, 'framework_created', user.id, { framework_id: f.id }, { name: f.name, body_name: f.body_name });
    return shapeFramework(c, f, { detail: true });
  }),
});

cap({
  name: 'update_academy_accreditation_framework', method: 'PATCH', path: '/academy/accreditation-frameworks/:id', tag: TAG,
  summary: 'Change a framework\'s details, dates, owner or status (draft, active, suspended, archived; archiving keeps everything). Send row_version to refuse a stale edit. Owners and admins only.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(FrameworkBody).map(([k, v]) => [k, v.optional()])), status: z.enum(['draft', 'active', 'suspended', 'archived']).optional(), row_version: z.coerce.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { f } = await frameworkFor(user, i.id, { write: true, c });
    if (i.row_version != null && i.row_version !== f.row_version) throw conflict('Someone else changed this framework. Reload and try again.', { row_version: f.row_version });
    if (i.owner_id) await ownerMember(c, f.organisation_id, i.owner_id);
    const set = [], v = [];
    const put = (col, val) => { v.push(val); set.push(`${col}=$${v.length}`); };
    for (const k of ['name', 'body_name', 'kind', 'level', 'owner_id', 'cycle_months', 'next_due_on', 'expires_on', 'remind_days', 'status']) if (i[k] !== undefined) put(k, i[k]);
    if (i.notes !== undefined) put('notes_enc', encryptFields({ notes: i.notes }, 'academy_accreditation_frameworks', ['notes']).notes_enc);
    if (i.status === 'archived') set.push('archived_at=now()');
    if (!set.length) return shapeFramework(c, f, { detail: true });
    v.push(f.id);
    const u = (await c.query(`UPDATE academy_accreditation_frameworks SET ${set.join(', ')}, row_version=row_version+1, updated_at=now() WHERE id=$${v.length} RETURNING *`, v)).rows[0];
    await event(c, f.organisation_id, i.status && i.status !== f.status ? `framework_${i.status}` : 'framework_updated', user.id, { framework_id: f.id }, { fields: Object.keys(i).filter((k) => !['id', 'row_version'].includes(k)) });
    return shapeFramework(c, u, { detail: true });
  }),
});

cap({
  name: 'save_academy_accreditation_requirement', method: 'POST', path: '/academy/accreditation-frameworks/:id/requirements', tag: TAG, status: 201,
  summary: 'Add a checklist item to a framework (what evidence it requires), or retire one by passing retire_id (it is kept, only hidden). Owners and admins only.',
  input: z.object({ id, requirement: RequirementIn.optional(), retire_id: id.optional() }).refine((x) => !!x.requirement !== !!x.retire_id, 'send either requirement or retire_id'),
  handler: ({ user }, i) => tx(async (c) => {
    const { f } = await frameworkFor(user, i.id, { write: true, c });
    if (i.retire_id) {
      const r = await c.query('UPDATE academy_accreditation_requirements SET retired_at=now() WHERE id=$1 AND framework_id=$2 AND retired_at IS NULL', [i.retire_id, f.id]);
      if (!r.rowCount) throw notFound('Requirement');
      await event(c, f.organisation_id, 'requirement_retired', user.id, { framework_id: f.id }, { requirement_id: i.retire_id });
    } else {
      if (i.requirement.comp_requirement_id) await ownCompRequirement(c, f.organisation_id, i.requirement.comp_requirement_id);
      const seq = (await c.query('SELECT coalesce(max(sequence)+1,0)::int AS n FROM academy_accreditation_requirements WHERE framework_id=$1', [f.id])).rows[0].n;
      await c.query('INSERT INTO academy_accreditation_requirements(framework_id, sequence, title, evidence_kind, required, comp_requirement_id) VALUES ($1,$2,$3,$4,$5,$6)', [f.id, seq, i.requirement.title, i.requirement.evidence_kind, i.requirement.required, i.requirement.comp_requirement_id ?? null]);
      await event(c, f.organisation_id, 'requirement_added', user.id, { framework_id: f.id }, { title: i.requirement.title });
    }
    return shapeFramework(c, f, { detail: true });
  }),
});

cap({
  name: 'get_academy_accreditation_framework', method: 'GET', path: '/academy/accreditation-frameworks/:id', tag: TAG,
  summary: 'One framework with its checklist: for every requirement, the evidence linked to it (compliance records and credentials, read live with their current validity and expiry), whether it is met, expiring, lapsed or missing, and the compliance percentage. Owners, admins and auditors.',
  input: z.object({ id }),
  handler: async ({ user }, i) => { const { f } = await frameworkFor(user, i.id); const r = await shapeFramework(pool, f, { detail: true }); await audit(null, user.id, 'read_accreditation_framework', 'academy_accreditation_frameworks', f.id); return r; },
});

// ------------------------------------------------------------------ evidence, by reference
cap({
  name: 'link_academy_accreditation_evidence', method: 'POST', path: '/academy/accreditation-frameworks/:id/evidence', tag: TAG, status: 201,
  summary: 'Link existing evidence to a checklist item: a compliance record (the organisation\'s own, or a member\'s) or a credential issued by this organisation. Nothing is copied; the link only points at the record, whose validity is read live. Owners and admins only.',
  input: z.object({ id, requirement_id: id, comp_record_id: id.optional(), credential_id: id.optional() }).refine((x) => !!x.comp_record_id !== !!x.credential_id, 'send exactly one of comp_record_id or credential_id'),
  handler: ({ user }, i) => tx(async (c) => {
    const { f } = await frameworkFor(user, i.id, { write: true, c });
    const q = (await c.query('SELECT 1 FROM academy_accreditation_requirements WHERE id=$1 AND framework_id=$2 AND retired_at IS NULL', [i.requirement_id, f.id])).rowCount;
    if (!q) throw notFound('Requirement');
    if (i.comp_record_id) {
      const r = (await c.query('SELECT subject_kind, subject_id FROM comp_records WHERE id=$1', [i.comp_record_id])).rows[0];
      const mine = r && (r.subject_kind === 'organisation' ? r.subject_id === f.organisation_id : r.subject_kind === 'person' && (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [f.organisation_id, r.subject_id])).rowCount > 0);
      if (!mine) throw notFound('Compliance record');
    } else if (!(await c.query('SELECT 1 FROM credentials WHERE id=$1 AND organisation_id=$2', [i.credential_id, f.organisation_id])).rowCount) throw notFound('Credential');
    const dup = (await c.query('SELECT 1 FROM academy_accreditation_evidence WHERE requirement_id=$1 AND ended_at IS NULL AND (comp_record_id=$2 OR credential_id=$3)', [i.requirement_id, i.comp_record_id ?? null, i.credential_id ?? null])).rowCount;
    if (dup) throw conflict('That evidence is already linked to this item');
    await c.query('INSERT INTO academy_accreditation_evidence(framework_id, requirement_id, comp_record_id, credential_id, linked_by) VALUES ($1,$2,$3,$4,$5)', [f.id, i.requirement_id, i.comp_record_id ?? null, i.credential_id ?? null, user.id]);
    await event(c, f.organisation_id, 'evidence_linked', user.id, { framework_id: f.id }, { requirement_id: i.requirement_id, comp_record_id: i.comp_record_id ?? null, credential_id: i.credential_id ?? null });
    return shapeFramework(c, f, { detail: true });
  }),
});

cap({
  name: 'unlink_academy_accreditation_evidence', method: 'POST', path: '/academy/accreditation-evidence/:id/unlink', tag: TAG,
  summary: 'End a link between a checklist item and a record. The link row is kept for the trail and the underlying record is never touched. Owners and admins only.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const e = (await c.query('SELECT * FROM academy_accreditation_evidence WHERE id=$1 AND ended_at IS NULL', [i.id])).rows[0];
    if (!e) throw notFound('Evidence link');
    const { f } = await frameworkFor(user, e.framework_id, { write: true, c });
    await c.query('UPDATE academy_accreditation_evidence SET ended_at=now(), ended_by=$2 WHERE id=$1', [e.id, user.id]);
    await event(c, f.organisation_id, 'evidence_unlinked', user.id, { framework_id: f.id }, { requirement_id: e.requirement_id });
    return shapeFramework(c, f, { detail: true });
  }),
});

cap({
  name: 'list_academy_accreditation_evidence_options', method: 'GET', path: '/organisations/:id/academy/accreditation-evidence-options', tag: TAG,
  summary: 'What can be linked as evidence: the organisation\'s own compliance records, its members\' compliance records, and the credentials it has issued, each with its current status and expiry. Use q to search by name.',
  input: z.object({ id, q: z.string().trim().max(80).optional() }),
  handler: async ({ user }, i) => {
    await orgAccess(user, i.id);
    const like = i.q ? `%${i.q.replace(/[%_]/g, '')}%` : null;
    const records = await many(
      `SELECT r.id, 'comp_record' AS ref_kind, cr.name AS label, cr.category, r.status, r.expires_on, CASE WHEN r.subject_kind='person' THEN u.display_name END AS person_name
         FROM comp_records r JOIN comp_requirements cr ON cr.id=r.requirement_id LEFT JOIN users u ON r.subject_kind='person' AND u.id=r.subject_id
        WHERE ((r.subject_kind='organisation' AND r.subject_id=$1) OR (r.subject_kind='person' AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=$1 AND m.user_id=r.subject_id AND m.status='active')))
          AND r.status IN ('valid','submitted') AND ($2::text IS NULL OR cr.name ILIKE $2 OR u.display_name ILIKE $2) ORDER BY cr.name, r.expires_on NULLS LAST LIMIT 60`, [i.id, like]);
    const credentials = await many(
      `SELECT c.id, 'credential' AS ref_kind, c.title AS label, c.kind AS category, c.status, c.expires_on, u.display_name AS person_name FROM credentials c JOIN users u ON u.id=c.user_id
        WHERE c.organisation_id=$1 AND c.status='issued' AND ($2::text IS NULL OR c.title ILIKE $2 OR u.display_name ILIKE $2) ORDER BY c.title LIMIT 60`, [i.id, like]);
    return { records: records.map((r) => ({ ...r, expires_on: plain(r.expires_on) })), credentials: credentials.map((r) => ({ ...r, expires_on: plain(r.expires_on) })) };
  },
});

// ------------------------------------------------------------------ the dashboard
cap({
  name: 'get_academy_accreditation_overview', method: 'GET', path: '/organisations/:id/academy/accreditation', tag: TAG,
  summary: 'The accreditation desk: every framework with its health (active, expiring, expired, draft, suspended), compliance percentage, open findings and corrective actions; upcoming audits; the open corrective-action queue (overdue first); and headline counts. Owners, admins and auditors.',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    const { manage } = await orgAccess(user, i.id);
    const fs = (await pool.query(`SELECT * FROM academy_accreditation_frameworks WHERE organisation_id=$1 ${i.include_archived ? '' : "AND status <> 'archived'"} ORDER BY name`, [i.id])).rows;
    const frameworks = [];
    for (const f of fs) frameworks.push(await shapeFramework(pool, f));
    const live = frameworks.filter((f) => f.status !== 'archived');
    const audits = (await pool.query(
      `SELECT a.*, f.name AS framework_name FROM academy_audits a JOIN academy_accreditation_frameworks f ON f.id=a.framework_id WHERE a.organisation_id=$1 AND a.status IN ('scheduled','findings_issued','resubmitted') ORDER BY a.scheduled_on LIMIT 30`, [i.id])).rows
      .map((a) => ({ id: a.id, framework_id: a.framework_id, framework_name: a.framework_name, kind: a.kind, scheduled_on: plain(a.scheduled_on), days_to: daysTo(a.scheduled_on), status: a.status, inspector_name: a.inspector_name, decision: a.decision }));
    const actions = (await pool.query(
      `SELECT y.id, y.title, y.due_on, y.owner_id, u.display_name AS owner_name, x.id AS finding_id, x.ref, x.severity, x.title AS finding_title, a.id AS audit_id, f.id AS framework_id, f.name AS framework_name
         FROM academy_audit_actions y JOIN academy_audit_findings x ON x.id=y.finding_id JOIN academy_audits a ON a.id=x.audit_id JOIN academy_accreditation_frameworks f ON f.id=a.framework_id LEFT JOIN users u ON u.id=y.owner_id
        WHERE y.organisation_id=$1 AND y.status='open' ORDER BY y.due_on NULLS LAST, x.severity LIMIT 60`, [i.id])).rows
      .map((y) => ({ ...y, due_on: plain(y.due_on), overdue: y.due_on ? daysTo(y.due_on) < 0 : false }));
    const avg = live.filter((f) => f.compliance.pct != null);
    return {
      organisation_id: i.id, can_manage: manage,
      kpis: {
        frameworks: live.length, active: live.filter((f) => f.health === 'active' || f.health === 'expiring').length,
        expiring: live.filter((f) => f.health === 'expiring').length, expired: live.filter((f) => f.health === 'expired').length,
        open_findings: live.reduce((s, f) => s + f.open_findings, 0), open_actions: actions.length, overdue_actions: actions.filter((y) => y.overdue).length,
        scheduled_audits: audits.filter((a) => a.status === 'scheduled').length,
        avg_compliance_pct: avg.length ? Math.round(avg.reduce((s, f) => s + f.compliance.pct, 0) / avg.length) : null,
      },
      frameworks, audits, actions,
    };
  },
});

// ------------------------------------------------------------------ audits
async function shapeAudit(c, a, { detail = false } = {}) {
  const fw = (await c.query('SELECT name, body_name FROM academy_accreditation_frameworks WHERE id=$1', [a.framework_id])).rows[0];
  const findings = (await c.query('SELECT * FROM academy_audit_findings WHERE audit_id=$1 ORDER BY ref', [a.id])).rows;
  const openN = findings.filter((x) => x.status === 'open').length;
  const base = {
    id: a.id, organisation_id: a.organisation_id, framework_id: a.framework_id, framework_name: fw?.name, body_name: fw?.body_name, kind: a.kind, scheduled_on: plain(a.scheduled_on), days_to: daysTo(a.scheduled_on),
    starts_at: a.starts_at?.slice(0, 5) ?? null, ends_at: a.ends_at?.slice(0, 5) ?? null, venue_name: a.venue_name, scope: a.scope, inspector_id: a.inspector_id, inspector_name: a.inspector_name,
    status: a.status, score: a.score, decision: a.decision, decided_at: a.decided_at, resubmit_by: plain(a.resubmit_by), findings_total: findings.length, findings_open: openN, row_version: a.row_version,
  };
  if (!detail) return base;
  const actions = (await c.query('SELECT y.*, u.display_name AS owner_name FROM academy_audit_actions y LEFT JOIN users u ON u.id=y.owner_id WHERE y.finding_id = ANY($1) ORDER BY y.created_at', [findings.map((x) => x.id)])).rows;
  const trail = (await c.query('SELECT e.id, e.kind, e.data, e.created_at, u.display_name AS actor_name FROM academy_accreditation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.audit_id=$1 ORDER BY e.created_at, e.id', [a.id])).rows;
  return {
    ...base, summary: a.summary_enc ? decryptFields(a, 'academy_audits', ['summary']).summary : null,
    findings: findings.map((x) => ({
      id: x.id, ref: x.ref, severity: x.severity, title: x.title, detail: x.detail_enc ? decryptFields(x, 'academy_audit_findings', ['detail']).detail : null, requirement_id: x.requirement_id, status: x.status, resolved_at: x.resolved_at,
      actions: actions.filter((y) => y.finding_id === x.id).map((y) => ({ id: y.id, title: y.title, owner_id: y.owner_id, owner_name: y.owner_name, due_on: plain(y.due_on), status: y.status, done_at: y.done_at, overdue: y.status === 'open' && y.due_on ? daysTo(y.due_on) < 0 : false, note: y.note_enc ? decryptFields(y, 'academy_audit_actions', ['note']).note : null })),
    })),
    trail,
  };
}

cap({
  name: 'schedule_academy_audit', method: 'POST', path: '/academy/accreditation-frameworks/:id/audits', tag: TAG, status: 201,
  summary: 'Schedule an audit of a framework: type (on-site, document review, remote), date and times, venue, the areas to verify and an optional inspector (a person on the platform, who then sees this audit only). Owners and admins only.',
  input: z.object({ id, kind: z.enum(AUDIT_KINDS), scheduled_on: date, starts_at: time.optional(), ends_at: time.optional(), venue_name: short(160, 1).optional(), scope: z.array(z.enum(SCOPES)).max(SCOPES.length).default([]), inspector_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { f } = await frameworkFor(user, i.id, { write: true, c });
    if (f.status === 'archived') throw conflict('This framework is archived');
    if (i.scheduled_on < today()) throw badRequest('Choose a date that is today or later');
    if (i.starts_at && i.ends_at && i.ends_at <= i.starts_at) throw badRequest('The end time must be after the start');
    let name = null;
    if (i.inspector_id) { name = (await c.query('SELECT display_name FROM users WHERE id=$1', [i.inspector_id])).rows[0]?.display_name; if (!name) throw notFound('Inspector'); }
    const a = (await c.query(
      `INSERT INTO academy_audits(organisation_id, framework_id, kind, scheduled_on, starts_at, ends_at, venue_name, scope, inspector_id, inspector_name, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [f.organisation_id, f.id, i.kind, i.scheduled_on, i.starts_at ?? null, i.ends_at ?? null, i.venue_name ?? null, i.scope, i.inspector_id ?? null, name, user.id])).rows[0];
    await event(c, f.organisation_id, 'audit_scheduled', user.id, { framework_id: f.id, audit_id: a.id }, { scheduled_on: i.scheduled_on, kind: i.kind, inspector_id: i.inspector_id ?? null });
    return shapeAudit(c, a, { detail: true });
  }),
});

cap({
  name: 'list_academy_audits', method: 'GET', path: '/organisations/:id/academy/audits', tag: TAG,
  summary: 'Audits for the organisation, newest first, optionally for one framework or status. Owners, admins and auditors.',
  input: z.object({ id, framework_id: id.optional(), status: z.enum(['scheduled', 'findings_issued', 'resubmitted', 'closed', 'cancelled']).optional() }),
  handler: async ({ user }, i) => {
    await orgAccess(user, i.id);
    const rows = (await pool.query('SELECT * FROM academy_audits WHERE organisation_id=$1 AND ($2::uuid IS NULL OR framework_id=$2) AND ($3::text IS NULL OR status=$3) ORDER BY scheduled_on DESC LIMIT 100', [i.id, i.framework_id ?? null, i.status ?? null])).rows;
    const out = []; for (const a of rows) out.push(await shapeAudit(pool, a));
    return out;
  },
});

cap({
  name: 'list_my_academy_audits', method: 'GET', path: '/academy/audits/mine', tag: TAG,
  summary: 'Audits where the caller is the assigned inspector, across organisations. An inspector sees only these audits, never the rest of the academy.',
  input: z.object({}),
  handler: async ({ user }) => {
    const rows = (await pool.query("SELECT a.*, o.name AS organisation_name FROM academy_audits a JOIN organisations o ON o.id=a.organisation_id WHERE a.inspector_id=$1 AND a.status <> 'cancelled' ORDER BY a.scheduled_on DESC LIMIT 100", [user.id])).rows;
    const out = []; for (const a of rows) out.push({ ...(await shapeAudit(pool, a)), organisation_name: a.organisation_name });
    return out;
  },
});

cap({
  name: 'get_academy_audit', method: 'GET', path: '/academy/audits/:id', tag: TAG,
  summary: 'One audit with its findings, corrective actions and the decision trail. Free text is decrypted and the read is audit-logged. Owners, admins, auditors and the assigned inspector.',
  input: z.object({ id }),
  handler: async ({ user }, i) => { const { a } = await auditFor(user, i.id); const r = await shapeAudit(pool, a, { detail: true }); await audit(null, user.id, 'read_academy_audit', 'academy_audits', a.id); return r; },
});

cap({
  name: 'cancel_academy_audit', method: 'POST', path: '/academy/audits/:id/cancel', tag: TAG,
  summary: 'Cancel an audit that has not produced a decision. The audit and its trail are kept. Owners and admins only.',
  input: z.object({ id, reason: short(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await auditFor(user, i.id, { write: true, c });
    if (a.status !== 'scheduled') throw conflict('Only a scheduled audit can be cancelled');
    const u = (await c.query("UPDATE academy_audits SET status='cancelled', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [a.id])).rows[0];
    await event(c, a.organisation_id, 'audit_cancelled', user.id, { framework_id: a.framework_id, audit_id: a.id }, { reason: i.reason ?? null });
    return shapeAudit(c, u, { detail: true });
  }),
});

// ------------------------------------------------------------------ findings and corrective actions
cap({
  name: 'record_academy_audit_finding', method: 'POST', path: '/academy/audits/:id/findings', tag: TAG, status: 201,
  summary: 'Record a finding against an audit (severity high, medium, low or observation), optionally tied to a checklist item, with corrective actions (each with an owner and a due date). Done by the assigned inspector or an owner or admin. The detail is encrypted.',
  input: z.object({ id, severity: z.enum(SEVERITIES), title: short(200), detail: z.string().trim().max(4000).optional(), requirement_id: id.optional(), actions: z.array(z.object({ title: short(200), owner_id: id.optional(), due_on: date.optional() })).max(10).default([]) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await auditFor(user, i.id, { write: true, inspector: true, c });
    if (['closed', 'cancelled'].includes(a.status)) throw conflict('This audit is closed');
    if (i.requirement_id && !(await c.query('SELECT 1 FROM academy_accreditation_requirements WHERE id=$1 AND framework_id=$2', [i.requirement_id, a.framework_id])).rowCount) throw notFound('Requirement');
    for (const y of i.actions) await ownerMember(c, a.organisation_id, y.owner_id);
    await c.query('SELECT id FROM academy_audits WHERE id=$1 FOR UPDATE', [a.id]);
    const n = (await c.query('SELECT count(*)::int+1 AS n FROM academy_audit_findings WHERE audit_id=$1', [a.id])).rows[0].n;
    const ref = `F-${String(n).padStart(3, '0')}`;
    const x = (await c.query('INSERT INTO academy_audit_findings(audit_id, organisation_id, ref, severity, title, detail_enc, requirement_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [a.id, a.organisation_id, ref, i.severity, i.title, i.detail ? encryptFields({ detail: i.detail }, 'academy_audit_findings', ['detail']).detail_enc : null, i.requirement_id ?? null, user.id])).rows[0];
    for (const y of i.actions) await c.query('INSERT INTO academy_audit_actions(finding_id, organisation_id, title, owner_id, due_on, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [x.id, a.organisation_id, y.title, y.owner_id ?? null, y.due_on ?? null, user.id]);
    await event(c, a.organisation_id, 'finding_recorded', user.id, { framework_id: a.framework_id, audit_id: a.id, finding_id: x.id }, { ref, severity: i.severity, title: i.title, actions: i.actions.length });
    return shapeAudit(c, a, { detail: true });
  }),
});

cap({
  name: 'add_academy_corrective_action', method: 'POST', path: '/academy/audit-findings/:id/actions', tag: TAG, status: 201,
  summary: 'Add a corrective action to a finding, with an owner (an active member) and a due date. Owners and admins, or the assigned inspector.',
  input: z.object({ id, title: short(200), owner_id: id.optional(), due_on: date.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const x = (await c.query('SELECT * FROM academy_audit_findings WHERE id=$1', [i.id])).rows[0];
    if (!x) throw notFound('Finding');
    const { a } = await auditFor(user, x.audit_id, { write: true, inspector: true, c });
    await ownerMember(c, a.organisation_id, i.owner_id);
    await c.query('INSERT INTO academy_audit_actions(finding_id, organisation_id, title, owner_id, due_on, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [x.id, a.organisation_id, i.title, i.owner_id ?? null, i.due_on ?? null, user.id]);
    await event(c, a.organisation_id, 'action_added', user.id, { framework_id: a.framework_id, audit_id: a.id, finding_id: x.id }, { title: i.title, owner_id: i.owner_id ?? null, due_on: i.due_on ?? null });
    return shapeAudit(c, a, { detail: true });
  }),
});

cap({
  name: 'complete_academy_corrective_action', method: 'POST', path: '/academy/audit-actions/:id/complete', tag: TAG,
  summary: 'Mark a corrective action done (or cancelled), with an optional note (encrypted). The action\'s owner, or an owner or admin, can do it.',
  input: z.object({ id, outcome: z.enum(['done', 'cancelled']).default('done'), note: z.string().trim().max(2000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const y = (await c.query('SELECT y.*, x.audit_id FROM academy_audit_actions y JOIN academy_audit_findings x ON x.id=y.finding_id WHERE y.id=$1 FOR UPDATE OF y', [i.id])).rows[0];
    if (!y) throw notFound('Action');
    const a = (await c.query('SELECT * FROM academy_audits WHERE id=$1', [y.audit_id])).rows[0];
    const role = await orgRole(user, a.organisation_id, c);
    if (!role) throw notFound('Action');
    await orgFor(user, a.organisation_id, undefined, { write: true, c });
    if (!ADMINS.includes(role) && y.owner_id !== user.id) throw forbidden('Only the action owner, an owner or an admin can complete this');
    if (y.status !== 'open') throw conflict('This action is already closed');
    await c.query('UPDATE academy_audit_actions SET status=$2, done_by=$3, done_at=now(), note_enc=$4 WHERE id=$1', [y.id, i.outcome, user.id, i.note ? encryptFields({ note: i.note }, 'academy_audit_actions', ['note']).note_enc : null]);
    await event(c, a.organisation_id, `action_${i.outcome}`, user.id, { framework_id: a.framework_id, audit_id: a.id, finding_id: y.finding_id }, { title: y.title });
    return shapeAudit(c, a, { detail: true });
  }),
});

cap({
  name: 'resolve_academy_audit_finding', method: 'POST', path: '/academy/audit-findings/:id/resolve', tag: TAG,
  summary: 'Resolve a finding, or accept the risk with a reason. Every corrective action must be done or cancelled first. Owners and admins only; the inspector confirms on sign-off.',
  input: z.object({ id, outcome: z.enum(['resolved', 'accepted_risk']).default('resolved'), reason: short(500).optional() }).refine((x) => x.outcome !== 'accepted_risk' || !!x.reason, 'accepting a risk needs a reason'),
  handler: ({ user }, i) => tx(async (c) => {
    const x = (await c.query('SELECT * FROM academy_audit_findings WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!x) throw notFound('Finding');
    const { a } = await auditFor(user, x.audit_id, { write: true, c });
    if (x.status !== 'open') throw conflict('This finding is already closed');
    const left = (await c.query("SELECT count(*)::int AS n FROM academy_audit_actions WHERE finding_id=$1 AND status='open'", [x.id])).rows[0].n;
    if (left && i.outcome === 'resolved') throw conflict(`${left} corrective action${left === 1 ? ' is' : 's are'} still open`, { open_actions: left });
    await c.query('UPDATE academy_audit_findings SET status=$2, resolved_by=$3, resolved_at=now() WHERE id=$1', [x.id, i.outcome, user.id]);
    await event(c, a.organisation_id, `finding_${i.outcome}`, user.id, { framework_id: a.framework_id, audit_id: a.id, finding_id: x.id }, { ref: x.ref, reason: i.reason ?? null });
    return shapeAudit(c, a, { detail: true });
  }),
});

// ------------------------------------------------------------------ decision, resubmission, sign-off
cap({
  name: 'decide_academy_audit', method: 'POST', path: '/academy/audits/:id/decision', tag: TAG,
  summary: 'Issue the audit decision: pass, conditional pass (needs a resubmission date) or fail, with a score of 0 to 100 and a summary (encrypted). The assigned inspector, or an owner or admin recording the inspector\'s result, can do this. A pass with no open findings closes the audit and moves the framework\'s next-due and expiry dates on by its cycle. A conditional pass sets the next-due date to the resubmission date. No federation-issued licence is changed.',
  input: z.object({ id, decision: z.enum(['pass', 'conditional_pass', 'fail']), score: z.coerce.number().int().min(0).max(100), resubmit_by: date.optional(), summary: z.string().trim().max(4000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await auditFor(user, i.id, { write: true, inspector: true, c });
    if (!['scheduled', 'findings_issued', 'resubmitted'].includes(a.status)) throw conflict('This audit can no longer take a decision');
    if (i.decision === 'conditional_pass' && !i.resubmit_by) throw badRequest('A conditional pass needs a resubmission date');
    if (i.resubmit_by && i.resubmit_by <= today()) throw badRequest('The resubmission date must be in the future');
    const open = (await c.query("SELECT count(*)::int AS n FROM academy_audit_findings WHERE audit_id=$1 AND status='open'", [a.id])).rows[0].n;
    if (i.decision === 'pass' && open) throw conflict(`${open} finding${open === 1 ? ' is' : 's are'} still open, so this cannot be a clean pass`, { open_findings: open });
    const status = i.decision === 'pass' ? 'closed' : 'findings_issued';
    const u = (await c.query('UPDATE academy_audits SET decision=$2, score=$3, resubmit_by=$4, status=$5, decided_by=$6, decided_at=now(), summary_enc=coalesce($7, summary_enc), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *',
      [a.id, i.decision, i.score, i.resubmit_by ?? null, status, user.id, i.summary ? encryptFields({ summary: i.summary }, 'academy_audits', ['summary']).summary_enc : null])).rows[0];
    const f = (await c.query('SELECT * FROM academy_accreditation_frameworks WHERE id=$1 FOR UPDATE', [a.framework_id])).rows[0];
    if (i.decision === 'pass') { const to = addMonths(plain(a.scheduled_on), f.cycle_months); await c.query("UPDATE academy_accreditation_frameworks SET next_due_on=$2, expires_on=$2, status=CASE WHEN status='draft' THEN 'active' ELSE status END, row_version=row_version+1, updated_at=now() WHERE id=$1", [f.id, to]); }
    else if (i.decision === 'conditional_pass') await c.query('UPDATE academy_accreditation_frameworks SET next_due_on=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [f.id, i.resubmit_by]);
    await event(c, a.organisation_id, 'audit_decided', user.id, { framework_id: a.framework_id, audit_id: a.id }, { decision: i.decision, score: i.score, resubmit_by: i.resubmit_by ?? null, open_findings: open, by_inspector: a.inspector_id === user.id });
    return shapeAudit(c, u, { detail: true });
  }),
});

cap({
  name: 'resubmit_academy_audit', method: 'POST', path: '/academy/audits/:id/resubmit', tag: TAG,
  summary: 'Send an audit back to the inspector once every high and medium finding is resolved or risk-accepted. The trail records who resubmitted and when. Owners and admins only.',
  input: z.object({ id, note: short(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await auditFor(user, i.id, { write: true, c });
    if (a.status !== 'findings_issued') throw conflict('Only an audit with issued findings can be resubmitted');
    const blocking = (await c.query("SELECT count(*)::int AS n FROM academy_audit_findings WHERE audit_id=$1 AND status='open' AND severity IN ('high','medium')", [a.id])).rows[0].n;
    if (blocking) throw conflict(`${blocking} high or medium finding${blocking === 1 ? ' is' : 's are'} still open`, { open_blocking: blocking });
    const u = (await c.query("UPDATE academy_audits SET status='resubmitted', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [a.id])).rows[0];
    await event(c, a.organisation_id, 'audit_resubmitted', user.id, { framework_id: a.framework_id, audit_id: a.id }, { note: i.note ?? null });
    return shapeAudit(c, u, { detail: true });
  }),
});

cap({
  name: 'list_academy_accreditation_trail', method: 'GET', path: '/organisations/:id/academy/accreditation/trail', tag: TAG,
  summary: 'The append-only decision trail for the organisation or one framework: who did what and when. Entries cannot be edited or removed. Owners, admins and auditors.',
  input: z.object({ id, framework_id: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }),
  handler: async ({ user }, i) => {
    await orgAccess(user, i.id);
    return (await pool.query('SELECT e.id, e.kind, e.framework_id, e.audit_id, e.finding_id, e.data, e.created_at, u.display_name AS actor_name FROM academy_accreditation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.organisation_id=$1 AND ($2::uuid IS NULL OR e.framework_id=$2) ORDER BY e.created_at DESC, e.id DESC LIMIT $3', [i.id, i.framework_id ?? null, i.limit])).rows;
  },
});
