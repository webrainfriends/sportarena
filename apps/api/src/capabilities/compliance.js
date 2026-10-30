// Compliance, safeguarding & eligibility (#595), part 1: the rulebook (requirements and obligations), the catalogue the app builds its controls from,
// and the questions "what is missing or expiring?" for a person, organisation or event, and "who is short?" for a scope.
// Rules are data, owned by a scope (platform, organisation, governing body, event) and enforced here on the server. See src/compliance.js for the engine.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { badRequest, conflict, notFound, forbidden } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { orgRole } from '../org-access.js';
import { authority, can } from '../federation.js';
import { TYPES as VERIFICATION_TYPES } from '../verification.js';
import {
  CATEGORIES, CONSEQUENCES, METHODS, SCOPES, SENSITIVE_CATEGORIES, SOURCE_KINDS, STATE_LABEL, SUBJECTS,
  evaluateSubject, holderAccess, manages, nameFor, roleChoices, sourceProblems, subjectsInScope, summarise,
} from '../compliance.js';
import {
  CLASSIFICATIONS, CLASS_LABEL, CLASS_RANK, DEFAULT_CLASS, EVENT_TYPES, FIRST_JURISDICTIONS, NEEDS_SECOND_APPROVER, OUTCOMES, SCOPE_CLASSES, STATUSES, statusCounts,
} from '../compliance-policy.js';

export const TAG = 'Compliance';
const CREDENTIAL_KINDS = ['insurance', 'electrical', 'pool_operator', 'first_aid', 'safeguarding', 'vehicle', 'food_safety', 'business_registration', 'other'];
const day = z.string().date();
const text = (n) => z.string().trim().max(n);
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export const log = (c, e) => c.query(
  'INSERT INTO comp_events(requirement_id, record_id, subject_kind, subject_id, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
  [e.requirement_id ?? null, e.record_id ?? null, e.subject_kind ?? null, e.subject_id ?? null, e.actor_id ?? null, e.action, JSON.stringify(e.detail ?? {})]);

const scopeRule = (x) => (x.scope_kind === 'platform') === !x.scope_id;
const scopeMsg = { message: 'Platform requirements have no scope id; every other scope needs one', path: ['scope_id'] };

/** The scope a caller names, if they may manage it; 404 otherwise so a scope's existence is not probed. */
async function mustManage(user, scopeKind, scopeId, { write = false } = {}) {
  if (!(await manages(user, scopeKind, scopeId ?? null, { write }))) throw notFound(scopeKind === 'platform' ? 'Compliance scope' : `${scopeKind[0].toUpperCase()}${scopeKind.slice(1)}`);
}
export async function loadRequirement(rid, { live = true } = {}) {
  const r = await one(`SELECT * FROM comp_requirements WHERE id=$1${live ? ' AND archived_at IS NULL' : ''}`, [rid]);
  if (!r) throw notFound('Requirement');
  return r;
}

