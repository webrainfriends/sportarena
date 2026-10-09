// Venue page content: photos & videos (uploaded by the venue team) and review feedback with ratings and team replies.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { mustFind } from '../helpers.js';
import { mustManage, canManage } from '../booking/engine.js';
import { notify, notifyVenueTeam } from '../notify.js';
import { storeBuffer, publicMedia, LIMITS } from '../media.js';

const TAG = 'Venue page';

// ------------------------------------------------------------------ media
cap({
  name: 'add_venue_media', method: 'POST', path: '/venues/:id/media', tag: TAG, status: 201,
  summary: 'Upload a photo or short video to a venue page (venue team). `data` is the file base64-encoded, up to 8 MB — fine for photos and short clips. For big videos (up to 150 MB) stream the raw file with `PUT /venues/:id/media` instead (same auth). The type is detected from the bytes: JPEG, PNG, WebP, GIF, MP4, MOV, WebM. The first upload becomes the cover.',
  input: z.object({ id, data: z.string().min(16).max(11_200_000), caption: z.string().max(200).optional(), resource_id: id.optional() }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const buf = Buffer.from(i.data.replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > 8 * 2 ** 20) throw badRequest('Too large for base64 upload (8 MB). Use PUT /venues/:id/media for bigger files.');
    return publicMedia(await storeBuffer(buf, { venueId: i.id, userId: user.id, caption: i.caption, resourceId: i.resource_id }));
  },
});

/** Turn a YouTube / Vimeo link into its embeddable form; refuse every other host. */
export function embedFor(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let m;
  if (host === 'youtu.be') m = u.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') m = u.searchParams.get('v') ?? /^\/(?:embed|shorts)\/([\w-]{11})/.exec(u.pathname)?.[1];
  if (m && /^[\w-]{11}$/.test(m)) return `https://www.youtube-nocookie.com/embed/${m}`;
  if (host === 'vimeo.com' || host === 'player.vimeo.com') { const v = /(\d{6,})/.exec(u.pathname)?.[1]; if (v) return `https://player.vimeo.com/video/${v}`; }
  return null;
}

cap({
  name: 'add_venue_video_link', method: 'POST', path: '/venues/:id/media/link', tag: TAG, status: 201,
  summary: 'Add a YouTube or Vimeo video to the venue page by link (no upload needed).',
  input: z.object({ id, url: z.string().url().max(300), caption: z.string().max(200).optional() }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const embed = embedFor(i.url);
    if (!embed) throw badRequest('Only https YouTube and Vimeo links are supported');
    const n = await one('SELECT count(*)::int AS n FROM venue_media WHERE venue_id=$1 AND removed_at IS NULL', [i.id]);
    if (n.n >= LIMITS.perVenueItems) throw conflict(`A venue can have up to ${LIMITS.perVenueItems} photos and videos`);
    return publicMedia(await one(
      `INSERT INTO venue_media(venue_id, kind, link_url, caption, position, is_cover, uploaded_by)
       SELECT $1,'video_link',$2,$3, coalesce(max(position),-1)+1, false, $4 FROM venue_media WHERE venue_id=$1 AND removed_at IS NULL RETURNING *`,
      [i.id, embed, i.caption ?? null, user.id]));
  },
});

cap({
  name: 'list_venue_media', method: 'GET', path: '/venues/:id/media', tag: TAG, auth: 'public',
  summary: 'Photos and videos of a venue in display order, cover first. `url` is relative to the API host for uploads, absolute for video links.',
  input: z.object({ id, resource_id: id.optional() }),
  async handler(_, i) {
    await mustFind('venues', i.id, 'id');
    const rows = await many('SELECT * FROM venue_media WHERE venue_id=$1 AND removed_at IS NULL AND ($2::uuid IS NULL OR resource_id=$2) ORDER BY is_cover DESC, position, created_at', [i.id, i.resource_id ?? null]);
    return rows.map(publicMedia);
  },
});

async function mediaFor(user, mediaId) {
  const m = await one('SELECT * FROM venue_media WHERE id=$1 AND removed_at IS NULL', [mediaId]);
  if (!m) throw notFound('Media');
  await mustManage(user, m.venue_id);
  return m;
}

cap({
  name: 'update_venue_media', method: 'PATCH', path: '/media/:id', tag: TAG,
  summary: 'Edit a photo/video: caption, which area it shows, or make it the venue cover.',
  input: z.object({ id, caption: z.string().max(200).optional(), resource_id: id.nullable().optional(), is_cover: z.literal(true).optional() }),
  async handler({ user }, i) {
    const m = await mediaFor(user, i.id);
    if (i.resource_id) { const r = await one('SELECT venue_id FROM resources WHERE id=$1', [i.resource_id]); if (!r || r.venue_id !== m.venue_id) throw badRequest('That area belongs to another venue'); }
    return tx(async (c) => {
      if (i.is_cover) {
        if (m.kind === 'video_link') throw badRequest('A video link cannot be the cover — pick a photo');
        await c.query('UPDATE venue_media SET is_cover=false WHERE venue_id=$1 AND is_cover AND removed_at IS NULL', [m.venue_id]);
      }
      const row = (await c.query('UPDATE venue_media SET caption=coalesce($2,caption), resource_id=CASE WHEN $3 THEN $4::uuid ELSE resource_id END, is_cover=CASE WHEN $5 THEN true ELSE is_cover END WHERE id=$1 RETURNING *',
        [i.id, i.caption ?? null, i.resource_id !== undefined, i.resource_id ?? null, !!i.is_cover])).rows[0];
      return publicMedia(row);
    });
  },
});

