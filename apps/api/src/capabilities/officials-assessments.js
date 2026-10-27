// Officials Development & Assessment (#486) 2/4: formal assessment reports with immutable versions, publication policy, acknowledgement, review/appeal,
// and an AI drafting aid that can never grade or decide. A formal assessment is a private development record: it is separate from public feedback (#215),
// never edits a fixture result, and a negative one is never silently deleted (corrections add a version; a void is explicit, reasoned and visible).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { askJson, aiConfigured, quoteData, AI_RULES } from '../ai.js';
import { bodyById, today, plain, isGuardianOf } from '../federation.js';
import { staffRecipients } from '../federation-subjects.js';
import { RECOMMENDATIONS, devStaff, currentGrade, logOff, historyOf, seal, unseal, sealText, unsealText, CTX, narrativeSchema, scoreSchema, validateScores } from '../officials-development.js';
import { settingsOf, appointmentFor, observationRow } from './officials-assessors.js';

const TAG = 'Officials development';
const text = (n) => z.string().trim().max(n);
const refOf = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex').slice(0, 16);

const contentIn = { scores: z.array(scoreSchema).max(40), narrative: narrativeSchema.default({}), recommendation: z.enum(RECOMMENDATIONS).optional() };

// ------------------------------------------------------------------ views
const HEAD_COLS = `a.id, a.observation_id, a.body_id, bo.name AS body_name, a.official_id, ou.display_name AS official_name, a.assessor_id, au.display_name AS assessor_name, a.fixture_id, a.sport_id, s.name AS sport_name, a.official_role,
  a.grade_label, a.grade_rank, a.status, a.current_version, a.submitted_at, a.published_at, a.void_reason, a.voided_at, a.created_at, a.row_version, o.purpose, e.name AS event_name, f.scheduled_at, v.recommendation,
  (SELECT count(*)::int FROM off_assessment_versions x WHERE x.assessment_id=a.id AND x.state='final') AS versions,
  EXISTS (SELECT 1 FROM off_appeals p WHERE p.assessment_id=a.id AND p.status IN ('lodged','under_review')) AS appeal_open,
  (a.status='published' AND NOT EXISTS (SELECT 1 FROM off_assessment_responses r WHERE r.assessment_id=a.id AND r.kind='acknowledgement' AND r.version=a.current_version)) AS needs_acknowledgement`;
const HEAD_FROM = `off_assessments a JOIN governing_bodies b ON b.id=a.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN users ou ON ou.id=a.official_id JOIN users au ON au.id=a.assessor_id JOIN sports s ON s.id=a.sport_id
  JOIN off_observations o ON o.id=a.observation_id JOIN fixtures f ON f.id=a.fixture_id JOIN events e ON e.id=f.event_id LEFT JOIN off_assessment_versions v ON v.assessment_id=a.id AND v.version=a.current_version`;

