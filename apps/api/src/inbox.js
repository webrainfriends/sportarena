// Unified Inbox core (issue #594), shared by the capabilities (REST / OpenAPI / MCP), the attachment routes and the worker sweeps.
// One inbox lists team chats (team_messages, unchanged), notifications and the conversations added here: direct, group, event channel and
// threads linked to a team / event / fixture / registration. Who may see or post is decided here from live membership, guardian links and
// safeguarding obligations on every call; a person who is not allowed learns nothing (404, never 403). Message text is encrypted at rest.
import { many, one, pool, tx } from './db.js';
import { conflict, forbidden, notFound } from './errors.js';
import { decrypt, encrypt } from './crypto.js';
import { PUBLIC_USER } from './helpers.js';
import { notify } from './notify.js';
import { YOUTH_SQL, guardiansOf, isYouth, requireConsent } from './youth.js';
import { assertMayMessageYouth } from './compliance.js';
import { canManageTeam } from './capabilities/teams.js';

export const BODY_CTX = 'conversation_messages.body';
export const NOTE_CTX = 'conversation_reports.note';
export const DEFAULT_ESCALATION_MINUTES = 30;
const GUARDIAN_LINK = `l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())`;

// the text is prefixed so an attachment-only message (empty text) still has a sealed body
export const sealBody = (text) => encrypt(`t:${text}`, BODY_CTX);
export const openBody = (enc) => decrypt(enc, BODY_CTX).slice(2);
export const preview = (enc, n = 90) => { const t = openBody(enc).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ---------------------------------------------------------------------------------------------------------------- who may do what
/** Is `userId` a verified guardian of a young person who is a live member of this conversation? (read-only visibility, ends when the link does) */
export const guardsMemberOf = async (userId, conversationId, db = pool) => !!(await db.query(
  `SELECT 1 FROM conversation_members m JOIN users u ON u.id=m.user_id JOIN guardian_links l ON l.child_id=m.user_id
    WHERE m.conversation_id=$1 AND m.left_at IS NULL AND l.guardian_id=$2 AND ${GUARDIAN_LINK} AND ${YOUTH_SQL} LIMIT 1`, [conversationId, userId])).rowCount;

/** Does `user` run the thing the conversation is about (its team, event, fixture or registration)? Such a person moderates it even if not a member. */
export async function runsContext(user, conv) {
  if (conv.team_id) { const t = await one('SELECT * FROM teams WHERE id=$1', [conv.team_id]); if (t && await canManageTeam(user, t)) return true; }
  const eventId = conv.event_id ?? (conv.fixture_id ? (await one('SELECT event_id FROM fixtures WHERE id=$1', [conv.fixture_id]))?.event_id : null)
    ?? (conv.entry_id ? (await one('SELECT event_id FROM event_entries WHERE id=$1', [conv.entry_id]))?.event_id : null);
  if (eventId && await one('SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2', [eventId, user.id])) return true;
  return false;
}

/**
 * What `user` is to a conversation. Throws 404 for anyone with no standing (an outsider cannot tell it exists).
 * member = live member; guardian = read-only through a young member; moderator = owner / moderator role, or runs the team / event it is about.
 */
export async function conversationAccess(user, conversationId, { write = false } = {}) {
  const conv = /^[0-9a-f-]{36}$/.test(String(conversationId)) ? await one('SELECT * FROM conversations WHERE id=$1', [conversationId]) : null;
  if (!conv) throw notFound('Conversation');
  const mem = await one('SELECT * FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL', [conv.id, user.id]);
  const guardian = !mem && await guardsMemberOf(user.id, conv.id);
  const moderator = (!!mem && mem.role !== 'member') || await runsContext(user, conv);
  if (!mem && !guardian && !moderator) throw notFound('Conversation');
  const silenced = !!mem?.silenced_until && new Date(mem.silenced_until) > new Date();
  const canPost = !!mem && !silenced && !conv.archived_at && (!conv.announcements_only || moderator);
  if (write && !canPost) {
    if (conv.archived_at) throw conflict('This conversation is archived and read-only');
    if (silenced) throw forbidden('You cannot post here right now');
    throw forbidden(guardian ? 'Guardians can read this conversation but not post in it' : conv.announcements_only ? 'Only organisers can post in this channel' : 'Only members can post here');
  }
  return { conv, member: mem, guardian, moderator, canPost, silenced };
}

const sharedTeam = (a, b) => one(
  `SELECT 1 FROM team_members x JOIN team_members y ON y.team_id=x.team_id WHERE x.user_id=$1 AND y.user_id=$2 AND x.status='active' AND y.status='active' LIMIT 1`, [a, b]);
const sharedOrganisation = (a, b) => one(
  `SELECT 1 FROM organisation_members x JOIN organisation_members y ON y.organisation_id=x.organisation_id WHERE x.user_id=$1 AND y.user_id=$2 AND x.status='active' AND y.status='active' LIMIT 1`, [a, b]);
const sharedEvent = (a, b) => one(
  `WITH ppl AS (SELECT event_id, user_id FROM event_staff WHERE status='accepted'
                 UNION SELECT id, organizer_id FROM events
                 UNION SELECT e.event_id, e.user_id FROM event_entries e WHERE e.user_id IS NOT NULL AND e.status IN ('pending','accepted')
                 UNION SELECT e.event_id, m.user_id FROM event_entries e JOIN team_members m ON m.team_id=e.team_id AND m.status='active' WHERE e.status IN ('pending','accepted'))
   SELECT 1 FROM ppl x JOIN ppl y ON y.event_id=x.event_id WHERE x.user_id=$1 AND y.user_id=$2 LIMIT 1`, [a, b]);
const guardianOf = (a, b) => one(
  `SELECT 1 FROM guardian_links l WHERE ((l.guardian_id=$1 AND l.child_id=$2) OR (l.guardian_id=$2 AND l.child_id=$1)) AND ${GUARDIAN_LINK} LIMIT 1`, [a, b]);

/** Two people may start a direct conversation only when the platform already connects them (a team, an organisation, an event, a guardian link). No cold messages. */
export const sharesContext = async (a, b) => !!((await sharedTeam(a, b)) || (await guardianOf(a, b)) || (await sharedOrganisation(a, b)) || (await sharedEvent(a, b)));

export const isBlocked = async (a, b) => !!(await one(
  'SELECT 1 FROM user_blocks WHERE lifted_at IS NULL AND ((blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))', [a, b]));

/**
 * Youth safeguarding for contact between two people (server-side, every send): two young people never message each other directly; an adult
 * needs a current guardian consent for contact, the compliance obligations that block youth contact met, and the young person needs a live
 * guardian (who then sees the conversation).
 */
export async function assertMayContact(senderId, otherId, db = pool) {
  const [sy, oy] = [await isYouth(senderId, db), await isYouth(otherId, db)];
  if (sy && oy) throw forbidden('Young people cannot start direct conversations with each other');
  if (!sy && !oy) return;
  const child = sy ? senderId : otherId, adult = sy ? otherId : senderId;
  if (!(await guardiansOf(child, db)).length) throw conflict('A young person needs a verified guardian before direct messages can start', { code: 'guardian_required' });
  await requireConsent(child, 'contact', 'direct messages', db);
  await assertMayMessageYouth(db, adult, child);
}

/** In a group, an adult poster must clear the youth-contact gate for every young member (the guardian-consent and compliance rules are the same as for direct messages). */
export async function assertMayPostHere(senderId, convId, db = pool) {
  if (await isYouth(senderId, db)) { await requireConsent(senderId, 'contact', 'messaging', db); return; }
  const kids = (await db.query(`SELECT m.user_id FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND m.left_at IS NULL AND ${YOUTH_SQL} LIMIT 200`, [convId])).rows;
  for (const k of kids) await assertMayMessageYouth(db, senderId, k.user_id);
}

// ---------------------------------------------------------------------------------------------------------------- people in a context
/** Everyone the platform connects to an event: organiser, accepted crew, entered players and the active members of entered teams. */
export async function eventPeople(eventId) {
  return (await many(
    `SELECT DISTINCT user_id FROM (
       SELECT organizer_id AS user_id FROM events WHERE id=$1
       UNION SELECT user_id FROM event_staff WHERE event_id=$1 AND status='accepted'
       UNION SELECT user_id FROM event_entries WHERE event_id=$1 AND user_id IS NOT NULL AND status IN ('pending','accepted')
       UNION SELECT m.user_id FROM event_entries e JOIN team_members m ON m.team_id=e.team_id AND m.status='active' WHERE e.event_id=$1 AND e.status IN ('pending','accepted')) p`, [eventId])).map((r) => r.user_id);
}
export const teamPeople = async (teamId) => (await many("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' UNION SELECT owner_id FROM teams WHERE id=$1", [teamId])).map((r) => r.user_id);

/** May this person be added to a conversation about this context? (so a thread can never pull in someone unconnected to it) */
export async function mayJoinContext(ctx, userId) {
  if (ctx.team_id && (await teamPeople(ctx.team_id)).includes(userId)) return true;
  const eventId = ctx.event_id ?? (ctx.fixture_id ? (await one('SELECT event_id FROM fixtures WHERE id=$1', [ctx.fixture_id]))?.event_id : null)
    ?? (ctx.entry_id ? (await one('SELECT event_id FROM event_entries WHERE id=$1', [ctx.entry_id]))?.event_id : null);
  if (eventId && (await eventPeople(eventId)).includes(userId)) return true;
  return false;
}

export async function contextOrganisation(ctx) {
  if (ctx.team_id) return (await one('SELECT organisation_id FROM teams WHERE id=$1', [ctx.team_id]))?.organisation_id ?? null;
  const eventId = ctx.event_id ?? (ctx.fixture_id ? (await one('SELECT event_id FROM fixtures WHERE id=$1', [ctx.fixture_id]))?.event_id : null)
    ?? (ctx.entry_id ? (await one('SELECT event_id FROM event_entries WHERE id=$1', [ctx.entry_id]))?.event_id : null);
  return eventId ? (await one('SELECT organisation_id FROM events WHERE id=$1', [eventId]))?.organisation_id ?? null : null;
}

// ---------------------------------------------------------------------------------------------------------------- sending
const NOTIFY_KIND = { text: 'conversation_message', announcement: 'conversation_announcement' };

/** Live recipients of a message: the other members, plus the verified guardians of the young members (as themselves, never as the child). */
export async function recipientsOf(c, convId, senderId) {
  const members = (await c.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND left_at IS NULL AND user_id<>$2', [convId, senderId])).rows.map((r) => r.user_id);
  const guardians = (await c.query(
    `SELECT DISTINCT l.guardian_id AS user_id FROM conversation_members m JOIN users u ON u.id=m.user_id JOIN guardian_links l ON l.child_id=m.user_id
      WHERE m.conversation_id=$1 AND m.left_at IS NULL AND ${GUARDIAN_LINK} AND ${YOUTH_SQL}`, [convId])).rows.map((r) => r.user_id);
  return { members, guardians: guardians.filter((g) => g !== senderId && !members.includes(g)) };
}

export async function postMessage(user, access, i) {
  const { conv } = access;
  await assertMayPostHere(user.id, conv.id);
  if (conv.kind === 'direct') {
    const other = (await one('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id<>$2 AND left_at IS NULL', [conv.id, user.id]))?.user_id;
    if (!other) throw conflict('The other person has left this conversation');
    if (await isBlocked(user.id, other)) throw forbidden('You cannot message this person');
    await assertMayContact(user.id, other);
  }
  if ((i.announcement || i.requires_ack) && !access.moderator) throw forbidden('Only organisers and managers can post announcements and urgent notices');
  if (i.client_id) {
    const prior = await one('SELECT id FROM conversation_messages WHERE conversation_id=$1 AND sender_id=$2 AND client_id=$3', [conv.id, user.id, i.client_id]);
    if (prior) return { id: prior.id, duplicate: true };
  }
  if (i.reply_to_id && !(await one('SELECT 1 FROM conversation_messages WHERE id=$1 AND conversation_id=$2 AND hidden_at IS NULL', [i.reply_to_id, conv.id]))) throw notFound('Message to reply to');
  if (i.attachment_id) {
    const a = await one('SELECT * FROM conversation_attachments WHERE id=$1 AND conversation_id=$2 AND removed_at IS NULL', [i.attachment_id, conv.id]);
    if (!a || a.uploader_id !== user.id) throw notFound('Attachment');
    if (await one('SELECT 1 FROM conversation_messages WHERE attachment_id=$1', [i.attachment_id])) throw conflict('That attachment is already on a message');
  }
  const kind = i.announcement || i.requires_ack ? 'announcement' : 'text';
  const delay = i.requires_ack ? (i.escalate_after_minutes ?? DEFAULT_ESCALATION_MINUTES) : null;
  return tx(async (c) => {
    const seq = (await c.query('UPDATE conversations SET last_seq=last_seq+1, last_message_at=now() WHERE id=$1 RETURNING last_seq', [conv.id])).rows[0].last_seq;
    const m = (await c.query(
      `INSERT INTO conversation_messages(conversation_id, seq, sender_id, body_enc, kind, requires_ack, escalate_after_minutes, reply_to_id, attachment_id, client_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, seq`,
      [conv.id, seq, user.id, sealBody(i.body ?? ''), kind, !!i.requires_ack, delay, i.reply_to_id ?? null, i.attachment_id ?? null, i.client_id ?? null])).rows[0];
    await c.query('UPDATE conversation_members SET last_read_seq=greatest(last_read_seq,$3) WHERE conversation_id=$1 AND user_id=$2', [conv.id, user.id, seq]);
    const { members, guardians } = await recipientsOf(c, conv.id, user.id);
    const muted = new Set((await c.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND muted_at IS NOT NULL', [conv.id])).rows.map((r) => r.user_id));
    const sender = (await c.query('SELECT display_name FROM users WHERE id=$1', [user.id])).rows[0].display_name;
    const title = conv.kind === 'direct' ? `${sender} sent you a message` : `${sender} in ${conv.title ?? 'a conversation'}`;
    // Notifications never carry the text: email and push leave the platform in clear, so they only say that something is waiting.
    const data = { conversation_id: conv.id, message_id: m.id, ...(conv.team_id ? { team_id: conv.team_id } : {}), ...(conv.event_id ? { event_id: conv.event_id } : {}) };
    for (const uid of [...members, ...guardians]) {
      if (muted.has(uid) && !i.requires_ack) continue;
      await notify(c, uid, {
        kind: NOTIFY_KIND[kind], title, urgent: !!i.requires_ack, dedupe_key: `conv:${m.id}:${uid}`,
        body: i.requires_ack ? 'Urgent notice. Open the inbox and confirm you have seen it.' : kind === 'announcement' ? 'New announcement. Open the inbox to read it.' : 'Open the inbox to read it.',
        data: { ...data, ...(guardians.includes(uid) ? { guardian_copy: true } : {}) },
      });
    }
    return { id: m.id, seq: m.seq, duplicate: false };
  });
}

// ---------------------------------------------------------------------------------------------------------------- reading
/** Messages as the viewer may see them, oldest first. Hidden messages show as a placeholder with the reason class, never their text. */
export async function readMessages(user, access, { afterSeq = 0, limit = 50, beforeSeq = null } = {}) {
  const { conv, moderator } = access;
  const rows = await many(
    `SELECT m.id AS message_id, m.seq, m.kind, m.body_enc, m.requires_ack, m.reply_to_id, m.attachment_id, m.created_at, m.hidden_at, (m.sender_id=$2) AS mine, ${PUBLIC_USER}
       FROM conversation_messages m JOIN users u ON u.id=m.sender_id
      WHERE m.conversation_id=$1 AND m.seq > $3 AND ($5::bigint IS NULL OR m.seq < $5)
      ORDER BY ${beforeSeq ? 'm.seq DESC' : 'm.seq ASC'} LIMIT $4`, [conv.id, user.id, afterSeq, Math.min(limit, 200), beforeSeq]);
  if (beforeSeq) rows.reverse();
  const ids = rows.map((r) => r.message_id);
  const [acks, reads, att, replies, mineAcked] = ids.length ? await Promise.all([
    many('SELECT message_id, count(*)::int AS n FROM conversation_acks WHERE message_id = ANY($1) GROUP BY message_id', [ids]),
    many(`SELECT m.id AS message_id, (SELECT count(*)::int FROM conversation_members r WHERE r.conversation_id=m.conversation_id AND r.user_id<>m.sender_id AND r.left_at IS NULL AND r.last_read_seq >= m.seq) AS read_by,
                 (SELECT count(*)::int FROM conversation_members r WHERE r.conversation_id=m.conversation_id AND r.user_id<>m.sender_id AND r.left_at IS NULL) AS recipients
            FROM conversation_messages m WHERE m.id = ANY($1)`, [ids]),
    many('SELECT id, kind, name, content_type, size_bytes FROM conversation_attachments WHERE id = ANY($1) AND removed_at IS NULL', [rows.map((r) => r.attachment_id).filter(Boolean)]),
    many('SELECT m.id, m.hidden_at, m.body_enc, u.display_name FROM conversation_messages m JOIN users u ON u.id=m.sender_id WHERE m.id = ANY($1)', [rows.map((r) => r.reply_to_id).filter(Boolean)]),
    many('SELECT message_id FROM conversation_acks WHERE message_id = ANY($1) AND user_id=$2', [ids, user.id]),
  ]) : [[], [], [], [], []];
  const by = (list, k) => new Map(list.map((x) => [x[k], x]));
  const A = by(acks, 'message_id'), R = by(reads, 'message_id'), F = by(att, 'id'), P = by(replies, 'id'), mine = new Set(mineAcked.map((x) => x.message_id));
  return rows.map((r) => {
    const hidden = !!r.hidden_at;
    const rep = r.reply_to_id ? P.get(r.reply_to_id) : null;
    const a = r.attachment_id ? F.get(r.attachment_id) : null;
    return {
      message_id: r.message_id, seq: Number(r.seq), kind: r.kind, created_at: r.created_at, mine: r.mine,
      body: hidden ? null : openBody(r.body_enc), hidden,
      sender: { id: r.id, handle: r.handle, display_name: r.display_name, roles: r.roles, avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color, avatar_url: r.avatar_url },
      reply_to: rep ? { message_id: r.reply_to_id, display_name: rep.display_name, body: rep.hidden_at ? null : preview(rep.body_enc, 120) } : null,
      attachment: !hidden && a ? { ...a, url: `/api/v1/conversation-attachments/${a.id}` } : null,
      // the sender and moderators see how far a message reached; everyone else sees only their own part
      delivery: r.mine || moderator ? { read_by: R.get(r.message_id)?.read_by ?? 0, recipients: R.get(r.message_id)?.recipients ?? 0 } : null,
      notice: r.requires_ack ? { acknowledged_by_me: mine.has(r.message_id) || r.mine, ...(r.mine || moderator ? { acknowledged: A.get(r.message_id)?.n ?? 0 } : {}) } : null,
    };
  });
}

export async function markConversationRead(userId, convId, seq = null) {
  await one(`UPDATE conversation_members SET last_read_seq=greatest(last_read_seq, coalesce($3, (SELECT last_seq FROM conversations WHERE id=$1))) WHERE conversation_id=$1 AND user_id=$2 RETURNING 1`, [convId, userId, seq]);
}

// ---------------------------------------------------------------------------------------------------------------- sweeps (worker)
/**
 * Unacknowledged urgent notices: after each person's own delay (their setting, else the notice's, else 30 minutes) the notice is pushed again as an
 * urgent notification that may use WhatsApp / SMS. A young person's guardians are told at the same moment whatever the young person chose.
 * One row per (notice, person) in conversation_escalations makes it safe to run on several instances and to repeat.
 */
export async function escalateUnacknowledged({ limit = 200 } = {}) {
  const due = await many(
    `SELECT m.id AS message_id, m.conversation_id, r.user_id, k.title, (SELECT display_name FROM users s WHERE s.id=m.sender_id) AS sender,
            coalesce(p.escalation_off, false) AS off, ${YOUTH_SQL.replaceAll('u.', 'ru.')} AS youth
       FROM conversation_messages m JOIN conversations k ON k.id=m.conversation_id
       JOIN conversation_members r ON r.conversation_id=m.conversation_id AND r.left_at IS NULL AND r.user_id<>m.sender_id
       JOIN users ru ON ru.id=r.user_id
       LEFT JOIN notification_prefs p ON p.user_id=r.user_id
      WHERE m.requires_ack AND m.hidden_at IS NULL AND m.created_at > now() - interval '3 days'
        AND m.created_at + make_interval(mins => coalesce(p.escalate_after_minutes, m.escalate_after_minutes, ${DEFAULT_ESCALATION_MINUTES})) <= now()
        AND NOT EXISTS (SELECT 1 FROM conversation_acks a WHERE a.message_id=m.id AND a.user_id=r.user_id)
        AND NOT EXISTS (SELECT 1 FROM conversation_escalations e WHERE e.message_id=m.id AND e.user_id=r.user_id)
      ORDER BY m.created_at LIMIT $1`, [limit]);
  let n = 0;
  for (const d of due) {
    await tx(async (c) => {
      const claimed = (await c.query('INSERT INTO conversation_escalations(message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [d.message_id, d.user_id])).rowCount;
      if (!claimed) return;
      const data = { conversation_id: d.conversation_id, message_id: d.message_id };
      const body = 'An urgent notice is still waiting for you. Open the inbox and confirm you have seen it.';
      if (!d.off && !d.youth) { n++; await notify(c, d.user_id, { kind: 'conversation_escalation', title: `Urgent: ${d.title ?? 'notice'} needs your confirmation`, body, urgent: true, comm: { essential: true }, dedupe_key: `conv-esc:${d.message_id}:${d.user_id}`, data }); }
      if (d.youth) for (const g of await guardiansOf(d.user_id, c)) { n++; await notify(c, g, { kind: 'conversation_escalation', title: `Urgent notice for your child is unconfirmed`, body, urgent: true, comm: { essential: true }, dedupe_key: `conv-esc:${d.message_id}:g:${g}`, data: { ...data, guardian_copy: true } }); }
    });
  }
  return n;
}

/**
 * Retention: a conversation with no activity for its retention period becomes read-only and moves to Archived. Nothing is deleted; a moderator can
 * reopen it. A conversation about a live (not completed / cancelled) event is never archived by this sweep.
 */
export async function archiveStaleConversations({ limit = 500 } = {}) {
  const r = await one(
    `WITH due AS (
       SELECT c.id FROM conversations c LEFT JOIN events e ON e.id = coalesce(c.event_id, (SELECT event_id FROM fixtures WHERE id=c.fixture_id), (SELECT event_id FROM event_entries WHERE id=c.entry_id))
        WHERE c.archived_at IS NULL AND coalesce(c.last_message_at, c.created_at) < now() - make_interval(days => c.retention_days)
          AND (e.id IS NULL OR e.status IN ('completed','cancelled')) ORDER BY c.created_at LIMIT $1 FOR UPDATE OF c SKIP LOCKED),
     up AS (UPDATE conversations c SET archived_at=now(), archived_reason='retention' FROM due WHERE c.id=due.id RETURNING 1)
     SELECT count(*)::int AS n FROM up`, [limit]);
  return r.n;
}
