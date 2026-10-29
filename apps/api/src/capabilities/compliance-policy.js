// Compliance policy layer (#568), part 3, on the compliance platform (#595): evaluating a subject against every rule in force on a date (jurisdiction,
// governing bodies, competitions, venues, event types and age, with precedence between rules of one topic), the append-only trail of decisions the gates
// took, the second-administrator approval a law or regulation needs, and jurisdiction packs (a set of rules exported from one scope and imported into
// another, so a new country needs no code). The engine is src/compliance.js and src/compliance-policy.js; nothing here owns a rule.
import { z } from 'zod';
import { cap, capabilities, id, page } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { invoke } from '../invoke.js';
import { CONSEQUENCES, SCOPES, SUBJECTS, evaluateSubject, holderAccess, manages, nameFor, summarise } from '../compliance.js';
import { CLASS_LABEL, DEFAULT_CLASS, NEEDS_SECOND_APPROVER, SCOPE_CLASSES, explainItems, statusCounts } from '../compliance-policy.js';
import { recordDecision, tenderForcing } from '../compliance-gates.js';
import { TAG, log, loadRequirement, visibleItems } from './compliance.js';

const day = z.string().date();
const PACK_FORMAT = 'sportarena.compliance-rules/1';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const must = (name) => capabilities.find((x) => x.name === name);

/** The date a subject is judged on when none is given: the day the event or tender starts, else today. */
async function defaultAsOf({ event_id, tender_id }) {
  let d = null;
  if (event_id) d = (await one('SELECT starts_on::text AS d FROM events WHERE id=$1', [event_id]))?.d ?? null;
  if (!d && tender_id) d = (await one('SELECT service_start::text AS d FROM proc_projects WHERE id=$1', [tender_id]))?.d ?? null;
  return d;
}

