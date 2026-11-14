// Issue #1190: Athlete Performance Posts — publish, share, challenge and appeal flow.
// Performance posts reference canonical performances rows; the existing verified Glicko ratings
// in skill-ratings.js are never touched here. Posts are audience-scoped and youth-safe.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { isYouth } from '../youth.js';
import { notify } from '../notify.js';

const TAG = 'PerformancePublishing';

const PROVENANCE = ['officially_verified', 'organiser_attested', 'self_reported', 'imported'];
const AUDIENCE = ['private', 'followers', 'club_team', 'coach_recruiter', 'public'];
const metricSchema = z.object({
  metric: z.string().min(1).max(80),
  value: z.union([z.number(), z.string()]),
  unit: z.string().max(40).optional(),
  direction: z.enum(['higher_better', 'lower_better', 'neutral']).optional(),
  period: z.string().max(80).optional(),
  role: z.string().max(80).optional(),
  result: z.string().max(80).optional(),
  rank: z.number().int().optional(),
  notes: z.string().max(400).optional(),
});

cap({
  name: 'publish_performance_post', method: 'POST', path: '/me/performance-posts', tag: TAG, status: 201,
  summary: 'Publish a performance post for a completed game, event or independent session. Idempotent via idempotency_key. Youth accounts are forced to private audience. Provenance is recorded; self_reported posts are labelled accordingly on profiles.',
  input: z.object({
    sport_id: id,
    performance_id: id.optional(),
    event_id: id.optional(),
    event_external_link_id: id.optional(),
    external_event_ref: z.object({
      title: z.string().min(1).max(200),
      sport: z.string().max(80).optional(),
      event_date: z.string().optional(),
      organizer: z.string().max(200).optional(),
      url: z.string().url().optional(),
      format: z.string().max(80).optional(),
      division: z.string().max(80).optional(),
    }).optional(),
    provenance: z.enum(PROVENANCE).default('self_reported'),
    metrics: z.array(metricSchema).min(1).max(50),
    audience: z.enum(AUDIENCE).default('private'),
    media_consent: z.boolean().default(false),
    source_rights_confirmed: z.boolean().default(false),
    idempotency_key: z.string().max(128).optional(),
    status: z.enum(['draft', 'published']).default('published'),
  }),
  async handler({ user }, i) {
    if (i.idempotency_key) {
      const existing = await one('SELECT * FROM performance_publications WHERE idempotency_key=$1 AND user_id=$2', [i.idempotency_key, user.id]);
      if (existing) return existing;
    }
    const youth = await isYouth(user.id);
    const audience = youth ? 'private' : i.audience;
    const pub = await one(
      `INSERT INTO performance_publications
        (user_id, sport_id, performance_id, event_id, event_external_link_id, external_event_ref,
         provenance, metrics, audience, status, media_consent, source_rights_confirmed,
         idempotency_key, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        user.id, i.sport_id, i.performance_id ?? null, i.event_id ?? null,
        i.event_external_link_id ?? null, i.external_event_ref ? JSON.stringify(i.external_event_ref) : null,
        i.provenance, JSON.stringify(i.metrics), audience, i.status,
        i.media_consent, i.source_rights_confirmed, i.idempotency_key ?? null,
        i.status === 'published' ? new Date() : null,
      ],
    );
    return pub;
  },
});

cap({
  name: 'list_performance_posts', method: 'GET', path: '/me/performance-posts', tag: TAG,
  summary: 'List your own performance posts (all statuses, all audiences), paginated newest first.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    return many(
      `SELECT pp.*, s.name AS sport_name, s.slug AS sport_slug
       FROM performance_publications pp
       JOIN sports s ON s.id = pp.sport_id
       WHERE pp.user_id = $1
       ORDER BY pp.created_at DESC
       LIMIT $2 OFFSET $3`,
      [user.id, i.limit ?? 20, i.offset ?? 0],
    );
  },
});

cap({
  name: 'get_performance_post', method: 'GET', path: '/performance-posts/:id', tag: TAG,
  summary: 'Get a single performance post. Non-owners see only published posts with public or followers audience. Sensitive reads are audit logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await mustFind('performance_publications', i.id);
    if (p.user_id !== user.id) {
      if (p.status !== 'published' || !['public', 'followers'].includes(p.audience)) throw notFound('performance_post');
      if (p.moderation_status === 'hidden') throw notFound('performance_post');
      audit(user, 'performance_publication', i.id);
    }
    return p;
  },
});

cap({
  name: 'update_performance_post', method: 'PUT', path: '/performance-posts/:id', tag: TAG,
  summary: 'Edit a draft performance post. Only draft posts may be edited; use withdraw + re-publish for published posts. Writes a revision snapshot.',
  input: z.object({
    id,
    metrics: z.array(metricSchema).min(1).max(50).optional(),
    audience: z.enum(AUDIENCE).optional(),
    provenance: z.enum(PROVENANCE).optional(),
    external_event_ref: z.object({ title: z.string().min(1).max(200) }).passthrough().optional(),
    media_consent: z.boolean().optional(),
    source_rights_confirmed: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const p = await q('SELECT * FROM performance_publications WHERE id=$1 FOR UPDATE', [i.id]);
      if (!p) throw notFound('performance_post');
      if (p.user_id !== user.id) throw forbidden();
      if (p.status !== 'draft') throw badRequest('Only draft posts may be edited. Withdraw and re-publish to change a published post.');
      await c.query(
        'INSERT INTO performance_publication_revisions(publication_id, actor_id, action, snapshot) VALUES ($1,$2,$3,$4)',
        [p.id, user.id, 'edit', JSON.stringify({ metrics: p.metrics, audience: p.audience, provenance: p.provenance })],
      );
      const updated = await q(
        `UPDATE performance_publications SET
          metrics = COALESCE($2, metrics),
          audience = COALESCE($3, audience),
          provenance = COALESCE($4, provenance),
          external_event_ref = COALESCE($5, external_event_ref),
          media_consent = COALESCE($6, media_consent),
          source_rights_confirmed = COALESCE($7, source_rights_confirmed),
          row_version = row_version + 1,
          updated_at = now()
         WHERE id=$1 RETURNING *`,
        [
          p.id,
          i.metrics ? JSON.stringify(i.metrics) : null,
          i.audience ?? null,
          i.provenance ?? null,
          i.external_event_ref ? JSON.stringify(i.external_event_ref) : null,
          i.media_consent ?? null,
          i.source_rights_confirmed ?? null,
        ],
      );
      return updated;
    });
  },
});

cap({
  name: 'withdraw_performance_post', method: 'POST', path: '/performance-posts/:id/withdraw', tag: TAG,
  summary: 'Withdraw a published performance post. The post leaves public listings immediately. The record and revision history are retained.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const p = await q('SELECT * FROM performance_publications WHERE id=$1 FOR UPDATE', [i.id]);
      if (!p) throw notFound('performance_post');
      if (p.user_id !== user.id && !isAdmin(user)) throw forbidden();
      if (p.status === 'withdrawn') throw badRequest('Already withdrawn');
      await c.query(
        'INSERT INTO performance_publication_revisions(publication_id, actor_id, action, snapshot, reason) VALUES ($1,$2,$3,$4,$5)',
        [p.id, user.id, 'withdraw', JSON.stringify({ status: p.status }), i.reason ?? null],
      );
      return q("UPDATE performance_publications SET status='withdrawn', archived_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id,status,archived_at", [p.id]);
    });
  },
});

cap({
  name: 'challenge_performance_post', method: 'POST', path: '/performance-posts/:id/challenge', tag: TAG, status: 201,
  summary: 'Organiser or coach disputes a performance post (e.g. incorrect result, misleading metrics). Sets moderation_status to flagged and logs the action. The athlete is notified.',
  input: z.object({ id, reason: z.string().min(10).max(1000), category: z.enum(['incorrect_result', 'misleading_metrics', 'rights_violation', 'other']) }),
  async handler({ user }, i) {
    const p = await mustFind('performance_publications', i.id);
    if (p.status !== 'published') throw badRequest('Only published posts can be challenged');
    await tx(async (c) => {
      await c.query("UPDATE performance_publications SET moderation_status='flagged', updated_at=now() WHERE id=$1", [p.id]);
      await c.query(
        "INSERT INTO moderation_audit(subject_type, subject_id, action, actor_id, reason, detail) VALUES ('performance_publication',$1,'flag',$2,$3,$4)",
        [p.id, user.id, i.reason, JSON.stringify({ category: i.category })],
      );
    });
    await notify(p.user_id, 'performance_post_challenged', { publication_id: p.id, reason: i.reason });
    return { publication_id: p.id, moderation_status: 'flagged' };
  },
});

cap({
  name: 'appeal_performance_challenge', method: 'POST', path: '/performance-posts/:id/appeal', tag: TAG, status: 201,
  summary: 'Athlete appeals a moderation flag on their performance post, providing evidence or context.',
  input: z.object({ id, statement: z.string().min(10).max(2000), evidence_url: z.string().url().optional() }),
  async handler({ user }, i) {
    const p = await mustFind('performance_publications', i.id);
    if (p.user_id !== user.id) throw forbidden();
    if (p.moderation_status !== 'flagged') throw badRequest('No active flag to appeal');
    await one(
      "INSERT INTO moderation_audit(subject_type, subject_id, action, actor_id, reason, detail) VALUES ('performance_publication',$1,'appeal_accepted',$2,$3,$4) RETURNING id",
      [p.id, user.id, i.statement, JSON.stringify({ evidence_url: i.evidence_url ?? null })],
    );
    return { publication_id: p.id, appeal_status: 'submitted' };
  },
});

cap({
  name: 'list_sport_performance_posts', method: 'GET', path: '/athletes/:user_id/sports/:sport_slug/posts', tag: TAG,
  summary: 'Public listing of published performance posts for an athlete in a given sport. Respects audience scope: authenticated followers see follower-scoped posts; unauthenticated or non-followers see only public posts.',
  input: z.object({ user_id: id, sport_slug: z.string(), ...page }),
  async handler({ user }, i) {
    const sport = await one('SELECT id FROM sports WHERE slug=$1', [i.sport_slug]);
    if (!sport) throw notFound('sport');
    const isFollowing = user
      ? await one("SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=$2 AND status='active'", [user.id, i.user_id])
      : null;
    const audienceFilter = user && isFollowing ? "audience IN ('public','followers')" : "audience = 'public'";
    return many(
      `SELECT pp.id, pp.provenance, pp.metrics, pp.audience, pp.published_at, pp.sport_id, s.name AS sport_name
       FROM performance_publications pp
       JOIN sports s ON s.id = pp.sport_id
       WHERE pp.user_id=$1 AND pp.sport_id=$2 AND pp.status='published'
         AND pp.moderation_status IN ('approved','pending')
         AND ${audienceFilter}
       ORDER BY pp.published_at DESC
       LIMIT $3 OFFSET $4`,
      [i.user_id, sport.id, i.limit ?? 20, i.offset ?? 0],
    );
  },
});
