import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, sportBySlugOrId } from '../helpers.js';
import { requireRelationship, requireCoachingConsent, relationships, sessionKinds } from '../coaching.js';
import { isYouth, guardianLink, hasConsent } from '../youth.js';
import { phasesIn, validatePhases, buildWeeks, sessionLoad, FOCUS } from '../training-load.js';
import { renderTrainingPlan } from '../documents/training-plan-pdf.js';
import { audit } from '../helpers.js';
import { structureIn, actualsIn, validateStructure, validateActuals, summarize, compare, rulesFor } from '../workout-structure.js';
import { notify } from '../notify.js';

const TAG = 'Training plans';
const sessionIn = z.object({
  session_id: id.optional().describe('existing scheduled session being moved/edited; omit to add a new one'),
  starts_at: z.string().datetime({ offset: true }),
  duration_min: z.number().int().min(15).max(480),
  kind: z.enum(sessionKinds),
  title: z.string().min(2).max(120),
  instructions: z.string().max(2000).optional(),
  target_rpe: z.number().int().min(1).max(10).optional().describe('non-clinical perceived-effort target'),
  objective: z.string().max(300).optional().describe('what this session is for, e.g. repeat-sprint ability'),
  focus: z.enum(FOCUS).optional(),
  blocks: structureIn.optional().describe('structured workout: sets/reps, intervals, rest, distance, pace/power zones and demonstration links'),
});
const content = z.object({
  targets: z.array(z.object({ label: z.string().min(1).max(120), value: z.string().max(120).optional() })).max(20).default([]),
  sessions: z.array(sessionIn).max(100).default([]),
  phases: phasesIn.default([]).describe('periodisation: preparation, pre-competition, competition, transition or return-to-play, with dates and focus'),
});

const isParty = (u, p) => u.id === p.coach_id || u.id === p.athlete_id || isAdmin(u);

const sportOf = async (c, sportId) => (sportId ? (await c.query('SELECT slug, name, scoring FROM sports WHERE id=$1', [sportId])).rows[0] : null);
/** Every structured session is checked against the plan's sport (distance, pace and power units) before it is stored. */
const checkBlocks = (sessions, sport, phases = []) => { validatePhases(phases); for (const s of sessions) if (s.blocks) validateStructure(s.blocks, sport); };

async function lockPlan(c, planId) {
  const p = (await c.query('SELECT * FROM training_plans WHERE id=$1 FOR UPDATE', [planId])).rows[0];
  if (!p) throw notFound('Training plan');
  return p;
}
const coachOnly = (u, p) => { if (u.id !== p.coach_id) throw forbidden('Only the plan\'s coach can do this'); };
const latest = async (c, p) => (await c.query('SELECT * FROM training_plan_revisions WHERE plan_id=$1 AND rev=$2', [p.id, p.current_rev])).rows[0];

async function checkSessions(c, planId, sessions) {
  const ids = sessions.map((s) => s.session_id).filter(Boolean);
  if (ids.length) {
    const ok = (await c.query("SELECT id FROM training_sessions WHERE plan_id=$1 AND id = ANY($2::uuid[]) AND status='scheduled' AND starts_at > now()", [planId, ids])).rows.length;
    if (ok !== new Set(ids).size) throw badRequest('Only future, scheduled sessions of this plan can be changed — completed history is never rewritten');
  }
  if (sessions.some((s) => !s.session_id && Date.parse(s.starts_at) <= Date.now())) throw badRequest('New sessions must be in the future');
}

