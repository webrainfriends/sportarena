// Coaching evaluations: a structured, evidence-led assessment of one athlete on the coach's own evaluation sheet (a rubric: criteria grouped by
// pillar, weighted, with behaviour anchors and targets), shared with the athlete or a young person's guardian, who add a self-assessment, respond,
// ask questions and acknowledge. Coach and athlete talk it through in a thread and the coach closes it. Every share freezes an immutable numbered
// version, so what the athlete saw can never be rewritten. One definition: REST, OpenAPI and MCP share it.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { requireRelationship, requireCoachingConsent } from '../coaching.js';
import { hasConsent, isYouth } from '../youth.js';
import { view, summarise, hashSnapshot } from '../coaching-evaluations.js';
import { renderEvaluation, SECTIONS } from '../documents/evaluation-pdf.js';
import { saveEncrypted } from '../doc-store.js';
import { createHash } from 'node:crypto';
import { isBlocked, assertMayContact, conversationAccess, postMessage } from '../inbox.js';
import { guardiansOf as verifiedGuardians } from '../youth.js';

const TAG = 'Coaching evaluations';
const COACH = ['coach'];
const text = (n) => z.string().trim().max(n);
const CONTEXTS = ['class', 'session', 'period', 'match', 'trial', 'custom'];
const REACTIONS = ['agree', 'discuss', 'disagree'];
const evidence = z.object({ type: z.enum(['note', 'link', 'clip']).default('note'), text: text(500).optional(), url: z.string().url().max(500).startsWith('https://').optional(), at: text(20).optional().describe('where in a clip, e.g. 12:40') });
const scoreEntry = z.object({ score: z.number().nullable().optional(), comment: text(2000).nullable().optional(), evidence: z.array(evidence).max(10).optional() });
const narrative = z.object({ strengths: text(3000).nullable().optional(), development: text(3000).nullable().optional(), cues: text(3000).nullable().optional(), next_steps: text(3000).nullable().optional(), private: text(4000).nullable().optional() });

// ------------------------------------------------------------------ helpers

