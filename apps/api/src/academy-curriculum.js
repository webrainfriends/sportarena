// Academy curriculum rules (#782). Reads only: the methodology/curriculum configuration, the canonical academy sessions and the coach's own coaching
// session record (plan blocks + block_log). There is no scoring or planning engine here; "coverage" is a count of objectives that coaches marked
// delivered, backed by the blocks they actually completed in the existing coaching tools.
import { pool } from './db.js';
import { notFound } from './errors.js';

export const PILLARS = ['technical', 'tactical', 'physical', 'mental', 'lifestyle'];
export const DEVIATIONS = ['weather', 'venue_unavailable', 'coach_absent', 'athlete_needs', 'low_attendance', 'safeguarding', 'time_overrun', 'schedule_change', 'other'];
export const BLOCK_KINDS = ['arrival', 'warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'match_play', 'conditioning', 'recovery', 'review', 'custom'];
const MAX_DEPTH = 4;
const q = (c) => c ?? pool;
/** A pg `date` arrives as a Date at local midnight, so read its local parts (toISOString would shift the day in zones east of UTC). */
export const iso = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
export const today = () => new Date().toISOString().slice(0, 10);

/** The published (or since superseded) version that applied on a date. Past dates keep resolving to the version that was then in force. */
export async function versionInEffect(curriculumId, asOf = today(), c) {
  return (await q(c).query(
    `SELECT * FROM academy_curriculum_versions WHERE curriculum_id=$1 AND status IN ('published','superseded') AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY version DESC LIMIT 1`, [curriculumId, asOf])).rows[0] ?? null;
}

export async function methodologyVersion(methodologyId, version, c) {
  return (await q(c).query('SELECT * FROM academy_methodology_versions WHERE methodology_id=$1 AND version=$2', [methodologyId, version])).rows[0] ?? null;
}

/**
 * The objectives a curriculum teaches on a date: the parent's (recursively, as in force that day) with this curriculum's own changes applied.
 * op "add" adds, "override" replaces an inherited objective with the same key, "exclude" removes it for this scope.
 */
export async function resolveObjectives(cur, ver, asOf = today(), c, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let map = new Map();
  if (cur.parent_id) {
    const parent = (await q(c).query('SELECT * FROM academy_curricula WHERE id=$1', [cur.parent_id])).rows[0];
    const pv = parent ? await versionInEffect(parent.id, asOf, c) : null;
    if (parent && pv) for (const o of await resolveObjectives(parent, pv, asOf, c, depth + 1)) map.set(o.key, { ...o, inherited_from: o.inherited_from ?? parent.id, inherited_title: o.inherited_title ?? parent.title });
  }
  for (const o of ver?.objectives ?? []) {
    if (o.op === 'exclude') map.delete(o.key);
    else map.set(o.key, { ...o, inherited_from: null, overrides_parent: o.op === 'override' });
  }
  return [...map.values()];
}

/** Resolved objectives decorated with their competency (pillar, title) from the methodology version the curriculum version was written against. */
export async function decorate(cur, ver, objectives, c) {
  const mv = ver ? await methodologyVersion(cur.methodology_id, ver.methodology_version, c) : null;
  const comp = new Map((mv?.competencies ?? []).map((x) => [x.key, x]));
  const drills = new Map((mv?.drills ?? []).map((x) => [x.key, x]));
  return objectives.map((o) => ({ ...o, pillar: comp.get(o.competency_key)?.pillar ?? null, competency_title: comp.get(o.competency_key)?.title ?? o.competency_key, drills: (o.drill_keys ?? []).map((k) => drills.get(k)).filter(Boolean) }));
}

/** Everything the coach's coaching record says about which tagged blocks were planned and done, per objective key. */
export async function sessionEvidence(sessionId, c) {
  const recs = (await q(c).query(
    `SELECT r.id, r.coach_id, r.status, r.block_log, v.blocks FROM coaching_session_records r
       LEFT JOIN coaching_session_plan_versions v ON v.session_record_id=r.id AND v.version=r.plan_version
      WHERE r.source_type='academy_session' AND r.source_id=$1`, [String(sessionId)])).rows;
  const out = new Map();
  for (const r of recs) for (const b of r.blocks ?? []) for (const t of b.tags ?? []) {
    if (!t.startsWith('obj:')) continue;
    const k = t.slice(4), e = out.get(k) ?? { blocks_planned: 0, blocks_done: 0, records: [] };
    e.blocks_planned++;
    if (['completed', 'modified'].includes(r.block_log?.[b.id]?.status)) e.blocks_done++;
    if (!e.records.some((x) => x.id === r.id)) e.records.push({ id: r.id, coach_id: r.coach_id, status: r.status });
    out.set(k, e);
  }
  return out;
}

/** The session and the cohort assignment(s) objectives can be mapped from. */
export async function sessionContext(sessionId, c) {
  const s = (await q(c).query(
    `SELECT s.*, (s.starts_at AT TIME ZONE s.timezone)::date AS local_date FROM academy_sessions s WHERE s.id=$1`, [sessionId])).rows[0];
  if (!s) throw notFound('Session');
  return { ...s, local_date: iso(s.local_date) };
}

export async function assignmentsForCohort(cohortId, asOf, c) {
  return (await q(c).query(
    `SELECT a.*, cu.title AS curriculum_title, cu.status AS curriculum_status FROM academy_curriculum_assignments a JOIN academy_curricula cu ON cu.id=a.curriculum_id
      WHERE a.cohort_id=$1 AND a.status='active' AND a.effective_from <= $2::date ORDER BY a.created_at, a.id`, [cohortId, asOf])).rows;
}

/**
 * Coverage of one assignment: per objective of the version in force today, how many mapped sessions delivered it, partly, or not at all, plus the
 * deviations and the sessions that had no objective at all. An objective is "complete" once delivered at least sessions_target times.
 */
export async function assignmentCoverage(a, c) {
  const cur = (await q(c).query('SELECT * FROM academy_curricula WHERE id=$1', [a.curriculum_id])).rows[0];
  const ver = await versionInEffect(cur.id, today(), c);
  const objectives = ver ? await decorate(cur, ver, await resolveObjectives(cur, ver, today(), c), c) : [];
  const rows = (await q(c).query(
    `SELECT o.objective_key, o.status, o.deviation_reason, o.session_id, o.evidence FROM academy_session_objectives o JOIN academy_sessions s ON s.id=o.session_id
      WHERE o.curriculum_id=$1 AND s.cohort_id=$2 AND o.status <> 'removed'`, [cur.id, a.cohort_id])).rows;
  const per = objectives.map((o) => {
    const mine = rows.filter((r) => r.objective_key === o.key);
    const delivered = mine.filter((r) => r.status === 'delivered').length;
    const evidence = mine.reduce((t, r) => ({ blocks_planned: t.blocks_planned + (r.evidence?.blocks_planned ?? 0), blocks_done: t.blocks_done + (r.evidence?.blocks_done ?? 0) }), { blocks_planned: 0, blocks_done: 0 });
    const target = o.sessions_target ?? 1;
    const state = delivered >= target ? 'complete' : delivered > 0 || mine.some((r) => r.status === 'partly') ? 'in_progress' : mine.length ? 'planned' : 'not_planned';
    return { key: o.key, title: o.title, pillar: o.pillar, priority: o.priority ?? 'core', mastery_target: o.mastery_target ?? null, success_criteria: o.success_criteria ?? null, rpe_target: o.rpe_target ?? null, competency_key: o.competency_key, sessions_target: target, mapped: mine.length, delivered, partly: mine.filter((r) => r.status === 'partly').length,
      not_delivered: mine.filter((r) => r.status === 'not_delivered').length, state, evidence, inherited: !!o.inherited_from };
  });
  const dev = {};
  for (const r of rows) if (['partly', 'not_delivered'].includes(r.status) && r.deviation_reason) dev[r.deviation_reason] = (dev[r.deviation_reason] ?? 0) + 1;
  const sess = (await q(c).query(
    `SELECT count(*)::int AS held, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM academy_session_objectives x WHERE x.session_id=s.id AND x.status <> 'removed'))::int AS with_objective
       FROM academy_sessions s WHERE s.cohort_id=$1 AND s.status IN ('published','completed') AND s.starts_at <= now() AND s.starts_at >= $2::date AND s.delivery_type IN ('training','workshop','camp','classroom','match_prep','makeup')`, [a.cohort_id, a.effective_from])).rows[0];
  const complete = per.filter((p) => p.state === 'complete').length;
  const by_pillar = PILLARS.map((pl) => { const x = per.filter((o) => (o.pillar ?? 'technical') === pl); return { pillar: pl, objectives: x.length, complete: x.filter((o) => o.state === 'complete').length, in_progress: x.filter((o) => o.state === 'in_progress').length, delivered: x.reduce((t, o) => t + o.delivered, 0), target: x.reduce((t, o) => t + o.sessions_target, 0) }; }).filter((x) => x.objectives);
  return {
    by_pillar,
    assignment_id: a.id, curriculum_id: cur.id, curriculum_title: cur.title, cohort_id: a.cohort_id, coach_id: a.coach_id, version: ver?.version ?? null, effective_from: ver ? iso(ver.effective_from) : null,
    objectives: per, totals: { objectives: per.length, complete, in_progress: per.filter((p) => p.state === 'in_progress').length, planned: per.filter((p) => p.state === 'planned').length, not_planned: per.filter((p) => p.state === 'not_planned').length,
      coverage_pct: per.length ? Math.round((complete / per.length) * 100) : null, sessions_held: sess.held, sessions_with_objective: sess.with_objective, sessions_without_objective: sess.held - sess.with_objective },
    deviations: Object.entries(dev).map(([reason, n]) => ({ reason, n })).sort((x, y) => y.n - x.n),
  };
}

// ---------------------------------------------------------------------------------------------- elite governance helpers
export const PRIORITIES = ['core', 'support', 'stretch'];
export const MASTERY = ['introduce', 'develop', 'consolidate', 'master'];
export const GAME_PHASES = ['in_possession', 'out_of_possession', 'transition_to_attack', 'transition_to_defence', 'set_play', 'general'];
export const INTENSITIES = ['low', 'medium', 'high', 'peak'];

/**
 * Is this version fit to go to the Technical Director? Blockers stop submission; warnings are shown with the request so the approver sees them.
 * Checked against the objectives as they will be in force (own entries plus inherited ones).
 */
export function readiness(ver, resolved, mv) {
  const blockers = [], warnings = [], passed = [];
  const own = (ver.objectives ?? []).filter((o) => o.op !== 'exclude');
  const phases = ver.phases ?? [];
  const add = (list, code, message, ref) => list.push({ code, message, ...(ref ? { ref } : {}) });
  if (!own.length && !resolved.length) add(blockers, 'no_objectives', 'The version has no objectives');
  else add(passed, 'objectives', `${resolved.length} objectives in force`);
  const noCrit = own.filter((o) => !o.success_criteria?.trim());
  if (noCrit.length) for (const o of noCrit) add(blockers, 'no_success_criteria', `"${o.title}" has no measurable success criteria`, o.key);
  else if (own.length) add(passed, 'success_criteria', 'Every objective states how success is judged');
  const pk = new Set(phases.map((p) => p.key));
  for (const o of own) for (const k of o.phase_keys ?? []) if (!pk.has(k)) add(blockers, 'unknown_phase', `"${o.title}" runs in a phase that is not in the periodisation`, o.key);
  const sorted = [...phases].sort((a, b) => String(a.starts_on).localeCompare(String(b.starts_on)));
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (p.starts_on > p.ends_on) add(blockers, 'phase_dates', `Phase "${p.title}" ends before it starts`, p.key);
    if (i && sorted[i - 1].ends_on >= p.starts_on) add(blockers, 'phase_overlap', `Phases "${sorted[i - 1].title}" and "${p.title}" overlap`, p.key);
  }
  if (!phases.length) add(warnings, 'no_periodisation', 'No periodisation: the year is not planned in phases');
  else add(passed, 'periodisation', `${phases.length} phases planned`);
  const pillars = new Set((mv?.competencies ?? []).map((c) => c.pillar));
  const have = new Set(resolved.map((o) => o.pillar));
  for (const p of pillars) if (!have.has(p)) add(warnings, 'pillar_missing', `No objective for the ${p} pillar`, p);
  if ([...pillars].every((p) => have.has(p))) add(passed, 'pillar_balance', 'Every pillar of the methodology is covered');
  const noDrill = own.filter((o) => !(o.drill_keys ?? []).length);
  for (const o of noDrill) add(warnings, 'no_drills', `"${o.title}" has no approved drill, so coaches start from a blank plan`, o.key);
  const noFam = own.filter((o) => !o.guardian_summary?.trim());
  for (const o of noFam) add(warnings, 'no_family_line', `"${o.title}" has no line for families`, o.key);
  const cov = new Set(resolved.map((o) => o.competency_key));
  const idle = (mv?.competencies ?? []).filter((c) => !cov.has(c.key));
  if (idle.length) add(warnings, 'competency_uncovered', `${idle.length} methodology competencies have no objective: ${idle.slice(0, 4).map((c) => c.title).join(', ')}${idle.length > 4 ? '…' : ''}`);
  const core = resolved.filter((o) => (o.priority ?? 'core') === 'core').length;
  if (resolved.length >= 4 && core / resolved.length < 0.4) add(warnings, 'few_core', 'Fewer than 40% of objectives are marked core');
  return { ready: !blockers.length, blockers, warnings, passed };
}

