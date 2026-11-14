import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound, conflict } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { manages, eligibleFor, published } from '../feedback.js';
import { notify } from '../notify.js';
import { encrypt } from '../crypto.js';

const TAG = 'Feedback';

cap({
  name: 'get_feedback_eligibility', method: 'GET', path: '/feedback/eligibility', tag: TAG,
  summary: 'Check whether the signed-in user can submit verified feedback for a given interaction. Returns eligibility status, evidence type, applicable policy (dimensions, window, NPS flag) and a readable reason if blocked.',
  input: z.object({ context_type: z.string(), context_id: id }),
  async handler({ user }, i) {
    return eligibleFor(user, i.context_type, i.context_id);
  },
});

cap({
  name: 'get_feedback_analytics', method: 'GET', path: '/feedback/analytics/:subject_type/:subject_id', tag: TAG,
  summary: 'Recipient analytics: mean, star distribution, dimension breakdown, NPS, reply rate, response time and monthly trend. Subject owner only.',
  input: z.object({ subject_type: z.string(), subject_id: id, period_days: z.coerce.number().int().min(7).max(3650).default(90) }),
  async handler({ user }, i) {
    if (!(await manages(user, i.subject_type, i.subject_id))) throw forbidden('Only the subject owner can view their analytics');
    const cutoff = new Date(Date.now() - i.period_days * 86400000).toISOString();
    const [summary, distribution, roles, dimensions, nps, replyStats, trend] = await Promise.all([
      one(`SELECT round(avg(t.rating),2) AS avg, count(*)::int AS n, count(*) FILTER (WHERE t.verification='verified_interaction')::int AS verified, count(*) FILTER (WHERE t.created_at >= $3)::int AS period_n FROM testimonials t WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()}`, [i.subject_type, i.subject_id, cutoff]),
      many(`SELECT t.rating, count(*)::int AS n FROM testimonials t WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()} GROUP BY t.rating ORDER BY t.rating DESC`, [i.subject_type, i.subject_id]),
      many(`SELECT t.author_role, round(avg(t.rating),2) AS avg, count(*)::int AS n FROM testimonials t WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()} AND t.author_role IS NOT NULL GROUP BY t.author_role`, [i.subject_type, i.subject_id]),
      one(`SELECT avg(CASE WHEN d->>'key'='instruction_quality' THEN (d->>'rating')::int END) AS instruction_quality, avg(CASE WHEN d->>'key'='punctuality' THEN (d->>'rating')::int END) AS punctuality, avg(CASE WHEN d->>'key'='communication' THEN (d->>'rating')::int END) AS communication, avg(CASE WHEN d->>'key'='preparation' THEN (d->>'rating')::int END) AS preparation, avg(CASE WHEN d->>'key'='value' THEN (d->>'rating')::int END) AS value FROM testimonials t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.dimensions_json,'[]'::jsonb)) d WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()}`, [i.subject_type, i.subject_id]),
      one(`SELECT count(*) FILTER (WHERE t.nps_score >= 9)::int AS promoters, count(*) FILTER (WHERE t.nps_score BETWEEN 7 AND 8)::int AS passives, count(*) FILTER (WHERE t.nps_score <= 6 AND t.nps_score IS NOT NULL)::int AS detractors, count(*) FILTER (WHERE t.nps_score IS NOT NULL)::int AS nps_total, CASE WHEN count(*) FILTER (WHERE t.nps_score IS NOT NULL) = 0 THEN NULL ELSE round((count(*) FILTER (WHERE t.nps_score >= 9)::numeric - count(*) FILTER (WHERE t.nps_score <= 6 AND t.nps_score IS NOT NULL)::numeric) / count(*) FILTER (WHERE t.nps_score IS NOT NULL) * 100, 0) END AS nps_score FROM testimonials t WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()}`, [i.subject_type, i.subject_id]),
      one(`SELECT count(*) FILTER (WHERE t.reply_body IS NOT NULL)::int AS replied, count(*)::int AS total, round(count(*) FILTER (WHERE t.reply_body IS NOT NULL)::numeric / NULLIF(count(*),0) * 100,1) AS reply_rate_pct, round(avg(EXTRACT(EPOCH FROM (t.replied_at - t.created_at))/86400) FILTER (WHERE t.replied_at IS NOT NULL),1) AS avg_response_days FROM testimonials t WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()}`, [i.subject_type, i.subject_id]),
      many(`SELECT date_trunc('month', t.created_at) AS month, round(avg(t.rating),2) AS avg, count(*)::int AS n FROM testimonials t WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()} AND t.created_at >= $3 GROUP BY 1 ORDER BY 1`, [i.subject_type, i.subject_id, cutoff]),
    ]);
    return { summary, distribution, roles, dimensions, nps, reply: replyStats, trend, period_days: i.period_days };
  },
});

