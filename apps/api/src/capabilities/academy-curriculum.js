// Academy OS P0 / #782: coaching philosophy, curriculum & methodology governance. A methodology is the academy's sport-specific library (values,
// competencies, outcomes, approved drills); a curriculum is a versioned, TD-approved teaching plan for a season / age band / level / campus that
// may inherit from a parent. Objectives are mapped to canonical academy sessions (snapshotted, so a later version never rewrites history) and are
// delivered through the coach's existing coaching session record (plan blocks), which also supplies the completion evidence. No planner, no
// scoring engine and no second session: everything here points at the canonical records.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { requireGuardian, isYouth } from '../youth.js';
import { opsAccess, sessionFor, ADMINS } from '../academy-ops.js';
import { openSession, savePlan } from './coaching-journal.js';
import { planCohort, toCsv, PILLARS, DEVIATIONS, BLOCK_KINDS, PRIORITIES, MASTERY, GAME_PHASES, INTENSITIES, readiness, diffVersions, deliveryAnalytics, iso, today, versionInEffect, methodologyVersion, resolveObjectives, decorate, sessionEvidence, sessionContext, assignmentsForCohort, assignmentCoverage } from '../academy-curriculum.js';

const TAG = 'Academy';
const READ = ['owner', 'admin', 'coach', 'auditor'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const slug = z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Use lowercase letters, numbers, - or _');
const text = (n) => z.string().trim().max(n);

/** Technical Director = owner/admin or an active engagement with the "curriculum" permission, read live on every call. */
async function govern(user, orgId, { write = false, c } = {}) {
  const a = await opsAccess(user, orgId, { write, c });
  if (!a.has('curriculum')) throw forbidden('You do not have curriculum access to this academy');
  return a;
}
/** Read access: governance staff see everything; a coach sees the library and only the curricula assigned to their cohorts. */
async function reader(user, orgId, c) {
  const a = await opsAccess(user, orgId, { c });
  if (a.has('curriculum')) return { a, all: true };
  if (a.role === 'coach') return { a, all: false };
  throw forbidden('You do not have access to the curriculum of this academy');
}
const isMine = async (userId, curriculumId) => !!(await one(
  `SELECT 1 FROM academy_curriculum_assignments x JOIN org_cohorts k ON k.id=x.cohort_id WHERE x.curriculum_id=$1 AND x.status='active' AND (x.coach_id=$2 OR k.coach_id=$2) LIMIT 1`, [curriculumId, userId]));
const dateOr = (d) => (d ? iso(d) : null);

// ---------------------------------------------------------------- methodology library
const competency = z.object({
  key: slug, pillar: z.enum(PILLARS), title: text(100).min(2), description: text(500).optional(), rubric_id: id.optional().describe('an existing Coach Performance Studio rubric that measures this competency'), dimension_key: text(60).optional(),
  proficiency: z.array(z.object({ stage_key: slug, descriptor: text(400).min(2) })).max(12).default([]).describe('what mastery looks like at each stage of the ladder'),
});
const stage = z.object({ key: slug, title: text(80).min(2), age_min: z.number().int().min(3).max(99).optional(), age_max: z.number().int().min(3).max(99).optional(), hours_per_week: z.number().min(0).max(60).optional(), focus: text(300).optional() });
const gameModel = z.object({ key: slug, phase: z.enum(GAME_PHASES), title: text(100).min(2), description: text(500).optional() });
const standards = z.object({ session_minutes: z.number().int().min(10).max(300).optional(), rpe_target: z.number().int().min(1).max(10).optional(), max_group_size: z.number().int().min(1).max(100).optional(), coach_ratio: z.number().int().min(1).max(60).optional().describe('athletes per coach'), notes: text(500).optional() });
const drill = z.object({
  key: slug, title: text(120).min(2), kind: z.enum(BLOCK_KINDS).default('skill_drill'), competency_keys: z.array(slug).max(10).default([]), duration_min: z.number().int().min(1).max(240).optional(),
  instructions: text(2000).optional(), setup: text(500).optional(), area: text(120).optional(), equipment: z.array(text(60)).max(15).default([]), work_rest: text(60).optional(),
  progression: text(300).optional(), regression: text(300).optional(), success_criteria: text(500).optional(), cues: z.array(text(200)).max(10).default([]),
});
const outcome = z.object({ competency_key: slug, stage_key: slug.optional(), age_min: z.number().int().min(3).max(99).optional(), age_max: z.number().int().min(3).max(99).optional(), level_key: text(40).optional(), position: text(60).optional(), outcome: text(300).min(2) });

cap({
  name: 'create_academy_methodology', method: 'POST', path: '/organisations/:id/academy/methodologies', tag: TAG, status: 201,
  summary: 'Start the academy\'s coaching methodology for one sport (Technical Director / owner / admin). The library content (philosophy, competencies, outcomes, approved drills) is added by publishing a version.',
  input: z.object({ id, sport: z.string().trim().toLowerCase().min(2).max(40), title: text(120).min(2) }),
  async handler({ user }, i) {
    await govern(user, i.id, { write: true });
    const dup = await one('SELECT id FROM academy_methodologies WHERE organisation_id=$1 AND sport=$2 AND lower(title)=lower($3)', [i.id, i.sport, i.title]);
    if (dup) throw conflict('This academy already has a methodology with that name for this sport', { code: 'duplicate_methodology' });
    const r = await one('INSERT INTO academy_methodologies(organisation_id, sport, title, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, i.sport, i.title, user.id]);
    await audit(null, user.id, 'create_academy_methodology', 'academy_methodologies', r.id);
    return r;
  },
});

cap({
  name: 'publish_academy_methodology_version', method: 'POST', path: '/academy/methodologies/:id/versions', tag: TAG, status: 201,
  summary: 'Publish a new version of a methodology: values, competencies (technical / tactical / physical / mental / lifestyle), position-age-level outcomes and approved drill templates. Append-only; curricula keep the version they were written against. Send row_version from the last read.',
  input: z.object({
    id, row_version: z.number().int().min(1),
    philosophy: z.object({ statement: text(1000).optional(), values: z.array(z.object({ key: slug, title: text(80).min(2), description: text(400).optional() })).max(12).default([]), principles: z.array(z.object({ key: slug, title: text(100).min(2), description: text(500).optional() })).max(12).default([]).describe('how we coach: questioning, constraints-led, error tolerance...') }).default({ values: [], principles: [] }),
    stages: z.array(stage).max(12).default([]), game_model: z.array(gameModel).max(40).default([]), standards: standards.default({}),
    competencies: z.array(competency).min(1).max(60), outcomes: z.array(outcome).max(300).default([]), drills: z.array(drill).max(100).default([]),
    effective_from: day.optional(), note: text(300).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query('SELECT * FROM academy_methodologies WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!m) throw notFound('Methodology');
    await govern(user, m.organisation_id, { write: true, c });
    if (m.row_version !== i.row_version) throw conflict('This methodology changed since you opened it. Reload and try again.', { code: 'stale_version' });
    if (m.status === 'archived') throw conflict('This methodology is archived');
    const keys = i.competencies.map((x) => x.key);
    if (new Set(keys).size !== keys.length) throw badRequest('Competency keys must be unique');
    const dk = i.drills.map((x) => x.key);
    if (new Set(dk).size !== dk.length) throw badRequest('Drill keys must be unique');
    const vk = i.philosophy.values.map((x) => x.key);
    if (new Set(vk).size !== vk.length) throw badRequest('Value keys must be unique');
    for (const d of i.drills) for (const k of d.competency_keys) if (!keys.includes(k)) throw badRequest(`Drill "${d.title}" trains "${k}", which is not a competency of this methodology`);
    for (const o of i.outcomes) {
      if (!keys.includes(o.competency_key)) throw badRequest(`An outcome refers to "${o.competency_key}", which is not a competency of this methodology`);
      if (o.age_min != null && o.age_max != null && o.age_min > o.age_max) throw badRequest('An outcome has a minimum age above its maximum age');
    }
    for (const k of i.competencies) if (k.rubric_id && !(await c.query('SELECT 1 FROM coaching_rubrics WHERE id=$1', [k.rubric_id])).rows.length) throw badRequest(`${k.title}: that coaching rubric does not exist`);
    const sk = i.stages.map((x) => x.key);
    if (new Set(sk).size !== sk.length) throw badRequest('Stage keys must be unique');
    for (const x of i.stages) if (x.age_min != null && x.age_max != null && x.age_min > x.age_max) throw badRequest(`Stage "${x.title}": minimum age is above maximum age`);
    for (const k of i.competencies) for (const pr of k.proficiency) if (!sk.includes(pr.stage_key)) throw badRequest(`${k.title}: proficiency refers to stage "${pr.stage_key}", which is not on the ladder`);
    for (const o of i.outcomes) if (o.stage_key && !sk.includes(o.stage_key)) throw badRequest('An outcome refers to a stage that is not on the ladder');
    if (new Set(i.game_model.map((x) => x.key)).size !== i.game_model.length) throw badRequest('Game-model keys must be unique');
    const version = m.current_version + 1;
    const v = (await c.query('INSERT INTO academy_methodology_versions(methodology_id, version, philosophy, competencies, outcomes, drills, stages, game_model, standards, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::date, current_date),$11,$12) RETURNING *',
      [m.id, version, JSON.stringify(i.philosophy), JSON.stringify(i.competencies), JSON.stringify(i.outcomes), JSON.stringify(i.drills), JSON.stringify(i.stages), JSON.stringify(i.game_model), JSON.stringify(i.standards), i.effective_from ?? null, i.note ?? null, user.id])).rows[0];
    const nm = (await c.query("UPDATE academy_methodologies SET current_version=$2, status='active', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [m.id, version])).rows[0];
    await audit(c, user.id, 'publish_academy_methodology_version', 'academy_methodologies', m.id);
    return { methodology: nm, version: v };
  }),
});

cap({
  name: 'list_academy_methodologies', method: 'GET', path: '/organisations/:id/academy/methodologies', tag: TAG,
  summary: 'The academy\'s methodology library with the current version\'s size (competencies, drills, values) and how many curricula use each (owner/admin/coach/auditor). Every sport the academy teaches has its own entry.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await reader(user, i.id);
    return many(
      `SELECT m.*, v.effective_from, jsonb_array_length(coalesce(v.competencies,'[]')) AS competencies, jsonb_array_length(coalesce(v.drills,'[]')) AS drills, jsonb_array_length(coalesce(v.philosophy->'values','[]')) AS "values", jsonb_array_length(coalesce(v.stages,'[]')) AS stages, coalesce(v.stages,'[]') AS stage_list, jsonb_array_length(coalesce(v.game_model,'[]')) AS game_model,
              (SELECT count(*)::int FROM academy_curricula k WHERE k.methodology_id=m.id AND k.status <> 'archived') AS curricula
         FROM academy_methodologies m LEFT JOIN academy_methodology_versions v ON v.methodology_id=m.id AND v.version=m.current_version
        WHERE m.organisation_id=$1 AND m.status <> 'archived' ORDER BY m.sport, m.title, m.id`, [i.id]);
  },
});

cap({
  name: 'get_academy_methodology', method: 'GET', path: '/academy/methodologies/:id', tag: TAG,
  summary: 'One methodology with every published version (owner/admin/coach/auditor).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await one('SELECT * FROM academy_methodologies WHERE id=$1', [i.id]);
    if (!m) throw notFound('Methodology');
    await reader(user, m.organisation_id).catch(() => { throw notFound('Methodology'); });
    return { methodology: m, versions: await many('SELECT * FROM academy_methodology_versions WHERE methodology_id=$1 ORDER BY version DESC', [m.id]) };
  },
});

// ---------------------------------------------------------------- curricula
const phase = z.object({ key: slug, title: text(80).min(2), starts_on: day, ends_on: day, intensity: z.enum(INTENSITIES).default('medium'), focus_keys: z.array(slug).max(12).default([]), note: text(300).optional() });
const objective = z.object({
  key: slug, title: text(120).min(2), competency_key: slug, description: text(500).optional(), sessions_target: z.number().int().min(1).max(200).default(1),
  priority: z.enum(PRIORITIES).default('core'), mastery_target: z.enum(MASTERY).default('develop').describe('the level of mastery expected by the end of the version'),
  success_criteria: text(500).optional().describe('how a coach judges the objective is met; required before the version can be submitted'), rpe_target: z.number().int().min(1).max(10).optional(),
  phase_keys: z.array(slug).max(12).default([]).describe('periodisation phases the objective runs in; empty = all year'), assess: z.object({ rubric_id: id, dimension_key: text(60).min(1) }).optional().describe('an existing coaching rubric dimension that measures it'),
  drill_keys: z.array(slug).max(10).default([]), guardian_summary: text(300).optional().describe('plain-language line shown to families'), op: z.enum(['add', 'override', 'exclude']).default('add').describe('only meaningful with a parent curriculum'),
});

async function ownVersion(cur, c) {
  return (await c.query('SELECT * FROM academy_curriculum_versions WHERE curriculum_id=$1 AND status IN (\'draft\',\'submitted\',\'approved\')', [cur.id])).rows[0] ?? null;
}

cap({
  name: 'create_academy_curriculum', method: 'POST', path: '/organisations/:id/academy/curricula', tag: TAG, status: 201,
  summary: 'Create a curriculum shell (Technical Director / owner / admin) from a published methodology, scoped by season, age band, pathway level and campus (an academy venue). Optionally inherit from a parent curriculum of the same methodology; inheritance is set once and is read live from the parent\'s version in force. Objectives arrive as versions.',
  input: z.object({
    id, methodology_id: id, title: text(120).min(2), parent_id: id.optional(), season_id: id.optional(), venue_id: id.optional().describe('campus'), pathway_id: id.optional(), level_key: text(40).optional(), stage_key: text(40).optional().describe('a stage of the methodology ladder'),
    age_min: z.number().int().min(3).max(99).optional(), age_max: z.number().int().min(3).max(99).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    await govern(user, i.id, { write: true, c });
    if (i.age_min != null && i.age_max != null && i.age_min > i.age_max) throw badRequest('Minimum age is above maximum age');
    const m = (await c.query('SELECT * FROM academy_methodologies WHERE id=$1 AND organisation_id=$2', [i.methodology_id, i.id])).rows[0];
    if (!m) throw badRequest('That methodology is not in this academy');
    if (!m.current_version) throw conflict('Publish a version of the methodology first', { code: 'methodology_unpublished' });
    if (i.parent_id) {
      const p = (await c.query('SELECT * FROM academy_curricula WHERE id=$1 AND organisation_id=$2', [i.parent_id, i.id])).rows[0];
      if (!p) throw badRequest('The parent curriculum is not in this academy');
      if (p.methodology_id !== m.id) throw badRequest('A curriculum can only inherit from one that uses the same methodology');
      let depth = 1, cur = p;
      while (cur.parent_id && depth < 5) { cur = (await c.query('SELECT * FROM academy_curricula WHERE id=$1', [cur.parent_id])).rows[0]; depth++; }
      if (depth >= 4) throw badRequest('Inheritance can be at most four levels deep');
    }
    if (i.stage_key) {
      const mv0 = await methodologyVersion(m.id, m.current_version, c);
      if (!(mv0?.stages ?? []).some((x) => x.key === i.stage_key)) throw badRequest('That stage is not on the methodology ladder');
    }
    if (i.season_id && !(await c.query('SELECT 1 FROM org_seasons WHERE id=$1 AND organisation_id=$2', [i.season_id, i.id])).rows.length) throw badRequest('That season is not in this academy');
    if (i.venue_id && !(await c.query('SELECT 1 FROM venues WHERE id=$1 AND organisation_id=$2', [i.venue_id, i.id])).rows.length) throw badRequest('That campus is not one of this academy\'s venues');
    if (i.pathway_id) {
      const pw = (await c.query('SELECT * FROM academy_pathways WHERE id=$1 AND organisation_id=$2', [i.pathway_id, i.id])).rows[0];
      if (!pw) throw badRequest('That pathway is not in this academy');
      if (i.level_key) {
        const pv = (await c.query('SELECT levels FROM academy_pathway_versions WHERE pathway_id=$1 AND version=$2', [pw.id, pw.current_version])).rows[0];
        if (!pv?.levels.some((l) => l.key === i.level_key)) throw badRequest('That level is not on the pathway');
      }
    }
    const r = (await c.query(
      'INSERT INTO academy_curricula(organisation_id, methodology_id, parent_id, season_id, venue_id, pathway_id, level_key, stage_key, age_min, age_max, title, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [i.id, m.id, i.parent_id ?? null, i.season_id ?? null, i.venue_id ?? null, i.pathway_id ?? null, i.level_key ?? null, i.stage_key ?? null, i.age_min ?? null, i.age_max ?? null, i.title, user.id])).rows[0];
    await audit(c, user.id, 'create_academy_curriculum', 'academy_curricula', r.id);
    return r;
  }),
});

cap({
  name: 'save_academy_curriculum_draft', method: 'POST', path: '/academy/curricula/:id/versions', tag: TAG, status: 201,
  summary: 'Write the next curriculum version as a draft (Technical Director / owner / admin): objectives tied to competencies and approved drills of the methodology version, with sessions target, a plain-language line for families and an effective date. Saving again replaces the open draft; once submitted it is frozen. With a parent, op "override"/"exclude" changes an inherited objective for this scope. Publishing is a separate approved step.',
  input: z.object({ id, objectives: z.array(objective).min(1).max(80), phases: z.array(phase).max(16).default([]), effective_from: day.optional(), note: text(300).optional(), methodology_version: z.number().int().min(1).optional().describe('defaults to the methodology\'s current version') }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM academy_curricula WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Curriculum');
    await govern(user, cur.organisation_id, { write: true, c });
    if (cur.status === 'archived') throw conflict('This curriculum is archived');
    const open = await ownVersion(cur, c);
    if (open && open.status !== 'draft') throw conflict(`Version ${open.version} is ${open.status}; wait for the decision or reject it before drafting again`, { code: 'version_in_review' });
    const m = (await c.query('SELECT * FROM academy_methodologies WHERE id=$1', [cur.methodology_id])).rows[0];
    const mvn = i.methodology_version ?? m.current_version;
    const mv = await methodologyVersion(m.id, mvn, c);
    if (!mv) throw badRequest('That methodology version does not exist');
    const comp = new Set(mv.competencies.map((x) => x.key)), drills = new Set(mv.drills.map((x) => x.key));
    const keys = i.objectives.map((o) => o.key);
    if (new Set(keys).size !== keys.length) throw badRequest('Objective keys must be unique');
    let inherited = new Set();
    if (cur.parent_id) {
      const parent = (await c.query('SELECT * FROM academy_curricula WHERE id=$1', [cur.parent_id])).rows[0];
      const pv = await versionInEffect(parent.id, today(), c);
      inherited = new Set((pv ? await resolveObjectives(parent, pv, today(), c) : []).map((o) => o.key));
    }
    for (const o of i.objectives) {
      if (o.op !== 'add' && !cur.parent_id) throw badRequest(`${o.title}: only a curriculum with a parent can override or exclude an inherited objective`);
      if (o.op !== 'add' && !inherited.has(o.key)) throw badRequest(`${o.title}: the parent curriculum has no objective "${o.key}" in force to ${o.op}`);
      if (o.op === 'exclude') continue;
      if (!comp.has(o.competency_key)) throw badRequest(`${o.title}: "${o.competency_key}" is not a competency of this methodology version`);
      for (const k of o.drill_keys) if (!drills.has(k)) throw badRequest(`${o.title}: "${k}" is not an approved drill of this methodology version`);
      if (o.assess && !(await c.query('SELECT 1 FROM coaching_rubrics WHERE id=$1', [o.assess.rubric_id])).rows.length) throw badRequest(`${o.title}: that coaching rubric does not exist`);
    }
    const pkeys = i.phases.map((x) => x.key);
    if (new Set(pkeys).size !== pkeys.length) throw badRequest('Phase keys must be unique');
    for (const ph of i.phases) for (const k of ph.focus_keys) if (!comp.has(k)) throw badRequest(`Phase "${ph.title}" focuses on "${k}", which is not a competency of this methodology version`);
    const eff = i.effective_from ?? today();
    let v;
    if (open) v = (await c.query('UPDATE academy_curriculum_versions SET objectives=$2, phases=$6, methodology_version=$3, effective_from=$4::date, note=$5 WHERE id=$1 RETURNING *', [open.id, JSON.stringify(i.objectives), mvn, eff, i.note ?? null, JSON.stringify(i.phases)])).rows[0];
    else {
      const next = ((await c.query('SELECT coalesce(max(version),0)::int AS n FROM academy_curriculum_versions WHERE curriculum_id=$1', [cur.id])).rows[0].n) + 1;
      v = (await c.query('INSERT INTO academy_curriculum_versions(curriculum_id, version, methodology_version, objectives, phases, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$8,$5::date,$6,$7) RETURNING *', [cur.id, next, mvn, JSON.stringify(i.objectives), eff, i.note ?? null, user.id, JSON.stringify(i.phases)])).rows[0];
    }
    await audit(c, user.id, 'save_academy_curriculum_draft', 'academy_curriculum_versions', v.id);
    return v;
  }),
});

const versionFor = async (versionId, c) => {
  const v = (await c.query('SELECT v.*, k.organisation_id, k.title AS curriculum_title, k.current_version FROM academy_curriculum_versions v JOIN academy_curricula k ON k.id=v.curriculum_id WHERE v.id=$1 FOR UPDATE OF v', [versionId])).rows[0];
  if (!v) throw notFound('Curriculum version');
  return v;
};

/** Readiness of a version as the approver will meet it, and what it changes against the version it follows. */
async function assess(cur, v, c) {
  const mv = await methodologyVersion(cur.methodology_id, v.methodology_version, c);
  const resolved = await decorate(cur, v, await resolveObjectives(cur, v, today(), c), c);
  const prev = (await (c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) }).query("SELECT * FROM academy_curriculum_versions WHERE curriculum_id=$1 AND version < $2 AND status IN ('published','superseded') ORDER BY version DESC LIMIT 1", [cur.id, v.version])).rows[0] ?? null;
  const groups = (await (c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) }).query("SELECT count(*)::int AS n FROM academy_curriculum_assignments WHERE curriculum_id=$1 AND status='active'", [cur.id])).rows[0].n;
  const mapped = prev ? (await (c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) }).query("SELECT count(*)::int AS n FROM academy_session_objectives WHERE curriculum_version_id=$1 AND status <> 'removed'", [prev.id])).rows[0].n : 0;
  return { readiness: readiness(v, resolved, mv), diff: diffVersions(prev, v), against: prev ? prev.version : null, impact: { groups, sessions_keep_old_wording: mapped } };
}

