// Compliance gates and the decision trail (#568). A module that must not act until the rules are met calls one of the functions here before it acts; the
// rules themselves are data in the compliance platform (src/compliance.js), never code in the module. No rule in force = no effect, so a module nobody
// has written rules for behaves exactly as before. Every decision a gate takes is kept in comp_decisions (append-only), with the facts it used, every rule
// with its version and result, and the waivers that let a rule through. A refused attempt is recorded too, on its own connection (the caller's
// transaction is about to roll back).
import { pool } from './db.js';
import { conflict } from './errors.js';
import { evaluateSubject, scopesOf } from './compliance.js';
import { explainItems } from './compliance-policy.js';

const compact = (i) => ({
  obligation_id: i.obligation_id, requirement_id: i.requirement_id, code: i.requirement.code, name: i.requirement.name, version: i.requirement.version, scope: i.scope,
  classification: i.policy.classification, topic: i.policy.topic, jurisdiction: i.policy.jurisdiction, effective_from: i.policy.effective_from, effective_to: i.policy.effective_to,
  mandatory: i.mandatory, consequences: i.consequences, state: i.state, status: i.status, outcome: i.outcome, blocking: i.blocking, expires_on: i.expires_on,
  waiver_id: i.waiver?.id ?? null, missing_facts: i.policy.missing_facts, explanation: i.explanation,
});

