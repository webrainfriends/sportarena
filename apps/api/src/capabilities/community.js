import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { aggregate, manages, published } from '../feedback.js';
import { notify } from '../notify.js';
import { canManage } from '../booking/engine.js';
import { notifyTeamOfReview } from './venue-media.js';

const SUBJECTS = { user: 'users', team: 'teams', event: 'events', venue: 'venues', sponsor: 'sponsors', product: 'shop_products', institution: 'organisations', programme: 'programmes', study_institution: 'study_institutions', study_programme: 'study_programmes' };
const TYPES = Object.keys(SUBJECTS);

const VERIFIED_FOR = {
  product: "SELECT 1 FROM shop_orders WHERE buyer_id=$1 AND product_id=$2 AND status='delivered'",
  institution: "SELECT 1 FROM enquiries WHERE athlete_id=$1 AND organisation_id=$2 AND status IN ('admitted','enrolled')",
  programme: "SELECT 1 FROM enquiries WHERE athlete_id=$1 AND programme_id=$2 AND status IN ('admitted','enrolled')",
  venue: "SELECT 1 FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$2 AND b.user_id=$1 AND b.status='confirmed' AND b.ends_at < now()",
};

cap({
  name: 'write_testimonial', method: 'POST', path: '/testimonials', tag: 'Community', status: 201,
  summary: 'Leave (or update) a rating + testimonial for a person, team, event, venue, sponsor or a shop product you bought. One per author per subject. Editing keeps the original date and the earlier text in the history; you cannot review something you own or manage. The result says whether the review is a verified interaction (delivered order / past booking) or unverified.',
  input: z.object({ subject_type: z.enum(TYPES), subject_id: id, rating: z.number().int().min(1).max(5), body: z.string().min(3).max(1000) }),
  async handler({ user }, i) {
    if (i.subject_type === 'user' && i.subject_id === user.id) throw badRequest('You cannot review yourself');
    await mustFind(SUBJECTS[i.subject_type], i.subject_id, 'id');
    if (await manages(user, i.subject_type, i.subject_id)) throw badRequest(`You cannot review a ${i.subject_type} you own or manage`);
    if (i.subject_type === 'product' && !(await one("SELECT 1 FROM shop_orders WHERE buyer_id=$1 AND product_id=$2 AND status IN ('placed','shipped','delivered')", [user.id, i.subject_id]))) throw badRequest('Only people who bought this product can review it');
    if (i.subject_type === 'venue' && (await canManage(user, i.subject_id))) throw badRequest('You cannot review a venue you run');
    const verification = VERIFIED_FOR[i.subject_type] && (await one(VERIFIED_FOR[i.subject_type], [user.id, i.subject_id])) ? 'verified_interaction' : 'unverified';
    const { saved, fresh } = await tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      const key = [user.id, i.subject_type, i.subject_id];
      let prev = await q('SELECT * FROM testimonials WHERE author_id=$1 AND subject_type=$2 AND subject_id=$3 FOR UPDATE', key);
      if (!prev) {
        const ins = await q('INSERT INTO testimonials(author_id, subject_type, subject_id, rating, body, verification) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (author_id, subject_type, subject_id) DO NOTHING RETURNING *', [...key, i.rating, i.body, verification]);
        if (ins) return { saved: ins, fresh: true };
        prev = await q('SELECT * FROM testimonials WHERE author_id=$1 AND subject_type=$2 AND subject_id=$3 FOR UPDATE', key); // lost a concurrent insert race: update that one
      }
      if (prev.status === 'hidden') throw badRequest('This review was hidden by moderation and cannot be edited; use the appeal route');
      await c.query("INSERT INTO testimonial_revisions(testimonial_id, action, actor_id, rating, body, status) VALUES ($1,'edit',$2,$3,$4,$5)", [prev.id, user.id, prev.rating, prev.body, prev.status]);
      const upd = await q("UPDATE testimonials SET rating=$2, body=$3, status='published', verification=$4, updated_at=now() WHERE id=$1 RETURNING *", [prev.id, i.rating, i.body, verification]);
      return { saved: upd, fresh: false };
    });
    if (fresh && i.subject_type === 'venue') await notifyTeamOfReview(i.subject_id, user, i.rating);
    return saved;
  },
});

