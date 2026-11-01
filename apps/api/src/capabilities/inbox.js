// Unified Inbox (issue #594): one inbox for team chats, notifications and the conversations added here (direct, group, event channel and threads
// linked to a team / event / fixture / registration), with attachments, delivery and read status, urgent notices that escalate, moderation,
// reporting, search and archive. The rules live in src/inbox.js; team chat itself (polls, RSVP, media) stays in capabilities/team-chat.js.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, PUBLIC_USER } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { YOUTH_SQL, guardiansOf, isYouth, requireConsent } from '../youth.js';
import { myTeamChats } from './team-chat.js';
import { linkFor } from '../workspace.js';
import { chatAccess } from '../team-chat.js';
import {
  NOTE_CTX, assertMayContact, conversationAccess, contextOrganisation, eventPeople, isBlocked, markConversationRead, mayJoinContext, postMessage, preview, readMessages, runsContext,
  sharesContext, teamPeople, openBody,
} from '../inbox.js';

const TAG = 'Inbox';
const FILTERS = ['all', 'teams', 'events', 'direct', 'announcements', 'alerts', 'archived'];
const seqNo = z.coerce.number().int().min(0);
const bodyText = z.string().trim().max(4000);

// ---------------------------------------------------------------------------------------------------------------- the inbox
const CONV_LIST = `
  SELECT c.id, c.kind, c.title, c.announcements_only, c.archived_at, c.last_message_at, c.created_at, c.team_id, c.event_id, c.fixture_id, c.entry_id,
         t.name AS team_name, e.name AS event_name, f.round AS fixture_round,
         (m.user_id IS NOT NULL) AS is_member, m.muted_at, m.role,
         (SELECT u2.display_name FROM conversation_members o JOIN users u2 ON u2.id=o.user_id WHERE o.conversation_id=c.id AND o.user_id<>$1 AND c.kind='direct' LIMIT 1) AS other_name,
         (SELECT count(*)::int FROM conversation_messages x WHERE x.conversation_id=c.id AND m.user_id IS NOT NULL AND x.seq > m.last_read_seq AND x.sender_id<>$1 AND x.hidden_at IS NULL) AS unread,
         (SELECT count(*)::int FROM conversation_messages x WHERE x.conversation_id=c.id AND m.user_id IS NOT NULL AND x.requires_ack AND x.hidden_at IS NULL AND x.sender_id<>$1
             AND NOT EXISTS (SELECT 1 FROM conversation_acks a WHERE a.message_id=x.id AND a.user_id=$1)) AS needs_ack,
         (SELECT json_build_object('body_enc', x.body_enc, 'kind', x.kind, 'sender', su.display_name, 'at', x.created_at) FROM conversation_messages x JOIN users su ON su.id=x.sender_id
           WHERE x.conversation_id=c.id AND x.hidden_at IS NULL ORDER BY x.seq DESC LIMIT 1) AS last
    FROM conversations c
    LEFT JOIN conversation_members m ON m.conversation_id=c.id AND m.user_id=$1 AND m.left_at IS NULL
    LEFT JOIN teams t ON t.id=c.team_id
    LEFT JOIN fixtures f ON f.id=c.fixture_id
    LEFT JOIN event_entries en ON en.id=c.entry_id
    LEFT JOIN events e ON e.id=coalesce(c.event_id, f.event_id, en.event_id)
   WHERE (m.user_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM conversation_members gm JOIN users gu ON gu.id=gm.user_id JOIN guardian_links l ON l.child_id=gm.user_id
            WHERE gm.conversation_id=c.id AND gm.left_at IS NULL AND l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL.replaceAll('u.', 'gu.')}))
   ORDER BY coalesce(c.last_message_at, c.created_at) DESC LIMIT 300`;

const contextLabel = (r) => r.fixture_id ? `Fixture${r.fixture_round ? ` · ${r.fixture_round}` : ''}${r.event_name ? ` · ${r.event_name}` : ''}`
  : r.entry_id ? `Registration${r.event_name ? ` · ${r.event_name}` : ''}` : r.event_id ? `Event · ${r.event_name}` : r.team_id ? `Team · ${r.team_name}` : null;

async function inboxItems(user) {
  const [convs, teams, notes] = await Promise.all([
    many(CONV_LIST, [user.id]),
    myTeamChats(user),
    many("SELECT id, kind, title, body, data, read_at, created_at FROM notifications WHERE user_id=$1 AND kind NOT LIKE 'conversation\\_%' ORDER BY created_at DESC LIMIT 300", [user.id]),
  ]);
  const items = [];
  for (const r of convs) {
    const last = r.last ? { text: preview(r.last.body_enc, 120), sender: r.last.sender, kind: r.last.kind, at: r.last.at } : null;
    items.push({
      key: `conversation:${r.id}`, source: 'conversation', type: r.kind, conversation_id: r.id,
      title: r.kind === 'direct' ? (r.other_name ?? 'Direct message') : (r.title ?? r.event_name ?? r.team_name ?? 'Conversation'),
      preview: last?.text ?? null, last_sender: last?.sender ?? null, at: last?.at ?? r.last_message_at ?? r.created_at, unread: r.unread, needs_ack: r.needs_ack,
      context: contextLabel(r), announcement: !!r.announcements_only || last?.kind === 'announcement', archived: !!r.archived_at, muted: !!r.muted_at, read_only: !r.is_member,
      team_id: r.team_id, event_id: r.event_id,
    });
  }
  for (const t of teams) {
    items.push({
      key: `team_chat:${t.team_id}`, source: 'team_chat', type: 'team', team_id: t.team_id, title: t.name, emoji: t.emoji, color: t.color, preview: t.last_message?.body ?? null,
      last_sender: t.last_message?.sender ?? null, at: t.last_message?.created_at ?? null, unread: t.unread, needs_ack: 0, context: 'Team channel', announcement: t.last_message?.kind === 'announcement',
      archived: false, muted: false, read_only: false, channels: t.channels,
    });
  }
  for (const n of notes) {
    items.push({ key: `notification:${n.id}`, source: 'notification', type: 'alert', notification_id: n.id, kind: n.kind, title: n.title, preview: n.body, at: n.created_at, unread: n.read_at ? 0 : 1, needs_ack: 0, context: null, announcement: false, archived: false, muted: false, read_only: false, link: linkFor(n.kind, n.data) });
  }
  return items.filter((x) => x.at).sort((a, b) => +new Date(b.at) - +new Date(a.at));
}