/** Keep one decision. `ev` is an evaluateSubject result. Facts hold the age that was used, never a date of birth. */
export async function recordDecision(c, actor, { consequence, ctx = {}, trigger, ev }) {
  const items = ev.items.map(compact);
  const excluded = (ev.excluded ?? []).map((x) => ({ name: x.requirement.name, classification: x.classification, outcome: x.outcome, reason: x.reason }));
  const blocked = ev.items.some((i) => i.blocking) || ev.decision === 'pending';
  const r = await c.query(
    `INSERT INTO comp_decisions(consequence, subject_kind, subject_id, context, event_id, trigger, as_of, facts, results, overall, blocked, waiver_ids, decided_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [consequence, ev.subject.kind, ev.subject.id, JSON.stringify({ event_id: ctx.event_id ?? null, tender_id: ctx.tender_id ?? null, organisation_id: ctx.organisation_id ?? null }), ctx.event_id ?? null, trigger, ev.today,
      JSON.stringify(ev.facts), JSON.stringify({ items, excluded }), ev.decision, blocked, items.map((x) => x.waiver_id).filter(Boolean), actor?.id ?? null]);
  return r.rows[0].id;
}

const stops = (i) => i.blocking || (i.mandatory && i.state === 'pending_review' && i.policy.classification !== 'recommended_standard');

/**
 * Judge each subject against the rules that block `consequence` and refuse (409 compliance_blocked) if any is not met. Returns { live, decision_ids }.
 * `forced`/`forcedRoles` place a subject that is not a member of a rulebook's scope under it (a supplier bidding to a buyer's tender).
 */
export async function assertRulesMet(c, { consequence, trigger, actor = null, subjects, ctx = {}, forced = null, forcedRoles = [], asOf = null }) {
  const scopes = scopesOf(ctx);
  const evals = [];
  for (const s of subjects) evals.push(await evaluateSubject(c, { kind: s.kind, id: s.id }, { consequence, scopes, context: { ...ctx, country_hint: s.country_hint }, forced, forcedRoles, asOf, actor }));
  const live = evals.filter((e) => e.items.length);
  if (!live.length) return { live: false, decision_ids: [] };
  const blockers = live.flatMap((e) => e.items.filter(stops).map((i) => ({ subject: e.subject, rule: i.requirement.name, classification: i.policy.classification, status: i.status, reason: i.explanation })));
  const ids = [];
  for (const e of live) ids.push(await recordDecision(blockers.length ? pool : c, actor, { consequence, ctx, trigger, ev: e }));
  if (blockers.length) {
    const ex = explainItems(live.flatMap((e) => e.items.filter(stops)));
    throw conflict('Compliance rules are not met yet', { code: 'compliance_blocked', consequence, decision_ids: ids, blockers, explanation: ex.text });
  }
  return { live: true, decision_ids: ids };
}

/** The scopes around an event: itself, its organising organisation and the governing bodies that organisation is affiliated to. */
export async function eventContext(c, ev) {
  const bodies = ev.organisation_id ? (await c.query("SELECT DISTINCT body_id FROM fed_affiliations WHERE organisation_id=$1 AND status IN ('approved','suspended')", [ev.organisation_id])).rows.map((r) => r.body_id) : [];
  return { event_id: ev.id, organisation_id: ev.organisation_id ?? null, body_ids: bodies };
}

/** Opening an event for entries, and starting it, are where its permits, insurance and safety approvals must be in order. */
export async function assertEventMayProceed(c, actor, ev, to) {
  const consequence = to === 'open' ? 'event_open' : 'event_start';
  return assertRulesMet(c, { consequence, trigger: consequence, actor, subjects: [{ kind: 'event', id: ev.id }], ctx: await eventContext(c, ev) });
}

/** The scopes and facts around a tender: the event it serves, the buyer's organisation and the governing bodies that organisation is affiliated to. */
async function tenderCtx(c, project) {
  const ctx = { tender_id: project.id, event_id: project.event_id ?? null, organisation_id: project.organisation_id ?? null, body_ids: [] };
  if (project.organisation_id) ctx.body_ids = (await c.query("SELECT DISTINCT body_id FROM fed_affiliations WHERE organisation_id=$1 AND status IN ('approved','suspended')", [project.organisation_id])).rows.map((r) => r.body_id);
  return ctx;
}
const forcedOf = (ctx) => new Set(scopesOf(ctx).map((s) => `${s.kind}:${s.id ?? ''}`));

/**
 * A bidder is not a member of the buyer's organisation, but the buyer's rulebook (and the event's, and the governing bodies') still governs the bid. If this
 * subject is a supplier taking part in the tender, return the context that places it under those rulebooks; otherwise null.
 */
export async function tenderForcing(c, tenderId, subject) {
  const project = (await c.query('SELECT * FROM proc_projects WHERE id=$1', [tenderId])).rows[0];
  if (!project) return null;
  const own = subject.kind === 'organisation' ? 'e.organisation_id = $2' : subject.kind === 'person' ? 'e.owner_user_id = $2' : 'false';
  const taking = await c.query(
    `SELECT 1 FROM proc_participants p JOIN supplier_entities e ON e.id=p.entity_id WHERE p.project_id=$1 AND ${own} AND p.status NOT IN ('declined','withdrawn') LIMIT 1`, [tenderId, subject.id]);
  if (!taking.rowCount) return null;
  const ctx = await tenderCtx(c, project);
  return { ctx, forced: forcedOf(ctx), forcedRoles: ['supplier'] };
}

/**
 * Recommending a tender award: the event the tender serves (if any) and every supplier the scenario would award to must meet the rules that block
 * `tender_award`. The buyer's organisation, the event and the governing bodies they sit under set those rules; they apply to the bidders too.
 */
export async function assertTenderAward(c, actor, project, entityIds) {
  const entities = entityIds.length ? (await c.query('SELECT id, organisation_id, owner_user_id, country FROM supplier_entities WHERE id = ANY($1)', [entityIds])).rows : [];
  const ctx = await tenderCtx(c, project);
  const subjects = entities.map((e) => (e.organisation_id ? { kind: 'organisation', id: e.organisation_id, country_hint: e.country } : { kind: 'person', id: e.owner_user_id, country_hint: e.country }));
  if (project.event_id) subjects.push({ kind: 'event', id: project.event_id });
  return assertRulesMet(c, { consequence: 'tender_award', trigger: 'tender_award', actor, subjects, ctx, forced: forcedOf(ctx), forcedRoles: ['supplier'] });
}
