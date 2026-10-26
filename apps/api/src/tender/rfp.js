// RFP structure helpers: loading, validation before approval/publication, and the allowlisted notice projections. A Billboard tender card is
// always a projection of the canonical proc_projects row: there is no second editable copy.
import { many, one, pool } from '../db.js';
import { isSupportedCurrency } from '../currency.js';
import { rubricSchema, rubricIssues } from './scoring.js';
import { stageOf, issuerOf } from './core.js';
import { badgesFor } from '../verification.js';

export const lotsOf = async (c, pid, { archived = false } = {}) => (await c.query(`SELECT code, title, description, service_family, qty::float AS qty, unit, estimate_minor, allow_partial, bundle_with, starts_on, ends_on, site, position FROM proc_lots WHERE project_id=$1 ${archived ? '' : 'AND archived_at IS NULL'} ORDER BY position, code`, [pid])).rows;
export const questionsOf = async (c, pid) => (await c.query('SELECT key, section, prompt, type, options, unit, required, pass_fail, pass_value, evidence_required, lot_code, show_if, position FROM proc_questions WHERE project_id=$1 AND archived_at IS NULL ORDER BY position, key', [pid])).rows;

const at = (d) => (d ? new Date(d).getTime() : null);

/** Everything that must be right before a tender can go for approval or be published. severity 'error' blocks; 'warning' does not. */
export async function validateProject(c, p) {
  const issues = [];
  const add = (severity, field, message) => issues.push({ severity, field, message });
  const lots = await lotsOf(c, p.id), qs = await questionsOf(c, p.id);
  if (!p.scope?.trim()) add('error', 'scope', 'Describe the scope of work');
  if (!p.objective?.trim()) add('warning', 'objective', 'State the objective so suppliers understand the purpose');
  if (!isSupportedCurrency(p.currency)) add('error', 'currency', 'Choose a supported currency');
  if (p.kind !== 'rfi' && !lots.length) add('error', 'lots', 'Add at least one lot or line item to bid on');
  if (!p.closes_at) add('error', 'closes_at', 'Set the submission deadline');
  else if (at(p.closes_at) <= Date.now() + 60_000) add('error', 'closes_at', 'The submission deadline must be in the future');
  const order = [['publish_at', 'clarification_deadline'], ['clarification_deadline', 'closes_at'], ['site_visit_at', 'closes_at'], ['closes_at', 'opens_at'], ['opens_at', 'evaluation_due'], ['evaluation_due', 'award_target']];
  for (const [a, b] of order) if (p[a] && p[b] && at(p[a]) > at(p[b])) add('error', b, `${b.replace(/_/g, ' ')} cannot be before ${a.replace(/_/g, ' ')}`);
  if (p.closes_at && !p.opens_at) add('warning', 'opens_at', 'No opening time set: opening is allowed from the deadline once your opening quorum acts');
  const d = (x) => (x ? new Date(x).getTime() : null);
  if (d(p.service_start) && d(p.service_end) && d(p.service_start) > d(p.service_end)) add('error', 'service_end', 'The service period ends before it starts');
  if (d(p.prep_start) && d(p.service_start) && d(p.prep_start) > d(p.service_start)) add('error', 'prep_start', 'Preparation cannot start after the service period');
  if (d(p.teardown_end) && d(p.service_end) && d(p.teardown_end) < d(p.service_end)) add('error', 'teardown_end', 'Teardown cannot end before the service period ends');
  if (['fixed_term', 'recurring', 'one_off'].includes(p.contract_type) && (!p.service_start || !p.service_end)) add('error', 'service_start', 'Give the service start and end dates');
  if (p.contract_type === 'framework' && !(p.ceiling_minor > 0)) add('error', 'ceiling_minor', 'A framework needs a spend ceiling (a ceiling is not guaranteed spend)');
  if (d(p.service_start) && p.award_target && d(p.service_start) < at(p.award_target) - 864e5) add('warning', 'award_target', 'The service period starts before the planned award date');
  const sumEst = lots.reduce((a, l) => a + (Number(l.estimate_minor) || 0), 0);
  if (p.budget_minor !== null && sumEst > Number(p.budget_minor)) add('warning', 'budget_minor', 'Lot estimates add up to more than the budget');
  const codes = new Set(lots.map((l) => l.code));
  for (const l of lots) for (const b of l.bundle_with ?? []) if (!codes.has(b)) add('error', 'lots', `Lot ${l.code} is bundled with unknown lot ${b}`);
  for (const q of qs) {
    if (q.type === 'single_select' || q.type === 'multi_select') if (!q.options?.length) add('error', `questions.${q.key}`, `Question "${q.key}" needs options`);
    if (q.pass_fail && (q.pass_value === null || q.pass_value === undefined)) add('error', `questions.${q.key}`, `Pass/fail question "${q.key}" needs the passing answer`);
    if (q.show_if && !qs.some((o) => o.key === q.show_if.key)) add('error', `questions.${q.key}`, `Question "${q.key}" depends on an unknown question`);
    if (q.lot_code && !codes.has(q.lot_code)) add('error', `questions.${q.key}`, `Question "${q.key}" refers to an unknown lot`);
  }
  if (p.kind !== 'rfi') {
    if (!p.rubric) add('error', 'rubric', 'Define the evaluation rubric before publishing: it is frozen when approved');
    else {
      const r = rubricSchema.safeParse(p.rubric);
      if (!r.success) add('error', 'rubric', 'The rubric is not valid');
      else for (const m of rubricIssues(r.data)) add('error', 'rubric', m);
    }
  }
  if (p.envelope_mode === 'sealed_dual' && p.kind !== 'rfi' && p.rubric && !(p.rubric.weights?.commercial > 0)) add('warning', 'envelope_mode', 'Two envelopes are set but the commercial weight is zero');
  if (p.site_visit_mandatory && !p.site_visit_at) add('error', 'site_visit_at', 'A mandatory site visit needs a date');
  if (p.publication === 'invite_only') {
    const n = (await c.query("SELECT count(*)::int AS n FROM proc_participants WHERE project_id=$1 AND status IN ('invited','approved')", [p.id])).rows[0].n;
    if (!n) add('warning', 'invites', 'Invite-only: invite at least one supplier before it opens');
  }
  if ((p.sites ?? []).length === 0 && !p.location) add('warning', 'location', 'Add the site or location so suppliers can check coverage');
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** Credential check against a tender's requirements, for one supplier entity. */
export async function credentialCheck(c, p, entityId, at = null) {
  const need = p.required_credentials ?? [];
  const have = (await c.query('SELECT kind, title, status, valid_to FROM supplier_credentials WHERE entity_id=$1 AND archived_at IS NULL', [entityId])).rows;
  const needAt = at ? new Date(at) : p.service_end ? new Date(p.service_end) : p.closes_at ? new Date(p.closes_at) : new Date();
  return need.map((r) => {
    const mine = have.filter((h) => h.kind === r.kind).sort((a, b) => (b.valid_to ?? '9999') > (a.valid_to ?? '9999') ? 1 : -1);
    const best = mine.find((h) => h.status !== 'rejected');
    let state = 'missing', detail = `No ${r.kind.replace(/_/g, ' ')} on file`;
    if (best) {
      const exp = best.valid_to ? new Date(best.valid_to) : null;
      if (exp && exp < needAt) { state = 'expired'; detail = `${best.title} expires ${exp.toISOString().slice(0, 10)}, before it is needed`; }
      else if (r.verified_required && best.status !== 'verified') { state = 'unverified'; detail = `${best.title} is declared but not yet verified`; }
      else { state = 'ok'; detail = best.status === 'verified' ? `${best.title} (verified)` : `${best.title} (declared)`; }
    }
    return { kind: r.kind, title: r.title ?? r.kind, verified_required: !!r.verified_required, state, detail };
  });
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** The allowlisted public card. Never carries confidential budget, scoring, supplier, price, passenger or youth data. */
export async function cardOf(p, c = pool) {
  const [issuer, sport, ev, lotN] = await Promise.all([
    issuerOf(p, c), p.sport_id ? one('SELECT slug, name FROM sports WHERE id=$1', [p.sport_id]) : null,
    p.event_id ? one("SELECT name FROM events WHERE id=$1 AND status <> 'draft'", [p.event_id]) : null,
    one('SELECT count(*)::int AS n FROM proc_lots WHERE project_id=$1 AND archived_at IS NULL', [p.id]),
  ]);
  const badges = (await badgesFor('user', [p.owner_user_id])).get(p.owner_user_id) ?? [];
  return {
    id: p.id, ref: p.ref, kind: p.kind, title: p.title, issuer: { name: issuer?.name ?? null, verified: badges.length > 0 },
    category: p.category, sport: sport ? { slug: sport.slug, name: sport.name } : null, location: p.location, sites: (p.sites ?? []).map((s) => s.label).filter(Boolean),
    event: ev ? { id: p.event_id, name: ev.name } : null, contract_type: p.contract_type,
    prep_start: p.prep_start, service_start: p.service_start, service_end: p.service_end, teardown_end: p.teardown_end,
    published_at: iso(p.published_at), closes_at: iso(p.closes_at), timezone: p.timezone, closes_at_utc: iso(p.closes_at), stage: stageOf(p), publication: p.publication,
    participation: p.publication === 'public' ? 'open' : p.publication === 'restricted' ? 'approved_suppliers' : 'invite_only',
    requires: (p.required_credentials ?? []).map((r) => r.title ?? r.kind), lots: lotN.n, envelope_mode: p.envelope_mode, version: p.version,
    budget: p.budget_public && p.budget_minor !== null ? { amount_minor: Number(p.budget_minor), currency: p.currency } : null,
  };
}