cap({
  name: 'get_academy_curriculum_readiness', method: 'GET', path: '/academy/curriculum-versions/:id/readiness', tag: TAG,
  summary: 'Is this version fit to submit, and what does it change? Blockers (no objectives, an objective without success criteria, overlapping or unknown periodisation phases) stop submission; warnings (a pillar with no objective, drills or family line missing, no periodisation) travel with the request. Also returns the field-level difference from the version it follows and how many groups and already-planned sessions are affected (those keep their old wording).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const v = await one('SELECT v.*, k.organisation_id FROM academy_curriculum_versions v JOIN academy_curricula k ON k.id=v.curriculum_id WHERE v.id=$1', [i.id]);
    if (!v) throw notFound('Curriculum version');
    const { all } = await reader(user, v.organisation_id).catch(() => { throw notFound('Curriculum version'); });
    if (!all) throw notFound('Curriculum version');
    const cur = await one('SELECT * FROM academy_curricula WHERE id=$1', [v.curriculum_id]);
    return assess(cur, v);
  },
});

cap({
  name: 'submit_academy_curriculum_version', method: 'POST', path: '/academy/curriculum-versions/:id/submit', tag: TAG,
  summary: 'Send the draft for Technical Director approval. From here the objectives are frozen.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const v = await versionFor(i.id, c);
    await govern(user, v.organisation_id, { write: true, c });
    if (v.status !== 'draft') throw conflict(`This version is already ${v.status}`);
    const cur0 = (await c.query('SELECT * FROM academy_curricula WHERE id=$1', [v.curriculum_id])).rows[0];
    const ready = await assess(cur0, v, c);
    if (!ready.readiness.ready) throw conflict('This version is not ready to submit', { code: 'not_ready', blockers: ready.readiness.blockers });
    const r = (await c.query("UPDATE academy_curriculum_versions SET status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$1 RETURNING *", [v.id, user.id])).rows[0];
    await audit(c, user.id, 'submit_academy_curriculum_version', 'academy_curriculum_versions', v.id);
    return { ...r, warnings: ready.readiness.warnings };
  }),
});

