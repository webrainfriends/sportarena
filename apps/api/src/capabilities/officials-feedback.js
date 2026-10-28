// Structured post-match feedback about officials (#88). Fixed criteria and a comment, from a team manager or the event organiser, never one overall score.
// The official sees criteria and comments without who wrote them, only once enough people have answered to avoid pointing at one person, can reply
// in public, and can contest a response; the platform team moderates. Reads of comments are audit-logged and comments are encrypted at rest.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { canManageTeam } from './teams.js';

const TAG = 'Officials';
export const CRITERIA = [
  ['communication', 'Communication'], ['consistency', 'Consistency'], ['game_control', 'Game control'], ['positioning_fitness', 'Positioning and fitness'], ['conduct', 'Professional conduct'],
];
export const MIN_RESPONSES = 3, WINDOW_DAYS = 21;
const rating = z.number().int().min(1).max(5);
const OFFICIATING = ['referee', 'umpire', 'linesman'];

/** What the official is allowed to see of the feedback about them (also drawn into their PDF extract). Nothing below the threshold but a count. */
export async function feedbackSummary(userId, { from, to, sportId } = {}) {
  const rows = await many(
    `SELECT b.id, b.ratings, b.comment_enc, b.capacity, b.status, b.reply_enc, b.replied_at, b.created_at, f.scheduled_at, e.name AS event_name
       FROM official_feedback b JOIN fixture_officials fo ON fo.id=b.fixture_official_id JOIN fixtures f ON f.id=b.fixture_id JOIN events e ON e.id=f.event_id
      WHERE fo.user_id=$1 AND b.status <> 'hidden' AND ($2::timestamptz IS NULL OR f.scheduled_at >= $2) AND ($3::timestamptz IS NULL OR f.scheduled_at < $3) AND ($4::uuid IS NULL OR e.sport_id=$4)
      ORDER BY f.scheduled_at DESC, b.id`, [userId, from ?? null, to ?? null, sportId ?? null]);
  if (rows.length < MIN_RESPONSES) return { responses: rows.length, enough: false, minimum: MIN_RESPONSES, criteria: [], comments: [] };
  const criteria = CRITERIA.map(([key, label]) => {
    const v = rows.map((r) => r.ratings[key]).filter(Number.isInteger);
    return { key, label, responses: v.length, average: v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null };
  });
  const comments = rows.filter((r) => r.comment_enc || r.reply_enc).map((r) => ({
    id: r.id, capacity: r.capacity, status: r.status, match_on: r.scheduled_at, event_name: r.event_name,
    comment: r.comment_enc ? decrypt(r.comment_enc, 'official_feedback.comment') : null, reply: r.reply_enc ? decrypt(r.reply_enc, 'official_feedback.reply') : null, replied_at: r.replied_at,
  }));
  return { responses: rows.length, enough: true, minimum: MIN_RESPONSES, criteria, comments };
}

