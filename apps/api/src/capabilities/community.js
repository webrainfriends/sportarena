import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { mustFind } from '../helpers.js';
import { canManage } from '../booking/engine.js';
import { notifyTeamOfReview } from './venue-media.js';

const SUBJECTS = { user: 'users', team: 'teams', event: 'events', venue: 'venues', sponsor: 'sponsors' };

cap({
  name: 'write_testimonial', method: 'POST', path: '/testimonials', tag: 'Community', status: 201,
  summary: 'Leave (or update) a rating + testimonial for a person, team, event, venue or sponsor. One per author per subject.',
  input: z.object({ subject_type: z.enum(['user', 'team', 'event', 'venue', 'sponsor']), subject_id: id, rating: z.number().int().min(1).max(5), body: z.string().min(3).max(1000) }),
  async handler({ user }, i) {
    if (i.subject_type === 'user' && i.subject_id === user.id) throw badRequest('You cannot review yourself');
    await mustFind(SUBJECTS[i.subject_type], i.subject_id, 'id');
    if (i.subject_type === 'venue' && (await canManage(user, i.subject_id))) throw badRequest('You cannot review a venue you run');
    const fresh = i.subject_type === 'venue' && !(await one("SELECT 1 FROM testimonials WHERE author_id=$1 AND subject_type='venue' AND subject_id=$2", [user.id, i.subject_id]));
    const saved = await one('INSERT INTO testimonials(author_id, subject_type, subject_id, rating, body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (author_id, subject_type, subject_id) DO UPDATE SET rating=EXCLUDED.rating, body=EXCLUDED.body, created_at=now() RETURNING *', [user.id, i.subject_type, i.subject_id, i.rating, i.body]);
    if (fresh) await notifyTeamOfReview(i.subject_id, user, i.rating);
    return saved;
  },
});

cap({
  name: 'list_testimonials', method: 'GET', path: '/testimonials', tag: 'Community', auth: 'public', summary: 'Testimonials and rating summary for a subject.',
  input: z.object({ subject_type: z.enum(['user', 'team', 'event', 'venue', 'sponsor']), subject_id: id, ...page }),
  async handler(_, i) {
    const [summary, items] = await Promise.all([
      one('SELECT round(avg(rating),2) AS avg, count(*)::int AS n FROM testimonials WHERE subject_type=$1 AND subject_id=$2', [i.subject_type, i.subject_id]),
      many('SELECT t.id, t.rating, t.body, t.created_at, u.id AS author_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, u.avatar_url FROM testimonials t JOIN users u ON u.id=t.author_id WHERE t.subject_type=$1 AND t.subject_id=$2 ORDER BY t.created_at DESC LIMIT $3 OFFSET $4', [i.subject_type, i.subject_id, i.limit, i.offset]),
    ]);
    return { ...summary, items };
  },
});
