// One coaching workspace for every kind of session a coach runs (class, 1:1 booking, academy session, game, team session). It sits on the coaching
// journal's own record, so the plan, attendance, notes, scores and summaries are the ones the coach already uses: nothing is copied. What it adds is
// one way in whatever the source is, sharing the plan with the people in the session, the people's own read of it, and plan reuse across sessions.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { isYouth, guardiansOf } from '../youth.js';
import { hasConsent } from '../youth.js';
import { openSession, savePlan, ownRecord } from './coaching-journal.js';
import { sharedOutputs } from '../coaching-workspace.js';
import { requireRelationship } from '../coaching.js';
import { createEvaluation } from './coaching-evaluations.js';
import { AppError } from '../errors.js';
import { audit } from '../helpers.js';
import { aiConfigured, askJson, quoteData, AI_RULES } from '../ai.js';

const TAG = 'Coaching workspace';
const COACH = ['coach'];
const SOURCES = ['training_session', 'coach_hire', 'fixture', 'team_session', 'academy_session', 'coach_class'];

/** Length of the session when its source knows it (class, booking, academy session); games and team sessions have none, so the screen shows no time budget. */
async function durationOf(rec) {
  if (rec.source_type === 'coach_class') return (await one('SELECT duration_min FROM coach_classes WHERE id::text=$1', [rec.source_id]))?.duration_min ?? null;
  if (rec.source_type === 'coach_hire') return (await one('SELECT duration_min FROM coach_hires WHERE id::text=$1', [rec.source_id]))?.duration_min ?? null;
  return null;
}

async function roster(rec) {
  const rows = await many(
    `SELECT p.athlete_id AS user_id, p.attendance, u.display_name, u.avatar_emoji, u.avatar_color, (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS is_youth,
            (SELECT count(*)::int FROM coaching_observations o WHERE o.session_record_id=$1 AND o.athlete_id=p.athlete_id) AS notes,
            (SELECT o.score FROM coaching_observations o WHERE o.session_record_id=$1 AND o.athlete_id=p.athlete_id AND o.score IS NOT NULL ORDER BY o.observed_at DESC LIMIT 1) AS last_score,
            s.summary, coalesce(s.shared, false) AS summary_shared,
            (SELECT count(*)::int FROM coaching_session_participants q JOIN coaching_session_records qr ON qr.id=q.session_record_id WHERE qr.coach_id=$2 AND q.athlete_id=p.athlete_id AND q.attendance IN ('present','late','left_early')) AS sessions_attended,
            (SELECT count(*)::int FROM coaching_session_participants q JOIN coaching_session_records qr ON qr.id=q.session_record_id WHERE qr.coach_id=$2 AND q.athlete_id=p.athlete_id AND q.attendance <> 'expected') AS sessions_recorded,
            (SELECT e.status FROM coaching_evaluations e WHERE e.session_record_id=$1 AND e.athlete_id=p.athlete_id ORDER BY e.updated_at DESC LIMIT 1) AS evaluation_status,
            (SELECT z.id FROM coach_class_seats z WHERE $3 = 'coach_class' AND z.class_id::text=$4 AND z.user_id=p.athlete_id AND z.status='confirmed') AS seat_id,
            (SELECT count(*)::int FROM coaching_goals g WHERE g.coach_id=$2 AND g.athlete_id=p.athlete_id AND g.status IN ('planned','active')) AS open_goals
       FROM coaching_session_participants p JOIN users u ON u.id=p.athlete_id LEFT JOIN coaching_player_summaries s ON s.session_record_id=$1 AND s.athlete_id=p.athlete_id
      WHERE p.session_record_id=$1 ORDER BY u.display_name, p.athlete_id`, [rec.id, rec.coach_id, rec.source_type, rec.source_id]);
  return Promise.all(rows.map(async ({ sessions_attended, sessions_recorded, ...r }) => ({ ...r, sessions_attended, sessions_recorded, attendance_rate: sessions_recorded ? Math.round((sessions_attended / sessions_recorded) * 100) : null, can_share: r.is_youth ? await hasConsent(r.user_id, 'coaching') : true })));  // a young person's notes and summaries are shared only under a guardian's current coaching consent
}