cap({
  name: 'decide_academy_curriculum_version', method: 'POST', path: '/academy/curriculum-versions/:id/decision', tag: TAG,
  summary: 'Technical Director decision on a submitted version: approve, or reject with a reason. The person who submitted it cannot approve it unless they are the academy owner or an admin (then it is recorded as self-approved).',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const v = await versionFor(i.id, c);
    const a = await govern(user, v.organisation_id, { write: true, c });
    if (v.status !== 'submitted') throw conflict(`This version is ${v.status}, not waiting for a decision`);
    if (i.decision === 'reject' && !i.note) throw badRequest('Say why the version is rejected');
    const self = v.submitted_by === user.id;
    if (self && !ADMINS.includes(a.role)) throw forbidden('A different Technical Director must approve what you submitted');
    const r = (await c.query('UPDATE academy_curriculum_versions SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, self_approved=$5 WHERE id=$1 RETURNING *', [v.id, i.decision === 'approve' ? 'approved' : 'rejected', user.id, i.note ?? null, self && i.decision === 'approve'])).rows[0];
    await audit(c, user.id, `${i.decision}_academy_curriculum_version`, 'academy_curriculum_versions', v.id);
    if (v.submitted_by && v.submitted_by !== user.id) await notify(c, v.submitted_by, { kind: 'academy_curriculum_decision', title: `Curriculum ${i.decision === 'approve' ? 'approved' : 'rejected'}: ${v.curriculum_title}`, body: i.note ?? 'Open the Curriculum tab for details.', data: { organisation_id: v.organisation_id, curriculum_id: v.curriculum_id, version_id: v.id }, dedupe_key: `curriculum-decision:${v.id}` });
    return r;
  }),
});