// ---------------------------------------------------------------- catalogue
cap({
  name: 'get_compliance_catalogue', method: 'GET', path: '/compliance/catalogue', tag: TAG,
  summary: 'Everything the compliance screens build their controls from: categories, methods, what an unmet requirement can block, the roles each scope can target, the platform verifications / supplier credentials a requirement can be linked to, and the scopes the caller can run (platform for the platform team, organisations they own or administer, events they organise, governing bodies they work for).',
  input: z.object({}),
  async handler({ user }) {
    const scopes = [];
    if (isAdmin(user)) scopes.push({ kind: 'platform', id: null, name: 'SportArena (platform)', write: true });
    for (const o of await many("SELECT o.id, o.name FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin') AND o.status='active' ORDER BY o.name", [user.id])) scopes.push({ kind: 'organisation', id: o.id, name: o.name, write: true });
    for (const e of await many(
      `SELECT DISTINCT e.id, e.name FROM events e WHERE e.status <> 'cancelled' AND (e.organizer_id=$1 OR e.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin'))) ORDER BY e.name LIMIT 100`, [user.id])) scopes.push({ kind: 'event', id: e.id, name: e.name, write: true });
    const bodies = await many(
      `SELECT DISTINCT b.id, o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id
        WHERE EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin'))
           OR EXISTS (SELECT 1 FROM governing_body_roles r WHERE r.body_id=b.id AND r.user_id=$1 AND r.status='active') ORDER BY o.name`, [user.id]);
    for (const b of bodies) { const auth = await authority(user, b.id, { optional: true }); if (auth && !auth.viaAncestor) scopes.push({ kind: 'body', id: b.id, name: b.name, write: auth.admin || auth.roles.some((r) => ['licensing', 'registrar'].includes(r.role)), read_only: !(auth.admin || auth.roles.some((r) => ['licensing', 'registrar'].includes(r.role))) && (can(auth, 'evidence') || can(auth, 'reports')) }); }
    const roles = { person: Object.fromEntries(SCOPES.map((s) => [s, roleChoices(s, 'person')])), organisation: roleChoices('platform', 'organisation'), event: roleChoices('platform', 'event') };
    return {
      categories: Object.entries(CATEGORIES).map(([value, label]) => ({ value, label, sensitive: SENSITIVE_CATEGORIES.includes(value) })),
      methods: Object.entries(METHODS).map(([value, label]) => ({ value, label })),
      consequences: Object.entries(CONSEQUENCES).map(([value, label]) => ({ value, label })),
      subjects: [{ value: 'person', label: 'People' }, { value: 'organisation', label: 'Organisations' }, { value: 'event', label: 'Events' }],
      sources: { kinds: Object.entries(SOURCE_KINDS).map(([value, label]) => ({ value, label })), verification_types: VERIFICATION_TYPES, credential_kinds: CREDENTIAL_KINDS },
      states: Object.entries(STATE_LABEL).map(([value, label]) => ({ value, label })),
      classifications: CLASSIFICATIONS.map((value) => ({ value, label: CLASS_LABEL[value], rank: CLASS_RANK[value], needs_second_approver: NEEDS_SECOND_APPROVER.includes(value), scopes: SCOPES.filter((k) => SCOPE_CLASSES[k].includes(value)) })),
      outcomes: OUTCOMES, statuses: STATUSES, event_types: EVENT_TYPES, jurisdictions: FIRST_JURISDICTIONS,
      precedence: ['Rules of one topic compete: the higher classification wins', 'then the narrower jurisdiction (municipality, state or province, country)', 'then the more specific applicability', 'then the later effective date, then the higher version', 'Rules of different topics all apply'],
      roles, scopes,
    };
  },
});

// ---------------------------------------------------------------- requirements
const reqFields = {
  name: text(120).min(2), description: text(1000).optional(), category: z.enum(Object.keys(CATEGORIES)), subject_kind: z.enum(SUBJECTS).default('person'),
  method: z.enum(Object.keys(METHODS)), source: z.object({ kind: z.enum(Object.keys(SOURCE_KINDS)), type: z.string().optional(), licence_type_id: id.optional(), body_id: id.optional(), credential_kind: z.enum(CREDENTIAL_KINDS).optional() }).optional(),
  requires_review: z.boolean().default(true), validity_days: z.number().int().min(1).max(3660).nullable().optional(),
  reminder_days: z.array(z.number().int().min(1).max(365)).max(5).default([60, 30, 7]), grace_days: z.number().int().min(0).max(180).default(0),
  escalate_after_days: z.number().int().min(0).max(180).default(7), statement: text(4000).optional(),
  // the policy facts of a rule (#568)
  classification: z.enum(CLASSIFICATIONS).optional(), topic: z.string().regex(/^[a-z0-9_.]{2,60}$/).nullable().optional(),
  source_title: text(200).nullable().optional(), source_url: z.string().url().max(500).nullable().optional(), approval_owner: text(120).nullable().optional(), waivable: z.boolean().nullable().optional(),
};
const SUBSTANTIVE = ['category', 'method', 'source', 'validity_days', 'statement', 'subject_kind'];   // wording or source changes start a version; policy facts (classification, topic) are carried on the row and in each snapshot