cap({
  name: 'create_training_plan', method: 'POST', path: '/training-plans', tag: TAG, status: 201,
  summary: 'Coach drafts a training plan for an athlete they actively coach (confirmed hire, shared team, led cohort or accepted plan). Nothing reaches the athlete until proposed.',
  input: z.object({ athlete_id: id, sport: z.string(), title: z.string().min(2).max(120), goal: z.string().max(1000).optional(), hire_id: id.optional(), content: content.optional() }),
  async handler({ user }, i) {
    await requireRelationship(user, i.athlete_id);
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    if (i.hire_id && !(await one("SELECT 1 FROM coach_hires WHERE id=$1 AND coach_id=$2 AND hirer_id=$3 AND status IN ('confirmed','completed')", [i.hire_id, user.id, i.athlete_id]))) throw badRequest('That hire is not yours with this athlete');
    const body = content.parse(i.content ?? {});
    if (body.sessions.some((s) => s.session_id)) throw badRequest('A new plan has no existing sessions');
    if (body.sessions.some((s) => Date.parse(s.starts_at) <= Date.now())) throw badRequest('Sessions must be in the future');
    checkBlocks(body.sessions, sport, body.phases);
    return tx(async (c) => {
      const p = (await c.query('INSERT INTO training_plans(coach_id, athlete_id, sport_id, hire_id, title, goal) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [user.id, i.athlete_id, sport.id, i.hire_id, i.title, i.goal])).rows[0];
      await c.query('INSERT INTO training_plan_revisions(plan_id, rev, title, goal, content) VALUES ($1,1,$2,$3,$4)', [p.id, i.title, i.goal, JSON.stringify(body)]);
      return p;
    });
  },
});

cap({
  name: 'edit_training_plan_draft', method: 'PATCH', path: '/training-plans/:id/draft', tag: TAG,
  summary: 'Coach edits the open draft revision (proposed revisions are immutable).',
  input: z.object({ id, title: z.string().min(2).max(120).optional(), goal: z.string().max(1000).optional(), content: content.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await lockPlan(c, i.id);
      coachOnly(user, p);
      if (p.status === 'closed') throw conflict('Plan is closed');
      const r = await latest(c, p);
      if (r.response !== 'draft') throw conflict('There is no open draft — start a revision first');
      await requireRelationship(user, p.athlete_id);
      const body = i.content ? content.parse(i.content) : r.content;
      if (i.content) { await checkSessions(c, p.id, body.sessions); checkBlocks(body.sessions, await sportOf(c, p.sport_id), body.phases); }
      return (await c.query('UPDATE training_plan_revisions SET title=coalesce($3,title), goal=coalesce($4,goal), content=$5 WHERE plan_id=$1 AND rev=$2 RETURNING *', [p.id, r.rev, i.title, i.goal, JSON.stringify(body)])).rows[0];
    });
  },
});

cap({
  name: 'start_training_plan_revision', method: 'POST', path: '/training-plans/:id/revisions', tag: TAG, status: 201,
  summary: 'Coach opens a new draft revision from the latest content. Allowed once the previous revision has been answered (or on an accepted plan).',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await lockPlan(c, i.id);
      coachOnly(user, p);
      if (p.status === 'closed') throw conflict('Plan is closed');
      const r = await latest(c, p);
      if (['draft', 'pending'].includes(r.response)) throw conflict(`Revision ${r.rev} is still ${r.response}`);
      await requireRelationship(user, p.athlete_id);
      // start from the live (accepted) content when there is one, else from the answered draft
      const base = p.accepted_rev ? (await c.query('SELECT * FROM training_plan_revisions WHERE plan_id=$1 AND rev=$2', [p.id, p.accepted_rev])).rows[0] : r;
      const rev = p.current_rev + 1;
      // on an accepted plan the draft starts from the live future sessions (with their ids and workout blocks), so accepting it
      // moves them instead of scheduling copies; completed and skipped history is never part of a draft
      const live = p.accepted_rev ? (await c.query("SELECT * FROM training_sessions WHERE plan_id=$1 AND status='scheduled' AND starts_at > now() ORDER BY starts_at, id", [p.id])).rows : null;
      const seed = live ? { ...base.content, sessions: live.map((x) => ({ session_id: x.id, starts_at: x.starts_at.toISOString(), duration_min: x.duration_min, kind: x.kind, title: x.title, instructions: x.instructions ?? undefined, target_rpe: x.target_rpe ?? undefined, objective: x.objective ?? undefined, focus: x.focus ?? undefined, blocks: x.structure ?? undefined })) } : base.content;
      await c.query('UPDATE training_plans SET current_rev=$2, updated_at=now() WHERE id=$1', [p.id, rev]);
      return (await c.query('INSERT INTO training_plan_revisions(plan_id, rev, title, goal, content) VALUES ($1,$2,$3,$4,$5) RETURNING *', [p.id, rev, base.title, base.goal, JSON.stringify(seed)])).rows[0];
    });
  },
});

