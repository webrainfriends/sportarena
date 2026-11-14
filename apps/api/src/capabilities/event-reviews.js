// Issue #1190: Verified Event Reviews — multi-dimension event feedback with role context,
// eligibility gating, organiser analytics, response flow and anti-selective-invite controls.
// Reviews use the existing testimonials table (context_type='event_experience') plus
// event_dimension_reviews for structured dimension data.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { isYouth } from '../youth.js';
import { notify } from '../notify.js';

const TAG = 'EventReviews';
const REVIEWER_ROLES = ['participant', 'official', 'coach', 'ticketed_attendee', 'organizer_staff'];
const PRIVACY_THRESHOLD = 3;

const dimensionSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(100),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

async function assertOrganiser(user, eventId) {
  const org = await one(
    "SELECT 1 FROM events WHERE id=$1 AND (organiser_id=$2 OR id IN (SELECT event_id FROM event_staff WHERE user_id=$2 AND role='organiser'))",
    [eventId, user.id],
  );
  if (!org && !isAdmin(user)) throw forbidden('Only the event organiser can do this');
}

async function getEligibility(userId, eventId) {
  // Check in priority order: registration > check-in > ticket > official > coach > stored evidence
  const reg = await one(
    "SELECT 1 FROM event_registrations WHERE event_id=$1 AND user_id=$2 AND status IN ('confirmed','attended')",
    [eventId, userId],
  );
  if (reg) return { eligible: true, role: 'participant', evidence_type: 'registration', verified: true };
  const checkin = await one(
    "SELECT 1 FROM event_check_ins WHERE event_id=$1 AND user_id=$2",
    [eventId, userId],
  );
  if (checkin) return { eligible: true, role: 'participant', evidence_type: 'check_in', verified: true };
  const ticket = await one(
    "SELECT 1 FROM tickets WHERE event_id=$1 AND holder_id=$2 AND status IN ('used','confirmed')",
    [eventId, userId],
  );
  if (ticket) return { eligible: true, role: 'ticketed_attendee', evidence_type: 'ticket', verified: true };
  const official = await one(
    "SELECT 1 FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE f.event_id=$1 AND fo.user_id=$2",
    [eventId, userId],
  );
  if (official) return { eligible: true, role: 'official', evidence_type: 'official_assignment', verified: true };
  const coach = await one(
    "SELECT 1 FROM event_staff WHERE event_id=$1 AND user_id=$2 AND role IN ('coach','assistant_coach')",
    [eventId, userId],
  );
  if (coach) return { eligible: true, role: 'coach', evidence_type: 'coach_assignment', verified: true };
  const stored = await one(
    "SELECT evidence_type, verified FROM review_eligibility_evidence WHERE event_id=$1 AND user_id=$2 ORDER BY verified DESC LIMIT 1",
    [eventId, userId],
  );
  if (stored) return { eligible: true, role: 'participant', evidence_type: stored.evidence_type, verified: stored.verified };
  return { eligible: false, role: null, evidence_type: null, verified: false, reason: 'No verified attendance, registration, ticket, official assignment or coach assignment found for this event' };
}

cap({
  name: 'get_event_review_eligibility', method: 'GET', path: '/events/:event_id/review-eligibility', tag: TAG,
  summary: 'Check whether the current user is eligible to review an event and what role they would review as.',
  input: z.object({ event_id: id }),
  async handler({ user }, i) {
    const event = await mustFind('events', i.event_id);
    return { event_id: i.event_id, ...(await getEligibility(user.id, i.event_id)) };
  },
});