cap({
  name: 'publish_academy_curriculum_version', method: 'POST', path: '/academy/curriculum-versions/:id/publish', tag: TAG,
  summary: 'Publish an approved version with an effective date (today or later). The previous version stays readable and is closed the day before; sessions already mapped keep the objectives they were planned with.',
  input: z.object({ id, effective_from: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const v = await versionFor(i.id, c);
    await govern(user, v.organisation_id, { write: true, c });
    if (v.status !== 'approved') throw conflict(v.status === 'published' ? 'This version is already published' : 'Only an approved version can be published', { code: 'not_approved' });
    const cur = (await c.query('SELECT * FROM academy_curricula WHERE id=$1 FOR UPDATE', [v.curriculum_id])).rows[0];
    const from = i.effective_from ?? (dateOr(v.effective_from) < today() ? today() : dateOr(v.effective_from));
    if (from < today()) throw badRequest('A version cannot take effect in the past; choose today or a later date');
    const prior = (await c.query("SELECT * FROM academy_curriculum_versions WHERE curriculum_id=$1 AND status='published'", [cur.id])).rows[0];
    if (prior) {
      if (from <= dateOr(prior.effective_from)) throw badRequest(`The new version must start after version ${prior.version} (${dateOr(prior.effective_from)})`);
      await c.query("UPDATE academy_curriculum_versions SET status='superseded', effective_to=($2::date - 1) WHERE id=$1", [prior.id, from]);
    }
    const r = (await c.query("UPDATE academy_curriculum_versions SET status='published', effective_from=$2::date, published_by=$3, published_at=now() WHERE id=$1 RETURNING *", [v.id, from, user.id])).rows[0];
    await c.query("UPDATE academy_curricula SET current_version=$2, status='active', row_version=row_version+1, updated_at=now() WHERE id=$1", [cur.id, v.version]);
    await audit(c, user.id, 'publish_academy_curriculum_version', 'academy_curriculum_versions', v.id);
    const coaches = (await c.query("SELECT DISTINCT coalesce(x.coach_id, k.coach_id) AS uid FROM academy_curriculum_assignments x JOIN org_cohorts k ON k.id=x.cohort_id WHERE x.curriculum_id=$1 AND x.status='active'", [cur.id])).rows.map((x) => x.uid).filter(Boolean);
    for (const uid of coaches) await notify(c, uid, { kind: 'academy_curriculum_published', title: `New version of ${cur.title} from ${from}`, body: 'Open Academy › Curriculum and confirm you have read it.', data: { organisation_id: cur.organisation_id, curriculum_id: cur.id, version_id: v.id }, dedupe_key: `curriculum-published:${v.id}:${uid}` });
    return r;
  }),
});

const listSql = `
  SELECT k.*, m.title AS methodology_title, m.sport, p.title AS parent_title, s.name AS season_name, ve.name AS campus_name,
         (SELECT jsonb_build_object('version', v.version, 'effective_from', v.effective_from, 'objectives', jsonb_array_length(v.objectives)) FROM academy_curriculum_versions v WHERE v.curriculum_id=k.id AND v.status='published') AS published,
         (SELECT jsonb_build_object('id', v.id, 'version', v.version, 'status', v.status) FROM academy_curriculum_versions v WHERE v.curriculum_id=k.id AND v.status IN ('draft','submitted','approved')) AS open_version,
         (SELECT count(*)::int FROM academy_curriculum_assignments x WHERE x.curriculum_id=k.id AND x.status='active') AS assignments,
         (SELECT r.outcome FROM academy_curriculum_reviews r WHERE r.curriculum_id=k.id ORDER BY r.created_at DESC LIMIT 1) AS last_review
    FROM academy_curricula k JOIN academy_methodologies m ON m.id=k.methodology_id LEFT JOIN academy_curricula p ON p.id=k.parent_id LEFT JOIN org_seasons s ON s.id=k.season_id LEFT JOIN venues ve ON ve.id=k.venue_id`;

cap({
  name: 'list_academy_curricula', method: 'GET', path: '/organisations/:id/academy/curricula', tag: TAG,
  summary: 'The academy\'s curricula with scope (sport, season, age band, level, campus, parent), the published version, any version waiting for approval, assignments and the latest review. A coach sees only curricula assigned to their cohorts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { all } = await reader(user, i.id);
    const rows = await many(`${listSql} WHERE k.organisation_id=$1 AND k.status <> 'archived' ORDER BY m.sport, k.title, k.id`, [i.id]);
    if (all) return rows;
    const mine = [];
    for (const r of rows) if (await isMine(user.id, r.id)) mine.push(r);
    return mine;
  },
});

cap({
  name: 'get_academy_curriculum', method: 'GET', path: '/academy/curricula/:id', tag: TAG,
  summary: 'One curriculum: every version with status and decision, the objectives in force today (inherited ones marked), assignments with their coach and cohort, reviews, and the methodology version it is written against. A coach reads it only when assigned.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cur = await one(`${listSql} WHERE k.id=$1`, [i.id]);
    if (!cur) throw notFound('Curriculum');
    const { all } = await reader(user, cur.organisation_id).catch(() => { throw notFound('Curriculum'); });
    if (!all && !(await isMine(user.id, cur.id))) throw notFound('Curriculum');
    const versions = await many('SELECT v.*, ub.display_name AS submitted_by_name, db.display_name AS decided_by_name FROM academy_curriculum_versions v LEFT JOIN users ub ON ub.id=v.submitted_by LEFT JOIN users db ON db.id=v.decided_by WHERE v.curriculum_id=$1 ORDER BY v.version DESC', [cur.id]);
    const inForce = await versionInEffect(cur.id);
    const objectives = inForce ? await decorate(cur, inForce, await resolveObjectives(cur, inForce), null) : [];
    const open = versions.find((v) => ['draft', 'submitted', 'approved'].includes(v.status));
    const openObjectives = open ? await decorate(cur, open, await resolveObjectives(cur, open), null) : [];
    const assignments = await many(
      `SELECT x.*, k.name AS cohort_name, cu.display_name AS coach_name, (SELECT count(*)::int FROM org_enrolments e WHERE e.cohort_id=x.cohort_id AND e.status='enrolled') AS athletes
         FROM academy_curriculum_assignments x JOIN org_cohorts k ON k.id=x.cohort_id LEFT JOIN users cu ON cu.id=x.coach_id WHERE x.curriculum_id=$1 AND x.status='active' ORDER BY k.name`, [cur.id]);
    const acked = new Set((await many('SELECT user_id FROM academy_curriculum_acks WHERE curriculum_version_id=$1', [inForce?.id ?? null])).map((r) => r.user_id));
    for (const x of assignments) x.acknowledged = x.coach_id ? acked.has(x.coach_id) : null;
    const me = assignments.find((x) => x.coach_id === user.id);
    const needs_ack = !!(me && inForce && !acked.has(user.id));
    const reviews = all ? await many('SELECT r.*, u.display_name AS reviewer_name FROM academy_curriculum_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.curriculum_id=$1 ORDER BY r.created_at DESC LIMIT 20', [cur.id]) : [];
    const methodology = await one('SELECT m.id, m.title, m.sport, m.current_version FROM academy_methodologies m WHERE m.id=$1', [cur.methodology_id]);
    const mv = await methodologyVersion(cur.methodology_id, (open ?? inForce)?.methodology_version ?? methodology.current_version);
    const review = open && all ? await assess(cur, open) : null;
    return { curriculum: cur, versions, objectives, open_objectives: openObjectives, open_review: review, needs_ack, in_force_id: inForce?.id ?? null, in_force: inForce ? { id: inForce.id, version: inForce.version, effective_from: inForce.effective_from } : null, assignments, reviews,
      methodology: { ...methodology, version: mv?.version ?? null, competencies: mv?.competencies ?? [], drills: mv?.drills ?? [], philosophy: mv?.philosophy ?? {}, outcomes: mv?.outcomes ?? [], standards: mv?.standards ?? {}, stages: mv?.stages ?? [] } };
  },
});

