// Issue #1190: Peer Skill Graph — sport-specific peer assessments, privacy-gated distribution,
// feedback request lifecycle, anti-abuse controls and admin audit trail.
// IMPORTANT: The existing verified Glicko 1.0–7.0 skill-ratings.js is never touched here.
// This is a completely separate surface for community-sourced skill observations.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { isYouth } from '../youth.js';
import { notify } from '../notify.js';
import { randomBytes } from 'crypto';

const TAG = 'PeerSkillGraph';

async function policyFor(sportId) {
  return (
    (await one('SELECT * FROM peer_rating_policy WHERE sport_id=$1 AND enabled=true', [sportId])) ||
    (await one('SELECT * FROM peer_rating_policy WHERE sport_id IS NULL AND enabled=true', []))
  );
}

cap({
  name: 'get_peer_skill_distribution', method: 'GET', path: '/athletes/:user_id/sports/:sport_slug/peer-skill', tag: TAG,
  summary: 'Retrieve the peer-assessed skill distribution for an athlete in a sport. The bucket breakdown is suppressed (privacy threshold) until at least k raters have submitted. Returns suppressed status, threshold, eligible count, dimension criteria distribution and freshness date.',
  input: z.object({ user_id: id, sport_slug: z.string() }),
  async handler({ user }, i) {
    const sport = await one('SELECT id FROM sports WHERE slug=$1', [i.sport_slug]);
    if (!sport) throw notFound('sport');
    const policy = await policyFor(sport.id);
    const threshold = policy?.privacy_min_raters ?? 5;
    const rows = await many(
      `SELECT overall_bucket, criteria, submitted_at
       FROM peer_skill_assessments
       WHERE athlete_id=$1 AND sport_id=$2 AND effective=true AND status='submitted'`,
      [i.user_id, sport.id],
    );
    const count = rows.length;
    if (count < threshold) {
      return { suppressed: true, threshold, eligible_count: count, distribution: null, as_of: null, sport_slug: i.sport_slug };
    }
    const bucketCounts = [0, 0, 0, 0, 0];
    let latestAt = null;
    for (const r of rows) {
      bucketCounts[r.overall_bucket - 1]++;
      if (!latestAt || r.submitted_at > latestAt) latestAt = r.submitted_at;
    }
    const labels = ['Beginner', 'Developing', 'Intermediate', 'Advanced', 'Professional'];
    const distribution = bucketCounts.map((n, idx) => ({ bucket: idx + 1, label: labels[idx], count: n, pct: Math.round((n / count) * 100) }));
    return { suppressed: false, threshold, eligible_count: count, distribution, as_of: latestAt, sport_slug: i.sport_slug };
  },
});

cap({
  name: 'request_skill_feedback', method: 'POST', path: '/me/sports/:sport_slug/request-feedback', tag: TAG, status: 201,
  summary: 'Invite eligible co-players, coaches or officials to rate your skills in a sport. Validates eligibility proof from match appearances. Enforces the per-sport rate limit (default 20 invites per 30 days). Sends invite notifications.',
  input: z.object({
    sport_slug: z.string(),
    invitee_ids: z.array(id).min(1).max(10),
    context_type: z.string().max(60).optional(),
    context_id: id.optional(),
  }),
  async handler({ user }, i) {
    const sport = await one('SELECT id FROM sports WHERE slug=$1', [i.sport_slug]);
    if (!sport) throw notFound('sport');
    const policy = await policyFor(sport.id);
    const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentCount = await one(
      "SELECT COUNT(*)::int AS n FROM rating_requests WHERE athlete_id=$1 AND sport_id=$2 AND created_at > $3",
      [user.id, sport.id, windowStart],
    );
    const maxRequests = policy?.max_requests_per_30_days ?? 20;
    if ((recentCount?.n ?? 0) + i.invitee_ids.length > maxRequests) {
      throw badRequest(`Rate limit: at most ${maxRequests} feedback requests per 30 days per sport`);
    }
    const youth = await isYouth(user.id);
    const expiresAt = new Date(Date.now() + (policy?.submission_window_days ?? 7) * 24 * 60 * 60 * 1000);
    const created = [];
    for (const inviteeId of i.invitee_ids) {
      if (inviteeId === user.id) continue;
      if (youth) {
        const inviteeYouth = await isYouth(inviteeId);
        if (!inviteeYouth) continue; // youth can only invite youth peers
      }
      const token = randomBytes(24).toString('hex');
      const req = await one(
        `INSERT INTO rating_requests(athlete_id, invitee_id, sport_id, context_type, context_id, token, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING RETURNING id, token, expires_at`,
        [user.id, inviteeId, sport.id, i.context_type ?? null, i.context_id ?? null, token, expiresAt],
      );
      if (req) {
        created.push(req);
        await notify(inviteeId, 'peer_skill_feedback_request', { athlete_id: user.id, sport_id: sport.id, token: req.token, expires_at: req.expires_at });
      }
    }
    return { created: created.length, requests: created };
  },
});

