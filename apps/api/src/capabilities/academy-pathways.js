// Academy OS 3/3: development pathways, assessments and human progression decisions. A pathway is configuration (versioned, append-only);
// an assessment references evidence that stays in its own domain; a decision is always a person's, never a model's and never driven by payment.
// Moving a programme/cohort, joining a squad or issuing a certificate is done through the canonical capability (the response says which).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { requireGuardian, isYouth, hasConsent } from '../youth.js';
import { STAFF } from '../academy.js';
import { collectEvidence, checkCriteria, levelOf, attendanceEvidence, reviewQueue } from '../academy-outcomes.js';

const ROLES = ['owner', 'admin', 'coach'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const levelSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,40}$/), title: z.string().min(1).max(80), position: z.number().int().min(1).max(50),
  age_min: z.number().int().min(3).max(99).optional(), age_max: z.number().int().min(3).max(99).optional(),
  prerequisites: z.array(z.string()).max(10).default([]), programme_ids: z.array(id).max(20).default([]),
  min_attendance_pct: z.number().min(0).max(100).optional(),
  criteria: z.array(z.object({ rubric_id: id, dimension_key: z.string().min(1).max(60), min_avg_score: z.number().min(0).max(100), min_observations: z.number().int().min(1).max(50).default(1) })).max(20).default([]),
  destinations: z.array(z.object({ kind: z.enum(['next_level', 'squad', 'elite_programme', 'graduation', 'external']), label: z.string().min(1).max(120) })).max(10).default([]),
});

/** Is this athlete one this staff member may work with? Owner/admin: anyone who applied or enrolled here. Coach: only their own groups. */
async function inScope(user, role, orgId, athleteId, c) {
  const db = c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) };
  const q = STAFF.includes(role)
    ? 'SELECT 1 FROM academy_applications WHERE organisation_id=$1 AND athlete_id=$2 UNION SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 LIMIT 1'
    : "SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused') LIMIT 1";
  const r = await db.query(q, STAFF.includes(role) ? [orgId, athleteId] : [orgId, athleteId, user.id]);
  if (!r.rows.length) throw notFound('Athlete');
}
const pathwayFor = async (pid, c) => {
  const db = c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) };
  const p = (await db.query('SELECT * FROM academy_pathways WHERE id=$1', [pid])).rows[0];
  if (!p) throw notFound('Pathway');
  return p;
};
const versionOf = async (p) => (p.current_version ? one('SELECT * FROM academy_pathway_versions WHERE pathway_id=$1 AND version=$2', [p.id, p.current_version]) : null);
const sorted = (v) => [...(v?.levels ?? [])].sort((a, b) => a.position - b.position);

/** Where the athlete stands on a pathway: the latest decision, the level definition from the version it was taken under, and the next level in the current version. */
async function standing(p, athleteId) {
  const last = await one('SELECT * FROM academy_progression_decisions WHERE pathway_id=$1 AND athlete_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1', [p.id, athleteId]);
  const cur = await versionOf(p);
  const lvls = sorted(cur);
  const level = last?.to_level ?? last?.from_level ?? null;
  const idx = level ? lvls.findIndex((l) => l.key === level) : -1;
  return { last, version: cur, level: level ? levelOf(cur, level) : null, level_key: last?.decision === 'graduate' ? null : level, graduated: last?.decision === 'graduate', paused: last?.decision === 'pause', next: idx >= 0 ? lvls[idx + 1] ?? null : null };
}

