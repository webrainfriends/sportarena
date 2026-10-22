// Sponsorship performance review (#145 §7): a sponsor reads an athlete's permitted results during an agreement, with agreed review objectives and dated reviews.
// Results are read from the athlete's canonical `performances` at request time (never copied), so corrections show up straight away.
// Reading is consent-gated by the athlete, revocable, and never reaches private notes/ratings, medical data or contact details.
// Missing a target never touches a due: objectives are a review aid, not a payment condition.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { isYouth } from '../youth.js';
import { EVIDENCE_LABELS } from '../scoring/performance-rules.js';
import { logHistory, dealContext } from '../sponsor-agreements.js';
import { notifySponsor } from '../sponsor-access.js';

const TAG = 'Sponsors';
const date = z.string().date();
// Notifications carry no results, targets or review text.
const ping = (c, to, title, ctx, kind = 'sponsorship_performance') => {
  const msg = { kind, title, body: `Open the ${ctx.sp.name} agreement to see the update.`, data: { sponsorship_id: ctx.d.id } };
  return to === 'sponsor' ? notifySponsor(c, ctx.sp, 'performance', msg, ctx.d.department_id) : notify(c, to, msg);
};
const other = (ctx) => (ctx.role === 'sponsor' ? ctx.recipientId : 'sponsor');
const running = (ctx) => ['active', 'ended'].includes(ctx.d.status);
const athleteOnly = (ctx) => { if (ctx.d.target_type !== 'athlete') throw badRequest('Performance review is for agreements with an individual athlete; team and event results stay with their organisers'); };
const VALID = `((p.provenance='approved_competition' AND p.status='approved') OR (p.provenance IN ('self_reported','imported') AND p.status='recorded'))`;

cap({
  name: 'set_sponsorship_performance_access', method: 'POST', path: '/sponsorships/:id/performance-access', tag: TAG,
  summary: 'The sponsored athlete switches the sponsor\'s read access to their results on or off for this agreement. `official` shares approved competition results only; `all_evidence` also shares self-reported and imported figures (always labelled). Turning it off stops every future read at once; history and payments are untouched. Youth athletes cannot be enabled here.',
  input: z.object({ id, enabled: z.boolean(), scope: z.enum(['official', 'all_evidence']).default('official'), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role !== 'recipient') throw forbidden('Only the sponsored athlete decides who sees their results');
      athleteOnly(ctx);
      if (i.enabled) {
        if (ctx.d.status !== 'active') throw conflict('Results can only be shared under an active agreement');
        if (await isYouth(user.id, c)) throw forbidden('Sharing results under a youth agreement needs guardian authority, which is not enabled here');
      }
      const row = (await c.query('UPDATE sponsorships SET performance_access=$2, performance_scope=$3, performance_access_at=now(), performance_access_by=$4 WHERE id=$1 RETURNING performance_access, performance_scope, performance_access_at', [ctx.d.id, i.enabled, i.scope, user.id])).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.terms_version, user.id, i.enabled ? 'performance_access_granted' : 'performance_access_revoked', i.reason);
      await ping(c, 'sponsor', i.enabled ? 'Performance sharing was switched on' : 'Performance sharing was switched off', ctx);
      return row;
    });
  },
});