async function sheetVersion(rubricId, version) {
  const r = await one('SELECT r.id, r.coach_id, r.name, r.sport_id, v.version, v.dimensions FROM coaching_rubrics r JOIN coaching_rubric_versions v ON v.rubric_id=r.id WHERE r.id=$1 AND ($2::int IS NULL OR v.version=$2) ORDER BY v.version DESC LIMIT 1', [rubricId, version ?? null]);
  if (!r) throw notFound('Evaluation sheet');
  return r;
}
async function ownEval(user, evId, c) {
  const q = c ? (t, p) => c.query(t, p).then((r) => r.rows[0] ?? null) : one;
  const ev = await q(`SELECT * FROM coaching_evaluations WHERE id=$1${c ? ' FOR UPDATE' : ''}`, [evId]);
  if (!ev || (ev.coach_id !== user.id && !isAdmin(user))) throw notFound('Evaluation');
  return ev;
}
/** The athlete, or a guardian of a young athlete, read live. Anyone else gets a 404. */
async function viewerOf(user, ev) {
  if (ev.athlete_id === user.id) return 'athlete';
  const g = await one("SELECT 1 FROM guardian_links WHERE guardian_id=$1 AND child_id=$2 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [user.id, ev.athlete_id]);
  return g ? 'guardian' : null;
}
async function sharedEval(user, evId) {
  const ev = await one('SELECT * FROM coaching_evaluations WHERE id=$1', [evId]);
  const as = ev && ev.latest_version > 0 ? await viewerOf(user, ev) : null;
  if (!as) throw notFound('Evaluation');
  if ((await isYouth(ev.athlete_id)) && !(await hasConsent(ev.athlete_id, 'coaching'))) throw notFound('Evaluation'); // withdrawing consent hides it; nothing is deleted
  return { ev, as };
}
const latestSnapshot = async (evId) => (await one('SELECT version, snapshot, published_at FROM coaching_evaluation_versions WHERE evaluation_id=$1 ORDER BY version DESC LIMIT 1', [evId]));
async function previousScores(ev) {
  const prev = await one("SELECT id FROM coaching_evaluations WHERE athlete_id=$1 AND coach_id=$2 AND rubric_id=$3 AND id <> $4 AND latest_version > 0 AND coalesce(shared_at, now()) <= coalesce($5::timestamptz, now()) ORDER BY shared_at DESC LIMIT 1", [ev.athlete_id, ev.coach_id, ev.rubric_id, ev.id, ev.shared_at]);
  if (!prev) return null;
  const s = await latestSnapshot(prev.id);
  return s ? { scores: s.snapshot.scores } : null;
}
const guardiansOf = (childId) => many("SELECT guardian_id FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [childId]).then((r) => r.map((x) => x.guardian_id));
async function tellAthlete(c, ev, msg) {
  const to = (await isYouth(ev.athlete_id)) ? await guardiansOf(ev.athlete_id) : [ev.athlete_id];
  for (const u of new Set(to)) await notify(c, u, { ...msg, data: { evaluation_id: ev.id } });
}
function checkScores(dims, scores) {
  const by = new Map(dims.map((d) => [d.key, d]));
  for (const [k, e] of Object.entries(scores ?? {})) {
    const d = by.get(k);
    if (!d) throw badRequest(`Unknown criterion ${k}`);
    if (e?.score != null && (e.score < d.scale_min || e.score > d.scale_max)) throw badRequest(`${d.name}: a score must be between ${d.scale_min} and ${d.scale_max}`);
    if (e?.score != null && d.step) { const n = (e.score - d.scale_min) / d.step; if (Math.abs(n - Math.round(n)) > 1e-6) throw badRequest(`${d.name}: scores go up in steps of ${d.step}`); }
  }
}
const mergeScores = (cur, patch) => {
  const out = { ...cur };
  for (const [k, e] of Object.entries(patch ?? {})) {
    const next = { ...(out[k] ?? {}), ...Object.fromEntries(Object.entries(e ?? {}).filter(([, v]) => v !== undefined)) };
    if (next.score == null && !next.comment && !(next.evidence?.length)) delete out[k]; else out[k] = JSON.parse(JSON.stringify(next, (_k, v) => (v === null ? undefined : v)));
  }
  return out;
};

async function coachView(ev) {
  const sheet = await sheetVersion(ev.rubric_id, ev.rubric_version);
  const [prev, snap, athlete] = await Promise.all([previousScores(ev), latestSnapshot(ev.id), one('SELECT id, display_name, avatar_emoji, avatar_color FROM users WHERE id=$1', [ev.athlete_id])]);
  const v = view(ev, sheet.dimensions, { previous: prev, includePrivate: true });
  const live = hashSnapshot({ s: ev.scores, n: { ...ev.narrative, private: undefined } });
  const frozen = snap ? hashSnapshot({ s: snap.snapshot.scores, n: { ...snap.snapshot.narrative, private: undefined } }) : null;
  const thread = await many('SELECT m.id, m.author_role, m.criterion_key, m.body, m.created_at, u.display_name AS author FROM coaching_evaluation_messages m JOIN users u ON u.id=m.author_id WHERE m.evaluation_id=$1 ORDER BY m.created_at, m.id', [ev.id]);
  return { ...v, sheet: { id: sheet.id, name: sheet.name, version: sheet.version }, athlete, unshared_changes: !!snap && live !== frozen, thread };
}

// ------------------------------------------------------------------ coach

cap({
  name: 'create_coaching_evaluation', method: 'POST', path: '/coaching/evaluations', tag: TAG, auth: COACH, status: 201,
  summary: 'Start an evaluation of an athlete you coach on one of your evaluation sheets (rubrics). Context says what it is about: a class (scores already given in that class are carried in), a session, a period, a match or a trial. Optionally ask the athlete for a self-assessment first, so you can compare your view with theirs once you score.',
  input: z.object({ athlete_id: id, rubric_id: id, context_type: z.enum(CONTEXTS).default('period'), class_id: id.optional(), title: text(160).min(2).optional(), period_from: z.string().date().optional(), period_to: z.string().date().optional(), request_self_assessment: z.boolean().default(false) }),
  async handler({ user }, i) {
    if (i.context_type === 'class' && !i.class_id) throw badRequest('Say which class');
    const rels = await requireRelationship(user, i.athlete_id);
    const sheet = await sheetVersion(i.rubric_id);
    if (sheet.coach_id !== user.id) throw notFound('Evaluation sheet');
    let k = null, rec = null, scores = {};
    if (i.class_id) {
      k = await one("SELECT k.* FROM coach_classes k JOIN coach_class_seats z ON z.class_id=k.id AND z.user_id=$2 AND z.status='confirmed' WHERE k.id=$1 AND k.coach_id=$3", [i.class_id, i.athlete_id, user.id]);
      if (!k) throw notFound('Class');
      rec = await one("SELECT id FROM coaching_session_records WHERE coach_id=$1 AND source_type='coach_class' AND source_id=$2", [user.id, k.id]);
      if (rec) for (const o of await many('SELECT DISTINCT ON (dimension_key) dimension_key, score::float AS score FROM coaching_observations WHERE coach_id=$1 AND athlete_id=$2 AND session_record_id=$3 AND rubric_id=$4 AND score IS NOT NULL ORDER BY dimension_key, observed_at DESC', [user.id, i.athlete_id, rec.id, sheet.id])) scores[o.dimension_key] = { score: o.score };
    }
    const title = i.title ?? [sheet.name, k?.title ?? new Date().toISOString().slice(0, 10)].join(' · ');
    const ev = await one(
      `INSERT INTO coaching_evaluations(coach_id, athlete_id, sport_id, rubric_id, rubric_version, context_type, class_id, session_record_id, title, period_from, period_to, self_requested, scores)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [user.id, i.athlete_id, k?.sport_id ?? sheet.sport_id ?? rels[0].sport_id, sheet.id, sheet.version, i.context_type, k?.id ?? null, rec?.id ?? null, title, i.period_from ?? null, i.period_to ?? null, i.request_self_assessment, JSON.stringify(scores)]);
    await audit(null, user.id, 'create_coaching_evaluation', 'coaching_evaluations', ev.id);
    if (i.request_self_assessment) await tx((c) => tellAthlete(c, ev, { kind: 'evaluation_self_requested', title: 'Your coach asked for your self-assessment', body: `Before your coach shares "${ev.title}", please rate yourself on the same criteria.` }));
    return coachView(ev);
  },
});

cap({
  name: 'update_coaching_evaluation', method: 'PATCH', path: '/coaching/evaluations/:id', tag: TAG, auth: COACH,
  summary: 'Fill in or edit an evaluation: a score, comment and evidence (notes, links, clip times) per criterion, and the written feedback (strengths, development priorities, key cues, next steps, and a private note only you see). Send row_version from your last read. Scores are checked against each criterion\'s own scale. Nothing the athlete has already been shown changes until you share again.',
  input: z.object({ id, row_version: z.number().int().min(1), title: text(160).min(2).optional(), scores: z.record(z.string(), scoreEntry).optional(), narrative: narrative.optional(), period_from: z.string().date().nullable().optional(), period_to: z.string().date().nullable().optional(), request_self_assessment: z.boolean().optional() }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const ev = await ownEval(user, i.id, c);
      if (ev.closed_at) throw conflict('This evaluation is closed');
      if (ev.row_version !== i.row_version) throw conflict('This evaluation changed. Reload and try again.');
      const sheet = await sheetVersion(ev.rubric_id, ev.rubric_version);
      checkScores(sheet.dimensions, i.scores);
      const scores = mergeScores(ev.scores, i.scores);
      const narr = { ...ev.narrative };
      for (const [k, v] of Object.entries(i.narrative ?? {})) { if (v === null || v === '') delete narr[k]; else if (v !== undefined) narr[k] = v; }
      return (await c.query(
        `UPDATE coaching_evaluations SET scores=$2, narrative=$3, title=coalesce($4,title), period_from=CASE WHEN $5::boolean THEN $6::date ELSE period_from END, period_to=CASE WHEN $7::boolean THEN $8::date ELSE period_to END,
                self_requested=coalesce($9,self_requested), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [ev.id, JSON.stringify(scores), JSON.stringify(narr), i.title ?? null, i.period_from !== undefined, i.period_from ?? null, i.period_to !== undefined, i.period_to ?? null, i.request_self_assessment ?? null])).rows[0];
    });
    return coachView(out);
  },
});

