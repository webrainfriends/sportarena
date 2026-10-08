// Team chat: a single conversation per team for its active members (owners/managers included).
// Managers can post announcements, which notify every member. Deleting a message hides it but keeps the row.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind, PUBLIC_USER } from '../helpers.js';
import { notify } from '../notify.js';
import { canManageTeam } from './teams.js';
import { requireConsent } from '../youth.js';

async function chatAccess(user, teamId) {
  const team = await mustFind('teams', teamId);
  const manager = await canManageTeam(user, team);
  const member = !!(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [teamId, user.id]));
  if (!manager && !member) throw forbidden('Only team members can use the team chat');
  return { team, manager };
}

const MSG = `SELECT m.id AS message_id, m.team_id, m.body, m.announcement, m.created_at, ${PUBLIC_USER}, (m.sender_id = $2) AS mine FROM team_messages m JOIN users u ON u.id = m.sender_id`;

cap({
  name: 'send_team_message', method: 'POST', path: '/teams/:id/messages', tag: 'Team chat', status: 201,
  summary: 'Post to the team chat. Managers can mark a message as an announcement, which notifies every member.',
  input: z.object({ id, body: z.string().trim().min(1).max(2000), announcement: z.boolean().default(false) }),
  async handler({ user }, i) {
    const { team, manager } = await chatAccess(user, i.id);
    await requireConsent(user.id, 'contact', 'messaging in the team chat');
    if (i.announcement && !manager) throw forbidden('Only owners and managers can post announcements');
    const m = await one('INSERT INTO team_messages(team_id, sender_id, body, announcement) VALUES ($1,$2,$3,$4) RETURNING id', [i.id, user.id, i.body, i.announcement]);
    await query('INSERT INTO team_chat_reads(team_id, user_id) VALUES ($1,$2) ON CONFLICT (team_id, user_id) DO UPDATE SET last_read_at=now()', [i.id, user.id]);
    if (i.announcement) {
      const { rows } = await query("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND user_id<>$2", [i.id, user.id]);
      for (const r of rows) await notify(null, r.user_id, { kind: 'team_announcement', title: `${team.name}: announcement`, body: i.body.slice(0, 140), data: { team_id: team.id } });
    }
    return one(`${MSG} WHERE m.id=$1`, [m.id, user.id]);
  },
});

cap({
  name: 'list_team_messages', method: 'GET', path: '/teams/:id/messages', tag: 'Team chat',
  summary: 'The team conversation, newest first. Page back with `before` (a created_at from the oldest message you have); poll with `after` for new ones.',
  input: z.object({ id, before: z.string().datetime({ offset: true }).optional(), after: z.string().datetime({ offset: true }).optional(), limit: page.limit }),
  async handler({ user }, i) {
    await chatAccess(user, i.id);
    return many(`${MSG} WHERE m.team_id=$1 AND m.deleted_at IS NULL AND ($3::timestamptz IS NULL OR date_trunc('milliseconds', m.created_at) < $3) AND ($4::timestamptz IS NULL OR date_trunc('milliseconds', m.created_at) > $4)
                 ORDER BY m.created_at DESC LIMIT $5`, [i.id, user.id, i.before ?? null, i.after ?? null, i.limit]);
  },
});

cap({
  name: 'delete_team_message', method: 'DELETE', path: '/teams/:id/messages/:message_id', tag: 'Team chat',
  summary: 'Remove a message from the chat — your own, or any if you manage the team. The record is kept.', input: z.object({ id, message_id: id }),
  async handler({ user }, i) {
    const { manager } = await chatAccess(user, i.id);
    const m = await one('SELECT sender_id FROM team_messages WHERE id=$1 AND team_id=$2 AND deleted_at IS NULL', [i.message_id, i.id]);
    if (!m) throw notFound('Message');
    if (m.sender_id !== user.id && !manager && !isAdmin(user)) throw forbidden();
    await query('UPDATE team_messages SET deleted_at=now(), deleted_by=$2 WHERE id=$1', [i.message_id, user.id]);
    return { ok: true };
  },
});

cap({
  name: 'mark_team_chat_read', method: 'POST', path: '/teams/:id/messages/read', tag: 'Team chat', summary: 'Mark the team chat as read up to now.', input: z.object({ id }),
  async handler({ user }, i) {
    await chatAccess(user, i.id);
    await query('INSERT INTO team_chat_reads(team_id, user_id) VALUES ($1,$2) ON CONFLICT (team_id, user_id) DO UPDATE SET last_read_at=now()', [i.id, user.id]);
    return { ok: true };
  },
});

cap({
  name: 'list_my_team_chats', method: 'GET', path: '/me/team-chats', tag: 'Team chat', summary: 'Your teams\' chats with the latest message and how many are unread.', input: z.object({}),
  handler: ({ user }) => many(
    `SELECT t.id AS team_id, t.name, t.emoji, t.color,
            (SELECT row_to_json(x) FROM (SELECT lm.body, lm.created_at, lu.display_name AS sender FROM team_messages lm JOIN users lu ON lu.id=lm.sender_id WHERE lm.team_id=t.id AND lm.deleted_at IS NULL ORDER BY lm.created_at DESC LIMIT 1) x) AS last_message,
            (SELECT count(*)::int FROM team_messages um WHERE um.team_id=t.id AND um.deleted_at IS NULL AND um.sender_id<>$1 AND um.created_at > coalesce(r.last_read_at, '-infinity')) AS unread
       FROM team_members m JOIN teams t ON t.id=m.team_id LEFT JOIN team_chat_reads r ON r.team_id=t.id AND r.user_id=$1
      WHERE m.user_id=$1 AND m.status='active' ORDER BY (SELECT max(created_at) FROM team_messages WHERE team_id=t.id) DESC NULLS LAST, t.name`, [user.id]),
});
