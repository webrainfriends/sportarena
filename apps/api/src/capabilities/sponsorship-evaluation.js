// Application scoring and evaluation committees (#288). Lives on the programs / rounds / applications of #284-#285: a round gets a
// weighted rubric and a committee; reviewers score independently (blind to each other and, when the rubric asks, to who applied);
// conflicted reviewers cannot score; moderators resolve disagreement; managers shortlist, interview and decide. Scores are
// confidential to the brand's evaluation staff and never reach the applicant. Nothing is deleted: scores are voided, conflicts cleared.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit, mustFind } from '../helpers.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { validTimezone } from '../booking/time.js';
import { sponsorAccess, sponsorRecipients } from '../sponsor-access.js';
import {
  STAGES, aliasOf, assertEvaluation, assertWritable, checkEvalVersion, conflictOf, evalContext, identityGranted, isBlind, liveRubric, logEvent,
  summarize, weightedTotal,
} from '../sponsorship-evaluation.js';

const STAGE = z.enum(STAGES);
const criterion = z.object({
  name: z.string().min(1).max(120), description: z.string().max(500).optional(),
  weight: z.coerce.number().int().min(1).max(100).describe('percent of the total; all weights of a rubric add up to exactly 100'),
});
const checkWeights = (criteria) => {
  const total = criteria.reduce((t, x) => t + x.weight, 0);
  if (total !== 100) throw unprocessable(`The weights must total 100 (they total ${total})`, { total });
};
const date = z.string().date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');
/** A calendar date + wall-clock time in an IANA timezone as an instant (clients pick a date, a time and a zone, never type an ISO string). */
async function instant(c, on, at, timezone) {
  if (!validTimezone(timezone)) throw badRequest('Unknown timezone; use an IANA name such as Europe/Paris');
  return (await c.query('SELECT (($1::date + $2::time) AT TIME ZONE $3) AS t', [on, at, timezone])).rows[0].t;
}
const checkVersion = (row, v, what) => { if (row.row_version !== v) throw conflict(`This ${what} was changed by someone else (now version ${row.row_version}); the latest was loaded, review it and try again`, { current_version: row.row_version }); };