const viewReq = (r) => ({
  id: r.id, scope: { kind: r.scope_kind, id: r.scope_id }, code: r.code, name: r.name, description: r.description, category: r.category, category_label: CATEGORIES[r.category], subject_kind: r.subject_kind,
  method: r.method, source: r.method === 'linked' ? r.source : null, sensitive: r.sensitive, requires_review: r.requires_review, validity_days: r.validity_days, reminder_days: r.reminder_days,
  grace_days: r.grace_days, escalate_after_days: r.escalate_after_days, statement: r.statement, version: r.version, archived: !!r.archived_at, updated_at: r.updated_at,
  classification: r.classification, classification_label: CLASS_LABEL[r.classification], topic: r.topic ?? null, source_title: r.source_title ?? null, source_url: r.source_url ?? null,
  approval_owner: r.approval_owner ?? null, waivable: r.waivable ?? null, approval_status: r.approval_status, approved_at: r.approved_at ?? null,
});
const viewOb = (o, roleLabels) => ({
  id: o.id, requirement_id: o.requirement_id, roles: o.roles, role_labels: o.roles.map((v) => roleLabels.get(v) ?? v), sport_id: o.sport_id, sport_name: o.sport_name ?? null, youth_work: o.youth_work, mandatory: o.mandatory,
  consequences: o.consequences, starts_on: o.starts_on, ends_on: o.ends_on, archived: !!o.archived_at,
  country: o.country ?? null, region: o.region ?? null, municipality: o.municipality ?? null, body_ids: o.body_ids ?? [], competition_ids: o.competition_ids ?? [], venue_ids: o.venue_ids ?? [],
  event_types: o.event_types ?? [], min_age: o.min_age ?? null, max_age: o.max_age ?? null,
});

function checkReq(i, ex) {
  const cat = i.category ?? ex?.category, method = i.method ?? ex?.method, subject = i.subject_kind ?? ex?.subject_kind;
  if (method === 'linked') {
    const p = sourceProblems(i.source ?? ex?.source);
    if (p) throw badRequest(p);
    if (subject === 'event' && (i.source ?? ex?.source).kind !== 'verification') throw badRequest('An event requirement can only be checked from a platform verification, or be answered with evidence');
  }
  if (method === 'declaration' && !(i.statement ?? ex?.statement)) throw badRequest('Write the statement people will read and agree to');
  if (SENSITIVE_CATEGORIES.includes(cat) && (method === 'declaration' || (i.requires_review ?? ex?.requires_review) === false)) throw badRequest('A background check status is always confirmed by a reviewer; it cannot be a self-declaration');
  if (cat === 'background_check' && subject !== 'person') throw badRequest('A background check status applies to people');
}