cap({
  name: 'get_feedback_moderation_queue', method: 'GET', path: '/feedback/moderation', tag: TAG, auth: ['admin'],
  summary: 'Admin only. Open testimonial reports and pending appeals, paginated. Filterable by type and category.',
  input: z.object({ type: z.enum(['reports', 'appeals', 'all']).default('all'), category: z.string().optional(), ...page }),
  async handler(_, i) {
    const catClause = i.category ? 'AND tr.category=$3' : '';
    const catParams = i.category ? [i.category] : [];
    const reports = (i.type === 'reports' || i.type === 'all') ? await many(
      `SELECT tr.id, tr.category, tr.details, tr.created_at, tr.status, t.id AS testimonial_id, t.subject_type, t.subject_id, t.rating, t.body, t.author_id, t.verification, u.display_name AS author_name, u.handle AS author_handle, u2.display_name AS reporter_name FROM testimonial_reports tr JOIN testimonials t ON t.id=tr.testimonial_id JOIN users u ON u.id=t.author_id JOIN users u2 ON u2.id=tr.reporter_id WHERE tr.status='open' ${catClause} ORDER BY tr.created_at LIMIT $1 OFFSET $2`,
      [i.limit, i.offset, ...catParams]
    ) : [];
    const appeals = (i.type === 'appeals' || i.type === 'all') ? await many(
      `SELECT fa.id, fa.reason, fa.evidence_refs, fa.created_at, fa.status, t.id AS testimonial_id, t.subject_type, t.subject_id, t.rating, t.body, t.moderation_reason, u.display_name AS author_name FROM feedback_appeals fa JOIN testimonials t ON t.id=fa.testimonial_id JOIN users u ON u.id=fa.author_id WHERE fa.status='pending' ORDER BY fa.created_at LIMIT $1 OFFSET $2`,
      [i.limit, i.offset]
    ) : [];
    return { reports, appeals };
  },
});

cap({
  name: 'submit_feedback_appeal', method: 'POST', path: '/testimonials/:id/appeal', tag: TAG, status: 201,
  summary: 'Appeal a moderation decision (hidden review). Provide a reason and optional evidence references. One appeal per author per review.',
  input: z.object({ id, reason: z.string().min(10).max(2000), evidence_refs: z.array(z.string().max(200)).max(10).optional() }),
  async handler({ user }, i) {
    const t = await mustFind('testimonials', i.id);
    if (t.author_id !== user.id) throw forbidden('Only the review author can appeal');
    if (t.status !== 'hidden') throw badRequest('Only hidden reviews can be appealed');
    if (t.appeal_status === 'pending') throw conflict('An appeal is already pending for this review');
    return tx(async (c) => {
      await c.query("UPDATE testimonials SET appeal_status='pending' WHERE id=$1", [t.id]);
      return (await c.query('INSERT INTO feedback_appeals(testimonial_id,author_id,reason,evidence_refs) VALUES ($1,$2,$3,$4) RETURNING *', [t.id, user.id, i.reason, i.evidence_refs ?? null])).rows[0];
    });
  },
});

cap({
  name: 'decide_feedback_appeal', method: 'POST', path: '/feedback/appeals/:id/decide', tag: TAG, auth: ['admin'],
  summary: 'Admin only. Uphold (restore review) or dismiss an appeal. Author is notified either way.',
  input: z.object({ id, decision: z.enum(['upheld', 'dismissed']), outcome_notes: z.string().min(5).max(500) }),
  async handler({ user }, i) {
    const appeal = await mustFind('feedback_appeals', i.id);
    if (appeal.status !== 'pending') throw conflict('This appeal has already been decided');
    const upheld = i.decision === 'upheld';
    return tx(async (c) => {
      const row = (await c.query('UPDATE feedback_appeals SET status=$2,decided_by=$3,decided_at=now(),outcome_notes=$4 WHERE id=$1 RETURNING *', [appeal.id, i.decision, user.id, i.outcome_notes])).rows[0];
      await c.query(
        "UPDATE testimonials SET appeal_status=$2, status=CASE WHEN $3 THEN 'published' ELSE status END, moderation_reason=CASE WHEN $3 THEN NULL ELSE moderation_reason END WHERE id=$1",
        [appeal.testimonial_id, i.decision, upheld]
      );
      if (upheld) await c.query("INSERT INTO testimonial_revisions(testimonial_id,action,actor_id,rating,body,status,reason) SELECT id,'restore',$2,rating,body,'hidden',$3 FROM testimonials WHERE id=$1", [appeal.testimonial_id, user.id, 'Appeal upheld: ' + i.outcome_notes]);
      await notify(c, appeal.author_id, { kind: 'appeal_decided', title: upheld ? 'Your appeal was upheld — review restored' : 'Your appeal was not upheld', body: i.outcome_notes.slice(0, 200), data: { testimonial_id: appeal.testimonial_id } });
      return row;
    });
  },
});