/** Loads the application with its round context and locks it. One lock order everywhere: program, round, application. */
async function appContext(user, applicationId, c, { lock = true } = {}) {
  const a0 = (await c.query('SELECT round_id FROM sponsorship_applications WHERE id=$1', [applicationId])).rows[0];
  if (!a0) throw notFound('Application');
  const ctx = await evalContext(user, a0.round_id, c);
  if (lock) { await c.query('SELECT 1 FROM sponsorship_programs WHERE id=$1 FOR UPDATE', [ctx.p.id]); await c.query('SELECT 1 FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [ctx.r.id]); }
  const a = (await c.query(`SELECT * FROM sponsorship_applications WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [applicationId])).rows[0];
  return { ...ctx, a };
}

// ---------------------------------------------------------------- rubric and committee

const rubricView = async (c, roundId, ctx) => {
  const rb = await liveRubric(c, roundId);
  const reviewers = await many(`SELECT v.id, v.user_id, v.role, v.created_at, u.display_name, u.handle FROM sponsorship_reviewers v JOIN users u ON u.id=v.user_id WHERE v.round_id=$1 AND v.removed_at IS NULL ORDER BY v.created_at, v.id`, [roundId]);
  return {
    round_id: roundId, rubric: rb && { ...rb, total_weight: rb.criteria.reduce((t, x) => t + x.weight, 0) }, reviewers,
    my_role: ctx.role, my_reviewer_role: ctx.reviewer?.role ?? null, can_manage: ctx.manage, can_moderate: ctx.moderate,
  };
};

cap({
  name: 'get_round_rubric', method: 'GET', path: '/program-rounds/:id/rubric', tag: 'Sponsors',
  summary: 'Brand evaluation staff / committee: the weighted rubric of a round (criteria, weights, scale, anonymity, scoring deadline) and its committee; `rubric` is null until one is set up.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await evalContext(user, i.id);
    assertEvaluation(ctx);
    return rubricView(pool, i.id, ctx);
  },
});

cap({
  name: 'save_round_rubric', method: 'POST', path: '/program-rounds/:id/rubric', tag: 'Sponsors',
  summary: 'Brand manager/approver: create or replace the DRAFT rubric of a round. Criterion weights must total exactly 100. `anonymize` (default on) hides who applied from the whole committee until the applicant consents. A rubric that has received its first score is locked (409). Send the current `version` when replacing (409 if someone else changed it).',
  input: z.object({
    id, criteria: z.array(criterion).min(1).max(20), anonymize: z.boolean().default(true), scale_max: z.coerce.number().int().min(2).max(10).default(5),
    spread_threshold: z.coerce.number().int().min(1).max(100).default(20).describe('points of 100 between the highest and lowest reviewer that ask for moderation'),
    scoring_closes_at: z.string().datetime().nullable().optional(), scoring_closes_on: date.optional().describe('closing day; with scoring_closes_time and timezone instead of scoring_closes_at'), scoring_closes_time: hhmm.optional(), timezone: z.string().min(1).max(60).optional(), version: z.coerce.number().int().positive().optional(),
  }),
  async handler({ user }, i) {
    checkWeights(i.criteria);
    return tx(async (c) => {
      const ctx = await evalContext(user, i.id, c);
      if (!ctx.manage) throw forbidden(`Your role (${ctx.role}) cannot set up an evaluation`);
      if (i.scoring_closes_on) i.scoring_closes_at = (await instant(c, i.scoring_closes_on, i.scoring_closes_time ?? '23:59', i.timezone ?? ctx.r.timezone)).toISOString();
      assertWritable(ctx);
      await c.query('SELECT 1 FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [i.id]);
      const cur = await liveRubric(c, i.id, { lock: true });
      if (cur) {
        if (cur.locked_at) throw conflict('Scoring has started, so this rubric is locked');
        if (cur.status === 'active') throw conflict('Scoring is already open, so this rubric cannot be replaced');
        if (i.version == null) throw badRequest('Send the current rubric version (the `row_version` you loaded)');
        checkVersion(cur, i.version, 'rubric');
        // nothing is deleted: the draft being replaced is retired and stays on record
        await c.query("UPDATE sponsorship_rubrics SET status='retired', updated_at=now() WHERE id=$1", [cur.id]);
      }
      const prev = (await c.query('SELECT coalesce(max(version),0)::int AS v FROM sponsorship_rubrics WHERE round_id=$1', [i.id])).rows[0].v;
      const rb = (await c.query('INSERT INTO sponsorship_rubrics(round_id, version, row_version, anonymize, scale_max, spread_threshold, scoring_closes_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, prev + 1, (cur?.row_version ?? 0) + 1, i.anonymize, i.scale_max, i.spread_threshold, i.scoring_closes_at ?? null, user.id])).rows[0];
      for (const [pos, x] of i.criteria.entries()) await c.query('INSERT INTO sponsorship_rubric_criteria(rubric_id, position, name, description, weight) VALUES ($1,$2,$3,$4,$5)', [rb.id, pos, x.name, x.description ?? null, x.weight]);
      await audit(c, user.id, 'save_rubric', 'sponsorship_rubrics', rb.id);
      return rubricView(c, i.id, ctx);
    });
  },
});

cap({
  name: 'activate_round_rubric', method: 'POST', path: '/program-rounds/:id/rubric/activate', tag: 'Sponsors',
  summary: 'Brand manager/approver: open scoring. The weights are re-checked (must total 100) and at least one reviewer must be on the committee. From now on the round\'s applicants are blind to the committee if the rubric says so.',
  input: z.object({ id, version: z.coerce.number().int().positive() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await evalContext(user, i.id, c);
      if (!ctx.manage) throw forbidden(`Your role (${ctx.role}) cannot open scoring`);
      assertWritable(ctx);
      await c.query('SELECT 1 FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [i.id]);
      const rb = await liveRubric(c, i.id, { lock: true });
      if (!rb) throw notFound('Rubric');
      checkVersion(rb, i.version, 'rubric');
      if (rb.status === 'active') throw conflict('Scoring is already open');
      checkWeights(rb.criteria);
      const n = (await c.query('SELECT count(*)::int AS n FROM sponsorship_reviewers WHERE round_id=$1 AND removed_at IS NULL', [i.id])).rows[0].n;
      if (!n) throw unprocessable('Add at least one reviewer to the committee first');
      await c.query("UPDATE sponsorship_rubrics SET status='active', activated_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [rb.id]);
      await audit(c, user.id, 'activate_rubric', 'sponsorship_rubrics', rb.id);
      for (const v of await c.query('SELECT user_id FROM sponsorship_reviewers WHERE round_id=$1 AND removed_at IS NULL', [i.id]).then((r) => r.rows)) {
        await notify(c, v.user_id, { kind: 'sponsorship_evaluation', title: 'Scoring is open', body: `You can now score applications to ${ctx.p.name} · ${ctx.r.name}.`, data: { round_id: i.id, program_id: ctx.p.id }, dedupe_key: `scoring-open:${rb.id}:${v.user_id}` });
      }
      return rubricView(c, i.id, ctx);
    });
  },
});

cap({
  name: 'list_eligible_reviewers', method: 'GET', path: '/program-rounds/:id/eligible-reviewers', tag: 'Sponsors',
  summary: 'Brand manager/approver: people who can be put on the round\'s committee (brand-wide managers and evaluators), with a flag for those already on it. Optional `q` filters by name or handle.',
  input: z.object({ id, q: z.string().max(60).optional() }),
  async handler({ user }, i) {
    const ctx = await evalContext(user, i.id);
    if (!ctx.manage) throw forbidden(`Your role (${ctx.role}) cannot manage the committee`);
    const ids = await sponsorRecipients(pool, ctx.sp, 'evaluate', null);
    return many(
      `SELECT u.id, u.handle, u.display_name, EXISTS (SELECT 1 FROM sponsorship_reviewers v WHERE v.round_id=$1 AND v.user_id=u.id AND v.removed_at IS NULL) AS on_committee
         FROM users u WHERE u.id = ANY($2) AND ($3::text IS NULL OR u.display_name ILIKE '%'||$3||'%' OR u.handle ILIKE '%'||$3||'%') ORDER BY u.display_name, u.id LIMIT 50`, [i.id, ids, i.q ?? null]);
  },
});

cap({
  name: 'add_round_reviewer', method: 'POST', path: '/program-rounds/:id/reviewers', tag: 'Sponsors', status: 201,
  summary: 'Brand manager/approver: put a person on the round\'s committee as a reviewer (scores) or moderator (also resolves disagreement and moves applications between stages). They must hold an evaluator or manager role for the brand.',
  input: z.object({ id, user_id: id, role: z.enum(['reviewer', 'moderator']).default('reviewer') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await evalContext(user, i.id, c);
      if (!ctx.manage) throw forbidden(`Your role (${ctx.role}) cannot manage the committee`);
      assertWritable(ctx);
      const target = await mustFind('users', i.user_id, 'id', c);
      const acc = await sponsorAccess(target, ctx.sp, c);
      if (!acc || acc.departmentId || !['manager', 'evaluator'].includes(acc.role)) throw unprocessable('Only a brand-wide evaluator or manager of this brand can be on its committee');
      await c.query('SELECT 1 FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [i.id]);
      const live = (await c.query('SELECT id FROM sponsorship_reviewers WHERE round_id=$1 AND user_id=$2 AND removed_at IS NULL', [i.id, target.id])).rows[0];
      let row;
      if (live) row = (await c.query('UPDATE sponsorship_reviewers SET role=$2 WHERE id=$1 RETURNING *', [live.id, i.role])).rows[0];
      else row = (await c.query('INSERT INTO sponsorship_reviewers(round_id, user_id, role, added_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, target.id, i.role, user.id])).rows[0];
      await audit(c, user.id, 'add_reviewer', 'sponsorship_rounds', i.id);
      if (!live) await notify(c, target.id, { kind: 'sponsorship_evaluation', title: 'You joined an evaluation committee', body: `You are a ${i.role} for ${ctx.p.name} · ${ctx.r.name}.`, data: { round_id: i.id, program_id: ctx.p.id }, dedupe_key: `reviewer:${i.id}:${target.id}` });
      return row;
    });
  },
});

cap({
  name: 'remove_round_reviewer', method: 'POST', path: '/program-rounds/:id/reviewers/:user_id/remove', tag: 'Sponsors',
  summary: 'Brand manager/approver: take a person off the committee. Their draft scores are voided; their submitted scores stay on record (and count) because the committee already relied on them. Nothing is deleted.',
  input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await evalContext(user, i.id, c);
      if (!ctx.manage) throw forbidden(`Your role (${ctx.role}) cannot manage the committee`);
      assertWritable(ctx);
      const row = (await c.query('UPDATE sponsorship_reviewers SET removed_at=now(), removed_by=$3 WHERE round_id=$1 AND user_id=$2 AND removed_at IS NULL RETURNING *', [i.id, i.user_id, user.id])).rows[0];
      if (!row) throw notFound('Reviewer');
      await c.query("UPDATE sponsorship_scores s SET status='voided', voided_at=now(), updated_at=now() FROM sponsorship_applications a WHERE a.id=s.application_id AND a.round_id=$1 AND s.reviewer_user_id=$2 AND s.status='draft'", [i.id, i.user_id]);
      await audit(c, user.id, 'remove_reviewer', 'sponsorship_rounds', i.id);
      return row;
    });
  },
});

// ---------------------------------------------------------------- the evaluation board

const SCORING_OPEN = (rb) => rb && rb.status === 'active' && (!rb.scoring_closes_at || new Date(rb.scoring_closes_at) > new Date());

cap({
  name: 'list_round_evaluation', method: 'GET', path: '/program-rounds/:id/evaluation', tag: 'Sponsors',
  summary: 'Committee and evaluation staff: the applications of a round with stage, alias, ask and score summary, oldest first. While the rubric is blind the applicant is only an alias. Plain reviewers see their own scoring status and nobody else\'s scores; moderators, managers/approvers and auditors see the summary. Filter by `stage`.',
  input: z.object({ id, stage: STAGE.optional(), ...page }),
  async handler({ user }, i) {
    const ctx = await evalContext(user, i.id);
    assertEvaluation(ctx);
    const rb = await liveRubric(pool, i.id);
    const apps = await many(
      `SELECT a.id, a.stage, a.eval_version, a.status, a.requested_cents, a.currency, a.pitch, a.round_terms_version, a.target_type, a.created_at,
              (SELECT status FROM sponsorship_identity_consents ic WHERE ic.application_id=a.id AND ic.status IN ('requested','granted') LIMIT 1) AS identity_status,
              (SELECT count(*)::int FROM sponsorship_interviews iv WHERE iv.application_id=a.id) AS interviews
         FROM sponsorship_applications a WHERE a.round_id=$1 AND a.status <> 'draft' AND ($2::text IS NULL OR a.stage=$2) ORDER BY a.created_at, a.id LIMIT $3 OFFSET $4`, [i.id, i.stage ?? null, i.limit, i.offset]);
    const out = [];
    for (const a of apps) {
      const full = { ...a, round_id: i.id };
      const mine = (await pool.query("SELECT status, total FROM sponsorship_scores WHERE application_id=$1 AND reviewer_user_id=$2 AND status <> 'voided'", [a.id, user.id])).rows[0] ?? null;
      const conf = ctx.reviewer ? await conflictOf(pool, { ...full, ...(await pool.query('SELECT applicant_id, target_id FROM sponsorship_applications WHERE id=$1', [a.id])).rows[0] }, user.id) : null;
      const blind = await isBlind(pool, full);
      let who = { alias: aliasOf(a.id), anonymized: blind };
      if (!blind) {
        const w = (await pool.query(`SELECT u.display_name AS applicant_name, CASE a.target_type WHEN 'athlete' THEN (SELECT display_name FROM users WHERE id=a.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=a.target_id) ELSE (SELECT name FROM events WHERE id=a.target_id) END AS target_name FROM sponsorship_applications a JOIN users u ON u.id=a.applicant_id WHERE a.id=$1`, [a.id])).rows[0];
        who = { ...who, ...w };
      }
      out.push({
        ...a, ...who, my_score: mine, my_conflict: conf, summary: ctx.seeAll ? await summarize(pool, { id: a.id }, rb) : { submitted: (await pool.query("SELECT count(*)::int AS n FROM sponsorship_scores WHERE application_id=$1 AND status='submitted'", [a.id])).rows[0].n },
      });
    }
    return { rubric_status: rb?.status ?? null, scoring_open: !!SCORING_OPEN(rb), anonymize: rb?.anonymize ?? false, can_see_all_scores: ctx.seeAll, can_moderate: ctx.moderate, can_manage: ctx.manage, items: out };
  },
});

cap({
  name: 'get_application_scoresheet', method: 'GET', path: '/program-applications/:id/scoresheet', tag: 'Sponsors',
  summary: 'Reviewer: the scoring sheet of an application - the rubric, the application as the committee may see it (alias while blind), your own draft or submitted score and whether you are recused. Moderators / managers also get every submitted score; a reviewer never sees other reviewers\' scores.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await appContext(user, i.id, pool, { lock: false });
    assertEvaluation(ctx);
    const { a, r } = ctx;
    const rb = await liveRubric(pool, r.id);
    const blind = await isBlind(pool, a);
    const mine = (await pool.query("SELECT id, status, criteria, comment, total, row_version, submitted_at FROM sponsorship_scores WHERE application_id=$1 AND reviewer_user_id=$2 AND status <> 'voided'", [a.id, user.id])).rows[0] ?? null;
    const recused = ctx.reviewer ? await conflictOf(pool, a, user.id) : null;
    const base = { id: a.id, alias: aliasOf(a.id), anonymized: blind, stage: a.stage, eval_version: a.eval_version, status: a.status, requested_cents: a.requested_cents, currency: a.currency, pitch: a.pitch, round_terms_version: a.round_terms_version, terms_snapshot: a.terms_snapshot };
    if (!blind) {
      const w = (await pool.query(`SELECT u.display_name AS applicant_name, CASE a.target_type WHEN 'athlete' THEN (SELECT display_name FROM users WHERE id=a.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=a.target_id) ELSE (SELECT name FROM events WHERE id=a.target_id) END AS target_name FROM sponsorship_applications a JOIN users u ON u.id=a.applicant_id WHERE a.id=$1`, [a.id])).rows[0];
      Object.assign(base, w, { target_type: a.target_type });
    }
    const all = ctx.seeAll ? await many(
      `SELECT s.reviewer_user_id, u.display_name AS reviewer_name, s.total, s.criteria, s.comment, s.submitted_at FROM sponsorship_scores s JOIN users u ON u.id=s.reviewer_user_id WHERE s.application_id=$1 AND s.status='submitted' ORDER BY s.submitted_at, s.id`, [a.id]) : undefined;
    return {
      application: base, rubric: rb, scoring_open: !!SCORING_OPEN(rb), can_score: !!SCORING_OPEN(rb) && !!ctx.reviewer && !recused && a.status === 'submitted',
      recused, my_score: mine, is_reviewer: !!ctx.reviewer, can_moderate: ctx.moderate, can_manage: ctx.manage,
      summary: ctx.seeAll ? await summarize(pool, a, rb) : undefined, all_scores: all,
    };
  },
});

const scoreEntry = z.object({ criterion_id: id, score: z.coerce.number().int().min(1), comment: z.string().max(500).optional() });
cap({
  name: 'save_application_score', method: 'POST', path: '/program-applications/:id/score', tag: 'Sponsors',
  summary: 'Committee reviewer: save a draft or submit your score of an application against the active rubric (each score 1..scale_max; submitting needs every criterion scored). Rejected (403) when you are recused or in conflict, not on the committee, or your brand role was removed; 409 when scoring is closed, the application is decided, or `version` (your score\'s row_version) / `rubric_version` is stale. Your score is independent: no other reviewer\'s score is shown to you.',
  input: z.object({ id, scores: z.array(scoreEntry).min(1).max(20), comment: z.string().max(2000).optional(), submit: z.boolean().default(false), rubric_version: z.coerce.number().int().positive().describe('the rubric `row_version` you scored against'), version: z.coerce.number().int().positive().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await appContext(user, i.id, c);
      const { a } = ctx;
      if (!ctx.reviewer || !ctx.can('evaluate')) throw forbidden('You are not on this round\'s committee');
      assertWritable(ctx);
      const why = await conflictOf(c, a, user.id);
      if (why) throw forbidden(`You cannot score this application: ${why}`);
      const rb = await liveRubric(c, a.round_id, { lock: true });
      if (!rb || rb.status !== 'active') throw conflict('Scoring is not open for this round');
      if (rb.scoring_closes_at && new Date(rb.scoring_closes_at) <= new Date()) throw conflict('Scoring has closed for this round');
      checkVersion(rb, i.rubric_version, 'rubric');
      if (a.status !== 'submitted') throw conflict(`This application is already ${a.status}`);
      const seen = new Set();
      for (const s of i.scores) {
        if (!rb.criteria.some((x) => x.id === s.criterion_id)) throw badRequest('A score names a criterion that is not in the rubric');
        if (seen.has(s.criterion_id)) throw badRequest('A criterion is scored twice');
        seen.add(s.criterion_id);
        if (s.score > rb.scale_max) throw badRequest(`Scores run from 1 to ${rb.scale_max}`);
      }
      if (i.submit && seen.size !== rb.criteria.length) throw unprocessable('Score every criterion before submitting');
      const total = i.submit ? weightedTotal(rb.criteria, i.scores, rb.scale_max) : null;
      const cur = (await c.query("SELECT * FROM sponsorship_scores WHERE application_id=$1 AND reviewer_user_id=$2 FOR UPDATE", [a.id, user.id])).rows[0];
      let row;
      if (cur) {
        if (cur.status !== 'voided' && (i.version == null || cur.row_version !== i.version)) throw conflict('Your score was changed in another window; the latest was loaded', { current_version: cur.row_version });
        row = (await c.query(
          `UPDATE sponsorship_scores SET criteria=$2, comment=$3, status=$4, total=$5, submitted_at=CASE WHEN $4='submitted' THEN coalesce(submitted_at, now()) ELSE NULL END, voided_at=NULL, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
          [cur.id, JSON.stringify(i.scores), i.comment ?? null, i.submit ? 'submitted' : 'draft', total])).rows[0];
      } else {
        row = (await c.query(
          `INSERT INTO sponsorship_scores(application_id, rubric_id, reviewer_user_id, status, criteria, comment, total, submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $4='submitted' THEN now() END) RETURNING *`,
          [a.id, rb.id, user.id, i.submit ? 'submitted' : 'draft', JSON.stringify(i.scores), i.comment ?? null, total])).rows[0];
      }
      if (i.submit) {
        await c.query('UPDATE sponsorship_rubrics SET locked_at=coalesce(locked_at, now()) WHERE id=$1', [rb.id]);
        await logEvent(c, a.id, cur?.status === 'submitted' ? 'score_revised' : 'score_submitted', user.id, { reviewer_user_id: user.id });
        await audit(c, user.id, 'score', 'sponsorship_applications', a.id);
      }
      return { id: row.id, status: row.status, total: row.total, row_version: row.row_version, submitted_at: row.submitted_at };
    });
  },
});