cap({
  name: 'create_academy_pathway', method: 'POST', path: '/organisations/:id/academy/pathways', tag: 'Academy', status: 201,
  summary: 'Start a development pathway for this academy (owner/admin): a named stream such as foundation to elite, a belt/grade structure or a goalkeeper stream. Levels are added by publishing a version.',
  input: z.object({ id, title: z.string().min(2).max(120), sport: z.string().min(2).max(40).optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF, { write: true });
    const r = await one('INSERT INTO academy_pathways(organisation_id, sport, title, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, i.sport ?? null, i.title, user.id]);
    await audit(null, user.id, 'create_academy_pathway', 'academy_pathways', r.id);
    return r;
  },
});

cap({
  name: 'publish_academy_pathway_version', method: 'POST', path: '/academy/pathways/:id/versions', tag: 'Academy', status: 201,
  summary: 'Publish a new version of a pathway (owner/admin): the levels, age guidance, prerequisites, expected programmes, attendance conditions, rubric-based evidence expectations and destinations. Versions are append-only; past decisions keep the version they were taken under. Send row_version from the last read.',
  input: z.object({ id, row_version: z.number().int().min(1), levels: z.array(levelSchema).min(1).max(30), effective_from: day.optional(), note: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM academy_pathways WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Pathway');
    await orgFor(user, p.organisation_id, STAFF, { write: true, c });
    if (p.row_version !== i.row_version) throw conflict('This pathway changed since you opened it. Reload and try again.', { code: 'stale_version' });
    const keys = new Set(i.levels.map((l) => l.key));
    if (keys.size !== i.levels.length) throw badRequest('Level keys must be unique');
    if (new Set(i.levels.map((l) => l.position)).size !== i.levels.length) throw badRequest('Level positions must be unique');
    for (const l of i.levels) {
      if (l.age_min != null && l.age_max != null && l.age_min > l.age_max) throw badRequest(`${l.title}: minimum age is above maximum age`);
      for (const pre of l.prerequisites) if (!keys.has(pre) || pre === l.key) throw badRequest(`${l.title}: prerequisite "${pre}" is not another level of this pathway`);
      for (const r of l.criteria) if (!(await c.query('SELECT 1 FROM coaching_rubrics WHERE id=$1', [r.rubric_id])).rows.length) throw badRequest(`${l.title}: that coaching rubric does not exist`);
      for (const pid of l.programme_ids) if (!(await c.query('SELECT 1 FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [pid, p.organisation_id])).rows.length) throw badRequest(`${l.title}: programme is not in this academy`);
    }
    const version = p.current_version + 1;
    const v = (await c.query('INSERT INTO academy_pathway_versions(pathway_id, version, levels, effective_from, note, created_by) VALUES ($1,$2,$3,coalesce($4::date, current_date),$5,$6) RETURNING *',
      [p.id, version, JSON.stringify(i.levels), i.effective_from ?? null, i.note ?? null, user.id])).rows[0];
    const np = (await c.query("UPDATE academy_pathways SET current_version=$2, status='active', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [p.id, version])).rows[0];
    await audit(c, user.id, 'publish_academy_pathway_version', 'academy_pathways', p.id);
    return { pathway: np, version: v };
  }),
});

cap({
  name: 'list_academy_pathways', method: 'GET', path: '/organisations/:id/academy/pathways', tag: 'Academy',
  summary: 'The academy\'s pathways with their current version and how many athletes stand at each level (owner/admin/coach). Counts only; no athlete data.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ROLES);
    const rows = await many('SELECT * FROM academy_pathways WHERE organisation_id=$1 AND status <> \'archived\' ORDER BY title, id', [i.id]);
    const out = [];
    for (const p of rows) {
      const v = await versionOf(p);
      const dist = await many(
        `SELECT coalesce(d.to_level, d.from_level) AS level, d.decision, count(*)::int AS n FROM (
           SELECT DISTINCT ON (athlete_id) * FROM academy_progression_decisions WHERE pathway_id=$1 ORDER BY athlete_id, created_at DESC, id DESC) d GROUP BY 1, 2`, [p.id]);
      out.push({ ...p, levels: sorted(v), distribution: dist.map((d) => ({ level: d.decision === 'graduate' ? 'graduated' : d.level, n: d.n })) });
    }
    return out;
  },
});

cap({
  name: 'get_academy_pathway', method: 'GET', path: '/academy/pathways/:id', tag: 'Academy',
  summary: 'One pathway with every published version (owner/admin/coach).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await pathwayFor(i.id);
    await orgFor(user, p.organisation_id, ROLES);
    return { pathway: p, versions: await many('SELECT * FROM academy_pathway_versions WHERE pathway_id=$1 ORDER BY version DESC', [p.id]) };
  },
});

cap({
  name: 'get_academy_athlete_progress', method: 'GET', path: '/academy/pathways/:id/athletes/:athlete_id', tag: 'Academy',
  summary: 'Where one athlete stands on a pathway (owner/admin; a coach for athletes in their own groups): current level, the evidence against the next level\'s criteria with source, unit, window and origin of every figure, and the decision history. Nothing is combined into a single score.',
  input: z.object({ id, athlete_id: id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const p = await pathwayFor(i.id);
    const { role } = await orgFor(user, p.organisation_id, ROLES);
    await inScope(user, role, p.organisation_id, i.athlete_id);
    const st = await standing(p, i.athlete_id);
    const from = i.from ?? daysAgo(90), to = i.to ?? today();
    const evidence = await collectEvidence(p.organisation_id, i.athlete_id, from, to);
    const target = st.next ?? (st.level_key ? null : sorted(st.version)[0] ?? null);
    const history = await many(
      `SELECT d.*, u.display_name AS decided_by_name, v.version AS pathway_version FROM academy_progression_decisions d JOIN users u ON u.id=d.decided_by JOIN academy_pathway_versions v ON v.id=d.version_id
        WHERE d.pathway_id=$1 AND d.athlete_id=$2 ORDER BY d.created_at DESC, d.id DESC`, [p.id, i.athlete_id]);
    const assessments = await many('SELECT id, level_key, period_from, period_to, outcome, status, assessor_id, reviewed_at, created_at FROM academy_assessments WHERE pathway_id=$1 AND athlete_id=$2 ORDER BY created_at DESC, id DESC LIMIT 20', [p.id, i.athlete_id]);
    await audit(null, user.id, 'read_academy_progress', 'users', i.athlete_id);
    return { pathway: { id: p.id, title: p.title, version: p.current_version }, level: st.level_key, graduated: st.graduated, paused: st.paused, evaluating: target?.key ?? null,
      criteria: target ? checkCriteria(target, evidence) : null, evidence, history, assessments, window: { from, to } };
  },
});

cap({
  name: 'record_academy_assessment', method: 'POST', path: '/academy/pathways/:id/assessments', tag: 'Academy', status: 201,
  summary: 'Record an assessment of one athlete against a pathway level (owner/admin/coach for their own athletes). The server snapshots references to the evidence it can see for the period (shared rubric observations, academy attendance, official results) and checks the criteria; the assessor adds a comment. It reuses coaching rubrics and creates no score of its own.',
  input: z.object({ id, athlete_id: id, level_key: z.string().min(1).max(40), period_from: day, period_to: day, comment: z.string().max(2000).optional(), comment_visibility: z.enum(['staff', 'athlete']).default('staff'), submit: z.boolean().default(true) }),
  async handler({ user }, i) {
    const p = await pathwayFor(i.id);
    const { role } = await orgFor(user, p.organisation_id, ROLES, { write: true });
    await inScope(user, role, p.organisation_id, i.athlete_id);
    if (i.period_from > i.period_to) throw badRequest('The period must start before it ends');
    const v = await versionOf(p);
    const level = levelOf(v, i.level_key);
    if (!level) throw badRequest('That level is not in the current version of this pathway');
    const evidence = await collectEvidence(p.organisation_id, i.athlete_id, i.period_from, i.period_to);
    const crit = checkCriteria(level, evidence);
    const row = await one(
      `INSERT INTO academy_assessments(organisation_id, athlete_id, pathway_id, version_id, level_key, period_from, period_to, assessor_id, evidence, outcome, status, comment, comment_visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [p.organisation_id, i.athlete_id, p.id, v.id, i.level_key, i.period_from, i.period_to, user.id, JSON.stringify({ ...evidence, criteria: crit.checks }), crit.outcome, i.submit ? 'submitted' : 'draft', i.comment ?? null, i.comment_visibility]);
    await audit(null, user.id, 'record_academy_assessment', 'academy_assessments', row.id);
    return row;
  },
});

cap({
  name: 'review_academy_assessment', method: 'POST', path: '/academy/assessments/:id/review', tag: 'Academy',
  summary: 'Approve a submitted assessment, or send it for reassessment (owner/admin). Send row_version from the last read. An appealed assessment is resolved the same way.',
  input: z.object({ id, row_version: z.number().int().min(1), action: z.enum(['approve', 'reassess']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const a = await one('SELECT * FROM academy_assessments WHERE id=$1', [i.id]);
    if (!a) throw notFound('Assessment');
    await orgFor(user, a.organisation_id, STAFF, { write: true });
    if (!['submitted', 'appealed'].includes(a.status)) throw conflict('Only a submitted or appealed assessment can be reviewed');
    const r = await one("UPDATE academy_assessments SET status=$3, reviewed_by=$4, reviewed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *",
      [a.id, i.row_version, i.action === 'approve' ? 'approved' : 'reassessed', user.id]);
    if (!r) throw conflict('This assessment changed since you opened it. Reload and try again.', { code: 'stale_version' });
    await audit(null, user.id, `review_academy_assessment_${i.action}`, 'academy_assessments', a.id);
    return r;
  },
});

cap({
  name: 'appeal_academy_assessment', method: 'POST', path: '/academy/assessments/:id/appeal', tag: 'Academy',
  summary: 'The athlete, or a verified guardian of a young athlete, asks for an approved assessment to be looked at again. The academy then approves or reassesses it.',
  input: z.object({ id, reason: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    const a = await one('SELECT * FROM academy_assessments WHERE id=$1', [i.id]);
    if (!a) throw notFound('Assessment');
    if (a.athlete_id !== user.id) await requireGuardian(user, a.athlete_id);
    if (a.status !== 'approved') throw conflict('Only an approved assessment can be appealed');
    const r = await one("UPDATE academy_assessments SET status='appealed', appeal_reason=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id, status", [a.id, i.reason]);
    await audit(null, user.id, 'appeal_academy_assessment', 'academy_assessments', a.id);
    return r;
  },
});

cap({
  name: 'list_academy_assessments', method: 'GET', path: '/organisations/:id/academy/assessments', tag: 'Academy',
  summary: 'Assessments for this academy (owner/admin; a coach sees their own athletes).',
  input: z.object({ id, athlete_id: id.optional(), status: z.enum(['draft', 'submitted', 'approved', 'appealed', 'reassessed']).optional(), ...page }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, ROLES);
    return many(
      `SELECT a.id, a.athlete_id, u.display_name AS athlete_name, a.pathway_id, p.title AS pathway, a.level_key, a.period_from, a.period_to, a.outcome, a.status, a.comment, a.comment_visibility, a.row_version, a.created_at, a.reviewed_at, au.display_name AS assessor_name
         FROM academy_assessments a JOIN users u ON u.id=a.athlete_id JOIN users au ON au.id=a.assessor_id JOIN academy_pathways p ON p.id=a.pathway_id
        WHERE a.organisation_id=$1 AND ($2::uuid IS NULL OR a.athlete_id=$2) AND ($3::text IS NULL OR a.status=$3)
          AND ($4 OR EXISTS (SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=a.athlete_id AND k.coach_id=$5))
        ORDER BY a.created_at DESC, a.id LIMIT $6 OFFSET $7`, [i.id, i.athlete_id ?? null, i.status ?? null, STAFF.includes(role), user.id, i.limit, i.offset]);
  },
});

const FOLLOW = {
  move_programme: { capability: 'transfer_academy_enrolment', note: 'Move the athlete with the enrolment transfer so billing and capacity stay correct.' },
  invite_squad: { capability: 'team workflow', note: 'Invite the athlete to the squad through the team invitation flow.' },
  graduate: { capability: 'passport', note: 'Issue any certificate or achievement through the athlete passport / awards flow.' },
};

cap({
  name: 'decide_academy_progression', method: 'POST', path: '/academy/pathways/:id/decisions', tag: 'Academy', status: 201,
  summary: 'Record a human progression decision for one athlete: place, remain, promote, move programme, invite to a squad, recommend reassessment, graduate or pause (owner/admin; a coach for their own athletes). The criteria are snapshotted with the decision; promoting past unmet criteria needs an explicit acknowledgement. It never reads payment status, and moving programme/squad/certificate is done through the canonical capability named in the response. Retrying with the same idempotency key returns the same decision.',
  input: z.object({
    id, athlete_id: id, decision: z.enum(['place', 'remain', 'promote', 'move_programme', 'invite_squad', 'reassess', 'graduate', 'pause']),
    to_level: z.string().min(1).max(40).optional(), expected_from_level: z.string().min(1).max(40).nullable().optional(), reason: z.string().min(3).max(1000),
    assessment_id: id.optional(), acknowledge_unmet_criteria: z.boolean().default(false), idempotency_key: z.string().min(8).max(80),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM academy_pathways WHERE id=$1', [i.id])).rows[0];
    if (!p) throw notFound('Pathway');
    const { role } = await orgFor(user, p.organisation_id, ROLES, { write: true, c });
    await inScope(user, role, p.organisation_id, i.athlete_id, c);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${p.id}:${i.athlete_id}`]);
    const prior = (await c.query('SELECT * FROM academy_progression_decisions WHERE decided_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
    if (prior) { if (prior.athlete_id !== i.athlete_id || prior.pathway_id !== p.id) throw conflict('That idempotency key was used for a different decision'); return { ...prior, replayed: true }; }
    if (!p.current_version) throw conflict('Publish a version of this pathway first');
    const v = (await c.query('SELECT * FROM academy_pathway_versions WHERE pathway_id=$1 AND version=$2', [p.id, p.current_version])).rows[0];
    const lvls = sorted(v);
    const last = (await c.query('SELECT * FROM academy_progression_decisions WHERE pathway_id=$1 AND athlete_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1', [p.id, i.athlete_id])).rows[0];
    const current = last && last.decision !== 'graduate' ? last.to_level ?? last.from_level : null;
    if ((i.expected_from_level ?? null) !== current) throw conflict('Someone else decided for this athlete first. Reload to see the current level.', { code: 'stale_level', current_level: current });
    if (i.assessment_id) {
      const a = (await c.query('SELECT organisation_id, athlete_id, pathway_id, status FROM academy_assessments WHERE id=$1', [i.assessment_id])).rows[0];
      if (!a || a.organisation_id !== p.organisation_id || a.athlete_id !== i.athlete_id || a.pathway_id !== p.id) throw badRequest('That assessment is not for this athlete and pathway');
    }
    let to = null;
    const idx = lvls.findIndex((l) => l.key === current);
    const curKeys = new Set(lvls.slice(0, Math.max(idx, 0) + 1).map((l) => l.key));
    if (i.decision === 'place') {
      if (current) throw conflict('This athlete is already placed on the pathway');
      to = i.to_level ?? lvls[0].key;
      if (!levelOf(v, to)) throw badRequest('That level is not in this pathway');
    } else {
      if (!current) throw conflict('Place the athlete on a level first');
      if (i.decision === 'promote') {
        const next = lvls[idx + 1];
        if (!next) throw badRequest('This is the last level; use graduate instead');
        if (i.to_level && i.to_level !== next.key) throw badRequest('Promotion moves to the next level only');
        to = next.key;
        for (const pre of next.prerequisites ?? []) if (!curKeys.has(pre)) throw badRequest(`Prerequisite level "${pre}" is not completed`);
      } else if (i.decision === 'graduate') {
        if (idx !== lvls.length - 1) throw badRequest('Only an athlete at the final level can graduate');
      } else to = current;
    }
    // criteria snapshot for the level the decision is about
    const target = i.decision === 'promote' ? levelOf(v, to) : levelOf(v, current ?? to);
    const evidence = await collectEvidence(p.organisation_id, i.athlete_id, daysAgo(90), today());
    const crit = target ? checkCriteria(target, evidence) : { checks: [], outcome: 'pending', missing: 0 };
    if (i.decision === 'promote' && crit.checks.length && crit.outcome !== 'criteria_met' && !i.acknowledge_unmet_criteria) {
      throw conflict('The configured criteria for the next level are not all met (or evidence is missing). Confirm you are promoting anyway.', { code: 'criteria_unmet', criteria: crit.checks });
    }
    const row = (await c.query(
      `INSERT INTO academy_progression_decisions(organisation_id, athlete_id, pathway_id, version_id, decision, from_level, to_level, reason, assessment_id, criteria_snapshot, decided_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [p.organisation_id, i.athlete_id, p.id, v.id, i.decision, current, to, i.reason, i.assessment_id ?? null, JSON.stringify({ outcome: crit.outcome, checks: crit.checks, window: { from: daysAgo(90), to: today() }, unmet_acknowledged: i.acknowledge_unmet_criteria }), user.id, i.idempotency_key])).rows[0];
    await audit(c, user.id, `academy_progression_${i.decision}`, 'academy_progression_decisions', row.id);
    return { ...row, follow_up: FOLLOW[i.decision] ?? null };
  }),
});

cap({
  name: 'list_academy_review_queue', method: 'GET', path: '/organisations/:id/academy/review-queue', tag: 'Academy',
  summary: 'Athletes who need a pathway look (owner/admin; a coach sees their own groups): not yet placed, no assessment in 90 days, or an approved assessment with no decision after it. Each row says why.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, ROLES);
    return (await reviewQueue(i.id, { coachId: STAFF.includes(role) ? null : user.id })).slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'get_my_academy_progress', method: 'GET', path: '/academy/my-progress', tag: 'Academy',
  summary: 'Progress for the signed-in athlete, or for a young athlete when their verified guardian asks: pathway level, approved assessments (comments only when the assessor made them visible to the athlete), decisions, attendance trend and the next review date. Coach-private notes never appear; a young person\'s coaching material needs the guardian\'s coaching consent.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id) { await requireGuardian(user, athleteId); await audit(null, user.id, 'read_child_academy_progress', 'users', athleteId); }
    const consent = await hasConsent(athleteId, 'coaching');
    const orgs = await many(
      `SELECT DISTINCT o.id, o.name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN organisations o ON o.id=k.organisation_id WHERE e.user_id=$1 AND e.programme_id IS NOT NULL ORDER BY o.name`, [athleteId]);
    const out = [];
    for (const o of orgs) {
      const pathways = await many("SELECT * FROM academy_pathways WHERE organisation_id=$1 AND status='active' ORDER BY title", [o.id]);
      const items = [];
      for (const p of pathways) {
        const st = await standing(p, athleteId);
        if (!st.last) continue;
        const decisions = await many('SELECT decision, from_level, to_level, reason, created_at FROM academy_progression_decisions WHERE pathway_id=$1 AND athlete_id=$2 ORDER BY created_at DESC, id DESC LIMIT 20', [p.id, athleteId]);
        const assessments = consent ? await many(
          `SELECT id, level_key, period_from, period_to, outcome, created_at, CASE WHEN comment_visibility='athlete' THEN comment END AS comment, evidence->'attendance' AS attendance
             FROM academy_assessments WHERE pathway_id=$1 AND athlete_id=$2 AND status IN ('approved','appealed') ORDER BY created_at DESC, id DESC LIMIT 10`, [p.id, athleteId]) : [];
        const lastA = assessments[0]?.created_at ?? decisions[0]?.created_at;
        items.push({ pathway_id: p.id, title: p.title, level: st.level_key, level_title: st.level?.title ?? null, graduated: st.graduated, next_level: st.next?.title ?? null,
          destinations: st.level?.destinations ?? [], decisions, assessments, next_review_on: lastA ? new Date(new Date(lastA).getTime() + 90 * 864e5).toISOString().slice(0, 10) : null });
      }
      const weeks = await many(
        `SELECT date_trunc('week', a.session_date)::date AS week, count(*) FILTER (WHERE a.status='present')::int AS present, count(*) FILTER (WHERE a.status='absent')::int AS absent
           FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id WHERE k.organisation_id=$1 AND a.user_id=$2 AND a.session_date >= current_date - 56 GROUP BY 1 ORDER BY 1`, [o.id, athleteId]);
      out.push({ organisation: o, pathways: items, attendance_weeks: weeks, attendance_pct_8w: (await attendanceEvidence(o.id, athleteId, daysAgo(56), today())).pct });
    }
    return { athlete_id: athleteId, is_youth: await isYouth(athleteId), coaching_consent: consent, academies: out };
  },
});

cap({
  name: 'list_academy_rubrics', method: 'GET', path: '/organisations/:id/academy/rubrics', tag: 'Academy',
  summary: 'The coaching rubrics (from Coach Performance Studio) that this academy\'s coaches use, with their dimensions (owner/admin/coach), so a pathway level can reference them. Read-only: rubrics are created and versioned in the coach\'s own workspace.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ROLES);
    return many(
      `SELECT r.id, r.name, r.sport_id, u.display_name AS coach_name, v.version, v.dimensions
         FROM coaching_rubrics r JOIN users u ON u.id=r.coach_id
         JOIN LATERAL (SELECT version, dimensions FROM coaching_rubric_versions WHERE rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true
        WHERE r.archived_at IS NULL AND (r.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$1 AND coach_id IS NOT NULL)
              OR r.coach_id IN (SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('coach','owner','admin')))
        ORDER BY r.name, r.id LIMIT 100`, [i.id]);
  },
});