cap({
  name: 'withdraw_testimonial', method: 'POST', path: '/testimonials/:id/withdraw', tag: 'Community',
  summary: 'Withdraw your own review: its text and rating leave every public listing and average at once. The earlier text stays in a protected history; writing again republishes it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const t = await mustFind('testimonials', i.id);
    if (t.author_id !== user.id) throw forbidden('Only the author can withdraw a review');
    if (t.status === 'hidden') throw badRequest('This review was hidden by moderation');
    return tx(async (c) => {
      await c.query("INSERT INTO testimonial_revisions(testimonial_id, action, actor_id, rating, body, status) VALUES ($1,'withdraw',$2,$3,$4,$5)", [t.id, user.id, t.rating, t.body, t.status]);
      return (await c.query("UPDATE testimonials SET status='withdrawn', updated_at=now() WHERE id=$1 RETURNING id, status, updated_at", [t.id])).rows[0];
    });
  },
});

const REPORT_CATEGORIES = ['harassment', 'privacy', 'impersonation', 'spam', 'fabricated_interaction', 'conflict_of_interest', 'retaliation', 'irrelevant'];
cap({
  name: 'report_testimonial', method: 'POST', path: '/testimonials/:id/report', tag: 'Community', status: 201,
  summary: 'Report a published review (harassment, privacy, impersonation, spam, fabricated interaction, conflict of interest, retaliation, irrelevant). Reporting does not hide the review; staff decide. One report per person per review.',
  input: z.object({ id, category: z.enum(REPORT_CATEGORIES), details: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    const t = await mustFind('testimonials', i.id);
    if (t.status !== 'published' || t.visibility !== 'public') throw notFound('testimonial');
    if (t.author_id === user.id) throw badRequest('You cannot report your own review; withdraw it instead');
    return one('INSERT INTO testimonial_reports(testimonial_id, reporter_id, category, details) VALUES ($1,$2,$3,$4) ON CONFLICT (testimonial_id, reporter_id) DO UPDATE SET category=EXCLUDED.category, details=EXCLUDED.details WHERE testimonial_reports.status=\'open\' RETURNING id, category, status, created_at', [t.id, user.id, i.category, i.details ?? null]);
  },
});

cap({
  name: 'moderate_testimonial', method: 'POST', path: '/testimonials/:id/moderate', tag: 'Community',
  summary: 'Staff only. Hide a review for a documented policy violation (with a reason), or restore it. The rating and text are never edited, every action is kept in the history, and the review stops or resumes counting in every average. Open reports on it are closed as upheld (hide) or dismissed (restore).',
  input: z.object({ id, action: z.enum(['hide', 'restore']), reason: z.string().min(5).max(500) }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden('Only staff can moderate reviews');
    const t = await mustFind('testimonials', i.id);
    return tx(async (c) => {
      const hide = i.action === 'hide';
      await c.query('INSERT INTO testimonial_revisions(testimonial_id, action, actor_id, rating, body, status, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [t.id, hide ? 'hide' : 'unhide', user.id, t.rating, t.body, t.status, i.reason]);
      const row = (await c.query("UPDATE testimonials SET status=$2, moderation_reason=$3, moderated_by=$4, moderated_at=now() WHERE id=$1 RETURNING id, status, moderation_reason, moderated_at", [t.id, hide ? 'hidden' : 'published', i.reason, user.id])).rows[0];
      await c.query("UPDATE testimonial_reports SET status=$2, decided_by=$3, decided_at=now() WHERE testimonial_id=$1 AND status='open'", [t.id, hide ? 'upheld' : 'dismissed', user.id]);
      await notify(c, t.author_id, { kind: 'review_moderated', title: hide ? 'Your review was hidden' : 'Your review was restored', body: i.reason.slice(0, 200), data: { review_id: t.id } });
      return row;
    });
  },
});

cap({
  name: 'list_testimonials', method: 'GET', path: '/testimonials', tag: 'Community', auth: 'public', summary: 'Testimonials and rating summary for a subject.',
  input: z.object({ subject_type: z.enum(TYPES), subject_id: id, ...page }),
  async handler(_, i) {
    const [summary, items] = await Promise.all([
      aggregate(i.subject_type, i.subject_id),
      many(`SELECT t.id, t.rating, t.body, t.created_at, t.updated_at, t.verification, u.id AS author_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, u.avatar_url FROM testimonials t JOIN users u ON u.id=t.author_id WHERE t.subject_type=$1 AND t.subject_id=$2 AND ${published()} ORDER BY t.created_at DESC, t.id LIMIT $3 OFFSET $4`, [i.subject_type, i.subject_id, i.limit, i.offset]),
    ]);
    return { ...summary, items };
  },
});