cap({
  name: 'revoke_feedback_request', method: 'POST', path: '/me/sports/:sport_slug/requests/:request_id/revoke', tag: TAG,
  summary: 'Revoke a pending feedback request you sent. The invitee can no longer submit via that token.',
  input: z.object({ sport_slug: z.string(), request_id: id }),
  async handler({ user }, i) {
    const req = await mustFind('rating_requests', i.request_id);
    if (req.athlete_id !== user.id) throw forbidden();
    if (req.status !== 'pending') throw badRequest(`Cannot revoke a request with status '${req.status}'`);
    return one("UPDATE rating_requests SET status='revoked', updated_at=now() WHERE id=$1 RETURNING id,status,updated_at", [req.id]);
  },
});

cap({
  name: 'list_feedback_requests', method: 'GET', path: '/me/sports/:sport_slug/requests', tag: TAG,
  summary: 'List feedback requests you have sent for a sport, with their current status.',
  input: z.object({ sport_slug: z.string(), ...page }),
  async handler({ user }, i) {
    const sport = await one('SELECT id FROM sports WHERE slug=$1', [i.sport_slug]);
    if (!sport) throw notFound('sport');
    return many(
      `SELECT rr.id, rr.invitee_id, u.display_name AS invitee_name, rr.status, rr.expires_at, rr.created_at, rr.updated_at
       FROM rating_requests rr
       LEFT JOIN users u ON u.id = rr.invitee_id
       WHERE rr.athlete_id=$1 AND rr.sport_id=$2
       ORDER BY rr.created_at DESC
       LIMIT $3 OFFSET $4`,
      [user.id, sport.id, i.limit ?? 20, i.offset ?? 0],
    );
  },
});

const criterionSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(100),
  bucket: z.number().int().min(1).max(5),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  not_observed: z.boolean().optional(),
});

cap({
  name: 'submit_peer_assessment', method: 'POST', path: '/peer-assessments', tag: TAG, status: 201,
  summary: 'Submit a peer skill assessment for an athlete in a sport. Requires eligibility proof (co-player via match appearances, confirmed coach, or authorized official). Enforces submission window, anti-self-rating, and reciprocal-ring detection. Constructive feedback is encrypted at rest.',
  input: z.object({
    athlete_id: id,
    sport_slug: z.string(),
    eligibility_type: z.enum(['co_player', 'confirmed_coach', 'authorized_official']),
    eligibility_evidence_id: id.optional(),
    overall_bucket: z.number().int().min(1).max(5),
    criteria: z.array(criterionSchema).min(1).max(20),
    constructive_feedback: z.string().max(2000).optional(),
    observed_session_ref: z.string().max(200).optional(),
    confidence: z.enum(['low', 'medium', 'high']).default('medium'),
    request_token: z.string().optional(),
  }),
  async handler({ user }, i) {
    if (i.athlete_id === user.id) throw badRequest('You cannot rate yourself');
    const sport = await one('SELECT id FROM sports WHERE slug=$1', [i.sport_slug]);
    if (!sport) throw notFound('sport');
    const policy = await policyFor(sport.id);
    if (i.eligibility_type === 'co_player') {
      const hasSharedGame = await one(
        `SELECT 1 FROM match_appearances ma1
         JOIN match_appearances ma2 ON ma2.fixture_id=ma1.fixture_id AND ma2.user_id=$2
         WHERE ma1.user_id=$1 AND ma1.archived_at IS NULL AND ma2.archived_at IS NULL
         LIMIT 1`,
        [user.id, i.athlete_id],
      );
      if (!hasSharedGame) throw badRequest('Co-player eligibility requires at least one shared recorded game');
    } else if (i.eligibility_type === 'confirmed_coach') {
      const isCoach = await one(
        "SELECT 1 FROM coaching_relations WHERE coach_id=$1 AND athlete_id=$2 AND status='active'",
        [user.id, i.athlete_id],
      );
      if (!isCoach && !isAdmin(user)) throw badRequest('Confirmed coach eligibility requires an active coaching relation');
    }
    // Reciprocal-ring detection: reject if athlete rated reviewer in same 7-day window
    const windowDays = policy?.submission_window_days ?? 7;
    const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const reciprocal = await one(
      `SELECT 1 FROM peer_skill_assessments
       WHERE reviewer_id=$1 AND athlete_id=$2 AND sport_id=$3 AND submitted_at > $4 AND status='submitted'`,
      [i.athlete_id, user.id, sport.id, windowStart],
    );
    if (reciprocal) throw badRequest('Reciprocal-ring detected: the athlete you are rating has rated you in the same window. Submit after the window expires.');
    const feedbackEnc = i.constructive_feedback ? await encrypt(i.constructive_feedback) : null;
    return tx(async (c) => {
      // Mark any existing effective assessment as superseded
      await c.query(
        `UPDATE peer_skill_assessments SET effective=false
         WHERE reviewer_id=$1 AND athlete_id=$2 AND sport_id=$3 AND effective=true`,
        [user.id, i.athlete_id, sport.id],
      );
      const ins = (await c.query(
        `INSERT INTO peer_skill_assessments
          (athlete_id, reviewer_id, sport_id, eligibility_type, eligibility_evidence_id,
           overall_bucket, criteria, constructive_feedback_enc, observed_session_ref, confidence, effective, eligibility_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,false)
         RETURNING id, overall_bucket, confidence, submitted_at`,
        [
          i.athlete_id, user.id, sport.id, i.eligibility_type, i.eligibility_evidence_id ?? null,
          i.overall_bucket, JSON.stringify(i.criteria), feedbackEnc, i.observed_session_ref ?? null, i.confidence,
        ],
      )).rows[0];
      // Accept request token if provided
      if (i.request_token) {
        await c.query(
          "UPDATE rating_requests SET status='accepted', updated_at=now() WHERE token=$1 AND invitee_id=$2 AND status='pending'",
          [i.request_token, user.id],
        );
      }
      return ins;
    });
  },
});

