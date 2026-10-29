// Team chat: a single conversation per team for its active members (owners/managers included), plus a guardians channel for youth teams.
// Managers can post announcements, which notify every member. Deleting a message hides it but keeps the row.
// Real time: GET /teams/:id/messages/stream (Server-Sent Events, resumable by seq) on the web, and the same list with after_seq + wait_seconds
// (long poll) everywhere else; both read the same rows, so a reconnect never duplicates a message. See src/team-chat-stream.js.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { requireConsent, YOUTH_SQL } from '../youth.js';
import { attendanceScope, askAttendance } from './team-workspace.js';
import { announce, chatAccess, fetchMessages, markRead, mustBeSafeToPost, mustPost, waitForChange } from '../team-chat.js';

const audience = z.enum(['team', 'guardians']).describe('team = every member; guardians = managers and the verified guardians of young members');
const seqNo = z.coerce.number().int().min(0);

/** Everyone who should be told about a message: members for the team channel, guardians of young members for the guardians channel (and as a copy for young members' team announcements). */
async function audienceOf(c, teamId, aud, senderId) {
  const guardians = (await c.query(
    `SELECT DISTINCT l.guardian_id AS user_id FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN guardian_links l ON l.child_id=tm.user_id
      WHERE tm.team_id=$1 AND tm.status='active' AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL}`, [teamId])).rows.map((r) => r.user_id);
  const members = aud === 'team' ? (await c.query("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active'", [teamId])).rows.map((r) => r.user_id) : [];
  return [...new Set([...members, ...guardians])].filter((u) => u !== senderId);
}

async function oneMessage(user, access, messageId) {
  const [m] = await fetchMessages(user, access, { where: 'm.id=$4', params: [messageId], limit: 1 });
  return m ?? null;
}
const mustMessage = async (user, access, messageId) => (await oneMessage(user, access, messageId)) ?? (() => { throw notFound('Message'); })();