// ---------------------------------------------------------------- evaluate
cap({
  name: 'evaluate_compliance', method: 'POST', path: '/compliance/evaluate', tag: TAG,
  summary: 'Judge a person, organisation or event against every rule in force on a date (default: the day the event or tender starts, else today). Each rule comes back as applies, does not apply (with why, including "overridden by a higher-ranked rule on the same topic"), cannot be judged yet (and which fact is missing, for example the venue\'s country) or needs an exception, with a status (compliant, expiring, pending, missing, exception, non-compliant), its classification (legal, regulatory, federation mandated, contractual, organisation policy, recommended standard), jurisdiction, effective dates and source, plus the facts used and where each came from. The explanation states what the rules ask and what is missing; it never asserts legal compliance, and an upload counts only after a person has verified it. The holder, a verified guardian and the platform team see everything; an event organiser or organisation administrator sees the rules of the scopes they run. With record=true (managers only) the decision is kept in the audit trail.',
  input: z.object({
    subject_kind: z.enum(SUBJECTS).default('person'), subject_id: id.optional(), event_id: id.optional(), tender_id: id.optional(), as_of: day.optional(),
    consequence: z.enum(Object.keys(CONSEQUENCES)).optional(), record: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const sid = i.subject_id ?? (i.subject_kind === 'person' ? user.id : i.subject_kind === 'event' ? i.event_id : null);
    if (!sid) throw badRequest('Say which person, organisation or event');
    const subject = { kind: i.subject_kind, id: sid };
    const access = await holderAccess(user, subject.kind, subject.id);
    const ctxManager = !!i.event_id && await manages(user, 'event', i.event_id);
    const ctx = { event_id: i.event_id ?? (subject.kind === 'event' ? sid : undefined), tender_id: i.tender_id };
    const asOf = i.as_of ?? await defaultAsOf(ctx);
    const tf = i.tender_id ? await tenderForcing(pool, i.tender_id, subject) : null;
    const ev = await evaluateSubject(pool, subject, { consequence: i.consequence ?? null, asOf: asOf ?? undefined, context: tf ? { ...ctx, ...tf.ctx } : ctx, actor: user, ...(tf ? { forced: tf.forced, forcedRoles: tf.forcedRoles } : {}) });
    const items = await visibleItems(user, access, ev.items);
    if (!access && !items.length && !ctxManager) throw notFound(subject.kind === 'person' ? 'Person' : subject.kind === 'organisation' ? 'Organisation' : 'Event');
    const sum = summarise(items);
    const excluded = access || ctxManager ? ev.excluded : [];
    let decision_id = null;
    if (i.record) {
      if (!(isAdmin(user) || ctxManager || ['admin', 'manager'].includes(access))) throw forbidden('Only the people who run this event or organisation can keep a decision');
      decision_id = await recordDecision(pool, user, { consequence: i.consequence ?? 'check', ctx, trigger: 'manual', ev: { ...ev, items, excluded } });
    }
    return {
      subject: { ...subject, name: await nameFor(pool, user, subject.kind, subject.id) }, relation: access ?? (ctxManager ? 'organiser' : 'manager'), as_of: ev.today,
      facts: ev.facts, decision: sum.decision, counts: sum.counts, statuses: statusCounts(items), items, excluded, explanation: explainItems(items, excluded), decision_id,
    };
  },
});

// ---------------------------------------------------------------- the decision trail
const viewDecision = async (user, d) => ({
  id: d.id, consequence: d.consequence, trigger: d.trigger, as_of: d.as_of, overall: d.overall, blocked: d.blocked, decided_at: d.decided_at, decided_by: d.decided_by_name ?? null,
  subject: { kind: d.subject_kind, id: d.subject_id, name: await nameFor(pool, user, d.subject_kind, d.subject_id) }, context: d.context,
  rules: d.rule_count ?? undefined, blockers: d.blocker_count ?? undefined,
});

/** May the user read a decision? The people who run its event or the platform, the holder or a verified guardian of its subject. */
async function mayReadDecision(user, d) {
  if (isAdmin(user)) return true;
  if (d.event_id && await manages(user, 'event', d.event_id)) return true;
  return !!(await holderAccess(user, d.subject_kind, d.subject_id));
}

cap({
  name: 'list_compliance_decisions', method: 'GET', path: '/compliance/decisions', tag: TAG,
  summary: 'The append-only trail of compliance decisions: what was decided (opening or starting an event, a tender award, registration, accreditation, or an evaluation someone kept), for whom, on which date, the overall result and how many rules stood in the way. Name an event you run, or a person, organisation or event you hold. Nothing here can be edited or deleted; a refused attempt is recorded too.',
  input: z.object({ event_id: id.optional(), subject_kind: z.enum(SUBJECTS).optional(), subject_id: id.optional(), consequence: z.string().max(40).optional(), blocked: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    if (i.event_id) { if (!(isAdmin(user) || await manages(user, 'event', i.event_id))) throw notFound('Event'); }
    else if (i.subject_id) { if (!(await holderAccess(user, i.subject_kind ?? 'person', i.subject_id))) throw notFound('Subject'); }
    else throw badRequest('Name an event you run, or the person, organisation or event to look at');
    const rows = await many(
      `SELECT d.*, u.display_name AS decided_by_name, jsonb_array_length(d.results->'items') AS rule_count,
              (SELECT count(*)::int FROM jsonb_array_elements(d.results->'items') x WHERE (x->>'blocking')::boolean) AS blocker_count
         FROM comp_decisions d LEFT JOIN users u ON u.id=d.decided_by
        WHERE ($1::uuid IS NULL OR d.event_id=$1) AND ($2::text IS NULL OR d.subject_kind=$2) AND ($3::uuid IS NULL OR d.subject_id=$3)
          AND ($4::text IS NULL OR d.consequence=$4) AND ($5::boolean IS NULL OR d.blocked=$5)
        ORDER BY d.decided_at DESC LIMIT $6 OFFSET $7`, [i.event_id ?? null, i.subject_kind ?? null, i.subject_id ?? null, i.consequence ?? null, i.blocked ?? null, i.limit + 1, i.offset]);
    const items = [];
    for (const d of rows.slice(0, i.limit)) items.push(await viewDecision(user, d));
    return { items, has_more: rows.length > i.limit };
  },
});

cap({
  name: 'get_compliance_decision', method: 'GET', path: '/compliance/decisions/:id', tag: TAG,
  summary: 'One kept decision in full: the facts it used and where each came from, every rule with its version, classification, jurisdiction, effective dates and result, the waivers that let a rule through, who decided and when. A date of birth is never part of it, only the age that was used.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('SELECT d.*, u.display_name AS decided_by_name FROM comp_decisions d LEFT JOIN users u ON u.id=d.decided_by WHERE d.id=$1', [i.id]);
    if (!d || !(await mayReadDecision(user, d))) throw notFound('Decision');
    return { ...(await viewDecision(user, d)), facts: d.facts, results: d.results, waiver_ids: d.waiver_ids };
  },
});

// ---------------------------------------------------------------- approval of laws and regulations
cap({
  name: 'approve_compliance_requirement', method: 'POST', path: '/compliance/requirements/:id/approval', tag: TAG,
  summary: 'A law or a regulation takes effect only after a second platform administrator approves it: the person who wrote it cannot. Until then it applies to no one and blocks nothing. A pending rule can also be withdrawn. The decision is part of the history.',
  input: z.object({ id, decision: z.enum(['approve', 'withdraw']) }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw notFound('Requirement');
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM comp_requirements WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Requirement');
      if (r.approval_status !== 'pending_approval') throw conflict('This rule is not waiting for approval', { code: 'not_pending' });
      if (!NEEDS_SECOND_APPROVER.includes(r.classification)) throw conflict('Only a law or a regulation needs a second approver');
      if (i.decision === 'approve' && r.created_by === user.id) throw forbidden('A second administrator must approve a rule you wrote');
      const row = (await c.query(
        `UPDATE comp_requirements SET approval_status=$2, approved_by=CASE WHEN $2='approved' THEN $3::uuid END, approved_at=CASE WHEN $2='approved' THEN now() END, updated_at=now() WHERE id=$1 RETURNING id, name, classification, approval_status, approved_at`,
        [r.id, i.decision === 'approve' ? 'approved' : 'withdrawn', user.id])).rows[0];
      await log(c, { requirement_id: r.id, actor_id: user.id, action: i.decision === 'approve' ? 'requirement_approved' : 'requirement_withdrawn', detail: { classification: r.classification } });
      return row;
    });
  },
});