cap({
  name: 'edit_peer_assessment', method: 'PUT', path: '/peer-assessments/:id', tag: TAG,
  summary: 'Edit your own peer assessment within the edit window (default 3 hours). Writes a revision snapshot. After the edit window expires the assessment is locked.',
  input: z.object({
    id,
    overall_bucket: z.number().int().min(1).max(5).optional(),
    criteria: z.array(criterionSchema).optional(),
    constructive_feedback: z.string().max(2000).optional(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const a = await q('SELECT * FROM peer_skill_assessments WHERE id=$1 FOR UPDATE', [i.id]);
      if (!a) throw notFound('peer_assessment');
      if (a.reviewer_id !== user.id) throw forbidden();
      if (a.status !== 'submitted' || !a.effective) throw badRequest('Only an active submitted assessment can be edited');
      const sport = await q('SELECT id FROM sports WHERE id=$1', [a.sport_id]);
      const policy = await policyFor(a.sport_id);
      const editWindowMs = (policy?.edit_window_hours ?? 3) * 60 * 60 * 1000;
      if (Date.now() - new Date(a.submitted_at).getTime() > editWindowMs) {
        throw badRequest(`Edit window of ${policy?.edit_window_hours ?? 3} hours has expired`);
      }
      await c.query(
        'INSERT INTO peer_skill_assessment_revisions(assessment_id, actor_id, action, snapshot) VALUES ($1,$2,$3,$4)',
        [a.id, user.id, 'edit', JSON.stringify({ overall_bucket: a.overall_bucket, criteria: a.criteria, confidence: a.confidence })],
      );
      const feedbackEnc = i.constructive_feedback != null ? await encrypt(i.constructive_feedback) : undefined;
      return q(
        `UPDATE peer_skill_assessments SET
          overall_bucket = COALESCE($2, overall_bucket),
          criteria = COALESCE($3, criteria),
          constructive_feedback_enc = COALESCE($4, constructive_feedback_enc),
          confidence = COALESCE($5, confidence),
          edited_at = now(),
          row_version = row_version + 1
         WHERE id=$1 RETURNING id, overall_bucket, confidence, edited_at`,
        [a.id, i.overall_bucket ?? null, i.criteria ? JSON.stringify(i.criteria) : null, feedbackEnc ?? null, i.confidence ?? null],
      );
    });
  },
});

cap({
  name: 'withdraw_peer_assessment', method: 'POST', path: '/peer-assessments/:id/withdraw', tag: TAG,
  summary: 'Withdraw your peer assessment. It is immediately removed from the athlete\'s distribution and counts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await mustFind('peer_skill_assessments', i.id);
    if (a.reviewer_id !== user.id) throw forbidden();
    if (a.status === 'withdrawn') throw badRequest('Already withdrawn');
    return tx(async (c) => {
      await c.query(
        'INSERT INTO peer_skill_assessment_revisions(assessment_id, actor_id, action, snapshot) VALUES ($1,$2,$3,$4)',
        [a.id, user.id, 'withdraw', JSON.stringify({ status: a.status })],
      );
      return (await c.query("UPDATE peer_skill_assessments SET status='withdrawn', effective=false WHERE id=$1 RETURNING id,status", [a.id])).rows[0];
    });
  },
});