/** The assessment plus the caller's side of it. Official: only once published. Assessor: always. Body staff: once submitted. Everyone else: 404. */
async function assessmentFor(user, aid, { c = pool, lock = false } = {}) {
  const a = (await c.query(`SELECT * FROM off_assessments WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [aid])).rows[0];
  if (!a) throw notFound('Assessment');
  const staff = (await devStaff(user, a.body_id, { c, sportId: a.sport_id, optional: true }))?.staff && a.status !== 'draft';
  const assessor = a.assessor_id === user.id;
  // the assessed official, or (for a young person) their verified guardian, exactly as for the licence itself
  const official = !!a.published_at && (a.official_id === user.id || await isGuardianOf(user.id, a.official_id, c));
  if (!staff && !assessor && !official) throw notFound('Assessment');
  return { a, staff: !!staff, assessor, official };
}

const openVersion = (v, who) => ({ version: v.version, state: v.state, scores: v.scores, recommendation: v.recommendation, correction_reason: v.correction_reason, created_at: v.created_at, finalised_at: v.finalised_at,
  by: who.get(v.created_by) ?? null, narrative: unseal(v.narrative_enc, CTX.narrative) });

async function detail(user, side, c = pool) {
  const { a } = side;
  const head = plain((await c.query(`SELECT ${HEAD_COLS} FROM ${HEAD_FROM} WHERE a.id=$1`, [a.id])).rows[0]);
  const rv = (await c.query('SELECT v.id, v.version, v.scale, v.dimensions, r.name, r.id AS rubric_id FROM off_rubric_versions v JOIN off_rubrics r ON r.id=v.rubric_id WHERE v.id=$1', [a.rubric_version_id])).rows[0];
  const versions = (await c.query("SELECT * FROM off_assessment_versions WHERE assessment_id=$1 AND (state='final' OR $2) ORDER BY version", [a.id, side.assessor])).rows;
  const who = new Map((await c.query('SELECT id, display_name FROM users WHERE id = ANY($1)', [[...new Set(versions.map((v) => v.created_by))]])).rows.map((u) => [u.id, u.display_name]));
  const responses = (await c.query('SELECT r.id, r.version, r.kind, r.body_enc, r.created_at, u.display_name AS by_name FROM off_assessment_responses r JOIN users u ON u.id=r.by_user WHERE r.assessment_id=$1 ORDER BY r.created_at', [a.id])).rows
    .map((r) => ({ id: r.id, version: r.version, kind: r.kind, body: unsealText(r.body_enc, CTX.response), created_at: r.created_at, by_name: r.by_name }));
  const appeals = (await c.query('SELECT p.*, u.display_name AS lodged_by_name FROM off_appeals p JOIN users u ON u.id=p.lodged_by WHERE p.assessment_id=$1 ORDER BY p.created_at', [a.id])).rows
    .map((p) => ({ id: p.id, kind: p.kind, version: p.version, status: p.status, grounds: unsealText(p.grounds_enc, CTX.appeal), decision: unsealText(p.decision_enc, CTX.decision), lodged_by_name: p.lodged_by_name, created_at: p.created_at, decided_at: p.decided_at, row_version: p.row_version }));
  const settings = await settingsOf(c, a.body_id);
  const from = head.published_at ? new Date(Math.max(new Date(head.published_at), ...versions.filter((v) => v.state === 'final').map((v) => new Date(v.finalised_at)))) : null;
  const closes = from ? new Date(from.getTime() + settings.appeal_window_days * 86400000) : null;
  const actions = [];
  if (side.assessor && a.status === 'draft') actions.push('save', 'submit');
  if (side.assessor && ['submitted', 'published'].includes(a.status)) actions.push('correct');
  if (side.staff && a.status === 'submitted') actions.push('publish');
  if (side.staff && ['submitted', 'published'].includes(a.status)) actions.push('void');
  if (side.official && a.status === 'published') {
    if (head.needs_acknowledgement) actions.push('acknowledge');
    actions.push('comment');
    if (closes > new Date() && !head.appeal_open) actions.push('request_review', 'appeal');
  }
  if (side.staff && appeals.some((p) => ['lodged', 'under_review'].includes(p.status))) actions.push('decide_appeal');
  await audit(c, user.id, 'read_off_assessments', 'off_assessments', a.id);
  return { ...head, as: { assessor: side.assessor, staff: side.staff, official: side.official }, rubric: rv, versions: versions.map((v) => openVersion(v, who)), responses, appeals,
    appeal_window: { days: settings.appeal_window_days, closes_at: closes }, publication: settings.publication, actions, history: await historyOf('assessment', a.id, c) };
}

cap({
  name: 'get_assessment', method: 'GET', path: '/officials-development/assessments/:id', tag: TAG,
  summary: 'One formal assessment, shaped to who is asking. The assessor sees their own report from the first draft; the body\'s licensing staff see it once submitted; the official sees it once it is published to them under the body\'s policy. Includes the rubric version it was scored on, every version, the official\'s acknowledgement and comments, any review or appeal, and the actions you may take. Reading it is audit-logged.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => detail(user, await assessmentFor(user, i.id, { c }), c)),
});

const FILTER = `($1::uuid IS NULL OR a.body_id=$1) AND ($2::uuid IS NULL OR a.assessor_id=$2) AND ($3::uuid IS NULL OR (a.official_id=$3 AND a.published_at IS NOT NULL)) AND ($4::text IS NULL OR a.status=$4)
  AND ($5::uuid IS NULL OR a.official_id=$5) AND ($6::uuid IS NULL OR a.sport_id=$6) AND ($1::uuid IS NULL OR a.status <> 'draft' OR $2::uuid IS NOT NULL)`;
cap({
  name: 'list_assessments', method: 'GET', path: '/officials-development/assessments', tag: TAG,
  summary: 'Assessments, headers only (never the narrative). As the official pass `mine` (published to you); as an assessor pass `as_assessor` (including your drafts); as the body\'s licensing staff pass `body_id` (submitted onwards; `status=submitted` is the review queue), optionally for one `official_id`.',
  input: z.object({ body_id: id.optional(), mine: z.coerce.boolean().optional(), as_assessor: z.coerce.boolean().optional(), official_id: id.optional(), sport_id: id.optional(), status: z.enum(['draft', 'submitted', 'published', 'voided']).optional(), ...page }),
  async handler({ user }, i) {
    if (!i.body_id && !i.mine && !i.as_assessor) throw badRequest('Give body_id, mine or as_assessor');
    if (i.body_id && !i.as_assessor && !i.mine) await devStaff(user, i.body_id);
    if (i.official_id && !i.body_id) throw badRequest('official_id needs body_id');
    const a = [i.mine || i.as_assessor ? (i.body_id ?? null) : i.body_id, i.as_assessor ? user.id : null, i.mine ? user.id : null, i.status ?? null, i.official_id ?? null, i.sport_id ?? null];
    const total = await one(`SELECT count(*)::int AS n FROM ${HEAD_FROM} WHERE ${FILTER}`, a);
    const items = await many(`SELECT ${HEAD_COLS} FROM ${HEAD_FROM} WHERE ${FILTER} ORDER BY (a.status='submitted') DESC, coalesce(a.published_at, a.submitted_at, a.created_at) DESC LIMIT $7 OFFSET $8`, [...a, i.limit, i.offset]);
    return { total: total.n, items: items.map(plain) };
  },
});

// ------------------------------------------------------------------ write the report
/** Turn an assessor's required actions into the official's shared development items (idempotent by text), cancelling open ones a correction removed. */
async function syncActions(c, a, narrative, actor) {
  const wanted = new Map((narrative.required_actions ?? []).map((t) => [refOf(t), t]));
  for (const [ref, t] of wanted) {
    await c.query(`INSERT INTO off_dev_items(body_id, official_id, kind, source_type, source_id, source_ref, title_enc, created_by) VALUES ($1,$2,'action','assessment',$3,$4,$5,$6)
                   ON CONFLICT (source_type, source_id, source_ref) WHERE source_id IS NOT NULL AND source_ref IS NOT NULL DO UPDATE SET status = CASE WHEN off_dev_items.status='cancelled' THEN 'open' ELSE off_dev_items.status END`,
      [a.body_id, a.official_id, a.id, ref, sealText(t, CTX.item), actor]);
  }
  await c.query("UPDATE off_dev_items SET status='cancelled' WHERE source_type='assessment' AND source_id=$1 AND status='open' AND NOT (source_ref = ANY($2))", [a.id, [...wanted.keys()]]);
}

async function rubricFor(c, obs, rank) {
  return (await c.query(
    `SELECT r.id AS rubric_id, v.id AS version_id, v.version, v.scale, v.dimensions FROM off_rubrics r JOIN LATERAL (SELECT * FROM off_rubric_versions x WHERE x.rubric_id=r.id ORDER BY x.version DESC LIMIT 1) v ON true
      WHERE r.body_id=$1 AND r.sport_id=$2 AND r.official_role=$3 AND r.archived_at IS NULL AND $4 BETWEEN r.min_grade_rank AND r.max_grade_rank ORDER BY (r.max_grade_rank - r.min_grade_rank), r.created_at LIMIT 1`,
    [obs.body_id, obs.sport_id, obs.official_role, rank])).rows[0];
}

cap({
  name: 'save_assessment', method: 'POST', path: '/officials-development/observations/:id/assessment', tag: TAG,
  summary: 'The assessor starts or updates the draft report for an observation they accepted. The first save binds it to the rubric version in force for the official\'s role and grade; that version never changes underneath it. Scores, evidence-linked observations, strengths, development areas, required actions, recommended support and a recommendation (maintain grade, ready for review, further observation required); a recommendation is not a promotion. Only the assessor can see a draft.',
  input: z.object({ id }).extend(contentIn),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM off_observations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!o || o.assessor_id !== user.id) throw notFound('Observation');
    if (o.status !== 'accepted') throw conflict(o.status === 'assigned' ? 'Accept the assignment, with your conflict-of-interest declaration, first' : `This assignment is ${o.status}`);
    const ev = (await c.query('SELECT e.* FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [o.fixture_id])).rows[0];
    if (!(await appointmentFor(c, { bodyId: o.body_id, assessorId: user.id, sportId: o.sport_id, officialRole: o.official_role, eventId: ev.id, officialId: o.official_id }))) throw conflict('Your appointment is not live for this assignment');
    let a = (await c.query('SELECT * FROM off_assessments WHERE observation_id=$1 FOR UPDATE', [o.id])).rows[0];
    let rv;
    if (!a) {
      const g = await currentGrade(o.official_id, o.sport_id, c);
      rv = await rubricFor(c, o, g?.grade_rank ?? 0);
      if (!rv) throw conflict('The body has not published a rubric for this role and grade yet; ask its licensing officer');
      a = (await c.query('INSERT INTO off_assessments(observation_id, body_id, official_id, assessor_id, fixture_id, sport_id, official_role, rubric_version_id, grade_label, grade_rank) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [o.id, o.body_id, o.official_id, user.id, o.fixture_id, o.sport_id, o.official_role, rv.version_id, g?.grade ?? '', g?.grade_rank ?? null])).rows[0];
      await logOff(c, o.body_id, 'assessment', a.id, 'drafted', { to: 'draft', actor: user.id, detail: { rubric_version_id: rv.version_id } });
    } else {
      if (a.status !== 'draft') throw conflict('This assessment is already submitted; use a correction');
      rv = (await c.query('SELECT id AS version_id, version, scale, dimensions FROM off_rubric_versions WHERE id=$1', [a.rubric_version_id])).rows[0];
    }
    validateScores(rv, i.scores);
    const sealed = seal(i.narrative, CTX.narrative);
    const have = (await c.query("SELECT id FROM off_assessment_versions WHERE assessment_id=$1 AND version=$2 AND state='draft'", [a.id, a.current_version])).rows[0];
    if (have) await c.query('UPDATE off_assessment_versions SET scores=$2, narrative_enc=$3, recommendation=$4 WHERE id=$1', [have.id, JSON.stringify(i.scores), sealed, i.recommendation ?? null]);
    else await c.query('INSERT INTO off_assessment_versions(assessment_id, version, state, scores, narrative_enc, recommendation, created_by) VALUES ($1,$2,\'draft\',$3,$4,$5,$6)', [a.id, a.current_version, JSON.stringify(i.scores), sealed, i.recommendation ?? null, user.id]);
    return detail(user, await assessmentFor(user, a.id, { c }), c);
  }),
});

/** Publish to the official: status, dev items from the required actions, a content-free notification. */
async function publish(c, a, actor, { fromStatus }) {
  await c.query("UPDATE off_assessments SET status='published', published_at=coalesce(published_at, now()), row_version=row_version+1 WHERE id=$1", [a.id]);
  const v = (await c.query("SELECT narrative_enc FROM off_assessment_versions WHERE assessment_id=$1 AND version=$2 AND state='final'", [a.id, a.current_version])).rows[0];
  await syncActions(c, a, unseal(v.narrative_enc, CTX.narrative), a.assessor_id);
  await logOff(c, a.body_id, 'assessment', a.id, 'published', { from: fromStatus, to: 'published', actor });
  await notify(c, a.official_id, { kind: 'official_assessment_published', title: 'A development assessment is ready', body: 'Open Officials development to read it and acknowledge it.', data: { assessment_id: a.id }, dedupe_key: `off-assess-pub:${a.id}:${a.current_version}` });
}

cap({
  name: 'submit_assessment', method: 'POST', path: '/officials-development/assessments/:id/submit', tag: TAG,
  summary: 'The assessor submits the finished report. Every rubric dimension needs a score or N/A (with evidence where the rubric requires it), a recommendation, and at least one strength or development area. The match must have started. It becomes immutable version 1 and, under the body\'s policy, reaches the official straight away or waits for the body\'s review.',
  input: z.object({ id, scores: z.array(scoreSchema).max(40).optional(), narrative: narrativeSchema.optional(), recommendation: z.enum(RECOMMENDATIONS).optional(), version: z.number().int().min(1).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await assessmentFor(user, i.id, { c, lock: true });
    if (!s.assessor) throw forbidden('Only the assessor submits');
    const a = s.a;
    if (a.status !== 'draft') throw conflict(`This assessment is ${a.status}`);
    if (i.version && i.version !== a.row_version) throw conflict('This assessment changed since you opened it; reload', { code: 'stale_version' });
    const o = (await c.query('SELECT * FROM off_observations WHERE id=$1 FOR UPDATE', [a.observation_id])).rows[0];
    const f = (await c.query('SELECT f.status, f.event_id FROM fixtures f WHERE f.id=$1', [a.fixture_id])).rows[0];
    if (!['live', 'completed'].includes(f.status)) throw conflict('The match has not started yet');
    if (!(await appointmentFor(c, { bodyId: a.body_id, assessorId: user.id, sportId: a.sport_id, officialRole: a.official_role, eventId: f.event_id, officialId: a.official_id }))) throw conflict('Your appointment is not live, so you cannot submit');
    const dv = (await c.query("SELECT * FROM off_assessment_versions WHERE assessment_id=$1 AND version=$2 AND state='draft' FOR UPDATE", [a.id, a.current_version])).rows[0];
    const scores = i.scores ?? dv?.scores ?? [];
    const narrative = i.narrative ? i.narrative : (dv ? unseal(dv.narrative_enc, CTX.narrative) : narrativeSchema.parse({}));
    const recommendation = i.recommendation ?? dv?.recommendation;
    const rv = (await c.query('SELECT version, scale, dimensions FROM off_rubric_versions WHERE id=$1', [a.rubric_version_id])).rows[0];
    validateScores(rv, scores, { final: true });
    if (!recommendation) throw badRequest('Give your recommendation');
    if (!narrative.strengths.length && !narrative.development_areas.length) throw badRequest('Record at least one strength or development area');
    const sealed = seal(narrative, CTX.narrative);
    if (dv) await c.query("UPDATE off_assessment_versions SET scores=$2, narrative_enc=$3, recommendation=$4, state='final', finalised_at=now() WHERE id=$1", [dv.id, JSON.stringify(scores), sealed, recommendation]);
    else await c.query("INSERT INTO off_assessment_versions(assessment_id, version, state, scores, narrative_enc, recommendation, created_by, finalised_at) VALUES ($1,$2,'final',$3,$4,$5,$6,now())", [a.id, a.current_version, JSON.stringify(scores), sealed, recommendation, user.id]);
    await c.query("UPDATE off_assessments SET status='submitted', submitted_at=now(), row_version=row_version+1 WHERE id=$1", [a.id]);
    await c.query("UPDATE off_observations SET status='completed', closed_at=now(), row_version=row_version+1 WHERE id=$1", [o.id]);
    await logOff(c, a.body_id, 'assessment', a.id, 'submitted', { from: 'draft', to: 'submitted', actor: user.id, detail: { recommendation } });
    const fresh = (await c.query('SELECT * FROM off_assessments WHERE id=$1', [a.id])).rows[0];
    if ((await settingsOf(c, a.body_id)).publication === 'on_submit') await publish(c, fresh, user.id, { fromStatus: 'submitted' });
    else {
      const body = await bodyById(a.body_id, c);
      for (const uid of await staffRecipients(c, body, ['licensing'])) await notify(c, uid, { kind: 'official_assessment_review', title: 'An assessment awaits your review', body: `${body.abbreviation}: a submitted assessment is in the review queue.`, data: { assessment_id: a.id, body_id: a.body_id }, dedupe_key: `off-assess-review:${a.id}:${uid}` });
    }
    return detail(user, await assessmentFor(user, a.id, { c }), c);
  }),
});

cap({
  name: 'correct_assessment', method: 'POST', path: '/officials-development/assessments/:id/correct', tag: TAG, status: 201,
  summary: 'The assessor corrects a submitted or published report by adding a new version with a reason. The earlier version stays in the history; the official is told there is a new version to read and acknowledge again. A correction cannot change the rubric version the assessment was scored on.',
  input: z.object({ id, ...contentIn, recommendation: z.enum(RECOMMENDATIONS), reason: text(500).min(5) }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await assessmentFor(user, i.id, { c, lock: true });
    if (!s.assessor) throw forbidden('Only the assessor corrects their report');
    const a = s.a;
    if (!['submitted', 'published'].includes(a.status)) throw conflict(`This assessment is ${a.status}`);
    const f = (await c.query('SELECT event_id FROM fixtures WHERE id=$1', [a.fixture_id])).rows[0];
    if (!(await appointmentFor(c, { bodyId: a.body_id, assessorId: user.id, sportId: a.sport_id, officialRole: a.official_role, eventId: f.event_id, officialId: a.official_id }))) throw conflict('Your appointment is not live, so you cannot correct');
    const rv = (await c.query('SELECT version, scale, dimensions FROM off_rubric_versions WHERE id=$1', [a.rubric_version_id])).rows[0];
    validateScores(rv, i.scores, { final: true });
    if (!i.narrative.strengths.length && !i.narrative.development_areas.length) throw badRequest('Record at least one strength or development area');
    const n = a.current_version + 1;
    await c.query("INSERT INTO off_assessment_versions(assessment_id, version, state, scores, narrative_enc, recommendation, correction_reason, created_by, finalised_at) VALUES ($1,$2,'final',$3,$4,$5,$6,$7,now())",
      [a.id, n, JSON.stringify(i.scores), seal(i.narrative, CTX.narrative), i.recommendation, i.reason, user.id]);
    await c.query('UPDATE off_assessments SET current_version=$2, row_version=row_version+1 WHERE id=$1', [a.id, n]);
    await logOff(c, a.body_id, 'assessment', a.id, 'corrected', { actor: user.id, reason: i.reason, detail: { version: n, recommendation: i.recommendation } });
    if (a.status === 'published') {
      await syncActions(c, a, i.narrative, user.id);
      await notify(c, a.official_id, { kind: 'official_assessment_corrected', title: 'A development assessment was corrected', body: 'There is a new version to read and acknowledge.', data: { assessment_id: a.id }, dedupe_key: `off-assess-pub:${a.id}:${n}` });
    }
    return detail(user, await assessmentFor(user, a.id, { c }), c);
  }),
});

cap({
  name: 'decide_assessment', method: 'POST', path: '/officials-development/assessments/:id/decision', tag: TAG,
  summary: 'The body\'s licensing staff publish a submitted assessment to the official (when the body reviews first), or void one with a reason of at least ten characters. A void is explicit, logged and visible to the official; the content and every version stay. Voided assessments stop counting toward requirements. Staff cannot edit what an assessor wrote.',
  input: z.object({ id, action: z.enum(['publish', 'void']), reason: text(500).optional(), version: z.number().int().min(1).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await assessmentFor(user, i.id, { c, lock: true });
    if (!s.staff) throw forbidden('Only the body\'s licensing staff decide on an assessment');
    const a = s.a;
    if (i.version && i.version !== a.row_version) throw conflict('This assessment changed since you opened it; reload', { code: 'stale_version' });
    if (i.action === 'publish') {
      if (a.status !== 'submitted') throw conflict(`This assessment is ${a.status}`);
      await publish(c, a, user.id, { fromStatus: 'submitted' });
    } else {
      if (!['submitted', 'published'].includes(a.status)) throw conflict(`This assessment is ${a.status}`);
      if ((i.reason ?? '').trim().length < 10) throw badRequest('Give the reason for voiding (at least ten characters); the official is shown it');
      await c.query("UPDATE off_assessments SET status='voided', void_reason=$2, voided_by=$3, voided_at=now(), row_version=row_version+1 WHERE id=$1", [a.id, i.reason.trim(), user.id]);
      await c.query("UPDATE off_dev_items SET status='cancelled' WHERE source_type='assessment' AND source_id=$1 AND status='open'", [a.id]);
      await logOff(c, a.body_id, 'assessment', a.id, 'voided', { from: a.status, to: 'voided', actor: user.id, reason: i.reason });
      if (a.published_at) await notify(c, a.official_id, { kind: 'official_assessment_voided', title: 'An assessment was voided', body: i.reason.trim().slice(0, 200), data: { assessment_id: a.id }, dedupe_key: `off-assess-void:${a.id}` });
    }
    await audit(c, user.id, `official_assessment_${i.action}`, 'off_assessments', a.id);
    return detail(user, await assessmentFor(user, a.id, { c }), c);
  }),
});

// ------------------------------------------------------------------ the official's side
cap({
  name: 'respond_assessment', method: 'POST', path: '/officials-development/assessments/:id/respond', tag: TAG, status: 201,
  summary: 'The assessed official acknowledges the current version (acknowledging means "I have read it", not "I agree") and/or adds a comment. Responses are append-only and stay with the report.',
  input: z.object({ id, kind: z.enum(['acknowledgement', 'comment']), body: text(2000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await assessmentFor(user, i.id, { c, lock: true });
    if (!s.official) throw forbidden('Only the assessed official responds');
    if (s.a.status !== 'published') throw conflict(`This assessment is ${s.a.status}`);
    if (i.kind === 'comment' && !i.body?.trim()) throw badRequest('Write your comment');
    if (i.kind === 'acknowledgement' && (await c.query("SELECT 1 FROM off_assessment_responses WHERE assessment_id=$1 AND version=$2 AND kind='acknowledgement'", [s.a.id, s.a.current_version])).rowCount) throw conflict('You already acknowledged this version');
    await c.query('INSERT INTO off_assessment_responses(assessment_id, version, kind, body_enc, by_user) VALUES ($1,$2,$3,$4,$5)', [s.a.id, s.a.current_version, i.kind, sealText(i.body?.trim(), CTX.response), user.id]);
    await logOff(c, s.a.body_id, 'assessment', s.a.id, i.kind === 'acknowledgement' ? 'acknowledged' : 'commented', { actor: user.id, detail: { version: s.a.current_version } });
    return detail(user, await assessmentFor(user, s.a.id, { c }), c);
  }),
});

cap({
  name: 'lodge_assessment_appeal', method: 'POST', path: '/officials-development/assessments/:id/appeals', tag: TAG, status: 201,
  summary: 'The assessed official asks for a review (a conversation about the report) or lodges a formal appeal (grounds, decided by the body) within the body\'s window after the current version was published. One of each can be open at a time. It never changes the report by itself and never touches a match result.',
  input: z.object({ id, kind: z.enum(['review', 'appeal']), grounds: text(3000).min(10) }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await assessmentFor(user, i.id, { c, lock: true });
    if (!s.official) throw forbidden('Only the assessed official lodges this');
    const a = s.a;
    if (a.status !== 'published') throw conflict(`This assessment is ${a.status}`);
    const st = await settingsOf(c, a.body_id);
    const last = (await c.query("SELECT max(finalised_at) AS t FROM off_assessment_versions WHERE assessment_id=$1 AND state='final'", [a.id])).rows[0].t;
    const closes = new Date(Math.max(new Date(a.published_at), new Date(last)) + st.appeal_window_days * 86400000);
    if (closes < new Date()) throw conflict(`The ${st.appeal_window_days}-day window to ${i.kind === 'appeal' ? 'appeal' : 'ask for a review'} closed on ${closes.toISOString().slice(0, 10)}`);
    let p;
    try {
      p = (await c.query('INSERT INTO off_appeals(assessment_id, body_id, version, kind, grounds_enc, lodged_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [a.id, a.body_id, a.current_version, i.kind, sealText(i.grounds, CTX.appeal), user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict(`There is already an open ${i.kind} on this assessment`); throw e; }
    await logOff(c, a.body_id, 'appeal', p.id, 'lodged', { to: 'lodged', actor: user.id, detail: { assessment_id: a.id, kind: i.kind, version: a.current_version } });
    const body = await bodyById(a.body_id, c);
    for (const uid of await staffRecipients(c, body, ['licensing'])) await notify(c, uid, { kind: 'official_assessment_appeal', title: i.kind === 'appeal' ? 'An assessment appeal was lodged' : 'A review was requested', body: `${body.abbreviation}: open the appeals queue.`, data: { appeal_id: p.id, assessment_id: a.id, body_id: a.body_id }, dedupe_key: `off-appeal:${p.id}:${uid}` });
    return detail(user, await assessmentFor(user, a.id, { c }), c);
  }),
});

cap({
  name: 'withdraw_assessment_appeal', method: 'POST', path: '/officials-development/appeals/:id/withdraw', tag: TAG,
  summary: 'The official withdraws their own open review request or appeal. The record stays.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM off_appeals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p || p.lodged_by !== user.id) throw notFound('Appeal');
    if (!['lodged', 'under_review'].includes(p.status)) throw conflict(`This ${p.kind} is ${p.status}`);
    await c.query("UPDATE off_appeals SET status='withdrawn', decided_at=now(), row_version=row_version+1 WHERE id=$1", [p.id]);
    await logOff(c, p.body_id, 'appeal', p.id, 'withdrawn', { from: p.status, to: 'withdrawn', actor: user.id });
    return detail(user, await assessmentFor(user, p.assessment_id, { c }), c);
  }),
});

cap({
  name: 'decide_assessment_appeal', method: 'POST', path: '/officials-development/appeals/:id/decision', tag: TAG,
  summary: 'The body\'s licensing staff take an appeal or review request: start_review, or decide it as uphold, partly_uphold or dismiss with a written decision. Upholding does not edit the report: it asks the assessor to correct it (a new version) or the body to void it, both with their own reasons and history.',
  input: z.object({ id, action: z.enum(['start_review', 'uphold', 'partly_uphold', 'dismiss']), decision: text(2000).optional(), version: z.number().int().min(1).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM off_appeals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Appeal');
    const a = (await c.query('SELECT * FROM off_assessments WHERE id=$1', [p.assessment_id])).rows[0];
    const auth = await devStaff(user, p.body_id, { c, sportId: a.sport_id });
    if (!auth.staff) throw forbidden('Only the body\'s licensing staff decide this');
    if (i.version && i.version !== p.row_version) throw conflict('This changed since you opened it; reload', { code: 'stale_version' });
    if (!['lodged', 'under_review'].includes(p.status)) throw conflict(`This ${p.kind} is ${p.status}`);
    if (i.action === 'start_review' && p.status !== 'lodged') throw conflict('Already under review');
    if (i.action !== 'start_review' && (i.decision ?? '').trim().length < 10) throw badRequest('Write the decision the official will be shown (at least ten characters)');
    const to = { start_review: 'under_review', uphold: 'upheld', partly_uphold: 'partly_upheld', dismiss: 'dismissed' }[i.action];
    await c.query('UPDATE off_appeals SET status=$2, decision_enc=$3, decided_by=$4, decided_at=CASE WHEN $2=\'under_review\' THEN NULL ELSE now() END, row_version=row_version+1 WHERE id=$1', [p.id, to, i.action === 'start_review' ? null : sealText(i.decision.trim(), CTX.decision), user.id]);
    await logOff(c, p.body_id, 'appeal', p.id, i.action, { from: p.status, to, actor: user.id });
    if (i.action !== 'start_review') {
      await notify(c, p.lodged_by, { kind: 'official_assessment_appeal_decided', title: `Your ${p.kind} was decided`, body: 'Open the assessment to read the decision.', data: { assessment_id: a.id, appeal_id: p.id }, dedupe_key: `off-appeal-decided:${p.id}` });
      if (['uphold', 'partly_uphold'].includes(i.action)) await notify(c, a.assessor_id, { kind: 'official_assessment_appeal_upheld', title: 'Please review your assessment', body: 'An appeal on your report was upheld; add a correction with your reasoning.', data: { assessment_id: a.id }, dedupe_key: `off-appeal-upheld:${p.id}` });
    }
    await audit(c, user.id, `official_appeal_${i.action}`, 'off_appeals', p.id);
    return detail(user, await assessmentFor(user, a.id, { c }), c);
  }),
});

cap({
  name: 'list_assessment_appeals', method: 'GET', path: '/officials-development/bodies/:id/appeals', tag: TAG,
  summary: 'The body\'s review requests and appeals (licensing officer/admin), open first. Headers only: open the assessment to read the grounds.',
  input: z.object({ id, status: z.enum(['lodged', 'under_review', 'upheld', 'partly_upheld', 'dismissed', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    await devStaff(user, i.id);
    const w = 'p.body_id=$1 AND ($2::text IS NULL OR p.status=$2)';
    const total = await one(`SELECT count(*)::int AS n FROM off_appeals p WHERE ${w}`, [i.id, i.status ?? null]);
    const items = await many(`SELECT p.id, p.assessment_id, p.kind, p.version, p.status, p.created_at, p.decided_at, p.row_version, ou.display_name AS official_name, e.name AS event_name FROM off_appeals p JOIN off_assessments a ON a.id=p.assessment_id JOIN users ou ON ou.id=a.official_id
      JOIN fixtures f ON f.id=a.fixture_id JOIN events e ON e.id=f.event_id WHERE ${w} ORDER BY (p.status IN ('lodged','under_review')) DESC, p.created_at DESC LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]);
    return { total: total.n, items };
  },
});