cap({
  name: 'save_compliance_requirement', method: 'POST', path: '/compliance/requirements', tag: TAG, status: 201,
  summary: 'Create or change a compliance requirement for a scope you run: what is needed (a certificate, a background-check status, safeguarding training or acknowledgement, a federation requirement, an event permit, insurance, a licence, a declaration, a conflict-of-interest declaration, an attestation), how it is satisfied (evidence a reviewer approves, a declaration, or an existing platform verification / federation licence / supplier credential read live), validity and renewal, reminder days, grace and escalation. Changing the wording, validity or source starts a new version; old records keep the version they were made under. Nothing is deleted: use archive.',
  input: z.object({ requirement_id: id.optional(), scope_kind: z.enum(SCOPES), scope_id: id.optional(), ...reqFields, code: z.string().regex(/^[a-z0-9_]{2,40}$/).optional() }).refine(scopeRule, scopeMsg),
  async handler({ user }, i) {
    await mustManage(user, i.scope_kind, i.scope_id, { write: true });
    return tx(async (c) => {
      let ex = null;
      if (i.requirement_id) {
        ex = (await c.query('SELECT * FROM comp_requirements WHERE id=$1 FOR UPDATE', [i.requirement_id])).rows[0];
        if (!ex || ex.scope_kind !== i.scope_kind || (ex.scope_id ?? null) !== (i.scope_id ?? null)) throw notFound('Requirement');
        if (ex.archived_at) throw conflict('This requirement is archived');
        const used = (await c.query('SELECT 1 FROM comp_records WHERE requirement_id=$1 LIMIT 1', [ex.id])).rowCount;
        if (used && (i.subject_kind !== ex.subject_kind || i.method !== ex.method)) throw conflict('Records already exist, so who it applies to and how it is satisfied cannot change. Archive it and create a new one.');
      }
      checkReq(i, ex);
      const classification = i.classification ?? ex?.classification ?? DEFAULT_CLASS[i.scope_kind];
      if (!SCOPE_CLASSES[i.scope_kind].includes(classification)) throw badRequest(`A ${i.scope_kind} cannot write a ${CLASS_LABEL[classification].toLowerCase()} rule`);
      if (ex && (NEEDS_SECOND_APPROVER.includes(classification) || NEEDS_SECOND_APPROVER.includes(ex.classification)) && ex.approval_status === 'approved') {
        throw conflict('A law or regulation is not edited once approved. End it and write the new one, which a second administrator approves.', { code: 'law_not_editable' });
      }
      if (ex && classification !== ex.classification && (NEEDS_SECOND_APPROVER.includes(classification) || NEEDS_SECOND_APPROVER.includes(ex.classification))) throw conflict('A rule cannot become, or stop being, a law or regulation. Write it again.', { code: 'class_locked' });
      const policy = {
        classification, topic: i.topic === undefined ? ex?.topic ?? null : i.topic, source_title: i.source_title === undefined ? ex?.source_title ?? null : i.source_title,
        source_url: i.source_url === undefined ? ex?.source_url ?? null : i.source_url, approval_owner: i.approval_owner === undefined ? ex?.approval_owner ?? null : i.approval_owner,
        waivable: i.waivable === undefined ? ex?.waivable ?? null : i.waivable,
      };
      if (NEEDS_SECOND_APPROVER.includes(classification)) policy.waivable = false;       // a law or a regulation is never the organisation's to waive
      const sensitive = SENSITIVE_CATEGORIES.includes(i.category);
      const body = {
        name: i.name, description: i.description ?? null, category: i.category, subject_kind: i.subject_kind, method: i.method, source: i.method === 'linked' ? i.source : {}, sensitive,
        requires_review: i.method === 'evidence' ? (sensitive ? true : i.requires_review) : false, validity_days: i.validity_days ?? null,
        reminder_days: [...new Set(i.reminder_days)].sort((a, b) => b - a), grace_days: i.grace_days, escalate_after_days: i.escalate_after_days, statement: i.method === 'declaration' ? i.statement : null,
      };
      if (!ex) {
        const code = i.code ?? (slug(i.name) || 'requirement');
        const row = (await c.query(
          `INSERT INTO comp_requirements(scope_kind, scope_id, code, name, description, category, subject_kind, method, source, sensitive, requires_review, validity_days, reminder_days, grace_days, escalate_after_days, statement, created_by,
                                         classification, topic, source_title, source_url, approval_owner, waivable, approval_status, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, CASE WHEN $24 = 'approved' THEN now() END) ON CONFLICT DO NOTHING RETURNING *`,
          [i.scope_kind, i.scope_id ?? null, code, body.name, body.description, body.category, body.subject_kind, body.method, JSON.stringify(body.source), body.sensitive, body.requires_review, body.validity_days, body.reminder_days, body.grace_days, body.escalate_after_days, body.statement, user.id,
            policy.classification, policy.topic, policy.source_title, policy.source_url, policy.approval_owner, policy.waivable, NEEDS_SECOND_APPROVER.includes(classification) ? 'pending_approval' : 'approved', NEEDS_SECOND_APPROVER.includes(classification) ? null : user.id])).rows[0];
        if (!row) throw conflict('A requirement with this name already exists here');
        await c.query('INSERT INTO comp_requirement_versions(requirement_id, version, snapshot, changed_by) VALUES ($1,1,$2,$3)', [row.id, JSON.stringify(viewReq(row)), user.id]);
        await log(c, { requirement_id: row.id, actor_id: user.id, action: 'requirement_created', detail: { name: row.name, version: 1 } });
        return viewReq(row);
      }
      const bump = SUBSTANTIVE.some((k) => JSON.stringify(k === 'source' ? (body.source ?? {}) : body[k] ?? null) !== JSON.stringify(k === 'source' ? (ex.source ?? {}) : ex[k] ?? null));
      const version = ex.version + (bump ? 1 : 0);
      const row = (await c.query(
        `UPDATE comp_requirements SET name=$2, description=$3, category=$4, method=$5, source=$6, sensitive=$7, requires_review=$8, validity_days=$9, reminder_days=$10, grace_days=$11, escalate_after_days=$12, statement=$13, version=$14, updated_at=now(),
                classification=$15, topic=$16, source_title=$17, source_url=$18, approval_owner=$19, waivable=$20 WHERE id=$1 RETURNING *`,
        [ex.id, body.name, body.description, body.category, body.method, JSON.stringify(body.source), body.sensitive, body.requires_review, body.validity_days, body.reminder_days, body.grace_days, body.escalate_after_days, body.statement, version,
          policy.classification, policy.topic, policy.source_title, policy.source_url, policy.approval_owner, policy.waivable])).rows[0];
      if (bump) await c.query('INSERT INTO comp_requirement_versions(requirement_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4)', [row.id, version, JSON.stringify(viewReq(row)), user.id]);
      await log(c, { requirement_id: row.id, actor_id: user.id, action: 'requirement_updated', detail: { version, new_version: bump } });
      return viewReq(row);
    });
  },
});