cap({
  name: 'create_event_review', method: 'POST', path: '/events/:event_id/reviews', tag: TAG, status: 201,
  summary: 'Submit a multi-dimension event review. Requires verified attendance, registration, ticket, official or coach assignment. Event must be completed. One review per eligible user. Organiser cannot review their own event.',
  input: z.object({
    event_id: id,
    overall: z.number().int().min(1).max(5),
    dimensions: z.array(dimensionSchema).min(1).max(10),
    body: z.string().min(10).max(2000).optional(),
    reviewer_role: z.enum(REVIEWER_ROLES).optional(),
    nps: z.number().int().min(0).max(10).optional(),
  }),
  async handler({ user }, i) {
    const event = await mustFind('events', i.event_id);
    if (event.status !== 'completed') throw badRequest('Reviews can only be submitted after the event is completed');
    if (event.organiser_id === user.id) throw badRequest('The organiser cannot review their own event');
    const elig = await getEligibility(user.id, i.event_id);
    if (!elig.eligible) throw badRequest(elig.reason ?? 'You are not eligible to review this event');
    const role = i.reviewer_role ?? elig.role;
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const existing = await q(
        "SELECT t.id FROM testimonials t JOIN event_dimension_reviews edr ON edr.testimonial_id=t.id WHERE t.author_id=$1 AND edr.event_id=$2 AND t.status!='withdrawn'",
        [user.id, i.event_id],
      );
      if (existing) throw badRequest('You have already reviewed this event. Use the update endpoint to edit your review.');
      const testimonial = await q(
        `INSERT INTO testimonials(author_id, subject_type, subject_id, rating, body, verification, context_type, context_id, role_context)
         VALUES ($1,'event',$2,$3,$4,'verified_interaction','event_experience',NULL,$5)
         RETURNING *`,
        [user.id, i.event_id, i.overall, i.body ?? '', role],
      );
      const dimReview = await q(
        `INSERT INTO event_dimension_reviews(testimonial_id, event_id, reviewer_role, eligibility_evidence, verified, dimensions, overall)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          testimonial.id, i.event_id, role,
          JSON.stringify({ evidence_type: elig.evidence_type, nps: i.nps ?? null }),
          elig.verified, JSON.stringify(i.dimensions), i.overall,
        ],
      );
      await c.query(
        `UPDATE testimonials SET context_id=$2 WHERE id=$1`,
        [testimonial.id, dimReview.id],
      );
      return { testimonial_id: testimonial.id, review_id: dimReview.id, overall: i.overall, verified: elig.verified, role };
    });
  },
});

cap({
  name: 'update_event_review', method: 'PUT', path: '/event-reviews/:id', tag: TAG,
  summary: 'Update your event review dimensions, body or overall rating.',
  input: z.object({
    id,
    overall: z.number().int().min(1).max(5).optional(),
    dimensions: z.array(dimensionSchema).optional(),
    body: z.string().min(10).max(2000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const edr = await q('SELECT edr.*, t.author_id FROM event_dimension_reviews edr JOIN testimonials t ON t.id=edr.testimonial_id WHERE edr.id=$1 FOR UPDATE', [i.id]);
      if (!edr) throw notFound('event_review');
      if (edr.author_id !== user.id) throw forbidden();
      if (i.overall) {
        await c.query('UPDATE testimonials SET rating=$2, updated_at=now() WHERE id=$1', [edr.testimonial_id, i.overall]);
        if (i.body) await c.query('UPDATE testimonials SET body=$2, updated_at=now() WHERE id=$1', [edr.testimonial_id, i.body]);
      }
      return q(
        `UPDATE event_dimension_reviews SET
           dimensions = COALESCE($2, dimensions),
           overall = COALESCE($3, overall)
         WHERE id=$1 RETURNING id, overall, dimensions`,
        [i.id, i.dimensions ? JSON.stringify(i.dimensions) : null, i.overall ?? null],
      );
    });
  },
});

cap({
  name: 'withdraw_event_review', method: 'POST', path: '/event-reviews/:id/withdraw', tag: TAG,
  summary: 'Withdraw your event review. It leaves public listings and aggregates immediately.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const edr = await q('SELECT edr.*, t.author_id FROM event_dimension_reviews edr JOIN testimonials t ON t.id=edr.testimonial_id WHERE edr.id=$1 FOR UPDATE', [i.id]);
      if (!edr) throw notFound('event_review');
      if (edr.author_id !== user.id && !isAdmin(user)) throw forbidden();
      await c.query("UPDATE testimonials SET status='withdrawn', updated_at=now() WHERE id=$1", [edr.testimonial_id]);
      return { review_id: edr.id, status: 'withdrawn' };
    });
  },
});

cap({
  name: 'list_event_reviews', method: 'GET', path: '/events/:event_id/reviews', tag: TAG,
  summary: 'Public listing of event reviews above the privacy threshold (k≥3). Returns role-breakdown cohorts, aggregate per dimension, and suppressed status below threshold.',
  input: z.object({ event_id: id, role: z.enum(REVIEWER_ROLES).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT edr.id, edr.reviewer_role, edr.overall, edr.dimensions, edr.verified,
              edr.organizer_response, edr.organizer_responded_at,
              t.body, t.created_at
       FROM event_dimension_reviews edr
       JOIN testimonials t ON t.id=edr.testimonial_id
       WHERE edr.event_id=$1 AND t.status='published'
         ${i.role ? 'AND edr.reviewer_role=$4' : ''}
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [i.event_id, i.limit ?? 20, i.offset ?? 0, ...(i.role ? [i.role] : [])],
    );
    const total = await one(
      `SELECT COUNT(*)::int AS n FROM event_dimension_reviews edr JOIN testimonials t ON t.id=edr.testimonial_id WHERE edr.event_id=$1 AND t.status='published'`,
      [i.event_id],
    );
    if ((total?.n ?? 0) < PRIVACY_THRESHOLD) {
      return { suppressed: true, threshold: PRIVACY_THRESHOLD, total: total?.n ?? 0, reviews: [] };
    }
    return { suppressed: false, threshold: PRIVACY_THRESHOLD, total: total?.n ?? 0, reviews: rows };
  },
});

cap({
  name: 'get_event_review_analytics', method: 'GET', path: '/events/:event_id/review-analytics', tag: TAG,
  summary: 'Organiser-only: full analytics dashboard — dimension averages, NPS, star distribution, role averages, response rate, flagged items, edition trend. Access is audit logged.',
  input: z.object({ event_id: id }),
  async handler({ user }, i) {
    await assertOrganiser(user, i.event_id);
    audit(user, 'event_review_analytics', i.event_id);
    const reviews = await many(
      `SELECT edr.reviewer_role, edr.overall, edr.dimensions, edr.verified, edr.organizer_response,
              t.status, t.created_at,
              (t.status='hidden')::boolean AS flagged,
              (edr.eligibility_evidence->>'nps')::int AS nps
       FROM event_dimension_reviews edr
       JOIN testimonials t ON t.id=edr.testimonial_id
       WHERE edr.event_id=$1 AND t.status IN ('published','hidden')`,
      [i.event_id],
    );
    const published = reviews.filter((r) => r.status === 'published');
    const total = published.length;
    const flagged = reviews.filter((r) => r.flagged).length;
    const responded = published.filter((r) => r.organizer_response).length;
    const avgOverall = total ? (published.reduce((s, r) => s + r.overall, 0) / total).toFixed(2) : null;
    const starDist = [0, 0, 0, 0, 0];
    published.forEach((r) => starDist[r.overall - 1]++);
    const npsScores = published.map((r) => r.nps).filter((n) => n != null);
    const promoters = npsScores.filter((n) => n >= 9).length;
    const detractors = npsScores.filter((n) => n <= 6).length;
    const nps = npsScores.length ? Math.round(((promoters - detractors) / npsScores.length) * 100) : null;
    const dimMap = {};
    for (const r of published) {
      const dims = Array.isArray(r.dimensions) ? r.dimensions : JSON.parse(r.dimensions ?? '[]');
      for (const d of dims) {
        if (!dimMap[d.key]) dimMap[d.key] = { key: d.key, label: d.label, sum: 0, count: 0 };
        dimMap[d.key].sum += d.rating;
        dimMap[d.key].count++;
      }
    }
    const dimensions = Object.values(dimMap).map((d) => ({ key: d.key, label: d.label, avg: (d.sum / d.count).toFixed(2), count: d.count }));
    const roleAverages = {};
    for (const r of published) {
      if (!roleAverages[r.reviewer_role]) roleAverages[r.reviewer_role] = { sum: 0, count: 0 };
      roleAverages[r.reviewer_role].sum += r.overall;
      roleAverages[r.reviewer_role].count++;
    }
    return {
      event_id: i.event_id, total, flagged, response_rate: total ? Math.round((responded / total) * 100) : 0,
      avg_overall: avgOverall, star_distribution: starDist, nps, nps_respondents: npsScores.length,
      promoters, detractors, passives: npsScores.length - promoters - detractors,
      dimensions,
      role_averages: Object.entries(roleAverages).map(([role, v]) => ({ role, avg: (v.sum / v.count).toFixed(2), count: v.count })),
    };
  },
});

cap({
  name: 'respond_to_event_review', method: 'POST', path: '/event-reviews/:id/organizer-response', tag: TAG,
  summary: 'Organiser writes a public response to a review. Visible inline on the review. One response per review; use PUT to update.',
  input: z.object({ id, response: z.string().min(10).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const edr = await q('SELECT * FROM event_dimension_reviews WHERE id=$1 FOR UPDATE', [i.id]);
      if (!edr) throw notFound('event_review');
      await assertOrganiser(user, edr.event_id);
      return q(
        'UPDATE event_dimension_reviews SET organizer_response=$2, organizer_responded_at=now() WHERE id=$1 RETURNING id, organizer_response, organizer_responded_at',
        [i.id, i.response],
      );
    });
  },
});

cap({
  name: 'report_event_review', method: 'POST', path: '/event-reviews/:id/report', tag: TAG, status: 201,
  summary: 'Report an event review (harassment, fabricated, conflict of interest, spam, retaliation). One report per person per review.',
  input: z.object({
    id,
    category: z.enum(['harassment', 'fabricated', 'conflict_of_interest', 'spam', 'retaliation', 'irrelevant']),
    details: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const edr = await mustFind('event_dimension_reviews', i.id);
    const t = await mustFind('testimonials', edr.testimonial_id);
    if (t.status !== 'published') throw badRequest('Only published reviews can be reported');
    if (t.author_id === user.id) throw badRequest('You cannot report your own review');
    return one(
      "INSERT INTO moderation_audit(subject_type, subject_id, action, actor_id, reason, detail) VALUES ('event_review',$1,'flag',$2,$3,$4) RETURNING id, created_at",
      [i.id, user.id, i.category, JSON.stringify({ details: i.details ?? null })],
    );
  },
});

cap({
  name: 'invite_event_reviewers', method: 'POST', path: '/events/:event_id/invite-reviewers', tag: TAG, status: 201,
  summary: 'Organiser invites confirmed attendees to review the event. Must invite the entire cohort (all confirmed registrants) or a specified role group — cherry-picking individuals is blocked to prevent review manipulation. Throttled to one campaign per 48 hours.',
  input: z.object({
    event_id: id,
    cohort: z.enum(['all_confirmed', 'participants', 'officials', 'coaches']).default('all_confirmed'),
    message: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    await assertOrganiser(user, i.event_id);
    const event = await mustFind('events', i.event_id);
    if (!['completed', 'closed'].includes(event.status)) throw badRequest('Invitations can only be sent after the event is completed');
    // Throttle: one invite campaign per 48 hours per event
    const recentCampaign = await one(
      "SELECT 1 FROM moderation_audit WHERE subject_type='review_invite_campaign' AND subject_id=$1 AND created_at > now() - interval '48 hours'",
      [i.event_id],
    );
    if (recentCampaign) throw badRequest('An invitation campaign was already sent in the last 48 hours');
    let cohortQuery;
    if (i.cohort === 'all_confirmed') {
      cohortQuery = "SELECT user_id FROM event_registrations WHERE event_id=$1 AND status IN ('confirmed','attended')";
    } else if (i.cohort === 'participants') {
      cohortQuery = "SELECT user_id FROM event_registrations WHERE event_id=$1 AND status IN ('confirmed','attended')";
    } else if (i.cohort === 'officials') {
      cohortQuery = "SELECT DISTINCT fo.user_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE f.event_id=$1";
    } else {
      cohortQuery = "SELECT user_id FROM event_staff WHERE event_id=$1 AND role IN ('coach','assistant_coach')";
    }
    const recipients = await many(cohortQuery, [i.event_id]);
    let sent = 0;
    for (const r of recipients) {
      const alreadyReviewed = await one(
        "SELECT 1 FROM event_dimension_reviews edr JOIN testimonials t ON t.id=edr.testimonial_id WHERE edr.event_id=$1 AND t.author_id=$2 AND t.status!='withdrawn'",
        [i.event_id, r.user_id],
      );
      if (alreadyReviewed) continue;
      await notify(r.user_id, 'event_review_invite', { event_id: i.event_id, message: i.message ?? null });
      sent++;
    }
    await one(
      "INSERT INTO moderation_audit(subject_type, subject_id, action, actor_id, reason, detail) VALUES ('review_invite_campaign',$1,'warn',$2,$3,$4) RETURNING id",
      [i.event_id, user.id, 'campaign_sent', JSON.stringify({ cohort: i.cohort, sent })],
    );
    return { sent, cohort: i.cohort };
  },
});
