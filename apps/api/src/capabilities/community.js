import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { aggregate, manages, published } from '../feedback.js';
import { notify } from '../notify.js';
import { canManage } from '../booking/engine.js';
import { notifyTeamOfReview } from './venue-media.js';

const SUBJECTS = {
  user: 'users', team: 'teams', event: 'events', venue: 'venues',
  sponsor: 'sponsors', product: 'shop_products', institution: 'organisations',
  programme: 'programmes', study_institution: 'study_institutions', study_programme: 'study_programmes',
};
const TYPES = Object.keys(SUBJECTS);

const VERIFIED_FOR = {
  user:        "SELECT 1 FROM marketplace_engagements WHERE buyer_id=$1 AND provider_id=$2 AND status IN ('paid','reviewed') AND agreed_minor > 0",
  product:     "SELECT 1 FROM shop_orders WHERE buyer_id=$1 AND product_id=$2 AND status='delivered'",
  institution: "SELECT 1 FROM enquiries WHERE athlete_id=$1 AND organisation_id=$2 AND status IN ('admitted','enrolled')",
  programme:   "SELECT 1 FROM enquiries WHERE athlete_id=$1 AND programme_id=$2 AND status IN ('admitted','enrolled')",
  venue:       "SELECT 1 FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$2 AND b.user_id=$1 AND b.status='confirmed' AND b.ends_at < now()",
};

cap({
  name: 'write_testimonial', method: 'POST', path: '/testimonials', tag: 'Community', status: 201,
  summary: 'Leave (or update) a rating + testimonial for a person, team, event, venue, sponsor, shop product, institution or programme. One per author per subject. Editing preserves the original date and keeps earlier text in history.',
  input: z.object({
    subject_type:    z.enum(TYPES),
    subject_id:      id,
    rating:          z.number().int().min(1).max(5),
    body:            z.string().min(3).max(1000),
    context_type:    z.string().max(60).optional(),
    context_id:      id.optional(),
    author_role:     z.string().max(60).optional(),
    nps_score:       z.number().int().min(0).max(10).optional(),
    dimensions_json: z.array(z.object({
      key:     z.string(),
      label:   z.string(),
      rating:  z.number().int().min(1).max(5),
      comment: z.string().max(500).optional(),
    })).max(10).optional(),
    visibility: z.enum(['public', 'private']).default('public'),
  }),
  async handler({ user }, i) {
    if (i.subject_type === 'user' && i.subject_id === user.id) throw badRequest('You cannot review yourself');
    await mustFind(SUBJECTS[i.subject_type], i.subject_id, 'id');
    if (await manages(user, i.subject_type, i.subject_id)) throw badRequest(`You cannot review a ${i.subject_type} you own or manage`);
    if (i.subject_type === 'product' && !(await one("SELECT 1 FROM shop_orders WHERE buyer_id=$1 AND product_id=$2 AND status IN ('placed','shipped','delivered')", [user.id, i.subject_id]))) throw badRequest('Only people who bought this product can review it');
    if (i.subject_type === 'venue' && (await canManage(user, i.subject_id))) throw badRequest('You cannot review a venue you run');
    const verification = VERIFIED_FOR[i.subject_type] && (await one(VERIFIED_FOR[i.subject_type], [user.id, i.subject_id])) ? 'verified_interaction' : 'unverified';
    const dimsJson = i.dimensions_json ? JSON.stringify(i.dimensions_json) : null;
    const { saved, fresh } = await tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const key = [user.id, i.subject_type, i.subject_id];
      let prev = await q('SELECT * FROM testimonials WHERE author_id=$1 AND subject_type=$2 AND subject_id=$3 FOR UPDATE', key);
      if (!prev) {
        const ins = await q(
          'INSERT INTO testimonials(author_id,subject_type,subject_id,rating,body,verification,context_type,context_id,author_role,nps_score,dimensions_json,visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT (author_id,subject_type,subject_id) DO NOTHING RETURNING *',
          [...key, i.rating, i.body, verification, i.context_type ?? null, i.context_id ?? null, i.author_role ?? null, i.nps_score ?? null, dimsJson, i.visibility]
        );
        if (ins) return { saved: ins, fresh: true };
        prev = await q('SELECT * FROM testimonials WHERE author_id=$1 AND subject_type=$2 AND subject_id=$3 FOR UPDATE', key);
      }
      if (prev.status === 'hidden') throw badRequest('This review was hidden by moderation and cannot be edited; use the appeal route');
      await c.query("INSERT INTO testimonial_revisions(testimonial_id,action,actor_id,rating,body,status) VALUES ($1,'edit',$2,$3,$4,$5)", [prev.id, user.id, prev.rating, prev.body, prev.status]);
      const upd = await q(
        "UPDATE testimonials SET rating=$2,body=$3,status='published',verification=$4,updated_at=now(),nps_score=$5,dimensions_json=$6::jsonb,visibility=$7 WHERE id=$1 RETURNING *",
        [prev.id, i.rating, i.body, verification, i.nps_score ?? null, dimsJson, i.visibility]
      );
      return { saved: upd, fresh: false };
    });
    if (fresh && i.subject_type === 'venue') await notifyTeamOfReview(i.subject_id, user, i.rating);
    if (i.subject_type === 'user' && verification === 'verified_interaction') {
      const done = await many("UPDATE marketplace_engagements SET status='reviewed',reviewed_at=now(),testimonial_id=$3,updated_at=now() WHERE buyer_id=$1 AND provider_id=$2 AND status='paid' RETURNING id", [user.id, i.subject_id, saved.id]);
      for (const d of done) await one("INSERT INTO marketplace_events(engagement_id,actor_id,kind,detail) VALUES ($1,$2,'reviewed',$3) RETURNING id", [d.id, user.id, { rating: i.rating }]);
    }
    return saved;
  },
});