cap({
  name: 'propose_training_plan', method: 'POST', path: '/training-plans/:id/propose', tag: TAG,
  summary: 'Coach sends the open draft revision to the athlete, who must accept, decline or ask for changes.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await lockPlan(c, i.id);
      coachOnly(user, p);
      if (p.status === 'closed') throw conflict('Plan is closed');
      const r = await latest(c, p);
      if (r.response !== 'draft') throw conflict('There is no draft to propose');
      await requireRelationship(user, p.athlete_id);
      if (!r.content.sessions?.length) throw badRequest('Add at least one session before proposing');
      if (r.content.sessions.some((s) => s.blocks?.length)) await requireCoachingConsent(p.athlete_id, 'a structured workout plan');
      await c.query("UPDATE training_plan_revisions SET response='pending', proposed_at=now() WHERE plan_id=$1 AND rev=$2", [p.id, r.rev]);
      const upd = (await c.query("UPDATE training_plans SET status=CASE WHEN accepted_rev IS NULL THEN 'proposed' ELSE status END, title=$2, goal=$3, updated_at=now() WHERE id=$1 RETURNING *", [p.id, r.title, r.goal])).rows[0];
      await notify(c, p.athlete_id, { kind: 'training_plan', title: `New training plan: ${r.title}`, body: 'Review and respond in your plans.', data: { plan_id: p.id, rev: r.rev } });
      return { ...upd, pending_rev: r.rev };
    });
  },
});

cap({
  name: 'respond_training_plan', method: 'POST', path: '/training-plans/:id/respond', tag: TAG,
  summary: 'Athlete accepts, declines or asks for changes to the pending revision. Acceptance schedules its sessions; completed sessions are never touched.',
  input: z.object({ id, response: z.enum(['accepted', 'declined', 'change_requested']), note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await lockPlan(c, i.id);
      if (user.id !== p.athlete_id) throw forbidden('Only the athlete can respond');
      const r = await latest(c, p);
      if (r.response !== 'pending') throw conflict('There is nothing waiting for your response');
      if (i.response === 'change_requested' && !i.note) throw badRequest('Say what you would like changed');
      await c.query('UPDATE training_plan_revisions SET response=$3, response_note=$4, responded_at=now() WHERE plan_id=$1 AND rev=$2', [p.id, r.rev, i.response, i.note]);
      if (i.response === 'accepted') {
        const ids = (r.content.sessions ?? []).map((s) => s.session_id).filter(Boolean);
        // future scheduled sessions dropped from this revision are cancelled (kept, not deleted); history is untouched
        await c.query("UPDATE training_sessions SET status='cancelled' WHERE plan_id=$1 AND status='scheduled' AND starts_at > now() AND NOT (id = ANY($2::uuid[]))", [p.id, ids]);
        for (const s of r.content.sessions ?? []) {
          if (s.session_id) await c.query("UPDATE training_sessions SET starts_at=$2, duration_min=$3, kind=$4, title=$5, instructions=$6, target_rpe=$7, from_rev=$8, structure=$10, objective=$11, focus=$12 WHERE id=$1 AND plan_id=$9 AND status='scheduled'", [s.session_id, s.starts_at, s.duration_min, s.kind, s.title, s.instructions, s.target_rpe, r.rev, p.id, s.blocks ? JSON.stringify(s.blocks) : null, s.objective ?? null, s.focus ?? null]);
          else await c.query('INSERT INTO training_sessions(plan_id, from_rev, starts_at, duration_min, kind, title, instructions, target_rpe, structure, objective, focus) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [p.id, r.rev, s.starts_at, s.duration_min, s.kind, s.title, s.instructions, s.target_rpe, s.blocks ? JSON.stringify(s.blocks) : null, s.objective ?? null, s.focus ?? null]);
        }
        if (p.accepted_rev) await c.query("UPDATE training_plan_revisions SET response='superseded' WHERE plan_id=$1 AND rev=$2 AND response='accepted'", [p.id, p.accepted_rev]);
      }
      const status = i.response === 'accepted' ? 'active' : p.accepted_rev ? 'active' : i.response;
      const upd = (await c.query('UPDATE training_plans SET status=$2, accepted_rev=CASE WHEN $3 THEN $4::int ELSE accepted_rev END, updated_at=now() WHERE id=$1 RETURNING *', [p.id, status, i.response === 'accepted', r.rev])).rows[0];
      await notify(c, p.coach_id, { kind: 'training_plan', title: `Training plan ${i.response.replace('_', ' ')}: ${r.title}`, body: i.note ?? '', data: { plan_id: p.id, rev: r.rev } });
      return upd;
    });
  },
});