// ---------------------------------------------------------------- assignment
cap({
  name: 'assign_academy_curriculum', method: 'POST', path: '/academy/curricula/:id/assignments', tag: TAG, status: 201,
  summary: 'Assign a published curriculum to a cohort and name the coach accountable for delivering it (Technical Director / owner / admin). The coach must be an active member of the academy. Repeating for the same cohort returns the existing assignment.',
  input: z.object({ id, cohort_id: id, coach_id: id.optional(), effective_from: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM academy_curricula WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Curriculum');
    await govern(user, cur.organisation_id, { write: true, c });
    if (!cur.current_version) throw conflict('Publish a version before assigning it', { code: 'not_published' });
    const k = (await c.query("SELECT * FROM org_cohorts WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.cohort_id, cur.organisation_id])).rows[0];
    if (!k) throw badRequest('That cohort is not an active group of this academy');
    if (cur.season_id && k.season_id && cur.season_id !== k.season_id) throw badRequest('The cohort belongs to a different season from this curriculum');
    const coachId = i.coach_id ?? k.coach_id ?? null;
    if (coachId && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin','coach')", [cur.organisation_id, coachId])).rows.length) throw badRequest('That person is not an active coach of this academy');
    const have = (await c.query("SELECT * FROM academy_curriculum_assignments WHERE curriculum_id=$1 AND cohort_id=$2 AND status='active'", [cur.id, k.id])).rows[0];
    if (have) {
      if (coachId && have.coach_id !== coachId) {
        const r = (await c.query('UPDATE academy_curriculum_assignments SET coach_id=$2, updated_at=now() WHERE id=$1 RETURNING *', [have.id, coachId])).rows[0];
        await audit(c, user.id, 'reassign_academy_curriculum_coach', 'academy_curriculum_assignments', have.id);
        await notify(c, coachId, { kind: 'academy_curriculum_assigned', title: `You deliver ${cur.title} for ${k.name}`, body: 'Open Academy › Curriculum to see the objectives.', data: { organisation_id: cur.organisation_id, curriculum_id: cur.id, cohort_id: k.id }, dedupe_key: `curriculum-assign:${have.id}:${coachId}` });
        return r;
      }
      return have;
    }
    const r = (await c.query('INSERT INTO academy_curriculum_assignments(curriculum_id, cohort_id, coach_id, effective_from, assigned_by) VALUES ($1,$2,$3,coalesce($4::date, current_date),$5) RETURNING *', [cur.id, k.id, coachId, i.effective_from ?? null, user.id])).rows[0];
    await audit(c, user.id, 'assign_academy_curriculum', 'academy_curriculum_assignments', r.id);
    if (coachId && coachId !== user.id) await notify(c, coachId, { kind: 'academy_curriculum_assigned', title: `You deliver ${cur.title} for ${k.name}`, body: 'Open Academy › Curriculum to see the objectives.', data: { organisation_id: cur.organisation_id, curriculum_id: cur.id, cohort_id: k.id }, dedupe_key: `curriculum-assign:${r.id}:${coachId}` });
    return r;
  }),
});

cap({
  name: 'end_academy_curriculum_assignment', method: 'POST', path: '/academy/curriculum-assignments/:id/end', tag: TAG,
  summary: 'Stop a cohort following a curriculum (Technical Director / owner / admin). The assignment and everything delivered under it stay on record.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const x = (await c.query('SELECT x.*, k.organisation_id FROM academy_curriculum_assignments x JOIN academy_curricula k ON k.id=x.curriculum_id WHERE x.id=$1 FOR UPDATE OF x', [i.id])).rows[0];
    if (!x) throw notFound('Assignment');
    await govern(user, x.organisation_id, { write: true, c });
    if (x.status === 'ended') return x;
    const r = (await c.query("UPDATE academy_curriculum_assignments SET status='ended', ended_on=current_date, updated_at=now() WHERE id=$1 RETURNING *", [x.id])).rows[0];
    await audit(c, user.id, 'end_academy_curriculum_assignment', 'academy_curriculum_assignments', x.id);
    return r;
  }),
});

// ---------------------------------------------------------------- sessions
const snapshotOf = (o, cur, ver) => ({
  key: o.key, title: o.title, description: o.description ?? null, competency_key: o.competency_key, competency_title: o.competency_title, pillar: o.pillar, sessions_target: o.sessions_target ?? 1,
  priority: o.priority ?? 'core', mastery_target: o.mastery_target ?? null, success_criteria: o.success_criteria ?? null, rpe_target: o.rpe_target ?? null,
  guardian_summary: o.guardian_summary ?? null, drills: o.drills ?? [], curriculum_title: cur.title, version: ver.version, methodology_version: ver.methodology_version, inherited_from: o.inherited_from ?? null,
});

/** The objectives a session's cohort could teach on its date: each active assignment's version in force that day, resolved with inheritance. */
async function availableFor(s) {
  const out = [];
  for (const a of await assignmentsForCohort(s.cohort_id, s.local_date)) {
    const cur = await one('SELECT * FROM academy_curricula WHERE id=$1', [a.curriculum_id]);
    const ver = await versionInEffect(cur.id, s.local_date);
    if (!ver) continue;
    for (const o of await decorate(cur, ver, await resolveObjectives(cur, ver, s.local_date), null)) out.push({ assignment_id: a.id, curriculum_id: cur.id, curriculum_version_id: ver.id, cur, ver, o });
  }
  return out;
}
const canWork = (acc) => acc.a.has('curriculum') || acc.mine;

cap({
  name: 'get_academy_session_objectives', method: 'GET', path: '/academy/sessions/:id/objectives', tag: TAG,
  summary: 'What this academy session is meant to teach and what happened: the mapped objectives exactly as planned (frozen snapshot with the curriculum version), the completion evidence from the coach\'s coaching plan (blocks planned / done), deviation reasons, and the objectives the cohort\'s curriculum offers that are not yet mapped. Session staff and curriculum staff only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const acc = await sessionFor(user, i.id, 'view');
    if (!canWork(acc)) throw forbidden('You are not part of this session');
    const s = await sessionContext(i.id);
    const rows = await many("SELECT * FROM academy_session_objectives WHERE session_id=$1 AND status <> 'removed' ORDER BY created_at, objective_key", [s.id]);
    const ev = await sessionEvidence(s.id);
    const mapped = new Set(rows.map((r) => r.objective_key));
    const mine = (r) => r.coach_id === user.id;
    return {
      session: { id: s.id, title: s.title, starts_at: s.starts_at, status: s.status, cohort_id: s.cohort_id, local_date: s.local_date },
      objectives: rows.map((r) => { const e = ev.get(r.objective_key); return { ...r, live_evidence: e ? { blocks_planned: e.blocks_planned, blocks_done: e.blocks_done, record_id: e.records.find(mine)?.id ?? null } : null }; }),
      available: (await availableFor(s)).filter((x) => !mapped.has(x.o.key)).map((x) => ({ key: x.o.key, title: x.o.title, pillar: x.o.pillar, competency_title: x.o.competency_title, sessions_target: x.o.sessions_target ?? 1, drills: x.o.drills.length, curriculum_title: x.cur.title, assignment_id: x.assignment_id, inherited: !!x.o.inherited_from })),
      can_plan: acc.a.has('curriculum') || acc.mine,
    };
  },
});

/** Map (and withdraw) objectives on one session inside the caller's transaction. Shared by the session screen and the forward planner. */
async function mapObjectives(user, sessionId, { add_keys = [], remove_keys = [], assignment_id }, c) {
  const acc = await sessionFor(user, sessionId, 'view', { write: true, c });
  if (!canWork(acc)) throw forbidden('You are not part of this session');
  const s = await sessionContext(sessionId, c);
  if (['cancelled'].includes(s.status)) throw conflict('This session is cancelled');
  const avail = [];
  for (const a of await assignmentsForCohort(s.cohort_id, s.local_date, c)) {
    if (assignment_id && a.id !== assignment_id) continue;
    const cur = (await c.query('SELECT * FROM academy_curricula WHERE id=$1', [a.curriculum_id])).rows[0];
    const ver = await versionInEffect(cur.id, s.local_date, c);
    if (!ver) continue;
    for (const o of await decorate(cur, ver, await resolveObjectives(cur, ver, s.local_date, c), c)) avail.push({ a, cur, ver, o });
  }
  for (const key of add_keys) {
    const hit = avail.find((x) => x.o.key === key);
    if (!hit) throw badRequest(`"${key}" is not an objective of the curriculum this cohort follows on that date`);
    await c.query(
      `INSERT INTO academy_session_objectives(session_id, assignment_id, curriculum_id, curriculum_version_id, objective_key, snapshot, mapped_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (session_id, objective_key) DO UPDATE SET status='planned' WHERE academy_session_objectives.status='removed'`,
      [s.id, hit.a.id, hit.cur.id, hit.ver.id, key, JSON.stringify(snapshotOf(hit.o, hit.cur, hit.ver)), user.id]);
  }
  for (const key of remove_keys) {
    const r = await c.query("UPDATE academy_session_objectives SET status='removed' WHERE session_id=$1 AND objective_key=$2 AND status='planned' RETURNING id", [s.id, key]);
    if (!r.rowCount && (await c.query("SELECT 1 FROM academy_session_objectives WHERE session_id=$1 AND objective_key=$2 AND status NOT IN ('planned','removed')", [s.id, key])).rowCount) throw conflict(`"${key}" already has a recorded outcome and cannot be withdrawn`);
  }
  await audit(c, user.id, 'map_academy_session_objectives', 'academy_sessions', s.id);
  return (await c.query("SELECT * FROM academy_session_objectives WHERE session_id=$1 AND status <> 'removed' ORDER BY created_at, objective_key", [s.id])).rows;
}