cap({
  name: 'open_coaching_workspace', method: 'POST', path: '/coaching/workspace', tag: TAG, auth: COACH,
  summary: 'Coach: open the workspace of any session you run, from whatever it came from (a class, a 1:1 or team booking, an academy session, a game, a team session or a plan session). Creates the coaching record on first use (repeating returns the same one) and returns it with the current plan, whether and which version is shared, the people in it with attendance, notes, last score, summary state and open goals, the evaluations already started from it, and earlier plans of yours you can reuse. The server decides access from the source; the client never says who is in the session.',
  input: z.object({ source_type: z.enum(SOURCES), source_id: z.string().max(80), team_id: id.optional().describe('required for fixture and team_session'), title: z.string().trim().min(2).max(120).optional() }),
  async handler({ user }, i) {
    const rec = await openSession(user, i);
    const plan = await one('SELECT version, blocks, created_at FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]);
    const evaluations = await many('SELECT e.id, e.title, e.status, e.athlete_id, e.rubric_id, e.updated_at FROM coaching_evaluations e WHERE e.session_record_id=$1 AND e.coach_id=$2 ORDER BY e.updated_at DESC', [rec.id, user.id]);
    const copy_from = await many(
      `SELECT r.id AS record_id, r.title, r.source_type, r.scheduled_at, r.plan_version FROM coaching_session_records r
        WHERE r.coach_id=$1 AND r.id <> $2 AND r.plan_version > 0 ORDER BY coalesce(r.scheduled_at, r.created_at) DESC LIMIT 30`, [user.id, rec.id]);
    const duration_min = await durationOf(rec);
    return {
      block_log: rec.block_log, started_at: rec.started_at, ended_at: rec.ended_at, phase: rec.status,
      duration_min, locked: ['completed', 'cancelled'].includes(rec.status),
      record_id: rec.id, source_type: rec.source_type, source_id: rec.source_id, title: rec.title, objective: rec.objective, status: rec.status, scheduled_at: rec.scheduled_at, sport_id: rec.sport_id, team_id: rec.team_id,
      plan: plan ?? { version: 0, blocks: [] },
      shared: rec.plan_shared_version != null, shared_version: rec.plan_shared_version, shared_at: rec.plan_shared_at, plan_changed_since_share: rec.plan_shared_version != null && rec.plan_shared_version !== rec.plan_version,
      roster: await roster(rec), evaluations, copy_from,
    };
  },
});

cap({
  name: 'share_coaching_plan', method: 'POST', path: '/coaching/sessions/:id/plan/share', tag: TAG, auth: COACH,
  summary: 'Coach: share the current plan of any of your sessions with the people in it (and a young person\'s guardian), or stop sharing. Only the objective and blocks are shared, never private coach notes. Sharing again after an edit publishes the new version; people are told once per version.',
  input: z.object({ id, share: z.boolean() }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    if (rec.status === 'cancelled') throw conflict('This session was cancelled');
    if (i.share && !rec.plan_version) throw badRequest('Save a plan first', { code: 'no_plan' });
    return tx(async (c) => {
      const row = (await c.query(
        i.share
          ? 'UPDATE coaching_session_records SET plan_shared_version=plan_version, plan_shared_at=now(), plan_shared_by=$2, updated_at=now() WHERE id=$1 RETURNING plan_shared_version, plan_shared_at'
          : 'UPDATE coaching_session_records SET plan_shared_version=NULL, plan_shared_at=NULL, plan_shared_by=NULL, updated_at=now() WHERE id=$1 AND $2::uuid IS NOT NULL RETURNING plan_shared_version, plan_shared_at',
        [rec.id, user.id])).rows[0];
      let told = 0;
      if (i.share) {
        for (const p of (await c.query('SELECT athlete_id FROM coaching_session_participants WHERE session_record_id=$1', [rec.id])).rows) {
          const to = (await isYouth(p.athlete_id)) ? await guardiansOf(p.athlete_id) : [p.athlete_id];
          for (const u of new Set(to)) { await notify(c, u, { kind: 'coaching_plan_shared', title: 'Session plan shared', body: `Your coach shared the plan for "${rec.title}".`, data: { record_id: rec.id }, dedupe_key: `cs_plan:${rec.id}:${p.athlete_id}:${row.plan_shared_version}:${u}` }); told++; }
        }
      }
      return { record_id: rec.id, shared: row.plan_shared_version != null, shared_version: row.plan_shared_version, shared_at: row.plan_shared_at, told };
    });
  },
});

cap({
  name: 'copy_coaching_plan', method: 'POST', path: '/coaching/sessions/:id/plan/copy', tag: TAG, auth: COACH,
  summary: 'Coach: start this session\'s plan from the current plan of another of your sessions (any kind). The blocks become a new version here, keeping where each block came from; the other session is untouched and nothing is shared until you share it.',
  input: z.object({ id, from_record_id: id }),
  async handler({ user }, i) {
    if (i.from_record_id === i.id) throw badRequest('Choose a different session');
    const to = await ownRecord(user, i.id);
    const from = await ownRecord(user, i.from_record_id);
    const src = await one('SELECT v.blocks FROM coaching_session_plan_versions v WHERE v.session_record_id=$1 AND v.version=$2', [from.id, from.plan_version]);
    if (!src) throw notFound('Plan');
    return savePlan(user, to.id, src.blocks.map(({ id: _drop, ...b }) => b), { objective: from.objective ?? undefined });
  },
});

cap({
  name: 'get_coaching_shared_plan', method: 'GET', path: '/coaching/sessions/:id/shared', tag: TAG, auth: 'user',
  summary: 'For someone in a coaching session (or a guardian of a young person in it): the plan the coach shared, your attendance, the summary written for you and the evaluations the coach shared, whatever the session came from. Returns shared=false until the coach shares. Anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const rec = await one('SELECT * FROM coaching_session_records WHERE id=$1', [i.id]);
    const out = rec ? await sharedOutputs(user, rec) : null;
    if (!out) throw notFound('Session');
    return out;
  },
});