cap({
  name: 'reorder_venue_media', method: 'POST', path: '/venues/:id/media/order', tag: TAG, summary: 'Set the display order of the venue gallery: pass media ids in the order you want.',
  input: z.object({ id, ids: z.array(id).min(1).max(LIMITS.perVenueItems) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    await tx(async (c) => { for (const [pos, mid] of i.ids.entries()) await c.query('UPDATE venue_media SET position=$3 WHERE id=$1 AND venue_id=$2 AND removed_at IS NULL', [mid, i.id, pos]); });
    return { ok: true };
  },
});

cap({
  name: 'remove_venue_media', method: 'DELETE', path: '/media/:id', tag: TAG,
  summary: 'Take a photo/video off the venue page. It is hidden, not erased (the file stays on disk). If it was the cover, the next photo becomes the cover.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await mediaFor(user, i.id);
    await tx(async (c) => {
      await c.query('UPDATE venue_media SET removed_at=now(), is_cover=false WHERE id=$1', [i.id]);
      if (m.is_cover) await c.query("UPDATE venue_media SET is_cover=true WHERE id=(SELECT id FROM venue_media WHERE venue_id=$1 AND removed_at IS NULL AND kind='photo' ORDER BY position, created_at LIMIT 1)", [m.venue_id]);
    });
    return { ok: true };
  },
});

// ------------------------------------------------------------------ reviews
const star = z.coerce.number().int().min(1).max(5);
cap({
  name: 'venue_reviews', method: 'GET', path: '/venues/:id/reviews', tag: TAG, auth: 'public',
  summary: 'Ratings and feedback for a venue: average, count, 1–5 star distribution, and reviews with a "verified" mark (the author has played there) and the venue team\'s reply. Sort by recent, highest, lowest or verified; filter by stars. Leave a review with write_testimonial (subject_type "venue").',
  input: z.object({ id, sort: z.enum(['recent', 'highest', 'lowest', 'verified']).default('recent'), stars: star.optional(), ...page }),
  async handler({ user }, i) {
    await mustFind('venues', i.id, 'id');
    const [sum, dist, items, mine] = await Promise.all([
      one("SELECT round(avg(rating),2) AS avg, count(*)::int AS count FROM testimonials WHERE subject_type='venue' AND subject_id=$1", [i.id]),
      many("SELECT rating, count(*)::int AS n FROM testimonials WHERE subject_type='venue' AND subject_id=$1 GROUP BY rating", [i.id]),
      many(
        `SELECT t.id, t.rating, t.body, t.created_at, t.reply_body, t.replied_at, u.id AS author_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, u.avatar_url, ru.display_name AS replied_by,
                EXISTS (SELECT 1 FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.user_id=t.author_id AND b.status='confirmed' AND b.ends_at < now()) AS verified
           FROM testimonials t JOIN users u ON u.id=t.author_id LEFT JOIN users ru ON ru.id=t.reply_by
          WHERE t.subject_type='venue' AND t.subject_id=$1 AND ($2::int IS NULL OR t.rating=$2)
          ORDER BY CASE WHEN $3='verified' THEN (EXISTS (SELECT 1 FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.user_id=t.author_id AND b.status='confirmed' AND b.ends_at < now())) END DESC NULLS LAST,
                   CASE WHEN $3='highest' THEN t.rating END DESC, CASE WHEN $3='lowest' THEN t.rating END ASC, t.created_at DESC
          LIMIT $4 OFFSET $5`, [i.id, i.stars ?? null, i.sort, i.limit, i.offset]),
      user ? one("SELECT id, rating, body FROM testimonials WHERE subject_type='venue' AND subject_id=$1 AND author_id=$2", [i.id, user.id]) : null,
    ]);
    const distribution = Object.fromEntries([5, 4, 3, 2, 1].map((s) => [s, dist.find((d) => d.rating === s)?.n ?? 0]));
    return {
      average: sum.avg, count: sum.count, distribution, my_review: mine,
      can_manage: user ? await canManage(user, i.id) : false,
      items: items.map(({ reply_body, replied_at, replied_by, ...r }) => ({ ...r, reply: reply_body ? { body: reply_body, at: replied_at, by: replied_by } : null })),
    };
  },
});

cap({
  name: 'reply_to_review', method: 'POST', path: '/reviews/:id/reply', tag: TAG,
  summary: 'The venue team answers a review publicly (replaces an earlier reply). The reviewer is notified.',
  input: z.object({ id, body: z.string().min(2).max(1000) }),
  async handler({ user }, i) {
    const t = await mustFind('testimonials', i.id);
    if (t.subject_type !== 'venue') throw badRequest('Only venue reviews can be answered here');
    await mustManage(user, t.subject_id);
    const row = await one('UPDATE testimonials SET reply_body=$2, reply_by=$3, replied_at=now() WHERE id=$1 RETURNING id, reply_body, replied_at', [i.id, i.body, user.id]);
    await notify(null, t.author_id, { kind: 'review_reply', title: 'The venue replied to your review', body: i.body.slice(0, 200), data: { venue_id: t.subject_id, review_id: t.id } });
    return row;
  },
});

export const notifyTeamOfReview = async (venueId, author, rating) => {
  const v = await one('SELECT * FROM venues WHERE id=$1', [venueId]);
  if (v) await notifyVenueTeam(null, v, author.id, { kind: 'new_review', title: `New ${rating}★ review`, body: `${author.display_name} reviewed ${v.name}.`, data: { venue_id: venueId } });
};