// ---------------------------------------------------------------- conflicts of interest

cap({
  name: 'declare_application_conflict', method: 'POST', path: '/program-applications/:id/conflicts', tag: 'Sponsors', status: 201,
  summary: 'Recuse yourself from an application (reviewers), or - for a manager/approver - record a conflict for a named `reviewer_user_id`. The reviewer\'s draft score is voided; a submitted score is voided too so it no longer counts. They can no longer score it. The reason is kept in the decision history.',
  input: z.object({ id, reason: z.string().min(1).max(500), reviewer_user_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await appContext(user, i.id, c);
      assertEvaluation(ctx);
      assertWritable(ctx);
      const target = i.reviewer_user_id ?? user.id;
      const self = target === user.id;
      if (!self && !ctx.manage) throw forbidden('Only a manager or approver can record a conflict for someone else');
      if (self && !ctx.reviewer) throw forbidden('You are not on this round\'s committee');
      if (!self) { const rv = (await c.query('SELECT 1 FROM sponsorship_reviewers WHERE round_id=$1 AND user_id=$2 AND removed_at IS NULL', [ctx.r.id, target])).rows[0]; if (!rv) throw unprocessable('That person is not on the committee'); }
      if (ctx.a.status !== 'submitted') throw conflict(`This application is already ${ctx.a.status}`);
      const live = (await c.query('SELECT id FROM sponsorship_conflicts WHERE application_id=$1 AND reviewer_user_id=$2 AND cleared_at IS NULL', [ctx.a.id, target])).rows[0];
      if (live) throw conflict('A conflict is already recorded for this reviewer');
      const row = (await c.query('INSERT INTO sponsorship_conflicts(application_id, reviewer_user_id, source, reason, declared_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ctx.a.id, target, self ? 'self' : 'manager', i.reason, user.id])).rows[0];
      await c.query("UPDATE sponsorship_scores SET status='voided', voided_at=now(), updated_at=now() WHERE application_id=$1 AND reviewer_user_id=$2 AND status IN ('draft','submitted')", [ctx.a.id, target]);
      await logEvent(c, ctx.a.id, 'conflict_declared', user.id, { reviewer_user_id: target, source: row.source });
      await audit(c, user.id, 'declare_conflict', 'sponsorship_applications', ctx.a.id);
      return row;
    });
  },
});

cap({
  name: 'clear_application_conflict', method: 'POST', path: '/program-applications/:id/conflicts/:reviewer_user_id/clear', tag: 'Sponsors',
  summary: 'Brand manager/approver: lift a recorded conflict with a reason (a reviewer cannot lift their own recusal). The reviewer may score again.',
  input: z.object({ id, reviewer_user_id: id, reason: z.string().min(1).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await appContext(user, i.id, c);
      if (!ctx.manage) throw forbidden('Only a manager or approver can lift a conflict');
      assertWritable(ctx);
      if (i.reviewer_user_id === user.id) throw forbidden('You cannot lift your own conflict');
      const row = (await c.query('UPDATE sponsorship_conflicts SET cleared_at=now(), cleared_by=$3, clear_reason=$4 WHERE application_id=$1 AND reviewer_user_id=$2 AND cleared_at IS NULL RETURNING *', [ctx.a.id, i.reviewer_user_id, user.id, i.reason])).rows[0];
      if (!row) throw notFound('Conflict');
      await logEvent(c, ctx.a.id, 'conflict_cleared', user.id, { reviewer_user_id: i.reviewer_user_id });
      return row;
    });
  },
});