const matches = (f, x) => ({
  all: !x.archived,
  teams: !x.archived && (x.type === 'team' || (x.source === 'conversation' && !!x.team_id)),
  events: !x.archived && x.source === 'conversation' && !!x.event_id,
  direct: !x.archived && x.type === 'direct',
  announcements: !x.archived && x.announcement,
  alerts: !x.archived && (x.type === 'alert' || x.needs_ack > 0),
  archived: x.archived,
})[f];

cap({
  name: 'list_inbox', method: 'GET', path: '/inbox', tag: TAG,
  summary: 'Your one inbox: team chats, direct and group conversations, event channels, threads about a team / fixture / registration, announcements and system alerts, newest first, with unread counts. Filter by all, teams, events, direct, announcements, alerts or archived. Guardians also see their young person\'s conversations, read-only.',
  input: z.object({ filter: z.enum(FILTERS).default('all'), unread: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const all = await inboxItems(user);
    const counts = Object.fromEntries(FILTERS.map((f) => [f, all.filter((x) => matches(f, x)).reduce((n, x) => n + (x.unread > 0 || x.needs_ack > 0 ? 1 : 0), 0)]));
    const rows = all.filter((x) => matches(i.filter, x) && (!i.unread || x.unread > 0 || x.needs_ack > 0));
    return { unread_total: counts.all, unread_by_filter: counts, total: rows.length, items: rows.slice(i.offset, i.offset + i.limit) };
  },
});

cap({
  name: 'search_inbox', method: 'GET', path: '/inbox/search', tag: TAG,
  summary: 'Search your inbox: conversation titles and messages (decrypted for you only, over your 1,500 most recent messages), team chat messages and notifications. Hidden messages are never searched.',
  input: z.object({ q: z.string().trim().min(2).max(80), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  async handler({ user }, i) {
    const needle = i.q.toLowerCase();
    const out = [];
    const rows = await many(
      `SELECT x.id AS message_id, x.conversation_id, x.seq, x.body_enc, x.created_at, c.kind, c.title, su.display_name AS sender,
              (SELECT u2.display_name FROM conversation_members o JOIN users u2 ON u2.id=o.user_id WHERE o.conversation_id=c.id AND o.user_id<>$1 AND c.kind='direct' LIMIT 1) AS other_name
         FROM conversation_messages x JOIN conversations c ON c.id=x.conversation_id JOIN users su ON su.id=x.sender_id
        WHERE x.hidden_at IS NULL AND (EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$1 AND m.left_at IS NULL)
              OR EXISTS (SELECT 1 FROM conversation_members gm JOIN users gu ON gu.id=gm.user_id JOIN guardian_links l ON l.child_id=gm.user_id
                          WHERE gm.conversation_id=c.id AND gm.left_at IS NULL AND l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL.replaceAll('u.', 'gu.')}))
        ORDER BY x.created_at DESC LIMIT 1500`, [user.id]);
    for (const r of rows) {
      const text = openBody(r.body_enc);
      if (!text.toLowerCase().includes(needle)) continue;
      out.push({ source: 'conversation', conversation_id: r.conversation_id, message_id: r.message_id, seq: Number(r.seq), title: r.kind === 'direct' ? r.other_name : r.title, sender: r.sender, snippet: preview(r.body_enc, 140), at: r.created_at });
      if (out.length >= i.limit) break;
    }
    for (const t of await myTeamChats(user)) {
      if (out.length >= i.limit) break;
      const { audiences } = await chatAccess(user, t.team_id);
      for (const m of await many("SELECT id, body, created_at FROM team_messages WHERE team_id=$1 AND deleted_at IS NULL AND audience = ANY($2) AND body ILIKE $3 ORDER BY seq DESC LIMIT 5", [t.team_id, audiences, `%${i.q.replace(/[%_\\]/g, '\\$&')}%`])) {
        out.push({ source: 'team_chat', team_id: t.team_id, message_id: m.id, title: t.name, snippet: m.body.slice(0, 140), at: m.created_at });
      }
    }
    for (const n of await many("SELECT id, title, body, created_at FROM notifications WHERE user_id=$1 AND kind NOT LIKE 'conversation\\_%' AND (title ILIKE $2 OR body ILIKE $2) ORDER BY created_at DESC LIMIT 10", [user.id, `%${i.q.replace(/[%_\\]/g, '\\$&')}%`])) {
      out.push({ source: 'notification', notification_id: n.id, title: n.title, snippet: n.body.slice(0, 140), at: n.created_at });
    }
    return { q: i.q, results: out.sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, i.limit) };
  },
});

// ---------------------------------------------------------------------------------------------------------------- pick lists for the compose sheet
cap({
  name: 'list_inbox_contacts', method: 'GET', path: '/inbox/contacts', tag: TAG,
  summary: 'People you may message: teammates, organisation colleagues, people in your events, and your guardian / young-person links, by name or handle. With team_id or event_id (a team or event you run) it lists the people connected to it, for adding to a group or thread. Young people never appear for other young people, and anyone who blocked you is left out.',
  input: z.object({ q: z.string().trim().max(60).optional(), team_id: id.optional(), event_id: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }),
  async handler({ user }, i) {
    const like = i.q ? `%${i.q.replace(/[%_\\]/g, '\\$&')}%` : null;
    const ctx = { team_id: i.team_id ?? null, event_id: i.event_id ?? null };
    let ids;
    if (ctx.team_id || ctx.event_id) {
      if (!(await runsContext(user, ctx))) throw notFound('Team or event');
      ids = ctx.event_id ? await eventPeople(ctx.event_id) : await teamPeople(ctx.team_id);
    } else {
      ids = (await many(
        `SELECT DISTINCT user_id FROM (
           SELECT y.user_id FROM team_members x JOIN team_members y ON y.team_id=x.team_id AND y.status='active' WHERE x.user_id=$1 AND x.status='active'
           UNION SELECT y.user_id FROM organisation_members x JOIN organisation_members y ON y.organisation_id=x.organisation_id AND y.status='active' WHERE x.user_id=$1 AND x.status='active'
           UNION SELECT l.child_id FROM guardian_links l WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
           UNION SELECT l.guardian_id FROM guardian_links l WHERE l.child_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
           UNION SELECT y.user_id FROM event_entries e JOIN team_members x ON x.team_id=e.team_id AND x.status='active' AND x.user_id=$1 JOIN events ev ON ev.id=e.event_id JOIN LATERAL (SELECT ev.organizer_id AS user_id) y ON true
         ) p`, [user.id])).map((r) => r.user_id);
    }
    const me = await isYouth(user.id);
    const rows = ids.length ? await many(
      `SELECT ${PUBLIC_USER}, ${YOUTH_SQL} AS young FROM users u WHERE u.id = ANY($1) AND u.id<>$2 AND ($3::text IS NULL OR u.display_name ILIKE $3 OR u.handle ILIKE $3)
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.lifted_at IS NULL AND ((b.blocker_id=u.id AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=u.id)))
        ORDER BY u.display_name LIMIT $4`, [ids, user.id, like, i.limit]) : [];
    return { people: rows.filter((r) => !(me && r.young)).map(({ young, ...p }) => ({ ...p, young })) };
  },
});

cap({
  name: 'list_inbox_contexts', method: 'GET', path: '/inbox/contexts', tag: TAG,
  summary: 'What you can start a group, event channel or thread about: teams you manage, events you organise, and your own registrations. Pick one when composing.', input: z.object({}),
  async handler({ user }) {
    const teams = (await many("SELECT t.* FROM teams t WHERE t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('captain','manager','coach'))", [user.id]));
    const managed = [];
    for (const t of teams) if (await runsContext(user, { team_id: t.id })) managed.push({ team_id: t.id, name: t.name, emoji: t.emoji });
    const events = await many("SELECT e.id AS event_id, e.name, e.status, EXISTS (SELECT 1 FROM conversations c WHERE c.event_id=e.id AND c.kind='event' AND c.archived_at IS NULL) AS has_channel FROM events e WHERE e.organizer_id=$1 AND e.status <> 'cancelled' ORDER BY e.created_at DESC LIMIT 50", [user.id]);
    const entries = await many(
      `SELECT en.id AS entry_id, ev.name AS event_name, coalesce(t.name, 'Individual entry') AS entrant FROM event_entries en JOIN events ev ON ev.id=en.event_id LEFT JOIN teams t ON t.id=en.team_id
        WHERE en.status IN ('pending','accepted') AND (en.user_id=$1 OR t.owner_id=$1) ORDER BY en.created_at DESC LIMIT 50`, [user.id]);
    return { teams: managed, events, registrations: entries };
  },
});

// ---------------------------------------------------------------------------------------------------------------- starting conversations
/** Add people to a conversation, enforcing the youth rules: a young person needs a live guardian and a current contact consent; guardians then see it read-only. */
async function addPeople(c, conv, userIds, addedBy, { role = 'member' } = {}) {
  for (const uid of [...new Set(userIds)]) {
    if (await isYouth(uid, c)) {
      if (!(await guardiansOf(uid, c)).length) throw conflict('A young person needs a verified guardian before joining a conversation', { code: 'guardian_required', user_id: uid });
      await requireConsent(uid, 'contact', 'conversations', c);
    }
    await c.query(
      `INSERT INTO conversation_members(conversation_id, user_id, role, added_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at=NULL, joined_at=CASE WHEN conversation_members.left_at IS NULL THEN conversation_members.joined_at ELSE now() END, silenced_until=NULL`,
      [conv, uid, role, addedBy]);
  }
}

const ctxIds = z.object({ team_id: id.optional(), event_id: id.optional(), fixture_id: id.optional(), entry_id: id.optional() });

cap({
  name: 'start_conversation', method: 'POST', path: '/conversations', tag: TAG, status: 201,
  summary: 'Start a conversation. direct: one person you already share a team, organisation, event or guardian link with (one conversation per pair; a young person needs a verified guardian, who can then read it). group: a named group for a team or event you run. event: the one channel of an event you organise (everyone connected to the event joins). context: a thread about a team, event, fixture or registration. Add `body` to send the first message.',
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('direct'), user_id: id, body: bodyText.optional() }),
    z.object({ kind: z.literal('group'), title: z.string().trim().min(1).max(80), member_ids: z.array(id).min(1).max(200), announcements_only: z.boolean().default(false), body: bodyText.optional() }).merge(ctxIds),
    z.object({ kind: z.literal('event'), event_id: id, title: z.string().trim().min(1).max(80).optional(), announcements_only: z.boolean().default(false), body: bodyText.optional() }),
    z.object({ kind: z.literal('context'), title: z.string().trim().min(1).max(80).optional(), member_ids: z.array(id).max(200).default([]), body: bodyText.optional() }).merge(ctxIds),
  ]),
  async handler({ user }, i) {
    let convId;
    if (i.kind === 'direct') {
      if (i.user_id === user.id) throw badRequest('Choose someone else');
      const other = await one('SELECT id FROM users WHERE id=$1', [i.user_id]);
      if (!other || (await isBlocked(user.id, i.user_id)) || !(await sharesContext(user.id, i.user_id))) throw notFound('Person');
      await assertMayContact(user.id, i.user_id);
      const key = [user.id, i.user_id].sort().join(':');
      convId = await tx(async (c) => {
        const ex = (await c.query('SELECT id FROM conversations WHERE direct_key=$1', [key])).rows[0];
        const cid = ex?.id ?? (await c.query("INSERT INTO conversations(kind, created_by, direct_key) VALUES ('direct',$1,$2) RETURNING id", [user.id, key])).rows[0].id;
        await addPeople(c, cid, [user.id, i.user_id], user.id);
        return cid;
      });
    } else {
      const ctx = { team_id: i.team_id ?? null, event_id: i.event_id ?? null, fixture_id: i.fixture_id ?? null, entry_id: i.entry_id ?? null };
      if (i.kind === 'group' && !ctx.team_id && !ctx.event_id) throw badRequest('A group is about a team or an event: choose which');
      if (i.kind === 'context' && !Object.values(ctx).some(Boolean)) throw badRequest('Choose the team, event, fixture or registration this thread is about');
      for (const [k, t] of [['team_id', 'teams'], ['event_id', 'events'], ['fixture_id', 'fixtures'], ['entry_id', 'event_entries']]) if (ctx[k] && !(await one(`SELECT 1 FROM ${t} WHERE id=$1`, [ctx[k]]))) throw notFound('Team, event, fixture or registration');
      let entryOwner = false;
      if (ctx.entry_id) {
        const en = await one('SELECT e.user_id, e.team_id FROM event_entries e WHERE e.id=$1', [ctx.entry_id]);
        entryOwner = en.user_id === user.id || (!!en.team_id && (await teamPeople(en.team_id)).includes(user.id) && !!(await one("SELECT 1 FROM teams t WHERE t.id=$1 AND t.owner_id=$2", [en.team_id, user.id])));
      }
      if (!(await runsContext(user, ctx)) && !entryOwner) throw notFound(i.kind === 'event' ? 'Event' : 'Team, event, fixture or registration');
      const orgId = await contextOrganisation(ctx);
      const title = i.title ?? (ctx.event_id ? (await one('SELECT name FROM events WHERE id=$1', [ctx.event_id]))?.name : ctx.team_id ? (await one('SELECT name FROM teams WHERE id=$1', [ctx.team_id]))?.name : null);
      let people = [];
      if (i.kind === 'event') people = await eventPeople(ctx.event_id);
      else {
        people = i.member_ids ?? [];
        for (const uid of people) if (!(await mayJoinContext(ctx, uid))) throw badRequest('Everyone in a conversation must be connected to its team, event, fixture or registration', { user_id: uid });
        if (i.kind === 'context' && ctx.entry_id) {
          const en = await one('SELECT e.user_id, ev.organizer_id, (SELECT owner_id FROM teams WHERE id=e.team_id) AS team_owner FROM event_entries e JOIN events ev ON ev.id=e.event_id WHERE e.id=$1', [ctx.entry_id]);
          people = [...people, en.organizer_id, en.user_id ?? en.team_owner].filter(Boolean);
        }
      }
      convId = await tx(async (c) => {
        if (i.kind === 'event' && (await c.query("SELECT 1 FROM conversations WHERE kind='event' AND event_id=$1 AND archived_at IS NULL", [ctx.event_id])).rowCount) throw conflict('This event already has a channel');
        const cid = (await c.query(
          `INSERT INTO conversations(kind, title, created_by, team_id, event_id, fixture_id, entry_id, organisation_id, announcements_only) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [i.kind, title ?? null, user.id, ctx.team_id, ctx.event_id, ctx.fixture_id, ctx.entry_id, orgId, i.announcements_only ?? false])).rows[0].id;
        await addPeople(c, cid, [user.id], user.id, { role: 'owner' });
        await addPeople(c, cid, people.filter((p) => p !== user.id), user.id);
        return cid;
      });
    }
    if (i.body) {
      const access = await conversationAccess(user, convId, { write: true });
      await postMessage(user, access, { body: i.body });
    }
    return conversationView(user, convId);
  },
});

async function conversationView(user, convId) {
  const access = await conversationAccess(user, convId);
  const { conv } = access;
  const members = await many(
    `SELECT ${PUBLIC_USER}, m.role, m.muted_at IS NOT NULL AS muted, (m.silenced_until IS NOT NULL AND m.silenced_until > now()) AS silenced,
            ${YOUTH_SQL} AS young
       FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND m.left_at IS NULL ORDER BY m.joined_at LIMIT 300`, [conv.id]);
  const names = await one(
    `SELECT t.name AS team_name, e.name AS event_name FROM conversations c LEFT JOIN teams t ON t.id=c.team_id
       LEFT JOIN fixtures f ON f.id=c.fixture_id LEFT JOIN event_entries en ON en.id=c.entry_id LEFT JOIN events e ON e.id=coalesce(c.event_id,f.event_id,en.event_id) WHERE c.id=$1`, [conv.id]);
  const mine = access.member;
  const other = conv.kind === 'direct' ? members.find((m) => m.id !== user.id) : null;
  return {
    conversation_id: conv.id, kind: conv.kind, title: other?.display_name ?? conv.title ?? names?.event_name ?? names?.team_name ?? 'Conversation',
    team_id: conv.team_id, event_id: conv.event_id, fixture_id: conv.fixture_id, entry_id: conv.entry_id, team_name: names?.team_name ?? null, event_name: names?.event_name ?? null,
    announcements_only: conv.announcements_only, retention_days: conv.retention_days, archived: !!conv.archived_at, archived_reason: conv.archived_reason,
    you: { member: !!mine, moderator: access.moderator, guardian_view: access.guardian, can_post: access.canPost, muted: !!mine?.muted_at, silenced: access.silenced },
    members: members.map(({ muted, silenced, ...p }) => ({ ...p, ...(access.moderator ? { muted, silenced } : {}) })),
    guardians_can_read: members.some((m) => m.young),
  };
}

cap({
  name: 'get_conversation', method: 'GET', path: '/conversations/:id', tag: TAG,
  summary: 'A conversation: who is in it, what it is about, whether you can post, and whether guardians of young members can read it.', input: z.object({ id }),
  handler: ({ user }, i) => conversationView(user, i.id),
});

// ---------------------------------------------------------------------------------------------------------------- messages
cap({
  name: 'list_conversation_messages', method: 'GET', path: '/conversations/:id/messages', tag: TAG,
  summary: 'Messages of a conversation, oldest first. after_seq returns what is newer than a message you hold; before_seq pages back. Hidden messages come back as placeholders. Senders and organisers see read counts. A guardian reading a young member\'s conversation is audit-logged.',
  input: z.object({ id, after_seq: seqNo.default(0), before_seq: seqNo.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    if (access.guardian && !access.member) await audit(null, user.id, 'guardian_read_conversation', 'conversations', i.id);
    const messages = await readMessages(user, access, { afterSeq: i.after_seq, beforeSeq: i.before_seq ?? null, limit: i.limit });
    return { conversation_id: i.id, messages, last_seq: Number(access.conv.last_seq), can_post: access.canPost };
  },
});

cap({
  name: 'send_conversation_message', method: 'POST', path: '/conversations/:id/messages', tag: TAG, status: 201,
  summary: 'Post to a conversation. Reply with reply_to_id and attach an uploaded file with attachment_id. Organisers can post an announcement or an urgent notice (requires_ack): recipients must confirm, and anyone who has not does after their escalation delay is re-sent it as an urgent alert. Send client_id (any unique string) so a retry never posts twice. Notifications never carry the text.',
  input: z.object({
    id, body: bodyText.default(''), announcement: z.boolean().default(false), requires_ack: z.boolean().default(false), escalate_after_minutes: z.number().int().min(5).max(1440).optional(),
    reply_to_id: id.optional(), attachment_id: id.optional(), client_id: z.string().min(8).max(64).optional(),
  }).refine((x) => x.body.length > 0 || x.attachment_id, { message: 'Write a message or attach a file', path: ['body'] }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id, { write: true });
    if (await isYouth(user.id)) await requireConsent(user.id, 'contact', 'messaging');
    const sent = await postMessage(user, access, i);
    const [m] = await readMessages(user, access, { afterSeq: Math.max(0, (sent.seq ?? (await one('SELECT seq FROM conversation_messages WHERE id=$1', [sent.id])).seq) - 1), limit: 1 });
    return m;
  },
});

cap({
  name: 'mark_conversation_read', method: 'POST', path: '/conversations/:id/read', tag: TAG, summary: 'Mark a conversation as read up to now (or up to a message with upto_seq). Senders then see read counts.',
  input: z.object({ id, upto_seq: seqNo.optional() }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    if (!access.member) return { ok: true, read: false };
    await markConversationRead(user.id, i.id, i.upto_seq ?? null);
    return { ok: true, read: true };
  },
});

cap({
  name: 'acknowledge_notice', method: 'POST', path: '/conversations/:id/messages/:message_id/acknowledge', tag: TAG,
  summary: 'Confirm you have seen an urgent notice. This stops its escalation to you (a young person\'s guardians are still told).', input: z.object({ id, message_id: id }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    if (!access.member) throw forbidden('Only members can confirm a notice');
    const m = await one('SELECT id, requires_ack, sender_id FROM conversation_messages WHERE id=$1 AND conversation_id=$2 AND hidden_at IS NULL', [i.message_id, i.id]);
    if (!m || !m.requires_ack) throw notFound('Notice');
    await one('INSERT INTO conversation_acks(message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [m.id, user.id]);
    await markConversationRead(user.id, i.id, null);
    return { ok: true };
  },
});

cap({
  name: 'get_message_delivery', method: 'GET', path: '/conversations/:id/messages/:message_id/delivery', tag: TAG,
  summary: 'How a message reached people (senders and organisers only): read and confirmed counts, and per channel (in-app, push, email, WhatsApp, SMS) how many deliveries are queued, sent, delivered, read or failed. Shows counts, never who.',
  input: z.object({ id, message_id: id }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    const m = await one('SELECT id, seq, sender_id, requires_ack FROM conversation_messages WHERE id=$1 AND conversation_id=$2', [i.message_id, i.id]);
    if (!m) throw notFound('Message');
    if (m.sender_id !== user.id && !access.moderator) throw notFound('Message');
    const [reach] = await many(
      `SELECT count(*)::int AS recipients, count(*) FILTER (WHERE last_read_seq >= $2)::int AS read_by FROM conversation_members WHERE conversation_id=$1 AND left_at IS NULL AND user_id<>$3`, [i.id, m.seq, m.sender_id]);
    const acked = (await one('SELECT count(*)::int AS n FROM conversation_acks WHERE message_id=$1', [m.id])).n;
    const channels = await many(
      `SELECT d.channel, d.status, count(*)::int AS n FROM notifications n JOIN notification_deliveries d ON d.notification_id=n.id WHERE n.data->>'message_id' = $1 GROUP BY d.channel, d.status ORDER BY d.channel`, [m.id]);
    const inApp = (await one("SELECT count(*)::int AS n FROM notifications WHERE data->>'message_id' = $1", [m.id])).n;
    return { message_id: m.id, ...reach, ...(m.requires_ack ? { acknowledged: acked } : {}), in_app: inApp, channels };
  },
});

// ---------------------------------------------------------------------------------------------------------------- people and settings
cap({
  name: 'add_conversation_members', method: 'POST', path: '/conversations/:id/members', tag: TAG,
  summary: 'Add people (organisers and moderators only). Everyone must be connected to the conversation\'s team, event, fixture or registration; `everyone: true` adds all of them. A young person needs a verified guardian and current contact consent.',
  input: z.object({ id, user_ids: z.array(id).max(200).default([]), everyone: z.boolean().default(false) }),
  async handler({ user }, i) {
    const { conv, moderator } = await conversationAccess(user, i.id);
    if (conv.kind === 'direct') throw badRequest('A direct conversation has exactly two people');
    if (!moderator) throw forbidden('Only organisers can add people');
    if (conv.archived_at) throw conflict('This conversation is archived');
    const ctx = { team_id: conv.team_id, event_id: conv.event_id, fixture_id: conv.fixture_id, entry_id: conv.entry_id };
    let ids = i.user_ids;
    if (i.everyone) ids = [...ids, ...(conv.event_id ? await eventPeople(conv.event_id) : conv.team_id ? await teamPeople(conv.team_id) : [])];
    for (const uid of new Set(ids)) if (!(await mayJoinContext(ctx, uid))) throw badRequest('Everyone in a conversation must be connected to its team, event, fixture or registration', { user_id: uid });
    await tx((c) => addPeople(c, conv.id, ids, user.id));
    await audit(null, user.id, 'add_conversation_members', 'conversations', conv.id);
    return conversationView(user, conv.id);
  },
});

cap({
  name: 'remove_conversation_member', method: 'DELETE', path: '/conversations/:id/members/:user_id', tag: TAG,
  summary: 'Leave a conversation (yourself) or remove someone (organisers). The person\'s access ends at once; their past messages stay for the record.', input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    if (access.conv.kind === 'direct' && i.user_id !== user.id) throw badRequest('You can leave a direct conversation, not remove the other person');
    if (i.user_id !== user.id && !access.moderator) throw forbidden('Only organisers can remove people');
    const r = await one('UPDATE conversation_members SET left_at=now() WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL RETURNING user_id', [i.id, i.user_id]);
    if (!r) throw notFound('Member');
    if (i.user_id !== user.id) await audit(null, user.id, 'remove_conversation_member', 'conversations', i.id);
    return { ok: true };
  },
});

cap({
  name: 'update_conversation', method: 'PATCH', path: '/conversations/:id', tag: TAG,
  summary: 'Organisers: rename, make announcements-only, set how long it stays active before it is archived (30 days to 10 years), or archive / reopen it. An archived conversation stays readable and searchable but takes no new messages; nothing is ever deleted.',
  input: z.object({ id, title: z.string().trim().min(1).max(80).optional(), announcements_only: z.boolean().optional(), retention_days: z.number().int().min(30).max(3650).optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    if (!access.moderator && !(access.conv.kind === 'direct' && i.archived !== undefined && Object.keys(i).length === 2)) throw forbidden('Only organisers can change a conversation');
    if (access.conv.kind === 'direct' && (i.title || i.announcements_only !== undefined)) throw badRequest('A direct conversation has no title or channel mode');
    await one(
      `UPDATE conversations SET title=coalesce($2,title), announcements_only=coalesce($3,announcements_only), retention_days=coalesce($4,retention_days),
              archived_at=CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN coalesce(archived_at, now()) ELSE NULL END,
              archived_reason=CASE WHEN $5::boolean IS NULL THEN archived_reason WHEN $5 THEN 'manual' ELSE NULL END WHERE id=$1 RETURNING id`,
      [i.id, i.title ?? null, i.announcements_only ?? null, i.retention_days ?? null, i.archived ?? null]);
    await audit(null, user.id, 'update_conversation', 'conversations', i.id);
    return conversationView(user, i.id);
  },
});

cap({
  name: 'mute_conversation', method: 'POST', path: '/conversations/:id/mute', tag: TAG,
  summary: 'Mute or unmute a conversation for yourself: it stays in the inbox with its unread count but sends no push, email or SMS (urgent notices still do).', input: z.object({ id, muted: z.boolean() }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    if (!access.member) throw forbidden('Only members can mute a conversation');
    await one('UPDATE conversation_members SET muted_at=CASE WHEN $3 THEN coalesce(muted_at, now()) ELSE NULL END WHERE conversation_id=$1 AND user_id=$2 RETURNING 1', [i.id, user.id, i.muted]);
    return { ok: true, muted: i.muted };
  },
});

cap({
  name: 'set_user_block', method: 'POST', path: '/me/contact-blocks', tag: TAG,
  summary: 'Stop one person from starting or continuing a direct conversation with you (and lift it again). Group conversations you are both in are unaffected; use moderation there.', input: z.object({ user_id: id, blocked: z.boolean() }),
  async handler({ user }, i) {
    if (i.user_id === user.id) throw badRequest('You cannot block yourself');
    if (!(await one('SELECT 1 FROM users WHERE id=$1', [i.user_id]))) throw notFound('Person');
    await one(`INSERT INTO user_blocks(blocker_id, blocked_id, lifted_at) VALUES ($1,$2, CASE WHEN $3 THEN NULL ELSE now() END)
               ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET lifted_at = CASE WHEN $3 THEN NULL ELSE now() END, created_at = CASE WHEN $3 THEN now() ELSE user_blocks.created_at END RETURNING 1`, [user.id, i.user_id, i.blocked]);
    return { ok: true, blocked: i.blocked };
  },
});

// ---------------------------------------------------------------------------------------------------------------- moderation
cap({
  name: 'hide_conversation_message', method: 'POST', path: '/conversations/:id/messages/:message_id/hide', tag: TAG,
  summary: 'Hide a message (its sender, or an organiser). Everyone then sees a placeholder; the text is kept for the safeguarding record and is never erased.',
  input: z.object({ id, message_id: id, reason: z.enum(['sender', 'abuse', 'harassment', 'unsafe_contact', 'spam', 'privacy', 'other']).default('other') }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    const m = await one('SELECT id, sender_id FROM conversation_messages WHERE id=$1 AND conversation_id=$2', [i.message_id, i.id]);
    if (!m) throw notFound('Message');
    if (m.sender_id !== user.id && !access.moderator) throw forbidden('Only the sender or an organiser can hide a message');
    await one("UPDATE conversation_messages SET hidden_at=coalesce(hidden_at, now()), hidden_by=coalesce(hidden_by,$2), hidden_reason=coalesce(hidden_reason,$3) WHERE id=$1 RETURNING 1", [m.id, user.id, m.sender_id === user.id ? 'sender' : i.reason]);
    if (m.sender_id !== user.id) await audit(null, user.id, 'hide_conversation_message', 'conversation_messages', m.id);
    return { ok: true };
  },
});

cap({
  name: 'report_conversation_message', method: 'POST', path: '/conversations/:id/messages/:message_id/report', tag: TAG, status: 201,
  summary: 'Report a message to the organisers of the conversation (members, and guardians reading a young member\'s conversation). One report per person per message; the note is encrypted. An unsafe-contact report is also copied to the platform safeguarding record.',
  input: z.object({ id, message_id: id, reason: z.enum(['abuse', 'harassment', 'unsafe_contact', 'spam', 'privacy', 'other']), note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    await conversationAccess(user, i.id);
    const m = await one('SELECT id, sender_id FROM conversation_messages WHERE id=$1 AND conversation_id=$2', [i.message_id, i.id]);
    if (!m) throw notFound('Message');
    if (m.sender_id === user.id) throw badRequest('You cannot report your own message');
    const r = await one(
      `INSERT INTO conversation_reports(conversation_id, message_id, reporter_id, reason, note_enc) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (message_id, reporter_id) DO NOTHING RETURNING id, status, created_at`,
      [i.id, m.id, user.id, i.reason, i.note ? encrypt(i.note, NOTE_CTX) : null]);
    if (!r) throw conflict('You have already reported this message');
    if (i.reason === 'unsafe_contact') await audit(null, user.id, 'report_unsafe_contact', 'conversation_messages', m.id);
    return { report_id: r.id, status: r.status, created_at: r.created_at };
  },
});

/** Reports on conversations the person moderates. Candidate rows come from SQL, each conversation is then verified with the same check as everywhere else. */
async function moderatedReports(user, { status, conversationId = null, limit = 50, offset = 0 }) {
  const rows = await many(
    `SELECT r.id AS report_id, r.conversation_id, r.message_id, r.reason, r.note_enc, r.status, r.outcome, r.created_at, r.handled_at, m.body_enc, m.hidden_at, m.seq,
            c.kind, c.title, su.display_name AS sender, su.id AS sender_id, ru.display_name AS reporter
       FROM conversation_reports r JOIN conversations c ON c.id=r.conversation_id JOIN conversation_messages m ON m.id=r.message_id
       JOIN users su ON su.id=m.sender_id JOIN users ru ON ru.id=r.reporter_id
      WHERE r.status=$1 AND ($2::uuid IS NULL OR r.conversation_id=$2)
        AND (EXISTS (SELECT 1 FROM conversation_members x WHERE x.conversation_id=c.id AND x.user_id=$3 AND x.left_at IS NULL AND x.role <> 'member')
             OR c.team_id IS NOT NULL OR c.event_id IS NOT NULL OR c.fixture_id IS NOT NULL OR c.entry_id IS NOT NULL)
      ORDER BY r.created_at DESC LIMIT 400`, [status, conversationId, user.id]);
  const ok = new Map();
  const out = [];
  for (const r of rows) {
    if (!ok.has(r.conversation_id)) ok.set(r.conversation_id, await conversationAccess(user, r.conversation_id).then((a) => a.moderator).catch(() => false));
    if (!ok.get(r.conversation_id)) continue;
    out.push(r);
  }
  const page_ = out.slice(offset, offset + limit);
  for (const r of page_) await audit(null, user.id, 'read_conversation_report', 'conversation_reports', r.report_id);
  return page_.map((r) => ({
    report_id: r.report_id, conversation_id: r.conversation_id, conversation: r.kind === 'direct' ? 'Direct message' : r.title, message_id: r.message_id, reason: r.reason,
    note: r.note_enc ? decrypt(r.note_enc, NOTE_CTX) : null, status: r.status, outcome: r.outcome, created_at: r.created_at, handled_at: r.handled_at,
    message: { sender: r.sender, sender_id: r.sender_id, hidden: !!r.hidden_at, body: openBody(r.body_enc) }, reporter: r.reporter,
  }));
}

cap({
  name: 'list_moderation_reports', method: 'GET', path: '/moderation/reports', tag: TAG,
  summary: 'Open (or actioned / dismissed) reports on conversations you organise or run (your team, event, fixture or registration). Shows the reported message and the reporter\'s note; each read is audit-logged.',
  input: z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open'), conversation_id: id.optional(), ...page }),
  async handler({ user }, i) { return { reports: await moderatedReports(user, { status: i.status, conversationId: i.conversation_id ?? null, limit: i.limit, offset: i.offset }) }; },
});

cap({
  name: 'resolve_moderation_report', method: 'POST', path: '/moderation/reports/:report_id/resolve', tag: TAG,
  summary: 'Close a report: hide the message, silence its sender for a while (silence_minutes, up to 30 days), or dismiss it. Hiding and silencing are recorded with who did them; nothing is deleted.',
  input: z.object({ report_id: id, outcome: z.enum(['hidden', 'silenced', 'dismissed']), silence_minutes: z.number().int().min(5).max(43200).optional() }),
  async handler({ user }, i) {
    const rep = await one('SELECT r.*, m.sender_id FROM conversation_reports r JOIN conversation_messages m ON m.id=r.message_id WHERE r.id=$1', [i.report_id]);
    if (!rep) throw notFound('Report');
    const access = await conversationAccess(user, rep.conversation_id).catch(() => null);
    if (!access?.moderator) throw notFound('Report');
    if (rep.status !== 'open') throw conflict('This report is already closed');
    if (i.outcome === 'silenced' && !i.silence_minutes) throw badRequest('Say how long (silence_minutes)');
    await tx(async (c) => {
      if (i.outcome === 'hidden' || i.outcome === 'silenced') await c.query("UPDATE conversation_messages SET hidden_at=coalesce(hidden_at, now()), hidden_by=coalesce(hidden_by,$2), hidden_reason=coalesce(hidden_reason,$3) WHERE id=$1", [rep.message_id, user.id, rep.reason]);
      if (i.outcome === 'silenced' && rep.sender_id !== user.id) await c.query("UPDATE conversation_members SET silenced_until=now() + make_interval(mins => $3), silenced_by=$4 WHERE conversation_id=$1 AND user_id=$2", [rep.conversation_id, rep.sender_id, i.silence_minutes, user.id]);
      await c.query("UPDATE conversation_reports SET status=CASE WHEN $2='dismissed' THEN 'dismissed' ELSE 'actioned' END, outcome=$2, handled_by=$3, handled_at=now() WHERE id=$1", [rep.id, i.outcome, user.id]);
      await audit(c, user.id, `resolve_report_${i.outcome}`, 'conversation_reports', rep.id);
    });
    return { ok: true, outcome: i.outcome };
  },
});

cap({
  name: 'silence_conversation_member', method: 'POST', path: '/conversations/:id/members/:user_id/silence', tag: TAG,
  summary: 'Stop a member from posting for a while, or lift it (minutes: null). Organisers only; they read it back in the member list.', input: z.object({ id, user_id: id, minutes: z.number().int().min(5).max(43200).nullable() }),
  async handler({ user }, i) {
    const access = await conversationAccess(user, i.id);
    if (!access.moderator) throw forbidden('Only organisers can silence a member');
    if (i.user_id === user.id) throw badRequest('You cannot silence yourself');
    const r = await one(
      `UPDATE conversation_members SET silenced_until=CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END, silenced_by=$4 WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL RETURNING user_id`,
      [i.id, i.user_id, i.minutes, user.id]);
    if (!r) throw notFound('Member');
    await audit(null, user.id, i.minutes ? 'silence_conversation_member' : 'unsilence_conversation_member', 'conversations', i.id);
    return { ok: true };
  },
});