async function authorStanding(user, fo, c = pool) {
  const f = (await c.query('SELECT f.*, e.organizer_id, e.organisation_id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [fo.fixture_id])).rows[0];
  if (isAdmin(user)) return { f, none: true };
  if (f.organizer_id === user.id) return { f, capacity: 'event_official', team_id: null };
  for (const side of ['home_team_id', 'away_team_id']) {
    const t = f[side] && (await c.query('SELECT * FROM teams WHERE id=$1', [f[side]])).rows[0];
    if (t && (await canManageTeam(user, t))) return { f, capacity: 'team_official', team_id: t.id };
  }
  return { f, none: true };
}

cap({
  name: 'list_official_feedback_due', method: 'GET', path: '/me/officials/feedback-due', tag: TAG,
  summary: 'Officials you can give feedback on: the match officials of completed matches (last 21 days) of your team or your event that you have not rated yet.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT fo.id AS official_assignment_id, fo.role, f.id AS fixture_id, f.scheduled_at, e.name AS event_name, h.name AS home_name, a.name AS away_name, u.display_name AS official_name
       FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id AND f.status='completed' AND f.scheduled_at > now() - interval '${WINDOW_DAYS} days'
       JOIN events e ON e.id=f.event_id JOIN users u ON u.id=fo.user_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
      WHERE fo.status='accepted' AND fo.role = ANY($1) AND fo.user_id <> $2
        AND (e.organizer_id=$2 OR EXISTS (SELECT 1 FROM teams t WHERE t.id IN (f.home_team_id, f.away_team_id) AND (t.owner_id=$2 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$2 AND m.status='active' AND m.role IN ('captain','manager')))))
        AND NOT EXISTS (SELECT 1 FROM official_feedback b WHERE b.fixture_official_id=fo.id AND b.author_id=$2)
      ORDER BY f.scheduled_at DESC, fo.id LIMIT $3 OFFSET $4`, [OFFICIATING, user.id, i.limit, i.offset]),
});

cap({
  name: 'submit_official_feedback', method: 'POST', path: '/official-assignments/:id/feedback', tag: TAG, status: 201,
  summary: 'A team manager or the event organiser rates an official on fixed criteria (1 to 5) with an optional comment, within 21 days of a completed match. One response each. The official never sees who wrote it.',
  input: z.object({ id, ratings: z.object({ communication: rating, consistency: rating, game_control: rating, positioning_fitness: rating, conduct: rating }), comment: z.string().trim().max(1000).optional() }),
  async handler({ user }, i) {
    const fo = await one('SELECT * FROM fixture_officials WHERE id=$1', [i.id]);
    if (!fo || fo.status !== 'accepted' || !OFFICIATING.includes(fo.role)) throw notFound('official assignment');
    if (fo.user_id === user.id) throw forbidden('You cannot rate yourself');
    const s = await authorStanding(user, fo);
    if (s.none) throw notFound('official assignment');
    if (s.f.status !== 'completed') throw conflict('Feedback opens when the match is completed');
    if (Date.now() - new Date(s.f.scheduled_at).getTime() > WINDOW_DAYS * 864e5) throw conflict(`Feedback closes ${WINDOW_DAYS} days after the match`);
    return tx(async (c) => {
      const dup = await c.query('SELECT 1 FROM official_feedback WHERE fixture_official_id=$1 AND author_id=$2', [fo.id, user.id]);
      if (dup.rowCount) throw conflict('You already gave feedback on this official for this match');
      const r = (await c.query('INSERT INTO official_feedback(fixture_official_id, fixture_id, author_id, capacity, team_id, ratings, comment_enc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at',
        [fo.id, fo.fixture_id, user.id, s.capacity, s.team_id, JSON.stringify(i.ratings), i.comment ? encrypt(i.comment, 'official_feedback.comment') : null])).rows[0];
      await audit(c, user.id, 'official_feedback.submit', 'official_feedback', r.id);
      return { id: r.id, created_at: r.created_at };
    });
  },
});

cap({
  name: 'list_my_official_feedback', method: 'GET', path: '/me/officials/feedback', tag: TAG,
  summary: 'Feedback about me as an official: average per criterion and the comments, shown once at least three people have answered (below that, only the count). Authors are never named. You can reply to or contest a comment.',
  input: z.object({ sport_id: id.optional() }),
  async handler({ user }, i) {
    const s = await feedbackSummary(user.id, { sportId: i.sport_id });
    if (s.comments.length) await audit(null, user.id, 'official_feedback.read', 'users', user.id);
    return s;
  },
});

cap({
  name: 'reply_official_feedback', method: 'POST', path: '/official-feedback/:id/reply', tag: TAG,
  summary: 'The official adds one public reply to a response about them.',
  input: z.object({ id, reply: z.string().trim().min(2).max(500) }),
  async handler({ user }, i) {
    const b = await one('SELECT b.*, fo.user_id AS official_id FROM official_feedback b JOIN fixture_officials fo ON fo.id=b.fixture_official_id WHERE b.id=$1', [i.id]);
    if (!b || b.official_id !== user.id || b.status === 'hidden') throw notFound('feedback');
    if (b.reply_enc) throw conflict('You already replied');
    await pool.query('UPDATE official_feedback SET reply_enc=$2, replied_at=now() WHERE id=$1', [i.id, encrypt(i.reply, 'official_feedback.reply')]);
    return { id: i.id, replied: true };
  },
});

cap({
  name: 'contest_official_feedback', method: 'POST', path: '/official-feedback/:id/contest', tag: TAG,
  summary: 'The official asks the platform team to review a response (abuse, wrong match, retaliation). It stays visible, marked as contested, until decided.',
  input: z.object({ id, reason: z.string().trim().min(5).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = (await c.query('SELECT b.*, fo.user_id AS official_id FROM official_feedback b JOIN fixture_officials fo ON fo.id=b.fixture_official_id WHERE b.id=$1 FOR UPDATE OF b', [i.id])).rows[0];
      if (!b || b.official_id !== user.id || b.status === 'hidden') throw notFound('feedback');
      if (b.status === 'contested') return { id: b.id, status: 'contested' };
      await c.query("UPDATE official_feedback SET status='contested', contest_reason=$2 WHERE id=$1", [b.id, i.reason]);
      for (const a of (await c.query("SELECT id FROM users WHERE 'admin' = ANY(roles)")).rows) await notify(c, a.id, { kind: 'official_feedback_contested', title: 'Official feedback contested', body: 'An official asked for a review of a feedback response.', data: { feedback_id: b.id } });
      return { id: b.id, status: 'contested' };
    });
  },
});

cap({
  name: 'list_contested_official_feedback', method: 'GET', path: '/admin/official-feedback', tag: TAG, auth: ['admin'],
  summary: 'Contested official feedback awaiting a decision (platform team). Reading a comment is audit-logged.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT b.id, b.capacity, b.ratings, b.comment_enc, b.contest_reason, b.created_at, fo.role, ou.display_name AS official_name, e.name AS event_name
         FROM official_feedback b JOIN fixture_officials fo ON fo.id=b.fixture_official_id JOIN users ou ON ou.id=fo.user_id JOIN fixtures f ON f.id=b.fixture_id JOIN events e ON e.id=f.event_id
        WHERE b.status='contested' ORDER BY b.created_at, b.id LIMIT $1 OFFSET $2`, [i.limit, i.offset]);
    for (const r of rows) await audit(null, user.id, 'official_feedback.moderate_read', 'official_feedback', r.id);
    return rows.map(({ comment_enc, ...r }) => ({ ...r, comment: comment_enc ? decrypt(comment_enc, 'official_feedback.comment') : null }));
  },
});

cap({
  name: 'moderate_official_feedback', method: 'POST', path: '/admin/official-feedback/:id/moderation', tag: TAG, auth: ['admin'],
  summary: 'Hide a response (it no longer counts) or keep it published, with a reason. The author is never revealed to the official.',
  input: z.object({ id, decision: z.enum(['hide', 'keep']), reason: z.string().trim().min(5).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = (await c.query('SELECT * FROM official_feedback WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!b) throw notFound('feedback');
      const status = i.decision === 'hide' ? 'hidden' : 'published';
      await c.query('UPDATE official_feedback SET status=$2, moderation_reason=$3, moderated_by=$4, moderated_at=now() WHERE id=$1', [b.id, status, i.reason, user.id]);
      await audit(c, user.id, `official_feedback.${i.decision}`, 'official_feedback', b.id);
      return { id: b.id, status };
    });
  },
});