// ---------------------------------------------------------------- stages, moderation, interviews

const ALLOWED_STAGE = { received: ['shortlisted'], shortlisted: ['received', 'interview', 'finalist'], interview: ['shortlisted', 'finalist'], finalist: ['interview', 'shortlisted'] };
cap({
  name: 'set_application_stage', method: 'POST', path: '/program-applications/:id/stage', tag: 'Sponsors',
  summary: 'Moderator, manager or approver: move an application through received -> shortlisted -> interview -> finalist (and back). Needs the application\'s current `eval_version` (409 when it changed). Interviews are scheduled while an application is shortlisted or in interview; the sponsor decides when to move to the next stage.',
  input: z.object({ id, stage: STAGE, eval_version: z.coerce.number().int().positive(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await appContext(user, i.id, c);
      assertEvaluation(ctx);
      if (!ctx.moderate) throw forbidden('Only a moderator, manager or approver can move applications between stages');
      assertWritable(ctx);
      checkEvalVersion(ctx.a, i.eval_version);
      if (ctx.a.status !== 'submitted') throw conflict(`This application is already ${ctx.a.status}`);
      if (!ALLOWED_STAGE[ctx.a.stage]?.includes(i.stage)) throw conflict(`An application cannot move from ${ctx.a.stage} to ${i.stage}`);
      const rb = await liveRubric(c, ctx.r.id);
      if (i.stage !== 'received' && (!rb || rb.status !== 'active')) throw conflict('Open scoring (activate the rubric) before shortlisting');
      const row = (await c.query('UPDATE sponsorship_applications SET stage=$2 WHERE id=$1 RETURNING id, stage, eval_version', [ctx.a.id, i.stage])).rows[0];
      await logEvent(c, ctx.a.id, 'stage_changed', user.id, { from: ctx.a.stage, to: i.stage, note: i.note ?? null });
      return { ...row, eval_version: row.eval_version + 1 };
    });
  },
});