cap({
  name: 'propose_sponsorship_objective', method: 'POST', path: '/sponsorships/:id/objectives', tag: TAG, status: 201,
  summary: 'Sponsor: propose a review objective for the athlete — a sport metric, direction (lower is better for times), optional baseline, target, evaluation window and the kind of evidence that counts. It becomes agreed only when the athlete accepts it. It is a review aid: missing a target never cancels or reduces a due.',
  input: z.object({ id, sport: z.string().min(1).max(60).describe('sport slug'), metric: z.string().min(1).max(40), direction: z.enum(['higher', 'lower']), evidence: z.enum(['approved_competition', 'self_reported', 'imported']).default('approved_competition'),
    baseline_value: z.coerce.number().optional(), baseline_on: date.optional(), target_value: z.coerce.number(), window_start: date, window_end: date }),
  async handler({ user }, i) {
    if (i.window_end < i.window_start) throw badRequest('window_end is before window_start');
    if ((i.baseline_value === undefined) !== (i.baseline_on === undefined)) throw badRequest('Give both the baseline value and its date, or neither');
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor proposes objectives');
      ctx.need('evaluate', 'propose objectives');
      athleteOnly(ctx);
      if (!['proposed', 'active'].includes(ctx.d.status)) throw conflict(`The agreement is ${ctx.d.status}`);
      const sport = (await c.query('SELECT id FROM sports WHERE slug=$1', [i.sport])).rows[0];
      if (!sport) throw notFound('Sport');
      const row = (await c.query(
        `INSERT INTO sponsorship_objectives(sponsorship_id, sport_id, metric, direction, evidence, baseline_value, baseline_on, target_value, window_start, window_end, proposed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ctx.d.id, sport.id, i.metric, i.direction, i.evidence, i.baseline_value ?? null, i.baseline_on ?? null, i.target_value, i.window_start, i.window_end, user.id])).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.terms_version, user.id, 'objective_proposed');
      await ping(c, ctx.recipientId, 'A review objective was proposed', ctx);
      return row;
    });
  },
});

cap({
  name: 'decide_sponsorship_objective', method: 'PATCH', path: '/sponsorship-objectives/:id', tag: TAG,
  summary: 'The athlete agrees to or declines a proposed objective; the sponsor may archive one (nothing is deleted). Only an agreed objective is evaluated.',
  input: z.object({ id, status: z.enum(['agreed', 'declined', 'archived']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o0 = (await c.query('SELECT sponsorship_id FROM sponsorship_objectives WHERE id=$1', [i.id])).rows[0];
      if (!o0) throw notFound('Objective');
      const ctx = await dealContext(c, o0.sponsorship_id, user, { lock: true });
      const o = (await c.query('SELECT * FROM sponsorship_objectives WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (i.status === 'archived' ? ctx.role !== 'sponsor' : ctx.role !== 'recipient') throw forbidden(i.status === 'archived' ? 'Only the sponsor archives an objective' : 'Only the athlete agrees to an objective');
      if (i.status === 'archived') ctx.need('evaluate', 'archive objectives');
      if (i.status === 'archived' ? !['proposed', 'agreed'].includes(o.status) : o.status !== 'proposed') throw conflict(`This objective is already ${o.status}`);
      const row = (await c.query('UPDATE sponsorship_objectives SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 RETURNING *', [o.id, i.status, user.id])).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.terms_version, user.id, `objective_${i.status}`);
      await ping(c, other(ctx), `A review objective was ${i.status}`, ctx);
      return row;
    });
  },
});

cap({
  name: 'get_sponsorship_performance', method: 'GET', path: '/sponsorships/:id/performance', tag: TAG,
  summary: 'The athlete\'s results for one agreement, read live from their canonical records: per sport, metric and kind of evidence — sample size, first and latest result, best (in the metric\'s direction), latest and the period covered — plus the agreed objectives with progress. Only metrics of the same sport and evidence are compared; there is no combined athlete score. Official and self-reported/imported figures are kept apart and labelled. The sponsor sees this only while the athlete has switched sharing on (and only the shared evidence kinds); never private notes, ratings, medical or contact data.',
  input: z.object({ id, from: date.optional(), to: date.optional() }),
  async handler({ user }, i) {
    if (i.from && i.to && i.to < i.from) throw badRequest('to is before from');
    const ctx = await dealContext(pool, i.id, user);
    athleteOnly(ctx);
    if (ctx.role === 'sponsor') {
      ctx.need('performance', 'read an athlete\'s results');
      if (!running(ctx)) throw conflict('Results are available once the athlete has accepted the agreement');
      if (!ctx.d.performance_access) throw forbidden('The athlete has not shared their results for this agreement');
    }
    const evidence = ctx.role === 'sponsor' && ctx.d.performance_scope === 'official' ? ['approved_competition'] : ['approved_competition', 'self_reported', 'imported'];
    const day = 'coalesce(p.achieved_on, p.recorded_at::date)';
    const metrics = await many(
      `SELECT s.slug AS sport, s.name AS sport_name, p.metric, p.provenance AS evidence, p.unit, coalesce(p.direction,'higher') AS direction, count(*)::int AS results,
              to_char(min(${day}),'YYYY-MM-DD') AS first_on, to_char(max(${day}),'YYYY-MM-DD') AS latest_on,
              CASE WHEN coalesce(p.direction,'higher')='lower' THEN min(p.value) ELSE max(p.value) END::float8 AS best,
              (array_agg(p.value ORDER BY ${day} DESC, p.recorded_at DESC))[1]::float8 AS latest
         FROM performances p JOIN sports s ON s.id=p.sport_id
        WHERE p.user_id=$1 AND ${VALID} AND p.provenance = ANY($2::text[]) AND ($3::date IS NULL OR ${day} >= $3) AND ($4::date IS NULL OR ${day} <= $4)
        GROUP BY s.slug, s.name, p.metric, p.provenance, p.unit, coalesce(p.direction,'higher') ORDER BY s.slug, p.metric, p.provenance`,
      [ctx.recipientId, evidence, i.from ?? null, i.to ?? null]);
    const objectives = await many(
      `SELECT o.id, o.status, s.slug AS sport, o.metric, o.direction, o.evidence, o.baseline_value::float8, o.baseline_on::text, o.target_value::float8, o.window_start::text, o.window_end::text
         FROM sponsorship_objectives o JOIN sports s ON s.id=o.sport_id WHERE o.sponsorship_id=$1 AND o.status IN ('proposed','agreed') ORDER BY o.created_at, o.id`, [ctx.d.id]);
    for (const o of objectives) {
      if (o.status !== 'agreed') continue;
      if (!evidence.includes(o.evidence)) { o.progress = { state: 'not_shared', note: 'This kind of evidence is not shared for this agreement' }; continue; }
      const r = (await pool.query(
        `SELECT count(*)::int AS results, (CASE WHEN $6='lower' THEN min(p.value) ELSE max(p.value) END)::float8 AS best
           FROM performances p JOIN sports s ON s.id=p.sport_id
          WHERE p.user_id=$1 AND s.slug=$2 AND p.metric=$3 AND p.provenance=$4 AND ${VALID} AND ${day} BETWEEN $5::date AND $7::date`,
        [ctx.recipientId, o.sport, o.metric, o.evidence, o.window_start, o.direction, o.window_end])).rows[0];
      o.progress = r.results ? { state: 'measured', results: r.results, best_in_window: r.best, met: o.direction === 'lower' ? r.best <= o.target_value : r.best >= o.target_value, source: EVIDENCE_LABELS[o.evidence] }
        : { state: 'no_results', note: 'No results in the evaluation window yet' };
    }
    return {
      agreement_id: ctx.d.id, role: ctx.role, access: { enabled: ctx.d.performance_access, scope: ctx.d.performance_scope },
      evidence_shown: evidence.map((e) => ({ evidence: e, label: EVIDENCE_LABELS[e] })),
      period: { from: i.from ?? null, to: i.to ?? null },
      metrics: metrics.map((m) => ({ ...m, evidence_label: EVIDENCE_LABELS[m.evidence] })),
      objectives,
      note: 'Read live from the athlete\'s own records; a corrected result changes this view. Sports and evidence kinds are never combined into one score. Objectives do not affect any payment due.',
    };
  },
});

cap({
  name: 'add_sponsorship_review', method: 'POST', path: '/sponsorships/:id/reviews', tag: TAG, status: 201,
  summary: 'Either side adds a dated review note and, optionally, the next review date. `shared` notes are read by both sides; `author_only` notes are read only by their author. Notes are never part of any contractual decision.',
  input: z.object({ id, body: z.string().min(2).max(2000), visibility: z.enum(['shared', 'author_only']).default('shared'), next_review_on: date.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role !== 'sponsor' && ctx.role !== 'recipient') throw forbidden('Only the two sides review an agreement');
      if (ctx.role === 'sponsor') ctx.need('evaluate', 'write reviews');
      if (!running(ctx)) throw conflict('Reviews are kept once the agreement has been accepted');
      const row = (await c.query('INSERT INTO sponsorship_reviews(sponsorship_id, author_id, body, visibility, next_review_on) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ctx.d.id, user.id, i.body, i.visibility, i.next_review_on ?? null])).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.terms_version, user.id, 'review_added');
      if (i.visibility === 'shared') await ping(c, other(ctx), 'A review was shared with you', ctx);
      return row;
    });
  },
});

cap({
  name: 'list_sponsorship_reviews', method: 'GET', path: '/sponsorships/:id/reviews', tag: TAG,
  summary: 'Reviews on an agreement, oldest first: every shared note plus your own author-only notes, with the recipient\'s response and the next review date.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (ctx.role === 'admin') throw forbidden('Reviews are between the two sides');
    if (ctx.role === 'sponsor') ctx.need('performance', 'read reviews');
    return many(
      `SELECT r.id, r.body, r.visibility, r.next_review_on::text, r.response, r.responded_at, r.created_at, (r.author_id=$2) AS mine, u.display_name AS author
         FROM sponsorship_reviews r JOIN users u ON u.id=r.author_id WHERE r.sponsorship_id=$1 AND (r.visibility='shared' OR r.author_id=$2) ORDER BY r.created_at, r.id`, [ctx.d.id, user.id]);
  },
});

cap({
  name: 'respond_to_sponsorship_review', method: 'POST', path: '/sponsorship-reviews/:id/response', tag: TAG,
  summary: 'The athlete answers a shared review written by the sponsor. One response per review.',
  input: z.object({ id, response: z.string().min(2).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r0 = (await c.query('SELECT sponsorship_id FROM sponsorship_reviews WHERE id=$1', [i.id])).rows[0];
      if (!r0) throw notFound('Review');
      const ctx = await dealContext(c, r0.sponsorship_id, user, { lock: true });
      if (ctx.role !== 'recipient') throw forbidden('Only the athlete responds to a sponsor review');
      const r = (await c.query('SELECT * FROM sponsorship_reviews WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (r.visibility !== 'shared' || r.author_id === ctx.recipientId) throw forbidden('That review is not addressed to you');
      if (r.response) throw conflict('Already answered');
      const row = (await c.query('UPDATE sponsorship_reviews SET response=$2, responded_at=now() WHERE id=$1 RETURNING *', [r.id, i.response])).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.terms_version, user.id, 'review_answered');
      await ping(c, 'sponsor', 'Your review was answered', ctx);
      return row;
    });
  },
});