// ---------------------------------------------------------------- jurisdiction packs
const obligationPack = z.object({
  roles: z.array(z.string().max(40)).max(12).default([]), sport: z.string().max(80).nullable().optional(), youth_work: z.boolean().default(false), mandatory: z.boolean().default(true),
  consequences: z.array(z.enum(Object.keys(CONSEQUENCES))).default([]), starts_on: day.optional(), ends_on: day.nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(), region: z.string().max(80).nullable().optional(), municipality: z.string().max(80).nullable().optional(),
  event_types: z.array(z.string().max(20)).max(5).default([]), min_age: z.number().int().min(0).max(120).nullable().optional(), max_age: z.number().int().min(0).max(120).nullable().optional(),
});
const rulePack = z.object({
  code: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().min(2).max(120), description: z.string().max(1000).nullable().optional(), category: z.string(), subject_kind: z.enum(SUBJECTS).default('person'),
  method: z.string(), source: z.record(z.any()).nullable().optional(), requires_review: z.boolean().default(true), validity_days: z.number().int().nullable().optional(),
  reminder_days: z.array(z.number().int()).max(5).default([60, 30, 7]), grace_days: z.number().int().default(0), escalate_after_days: z.number().int().default(7), statement: z.string().max(4000).nullable().optional(),
  classification: z.string().optional(), topic: z.string().nullable().optional(), source_title: z.string().nullable().optional(), source_url: z.string().nullable().optional(), approval_owner: z.string().nullable().optional(), waivable: z.boolean().nullable().optional(),
  obligations: z.array(obligationPack).max(50).default([]),
});
const scopeInput = { scope_kind: z.enum(SCOPES), scope_id: id.optional() };
const scopeOk = { message: 'scope_id is required for every scope except platform' };

// a pack carries only what is set, so it round-trips through the same input rules as a hand-written rule
const bare = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

