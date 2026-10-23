// Application scoring and evaluation committees (#288): shared rules for rubrics, conflicts, anonymity, scores and the decision record.
// The capabilities live in capabilities/sponsorship-evaluation.js; the award / decline handler of sponsorship-programs.js calls
// `gateDecision` and `recordDecision` so a decision is always taken against the rubric the committee scored with.
import { pool } from './db.js';
import { conflict, forbidden, notFound } from './errors.js';
import { isAdmin } from './helpers.js';
import { sponsorAccess, SPONSOR_ACTIONS } from './sponsor-access.js';

export const STAGES = ['received', 'shortlisted', 'interview', 'finalist'];
export const aliasOf = (applicationId) => `A-${String(applicationId).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
const r2 = (n) => Math.round(n * 100) / 100;

/** Weighted total out of 100: sum(score / scale_max * weight). Weights total 100, so a full-marks score is exactly 100. */
export function weightedTotal(criteria, scores, scaleMax) {
  const by = new Map(scores.map((s) => [s.criterion_id, s.score]));
  return r2(criteria.reduce((t, c) => t + ((by.get(c.id) ?? 0) / scaleMax) * c.weight, 0));
}

export async function liveRubric(c, roundId, { lock = false } = {}) {
  const rb = (await c.query(`SELECT * FROM sponsorship_rubrics WHERE round_id=$1 AND status IN ('draft','active')${lock ? ' FOR UPDATE' : ''}`, [roundId])).rows[0];
  if (!rb) return null;
  rb.criteria = (await c.query('SELECT id, position, name, description, weight FROM sponsorship_rubric_criteria WHERE rubric_id=$1 ORDER BY position', [rb.id])).rows;
  return rb;
}

/**
 * Who the caller is for a round's evaluation. Everything is read live and server-side on each call, so removing a person from the brand
 * or from the committee takes effect at once. `can` answers the sponsor-side action matrix; `seeAll` is who may see other reviewers' scores.
 */
export async function evalContext(user, roundId, c = pool) {
  const r = (await c.query('SELECT * FROM sponsorship_rounds WHERE id=$1', [roundId])).rows[0];
  if (!r) throw notFound('Round');
  const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1', [r.program_id])).rows[0];
  const sp = (await c.query('SELECT * FROM sponsors WHERE id=$1', [p.sponsor_id])).rows[0];
  const admin = isAdmin(user);
  const access = admin ? null : await sponsorAccess(user, sp, c);
  if (!admin && (!access || access.departmentId)) throw forbidden('You are not part of this brand');
  const can = (action) => admin || SPONSOR_ACTIONS[action].includes(access.role);
  const reviewer = (await c.query('SELECT * FROM sponsorship_reviewers WHERE round_id=$1 AND user_id=$2 AND removed_at IS NULL', [roundId, user.id])).rows[0] ?? null;
  const role = admin ? 'admin' : access.role;
  return {
    r, p, sp, role, access, reviewer, can,
    ownerOrArchived: !admin && access.archived && !access.owner,
    manage: can('program'),
    moderate: can('program') || reviewer?.role === 'moderator',
    seeAll: can('program') || role === 'auditor' || reviewer?.role === 'moderator',
  };
}
export function assertEvaluation(ctx) {
  if (!ctx.can('evaluation') && !ctx.reviewer) throw forbidden(`Your role (${ctx.role}) cannot see how applications are evaluated`);
}
export function assertWritable(ctx) {
  if (ctx.ownerOrArchived) throw conflict("This brand's organisation is archived and read-only");
}

/** A reason this reviewer must not score the application, or null. Recorded declarations and ownership / team ties both count. */
export async function conflictOf(c, app, userId) {
  const rec = (await c.query('SELECT reason, source FROM sponsorship_conflicts WHERE application_id=$1 AND reviewer_user_id=$2 AND cleared_at IS NULL', [app.id, userId])).rows[0];
  if (rec) return rec.source === 'self' ? `You declared a conflict: ${rec.reason}` : `A manager recorded a conflict: ${rec.reason}`;
  if (app.applicant_id === userId) return 'You made this application';
  if (app.target_type === 'athlete' && app.target_id === userId) return 'You are the athlete this application is for';
  if (app.target_type === 'team') {
    const t = (await c.query(`SELECT 1 FROM teams WHERE id=$1 AND owner_id=$2 UNION ALL SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'`, [app.target_id, userId])).rows[0];
    if (t) return 'You are part of the team this application is for';
  }
  if (app.target_type === 'event') {
    const t = (await c.query('SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2', [app.target_id, userId])).rows[0];
    if (t) return 'You organise the event this application is for';
  }
  return null;
}

/** Has the applicant agreed to show the committee who they are? */
export const identityGranted = async (c, applicationId) => !!(await c.query("SELECT 1 FROM sponsorship_identity_consents WHERE application_id=$1 AND status='granted'", [applicationId])).rows[0];

/** Is this application blind to the brand's staff right now? Only while a rubric that asks for anonymity exists and consent is not granted. */
export async function isBlind(c, app) {
  const rb = (await c.query("SELECT anonymize FROM sponsorship_rubrics WHERE round_id=$1 AND status IN ('draft','active')", [app.round_id])).rows[0];
  return !!rb?.anonymize && !(await identityGranted(c, app.id));
}

/**
 * Hide who applied, for staff, on rows that are still blind. Rows keep an alias so a committee can still discuss them. Works on the
 * shapes of list_program_applications (display_name / handle ... / applicant_user_id / target_name) and is a no-op for the rest.
 */
