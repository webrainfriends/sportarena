// Team chat core, shared by the capabilities (REST / OpenAPI / MCP), the live stream and the media routes.
// One conversation per team (team_messages). A message may carry a reply, reactions, a pin, a poll, a photo/file/voice note, or point at an
// event/fixture (RSVP prompt) - the RSVP itself always lives in team_attendance. Who may read or post is decided here, from the live
// membership / guardian link, on every call: removing someone from the team (or revoking a guardian link) ends their access at once.
import { many, one } from './db.js';
import { forbidden } from './errors.js';
import { mustFind, PUBLIC_USER } from './helpers.js';
import { YOUTH_SQL } from './youth.js';
import { publish, subscribe } from './live.js';
import { canManageTeam } from './capabilities/teams.js';

export const channel = (teamId) => `team-chat:${teamId}`;

/**
 * What `user` is to this team's chat. Managers see everything. Members see the team channel. A verified guardian of a young member
 * (who need not be on the team) sees only the guardians channel, which shows names but nothing about whose parent anyone is.
 */
export async function chatAccess(user, teamId) {
  const team = await mustFind('teams', teamId);
  const manager = await canManageTeam(user, team);
  const member = !!(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [teamId, user.id]));
  const guardian = !!(await one(
    `SELECT 1 FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN guardian_links l ON l.child_id=tm.user_id
      WHERE tm.team_id=$1 AND tm.status='active' AND l.guardian_id=$2 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL}`, [teamId, user.id]));
  if (!manager && !member && !guardian) throw forbidden('Only team members and the guardians of young members can use the team chat');
  const audiences = [...(manager || member ? ['team'] : []), ...(manager || guardian ? ['guardians'] : [])];
  return { team, manager, member, guardian, audiences, canPostTeam: manager || member, canPostGuardians: manager || guardian };
}

export const mustPost = (access, audience) => {
  if (audience === 'guardians' ? !access.canPostGuardians : !access.canPostTeam) throw forbidden(audience === 'guardians' ? 'Only managers and guardians can post in the guardians channel' : 'Only team members can post in the team channel');
};

const MSG = `SELECT m.id AS message_id, m.seq, m.team_id, m.kind, m.body, m.announcement, m.audience, m.created_at, m.reply_to_id, m.pinned_at, m.event_id, m.fixture_id, m.media_id,
                    (m.sender_id = $2) AS mine, ${PUBLIC_USER}
               FROM team_messages m JOIN users u ON u.id = m.sender_id`;

/**
 * Messages the viewer may see, newest first, fully shaped. `where` adds conditions on m.* using $4 onwards; $1 team, $2 viewer, $3 audiences.
 * Deleted messages never appear. Poll counts are totals only (nobody sees who voted what).
 */
