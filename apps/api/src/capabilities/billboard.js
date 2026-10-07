import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hasRole, isAdmin, mustFind, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { canManageTeam } from './teams.js';

const kinds = ['match_players', 'team_recruiting', 'sponsorship_wanted', 'sponsor_call'];
const POST_COLS = `b.id, b.kind, b.title, b.body, b.city, b.starts_at, b.positions_needed, b.budget_cents, b.status, b.created_at, b.team_id,
  s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, t.name AS team_name, t.emoji AS team_emoji,
  u.id AS author_id, u.handle AS author_handle, u.display_name AS author_name, u.avatar_emoji AS author_emoji, u.avatar_color AS author_color,
  (SELECT count(*)::int FROM billboard_responses r WHERE r.post_id=b.id AND r.status='accepted') AS accepted`;
const FROM = 'FROM billboard_posts b JOIN users u ON u.id=b.author_id LEFT JOIN sports s ON s.id=b.sport_id LEFT JOIN teams t ON t.id=b.team_id';

cap({
  name: 'create_billboard_post', method: 'POST', path: '/billboard', tag: 'Billboard', status: 201,
  summary: 'Post a demand on the billboard: players wanted for a match, a team recruiting, an athlete/team seeking a sponsor, or a sponsor calling for athletes (sponsors only).',
  input: z.object({
    kind: z.enum(kinds), title: z.string().min(3).max(100), body: z.string().max(1000).optional(), sport: z.string().optional(), team_id: id.optional(),
    city: z.string().max(80).optional(), starts_at: z.string().datetime({ offset: true }).optional(), positions_needed: z.number().int().min(1).max(200).default(1), budget_cents: money.optional(),
  }),
  async handler({ user }, i) {
    if (i.kind === 'sponsor_call' && !hasRole(user, 'sponsor')) throw forbidden('Only sponsors can post sponsor calls');
    if (i.team_id && !(await canManageTeam(user, await mustFind('teams', i.team_id)))) throw forbidden('You do not manage that team');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return one('INSERT INTO billboard_posts(author_id, kind, sport_id, team_id, title, body, city, starts_at, positions_needed, budget_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, kind, title, status',
      [user.id, i.kind, sport?.id ?? null, i.team_id ?? null, i.title, i.body, i.city, i.starts_at, i.positions_needed, i.budget_cents]);
  },
});