const CMP = ['title', 'competency_key', 'priority', 'mastery_target', 'success_criteria', 'rpe_target', 'sessions_target', 'guardian_summary', 'description'];
/** What changed between two versions: objectives added, removed or edited (field by field) and the phase count, plus who is affected. */
export function diffVersions(prev, next) {
  const a = new Map((prev?.objectives ?? []).map((o) => [o.key, o])), b = new Map((next.objectives ?? []).map((o) => [o.key, o]));
  const added = [...b.values()].filter((o) => !a.has(o.key)).map((o) => ({ key: o.key, title: o.title }));
  const removed = [...a.values()].filter((o) => !b.has(o.key)).map((o) => ({ key: o.key, title: o.title }));
  const changed = [];
  for (const [k, o] of b) {
    const old = a.get(k);
    if (!old) continue;
    const fields = CMP.filter((f) => JSON.stringify(old[f] ?? null) !== JSON.stringify(o[f] ?? null));
    if (JSON.stringify(old.drill_keys ?? []) !== JSON.stringify(o.drill_keys ?? [])) fields.push('drill_keys');
    if (fields.length) changed.push({ key: k, title: o.title, fields, before: Object.fromEntries(fields.map((f) => [f, old[f] ?? null])), after: Object.fromEntries(fields.map((f) => [f, o[f] ?? null])) });
  }
  return { added, removed, changed, phases: { before: (prev?.phases ?? []).length, after: (next.phases ?? []).length }, unchanged: [...b.keys()].filter((k) => a.has(k)).length - changed.length };
}