cap({
  name: 'withdraw_testimonial', method: 'POST', path: '/testimonials/:id/withdraw', tag: 'Community',
  summary: 'Withdraw your own review. Text and rating leave every public listing immediately. Protected history is kept for audit.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const t = await mustFind('testimonials', i.id);
    if (t.author_id !== user.id) throw forbidden('Only the author can withdraw a review');
    if (t.status === 'hidden') throw badRequest('This review was hidden by moderation');
    return tx(async (c) => {
      await c.query("INSERT INTO testimonial_revisions(testimonial_id,action,actor_id,rating,body,status) VALUES ($1,'withdraw',$2,$3,$4,$5)", [t.id, user.id, t.rating, t.body, t.status]);
      return (await c.query("UPDATE testimonials SET status='withdrawn',updated_at=now() WHERE id=$1 RETURNING id,status,updated_at", [t.id])).rows[0];
    });
  },
});

const REPORT_CATEGORIES = ['harassment', 'privacy', 'impersonation', 'spam', 'fabricated_interaction', 'conflict_of_interest', 'retaliation', 'irrelevant'];
cap({
  name: 'report_testimonial', method: 'POST', path: '/testimonials/:id/report', tag: 'Community', status: 201,
  summary: 'Report a published review. Reporting does not hide the review — staff decide. One report per person per review.',
  input: z.object({ id, category: z.enum(REPORT_CATEGORIES), details: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    const t = await mustFind('testimonials', i.id);
    if (t.status !== 'published' || t.visibility !== 'public') throw notFound('testimonial');
    if (t.author_id === user.id) throw badRequest('You cannot report your own review; withdraw it instead');
    return one(
      "INSERT INTO testimonial_reports(testimonial_id,reporter_id,category,details) VALUES ($1,$2,$3,$4) ON CONFLICT (testimonial_id,reporter_id) DO UPDATE SET category=EXCLUDED.category,details=EXCLUDED.details WHERE testimonial_reports.status='open' RETURNING id,category,status,created_at",
      [t.id, user.id, i.category, i.details ?? null]
    );
  },
});

cap({
  name: 'moderate_testimonial', method: 'POST', path: '/testimonials/:id/moderate', tag: 'Community',
  summary: 'Staff only. Hide a review for a documented policy violation or restore it. The rating and text are never edited; every action is in the history.',
  input: z.object({ id, action: z.enum(['hide', 'restore']), reason: z.string().min(5).max(500) }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden('Only staff can moderate reviews');
    const t = await mustFind('testimonials', i.id);
    return tx(async (c) => {
      const hide = i.action === 'hide';
      await c.query('INSERT INTO testimonial_revisions(testimonial_id,action,actor_id,rating,body,status,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [t.id, hide ? 'hide' : 'unhide', user.id, t.rating, t.body, t.status, i.reason]);
      const row = (await c.query(
        "UPDATE testimonials SET status=$2,moderation_reason=$3,moderated_by=$4,moderated_at=now(),appeal_status=CASE WHEN $5 THEN 'none' ELSE appeal_status END WHERE id=$1 RETURNING id,status,moderation_reason,moderated_at,appeal_status",
        [t.id, hide ? 'hidden' : 'published', i.reason, user.id, !hide]
      )).rows[0];
      await c.query("UPDATE testimonial_reports SET status=$2,decided_by=$3,decided_at=now() WHERE testimonial_id=$1 AND status='open'", [t.id, hide ? 'upheld' : 'dismissed', user.id]);
      await notify(c, t.author_id, { kind: 'review_moderated', title: hide ? 'Your review was hidden' : 'Your review was restored', body: i.reason.slice(0, 200), data: { review_id: t.id } });
      return row;
    });
  },
});

cap({
  name: 'reply_to_testimonial', method: 'POST', path: '/testimonials/:id/reply', tag: 'Community',
  summary: 'Reply to a review of yourself, your team, event, venue or organisation — once. The reply is public beneath the review. Works for all subject types you own or manage.',
  input: z.object({ id, reply: z.string().min(2).max(1000) }),
  async handler({ user }, i) {
    const t = await mustFind('testimonials', i.id);
    if (t.status !== 'published') throw notFound('testimonial');
    if (t.reply_body) throw badRequest('A reply has already been posted');
    if (!(await manages(user, t.subject_type, t.subject_id))) throw forbidden('Only the subject owner or manager can reply');
    const row = await one('UPDATE testimonials SET reply_body=$2,reply_by=$3,replied_at=now() WHERE id=$1 RETURNING id,reply_body,replied_at', [t.id, i.reply.trim(), user.id]);
    await notify(null, t.author_id, { kind: 'review_reply', title: 'Your review received a reply', body: i.reply.slice(0, 160), data: { review_id: t.id } });
    return row;
  },
});

cap({
  name: 'list_testimonials', method: 'GET', path: '/testimonials', tag: 'Community', auth: 'public',
  summary: 'Published testimonials and rating summary for a subject. Includes verified count, dimension breakdown and reply.',
  input: z.object({
    subject_type: z.enum(TYPES),
    subject_id:   id,
    author_role:  z.string().optional(),
    min_rating:   z.coerce.number().min(1).max(5).optional(),
    ...page,
  }),
  async handler(_, i) {
    const roleFilter   = i.author_role ? 'AND t.author_role = $5' : '';
    const ratingFilter = i.min_rating  ? `AND t.rating >= ${i.author_role ? '$6' : '$5'}` : '';
    const params = [i.subject_type, i.subject_id, i.limit, i.offset];
    if (i.author_role) params.push(i.author_role);
    if (i.min_rating)  params.push(i.min_rating);
    const [summary, items] = await Promise.all([
      aggregate(i.subject_type, i.subject_id),
      many(
        `SELECT t.id, t.rating, t.body, t.created_at, t.updated_at, t.verification, t.role_context, t.author_role, t.nps_score, t.dimensions_json, t.reply_body, t.replied_at,
                u.id AS author_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, u.avatar_url
           FROM testimonials t
           JOIN users u ON u.id=t.author_id
          WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()} ${roleFilter} ${ratingFilter}
          ORDER BY t.created_at DESC, t.id
          LIMIT $3 OFFSET $4`,
        params
      ),
    ]);
    return { ...summary, items };
  },
});