cap({
  name: 'configure_blind_review', method: 'POST', path: '/feedback/blind-sessions', tag: TAG, status: 201,
  summary: 'Set up a blind reciprocal review pairing for a context. Both reviews are hidden until both submit or the reveal deadline passes.',
  input: z.object({ context_type: z.string(), context_id: id, party_a_id: id, party_b_id: id, reveal_days: z.number().int().min(1).max(90).default(30) }),
  async handler(_, i) {
    if (i.party_a_id === i.party_b_id) throw badRequest('Both parties must be different users');
    const revealAt = new Date(Date.now() + i.reveal_days * 86400000).toISOString();
    return one('INSERT INTO feedback_blind_sessions(context_type,context_id,party_a_id,party_b_id,reveal_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (context_type,context_id,party_a_id,party_b_id) DO UPDATE SET reveal_at=$5 RETURNING *', [i.context_type, i.context_id, i.party_a_id, i.party_b_id, revealAt]);
  },
});

cap({
  name: 'invite_feedback', method: 'POST', path: '/feedback/invite', tag: TAG, status: 201,
  summary: 'Send a feedback invitation to an entire cohort (not cherry-picked individuals). Throttled to one campaign per context per 72 hours.',
  input: z.object({ context_type: z.string(), context_id: id, cohort: z.enum(['all','participants','officials','coaches','customers','staff']), message: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const recent = await one("SELECT id FROM feedback_invitations WHERE context_type=$1 AND context_id=$2 AND sender_id=$3 AND cohort=$4 AND sent_at > now() - interval '72 hours'", [i.context_type, i.context_id, user.id, i.cohort]);
    if (recent) throw conflict('You can only send one invitation campaign per cohort per 72 hours');
    return one('INSERT INTO feedback_invitations(context_type,context_id,sender_id,cohort) VALUES ($1,$2,$3,$4) RETURNING *', [i.context_type, i.context_id, user.id, i.cohort]);
  },
});

cap({
  name: 'submit_performance_feedback', method: 'POST', path: '/feedback/performance', tag: TAG, status: 201,
  summary: 'Submit rubric-based developmental feedback for an athlete or team member. Private by default, visible only to the recipient. Never enters public reputation aggregates.',
  input: z.object({
    recipient_id:    id,
    context_type:    z.string().max(60),
    context_id:      id,
    sport_id:        id.optional(),
    rubric:          z.array(z.object({ skill: z.string().max(80), score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() })).min(1).max(20),
    overall_comment: z.string().max(2000).optional(),
    recommendations: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    if (i.recipient_id === user.id) throw badRequest('You cannot submit performance feedback about yourself');
    const bodyEnc = i.overall_comment ? await encrypt(i.overall_comment, 'performance_feedback') : null;
    const recsEnc = i.recommendations ? await encrypt(i.recommendations, 'performance_feedback') : null;
    return one(
      "INSERT INTO peer_skill_assessments(assessor_id,subject_id,context_type,context_id,sport_id,skills,body_enc,recommendations_enc,visibility) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'private') RETURNING id,assessor_id,subject_id,context_type,created_at",
      [user.id, i.recipient_id, i.context_type, i.context_id, i.sport_id ?? null, JSON.stringify(i.rubric), bodyEnc, recsEnc]
    );
  },
});

cap({
  name: 'list_received_feedback', method: 'GET', path: '/feedback/received', tag: TAG,
  summary: 'All public and private feedback received by the signed-in user, including private developmental assessments. Paginated.',
  input: z.object({ type: z.enum(['all','public','private','performance']).default('all'), ...page }),
  async handler({ user }, i) {
    const publicFeedback = (i.type === 'all' || i.type === 'public') ? await many(
      `SELECT t.id, t.subject_type, t.rating, t.body, t.created_at, t.updated_at, t.verification, t.author_role, t.dimensions_json, t.reply_body, t.replied_at, u.display_name AS author_name, u.handle AS author_handle, u.avatar_emoji FROM testimonials t JOIN users u ON u.id=t.author_id WHERE t.subject_id=$1 AND t.subject_type='user' AND t.status='published' AND t.visibility='public' ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`,
      [user.id, i.limit, i.offset]
    ) : [];
    const privateFeedback = (i.type === 'all' || i.type === 'private') ? await many(
      `SELECT t.id, t.subject_type, t.rating, t.body, t.created_at, t.verification, t.author_role, t.dimensions_json FROM testimonials t WHERE t.private_recipient_id=$1 AND t.visibility='private' AND t.status='published' ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`,
      [user.id, i.limit, i.offset]
    ) : [];
    const performance = (i.type === 'all' || i.type === 'performance') ? await many(
      'SELECT psa.id, psa.assessor_id, psa.context_type, psa.skills, psa.created_at, u.display_name AS assessor_name FROM peer_skill_assessments psa JOIN users u ON u.id=psa.assessor_id WHERE psa.subject_id=$1 ORDER BY psa.created_at DESC LIMIT $2 OFFSET $3',
      [user.id, i.limit, i.offset]
    ) : [];
    return { public_feedback: publicFeedback, private_feedback: privateFeedback, performance };
  },
});