// ---------------------------------------------------------------- scoring: the coach's own evaluation sheet, per person, per skill, in any session

async function sheetOf(coachId, rubricId) {
  const r = await one('SELECT r.id, r.name, v.version, v.dimensions FROM coaching_rubrics r JOIN LATERAL (SELECT * FROM coaching_rubric_versions x WHERE x.rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true WHERE r.id=$1 AND r.coach_id=$2 AND r.archived_at IS NULL', [rubricId, coachId]);
  if (!r) throw notFound('Evaluation sheet');
  return r;
}

cap({
  name: 'get_coaching_session_scores', method: 'GET', path: '/coaching/sessions/:id/scores', tag: TAG, auth: COACH,
  summary: 'Coach: the scoring grid of any of your sessions for one of your evaluation sheets. For each person in the session: the score given here for every skill, the earlier scores for the same skill (oldest to newest, up to six) and the change since the last time. The scores are the coach\'s own judgement and nothing is ranked.',
  input: z.object({ id, rubric_id: id }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    const sheet = await sheetOf(rec.coach_id, i.rubric_id);
    const people = await many('SELECT p.athlete_id, u.display_name FROM coaching_session_participants p JOIN users u ON u.id=p.athlete_id WHERE p.session_record_id=$1 ORDER BY u.display_name, p.athlete_id', [rec.id]);
    const obs = people.length ? await many(
      `SELECT o.athlete_id, o.dimension_key, o.score::float AS score, (o.session_record_id=$3) AS here FROM coaching_observations o
        WHERE o.coach_id=$1 AND o.rubric_id=$2 AND o.athlete_id = ANY($4::uuid[]) AND o.score IS NOT NULL ORDER BY o.observed_at, o.id`, [rec.coach_id, sheet.id, rec.id, people.map((p) => p.athlete_id)]) : [];
    const rows = people.map((p) => {
      const mine = obs.filter((o) => o.athlete_id === p.athlete_id);
      const dims = {};
      for (const d of sheet.dimensions) {
        const series = mine.filter((o) => o.dimension_key === d.key);
        const here = series.filter((o) => o.here).at(-1) ?? null;
        const before = series.filter((o) => !o.here).map((o) => o.score);
        dims[d.key] = { score: here?.score ?? null, history: before.slice(-6), change: here && before.length ? Math.round((here.score - before.at(-1)) * 100) / 100 : null };
      }
      return { athlete_id: p.athlete_id, display_name: p.display_name, dimensions: dims };
    });
    return { record_id: rec.id, rubric: { id: sheet.id, name: sheet.name, version: sheet.version, dimensions: sheet.dimensions }, rows };
  },
});