cap({
  name: 'get_coaching_evaluation', method: 'GET', path: '/coaching/evaluations/:id', tag: TAG, auth: COACH,
  summary: 'One evaluation as you see it: the sheet, every criterion with your score and comment, the athlete\'s self-assessment and the gap, the change since your previous evaluation of them, weighted pillar and overall scores (labelled computed), your written feedback, the athlete\'s response and the thread, and whether you have edited since you last shared.',
  input: z.object({ id }),
  handler: async ({ user }, i) => coachView(await ownEval(user, i.id)),
});

cap({
  name: 'list_coaching_evaluations', method: 'GET', path: '/coaching/evaluations', tag: TAG, auth: COACH,
  summary: 'Your evaluations, newest first, with the athlete, status, overall score and what is waiting on whom (drafts to finish, shared and waiting for a response, responded and waiting for you). Filter by athlete, status, class or sheet.',
  input: z.object({ athlete_id: id.optional(), status: z.enum(['draft', 'shared', 'responded', 'closed']).optional(), class_id: id.optional(), rubric_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT e.*, u.display_name AS athlete_name FROM coaching_evaluations e JOIN users u ON u.id=e.athlete_id
        WHERE e.coach_id=$1 AND ($2::uuid IS NULL OR e.athlete_id=$2) AND ($3::text IS NULL OR e.status=$3) AND ($4::uuid IS NULL OR e.class_id=$4) AND ($5::uuid IS NULL OR e.rubric_id=$5)
        ORDER BY e.updated_at DESC, e.id LIMIT $6 OFFSET $7`, [user.id, i.athlete_id ?? null, i.status ?? null, i.class_id ?? null, i.rubric_id ?? null, i.limit, i.offset]);
    const out = [];
    for (const e of rows) {
      const sheet = await sheetVersion(e.rubric_id, e.rubric_version);
      out.push({ id: e.id, title: e.title, athlete_id: e.athlete_id, athlete_name: e.athlete_name, status: e.status, context_type: e.context_type, class_id: e.class_id, overall: summarise(sheet.dimensions, e.scores).overall, shared_at: e.shared_at, responded_at: e.responded_at, closed_at: e.closed_at, updated_at: e.updated_at,
        waiting_on: e.status === 'draft' ? 'coach' : e.status === 'shared' ? 'athlete' : e.status === 'responded' ? 'coach' : null });
    }
    return out;
  },
});

cap({
  name: 'share_coaching_evaluation', method: 'POST', path: '/coaching/evaluations/:id/share', tag: TAG, auth: COACH,
  summary: 'Share the evaluation with the athlete (or a young person\'s guardian) as a new frozen version: the sheet as it is now, your scores, comments, evidence and written feedback (never your private note), with the computed scores. A young person needs a guardian\'s current coaching consent. Sharing again after edits publishes the next version and tells them once.',
  input: z.object({ id, note: text(500).optional().describe('a short message that goes with it') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await ownEval(user, i.id, c);
      if (ev.closed_at) throw conflict('This evaluation is closed');
      const sheet = await sheetVersion(ev.rubric_id, ev.rubric_version);
      if (!summarise(sheet.dimensions, ev.scores).coverage.scored) throw badRequest('Score at least one criterion first', { code: 'nothing_scored' });
      await requireRelationship(user, ev.athlete_id);
      await requireCoachingConsent(ev.athlete_id, 'sharing an evaluation with them');
      const prev = await previousScores(ev);
      const v = ev.latest_version + 1;
      const snapshot = { title: ev.title, context_type: ev.context_type, period_from: ev.period_from, period_to: ev.period_to, sheet: { id: sheet.id, name: sheet.name, version: sheet.version }, dimensions: sheet.dimensions,
        scores: ev.scores, narrative: { ...ev.narrative, private: undefined }, summary: view(ev, sheet.dimensions, { previous: prev, includeSelf: false }).summary, previous: prev?.scores ?? null, note: i.note ?? null, shared_by: user.id };
      await c.query('INSERT INTO coaching_evaluation_versions(evaluation_id, version, snapshot, snapshot_sha256, published_by) VALUES ($1,$2,$3,$4,$5)', [ev.id, v, JSON.stringify(snapshot), hashSnapshot(snapshot), user.id]);
      const row = (await c.query("UPDATE coaching_evaluations SET latest_version=$2, status=CASE WHEN status='draft' THEN 'shared' ELSE status END, shared_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [ev.id, v])).rows[0];
      await audit(c, user.id, 'share_coaching_evaluation', 'coaching_evaluations', ev.id);
      await tellAthlete(c, row, { kind: 'evaluation_shared', title: v === 1 ? 'Your coach shared an evaluation' : 'Your coach updated an evaluation', body: `"${ev.title}"${i.note ? `: ${i.note}` : ''}. Read it, add your view and ask anything you like.` });
      return { id: ev.id, version: v, status: row.status };
    });
  },
});

cap({
  name: 'close_coaching_evaluation', method: 'POST', path: '/coaching/evaluations/:id/close', tag: TAG, auth: COACH,
  summary: 'Close a shared evaluation once you have talked it through: it becomes read-only for both of you and stays on record. The athlete is told.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await ownEval(user, i.id, c);
      if (ev.closed_at) return { id: ev.id, status: 'closed', replayed: true };
      if (!ev.latest_version) throw conflict('Share it first', { code: 'not_shared' });
      const row = (await c.query("UPDATE coaching_evaluations SET status='closed', closed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [ev.id])).rows[0];
      await audit(c, user.id, 'close_coaching_evaluation', 'coaching_evaluations', ev.id);
      await tellAthlete(c, row, { kind: 'evaluation_closed', title: 'Evaluation closed', body: `"${ev.title}" is closed. It stays available to read.` });
      return { id: ev.id, status: 'closed' };
    });
  },
});

// ------------------------------------------------------------------ both sides: thread, trend, export

cap({
  name: 'post_evaluation_message', method: 'POST', path: '/coaching/evaluations/:id/messages', tag: TAG, auth: 'user', status: 201,
  summary: 'Add to the conversation on a shared evaluation, optionally about one criterion. The coach, the athlete and a young person\'s guardian can write; messages are kept and never edited. The other side is told.',
  input: z.object({ id, body: text(2000).min(1), criterion_key: z.string().max(40).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = (await c.query('SELECT * FROM coaching_evaluations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ev || !ev.latest_version) throw notFound('Evaluation');
      const asCoach = ev.coach_id === user.id;
      const as = asCoach ? 'coach' : await viewerOf(user, ev);
      if (!as) throw notFound('Evaluation');
      if (!asCoach && (await isYouth(ev.athlete_id)) && !(await hasConsent(ev.athlete_id, 'coaching'))) throw notFound('Evaluation');
      if (ev.closed_at) throw conflict('This evaluation is closed');
      if (i.criterion_key) { const sheet = await sheetVersion(ev.rubric_id, ev.rubric_version); if (!sheet.dimensions.some((d) => d.key === i.criterion_key)) throw badRequest('Unknown criterion'); }
      const m = (await c.query('INSERT INTO coaching_evaluation_messages(evaluation_id, author_id, author_role, criterion_key, body) VALUES ($1,$2,$3,$4,$5) RETURNING id, author_role, criterion_key, body, created_at', [ev.id, user.id, as, i.criterion_key ?? null, i.body])).rows[0];
      if (asCoach) await tellAthlete(c, ev, { kind: 'evaluation_message', title: 'Your coach replied', body: i.body.slice(0, 140) });
      else await notify(c, ev.coach_id, { kind: 'evaluation_message', title: 'New message on an evaluation', body: i.body.slice(0, 140), data: { evaluation_id: ev.id } });
      return m;
    });
  },
});

cap({
  name: 'get_evaluation_trend', method: 'GET', path: '/coaching/evaluation-trend', tag: TAG, auth: 'user',
  summary: 'How an athlete\'s evaluations on one sheet change over time: for each shared evaluation, the overall and pillar scores (computed) and per-criterion scores, oldest first. A coach sees their own evaluations of an athlete they coach; an athlete or guardian sees what was shared. Leave athlete_id out to see your own.',
  input: z.object({ rubric_id: id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    let rows;
    if (athleteId === user.id || (await viewerOf(user, { athlete_id: athleteId }))) {
      if ((await isYouth(athleteId)) && !(await hasConsent(athleteId, 'coaching'))) return { points: [] };
      rows = await many('SELECT e.id, e.title, e.shared_at, v.snapshot FROM coaching_evaluations e JOIN LATERAL (SELECT snapshot FROM coaching_evaluation_versions x WHERE x.evaluation_id=e.id ORDER BY version DESC LIMIT 1) v ON true WHERE e.athlete_id=$1 AND e.rubric_id=$2 AND e.latest_version > 0 ORDER BY e.shared_at, e.id', [athleteId, i.rubric_id]);
    } else {
      await requireRelationship(user, athleteId);
      rows = await many('SELECT e.id, e.title, e.shared_at, v.snapshot FROM coaching_evaluations e JOIN LATERAL (SELECT snapshot FROM coaching_evaluation_versions x WHERE x.evaluation_id=e.id ORDER BY version DESC LIMIT 1) v ON true WHERE e.athlete_id=$1 AND e.coach_id=$2 AND e.rubric_id=$3 AND e.latest_version > 0 ORDER BY e.shared_at, e.id', [athleteId, user.id, i.rubric_id]);
    }
    return { points: rows.map((r) => ({ evaluation_id: r.id, title: r.title, at: r.shared_at, overall: r.snapshot.summary.overall, pillars: r.snapshot.summary.pillars, scores: Object.fromEntries(Object.entries(r.snapshot.scores).map(([k, e]) => [k, e.score ?? null])) })), criteria: rows.at(-1)?.snapshot.dimensions.map((d) => ({ key: d.key, name: d.name, pillar: d.pillar ?? 'other', scale_min: d.scale_min, scale_max: d.scale_max, target: d.target ?? null })) ?? [] };
  },
});

const sectionsInput = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v), z.array(z.enum(SECTIONS)).min(1)).optional().describe('what goes in the PDF: summary, scores (with the level descriptions), comments (per criterion), evidence, feedback (the written feedback), response (the athlete\'s) and conversation; default is all');

/**
 * The evaluation as a PDF for one person. A coach can take the working copy (everything, including the athlete's self-assessment and response; the private
 * note only when asked) or the shared copy (exactly what the athlete was shown, the safe one to pass on). An athlete or guardian always gets the shared copy.
 */
async function buildEvaluationPdf(user, evId, { copy = 'working', sections, includePrivate = false }) {
  const raw = await one('SELECT * FROM coaching_evaluations WHERE id=$1', [evId]);
  if (!raw) throw notFound('Evaluation');
  const isCoach = raw.coach_id === user.id || isAdmin(user);
  let data, who;
  if (isCoach && copy === 'working') {
    who = 'coach'; data = await coachView(raw);
    if (!includePrivate) delete data.narrative.private;
  } else {
    if (!isCoach) await sharedEval(user, evId);   // consent and viewer checks for the athlete or guardian
    else if (!raw.latest_version) throw conflict('Share the evaluation first: the shared copy is what the athlete was shown', { code: 'not_shared' });
    const snap = await latestSnapshot(raw.id);
    who = isCoach ? 'coach' : 'athlete';
    data = { ...view({ ...raw, scores: snap.snapshot.scores, narrative: snap.snapshot.narrative, latest_version: snap.version }, snap.snapshot.dimensions, { previous: snap.snapshot.previous ? { scores: snap.snapshot.previous } : null }),
      sheet: snap.snapshot.sheet, athlete: await one('SELECT id, display_name FROM users WHERE id=$1', [raw.athlete_id]),
      thread: await many('SELECT m.author_role, m.criterion_key, m.body, m.created_at, u.display_name AS author FROM coaching_evaluation_messages m JOIN users u ON u.id=m.author_id WHERE m.evaluation_id=$1 ORDER BY m.created_at, m.id', [raw.id]) };
  }
  const coach = await one('SELECT display_name FROM users WHERE id=$1', [raw.coach_id]);
  const { buffer, pages } = await renderEvaluation({ ...data, coach_name: coach.display_name, viewer: who }, { sections: sections ?? SECTIONS });
  return { raw, buffer, pages, title: raw.title };
}
const pdfName = (title) => `evaluation-${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'report'}.pdf`;

cap({
  name: 'export_coaching_evaluation', method: 'GET', path: '/coaching/evaluations/:id/export', tag: TAG, auth: 'user',
  summary: 'The evaluation as a printable PDF you can keep or pass on. Choose what goes in (summary, scores with level descriptions, comments, evidence, written feedback, the athlete\'s response, the conversation). A coach picks copy=working (everything, athlete self-assessment included; the private note only with include_private) or copy=shared (exactly what the athlete was shown: the safe one to send to others). An athlete or guardian always gets the shared copy with their own response. Every export is audited. Returns the file as base64.',
  input: z.object({ id, copy: z.enum(['working', 'shared']).default('working'), sections: sectionsInput, include_private: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const { raw, buffer, pages, title } = await buildEvaluationPdf(user, i.id, { copy: i.copy, sections: i.sections, includePrivate: i.include_private });
    await audit(null, user.id, 'export_coaching_evaluation', 'coaching_evaluations', raw.id);
    return { filename: pdfName(title), content_type: 'application/pdf', encoding: 'base64', content: buffer.toString('base64'), pages, copy: raw.coach_id === user.id || isAdmin(user) ? i.copy : 'shared' };
  },
});

cap({
  name: 'send_coaching_evaluation_message', method: 'POST', path: '/coaching/evaluations/:id/send', tag: TAG, auth: COACH,
  summary: 'Send the shared copy of an evaluation to the athlete as a message in the inbox, with the PDF attached and an optional note. It uses the same safeguards as every direct message: a young person needs a verified guardian (who can read it) and a guardian\'s contact consent, and a blocked person cannot be messaged. Only an evaluation you have already shared can be sent, and only what they were shown goes in the file.',
  input: z.object({ id, note: text(500).optional(), sections: sectionsInput }),
  async handler({ user }, i) {
    const ev = await ownEval(user, i.id);
    if (!ev.latest_version) throw conflict('Share the evaluation first', { code: 'not_shared' });
    await requireRelationship(user, ev.athlete_id);
    if (await isBlocked(user.id, ev.athlete_id)) throw notFound('Person');
    await assertMayContact(user.id, ev.athlete_id);
    const { buffer, title } = await buildEvaluationPdf(user, ev.id, { copy: 'shared', sections: i.sections });
    const key = [user.id, ev.athlete_id].sort().join(':');
    const convId = await tx(async (c) => {
      const ex = (await c.query('SELECT id FROM conversations WHERE direct_key=$1', [key])).rows[0];
      const cid = ex?.id ?? (await c.query("INSERT INTO conversations(kind, created_by, direct_key) VALUES ('direct',$1,$2) RETURNING id", [user.id, key])).rows[0].id;
      for (const uid of [user.id, ev.athlete_id]) {
        if (await isYouth(uid, c) && !(await verifiedGuardians(uid, c)).length) throw conflict('A young person needs a verified guardian before direct messages can start', { code: 'guardian_required' });
        await c.query(`INSERT INTO conversation_members(conversation_id, user_id, role, added_by) VALUES ($1,$2,'member',$3)
                       ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at=NULL, joined_at=CASE WHEN conversation_members.left_at IS NULL THEN conversation_members.joined_at ELSE now() END`, [cid, uid, user.id]);
      }
      return cid;
    });
    const { id: aid, file } = await saveEncrypted('inbox', 'conversation_attachments.file', buffer);
    const att = await one(
      `INSERT INTO conversation_attachments(id, conversation_id, uploader_id, kind, content_type, name, file_name, size_bytes, sha256) VALUES ($1,$2,$3,'file','application/pdf',$4,$5,$6,$7) RETURNING id`,
      [aid, convId, user.id, pdfName(title), file, buffer.length, createHash('sha256').update(buffer).digest('hex')]);
    const access = await conversationAccess(user, convId, { write: true });
    const m = await postMessage(user, access, { body: i.note ?? `Your evaluation: ${title}`, attachment_id: att.id });
    await audit(null, user.id, 'send_coaching_evaluation_message', 'coaching_evaluations', ev.id);
    return { conversation_id: convId, message_id: m.id, attachment_id: att.id, filename: pdfName(title) };
  },
});

// ------------------------------------------------------------------ the athlete (or a young person's guardian)

cap({
  name: 'my_coaching_evaluations', method: 'GET', path: '/me/coaching-evaluations', tag: TAG, auth: 'user',
  summary: 'Evaluations your coaches shared with you, and those shared about a young person you are a verified guardian of (pass athlete_id), plus self-assessments your coach asked for. For a young person they show only while a guardian\'s coaching consent is in force. Each row says what is waiting on you.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id && !(await viewerOf(user, { athlete_id: athleteId }))) throw notFound('Athlete');
    if ((await isYouth(athleteId)) && !(await hasConsent(athleteId, 'coaching'))) return [];
    const rows = await many(
      `SELECT e.id, e.title, e.status, e.context_type, e.shared_at, e.responded_at, e.acknowledged_at, e.closed_at, e.self_requested, e.self_submitted_at, e.latest_version, e.rubric_id, u.display_name AS coach_name,
              (SELECT snapshot->'summary'->>'overall' FROM coaching_evaluation_versions v WHERE v.evaluation_id=e.id ORDER BY version DESC LIMIT 1)::float AS overall
         FROM coaching_evaluations e JOIN users u ON u.id=e.coach_id WHERE e.athlete_id=$1 AND (e.latest_version > 0 OR (e.self_requested AND e.status='draft')) ORDER BY coalesce(e.shared_at, e.created_at) DESC, e.id LIMIT $2 OFFSET $3`, [athleteId, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, waiting_on_you: r.closed_at ? null : r.latest_version === 0 ? 'self_assessment' : !r.responded_at ? 'response' : !r.acknowledged_at ? 'acknowledge' : null }));
  },
});

async function athleteView(user, evId) {
  const raw = await one('SELECT * FROM coaching_evaluations WHERE id=$1', [evId]);
  if (!raw) throw notFound('Evaluation');
  // before the first share the athlete sees only the sheet they were asked to rate themselves on
  if (!raw.latest_version) {
    const as = raw.self_requested && !raw.closed_at ? await viewerOf(user, raw) : null;
    if (!as) throw notFound('Evaluation');
    if ((await isYouth(raw.athlete_id)) && !(await hasConsent(raw.athlete_id, 'coaching'))) throw notFound('Evaluation');
    const sheet = await sheetVersion(raw.rubric_id, raw.rubric_version);
    const v = view({ ...raw, scores: {}, narrative: {} }, sheet.dimensions, {});
    return { ...v, stage: 'self_assessment', viewer: as, sheet: { id: sheet.id, name: sheet.name, version: sheet.version }, thread: [] };
  }
  const { ev, as } = await sharedEval(user, evId);
  const snap = await latestSnapshot(ev.id);
  const v = view({ ...ev, scores: snap.snapshot.scores, narrative: snap.snapshot.narrative, latest_version: snap.version }, snap.snapshot.dimensions, { previous: snap.snapshot.previous ? { scores: snap.snapshot.previous } : null });
  const thread = await many('SELECT m.id, m.author_role, m.criterion_key, m.body, m.created_at, u.display_name AS author FROM coaching_evaluation_messages m JOIN users u ON u.id=m.author_id WHERE m.evaluation_id=$1 ORDER BY m.created_at, m.id', [ev.id]);
  const coach = await one('SELECT display_name FROM users WHERE id=$1', [ev.coach_id]);
  return { ...v, stage: 'shared', viewer: as, sheet: snap.snapshot.sheet, coach_name: coach.display_name, shared_note: snap.snapshot.note, thread };
}

cap({
  name: 'get_my_coaching_evaluation', method: 'GET', path: '/me/coaching-evaluations/:id', tag: TAG, auth: 'user',
  summary: 'One evaluation as the athlete (or a guardian) sees it: the version the coach shared, with the sheet, scores, comments, evidence, written feedback, your own self-assessment and response, and the thread. Never the coach\'s private note. Before the first share it is just the sheet you were asked to rate yourself on.',
  input: z.object({ id }),
  handler: ({ user }, i) => athleteView(user, i.id),
});

cap({
  name: 'submit_evaluation_self_assessment', method: 'POST', path: '/me/coaching-evaluations/:id/self', tag: TAG, auth: 'user',
  summary: 'Rate yourself (or, as a guardian, the young person) on the same criteria, with an optional comment each. Allowed when your coach asked for it, or after they shared the evaluation, until it is closed. Your own scores are shown beside your coach\'s once shared, so the gaps are easy to talk about.',
  input: z.object({ id, scores: z.record(z.string(), z.object({ score: z.number().nullable().optional(), comment: text(1000).nullable().optional() })) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = (await c.query('SELECT * FROM coaching_evaluations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const as = ev ? await viewerOf(user, ev) : null;
      if (!as || ev.closed_at || (!ev.self_requested && !ev.latest_version)) throw notFound('Evaluation');
      if ((await isYouth(ev.athlete_id)) && !(await hasConsent(ev.athlete_id, 'coaching'))) throw notFound('Evaluation');
      const sheet = await sheetVersion(ev.rubric_id, ev.rubric_version);
      checkScores(sheet.dimensions, i.scores);
      const merged = mergeScores(ev.self_scores, i.scores);
      await c.query('UPDATE coaching_evaluations SET self_scores=$2, self_submitted_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1', [ev.id, JSON.stringify(merged)]);
      await notify(c, ev.coach_id, { kind: 'evaluation_self_submitted', title: 'Self-assessment received', body: `Your athlete rated themselves for "${ev.title}".`, data: { evaluation_id: ev.id } });
      return { id: ev.id, scored: Object.values(merged).filter((x) => x.score != null).length };
    });
  },
});

cap({
  name: 'respond_to_coaching_evaluation', method: 'POST', path: '/me/coaching-evaluations/:id/respond', tag: TAG, auth: 'user',
  summary: 'Answer a shared evaluation: for each criterion say whether you agree, want to talk about it, or disagree; add an overall comment and any questions. Your coach is told and can reply in the thread. Replying again updates your answer.',
  input: z.object({ id, reactions: z.record(z.string(), z.enum(REACTIONS)).optional(), comment: text(2000).nullable().optional(), questions: text(2000).nullable().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, as } = await (async () => { const e = (await c.query('SELECT * FROM coaching_evaluations WHERE id=$1 FOR UPDATE', [i.id])).rows[0]; if (!e || !e.latest_version) throw notFound('Evaluation'); const a = await viewerOf(user, e); if (!a) throw notFound('Evaluation'); return { ev: e, as: a }; })();
      if (ev.closed_at) throw conflict('This evaluation is closed');
      if ((await isYouth(ev.athlete_id)) && !(await hasConsent(ev.athlete_id, 'coaching'))) throw notFound('Evaluation');
      const sheet = await sheetVersion(ev.rubric_id, ev.rubric_version);
      for (const k of Object.keys(i.reactions ?? {})) if (!sheet.dimensions.some((d) => d.key === k)) throw badRequest(`Unknown criterion ${k}`);
      const response = { ...ev.response, reactions: { ...(ev.response?.reactions ?? {}), ...(i.reactions ?? {}) }, ...(i.comment !== undefined ? { comment: i.comment } : {}), ...(i.questions !== undefined ? { questions: i.questions } : {}) };
      await c.query("UPDATE coaching_evaluations SET response=$2, responded_at=now(), status=CASE WHEN status='shared' THEN 'responded' ELSE status END, row_version=row_version+1, updated_at=now() WHERE id=$1", [ev.id, JSON.stringify(response)]);
      for (const body of [i.comment && `Comment: ${i.comment}`, i.questions && `Question: ${i.questions}`].filter(Boolean)) await c.query('INSERT INTO coaching_evaluation_messages(evaluation_id, author_id, author_role, body) VALUES ($1,$2,$3,$4)', [ev.id, user.id, as, body]);
      const disagree = Object.values(response.reactions).filter((x) => x === 'disagree').length, talk = Object.values(response.reactions).filter((x) => x === 'discuss').length;
      await notify(c, ev.coach_id, { kind: 'evaluation_responded', title: 'Your athlete responded to an evaluation', body: `"${ev.title}": ${disagree} to disagree on, ${talk} to discuss.${i.questions ? ' They have a question.' : ''}`, data: { evaluation_id: ev.id } });
      await audit(c, user.id, 'respond_coaching_evaluation', 'coaching_evaluations', ev.id);
      return { id: ev.id, status: ev.status === 'shared' ? 'responded' : ev.status };
    });
  },
});

cap({
  name: 'acknowledge_coaching_evaluation', method: 'POST', path: '/me/coaching-evaluations/:id/acknowledge', tag: TAG, auth: 'user',
  summary: 'Say you have read and understood a shared evaluation (a guardian can do it for a young person). It is a record that it was received, not agreement; your reactions say what you agree with.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = (await c.query('SELECT * FROM coaching_evaluations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ev || !ev.latest_version || !(await viewerOf(user, ev))) throw notFound('Evaluation');
      if (ev.acknowledged_at) return { id: ev.id, acknowledged_at: ev.acknowledged_at, replayed: true };
      const row = (await c.query('UPDATE coaching_evaluations SET acknowledged_at=now(), acknowledged_by=$2, updated_at=now() WHERE id=$1 RETURNING acknowledged_at', [ev.id, user.id])).rows[0];
      await notify(c, ev.coach_id, { kind: 'evaluation_acknowledged', title: 'Evaluation acknowledged', body: `"${ev.title}" was read.`, data: { evaluation_id: ev.id } });
      return { id: ev.id, acknowledged_at: row.acknowledged_at };
    });
  },
});