cap({
  name: 'export_compliance_rules', method: 'GET', path: '/compliance/rules/export', tag: TAG,
  summary: 'Export the rules in force in a scope you run as a jurisdiction pack: each requirement (wording, classification, topic, source, approval owner) with its obligations (roles, sport, place, event types, age band, dates, what it blocks). A pack is plain data, so a country or a federation\'s rulebook can be shared and imported elsewhere without any code. Governing bodies, competitions and venues are specific to this platform and are not included.',
  input: z.object(scopeInput).refine((x) => (x.scope_kind === 'platform') === !x.scope_id, scopeOk),
  async handler({ user }, i) {
    if (!(await manages(user, i.scope_kind, i.scope_id ?? null))) throw notFound('Scope');
    const reqs = await many("SELECT * FROM comp_requirements WHERE scope_kind=$1 AND scope_id IS NOT DISTINCT FROM $2 AND archived_at IS NULL AND approval_status='approved' ORDER BY code", [i.scope_kind, i.scope_id ?? null]);
    const obs = reqs.length ? await many('SELECT o.*, s.slug AS sport_slug FROM comp_obligations o LEFT JOIN sports s ON s.id=o.sport_id WHERE o.requirement_id = ANY($1) AND o.archived_at IS NULL ORDER BY o.created_at', [reqs.map((r) => r.id)]) : [];
    return {
      format: PACK_FORMAT, exported_at: new Date().toISOString(), scope: { kind: i.scope_kind },
      rules: reqs.map((r) => bare({
        code: r.code, name: r.name, description: r.description, category: r.category, subject_kind: r.subject_kind, method: r.method, source: r.method === 'linked' ? r.source : null, requires_review: r.requires_review,
        validity_days: r.validity_days, reminder_days: r.reminder_days, grace_days: r.grace_days, escalate_after_days: r.escalate_after_days, statement: r.statement,
        classification: r.classification, topic: r.topic, source_title: r.source_title, source_url: r.source_url, approval_owner: r.approval_owner, waivable: r.waivable,
        obligations: obs.filter((o) => o.requirement_id === r.id).map((o) => bare({
          roles: o.roles, sport: o.sport_slug, youth_work: o.youth_work, mandatory: o.mandatory, consequences: o.consequences, starts_on: iso(o.starts_on), ends_on: o.ends_on ? iso(o.ends_on) : null,
          country: o.country, region: o.region, municipality: o.municipality, event_types: o.event_types, min_age: o.min_age, max_age: o.max_age,
        })),
      })),
    };
  },
});

cap({
  name: 'import_compliance_rules', method: 'POST', path: '/compliance/rules/import', tag: TAG, status: 201,
  summary: 'Import a jurisdiction pack into a scope you run. Every rule is checked first with the same rules as writing it by hand (who may write which classification, valid roles and sports, dates), and nothing is imported if any rule is wrong. A rule whose code already exists in the scope is skipped, so importing the same pack twice changes nothing. Laws and regulations arrive waiting for a second platform administrator to approve them.',
  input: z.object({ ...scopeInput, pack: z.object({ format: z.literal(PACK_FORMAT), rules: z.array(rulePack).min(1).max(100) }) }).refine((x) => (x.scope_kind === 'platform') === !x.scope_id, scopeOk),
  async handler({ user }, i) {
    if (!(await manages(user, i.scope_kind, i.scope_id ?? null, { write: true }))) throw notFound('Scope');
    const reqCap = must('save_compliance_requirement'), obCap = must('save_compliance_obligation');
    const slugs = [...new Set(i.pack.rules.flatMap((r) => r.obligations.map((o) => o.sport)).filter(Boolean))];
    const sports = slugs.length ? await many('SELECT id, slug FROM sports WHERE slug = ANY($1)', [slugs]) : [];
    const sportId = (slug) => sports.find((x) => x.slug === slug)?.id ?? null;
    const unknownSport = slugs.find((sl) => !sportId(sl));
    if (unknownSport) throw badRequest(`The sport "${unknownSport}" is not in the catalogue`);
    // check every rule before writing any
    const planned = [];
    for (const r of i.pack.rules) {
      const { obligations, ...rest } = r;
      let req;
      try {
        req = reqCap.input.parse({ ...rest, scope_kind: i.scope_kind, scope_id: i.scope_id, source: rest.method === 'linked' ? rest.source ?? undefined : undefined });
        const cls = req.classification ?? DEFAULT_CLASS[i.scope_kind];
        if (!SCOPE_CLASSES[i.scope_kind].includes(cls)) throw new Error(`a ${i.scope_kind} cannot write a ${CLASS_LABEL[cls].toLowerCase()} rule`);
        for (const o of obligations) obCap.input.parse({ id: PLACEHOLDER, ...o, sport_id: o.sport ? sportId(o.sport) : null });
      } catch (e) { throw badRequest(`Rule "${r.code}" is not valid: ${e.issues?.[0] ? `${e.issues[0].path.join('.')} ${e.issues[0].message}` : e.message}`); }
      planned.push({ req, obligations });
    }
    const created = [], skipped = [];
    for (const { req, obligations } of planned) {
      const exists = await one('SELECT 1 AS x FROM comp_requirements WHERE scope_kind=$1 AND scope_id IS NOT DISTINCT FROM $2 AND code=$3 AND archived_at IS NULL', [i.scope_kind, i.scope_id ?? null, req.code]);
      if (exists) { skipped.push(req.code); continue; }
      const made = await invoke(reqCap, user, req);
      for (const o of obligations) await invoke(obCap, user, { id: made.id, ...o, sport_id: o.sport ? sportId(o.sport) : null });
      created.push({ code: req.code, approval_status: made.approval_status });
    }
    return { created, skipped };
  },
});