cap({
  name: 'archive_compliance_requirement', method: 'POST', path: '/compliance/requirements/:id/archive', tag: TAG,
  summary: 'Archive (or restore) a requirement. Its records, history and past decisions are kept; an archived requirement no longer applies to anyone and blocks nothing.',
  input: z.object({ id, archived: z.boolean().default(true) }),
  async handler({ user }, i) {
    const r = await loadRequirement(i.id, { live: false });
    await mustManage(user, r.scope_kind, r.scope_id, { write: true });
    const row = (await one('UPDATE comp_requirements SET archived_at = CASE WHEN $2 THEN coalesce(archived_at, now()) ELSE NULL END, updated_at=now() WHERE id=$1 RETURNING *', [i.id, i.archived]));
    await log(pool, { requirement_id: r.id, actor_id: user.id, action: i.archived ? 'requirement_archived' : 'requirement_restored' });
    return viewReq(row);
  },
});

cap({
  name: 'list_compliance_requirements', method: 'GET', path: '/compliance/requirements', tag: TAG,
  summary: 'The requirements of a scope you run, each with the obligations that say who must meet it and what an unmet one blocks, plus how many records are valid, awaiting review or expiring within 30 days.',
  input: z.object({ scope_kind: z.enum(SCOPES), scope_id: id.optional(), include_archived: z.coerce.boolean().default(false) }).refine((x) => (x.scope_kind === 'platform') === !x.scope_id, { message: 'scope_id is required for every scope except platform' }),
  async handler({ user }, i) {
    await mustManage(user, i.scope_kind, i.scope_id);
    const reqs = await many(`SELECT * FROM comp_requirements WHERE scope_kind=$1 AND scope_id IS NOT DISTINCT FROM $2 ${i.include_archived ? '' : 'AND archived_at IS NULL'} ORDER BY name`, [i.scope_kind, i.scope_id ?? null]);
    const obs = reqs.length ? await many('SELECT o.*, s.name AS sport_name FROM comp_obligations o LEFT JOIN sports s ON s.id=o.sport_id WHERE o.requirement_id = ANY($1) AND o.archived_at IS NULL ORDER BY o.created_at', [reqs.map((r) => r.id)]) : [];
    const counts = reqs.length ? await many(
      `SELECT requirement_id, count(*) FILTER (WHERE status='valid' AND (expires_on IS NULL OR expires_on >= current_date))::int AS valid, count(*) FILTER (WHERE status='submitted')::int AS awaiting,
              count(*) FILTER (WHERE status='valid' AND expires_on BETWEEN current_date AND current_date + 30)::int AS expiring FROM comp_records WHERE requirement_id = ANY($1) GROUP BY requirement_id`, [reqs.map((r) => r.id)]) : [];
    const labels = new Map();
    return {
      requirements: reqs.map((r) => {
        const sub = r.subject_kind;
        for (const x of roleChoices(r.scope_kind, sub)) labels.set(x.value, x.label);
        return { ...viewReq(r), obligations: obs.filter((o) => o.requirement_id === r.id).map((o) => viewOb(o, labels)), counts: counts.find((x) => x.requirement_id === r.id) ?? { valid: 0, awaiting: 0, expiring: 0 } };
      }),
    };
  },
});