cap({
  name: 'score_coaching_session', method: 'POST', path: '/coaching/sessions/:id/scores', tag: TAG, auth: COACH,
  summary: 'Coach: save scores for the people in any of your sessions on the skills of one of your evaluation sheets (a score within the skill\'s own scale). Each becomes a private coaching observation tied to this session and the sheet version; re-scoring adds a newer score and keeps the old one. Only people in the session can be scored, and a young person only while a guardian allows it. Scoring shares nothing.',
  input: z.object({ id, rubric_id: id, scores: z.array(z.object({ athlete_id: id, dimension_key: z.string().max(40), score: z.number() })).min(1).max(500) }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    if (rec.status === 'cancelled') throw conflict('This session was cancelled');
    const sheet = await sheetOf(rec.coach_id, i.rubric_id);
    const inside = new Set((await many('SELECT athlete_id FROM coaching_session_participants WHERE session_record_id=$1', [rec.id])).map((r) => r.athlete_id));
    const dims = new Map(sheet.dimensions.map((d) => [d.key, d]));
    for (const s of i.scores) {
      const d = dims.get(s.dimension_key);
      if (!d) throw badRequest(`Unknown skill ${s.dimension_key}`);
      if (!inside.has(s.athlete_id)) throw badRequest('Someone you scored is not in this session');
      if (s.score < d.scale_min || s.score > d.scale_max) throw badRequest(`${d.name}: score must be between ${d.scale_min} and ${d.scale_max}`);
    }
    for (const a of new Set(i.scores.map((s) => s.athlete_id))) await requireRelationship({ ...user, id: rec.coach_id }, a);
    return tx(async (c) => {
      let saved = 0;
      for (const s of i.scores) {
        const d = dims.get(s.dimension_key);
        const last = (await c.query('SELECT score::float AS score FROM coaching_observations WHERE coach_id=$1 AND athlete_id=$2 AND session_record_id=$3 AND rubric_id=$4 AND dimension_key=$5 AND score IS NOT NULL ORDER BY observed_at DESC, id DESC LIMIT 1', [rec.coach_id, s.athlete_id, rec.id, sheet.id, d.key])).rows[0];
        if (last && last.score === s.score) continue;   // the same score again is not a new fact
        await c.query(
          `INSERT INTO coaching_observations(coach_id, athlete_id, sport_id, session_record_id, obs_type, skill_tag, note, visibility, rubric_id, rubric_version, dimension_key, score)
           VALUES ($1,$2,$3,$4,'technical',$5,$6,'coach_private',$7,$8,$9,$10)`, [rec.coach_id, s.athlete_id, rec.sport_id, rec.id, d.name.slice(0, 60), `${d.name}: ${s.score}`, sheet.id, sheet.version, d.key, s.score]);
        saved++;
      }
      return { saved, record_id: rec.id };
    });
  },
});

// ---------------------------------------------------------------- evaluate everyone in a session on one sheet

const EVAL_CONTEXT = { coach_class: 'class', coach_hire: 'booking', academy_session: 'academy', fixture: 'game' };
const ratio = (d, v) => { const f = (v - d.scale_min) / ((d.scale_max - d.scale_min) || 1); return d.direction === 'lower_is_better' ? 1 - f : f; };

/** A first draft of the written feedback from the scores alone: strongest criteria and the next focus. Plain statements of what was scored, nothing invented. */
function narrativeFromScores(dims, scores) {
  const rows = dims.filter((d) => scores[d.key]?.score != null).map((d) => ({ d, v: scores[d.key].score, r: ratio(d, scores[d.key].score) }));
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.r - a.r);
  const strong = sorted.filter((x) => x.r >= 0.7).slice(0, 2), weak = [...sorted].reverse().filter((x) => x.r <= 0.6 && !strong.includes(x)).slice(0, 2);
  const fmt = (x) => `${x.d.name} (${x.v} of ${x.d.scale_max})`;
  const out = {};
  if (strong.length) out.strengths = `Strongest in this session: ${strong.map(fmt).join(', ')}.`;
  if (weak.length) { out.development = `Most room to grow: ${weak.map(fmt).join(', ')}.`; out.next_steps = `Give ${weak.map((x) => x.d.name).join(' and ')} more focus in the next sessions.`; }
  return Object.keys(out).length ? out : null;
}

const aiNarrativeSchema = z.object({ strengths: z.string().max(600), development: z.string().max(600), next_steps: z.string().max(600) });
async function aiNarrative(dims, scores, draft) {
  const facts = dims.filter((d) => scores[d.key]?.score != null).map((d) => ({ criterion: quoteData(d.name, 60), score: scores[d.key].score, scale: [d.scale_min, d.scale_max], higher_is_better: d.direction !== 'lower_is_better' }));
  const out = await askJson({
    system: `You help a sports coach draft written feedback for one athlete after a session. ${AI_RULES} Use only the scores given; do not mention a name; do not give medical advice; be specific, kind and practical. Start from this plain draft and improve the wording: ${JSON.stringify(draft ?? {})}`,
    user: `<data>${JSON.stringify(facts)}</data>`, schema: aiNarrativeSchema, shape: '{"strengths": string, "development": string, "next_steps": string}', maxTokens: 700,
  });
  return out ? { ...out, ai_drafted: true } : null;
}