cap({
  name: 'map_academy_session_objectives', method: 'POST', path: '/academy/sessions/:id/objectives', tag: TAG, status: 201,
  summary: 'Pick which curriculum objectives this session works on (session staff or curriculum staff). Each is stored as a frozen snapshot of the objective in the version in force on the session date, so publishing a later version never changes it. Idempotent; remove_keys withdraws objectives that have not been recorded yet.',
  input: z.object({ id, add_keys: z.array(slug).max(20).default([]), remove_keys: z.array(slug).max(20).default([]), assignment_id: id.optional() }),
  handler: ({ user }, i) => tx((c) => mapObjectives(user, i.id, i, c)),
});

cap({
  name: 'load_academy_session_objectives_into_plan', method: 'POST', path: '/academy/sessions/:id/objectives/plan', tag: TAG, auth: ['coach'], status: 201,
  summary: 'Coach: put the approved drills of the mapped objectives into your own coaching plan for this session, as tagged blocks, using the existing coaching session record and plan versions (nothing is copied elsewhere). Existing blocks are kept; repeating adds nothing twice. Then run, mark and review the session in the coaching tools as usual.',
  input: z.object({ id, keys: z.array(slug).max(20).optional() }),
  async handler({ user }, i) {
    const acc = await sessionFor(user, i.id, 'view');
    if (!acc.mine) throw forbidden('Only the session\'s coaches can plan it');
    const rows = (await many("SELECT * FROM academy_session_objectives WHERE session_id=$1 AND status='planned' ORDER BY created_at, objective_key", [i.id])).filter((r) => !i.keys || i.keys.includes(r.objective_key));
    if (!rows.length) throw badRequest('Map at least one objective to the session first');
    const rec = await openSession(user, { source_type: 'academy_session', source_id: i.id });
    const plan = await one('SELECT blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]);
    const blocks = plan?.blocks ?? [];
    const has = (t) => blocks.some((b) => (b.tags ?? []).includes(t));
    const added = [];
    for (const r of rows) {
      const sn = r.snapshot;
      const items = sn.drills.length ? sn.drills : [{ key: 'objective', title: sn.title, kind: 'custom', instructions: sn.description ?? undefined }];
      for (const d of items) {
        const tag = `drill:${d.key}`.slice(0, 60);
        if (has(`obj:${sn.key}`) && blocks.some((b) => (b.tags ?? []).includes(`obj:${sn.key}`) && (b.tags ?? []).includes(tag))) continue;
        const b = { kind: d.kind ?? 'skill_drill', title: d.title, objective: sn.title, duration_min: d.duration_min, instructions: d.instructions, setup: d.setup, cues: d.cues ?? [], success_criteria: d.success_criteria, area: d.area, equipment: d.equipment ?? [], work_rest: d.work_rest, progression: d.progression, regression: d.regression, trains: [sn.competency_key], tags: [`obj:${sn.key}`, tag, 'curriculum'] };
        for (const k of Object.keys(b)) if (b[k] === undefined || b[k] === null) delete b[k];
        blocks.push(b); added.push(d.title);
      }
    }
    if (blocks.length > 30) throw badRequest('The plan would exceed 30 blocks; remove some before loading more');
    if (!added.length) return { record_id: rec.id, plan_version: rec.plan_version, added: [] };
    const saved = await savePlan(user, rec.id, blocks, { expected_version: rec.plan_version });
    await audit(null, user.id, 'load_academy_session_objectives_into_plan', 'academy_sessions', i.id);
    return { record_id: rec.id, plan_version: saved.plan.version, added };
  },
});

cap({
  name: 'record_academy_session_objective', method: 'POST', path: '/academy/sessions/:id/objectives/:key/outcome', tag: TAG,
  summary: 'Record whether an objective was delivered, partly delivered or not delivered once the session has started. "Delivered" needs at least one completed block tagged to it in the coach\'s coaching record, or a written attestation (flagged as attested). Partly / not delivered need a deviation reason. Re-recording is allowed and audited.',
  input: z.object({ id, key: slug, outcome: z.enum(['delivered', 'partly', 'not_delivered']), deviation_reason: z.enum(DEVIATIONS).optional(), deviation_note: text(500).optional(), evidence_note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const acc = await sessionFor(user, i.id, 'view', { write: true, c });
    if (!canWork(acc)) throw forbidden('You are not part of this session');
    const s = await sessionContext(i.id, c);
    if (!['published', 'completed'].includes(s.status) || new Date(s.starts_at) > new Date()) throw conflict('Outcomes can be recorded once a published session has started');
    const o = (await c.query("SELECT * FROM academy_session_objectives WHERE session_id=$1 AND objective_key=$2 AND status <> 'removed' FOR UPDATE", [s.id, i.key])).rows[0];
    if (!o) throw notFound('Objective on this session');
    if (i.outcome !== 'delivered' && !i.deviation_reason) throw badRequest('Say why it was not fully delivered');
    const ev = (await sessionEvidence(s.id, c)).get(i.key);
    const done = ev?.blocks_done ?? 0;
    if (i.outcome === 'delivered' && !done && !i.evidence_note) throw badRequest('Mark a block for this objective as completed in your coaching plan, or add a note saying how it was delivered', { code: 'evidence_required' });
    const evidence = { blocks_planned: ev?.blocks_planned ?? 0, blocks_done: done, attested: i.outcome === 'delivered' && !done, note: i.evidence_note ?? null, record_ids: (ev?.records ?? []).map((r) => r.id) };
    const r = (await c.query('UPDATE academy_session_objectives SET status=$2, deviation_reason=$3, deviation_note=$4, evidence=$5, recorded_by=$6, recorded_at=now() WHERE id=$1 RETURNING *',
      [o.id, i.outcome, i.outcome === 'delivered' ? null : i.deviation_reason, i.outcome === 'delivered' ? null : i.deviation_note ?? null, JSON.stringify(evidence), user.id])).rows[0];
    await audit(c, user.id, 'record_academy_session_objective', 'academy_session_objectives', o.id);
    return r;
  }),
});

// ---------------------------------------------------------------- coverage & review
cap({
  name: 'get_academy_curriculum_coverage', method: 'GET', path: '/organisations/:id/academy/curriculum-coverage', tag: TAG,
  summary: 'Coverage dashboard: for each cohort following a curriculum, how many objectives are complete / in progress / planned / not yet planned, sessions held with and without an objective, deviation reasons, and the completion evidence per objective. Technical Directors see all; a coach sees their own cohorts.',
  input: z.object({ id, curriculum_id: id.optional(), cohort_id: id.optional() }),
  async handler({ user }, i) {
    const { a, all } = await reader(user, i.id);
    const rows = await many(
      `SELECT x.*, k.name AS cohort_name, u.display_name AS coach_name, cu.title AS curriculum_title, m.sport FROM academy_curriculum_assignments x JOIN academy_curricula cu ON cu.id=x.curriculum_id JOIN academy_methodologies m ON m.id=cu.methodology_id
         JOIN org_cohorts k ON k.id=x.cohort_id LEFT JOIN users u ON u.id=x.coach_id
        WHERE cu.organisation_id=$1 AND x.status='active' AND ($2::uuid IS NULL OR x.curriculum_id=$2) AND ($3::uuid IS NULL OR x.cohort_id=$3) AND ($4::boolean OR x.coach_id=$5 OR k.coach_id=$5) ORDER BY m.sport, k.name, x.id`,
      [i.id, i.curriculum_id ?? null, i.cohort_id ?? null, all, user.id]);
    const items = [];
    for (const a of rows) items.push({ cohort_name: a.cohort_name, coach_name: a.coach_name, sport: a.sport, ...(await assignmentCoverage(a)) });
    const analytics = await deliveryAnalytics(rows);
    const pil = new Map();
    for (const x of items) for (const p of x.by_pillar) { const e = pil.get(p.pillar) ?? { pillar: p.pillar, objectives: 0, complete: 0, in_progress: 0, delivered: 0, target: 0 }; for (const k of ['objectives', 'complete', 'in_progress', 'delivered', 'target']) e[k] += p[k]; pil.set(p.pillar, e); }
    const t = items.reduce((s, x) => ({ objectives: s.objectives + x.totals.objectives, complete: s.complete + x.totals.complete, held: s.held + x.totals.sessions_held, without: s.without + x.totals.sessions_without_objective }), { objectives: 0, complete: 0, held: 0, without: 0 });
    return { can_govern: all && !a.readOnly, by_pillar: PILLARS.map((p) => pil.get(p)).filter(Boolean), analytics, totals: { cohorts: items.length, objectives: t.objectives, complete: t.complete, coverage_pct: t.objectives ? Math.round((t.complete / t.objectives) * 100) : null, sessions_held: t.held, sessions_without_objective: t.without }, items };
  },
});

cap({
  name: 'record_academy_curriculum_review', method: 'POST', path: '/academy/curricula/:id/reviews', tag: TAG, status: 201,
  summary: 'Technical Director review of how a curriculum is landing: on track / needs attention / revise, with a note. The coverage figures at that moment are stored with it. Append-only.',
  input: z.object({ id, outcome: z.enum(['on_track', 'needs_attention', 'revise']), note: text(1000).optional() }),
  async handler({ user }, i) {
    const cur = await one('SELECT * FROM academy_curricula WHERE id=$1', [i.id]);
    if (!cur) throw notFound('Curriculum');
    await govern(user, cur.organisation_id, { write: true });
    if (i.outcome !== 'on_track' && !i.note) throw badRequest('Add a note saying what needs attention');
    const assigns = await many("SELECT * FROM academy_curriculum_assignments WHERE curriculum_id=$1 AND status='active'", [cur.id]);
    const cov = [];
    for (const a of assigns) { const x = await assignmentCoverage(a); cov.push({ cohort_id: x.cohort_id, version: x.version, ...x.totals, deviations: x.deviations }); }
    const ver = await versionInEffect(cur.id);
    const r = await one('INSERT INTO academy_curriculum_reviews(curriculum_id, curriculum_version_id, reviewer_id, outcome, coverage, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [cur.id, ver?.id ?? null, user.id, i.outcome, JSON.stringify({ cohorts: cov }), i.note ?? null]);
    await audit(null, user.id, 'record_academy_curriculum_review', 'academy_curricula', cur.id);
    return r;
  },
});

// ---------------------------------------------------------------- families
cap({
  name: 'get_my_academy_curriculum', method: 'GET', path: '/academy/my-curriculum', tag: TAG,
  summary: 'For the signed-in athlete, or a young athlete when their verified guardian asks: in plain language, what each of their academy groups is working on this season (curriculum title, objectives with a one-line family summary, how many are complete), without any other athlete\'s data, coach-private notes or assessment results.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id) { await requireGuardian(user, athleteId); await audit(null, user.id, 'read_child_academy_curriculum', 'users', athleteId); }
    const groups = await many(
      `SELECT DISTINCT k.id AS cohort_id, k.name AS cohort_name, o.id AS organisation_id, o.name AS academy FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN organisations o ON o.id=k.organisation_id
        WHERE e.user_id=$1 AND e.status='enrolled' ORDER BY o.name, k.name`, [athleteId]);
    const out = [];
    for (const g of groups) {
      for (const a of await assignmentsForCohort(g.cohort_id, today())) {
        const cur = await one('SELECT * FROM academy_curricula WHERE id=$1', [a.curriculum_id]);
        const ver = await versionInEffect(cur.id);
        if (!ver) continue;
        const cov = await assignmentCoverage(a);
        const objs = await decorate(cur, ver, await resolveObjectives(cur, ver), null);
        const state = new Map(cov.objectives.map((x) => [x.key, x.state]));
        out.push({ academy: g.academy, cohort_name: g.cohort_name, curriculum: cur.title, version: ver.version, age_min: cur.age_min, age_max: cur.age_max, level_key: cur.level_key, complete: cov.totals.complete, total: cov.totals.objectives,
          objectives: objs.map((o) => ({ key: o.key, title: o.title, pillar: o.pillar, summary: o.guardian_summary ?? o.description ?? null, state: state.get(o.key) ?? 'not_planned' })) });
      }
    }
    return { athlete_id: athleteId, is_youth: await isYouth(athleteId), curricula: out };
  },
});

// ---------------------------------------------------------------- acknowledgement, feedback, rollover, planner, export
cap({
  name: 'acknowledge_academy_curriculum_version', method: 'POST', path: '/academy/curriculum-versions/:id/acknowledge', tag: TAG, status: 201,
  summary: 'A coach confirms they have read the curriculum version their group follows. Idempotent; only a coach assigned to a cohort that follows it, and only for a published version.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const v = await one("SELECT v.*, k.organisation_id FROM academy_curriculum_versions v JOIN academy_curricula k ON k.id=v.curriculum_id WHERE v.id=$1 AND v.status IN ('published','superseded')", [i.id]);
    if (!v) throw notFound('Curriculum version');
    if (!(await isMine(user.id, v.curriculum_id))) throw notFound('Curriculum version');
    await one('INSERT INTO academy_curriculum_acks(curriculum_version_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id', [v.id, user.id]);
    await audit(null, user.id, 'acknowledge_academy_curriculum_version', 'academy_curriculum_versions', v.id);
    return { version_id: v.id, acknowledged: true };
  },
});