cap({
  name: 'save_compliance_obligation', method: 'POST', path: '/compliance/requirements/:id/obligations', tag: TAG, status: 201,
  summary: 'Say who must meet a requirement and what happens if they do not: which roles or engagements (none chosen = everyone in the scope), an optional sport, an optional place (country, state or province, municipality), governing bodies, competitions, venues, event types and an age band (a rule that names something the facts cannot answer is "cannot be judged yet", never silently skipped), whether it only applies to adults who coach or manage young people, whether it is mandatory, since when and until when, and what an unmet one blocks (contact with young people, competition registration, event accreditation, opening or starting an event, recommending a tender award). Safeguarding that blocks contact with young people can never be waived. Archive an obligation with archived=true.',
  input: z.object({
    id, obligation_id: id.optional(), roles: z.array(z.string().max(40)).max(12).default([]), sport_id: id.nullable().optional(), youth_work: z.boolean().default(false), mandatory: z.boolean().default(true),
    consequences: z.array(z.enum(Object.keys(CONSEQUENCES))).default([]), starts_on: day.optional(), ends_on: day.nullable().optional(), archived: z.boolean().optional(),
    // where and for whom beyond roles and sport (#568); a rule that names a dimension the facts cannot answer is "unknown", never silently "does not apply"
    country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(), region: text(80).min(1).nullable().optional(), municipality: text(80).min(1).nullable().optional(),
    body_ids: z.array(id).max(20).default([]), competition_ids: z.array(id).max(50).default([]), venue_ids: z.array(id).max(50).default([]),
    event_types: z.array(z.enum(EVENT_TYPES)).max(5).default([]), min_age: z.number().int().min(0).max(120).nullable().optional(), max_age: z.number().int().min(0).max(120).nullable().optional(),
  }),
  async handler({ user }, i) {
    const r = await loadRequirement(i.id);
    await mustManage(user, r.scope_kind, r.scope_id, { write: true });
    const allowed = new Set(roleChoices(r.scope_kind, r.subject_kind).map((x) => x.value));
    const bad = i.roles.find((x) => !allowed.has(x));
    if (bad) throw badRequest(`"${bad}" is not a role that can be chosen for this scope`);
    const PERSON_ONLY = ['youth_contact', 'youth_access', 'registration', 'accreditation'];
    if (r.subject_kind !== 'person' && (i.youth_work || i.consequences.some((x) => PERSON_ONLY.includes(x)))) throw badRequest('Only requirements for people can block contact, registration or accreditation, or be limited to people who work with young people');
    if (r.subject_kind === 'person' && i.consequences.some((x) => ['event_open', 'event_start'].includes(x))) throw badRequest('Opening and starting an event are decided from the event\'s own requirements, not a person\'s');
    if (r.subject_kind === 'organisation' && i.consequences.some((x) => ['event_open', 'event_start'].includes(x))) throw badRequest('Opening and starting an event are decided from the event\'s own requirements');
    if (r.subject_kind !== 'person' && (i.min_age != null || i.max_age != null)) throw badRequest('An age band applies to people');
    if (i.min_age != null && i.max_age != null && i.max_age < i.min_age) throw badRequest('The maximum age cannot be below the minimum age');
    if (i.body_ids.length && (await many('SELECT id FROM governing_bodies WHERE id = ANY($1)', [i.body_ids])).length !== new Set(i.body_ids).size) throw badRequest('Choose existing governing bodies');
    if (i.competition_ids.length && (await many('SELECT id FROM events WHERE id = ANY($1)', [i.competition_ids])).length !== new Set(i.competition_ids).size) throw badRequest('Choose existing competitions');
    if (i.venue_ids.length && (await many('SELECT id FROM venues WHERE id = ANY($1)', [i.venue_ids])).length !== new Set(i.venue_ids).size) throw badRequest('Choose existing venues');
    if ((i.consequences.includes('youth_contact') || i.consequences.includes('youth_access')) && r.scope_kind === 'event') throw badRequest('Contact with and access to young people are controlled by the organisation or the platform, not by a single event');
    if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('The end date cannot be before the start date');
    return tx(async (c) => {
      let row;
      if (i.obligation_id) {
        const ex = (await c.query('SELECT * FROM comp_obligations WHERE id=$1 AND requirement_id=$2 FOR UPDATE', [i.obligation_id, r.id])).rows[0];
        if (!ex) throw notFound('Obligation');
        row = (await c.query(
          `UPDATE comp_obligations SET roles=$2, sport_id=$3, youth_work=$4, mandatory=$5, consequences=$6, starts_on=$7, ends_on=$8,
                  country=$10, region=$11, municipality=$12, body_ids=$13, competition_ids=$14, venue_ids=$15, event_types=$16, min_age=$17, max_age=$18,
                  archived_at = CASE WHEN $9::boolean IS TRUE THEN coalesce(archived_at, now()) WHEN $9::boolean IS FALSE THEN NULL ELSE archived_at END WHERE id=$1 RETURNING *`,
          [ex.id, i.roles, i.sport_id ?? null, i.youth_work, i.mandatory, i.consequences, i.starts_on ?? ex.starts_on, i.ends_on === undefined ? ex.ends_on : i.ends_on, i.archived ?? null,
            i.country ?? null, i.region ?? null, i.municipality ?? null, i.body_ids, i.competition_ids, i.venue_ids, i.event_types, i.min_age ?? null, i.max_age ?? null])).rows[0];
      } else {
        row = (await c.query(
          `INSERT INTO comp_obligations(requirement_id, roles, sport_id, youth_work, mandatory, consequences, starts_on, ends_on, created_by, country, region, municipality, body_ids, competition_ids, venue_ids, event_types, min_age, max_age)
           VALUES ($1,$2,$3,$4,$5,$6,coalesce($7::date, current_date),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [r.id, i.roles, i.sport_id ?? null, i.youth_work, i.mandatory, i.consequences, i.starts_on ?? null, i.ends_on ?? null, user.id,
            i.country ?? null, i.region ?? null, i.municipality ?? null, i.body_ids, i.competition_ids, i.venue_ids, i.event_types, i.min_age ?? null, i.max_age ?? null])).rows[0];
      }
      await log(c, { requirement_id: r.id, actor_id: user.id, action: i.obligation_id ? 'obligation_updated' : 'obligation_created', detail: { obligation_id: row.id, consequences: row.consequences, mandatory: row.mandatory } });
      const labels = new Map(roleChoices(r.scope_kind, r.subject_kind).map((x) => [x.value, x.label]));
      return viewOb(row, labels);
    });
  },
});

// ---------------------------------------------------------------- status
/** Items a manager may see: only the obligations of scopes they run. The holder, a guardian and the platform team see everything that applies. */
export async function visibleItems(user, access, items) {
  if (access) return items;
  const out = [];
  const cache = new Map();
  for (const it of items) {
    const k = `${it.scope.kind}:${it.scope.id ?? ''}`;
    if (!cache.has(k)) cache.set(k, await manages(user, it.scope.kind, it.scope.id));
    if (cache.get(k)) out.push(it);
  }
  return out;
}

cap({
  name: 'get_compliance_status', method: 'GET', path: '/compliance/status', tag: TAG,
  summary: 'What is missing, pending or expiring for a person, organisation or event, and why. Every obligation that applies is returned with its state (met, expiring, in grace, awaiting review, missing, expired, not accepted, revoked, waived), whether it blocks, the validity dates, a plain-language explanation and the next step. Omit the subject to see your own. The holder, a verified guardian and the platform team see everything; a manager sees only the requirements of the scopes they run. Underlying references, numbers and reviewer notes for background checks are never returned here.',
  input: z.object({ subject_kind: z.enum(SUBJECTS).default('person'), subject_id: id.optional(), consequence: z.enum(Object.keys(CONSEQUENCES)).optional(), scope_kind: z.enum(SCOPES).optional(), scope_id: id.optional() }),
  async handler({ user }, i) {
    const sid = i.subject_id ?? (i.subject_kind === 'person' ? user.id : null);
    if (!sid) throw badRequest('Say which organisation or event');
    const subject = { kind: i.subject_kind, id: sid };
    const access = await holderAccess(user, subject.kind, subject.id);
    const full = await evaluateSubject(pool, subject, { consequence: i.consequence ?? null, scope: i.scope_kind ? { kind: i.scope_kind, id: i.scope_id ?? null } : null });
    let items = await visibleItems(user, access, full.items);
    if (!access && !items.length) throw notFound(subject.kind === 'person' ? 'Person' : subject.kind === 'organisation' ? 'Organisation' : 'Event');
    const sum = summarise(items);
    return {
      subject: { ...subject, name: await nameFor(pool, user, subject.kind, subject.id) },
      relation: access ?? 'manager', as_of: full.today, decision: sum.decision, counts: sum.counts, statuses: statusCounts(items), items,
    };
  },
});

cap({
  name: 'list_compliance_gaps', method: 'GET', path: '/compliance/gaps', tag: TAG,
  summary: 'The roll-up for a scope you run: the people (or organisations, or events) in it that are blocked, awaiting review or expiring against the scope\'s own requirements, worst first, each with the items and the reason. Young people the caller may not see are shown as "Protected participant".',
  input: z.object({ scope_kind: z.enum(SCOPES), scope_id: id.optional(), subject_kind: z.enum(SUBJECTS).default('person'), attention_only: z.coerce.boolean().default(true), ...page, limit: z.coerce.number().int().min(1).max(50).default(25) })
    .refine((x) => (x.scope_kind === 'platform') === !x.scope_id, { message: 'scope_id is required for every scope except platform' }),
  async handler({ user }, i) {
    await mustManage(user, i.scope_kind, i.scope_id);
    const { total, ids } = await subjectsInScope(pool, i.scope_kind, i.scope_id ?? null, i.subject_kind, { limit: i.limit, offset: i.offset });
    const rank = { blocked: 0, pending: 1, clear: 2 };
    const rows = [], dashboard = statusCounts([]);
    for (const sid of ids) {
      const ev = await evaluateSubject(pool, { kind: i.subject_kind, id: sid }, { scope: { kind: i.scope_kind, id: i.scope_id ?? null } });
      if (!ev.items.length) continue;
      for (const [k, n] of Object.entries(ev.statuses)) dashboard[k] += n;
      const attention = ev.items.filter((x) => x.blocking || ['pending_review', 'expiring', 'grace'].includes(x.state));
      if (i.attention_only && !attention.length) continue;
      rows.push({
        subject: { kind: i.subject_kind, id: sid, name: await nameFor(pool, user, i.subject_kind, sid) }, decision: ev.decision, counts: ev.counts,
        items: (i.attention_only ? attention : ev.items).map((x) => ({ requirement_id: x.requirement_id, name: x.requirement.name, state: x.state, state_label: x.state_label, blocking: x.blocking, waivable: x.waivable, expires_on: x.expires_on, explanation: x.explanation, record_id: x.record?.id ?? null })),
      });
    }
    rows.sort((a, b) => rank[a.decision] - rank[b.decision] || b.counts.blocked - a.counts.blocked);
    return { total, limit: i.limit, offset: i.offset, evaluated: ids.length, dashboard, subjects: rows,
      summary: { blocked: rows.filter((r) => r.decision === 'blocked').length, pending: rows.filter((r) => r.decision === 'pending').length, expiring: rows.filter((r) => r.counts.expiring > 0).length } };
  },
});

cap({
  name: 'list_compliance_history', method: 'GET', path: '/compliance/history', tag: TAG,
  summary: 'The append-only history for a person, organisation or event: submissions, decisions, waivers, evidence-pack grants and reads of a reference (who, what, when). References, numbers and notes are never part of it. Holders and guardians see everything about them; a manager sees the events of requirements in the scopes they run.',
  input: z.object({ subject_kind: z.enum(SUBJECTS).default('person'), subject_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const sid = i.subject_id ?? (i.subject_kind === 'person' ? user.id : null);
    if (!sid) throw badRequest('Say which organisation or event');
    const access = await holderAccess(user, i.subject_kind, sid);
    const rows = await many(
      `SELECT e.id, e.action, e.at, e.detail, e.record_id, r.name AS requirement_name, r.scope_kind, r.scope_id, u.display_name AS actor_name
         FROM comp_events e LEFT JOIN comp_requirements r ON r.id=e.requirement_id LEFT JOIN users u ON u.id=e.actor_id
        WHERE e.subject_kind=$1 AND e.subject_id=$2 ORDER BY e.at DESC, e.id DESC LIMIT $3 OFFSET $4`, [i.subject_kind, sid, i.limit + 1, i.offset]);
    const keep = [];
    for (const r of rows.slice(0, i.limit)) if (access || (r.scope_kind && await manages(user, r.scope_kind, r.scope_id))) keep.push(r);
    if (!access && !keep.length) throw notFound('History');
    return { items: keep.map((r) => ({ id: r.id, action: r.action, at: r.at, requirement: r.requirement_name, actor: r.actor_name, detail: r.detail, record_id: r.record_id })), has_more: rows.length > i.limit };
  },
});