cap({
  name: 'moderate_application', method: 'POST', path: '/program-applications/:id/moderation', tag: 'Sponsors', status: 201,
  summary: 'Moderator, manager or approver: settle the committee\'s disagreement by recording a moderated total (0-100) with a reason. It becomes the final score; the reviewers\' scores and every earlier moderation stay on record. Needs at least one submitted score and the current `eval_version`.',
  input: z.object({ id, total: z.coerce.number().min(0).max(100), reason: z.string().min(1).max(1000), eval_version: z.coerce.number().int().positive() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await appContext(user, i.id, c);
      assertEvaluation(ctx);
      if (!ctx.moderate) throw forbidden('Only a moderator, manager or approver can moderate scores');
      assertWritable(ctx);
      checkEvalVersion(ctx.a, i.eval_version);
      if (ctx.a.status !== 'submitted') throw conflict(`This application is already ${ctx.a.status}`);
      const n = (await c.query("SELECT count(*)::int AS n FROM sponsorship_scores WHERE application_id=$1 AND status='submitted'", [ctx.a.id])).rows[0].n;
      if (!n) throw unprocessable('There is no submitted score to moderate yet');
      const row = (await c.query('INSERT INTO sponsorship_moderations(application_id, total, reason, moderated_by) VALUES ($1,$2,$3,$4) RETURNING *', [ctx.a.id, i.total, i.reason, user.id])).rows[0];
      await logEvent(c, ctx.a.id, 'moderated', user.id, { total: Number(row.total) });
      await audit(c, user.id, 'moderate', 'sponsorship_applications', ctx.a.id);
      return row;
    });
  },
});