/** Delivery analytics for the cohorts that follow a set of assignments: monthly trend, per coach compliance and drill usage. */
export async function deliveryAnalytics(assignments, c) {
  if (!assignments.length) return { trend: [], coaches: [], drills: [] };
  const cohortIds = [...new Set(assignments.map((a) => a.cohort_id))], curIds = [...new Set(assignments.map((a) => a.curriculum_id))];
  const trend = (await q(c).query(
    `SELECT to_char(date_trunc('month', s.starts_at), 'YYYY-MM') AS month, count(*) FILTER (WHERE o.status='delivered')::int AS delivered, count(*) FILTER (WHERE o.status IN ('partly','not_delivered'))::int AS deviated, count(*)::int AS mapped
       FROM academy_session_objectives o JOIN academy_sessions s ON s.id=o.session_id WHERE s.cohort_id = ANY($1) AND o.curriculum_id = ANY($2) AND o.status <> 'removed' AND s.starts_at >= date_trunc('month', now()) - interval '5 months'
      GROUP BY 1 ORDER BY 1`, [cohortIds, curIds])).rows;
  const coaches = (await q(c).query(
    `SELECT u.id AS coach_id, u.display_name AS coach_name, count(DISTINCT s.id)::int AS sessions, count(DISTINCT s.id) FILTER (WHERE EXISTS (SELECT 1 FROM academy_session_objectives x WHERE x.session_id=s.id AND x.status <> 'removed'))::int AS with_objective,
            count(*) FILTER (WHERE o.status IN ('delivered','partly','not_delivered'))::int AS recorded, count(*) FILTER (WHERE o.status <> 'removed')::int AS mapped, count(*) FILTER (WHERE (o.evidence->>'attested')::boolean)::int AS attested
       FROM academy_sessions s JOIN academy_session_staff st ON st.session_id=s.id AND st.role='lead' AND st.status IN ('assigned','confirmed') JOIN users u ON u.id=st.user_id LEFT JOIN academy_session_objectives o ON o.session_id=s.id
      WHERE s.cohort_id = ANY($1) AND s.status IN ('published','completed') AND s.starts_at <= now() AND s.starts_at >= now() - interval '90 days' GROUP BY u.id, u.display_name ORDER BY u.display_name`, [cohortIds])).rows;
  const drills = (await q(c).query(
    `SELECT d->>'key' AS key, d->>'title' AS title, count(*)::int AS n FROM academy_session_objectives o JOIN academy_sessions s ON s.id=o.session_id, jsonb_array_elements(o.snapshot->'drills') d
      WHERE s.cohort_id = ANY($1) AND o.status <> 'removed' GROUP BY 1, 2 ORDER BY n DESC, 2 LIMIT 6`, [cohortIds])).rows;
  return { trend, coaches, drills };
}