cap({
  name: 'list_billboard', method: 'GET', path: '/billboard', tag: 'Billboard', auth: 'public',
  summary: 'Browse the billboard (open posts by default). When signed in, each post says whether you already responded and whether it is yours.',
  input: z.object({ kind: z.enum(kinds).optional(), sport: z.string().optional(), q: z.string().optional(), mine: z.coerce.boolean().optional(), include_closed: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return many(
      `SELECT ${POST_COLS}, (b.author_id = $1) AS is_mine, (SELECT r.status FROM billboard_responses r WHERE r.post_id=b.id AND r.responder_id=$1) AS my_response
         ${FROM}
        WHERE ($2::text IS NULL OR b.kind=$2) AND ($3::uuid IS NULL OR b.sport_id=$3) AND ($4::text IS NULL OR b.title ILIKE '%'||$4||'%' OR b.body ILIKE '%'||$4||'%')
          AND (coalesce($5,false) = false OR b.author_id=$1) AND (coalesce($6,false) OR b.status='open')
        ORDER BY b.created_at DESC LIMIT $7 OFFSET $8`,
      [user?.id ?? null, i.kind ?? null, sport?.id ?? null, i.q ?? null, i.mine ?? null, i.include_closed ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'close_billboard_post', method: 'POST', path: '/billboard/:id/close', tag: 'Billboard', summary: 'Take your post down.', input: z.object({ id }),
  async handler({ user }, i) {
    const p = await mustFind('billboard_posts', i.id);
    if (p.author_id !== user.id && !isAdmin(user)) throw forbidden();
    await query("UPDATE billboard_posts SET status='closed' WHERE id=$1", [i.id]);
    return { ok: true };
  },
});

cap({
  name: 'respond_to_post', method: 'POST', path: '/billboard/:id/responses', tag: 'Billboard', status: 201,
  summary: 'Answer a post: offer to play, apply to join a team, or (as a sponsor) offer sponsorship. One response per person per post.',
  input: z.object({ id, message: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const p = await mustFind('billboard_posts', i.id);
    if (p.status !== 'open') throw conflict('This post is no longer open');
    if (p.author_id === user.id) throw badRequest('You cannot respond to your own post');
    if (p.kind === 'sponsorship_wanted' && !hasRole(user, 'sponsor')) throw forbidden('Only sponsors can respond to a sponsorship request');
    try {
      return await one('INSERT INTO billboard_responses(post_id, responder_id, message) VALUES ($1,$2,$3) RETURNING id, post_id, status', [i.id, user.id, i.message]);
    } catch (e) {
      if (e.code === '23505') throw conflict('You already responded to this post');
      throw e;
    }
  },
});

cap({
  name: 'list_post_responses', method: 'GET', path: '/billboard/:id/responses', tag: 'Billboard', summary: 'Responses to your post.', input: z.object({ id }),
  async handler({ user }, i) {
    const p = await mustFind('billboard_posts', i.id);
    if (p.author_id !== user.id && !isAdmin(user)) throw forbidden();
    return many(`SELECT r.id AS response_id, r.message, r.status, r.created_at, ${PUBLIC_USER} FROM billboard_responses r JOIN users u ON u.id=r.responder_id WHERE r.post_id=$1 ORDER BY r.created_at`, [i.id]);
  },
});

cap({
  name: 'decide_response', method: 'PATCH', path: '/billboard/responses/:id', tag: 'Billboard',
  summary: 'Accept or decline a response to your post. Accepting for a team post adds the person to the team roster; the post is marked filled once all positions are taken.',
  input: z.object({ id, status: z.enum(['accepted', 'declined']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM billboard_responses WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Response');
      const p = (await c.query('SELECT * FROM billboard_posts WHERE id=$1 FOR UPDATE', [r.post_id])).rows[0];
      if (p.author_id !== user.id && !isAdmin(user)) throw forbidden();
      if (r.status !== 'pending') throw conflict(`Already ${r.status}`);
      if (i.status === 'accepted') {
        if (p.status !== 'open') throw conflict('This post is no longer open');
        if (p.kind === 'team_recruiting' && p.team_id) {
          await c.query(`INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active') ON CONFLICT (team_id, user_id) DO UPDATE SET status='active'`, [p.team_id, r.responder_id]);
        }
      }
      const { rows: [out] } = await c.query('UPDATE billboard_responses SET status=$2 WHERE id=$1 RETURNING id, post_id, status', [i.id, i.status]);
      if (i.status === 'accepted') {
        const n = (await c.query("SELECT count(*)::int AS n FROM billboard_responses WHERE post_id=$1 AND status='accepted'", [p.id])).rows[0].n;
        if (n >= p.positions_needed) await c.query("UPDATE billboard_posts SET status='filled' WHERE id=$1", [p.id]);
      }
      return out;
    });
  },
});

cap({
  name: 'list_my_responses', method: 'GET', path: '/me/billboard-responses', tag: 'Billboard', summary: 'Posts you responded to, with the outcome.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT r.id, r.status AS response_status, r.message, r.created_at AS responded_at, ${POST_COLS}, (b.author_id = $1) AS is_mine
       FROM billboard_responses r JOIN billboard_posts b ON b.id=r.post_id JOIN users u ON u.id=b.author_id LEFT JOIN sports s ON s.id=b.sport_id LEFT JOIN teams t ON t.id=b.team_id
      WHERE r.responder_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});