cap({
  name: 'close_training_plan', method: 'POST', path: '/training-plans/:id/close', tag: TAG,
  summary: 'Coach or athlete closes a plan. Future sessions are cancelled; completed history and feedback are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await lockPlan(c, i.id);
      if (!isParty(user, p)) throw forbidden();
      if (p.status === 'closed') return p;
      await c.query("UPDATE training_sessions SET status='cancelled' WHERE plan_id=$1 AND status='scheduled' AND starts_at > now()", [p.id]);
      await c.query("UPDATE training_plan_revisions SET response='superseded' WHERE plan_id=$1 AND response IN ('draft','pending')", [p.id]);
      return (await c.query("UPDATE training_plans SET status='closed', closed_by=$2, closed_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [p.id, user.id])).rows[0];
    });
  },
});

const PLAN_SQL = `SELECT p.*, s.slug AS sport_slug, s.name AS sport, uc.display_name AS coach_name, ua.display_name AS athlete_name,
    (SELECT count(*)::int FROM training_sessions x WHERE x.plan_id=p.id AND x.status='completed') AS completed,
    (SELECT count(*)::int FROM training_sessions x WHERE x.plan_id=p.id AND x.status IN ('scheduled','completed','skipped')) AS total,
    (SELECT response FROM training_plan_revisions r WHERE r.plan_id=p.id AND r.rev=p.current_rev) AS latest_response,
    (SELECT min(x.starts_at) FROM training_sessions x WHERE x.plan_id=p.id AND x.status='scheduled' AND x.starts_at > now()) AS next_session_at
  FROM training_plans p JOIN users uc ON uc.id=p.coach_id JOIN users ua ON ua.id=p.athlete_id LEFT JOIN sports s ON s.id=p.sport_id`;

cap({
  name: 'list_training_plans', method: 'GET', path: '/training-plans', tag: TAG,
  summary: 'Plans you coach or follow, newest first.',
  input: z.object({ as: z.enum(['coach', 'athlete']).default('athlete'), status: z.enum(['draft', 'proposed', 'active', 'declined', 'change_requested', 'closed']).optional(), athlete_id: id.optional(), ...page }),
  handler: ({ user }, i) => many(
    `${PLAN_SQL} WHERE ${i.as === 'coach' ? 'p.coach_id' : 'p.athlete_id'}=$1 AND ($2::text IS NULL OR p.status=$2) AND ($3::uuid IS NULL OR p.athlete_id=$3)
      AND (p.coach_id=$1 OR p.status <> 'draft')
      ORDER BY p.updated_at DESC, p.id LIMIT $4 OFFSET $5`, [user.id, i.status ?? null, i.athlete_id ?? null, i.limit, i.offset]),
});