cap({
  name: 'generate_session_evaluations', method: 'POST', path: '/coaching/sessions/:id/evaluations', tag: TAG, auth: COACH, status: 201,
  summary: 'Start an evaluation for everyone in one of your sessions (or the athletes you name) on one of your evaluation sheets, in one go. Each draft starts from the scores already given in the session and, with draft_narrative, a first draft of the written feedback built from those scores (strongest criteria, next focus). With use_ai (and AI configured) a model improves that wording from the scores only, never a name; such a draft must be confirmed (confirm_reviewed) before it is shared with the athlete. Existing evaluations on the same sheet are kept, not duplicated; anyone you may not evaluate (no coaching relationship, a young person without a guardian\'s consent) is listed as skipped with the reason. Nothing is shared by generating.',
  input: z.object({ id, rubric_id: id, athlete_ids: z.array(id).max(200).optional(), draft_narrative: z.boolean().default(true), use_ai: z.boolean().default(false), request_self_assessment: z.boolean().default(false) }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    if (rec.status === 'cancelled') throw conflict('This session was cancelled');
    const sheet = await sheetOf(rec.coach_id, i.rubric_id);
    let people = await many('SELECT p.athlete_id, u.display_name FROM coaching_session_participants p JOIN users u ON u.id=p.athlete_id WHERE p.session_record_id=$1 ORDER BY u.display_name, p.athlete_id', [rec.id]);
    if (i.athlete_ids?.length) {
      const want = new Set(i.athlete_ids);
      if (!i.athlete_ids.every((a) => people.some((p) => p.athlete_id === a))) throw badRequest('Someone you named is not in this session');
      people = people.filter((p) => want.has(p.athlete_id));
    }
    if (!people.length) throw badRequest('Nobody in this session to evaluate');
    const out = { created: 0, existing: 0, skipped: [], evaluations: [] };
    let usedAi = false;
    for (const p of people) {
      const have = await one('SELECT id, status, narrative FROM coaching_evaluations WHERE coach_id=$1 AND session_record_id=$2 AND athlete_id=$3 AND rubric_id=$4 ORDER BY created_at LIMIT 1', [user.id, rec.id, p.athlete_id, sheet.id]);
      if (have) { out.existing++; out.evaluations.push({ id: have.id, athlete_id: p.athlete_id, display_name: p.display_name, status: have.status, ai_drafted: !!have.narrative?.ai_drafted, created: false }); continue; }
      let ev;
      try { ev = await createEvaluation(user, { athlete_id: p.athlete_id, rubric_id: sheet.id, context_type: EVAL_CONTEXT[rec.source_type] ?? 'session', session_record_id: rec.id, request_self_assessment: i.request_self_assessment }); }
      catch (e) { if (e instanceof AppError) { out.skipped.push({ athlete_id: p.athlete_id, display_name: p.display_name, reason: e.message }); continue; } throw e; }
      let narrative = null;
      if (i.draft_narrative) {
        const scores = (await one('SELECT scores FROM coaching_evaluations WHERE id=$1', [ev.id])).scores ?? {};
        narrative = narrativeFromScores(sheet.dimensions, scores);
        if (narrative && i.use_ai && aiConfigured()) { const better = await aiNarrative(sheet.dimensions, scores, narrative); if (better) { narrative = better; usedAi = true; } }
        if (narrative) await one('UPDATE coaching_evaluations SET narrative = narrative || $2::jsonb, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id', [ev.id, JSON.stringify(narrative)]);
      }
      out.created++;
      out.evaluations.push({ id: ev.id, athlete_id: p.athlete_id, display_name: p.display_name, status: 'draft', ai_drafted: !!narrative?.ai_drafted, has_narrative: !!narrative, created: true });
    }
    if (usedAi) await audit(null, user.id, 'ai_evaluation_draft', 'coaching_session_records', rec.id);
    return { record_id: rec.id, rubric: { id: sheet.id, name: sheet.name }, ...out, ai_used: usedAi, ai_available: aiConfigured() };
  },
});
