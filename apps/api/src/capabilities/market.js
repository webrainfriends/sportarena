import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { isAdmin, mustFind, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { marketMediaUrl } from '../market-media.js';

const kinds = ['wanted', 'match', 'schedule', 'sale', 'campaign', 'announcement'];
const ACTIVE_AD = "(p.sponsor_status='approved' AND now() BETWEEN p.promo_starts_at AND p.promo_ends_at)";

const COLS = `p.id, p.kind, p.title, p.body, p.city, p.starts_at, p.price_cents, p.positions, p.cta_label, p.link_url, p.visibility, p.status, p.created_at,
  p.sponsor_status, p.promo_starts_at, p.promo_ends_at, ${ACTIVE_AD} AS sponsored,
  s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
  u.id AS author_id, u.handle AS author_handle, u.display_name AS author_name, u.avatar_emoji AS author_emoji, u.avatar_color AS author_color, u.roles AS author_roles,
  (SELECT count(*)::int FROM market_reactions r WHERE r.post_id=p.id AND r.active) AS reactions,
  (SELECT count(*)::int FROM market_comments c WHERE c.post_id=p.id AND c.archived_at IS NULL) AS comments,
  (SELECT count(*)::int FROM market_leads l WHERE l.post_id=p.id) AS applicants,
  coalesce((SELECT json_agg(json_build_object('id', m.id, 'kind', m.kind, 'content_type', m.content_type) ORDER BY m.position) FROM market_media m WHERE m.post_id=p.id AND m.removed_at IS NULL), '[]'::json) AS media,
  (p.author_id = $1) AS is_mine,
  EXISTS (SELECT 1 FROM market_reactions r WHERE r.post_id=p.id AND r.user_id=$1 AND r.active) AS my_reaction,
  (SELECT l.status FROM market_leads l WHERE l.post_id=p.id AND l.user_id=$1) AS my_application`;
const FROM = 'FROM market_posts p JOIN users u ON u.id=p.author_id LEFT JOIN sports s ON s.id=p.sport_id';
// What a viewer may see: archived never; unreviewed/rejected ads only to their author (and admins); members-only posts need a login.
const VISIBLE = `p.archived_at IS NULL AND (
  p.author_id = $1 OR $2::boolean
  OR (p.sponsor_status IN ('none','approved') AND (p.visibility='public' OR $1::uuid IS NOT NULL)))`;

/** Shape a row for the viewer. Visitors who are not signed in see who posted, but not a profile link or handle. */
function shape(row, user) {
  const { author_id, author_handle, author_roles, author_name, author_emoji, author_color, media, ...rest } = row;
  const author = user
    ? { id: author_id, handle: author_handle, display_name: author_name, avatar_emoji: author_emoji, avatar_color: author_color, roles: author_roles }
    : { display_name: author_name, avatar_emoji: author_emoji, avatar_color: author_color };
  return { ...rest, author, media: media.map((m) => ({ ...m, url: marketMediaUrl(m) })), login_required_for: user ? [] : ['profile', 'contact', 'apply', 'react', 'comment'] };
}
const args = (user) => [user?.id ?? null, !!isAdmin(user)];

async function loadVisible(user, postId) {
  const row = await one(`SELECT ${COLS} ${FROM} WHERE p.id=$3 AND ${VISIBLE}`, [...args(user), postId]);
  if (row) return row;
  const exists = await one('SELECT visibility FROM market_posts WHERE id=$1 AND archived_at IS NULL', [postId]);
  if (exists?.visibility === 'members' && !user) throw unauthorized('Sign in to view this post');
  throw notFound('Post');
}

cap({
  name: 'list_market_posts', method: 'GET', path: '/market/posts', tag: 'Marketplace', auth: 'public',
  summary: 'The marketplace feed: wanted athletes, matches, schedules, sales and campaigns as cards, newest first. Visitors see public posts with the author redacted; signed-in members also see members-only posts, their own reactions/applications and profile links.',
  input: z.object({ kind: z.enum(kinds).optional(), sport: z.string().optional(), city: z.string().optional(), q: z.string().max(100).optional(), sponsored: z.coerce.boolean().optional().describe('true = only live paid campaigns'), mine: z.coerce.boolean().optional(), include_closed: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    if (i.mine && !user) throw unauthorized();
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const rows = await many(
      `SELECT ${COLS} ${FROM}
        WHERE ${VISIBLE}
          AND ($3::text IS NULL OR p.kind=$3) AND ($4::uuid IS NULL OR p.sport_id=$4) AND ($5::text IS NULL OR p.city ILIKE $5)
          AND ($6::text IS NULL OR p.title ILIKE '%'||$6||'%' OR p.body ILIKE '%'||$6||'%')
          AND (NOT coalesce($7,false) OR ${ACTIVE_AD}) AND (NOT coalesce($8,false) OR p.author_id=$1)
          AND (coalesce($9,false) OR p.status='open')
        ORDER BY p.created_at DESC LIMIT $10 OFFSET $11`,
      [...args(user), i.kind ?? null, sport?.id ?? null, i.city ?? null, i.q ?? null, i.sponsored ?? null, i.mine ?? null, i.include_closed ?? null, i.limit, i.offset]);
    return rows.map((r) => shape(r, user));
  },
});

cap({
  name: 'get_market_post', method: 'GET', path: '/market/posts/:id', tag: 'Marketplace', auth: 'public',
  summary: 'One marketplace post. Members-only posts answer 401 to visitors so the app can start the sign-in flow.', input: z.object({ id }),
  async handler({ user }, i) { return shape(await loadVisible(user, i.id), user); },
});

cap({
  name: 'create_market_post', method: 'POST', path: '/market/posts', tag: 'Marketplace', status: 201,
  summary: 'Publish a card: athletes wanted, a match, a schedule, an item for sale, a campaign or an announcement. Upload images/videos first (PUT /market/media) and pass their ids. Set sponsored=true to request a paid placement; an admin reviews it before it goes live.',
  input: z.object({
    kind: z.enum(kinds), title: z.string().min(3).max(120), body: z.string().max(2000).optional(), sport: z.string().optional(), city: z.string().max(80).optional(),
    starts_at: z.string().datetime({ offset: true }).optional(), price_cents: money.optional(), positions: z.number().int().min(1).max(500).optional(),
    cta_label: z.string().max(30).optional(), link_url: z.string().url().max(500).regex(/^https?:\/\//i).optional(),
    visibility: z.enum(['public', 'members']).default('public'), sponsored: z.boolean().default(false), media_ids: z.array(id).max(8).default([]),
  }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.sponsored && i.visibility !== 'public') throw badRequest('Paid campaigns must be public');
    return tx(async (c) => {
      const post = (await c.query(
        `INSERT INTO market_posts(author_id, kind, title, body, sport_id, city, starts_at, price_cents, positions, cta_label, link_url, visibility, sponsor_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, kind, title, status, sponsor_status`,
        [user.id, i.kind, i.title, i.body, sport?.id ?? null, i.city, i.starts_at, i.price_cents, i.positions, i.cta_label, i.link_url, i.visibility, i.sponsored ? 'pending' : 'none'])).rows[0];
      for (const [pos, mid] of i.media_ids.entries()) {
        const r = await c.query('UPDATE market_media SET post_id=$1, position=$2 WHERE id=$3 AND uploader_id=$4 AND post_id IS NULL AND removed_at IS NULL', [post.id, pos, mid, user.id]);
        if (!r.rowCount) throw badRequest('One of the attached files is not yours or is already used');
      }
      return post;
    });
  },
});

async function mineOrAdmin(user, postId) {
  const p = await mustFind('market_posts', postId);
  if (p.author_id !== user.id && !isAdmin(user)) throw forbidden();
  return p;
}

cap({
  name: 'close_market_post', method: 'POST', path: '/market/posts/:id/close', tag: 'Marketplace', summary: 'Mark your post as closed (filled / sold / over). It stays visible to you.', input: z.object({ id }),
  async handler({ user }, i) { await mineOrAdmin(user, i.id); await query("UPDATE market_posts SET status='closed' WHERE id=$1", [i.id]); return { ok: true }; },
});

cap({
  name: 'archive_market_post', method: 'POST', path: '/market/posts/:id/archive', tag: 'Marketplace', summary: 'Take your post down. It is hidden, never deleted.', input: z.object({ id }),
  async handler({ user }, i) { await mineOrAdmin(user, i.id); await query('UPDATE market_posts SET archived_at=now() WHERE id=$1 AND archived_at IS NULL', [i.id]); return { ok: true }; },
});

cap({
  name: 'react_market_post', method: 'POST', path: '/market/posts/:id/react', tag: 'Marketplace', summary: 'Like / unlike a post (toggle).', input: z.object({ id }),
  async handler({ user }, i) {
    await loadVisible(user, i.id);
    const r = await one(`INSERT INTO market_reactions(post_id, user_id) VALUES ($1,$2)
                         ON CONFLICT (post_id, user_id) DO UPDATE SET active = NOT market_reactions.active RETURNING active`, [i.id, user.id]);
    return { reacted: r.active, reactions: (await one('SELECT count(*)::int AS n FROM market_reactions WHERE post_id=$1 AND active', [i.id])).n };
  },
});

cap({
  name: 'list_market_comments', method: 'GET', path: '/market/posts/:id/comments', tag: 'Marketplace', summary: 'Comments on a post (members only).', input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await loadVisible(user, i.id);
    return many(`SELECT c.id, c.body, c.created_at, u.id AS author_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color FROM market_comments c JOIN users u ON u.id=c.author_id
                  WHERE c.post_id=$1 AND c.archived_at IS NULL ORDER BY c.created_at LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'add_market_comment', method: 'POST', path: '/market/posts/:id/comments', tag: 'Marketplace', status: 201, summary: 'Comment on a post.', input: z.object({ id, body: z.string().min(1).max(600) }),
  async handler({ user }, i) {
    const p = await loadVisible(user, i.id);
    return tx(async (c) => {
      const row = (await c.query('INSERT INTO market_comments(post_id, author_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at', [i.id, user.id, i.body])).rows[0];
      if (p.author_id !== user.id) await notify(c, p.author_id, { kind: 'market_comment', title: `${user.display_name} commented on your post`, body: p.title, data: { post_id: i.id } });
      return row;
    });
  },
});

cap({
  name: 'apply_market_post', method: 'POST', path: '/market/posts/:id/apply', tag: 'Marketplace', status: 201,
  summary: 'Apply / register interest in a post (e.g. an athlete answering a "wanted" card). One application per person; the poster is notified.', input: z.object({ id, message: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const p = await loadVisible(user, i.id);
    if (p.author_id === user.id) throw badRequest('This is your own post');
    if (p.status !== 'open') throw conflict('This post is closed');
    return tx(async (c) => {
      const row = (await c.query('INSERT INTO market_leads(post_id, user_id, message) VALUES ($1,$2,$3) ON CONFLICT (post_id, user_id) DO NOTHING RETURNING id, status', [i.id, user.id, i.message])).rows[0];
      if (!row) throw conflict('You have already applied');
      await notify(c, p.author_id, { kind: 'market_application', title: `${user.display_name} responded to "${p.title}"`, body: i.message ?? 'New application', data: { post_id: i.id } });
      return row;
    });
  },
});

cap({
  name: 'list_market_leads', method: 'GET', path: '/market/posts/:id/applications', tag: 'Marketplace', summary: 'Applications on your post.', input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await mineOrAdmin(user, i.id);
    return many(`SELECT l.id, l.message, l.status, l.created_at, u.id AS user_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, u.roles FROM market_leads l JOIN users u ON u.id=l.user_id
                  WHERE l.post_id=$1 ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'list_my_market_applications', method: 'GET', path: '/market/applications', tag: 'Marketplace', summary: 'Posts you applied to, with the poster\'s decision.', input: z.object({ ...page }),
  async handler({ user }, i) {
    return many(`SELECT l.id, l.status, l.message, l.created_at, p.id AS post_id, p.title, p.kind FROM market_leads l JOIN market_posts p ON p.id=l.post_id WHERE l.user_id=$1 ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'decide_market_lead', method: 'POST', path: '/market/applications/:id/decide', tag: 'Marketplace', summary: 'Accept or decline an application on your post.', input: z.object({ id, decision: z.enum(['accepted', 'declined']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l = (await c.query('SELECT l.*, p.author_id, p.title FROM market_leads l JOIN market_posts p ON p.id=l.post_id WHERE l.id=$1 FOR UPDATE OF l', [i.id])).rows[0];
      if (!l) throw notFound('Application');
      if (l.author_id !== user.id && !isAdmin(user)) throw forbidden();
      await c.query('UPDATE market_leads SET status=$2 WHERE id=$1', [i.id, i.decision]);
      await notify(c, l.user_id, { kind: 'market_decision', title: `Your response to "${l.title}" was ${i.decision}`, body: l.title, data: { post_id: l.post_id } });
      return { ok: true, status: i.decision };
    });
  },
});

cap({
  name: 'list_sponsored_requests', method: 'GET', path: '/market/sponsored/requests', tag: 'Marketplace', auth: ['admin'], summary: 'Campaigns waiting for review.', input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT ${COLS} ${FROM} WHERE p.sponsor_status='pending' AND p.archived_at IS NULL ORDER BY p.created_at LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    return rows.map((r) => shape(r, user));
  },
});

cap({
  name: 'review_sponsored_post', method: 'POST', path: '/market/posts/:id/review', tag: 'Marketplace', auth: ['admin'],
  summary: 'Approve a campaign for a date window (it then shows as Sponsored on the landing page) or reject it.',
  input: z.object({ id, decision: z.enum(['approved', 'rejected']), promo_starts_at: z.string().datetime({ offset: true }).optional(), promo_ends_at: z.string().datetime({ offset: true }).optional() }),
  async handler(_ctx, i) {
    const p = await mustFind('market_posts', i.id);
    if (p.sponsor_status === 'none') throw badRequest('This post did not request a paid placement');
    if (i.decision === 'approved') {
      const from = i.promo_starts_at ?? new Date().toISOString();
      if (!i.promo_ends_at || new Date(i.promo_ends_at) <= new Date(from)) throw badRequest('Give an end date after the start date');
      await query("UPDATE market_posts SET sponsor_status='approved', promo_starts_at=$2, promo_ends_at=$3 WHERE id=$1", [i.id, from, i.promo_ends_at]);
    } else await query("UPDATE market_posts SET sponsor_status='rejected' WHERE id=$1", [i.id]);
    await notify(null, p.author_id, { kind: 'market_campaign', title: `Your campaign was ${i.decision}`, body: p.title, data: { post_id: i.id } });
    return { ok: true, sponsor_status: i.decision };
  },
});

cap({
  name: 'get_market_highlights', method: 'GET', path: '/market/highlights', tag: 'Marketplace', auth: 'public',
  summary: 'Landing-page payload: live counters, running campaigns, upcoming matches and events. Only real data; empty lists when there is none.',
  async handler({ user }) {
    const [counts, featured, games, events] = await Promise.all([
      one(`SELECT (SELECT count(*)::int FROM users) AS people, (SELECT count(*)::int FROM teams) AS teams, (SELECT count(*)::int FROM venues) AS venues,
                  (SELECT count(*)::int FROM events WHERE status IN ('open','ongoing')) AS live_events,
                  (SELECT count(*)::int FROM market_posts WHERE kind='wanted' AND status='open' AND archived_at IS NULL AND sponsor_status IN ('none','approved')) AS open_calls,
                  (SELECT count(*)::int FROM market_posts WHERE kind='sale' AND status='open' AND archived_at IS NULL AND sponsor_status IN ('none','approved')) AS items_for_sale`),
      many(`SELECT ${COLS} ${FROM} WHERE ${VISIBLE} AND ${ACTIVE_AD} AND p.status='open' ORDER BY p.promo_starts_at DESC LIMIT 8`, args(user)),
      many("SELECT f.id, f.scheduled_at, f.status, h.name AS home_name, h.emoji AS home_emoji, a.name AS away_name, a.emoji AS away_emoji, e.name AS event_name FROM fixtures f JOIN events e ON e.id=f.event_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id WHERE f.status IN ('scheduled','live') AND f.scheduled_at > now() - interval '3 hours' ORDER BY f.scheduled_at LIMIT 10"),
      many("SELECT e.id, e.name, e.banner_emoji, e.kind, e.starts_on, s.name AS sport, s.emoji AS sport_emoji FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.status IN ('open','ongoing') ORDER BY e.starts_on NULLS LAST LIMIT 8"),
    ]);
    return { counts, featured: featured.map((r) => shape(r, user)), games, events };
  },
});