// ------------------------------------------------------------------ AI drafting aid
cap({
  name: 'draft_development_plan', method: 'POST', path: '/me/officials-development/plan-draft', tag: TAG,
  summary: 'Draft wording for your own development plan from your published assessments, open actions and CPD. The AI writes a DRAFT only: it sees nothing about other people, has no tools, and cannot grade, recommend a promotion or demotion, or decide licence eligibility. You choose what to keep and add it as goals yourself. Without AI configured you get a plain summary of the same records.',
  input: z.object({ body_id: id.optional(), sport_id: id.optional() }),
  async handler({ user }, i) {
    const rows = (await many(
      `SELECT a.id, a.official_role, a.grade_label, a.published_at, v.narrative_enc, v.recommendation FROM off_assessments a JOIN off_assessment_versions v ON v.assessment_id=a.id AND v.version=a.current_version
        WHERE a.official_id=$1 AND a.status='published' AND ($2::uuid IS NULL OR a.body_id=$2) AND ($3::uuid IS NULL OR a.sport_id=$3) ORDER BY a.published_at DESC LIMIT 8`, [user.id, i.body_id ?? null, i.sport_id ?? null]));
    if (!rows.length) return { draft: true, source: 'none', headline: 'No published assessments yet', items: [], limitations: ['There is nothing to summarise until an assessment has been published to you.'] };
    const open = (await many("SELECT title_enc FROM off_dev_items WHERE official_id=$1 AND status='open' AND visibility='shared' ORDER BY created_at DESC LIMIT 10", [user.id])).map((r) => unsealText(r.title_enc, CTX.item));
    const narratives = rows.map((r, n) => ({ ref: `A${n + 1}`, role: r.official_role, date: String(r.published_at).slice(0, 10), recommendation: r.recommendation, ...unseal(r.narrative_enc, CTX.narrative) }));
    await audit(null, user.id, 'read_off_assessments', 'off_assessments', rows[0].id);
    const plain = { draft: true, source: 'plain', headline: 'Recurring development areas from your assessments', items: [...new Set(narratives.flatMap((n) => n.development_areas))].slice(0, 6).map((t) => ({ title: t, detail: '', source_refs: [] })), limitations: ['This is a plain list of your own recorded development areas.'] };
    if (!aiConfigured()) return plain;
    const data = narratives.map((n) => `${n.ref} (${n.date}, ${n.role}): strengths: ${n.strengths.map((t) => quoteData(t, 200)).join('; ')}; development: ${n.development_areas.map((t) => quoteData(t, 200)).join('; ')}; actions: ${n.required_actions.map((t) => quoteData(t, 200)).join('; ')}`).join('\n')
      + `\nOpen actions: ${open.map((t) => quoteData(t, 160)).join('; ') || 'none'}`;
    const out = await askJson({
      system: `You help an official turn their own assessment feedback into a short development plan. Write goals in plain, encouraging language grounded in the data. Do not give scores, do not say whether the person should be promoted, demoted, licensed or renewed, and do not mention other people. ${AI_RULES}`,
      user: `<data>\n${data}\n</data>\nDraft up to 5 development goals, each tied to the assessment refs behind it.`,
      shape: '{"headline": string, "items": [{"title": string, "detail": string, "source_refs": ["A1"]}]}',
      schema: z.object({ headline: z.string().max(300), items: z.array(z.object({ title: z.string().max(160), detail: z.string().max(600).default(''), source_refs: z.array(z.string().max(6)).max(6).default([]) })).max(5) }),
    });
    return out ? { draft: true, source: 'ai', ...out, limitations: ['A draft for you to edit. It does not grade you or decide anything about your licence.'] } : { ...plain, limitations: ['The AI did not answer, so this is a plain list of your own recorded development areas.'] };
  },
});