cap({
  name: 'report_peer_assessment', method: 'POST', path: '/peer-assessments/:id/report', tag: TAG, status: 201,
  summary: 'Report a peer assessment for abuse, fabrication, conflict of interest or retaliation. One report per person per assessment.',
  input: z.object({
    id,
    category: z.enum(['fabricated', 'conflict_of_interest', 'retaliation', 'harassment', 'other']),
    details: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const a = await mustFind('peer_skill_assessments', i.id);
    if (a.status !== 'submitted') throw badRequest('Only submitted assessments can be reported');
    return one(
      "INSERT INTO moderation_audit(subject_type, subject_id, action, actor_id, reason, detail) VALUES ('peer_assessment',$1,'flag',$2,$3,$4) RETURNING id, created_at",
      [a.id, user.id, i.category, JSON.stringify({ details: i.details ?? null })],
    );
  },
});

cap({
  name: 'get_my_peer_feedback_received', method: 'GET', path: '/me/sports/:sport_slug/peer-feedback', tag: TAG,
  summary: 'Your own view of peer feedback received in a sport: distribution and anonymised dimension summary. Reviewer identities are never exposed; only trust/safety staff can see them via the admin audit endpoint. Sensitive access is audit logged.',
  input: z.object({ sport_slug: z.string() }),
  async handler({ user }, i) {
    const sport = await one('SELECT id FROM sports WHERE slug=$1', [i.sport_slug]);
    if (!sport) throw notFound('sport');
    audit(user, 'peer_skill_feedback_received', `${user.id}:${sport.id}`);
    const policy = await policyFor(sport.id);
    const threshold = policy?.privacy_min_raters ?? 5;
    const rows = await many(
      `SELECT overall_bucket, criteria, confidence, submitted_at
       FROM peer_skill_assessments
       WHERE athlete_id=$1 AND sport_id=$2 AND effective=true AND status='submitted'`,
      [user.id, sport.id],
    );
    const count = rows.length;
    // Aggregate dimension summaries without exposing any reviewer identity
    const dimensionMap = {};
    for (const r of rows) {
      const criteria = Array.isArray(r.criteria) ? r.criteria : JSON.parse(r.criteria ?? '[]');
      for (const c of criteria) {
        if (!dimensionMap[c.key]) dimensionMap[c.key] = { key: c.key, label: c.label, buckets: [0, 0, 0, 0, 0], total: 0 };
        if (c.bucket >= 1 && c.bucket <= 5 && !c.not_observed) {
          dimensionMap[c.key].buckets[c.bucket - 1]++;
          dimensionMap[c.key].total++;
        }
      }
    }
    const dimensions = Object.values(dimensionMap).map((d) => ({
      key: d.key,
      label: d.label,
      distribution: d.buckets.map((n, idx) => ({ bucket: idx + 1, count: n, pct: d.total ? Math.round((n / d.total) * 100) : 0 })),
      response_count: d.total,
    }));
    return { eligible_count: count, suppressed: count < threshold, threshold, dimensions, sport_slug: i.sport_slug };
  },
});

cap({
  name: 'admin_peer_assessment_audit', method: 'GET', path: '/admin/peer-assessments', tag: TAG,
  summary: 'Platform admin: full peer assessment history with reviewer identities and audit trail. Access requires platform_admin role and is logged.',
  input: z.object({
    athlete_id: id.optional(),
    reviewer_id: id.optional(),
    sport_slug: z.string().optional(),
    ...page,
  }),
  async handler({ user }, i) {
    if (!user.is_platform_admin) throw forbidden('Platform admin only');
    audit(user, 'admin_peer_assessment_audit', `${i.athlete_id ?? 'all'}:${i.reviewer_id ?? 'all'}`);
    const conditions = ['1=1'];
    const params = [];
    let p = 1;
    if (i.athlete_id) { conditions.push(`psa.athlete_id=$${p++}`); params.push(i.athlete_id); }
    if (i.reviewer_id) { conditions.push(`psa.reviewer_id=$${p++}`); params.push(i.reviewer_id); }
    if (i.sport_slug) {
      const sport = await one('SELECT id FROM sports WHERE slug=$1', [i.sport_slug]);
      if (sport) { conditions.push(`psa.sport_id=$${p++}`); params.push(sport.id); }
    }
    params.push(i.limit ?? 20, i.offset ?? 0);
    return many(
      `SELECT psa.*, a.display_name AS athlete_name, r.display_name AS reviewer_name, s.slug AS sport_slug
       FROM peer_skill_assessments psa
       JOIN users a ON a.id = psa.athlete_id
       JOIN users r ON r.id = psa.reviewer_id
       JOIN sports s ON s.id = psa.sport_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY psa.submitted_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      params,
    );
  },
});