/** Who may read this plan and with what authority. Live: relationship, guardian link and consent are re-checked on every read. */
async function readAccess(user, p) {
  if (isAdmin(user) || user.id === p.athlete_id) return { role: user.id === p.athlete_id ? 'athlete' : 'admin', athleteData: true };
  if (user.id === p.coach_id) {
    const live = (await relationships(user.id, p.athlete_id)).length > 0;
    const youth = await isYouth(p.athlete_id);
    const consent = !youth || await hasConsent(p.athlete_id, 'coaching');
    return { role: 'coach', athleteData: live && consent, hidden: !live ? 'relationship_ended' : !consent ? 'guardian_consent' : null };
  }
  if (await guardianLink(user.id, p.athlete_id)) { const consent = await hasConsent(p.athlete_id, 'coaching'); return { role: 'guardian', athleteData: consent, hidden: consent ? null : 'guardian_consent' }; }
  return null;
}

/** Plan content is the coach's own and stays visible to them; what the athlete recorded is hidden once access is revoked. */
function shape(s, access, sport) {
  const blocks = s.structure ?? null;
  const out = { ...s, rules: blocks ? rulesFor(sport) : undefined, summary: blocks ? summarize(blocks) : undefined };
  if (!access.athleteData) {
    out.actuals = undefined; out.athlete_rpe = null; out.athlete_feedback = null; out.athlete_data_hidden = access.hidden;
    return out;
  }
  if (blocks && s.actuals) out.compliance = compare(blocks, s.actuals);
  return out;
}

/** The plan as one viewer may see it. The screen, the API and the PDF export all use this, so they can never disagree. */
async function viewPlan(user, planId) {
  const p = await one(`${PLAN_SQL} WHERE p.id=$1`, [planId]);
  if (!p) throw notFound('Training plan');
  const access = await readAccess(user, p);
  if (!access) throw notFound('Training plan');
  const asCoach = access.role === 'coach' || access.role === 'admin';
  const revisions = await many(`SELECT rev, title, goal, content, response, response_note, proposed_at, responded_at FROM training_plan_revisions WHERE plan_id=$1 ${asCoach ? '' : "AND response <> 'draft'"} ORDER BY rev`, [p.id]);
  const sport = p.sport_id ? await one('SELECT slug, name, scoring FROM sports WHERE id=$1', [p.sport_id]) : null;
  const sessions = (await many('SELECT * FROM training_sessions WHERE plan_id=$1 ORDER BY starts_at, id', [p.id])).map((s) => ({ ...shape(s, access, sport), ...sessionLoad(s, access.athleteData) }));
  const live = revisions.find((r) => r.rev === p.accepted_rev) ?? revisions[revisions.length - 1];
  const phases = live?.content?.phases ?? [];
  const weeks = buildWeeks(sessions, phases, access.athleteData, compare);
  return { ...p, viewer: access.role, sport_rules: rulesFor(sport), phases, targets: live?.content?.targets ?? [], weeks, revisions, sessions };
}

cap({
  name: 'get_training_plan', method: 'GET', path: '/training-plans/:id', tag: TAG,
  summary: 'A plan with its revisions, periodisation phases, structured sessions, actual-versus-planned and weekly training load (session-RPE). The athlete sees drafts only once proposed; a coach whose relationship or guardian consent has ended no longer sees the athlete\'s recorded results; verified guardians can read their child\'s plan.',
  input: z.object({ id }),
  handler: ({ user }, i) => viewPlan(user, i.id),
});