export async function redactBlind(rows, c = pool) {
  if (!rows.length) return rows;
  const ids = rows.map((x) => x.id);
  const blind = new Set((await c.query(
    `SELECT a.id FROM sponsorship_applications a JOIN sponsorship_rubrics rb ON rb.round_id=a.round_id AND rb.status IN ('draft','active') AND rb.anonymize
      WHERE a.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM sponsorship_identity_consents ic WHERE ic.application_id=a.id AND ic.status='granted')`, [ids])).rows.map((x) => x.id));
  return rows.map((x) => (blind.has(x.id)
    ? { ...x, alias: aliasOf(x.id), anonymized: true, applicant_id: null, applicant_user_id: null, target_id: null, target_name: null, handle: null, display_name: aliasOf(x.id), roles: null, bio: null, avatar_emoji: null, avatar_color: null, avatar_url: null }
    : { ...x, alias: aliasOf(x.id), anonymized: false }));
}

export async function logEvent(c, applicationId, kind, actorId, data = {}) {
  await c.query('INSERT INTO sponsorship_evaluation_events(application_id, kind, actor_id, data) VALUES ($1,$2,$3,$4)', [applicationId, kind, actorId, data]);
  await c.query('UPDATE sponsorship_applications SET eval_version = eval_version + 1 WHERE id=$1', [applicationId]);
}

export function checkEvalVersion(app, v) {
  if (v != null && app.eval_version !== v) throw conflict(`This application was changed by someone else (now version ${app.eval_version}); the latest was loaded, review it and try again`, { current_version: app.eval_version });
}

/** Scores of one application summarised: average of the submitted ones, their spread, the moderated total and the final score. */
export async function summarize(c, app, rubric) {
  const rows = (await c.query("SELECT reviewer_user_id, total, criteria FROM sponsorship_scores WHERE application_id=$1 AND status='submitted' ORDER BY submitted_at, id", [app.id])).rows;
  const mod = (await c.query('SELECT total, reason, created_at FROM sponsorship_moderations WHERE application_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [app.id])).rows[0] ?? null;
  const totals = rows.map((x) => Number(x.total));
  const avg = totals.length ? r2(totals.reduce((a, b) => a + b, 0) / totals.length) : null;
  const spread = totals.length > 1 ? r2(Math.max(...totals) - Math.min(...totals)) : 0;
  const threshold = rubric?.spread_threshold ?? 20;
  const byCriterion = (rubric?.criteria ?? []).map((cr) => {
    const vals = rows.map((x) => (x.criteria.find((k) => k.criterion_id === cr.id) ?? {}).score).filter((v) => v != null);
    return { criterion_id: cr.id, name: cr.name, weight: cr.weight, average: vals.length ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
  });
  return {
    submitted: rows.length, average: avg, spread, needs_moderation: rows.length > 1 && spread >= threshold && !mod,
    moderated_total: mod ? Number(mod.total) : null, moderation_reason: mod?.reason ?? null,
    final_score: mod ? Number(mod.total) : avg, by_criterion: byCriterion, reviewers: rows.map((x) => x.reviewer_user_id),
  };
}

/**
 * Called by the award / decline handler inside its transaction, with the application locked. Without a rubric the decision is as it
 * always was. With an active rubric an award needs a shortlisted application, at least one submitted score and, when the rubric is
 * blind, the applicant's consent to be identified - so the committee's process cannot be skipped by a direct call.
 */
export async function gateDecision(c, app, decision, evalVersion) {
  checkEvalVersion(app, evalVersion);
  const rb = await liveRubric(c, app.round_id);
  if (!rb || rb.status !== 'active' || decision !== 'award') return rb;
  if (app.stage === 'received') throw conflict('Shortlist this application before awarding it: this round is scored by a committee');
  const n = (await c.query("SELECT count(*)::int AS n FROM sponsorship_scores WHERE application_id=$1 AND status='submitted'", [app.id])).rows[0].n;
  if (!n) throw conflict('This application has no submitted committee score yet');
  if (rb.anonymize && !(await identityGranted(c, app.id))) throw conflict('The applicant has not yet agreed to be identified; request that before awarding');
  return rb;
}

/** Keep what the decision was based on: the rubric as scored, the result, and the references the brand may rely on. */
export async function recordDecision(c, app, p, decision, userId) {
  const rb = await liveRubric(c, app.round_id);
  const granted = await identityGranted(c, app.id);
  const sum = rb ? await summarize(c, app, rb) : null;
  const consent = granted ? (await c.query("SELECT id FROM sponsorship_identity_consents WHERE application_id=$1 AND status='granted'", [app.id])).rows[0] : null;
  const refs = { application_id: app.id, program_id: app.program_id, round_id: app.round_id, round_terms_version: app.round_terms_version, program_version: p.row_version, stage: app.stage, ...(granted ? { target_type: app.target_type, target_id: app.target_id, identity_consent_id: consent?.id } : {}) };
  await c.query(
    `INSERT INTO sponsorship_decision_records(application_id, decision, rubric_id, rubric_snapshot, score_snapshot, source_refs, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (application_id) DO NOTHING`,
    [app.id, decision, rb?.id ?? null, rb ? { version: rb.version, anonymize: rb.anonymize, scale_max: rb.scale_max, criteria: rb.criteria } : null, sum ? { submitted: sum.submitted, average: sum.average, spread: sum.spread, moderated_total: sum.moderated_total, final_score: sum.final_score, by_criterion: sum.by_criterion } : null, refs, userId]);
  await logEvent(c, app.id, 'decided', userId, { decision, rubric_version: rb?.version ?? null, final_score: sum?.final_score ?? null });
}