/**
 * Suggest objectives for the next sessions of a cohort. Per session: the phase of the year it falls in, which objectives that phase prioritises,
 * how far each objective is from its sessions target (delivered + already planned), and its priority. A suggestion carries the reasons, so a
 * Technical Director can see why; nothing is written until a person applies it.
 */
export async function planCohort(cohortId, { weeks = 4, perSession = 2 } = {}, c) {
  const sessions = (await q(c).query(
    `SELECT s.id, s.title, s.starts_at, s.status, (s.starts_at AT TIME ZONE s.timezone)::date AS local_date FROM academy_sessions s
      WHERE s.cohort_id=$1 AND s.status IN ('draft','published') AND s.starts_at > now() AND s.starts_at < now() + ($2 || ' weeks')::interval AND s.delivery_type IN ('training','workshop','camp','classroom','match_prep','makeup') ORDER BY s.starts_at`, [cohortId, String(weeks)])).rows;
  const assigns = await assignmentsForCohort(cohortId, today(), c);
  const out = [];
  const used = new Map();   // assignment|key -> planned/delivered count, updated as the plan is simulated
  for (const a of assigns) {
    const rows = (await q(c).query("SELECT o.objective_key, count(*)::int AS n FROM academy_session_objectives o JOIN academy_sessions s ON s.id=o.session_id WHERE o.curriculum_id=$1 AND s.cohort_id=$2 AND o.status IN ('planned','delivered') GROUP BY 1", [a.curriculum_id, cohortId])).rows;
    for (const r of rows) used.set(`${a.id}|${r.objective_key}`, r.n);
  }
  for (const s of sessions) {
    const date = iso(s.local_date);
    const mapped = (await q(c).query("SELECT objective_key FROM academy_session_objectives WHERE session_id=$1 AND status <> 'removed'", [s.id])).rows.map((r) => r.objective_key);
    const picks = [];
    for (const a of assigns) {
      const cur = (await q(c).query('SELECT * FROM academy_curricula WHERE id=$1', [a.curriculum_id])).rows[0];
      const ver = await versionInEffect(cur.id, date, c);
      if (!ver) continue;
      const phase = (ver.phases ?? []).find((p) => iso(p.starts_on) <= date && iso(p.ends_on) >= date) ?? null;
      for (const o of await decorate(cur, ver, await resolveObjectives(cur, ver, date, c), c)) {
        if (mapped.includes(o.key)) continue;
        if (o.phase_keys?.length && (!phase || !o.phase_keys.includes(phase.key))) continue;
        const done = used.get(`${a.id}|${o.key}`) ?? 0, remaining = (o.sessions_target ?? 1) - done;
        if (remaining <= 0) continue;
        const reasons = [];
        let score = { core: 3, support: 2, stretch: 1 }[o.priority ?? 'core'];
        if (phase && (o.phase_keys ?? []).includes(phase.key)) { score += 3; reasons.push('phase_objective'); }
        if (phase && (phase.focus_keys ?? []).includes(o.competency_key)) { score += 2; reasons.push('phase_focus'); }
        if (remaining >= 2) { score += 1; reasons.push('behind_target'); }
        if ((o.priority ?? 'core') === 'core') reasons.push('core');
        picks.push({ score, assignment_id: a.id, key: o.key, title: o.title, pillar: o.pillar, priority: o.priority ?? 'core', remaining, reasons, competency_title: o.competency_title, mastery_target: o.mastery_target ?? null });
      }
      if (phase) picks.phase = { key: phase.key, title: phase.title, intensity: phase.intensity };
    }
    picks.sort((x, y) => y.score - x.score || x.key.localeCompare(y.key));
    const chosen = [], pillars = new Set();
    for (const p of picks) { if (chosen.length >= perSession) break; if (pillars.has(p.pillar) && picks.some((z) => !pillars.has(z.pillar) && !chosen.includes(z) && z.score >= p.score - 1)) continue; chosen.push(p); pillars.add(p.pillar); }
    for (const p of chosen) used.set(`${p.assignment_id}|${p.key}`, (used.get(`${p.assignment_id}|${p.key}`) ?? 0) + 1);
    out.push({ session_id: s.id, title: s.title, starts_at: s.starts_at, status: s.status, local_date: date, phase: picks.phase ?? null, already: mapped, suggestions: chosen.map(({ score, ...r }) => r) });
  }
  return out;
}

const csvCell = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');