cap({
  name: 'export_training_plan', method: 'GET', path: '/training-plans/:id/export', tag: TAG,
  summary: 'Download the plan and the athlete\'s actuals as a PDF (coach, athlete, or a guardian while consent stands). Built from exactly what the viewer sees on screen, so revoked access or withdrawn guardian consent leaves the athlete-recorded results out. Every export is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const plan = await viewPlan(user, i.id);
    const { buffer, pages } = await renderTrainingPlan(plan);
    await audit(null, user.id, 'export', 'training_plan', plan.id);
    const slug = plan.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'plan';
    return { filename: `training-plan-${slug}.pdf`, content_type: 'application/pdf', encoding: 'base64', content: buffer.toString('base64'), pages };
  },
});

// jsonb does not keep key order, so compare with sorted keys
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sameJson = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

cap({
  name: 'update_training_session', method: 'PATCH', path: '/training-sessions/:id', tag: TAG,
  summary: 'Athlete records what they actually did against a structured workout — save progress as often as needed (send expected_version; a stale copy gets 409), then mark the session completed or skipped with optional effort (1-10) and non-clinical feedback. A finished session is final; repeating the identical request is safe. Coach adds post-session feedback.',
  input: z.object({
    id, status: z.enum(['completed', 'skipped']).optional(), athlete_rpe: z.number().int().min(1).max(10).optional(),
    athlete_feedback: z.string().max(1000).optional(), coach_feedback: z.string().max(1000).optional(),
    actuals: actualsIn.optional().describe('results per planned block, replacing the previous save'),
    expected_version: z.number().int().min(1).optional().describe('version of the session you loaded; required with actuals'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT s.*, p.coach_id, p.athlete_id, p.sport_id FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id WHERE s.id=$1 FOR UPDATE OF s', [i.id])).rows[0];
      if (!s) throw notFound('Session');
      if (i.coach_feedback !== undefined) {
        if (user.id !== s.coach_id) throw forbidden('Only the coach can add coach feedback');
        if (!['completed', 'skipped'].includes(s.status)) throw conflict('Feedback is added after the session');
        await requireRelationship(user, s.athlete_id);
        return (await c.query('UPDATE training_sessions SET coach_feedback=$2 WHERE id=$1 RETURNING *', [s.id, i.coach_feedback])).rows[0];
      }
      if (user.id !== s.athlete_id) throw forbidden('Only the athlete can record the outcome');
      if (!i.status && i.actuals === undefined) throw badRequest('status or actuals is required');
      if (i.actuals !== undefined) {
        if (!s.structure) throw badRequest('This session has no structured workout to record against');
        if (i.expected_version === undefined) throw badRequest('expected_version is required with actuals');
        validateActuals(i.actuals, s.structure, await sportOf(c, s.sport_id));
      }
      // an identical retry of a request that already succeeded is not an error (flaky connections, double taps)
      if (s.status !== 'scheduled') {
        const same = i.status === s.status && (i.athlete_rpe ?? null) === s.athlete_rpe && (i.athlete_feedback ?? null) === s.athlete_feedback
          && (i.actuals === undefined || sameJson(i.actuals, s.actuals));
        if (same) return s;
        throw conflict(`Session is already ${s.status}`);
      }
      if (i.expected_version !== undefined && i.expected_version !== s.version) throw conflict('This session changed on another device — reload it before saving', { code: 'stale_version', version: s.version });
      const done = !!i.status;
      return (await c.query(
        `UPDATE training_sessions SET status=coalesce($2,status), athlete_rpe=coalesce($3,athlete_rpe), athlete_feedback=coalesce($4,athlete_feedback),
                actuals=CASE WHEN $5::jsonb IS NULL THEN actuals ELSE $5::jsonb END, actuals_at=CASE WHEN $5::jsonb IS NULL THEN actuals_at ELSE now() END,
                completed_at=CASE WHEN $6 THEN now() ELSE completed_at END, version=version+1
          WHERE id=$1 RETURNING *`,
        [s.id, i.status ?? null, i.athlete_rpe ?? null, i.athlete_feedback ?? null, i.actuals === undefined ? null : JSON.stringify(i.actuals), done])).rows[0];
    });
  },
});