export async function fetchMessages(user, access, { where = 'TRUE', params = [], limit = 50, order = 'DESC' } = {}) {
  const rows = await many(`${MSG} WHERE m.team_id=$1 AND m.deleted_at IS NULL AND m.audience = ANY($3) AND (${where}) ORDER BY m.seq ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT ${Math.min(Number(limit) || 50, 200)}`,
    [access.team.id, user.id, access.audiences, ...params]);
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.message_id);
  const replies = await many(
    `SELECT m.id, CASE WHEN m.deleted_at IS NULL THEN left(m.body, 120) END AS body, u.display_name FROM team_messages m JOIN users u ON u.id=m.sender_id WHERE m.id = ANY($1) AND m.audience = ANY($2)`,
    [rows.map((r) => r.reply_to_id).filter(Boolean), access.audiences]);
  const media = await many("SELECT id, kind, name, content_type, size_bytes, seconds FROM team_chat_media WHERE id = ANY($1) AND removed_at IS NULL", [rows.map((r) => r.media_id).filter(Boolean)]);
  const reacts = await many('SELECT message_id, emoji, count(*)::int AS count, bool_or(user_id=$2) AS mine FROM team_message_reactions WHERE message_id = ANY($1) AND removed_at IS NULL GROUP BY message_id, emoji ORDER BY min(created_at)', [ids, user.id]);
  const polls = await many(
    `SELECT p.message_id, p.question, p.multiple, p.closes_at, p.closed_at,
            (SELECT json_agg(json_build_object('option_id', o.id, 'label', o.label, 'votes', (SELECT count(*)::int FROM team_poll_votes v WHERE v.option_id=o.id AND v.removed_at IS NULL),
                                               'mine', EXISTS (SELECT 1 FROM team_poll_votes v WHERE v.option_id=o.id AND v.user_id=$2 AND v.removed_at IS NULL)) ORDER BY o.position)
               FROM team_poll_options o WHERE o.message_id=p.message_id) AS options,
            (SELECT count(DISTINCT v.user_id)::int FROM team_poll_votes v WHERE v.message_id=p.message_id AND v.removed_at IS NULL) AS voters
       FROM team_polls p WHERE p.message_id = ANY($1)`, [ids, user.id]);
  const rsvps = await rsvpCounts(user, access.team.id, rows.filter((r) => r.kind === 'rsvp'));
  const sent = rows.filter((r) => r.mine);
  const reads = sent.length ? await many(
    `SELECT m.id, (SELECT count(*)::int FROM team_chat_reads r WHERE r.team_id=m.team_id AND r.user_id<>m.sender_id AND r.last_read_seq >= m.seq) AS read_by,
            (SELECT count(*)::int FROM team_members tm WHERE tm.team_id=m.team_id AND tm.status='active' AND tm.user_id<>m.sender_id) AS recipients
       FROM team_messages m WHERE m.id = ANY($1) AND m.audience='team'`, [sent.map((r) => r.message_id)]) : [];
  const by = (list, key) => new Map(list.map((x) => [x[key], x]));
  const R = by(replies, 'id'), M = by(media, 'id'), P = by(polls, 'message_id'), Rd = by(reads, 'id');
  return rows.map((r) => {
    const poll = P.get(r.message_id);
    const md = r.media_id ? M.get(r.media_id) : null;
    const rep = r.reply_to_id ? R.get(r.reply_to_id) : null;
    return {
      ...r, reply_to_id: undefined, media_id: undefined,
      reply_to: rep ? { message_id: r.reply_to_id, body: rep.body, display_name: rep.display_name } : null,
      media: md ? { ...md, url: `/api/v1/team-chat-media/${md.id}` } : null,
      reactions: reacts.filter((x) => x.message_id === r.message_id).map(({ emoji, count, mine }) => ({ emoji, count, mine })),
      poll: poll ? { question: poll.question, multiple: poll.multiple, closes_at: poll.closes_at, closed: !!poll.closed_at || (!!poll.closes_at && new Date(poll.closes_at) <= new Date()), options: poll.options ?? [], voters: poll.voters } : null,
      rsvp: rsvps.get(r.message_id) ?? null,
      delivery: r.mine ? { delivered: true, read_by: Rd.get(r.message_id)?.read_by ?? 0, recipients: Rd.get(r.message_id)?.recipients ?? 0 } : null,
    };
  });
}

/** The live attendance behind an RSVP prompt (counts and my own answer). Read from team_attendance every time; the message stores nothing. */
async function rsvpCounts(user, teamId, prompts) {
  const out = new Map();
  for (const p of prompts) {
    const rows = await many(
      `SELECT rsvp, count(*)::int AS n, bool_or(user_id=$4) AS mine FROM team_attendance WHERE team_id=$1 AND event_id IS NOT DISTINCT FROM $2 AND fixture_id IS NOT DISTINCT FROM $3 GROUP BY rsvp`,
      [teamId, p.event_id, p.fixture_id, user.id]);
    const label = p.fixture_id
      ? (await one('SELECT f.scheduled_at AS at, e.name FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [p.fixture_id]))
      : (await one('SELECT starts_on AS at, name FROM events WHERE id=$1', [p.event_id]));
    const c = Object.fromEntries(['pending', 'going', 'maybe', 'no'].map((k) => [k, rows.find((x) => x.rsvp === k)?.n ?? 0]));
    out.set(p.message_id, { event_id: p.event_id, fixture_id: p.fixture_id, name: label?.name ?? null, at: label?.at ?? null, counts: c, mine: rows.find((x) => x.mine)?.rsvp ?? null });
  }
  return out;
}

/** Tell every open stream of this team that these messages changed (new, edited by a reaction/vote/pin, or removed). */
export const announce = (teamId, ids) => publish(channel(teamId), { ids });

export const markRead = (teamId, userId) => one(
  `INSERT INTO team_chat_reads(team_id, user_id, last_read_seq) VALUES ($1,$2, coalesce((SELECT max(seq) FROM team_messages WHERE team_id=$1),0))
   ON CONFLICT (team_id, user_id) DO UPDATE SET last_read_at=now(), last_read_seq=greatest(team_chat_reads.last_read_seq, EXCLUDED.last_read_seq) RETURNING 1`, [teamId, userId]);

/** Long-poll helper: resolves true when the team's chat changes, false after `ms`. Lets clients without a stream (React Native) get messages the moment they arrive. */
export const waitForChange = (teamId, ms) => new Promise((resolve) => {
  let off = () => {};
  const t = setTimeout(() => { off(); resolve(false); }, ms);
  off = subscribe(channel(teamId), () => { clearTimeout(t); off(); resolve(true); });
});