const interviewFields = {
  scheduled_at: z.string().datetime().optional().describe('when it takes place (a scheduled slot); or give `on` + `at` + `timezone`'),
  on: date.optional(), at: hhmm.optional(),
  timezone: z.string().min(1).max(60).optional().describe('IANA timezone the slot is shown in'),
  video_url: z.string().url().max(500).regex(/^https:\/\//, 'must be an https link').optional().describe('a video call link'),
  location: z.string().max(300).optional(), notes: z.string().max(2000).optional().describe('shown to the applicant'),
};
const interviewCols = 'iv.id, iv.application_id, iv.seq, iv.scheduled_at, iv.timezone, iv.video_url, iv.location, iv.notes, iv.status, iv.created_at, iv.row_version';

cap({
  name: 'schedule_application_interview', method: 'POST', path: '/program-applications/:id/interviews', tag: 'Sponsors', status: 201,
  summary: 'Moderator, manager or approver: add the next interview round for a shortlisted application - a scheduled time, a video link, or both - as many rounds as needed until the sponsor moves it on. Moves the application to the interview stage and tells the applicant (they see the time, link and notes, never scores). Needs the current `eval_version`.',
  input: z.object({ id, eval_version: z.coerce.number().int().positive(), ...interviewFields }),
  async handler({ user }, i) {
    if (!i.scheduled_at && !(i.on && i.at) && !i.video_url) throw badRequest('Give the interview a time, a video link, or both');
    if (i.timezone && !validTimezone(i.timezone)) throw badRequest('Unknown timezone; use an IANA name such as Europe/Paris');
    return tx(async (c) => {
      if (i.on && i.at) i.scheduled_at = (await instant(c, i.on, i.at, i.timezone ?? 'UTC')).toISOString();
      const ctx = await appContext(user, i.id, c);
      assertEvaluation(ctx);
      if (!ctx.moderate) throw forbidden('Only a moderator, manager or approver can schedule interviews');
      assertWritable(ctx);
      checkEvalVersion(ctx.a, i.eval_version);
      if (ctx.a.status !== 'submitted') throw conflict(`This application is already ${ctx.a.status}`);
      if (!['shortlisted', 'interview'].includes(ctx.a.stage)) throw conflict('Shortlist the application before scheduling an interview');
      const open = (await c.query("SELECT 1 FROM sponsorship_interviews WHERE application_id=$1 AND status='scheduled'", [ctx.a.id])).rows[0];
      if (open) throw conflict('Complete or cancel the current interview before scheduling the next round');
      const seq = (await c.query('SELECT coalesce(max(seq),0)::int + 1 AS n FROM sponsorship_interviews WHERE application_id=$1', [ctx.a.id])).rows[0].n;
      const row = (await c.query('INSERT INTO sponsorship_interviews(application_id, seq, scheduled_at, timezone, video_url, location, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [ctx.a.id, seq, i.scheduled_at ?? null, i.timezone ?? null, i.video_url ?? null, i.location ?? null, i.notes ?? null, user.id])).rows[0];
      if (ctx.a.stage !== 'interview') await c.query("UPDATE sponsorship_applications SET stage='interview' WHERE id=$1", [ctx.a.id]);
      await logEvent(c, ctx.a.id, 'interview_scheduled', user.id, { seq });
      await notify(c, ctx.a.applicant_id, { kind: 'sponsorship_program', title: `Interview round ${seq}`, body: `${ctx.sp.name} invited you to an interview for ${ctx.p.name}${row.scheduled_at ? ` on ${row.scheduled_at.toISOString()}` : ''}. Open the application for the details.`, data: { application_id: ctx.a.id, interview_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'update_application_interview', method: 'PATCH', path: '/program-interviews/:id', tag: 'Sponsors',
  summary: 'Moderator, manager or approver: reschedule an interview that is still scheduled (time / link / notes), mark it completed with an internal outcome, or cancel it. Send the interview\'s current `version`.',
  input: z.object({ id, version: z.coerce.number().int().positive(), status: z.enum(['scheduled', 'completed', 'cancelled']).optional(), outcome: z.string().max(2000).optional(), ...interviewFields }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const iv0 = (await c.query('SELECT application_id FROM sponsorship_interviews WHERE id=$1', [i.id])).rows[0];
      if (!iv0) throw notFound('Interview');
      const ctx = await appContext(user, iv0.application_id, c);
      assertEvaluation(ctx);
      if (!ctx.moderate) throw forbidden('Only a moderator, manager or approver can change interviews');
      assertWritable(ctx);
      const iv = (await c.query('SELECT * FROM sponsorship_interviews WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      checkVersion(iv, i.version, 'interview');
      if (iv.status !== 'scheduled') throw conflict(`This interview is already ${iv.status}`);
      if (i.timezone && !validTimezone(i.timezone)) throw badRequest('Unknown timezone; use an IANA name such as Europe/Paris');
      if (i.on && i.at) i.scheduled_at = (await instant(c, i.on, i.at, i.timezone ?? iv.timezone ?? 'UTC')).toISOString();
      const next = { scheduled_at: i.scheduled_at ?? iv.scheduled_at, video_url: i.video_url ?? iv.video_url };
      if (!next.scheduled_at && !next.video_url) throw badRequest('An interview needs a time, a video link, or both');
      const row = (await c.query(
        `UPDATE sponsorship_interviews SET scheduled_at=$2, timezone=coalesce($3, timezone), video_url=$4, location=coalesce($5, location), notes=coalesce($6, notes), status=coalesce($7, status), outcome=coalesce($8, outcome), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [iv.id, next.scheduled_at, i.timezone ?? null, next.video_url, i.location ?? null, i.notes ?? null, i.status ?? null, i.outcome ?? null])).rows[0];
      await logEvent(c, ctx.a.id, i.status && i.status !== 'scheduled' ? `interview_${i.status}` : 'interview_changed', user.id, { seq: iv.seq });
      if (!i.status || i.status === 'scheduled') await notify(c, ctx.a.applicant_id, { kind: 'sponsorship_program', title: `Interview round ${iv.seq} updated`, body: `The details of your interview for ${ctx.p.name} changed. Open the application to see them.`, data: { application_id: ctx.a.id, interview_id: iv.id } });
      return row;
    });
  },
});

cap({
  name: 'list_application_interviews', method: 'GET', path: '/program-applications/:id/interviews', tag: 'Sponsors',
  summary: 'Committee and evaluation staff: every interview round of an application with its internal outcome.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await appContext(user, i.id, pool, { lock: false });
    assertEvaluation(ctx);
    return many(`SELECT ${interviewCols}, iv.outcome FROM sponsorship_interviews iv WHERE iv.application_id=$1 ORDER BY iv.seq`, [i.id]);
  },
});

cap({
  name: 'list_my_program_interviews', method: 'GET', path: '/my/program-interviews', tag: 'Sponsors',
  summary: 'Applicant: the interviews you are invited to for your own applications (time, timezone, link, location, notes, status). Internal outcomes and scores are never included.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${interviewCols}, p.name AS program_name, r.name AS round_name FROM sponsorship_interviews iv JOIN sponsorship_applications a ON a.id=iv.application_id JOIN sponsorship_programs p ON p.id=a.program_id JOIN sponsorship_rounds r ON r.id=a.round_id
      WHERE a.applicant_id=$1 AND iv.status <> 'cancelled' ORDER BY iv.scheduled_at NULLS LAST, iv.created_at DESC, iv.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

// ---------------------------------------------------------------- identity consent

cap({
  name: 'request_applicant_identity', method: 'POST', path: '/program-applications/:id/identity-request', tag: 'Sponsors', status: 201,
  summary: 'Brand manager/approver: ask the applicant to agree to be identified to the brand (the committee sees only an alias until they do). Nothing about who they are is shown before they grant it; awarding a blind application requires it.',
  input: z.object({ id, message: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await appContext(user, i.id, c);
      if (!ctx.manage) throw forbidden('Only a manager or approver can ask an applicant to be identified');
      assertWritable(ctx);
      if (ctx.a.status !== 'submitted') throw conflict(`This application is already ${ctx.a.status}`);
      const live = (await c.query("SELECT status FROM sponsorship_identity_consents WHERE application_id=$1 AND status IN ('requested','granted')", [ctx.a.id])).rows[0];
      if (live) throw conflict(live.status === 'granted' ? 'The applicant has already agreed to be identified' : 'A request is already waiting for the applicant');
      const row = (await c.query('INSERT INTO sponsorship_identity_consents(application_id, requested_by, message) VALUES ($1,$2,$3) RETURNING *', [ctx.a.id, user.id, i.message ?? null])).rows[0];
      await logEvent(c, ctx.a.id, 'identity_requested', user.id);
      await notify(c, ctx.a.applicant_id, { kind: 'sponsorship_program', title: 'Agree to be identified?', body: `${ctx.sp.name} asks to know who you are for your application to ${ctx.p.name}. You decide; scores are never shared with you or about you.`, data: { application_id: ctx.a.id, consent_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'respond_applicant_identity', method: 'POST', path: '/program-applications/:id/identity-response', tag: 'Sponsors',
  summary: 'Applicant (the person who applied): grant, deny or later revoke the brand\'s request to identify you. Only you can do this. Revoking hides your identity again going forward; awards already made stay.',
  input: z.object({ id, decision: z.enum(['grant', 'deny', 'revoke']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a || a.applicant_id !== user.id) throw notFound('Application'); // not yours = not found: nothing is revealed
      const cur = (await c.query("SELECT * FROM sponsorship_identity_consents WHERE application_id=$1 AND status IN ('requested','granted') FOR UPDATE", [a.id])).rows[0];
      if (!cur) throw conflict('There is no request to answer');
      if (i.decision === 'revoke' ? cur.status !== 'granted' : cur.status !== 'requested') throw conflict(i.decision === 'revoke' ? 'You have not agreed to be identified' : `You already answered (${cur.status})`);
      const to = { grant: 'granted', deny: 'denied', revoke: 'revoked' }[i.decision];
      const row = (await c.query('UPDATE sponsorship_identity_consents SET status=$2, responded_at=now() WHERE id=$1 RETURNING *', [cur.id, to])).rows[0];
      await logEvent(c, a.id, `identity_${to}`, user.id);
      const p = (await c.query('SELECT sp.* , p.name AS program_name FROM sponsorship_programs p JOIN sponsors sp ON sp.id=p.sponsor_id WHERE p.id=$1', [a.program_id])).rows[0];
      await notify(c, cur.requested_by, { kind: 'sponsorship_program', title: `Identity request ${to}`, body: `The applicant ${to === 'granted' ? 'agreed' : to === 'denied' ? 'declined' : 'withdrew their agreement'} to be identified for ${p.program_name}.`, data: { application_id: a.id } });
      return { id: row.id, status: row.status, responded_at: row.responded_at };
    });
  },
});

// ---------------------------------------------------------------- history and export

cap({
  name: 'get_application_history', method: 'GET', path: '/program-applications/:id/history', tag: 'Sponsors',
  summary: 'Moderators, managers/approvers and auditors: the append-only decision history of an application (stage moves, scores submitted - without values -, conflicts, moderation, interviews, identity consent) and, once decided, the decision record: the rubric as scored, the score result and the source references. Not available to plain reviewers or applicants.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const ctx = await appContext(user, i.id, pool, { lock: false });
    if (!ctx.seeAll) throw forbidden('Only a moderator, manager, approver or auditor can read the decision history');
    const events = await many(
      `SELECT e.id, e.kind, e.data, e.created_at, u.display_name AS actor FROM sponsorship_evaluation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.application_id=$1 ORDER BY e.created_at, e.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
    const decision = (await pool.query('SELECT decision, rubric_id, rubric_snapshot, score_snapshot, source_refs, created_at FROM sponsorship_decision_records WHERE application_id=$1', [i.id])).rows[0] ?? null;
    return { alias: aliasOf(i.id), events, decision };
  },
});

cap({
  name: 'export_round_evaluation', method: 'GET', path: '/program-rounds/:id/evaluation-export', tag: 'Sponsors',
  summary: 'Brand manager/approver/auditor: CSV of a round\'s evaluation (alias, stage, submitted scores, average, spread, moderated and final score, status). Applicants appear only as aliases unless they agreed to be identified. Confidential; the export is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await evalContext(user, i.id);
    if (!(ctx.manage || ctx.role === 'auditor')) throw forbidden(`Your role (${ctx.role}) cannot export evaluations`);
    const rb = await liveRubric(pool, i.id);
    const apps = await many("SELECT * FROM sponsorship_applications WHERE round_id=$1 AND status <> 'draft' ORDER BY created_at, id", [i.id]);
    const rows = [];
    for (const a of apps) {
      const s = await summarize(pool, a, rb);
      const granted = await identityGranted(pool, a.id);
      rows.push({ application: aliasOf(a.id), applicant: granted ? (await pool.query('SELECT handle FROM users WHERE id=$1', [a.applicant_id])).rows[0].handle : '', stage: a.stage, status: a.status, scores_submitted: s.submitted, average: s.average ?? '', spread: s.spread, moderated_total: s.moderated_total ?? '', final_score: s.final_score ?? '' });
    }
    await audit(null, user.id, 'export', 'sponsorship_rounds', i.id);
    return { filename: `round-${i.id}-evaluation.csv`, rows: rows.length, csv: toCsv(['application', 'applicant', 'stage', 'status', 'scores_submitted', 'average', 'spread', 'moderated_total', 'final_score'], rows) };
  },
});