cap({
  name: 'send_team_message', method: 'POST', path: '/teams/:id/messages', tag: 'Team chat', status: 201,
  summary: 'Post to the team chat (or the guardians channel). Reply with reply_to_id, attach an uploaded photo / file / voice note with media_id. Managers can mark a message as an announcement, which notifies every recipient. Send client_id (any unique string) so a retry never posts twice.',
  input: z.object({
    id, body: z.string().trim().max(2000).default(''), announcement: z.boolean().default(false), audience: audience.default('team'),
    reply_to_id: id.optional(), media_id: id.optional(), client_id: z.string().min(8).max(64).optional(),
  }).refine((x) => x.body.length > 0 || x.media_id, { message: 'Write a message or attach a photo, file or voice note', path: ['body'] }),
  async handler({ user }, i) {
    const access = await chatAccess(user, i.id);
    mustPost(access, i.audience);
    await requireConsent(user.id, 'contact', 'messaging in the team chat');
    await mustBeSafeToPost(user, access);
    if (i.announcement && !access.manager) throw forbidden('Only owners and managers can post announcements');
    if (i.client_id) {
      const prior = await one('SELECT id FROM team_messages WHERE team_id=$1 AND sender_id=$2 AND client_id=$3', [i.id, user.id, i.client_id]);
      if (prior) return oneMessage(user, access, prior.id);
    }
    if (i.reply_to_id && !(await one('SELECT 1 FROM team_messages WHERE id=$1 AND team_id=$2 AND deleted_at IS NULL AND audience = ANY($3)', [i.reply_to_id, i.id, access.audiences]))) throw notFound('Message to reply to');
    if (i.media_id) {
      const md = await one('SELECT * FROM team_chat_media WHERE id=$1 AND team_id=$2 AND removed_at IS NULL', [i.media_id, i.id]);
      if (!md || md.uploader_id !== user.id) throw notFound('Attachment');
      if (md.audience !== i.audience) throw badRequest('That attachment was uploaded for the other channel');
      if (await one('SELECT 1 FROM team_messages WHERE media_id=$1', [i.media_id])) throw conflict('That attachment is already on a message');
    }
    const team = access.team;
    const mid = await tx(async (c) => {
      const m = (await c.query(
        `INSERT INTO team_messages(team_id, sender_id, body, announcement, audience, kind, reply_to_id, media_id, client_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (team_id, sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
        [i.id, user.id, i.body, i.announcement, i.audience, i.media_id ? 'media' : 'text', i.reply_to_id ?? null, i.media_id ?? null, i.client_id ?? null])).rows[0];
      if (!m) return null;
      if (i.announcement) {
        for (const u of await audienceOf(c, i.id, i.audience, user.id)) {
          await notify(c, u, { kind: 'team_announcement', title: `${team.name}: announcement`, body: (i.body || 'New attachment').slice(0, 140), data: { team_id: team.id }, dedupe_key: `team_announcement:${m.id}` });
        }
      }
      return m.id;
    });
    const stored = mid ?? (await one('SELECT id FROM team_messages WHERE team_id=$1 AND sender_id=$2 AND client_id=$3', [i.id, user.id, i.client_id])).id;
    await markRead(i.id, user.id);
    announce(i.id, [stored]);
    return oneMessage(user, access, stored);
  },
});

cap({
  name: 'list_team_messages', method: 'GET', path: '/teams/:id/messages', tag: 'Team chat',
  summary: 'The team conversation, newest first. Page back with `before` / `before_seq`. To stay current, pass `after_seq` (the highest seq you have; oldest first) and `wait_seconds` to hold the request open until something new arrives - safe to repeat after a reconnect, messages carry their id so you can dedupe. `channel` picks team or guardians (default: everything you may see). Reactions, votes, pins and RSVP counts arrive inside each message.',
  input: z.object({
    id, before: z.string().datetime({ offset: true }).optional(), after: z.string().datetime({ offset: true }).optional(), before_seq: seqNo.optional(), after_seq: seqNo.optional(),
    channel: audience.optional(), pinned: z.coerce.boolean().optional(), wait_seconds: z.coerce.number().int().min(0).max(25).default(0), limit: page.limit,
  }),
  async handler({ user }, i) {
    const access = await chatAccess(user, i.id);
    if (i.channel && !access.audiences.includes(i.channel)) throw forbidden('You cannot see that channel');
    const conds = [], params = [];
    const add = (sql, v) => { params.push(v); conds.push(sql.replace('?', `$${params.length + 3}`)); };
    if (i.channel) add('m.audience = ?', i.channel);
    if (i.before) add("date_trunc('milliseconds', m.created_at) < ?::timestamptz", i.before);
    if (i.after) add("date_trunc('milliseconds', m.created_at) > ?::timestamptz", i.after);
    if (i.before_seq != null) add('m.seq < ?', i.before_seq);
    if (i.after_seq != null) add('m.seq > ?', i.after_seq);
    if (i.pinned) conds.push('m.pinned_at IS NOT NULL');
    const run = () => fetchMessages(user, access, { where: conds.join(' AND ') || 'TRUE', params, limit: i.limit, order: i.after_seq != null ? 'ASC' : 'DESC' });
    let rows = await run();
    if (!rows.length && i.wait_seconds && (i.after_seq != null || i.after)) {
      if (await waitForChange(i.id, i.wait_seconds * 1000)) rows = await run();
      await chatAccess(user, i.id);   // the wait can be long: confirm the person is still allowed before anything is returned
    }
    return rows;
  },
});

cap({
  name: 'delete_team_message', method: 'DELETE', path: '/teams/:id/messages/:message_id', tag: 'Team chat',
  summary: 'Remove a message from the chat — your own, or any if you manage the team. The record is kept; an attachment stops being served.', input: z.object({ id, message_id: id }),
  async handler({ user }, i) {
    const { manager } = await chatAccess(user, i.id);
    const m = await one('SELECT sender_id, media_id FROM team_messages WHERE id=$1 AND team_id=$2 AND deleted_at IS NULL', [i.message_id, i.id]);
    if (!m) throw notFound('Message');
    if (m.sender_id !== user.id && !manager && !isAdmin(user)) throw forbidden();
    await query('UPDATE team_messages SET deleted_at=now(), deleted_by=$2 WHERE id=$1', [i.message_id, user.id]);
    if (m.media_id) await query('UPDATE team_chat_media SET removed_at=now() WHERE id=$1', [m.media_id]);
    announce(i.id, [i.message_id]);
    return { ok: true };
  },
});

cap({
  name: 'mark_team_chat_read', method: 'POST', path: '/teams/:id/messages/read', tag: 'Team chat', summary: 'Mark the team chat as read up to now.', input: z.object({ id }),
  async handler({ user }, i) {
    await chatAccess(user, i.id);
    await markRead(i.id, user.id);
    announce(i.id, []);
    return { ok: true };
  },
});

cap({
  name: 'list_my_team_chats', method: 'GET', path: '/me/team-chats', tag: 'Team chat', summary: 'Your teams\' chats (as a member, or as a guardian of a young member) with the latest message and how many are unread.', input: z.object({}),
  async handler({ user }) {
    const teams = await many(
      `SELECT t.id AS team_id, t.name, t.emoji, t.color FROM teams t WHERE
         EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.status='active')
         OR EXISTS (SELECT 1 FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN guardian_links l ON l.child_id=tm.user_id
                     WHERE tm.team_id=t.id AND tm.status='active' AND l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL})`, [user.id]);
    const out = [];
    for (const t of teams) {
      const { audiences } = await chatAccess(user, t.team_id);
      const last = await one(
        'SELECT lm.body, lm.created_at, lu.display_name AS sender, lm.kind FROM team_messages lm JOIN users lu ON lu.id=lm.sender_id WHERE lm.team_id=$1 AND lm.deleted_at IS NULL AND lm.audience = ANY($2) ORDER BY lm.seq DESC LIMIT 1', [t.team_id, audiences]);
      const unread = await one(
        `SELECT count(*)::int AS n FROM team_messages um LEFT JOIN team_chat_reads r ON r.team_id=um.team_id AND r.user_id=$1
          WHERE um.team_id=$2 AND um.deleted_at IS NULL AND um.audience = ANY($3) AND um.sender_id<>$1 AND um.created_at > coalesce(r.last_read_at, '-infinity')`, [user.id, t.team_id, audiences]);
      out.push({ ...t, last_message: last, unread: unread.n, channels: audiences });
    }
    const at = (x) => (x.last_message ? +new Date(x.last_message.created_at) : -Infinity);
    return out.sort((a, b) => (at(b) === at(a) ? a.name.localeCompare(b.name) : at(b) - at(a)));
  },
});

// ------------------------------------------------------------------ reactions, pins
cap({
  name: 'react_to_team_message', method: 'POST', path: '/teams/:id/messages/:message_id/reactions', tag: 'Team chat',
  summary: 'Add or remove your emoji reaction on a message (on: false removes it).', input: z.object({ id, message_id: id, emoji: z.string().trim().min(1).max(16), on: z.boolean().default(true) }),
  async handler({ user }, i) {
    const access = await chatAccess(user, i.id);
    await mustMessage(user, access, i.message_id);
    if (i.on) await query('INSERT INTO team_message_reactions(message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT (message_id, user_id, emoji) DO UPDATE SET removed_at=NULL, created_at=CASE WHEN team_message_reactions.removed_at IS NULL THEN team_message_reactions.created_at ELSE now() END', [i.message_id, user.id, i.emoji]);
    else await query('UPDATE team_message_reactions SET removed_at=now() WHERE message_id=$1 AND user_id=$2 AND emoji=$3 AND removed_at IS NULL', [i.message_id, user.id, i.emoji]);
    announce(i.id, [i.message_id]);
    return oneMessage(user, access, i.message_id);
  },
});

cap({
  name: 'pin_team_message', method: 'POST', path: '/teams/:id/messages/:message_id/pin', tag: 'Team chat',
  summary: 'Pin a message to the top of the chat, or unpin it (pinned: false). Owner and managers.', input: z.object({ id, message_id: id, pinned: z.boolean().default(true) }),
  async handler({ user }, i) {
    const access = await chatAccess(user, i.id);
    if (!access.manager) throw forbidden('Only owners and managers can pin messages');
    await mustMessage(user, access, i.message_id);
    await query('UPDATE team_messages SET pinned_at=CASE WHEN $2 THEN now() END, pinned_by=CASE WHEN $2 THEN $3::uuid END WHERE id=$1', [i.message_id, i.pinned, user.id]);
    announce(i.id, [i.message_id]);
    return oneMessage(user, access, i.message_id);
  },
});

// ------------------------------------------------------------------ polls
cap({
  name: 'create_team_poll', method: 'POST', path: '/teams/:id/polls', tag: 'Team chat', status: 201,
  summary: 'Ask the team (or the guardians) a question with 2-8 options. For "are you coming?" use post_team_rsvp_prompt instead - attendance is never stored in a poll.',
  input: z.object({
    id, question: z.string().trim().min(1).max(300), options: z.array(z.string().trim().min(1).max(120)).min(2).max(8), multiple: z.boolean().default(false),
    closes_at: z.string().datetime({ offset: true }).optional(), audience: audience.default('team'), client_id: z.string().min(8).max(64).optional(),
  }),
  async handler({ user }, i) {
    const access = await chatAccess(user, i.id);
    mustPost(access, i.audience);
    await requireConsent(user.id, 'contact', 'messaging in the team chat');
    await mustBeSafeToPost(user, access);
    if (new Set(i.options.map((o) => o.toLowerCase())).size !== i.options.length) throw badRequest('Each option must be different');
    if (i.closes_at && new Date(i.closes_at) <= new Date()) throw badRequest('closes_at must be in the future');
    if (i.client_id) {
      const prior = await one('SELECT id FROM team_messages WHERE team_id=$1 AND sender_id=$2 AND client_id=$3', [i.id, user.id, i.client_id]);
      if (prior) return oneMessage(user, access, prior.id);
    }
    const mid = await tx(async (c) => {
      const m = (await c.query("INSERT INTO team_messages(team_id, sender_id, body, audience, kind, client_id) VALUES ($1,$2,$3,$4,'poll',$5) RETURNING id", [i.id, user.id, i.question, i.audience, i.client_id ?? null])).rows[0];
      await c.query('INSERT INTO team_polls(message_id, question, multiple, closes_at) VALUES ($1,$2,$3,$4)', [m.id, i.question, i.multiple, i.closes_at ?? null]);
      for (const [k, label] of i.options.entries()) await c.query('INSERT INTO team_poll_options(message_id, position, label) VALUES ($1,$2,$3)', [m.id, k, label]);
      for (const u of await audienceOf(c, i.id, i.audience, user.id)) await notify(c, u, { kind: 'team_poll', title: `${access.team.name}: new poll`, body: i.question.slice(0, 140), data: { team_id: i.id, message_id: m.id }, dedupe_key: `team_poll:${m.id}` });
      return m.id;
    });
    await markRead(i.id, user.id);
    announce(i.id, [mid]);
    return oneMessage(user, access, mid);
  },
});

const pollOf = async (user, access, teamId, messageId) => {
  const p = await one(
    `SELECT p.*, m.audience FROM team_polls p JOIN team_messages m ON m.id=p.message_id WHERE p.message_id=$1 AND m.team_id=$2 AND m.deleted_at IS NULL AND m.audience = ANY($3)`, [messageId, teamId, access.audiences]);
  if (!p) throw notFound('Poll');
  return p;
};
const isClosed = (p) => !!p.closed_at || (p.closes_at && new Date(p.closes_at) <= new Date());

cap({
  name: 'vote_team_poll', method: 'POST', path: '/teams/:id/polls/:message_id/vote', tag: 'Team chat',
  summary: 'Set your vote on a poll: send the option ids you choose (one, or several if the poll allows it; an empty list withdraws your vote). Voting again replaces your earlier vote.',
  input: z.object({ id, message_id: id, option_ids: z.array(id).max(8) }),
  async handler({ user }, i) {
    const access = await chatAccess(user, i.id);
    const p = await pollOf(user, access, i.id, i.message_id);
    mustPost(access, p.audience);
    await requireConsent(user.id, 'contact', 'voting in the team chat');
    if (isClosed(p)) throw conflict('This poll is closed');
    const ids = [...new Set(i.option_ids)];
    if (ids.length > 1 && !p.multiple) throw badRequest('This poll allows one choice');
    if (ids.length) {
      const ok = await one('SELECT count(*)::int AS n FROM team_poll_options WHERE message_id=$1 AND id = ANY($2)', [i.message_id, ids]);
      if (ok.n !== ids.length) throw badRequest('Unknown option');
    }
    await tx(async (c) => {
      await c.query('UPDATE team_poll_votes SET removed_at=now() WHERE message_id=$1 AND user_id=$2 AND removed_at IS NULL AND NOT (option_id = ANY($3))', [i.message_id, user.id, ids]);   // a changed vote is kept, marked withdrawn
      for (const o of ids) await c.query('INSERT INTO team_poll_votes(option_id, message_id, user_id) VALUES ($1,$2,$3) ON CONFLICT (option_id, user_id) DO UPDATE SET removed_at=NULL', [o, i.message_id, user.id]);
    });
    announce(i.id, [i.message_id]);
    return oneMessage(user, access, i.message_id);
  },
});

cap({
  name: 'close_team_poll', method: 'POST', path: '/teams/:id/polls/:message_id/close', tag: 'Team chat',
  summary: 'Close a poll so nobody can vote any more. The poster or a manager.', input: z.object({ id, message_id: id }),
  async handler({ user }, i) {
    const access = await chatAccess(user, i.id);
    const p = await pollOf(user, access, i.id, i.message_id);
    const owner = await one('SELECT sender_id FROM team_messages WHERE id=$1', [i.message_id]);
    if (owner.sender_id !== user.id && !access.manager) throw forbidden('Only the person who asked, or a manager, can close this poll');
    if (!p.closed_at) await query('UPDATE team_polls SET closed_at=now(), closed_by=$2 WHERE message_id=$1', [i.message_id, user.id]);
    announce(i.id, [i.message_id]);
    return oneMessage(user, access, i.message_id);
  },
});

// ------------------------------------------------------------------ RSVP prompt (points at the canonical attendance)
cap({
  name: 'post_team_rsvp_prompt', method: 'POST', path: '/teams/:id/rsvp-prompts', tag: 'Team chat', status: 201,
  summary: 'Ask the roster (or the selected squad) "are you coming?" for an event or match. This asks for attendance through the team schedule - answers are stored in team attendance (set_event_rsvp), and the chat card shows the live counts. Owner/managers.',
  input: z.object({ id, event_id: id.optional(), fixture_id: id.optional(), squad_only: z.boolean().default(false), note: z.string().trim().max(300).default('') }),
  async handler({ user }, i) {
    const access = await chatAccess(user, i.id);
    if (!access.manager) throw forbidden('Only owners and managers can ask the team to RSVP');
    const s = await attendanceScope(access.team, i);
    const mid = await tx(async (c) => {
      await askAttendance(c, access.team, user, s, i.squad_only);
      return (await c.query("INSERT INTO team_messages(team_id, sender_id, body, kind, event_id, fixture_id) VALUES ($1,$2,$3,'rsvp',$4,$5) RETURNING id", [i.id, user.id, i.note, s.event_id, s.fixture_id])).rows[0].id;
    });
    await markRead(i.id, user.id);
    announce(i.id, [mid]);
    return oneMessage(user, access, mid);
  },
});