const FEEDBACK = ['too_easy', 'too_hard', 'too_long', 'unclear', 'missing_drill', 'suggestion', 'other'];
cap({
  name: 'submit_academy_curriculum_feedback', method: 'POST', path: '/academy/curricula/:id/feedback', tag: TAG, status: 201,
  summary: 'A coach on a curriculum (or a Technical Director) raises structured feedback, optionally on one objective: too easy, too hard, too long, unclear, a drill missing, or a suggestion. It is kept against the version in force and resolved by the Technical Director when the next version is written.',
  input: z.object({ id, objective_key: slug.optional(), kind: z.enum(FEEDBACK), note: text(1000).min(2) }),
  async handler({ user }, i) {
    const cur = await one('SELECT * FROM academy_curricula WHERE id=$1', [i.id]);
    if (!cur) throw notFound('Curriculum');
    const { all } = await reader(user, cur.organisation_id).catch(() => { throw notFound('Curriculum'); });
    if (!all && !(await isMine(user.id, cur.id))) throw notFound('Curriculum');
    const ver = await versionInEffect(cur.id);
    if (i.objective_key && ver && !(await resolveObjectives(cur, ver)).some((o) => o.key === i.objective_key)) throw badRequest('That objective is not in the version in force');
    const r = await one('INSERT INTO academy_curriculum_feedback(curriculum_id, curriculum_version_id, objective_key, author_id, kind, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [cur.id, ver?.id ?? null, i.objective_key ?? null, user.id, i.kind, i.note]);
    await audit(null, user.id, 'submit_academy_curriculum_feedback', 'academy_curricula', cur.id);
    return r;
  },
});

cap({
  name: 'list_academy_curriculum_feedback', method: 'GET', path: '/organisations/:id/academy/curriculum-feedback', tag: TAG,
  summary: 'Feedback on curricula with its status. Technical Directors see all; a coach sees only their own.',
  input: z.object({ id, curriculum_id: id.optional(), status: z.enum(['open', 'accepted', 'declined', 'done']).optional() }),
  async handler({ user }, i) {
    const { all } = await reader(user, i.id);
    return many(
      `SELECT f.*, u.display_name AS author_name, k.title AS curriculum_title FROM academy_curriculum_feedback f JOIN academy_curricula k ON k.id=f.curriculum_id JOIN users u ON u.id=f.author_id
        WHERE k.organisation_id=$1 AND ($2::uuid IS NULL OR f.curriculum_id=$2) AND ($3::text IS NULL OR f.status=$3) AND ($4::boolean OR f.author_id=$5) ORDER BY (f.status='open') DESC, f.created_at DESC LIMIT 100`,
      [i.id, i.curriculum_id ?? null, i.status ?? null, all, user.id]);
  },
});

cap({
  name: 'resolve_academy_curriculum_feedback', method: 'POST', path: '/academy/curriculum-feedback/:id/resolve', tag: TAG,
  summary: 'Technical Director decision on feedback: accepted (will go into the next version), declined (with a reason the coach can read) or done (already in a published version). The author is told.',
  input: z.object({ id, status: z.enum(['accepted', 'declined', 'done']), note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const f = (await c.query('SELECT f.*, k.organisation_id, k.title FROM academy_curriculum_feedback f JOIN academy_curricula k ON k.id=f.curriculum_id WHERE f.id=$1 FOR UPDATE OF f', [i.id])).rows[0];
    if (!f) throw notFound('Feedback');
    await govern(user, f.organisation_id, { write: true, c });
    if (i.status === 'declined' && !i.note) throw badRequest('Say why it is declined');
    const r = (await c.query('UPDATE academy_curriculum_feedback SET status=$2, resolution_note=$3, resolved_by=$4, resolved_at=now() WHERE id=$1 RETURNING *', [f.id, i.status, i.note ?? null, user.id])).rows[0];
    await audit(c, user.id, 'resolve_academy_curriculum_feedback', 'academy_curriculum_feedback', f.id);
    if (f.author_id !== user.id) await notify(c, f.author_id, { kind: 'academy_curriculum_feedback', title: `Your feedback on ${f.title} was ${i.status}`, body: i.note ?? 'Open Academy › Curriculum.', data: { organisation_id: f.organisation_id, curriculum_id: f.curriculum_id }, dedupe_key: `curriculum-feedback:${f.id}:${i.status}` });
    return r;
  }),
});

cap({
  name: 'rollover_academy_curriculum', method: 'POST', path: '/academy/curricula/:id/rollover', tag: TAG, status: 201,
  summary: 'Carry a curriculum into a new season or campus (Technical Director / owner / admin): creates a new draft curriculum with the latest version\'s objectives and phases (dates moved by shift_days) for approval. Nothing is copied back or changed on the source; assignments are not copied.',
  input: z.object({ id, title: text(120).min(2), season_id: id.optional(), venue_id: id.optional(), stage_key: text(40).optional(), age_min: z.number().int().min(3).max(99).optional(), age_max: z.number().int().min(3).max(99).optional(), shift_days: z.number().int().min(-3650).max(3650).default(365) }),
  handler: ({ user }, i) => tx(async (c) => {
    const src = (await c.query('SELECT * FROM academy_curricula WHERE id=$1', [i.id])).rows[0];
    if (!src) throw notFound('Curriculum');
    await govern(user, src.organisation_id, { write: true, c });
    if (i.age_min != null && i.age_max != null && i.age_min > i.age_max) throw badRequest('Minimum age is above maximum age');
    if (i.season_id && !(await c.query('SELECT 1 FROM org_seasons WHERE id=$1 AND organisation_id=$2', [i.season_id, src.organisation_id])).rows.length) throw badRequest('That season is not in this academy');
    if (i.venue_id && !(await c.query('SELECT 1 FROM venues WHERE id=$1 AND organisation_id=$2', [i.venue_id, src.organisation_id])).rows.length) throw badRequest('That campus is not one of this academy\'s venues');
    const base = (await c.query("SELECT * FROM academy_curriculum_versions WHERE curriculum_id=$1 AND status <> 'rejected' ORDER BY version DESC LIMIT 1", [src.id])).rows[0];
    if (!base) throw conflict('There is no version to carry over');
    const m = (await c.query('SELECT * FROM academy_methodologies WHERE id=$1', [src.methodology_id])).rows[0];
    const shift = (d) => new Date(new Date(`${iso(d)}T00:00:00Z`).getTime() + i.shift_days * 864e5).toISOString().slice(0, 10);
    const cur = (await c.query(
      'INSERT INTO academy_curricula(organisation_id, methodology_id, parent_id, season_id, venue_id, pathway_id, level_key, stage_key, age_min, age_max, title, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [src.organisation_id, src.methodology_id, src.parent_id, i.season_id ?? src.season_id, i.venue_id ?? src.venue_id, src.pathway_id, src.level_key, i.stage_key ?? src.stage_key, i.age_min ?? src.age_min, i.age_max ?? src.age_max, i.title, user.id])).rows[0];
    const phases = (base.phases ?? []).map((p) => ({ ...p, starts_on: shift(p.starts_on), ends_on: shift(p.ends_on) }));
    const v = (await c.query('INSERT INTO academy_curriculum_versions(curriculum_id, version, methodology_version, objectives, phases, effective_from, note, created_by) VALUES ($1,1,$2,$3,$4,current_date,$5,$6) RETURNING *',
      [cur.id, m.current_version, JSON.stringify(base.objectives), JSON.stringify(phases), `Rolled over from ${src.title} v${base.version}`, user.id])).rows[0];
    await audit(c, user.id, 'rollover_academy_curriculum', 'academy_curricula', cur.id);
    return { curriculum: cur, version: v };
  }),
});

cap({
  name: 'get_academy_objective_plan', method: 'GET', path: '/organisations/:id/academy/cohorts/:cohort_id/objective-plan', tag: TAG,
  summary: 'Forward planner: for the next weeks of a group\'s sessions, which objectives to work on, suggested from the phase of the year, what that phase prioritises, how far each objective is from its sessions target and its priority. Each suggestion carries its reasons. Nothing is written; apply it with apply_academy_objective_plan. Technical Directors, or the group\'s coach.',
  input: z.object({ id, cohort_id: id, weeks: z.coerce.number().int().min(1).max(12).default(4), per_session: z.coerce.number().int().min(1).max(5).default(2) }),
  async handler({ user }, i) {
    const { all } = await reader(user, i.id);
    const k = await one('SELECT * FROM org_cohorts WHERE id=$1 AND organisation_id=$2', [i.cohort_id, i.id]);
    if (!k) throw notFound('Group');
    if (!all && k.coach_id !== user.id && !(await one("SELECT 1 FROM academy_curriculum_assignments WHERE cohort_id=$1 AND coach_id=$2 AND status='active'", [k.id, user.id]))) throw notFound('Group');
    return { cohort: { id: k.id, name: k.name }, weeks: i.weeks, sessions: await planCohort(k.id, { weeks: i.weeks, perSession: i.per_session }) };
  },
});

cap({
  name: 'apply_academy_objective_plan', method: 'POST', path: '/organisations/:id/academy/cohorts/:cohort_id/objective-plan', tag: TAG, status: 201,
  summary: 'Apply a forward plan: maps the chosen objectives onto the listed sessions of the group, all or nothing. Each session goes through the same checks and frozen snapshot as mapping one session by hand.',
  input: z.object({ id, cohort_id: id, items: z.array(z.object({ session_id: id, keys: z.array(slug).min(1).max(10) })).min(1).max(60) }),
  handler: ({ user }, i) => tx(async (c) => {
    const k = (await c.query('SELECT * FROM org_cohorts WHERE id=$1 AND organisation_id=$2', [i.cohort_id, i.id])).rows[0];
    if (!k) throw notFound('Group');
    const out = [];
    for (const it of i.items) {
      const s = (await c.query('SELECT cohort_id FROM academy_sessions WHERE id=$1', [it.session_id])).rows[0];
      if (!s || s.cohort_id !== k.id) throw badRequest('A session in the plan does not belong to this group');
      out.push({ session_id: it.session_id, objectives: (await mapObjectives(user, it.session_id, { add_keys: it.keys }, c)).length });
    }
    return { applied: out.length, sessions: out };
  }),
});

cap({
  name: 'export_academy_curriculum_coverage', method: 'GET', path: '/organisations/:id/academy/curriculum-coverage/export', tag: TAG,
  summary: 'Coverage as a CSV for the board pack: one row per group and objective with pillar, priority, mastery target, delivered / target, deviations and the completion evidence. Audited. Technical Directors see all groups; a coach sees their own.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { all } = await reader(user, i.id);
    const rows = await many(
      `SELECT x.*, k.name AS cohort_name FROM academy_curriculum_assignments x JOIN academy_curricula cu ON cu.id=x.curriculum_id JOIN org_cohorts k ON k.id=x.cohort_id
        WHERE cu.organisation_id=$1 AND x.status='active' AND ($2::boolean OR x.coach_id=$3 OR k.coach_id=$3) ORDER BY k.name, x.id`, [i.id, all, user.id]);
    const lines = [['group', 'curriculum', 'version', 'pillar', 'objective', 'priority', 'mastery_target', 'state', 'delivered', 'sessions_target', 'partly', 'not_delivered', 'blocks_done', 'blocks_planned', 'success_criteria']];
    for (const a of rows) {
      const x = await assignmentCoverage(a);
      for (const o of x.objectives) lines.push([a.cohort_name, x.curriculum_title, x.version, o.pillar, o.title, o.priority, o.mastery_target, o.state, o.delivered, o.sessions_target, o.partly, o.not_delivered, o.evidence.blocks_done, o.evidence.blocks_planned, o.success_criteria]);
    }
    await audit(null, user.id, 'export_academy_curriculum_coverage', 'organisations', i.id);
    return { filename: `curriculum-coverage-${today()}.csv`, csv: toCsv(lines) };
  },
});
