// R20: Officiating Crew Communication Center (#1012)
// Private, assignment-scoped 2-way communication for crew and organisers.
// Threads are time-bound to the assignment lifecycle; access expires 2h post-match by default.
// All personal free-text is encrypted (body_enc). Read receipts, pre-match briefings, emergency
// notices, handover threads, roster-change messages, document sharing, and moderation are here.
// No finance tables are created — the platform ledger is reused throughout.
// MCP-enabled via the cap() registry (identical REST+OpenAPI+MCP surface from one definition).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, query } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encryptField, decryptField } from '../crypto.js';
import { notify } from '../notify.js';
import { audit } from '../helpers.js';

const TAG = 'Officials';

// ── Thread type enum ─────────────────────────────────────────────────────────
const THREAD_TYPES = ['general', 'briefing', 'emergency', 'handover', 'roster_change'];
const threadType = z.enum(THREAD_TYPES);

const MSG_TYPES = ['text', 'attachment', 'emergency', 'roster_change', 'handover', 'system'];
const msgType = z.enum(MSG_TYPES);

const DOC_CATEGORIES = ['rules', 'permit', 'form', 'manual', 'other'];
const FLAG_REASONS = ['inappropriate_conduct', 'misinformation', 'personal_data_disclosed', 'other'];

// ── Access helpers ────────────────────────────────────────────────────────────

/** Resolve fixture + event and assert the caller is the organiser or an accepted official. */
async function assertCrewAccess(c, fixtureId, userId) {
  const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [fixtureId])).rows[0];
  if (!f) throw notFound('Fixture');
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
  if (!ev) throw notFound('Event');
  const isOrg = ev.organizer_id === userId;
  if (!isOrg) {
    const accepted = (await c.query(
      "SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status='accepted'",
      [fixtureId, userId],
    )).rowCount;
    if (!accepted) throw forbidden('Only the organiser or an accepted official may access crew comms');
  }
  return { f, ev, isOrg };
}

/** Assert the caller is a participant (or organiser) of the given thread. */
async function assertThreadAccess(c, threadId, userId) {
  const th = (await c.query('SELECT * FROM crew_threads WHERE id=$1', [threadId])).rows[0];
  if (!th) throw notFound('Thread');
  const { f, ev, isOrg } = await assertCrewAccess(c, th.fixture_id, userId);

  // Check thread-level access expiry
  const expiresAt = th.access_expires_at
    ?? (f.ends_at ? new Date(new Date(f.ends_at).getTime() + 2 * 60 * 60 * 1000) : null);
  if (expiresAt && new Date() > expiresAt) throw forbidden('This crew thread has expired');

  if (!isOrg) {
    const inThread = (await c.query(
      'SELECT 1 FROM crew_thread_participants WHERE thread_id=$1 AND user_id=$2 AND removed_at IS NULL',
      [threadId, userId],
    )).rowCount;
    if (!inThread) throw forbidden('You are not a participant in this thread');
  }
  return { th, f, ev, isOrg };
}

/** Resolve and decrypt a single message row for the response. */
async function formatMessage(row, userId) {
  const body = row.body ?? (row.body_enc ? await decryptField(row.body_enc) : '');
  return {
    id: row.id,
    thread_id: row.thread_id,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    sender_avatar: row.sender_avatar,
    body,
    msg_type: row.msg_type,
    priority: row.priority,
    reply_to_id: row.reply_to_id,
    attachments: row.attachments ?? [],
    read_by: row.read_by ?? [],
    read_count: row.read_count ?? 0,
    is_read: !!(row.read_by ?? []).find((r) => r.user_id === userId),
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    seq: row.seq,
  };
}

async function fetchThreadMessages(threadId, userId, { afterSeq, beforeSeq, limit = 40, order = 'DESC' } = {}) {
  const conds = ['m.thread_id=$1', 'm.deleted_at IS NULL'];
  const params = [threadId];
  if (afterSeq != null) { params.push(afterSeq); conds.push(`m.seq > $${params.length}`); }
  if (beforeSeq != null) { params.push(beforeSeq); conds.push(`m.seq < $${params.length}`); }
  params.push(limit);
  const rows = (await query(
    `SELECT m.*,
            u.name AS sender_name, u.avatar_url AS sender_avatar,
            coalesce(json_agg(DISTINCT jsonb_build_object('user_id', r.user_id, 'read_at', r.read_at))
              FILTER (WHERE r.user_id IS NOT NULL), '[]') AS read_by,
            count(DISTINCT r.user_id)::int AS read_count,
            coalesce(
              json_agg(DISTINCT jsonb_build_object(
                'id', att.id, 'filename', att.filename, 'mime_type', att.mime_type,
                'file_size_bytes', att.file_size_bytes
              )) FILTER (WHERE att.id IS NOT NULL), '[]'
            ) AS attachments
       FROM crew_messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN crew_message_reads r ON r.message_id = m.id
       LEFT JOIN crew_message_attachments att ON att.message_id = m.id AND att.removed_at IS NULL
      WHERE ${conds.join(' AND ')}
      GROUP BY m.id, u.name, u.avatar_url
      ORDER BY m.seq ${order}
      LIMIT $${params.length}`,
    params,
  )).rows;
  return Promise.all(rows.map((r) => formatMessage(r, userId)));
}

async function markThreadRead(threadId, userId) {
  await query(
    `INSERT INTO crew_thread_reads(thread_id, user_id, last_read_at) VALUES ($1,$2,now())
     ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at=now()`,
    [threadId, userId],
  );
}

// ── Capability: list crew threads ────────────────────────────────────────────

cap({
  name: 'list_crew_threads',
  method: 'GET',
  path: '/fixtures/:id/crew-threads',
  tag: TAG,
  summary: 'List all communication threads for a fixture (crew and organiser). Returns each thread with its latest message, unread count and participant summary. Archived threads are excluded by default.',
  input: z.object({
    id,
    include_archived: z.coerce.boolean().default(false),
    type: threadType.optional(),
  }),
  async handler({ user }, i) {
    const rows = await tx(async (c) => {
      await assertCrewAccess(c, i.id, user.id);
      const conds = ['th.fixture_id=$1'];
      const params = [i.id];
      if (!i.include_archived) conds.push('th.archived_at IS NULL');
      if (i.type) { params.push(i.type); conds.push(`th.type=$${params.length}`); }
      return (await c.query(
        `SELECT th.*,
                creator.name AS created_by_name,
                count(DISTINCT tp.user_id) FILTER (WHERE tp.removed_at IS NULL)::int AS participant_count,
                lm.id AS last_msg_id,
                lm.created_at AS last_msg_at,
                lm.msg_type AS last_msg_type,
                lu.name AS last_msg_sender,
                -- unread count for the calling user
                count(DISTINCT um.id) FILTER (
                  WHERE um.sender_id <> $2
                    AND um.deleted_at IS NULL
                    AND um.created_at > coalesce(tr.last_read_at, '-infinity'::timestamptz)
                )::int AS unread_count
           FROM crew_threads th
           JOIN users creator ON creator.id = th.created_by
           LEFT JOIN crew_thread_participants tp ON tp.thread_id = th.id
           LEFT JOIN LATERAL (
             SELECT m.id, m.created_at, m.msg_type, m.sender_id
               FROM crew_messages m
              WHERE m.thread_id = th.id AND m.deleted_at IS NULL
              ORDER BY m.seq DESC LIMIT 1
           ) lm ON true
           LEFT JOIN users lu ON lu.id = lm.sender_id
           LEFT JOIN crew_messages um ON um.thread_id = th.id
           LEFT JOIN crew_thread_reads tr ON tr.thread_id = th.id AND tr.user_id = $2
          WHERE ${conds.join(' AND ')}
          GROUP BY th.id, creator.name, lm.id, lm.created_at, lm.msg_type, lu.name, tr.last_read_at
          ORDER BY th.priority DESC, coalesce(lm.created_at, th.created_at) DESC`,
        [i.id, user.id, ...params.slice(1)],
      )).rows;
    });
    return rows;
  },
});

// ── Capability: create crew thread ───────────────────────────────────────────

cap({
  name: 'create_crew_thread',
  method: 'POST',
  path: '/fixtures/:id/crew-threads',
  tag: TAG,
  status: 201,
  summary: 'Create a new communication thread for the crew. Types: general, briefing (requires acknowledgement from participants), emergency (priority alert), handover (structured match notes), roster_change. Participants default to the full accepted crew plus the organiser. Access expires 2h after the fixture ends unless overridden.',
  input: z.object({
    id,
    type: threadType.default('general'),
    title: z.string().trim().min(1).max(200),
    participant_ids: z.array(id).min(1).max(50).optional(),
    access_expires_at: z.string().datetime({ offset: true }).optional(),
    assignment_id: id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { f, ev } = await assertCrewAccess(c, i.id, user.id);

      if (i.access_expires_at && new Date(i.access_expires_at) <= new Date()) {
        throw badRequest('access_expires_at must be in the future');
      }

      // Build participant list: supplied list, or full accepted crew + organiser
      let participantIds = i.participant_ids ?? [];
      if (!participantIds.length) {
        const crew = (await c.query(
          "SELECT user_id FROM fixture_officials WHERE fixture_id=$1 AND status='accepted'", [i.id],
        )).rows.map((r) => r.user_id);
        participantIds = [...new Set([...crew, ev.organizer_id, user.id])];
      } else {
        // Validate all supplied IDs are either the organiser or an accepted official
        const accepted = (await c.query(
          "SELECT user_id FROM fixture_officials WHERE fixture_id=$1 AND status='accepted'", [i.id],
        )).rows.map((r) => r.user_id);
        const allowed = new Set([...accepted, ev.organizer_id]);
        for (const pid of participantIds) {
          if (!allowed.has(pid)) throw badRequest(`User ${pid} is not an accepted official or organiser for this fixture`);
        }
        if (!participantIds.includes(user.id)) participantIds.push(user.id);
      }

      const priority = i.type === 'emergency' ? 100 : i.type === 'handover' ? 50 : 0;

      const th = (await c.query(
        `INSERT INTO crew_threads(fixture_id, event_id, assignment_id, type, priority, title, created_by, access_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [i.id, ev.id, i.assignment_id ?? null, i.type, priority, i.title, user.id, i.access_expires_at ?? null],
      )).rows[0];

      for (const pid of participantIds) {
        await c.query(
          'INSERT INTO crew_thread_participants(thread_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [th.id, pid, user.id],
        );
      }

      // Notify participants (excluding the creator)
      for (const pid of participantIds.filter((p) => p !== user.id)) {
        await notify(c, pid, {
          kind: i.type === 'emergency' ? 'crew_emergency' : 'crew_thread',
          title: i.type === 'emergency' ? `🚨 Emergency: ${i.title}` : `Crew: ${i.title}`,
          body: `${ev.name} · ${i.title}`,
          data: { fixture_id: i.id, thread_id: th.id },
          dedupe_key: `crew_thread:${th.id}`,
        });
      }

      await audit(c, user.id, 'crew_thread.created', 'crew_threads', th.id);
      return { ...th, participant_count: participantIds.length };
    });
  },
});

// ── Capability: get thread messages (long-poll) ───────────────────────────────

cap({
  name: 'get_crew_thread_messages',
  method: 'GET',
  path: '/crew-threads/:id/messages',
  tag: TAG,
  summary: 'Messages in a crew thread, newest-first. Pass after_seq + wait_seconds (up to 25) for long-poll real-time (safe to reconnect: dedupe by message id). Pass before_seq for pagination backwards.',
  input: z.object({
    id,
    after_seq: z.coerce.number().int().min(0).optional(),
    before_seq: z.coerce.number().int().min(0).optional(),
    wait_seconds: z.coerce.number().int().min(0).max(25).default(0),
    limit: page.limit,
  }),
  async handler({ user }, i) {
    await tx(async (c) => assertThreadAccess(c, i.id, user.id));
    let msgs = await fetchThreadMessages(i.id, user.id, {
      afterSeq: i.after_seq,
      beforeSeq: i.before_seq,
      limit: i.limit,
      order: i.after_seq != null ? 'ASC' : 'DESC',
    });
    // Simple long-poll: re-query after a brief wait if no new messages
    if (!msgs.length && i.wait_seconds && i.after_seq != null) {
      await new Promise((res) => setTimeout(res, Math.min(i.wait_seconds, 25) * 1000));
      await tx(async (c) => assertThreadAccess(c, i.id, user.id));
      msgs = await fetchThreadMessages(i.id, user.id, { afterSeq: i.after_seq, limit: i.limit, order: 'ASC' });
    }
    await markThreadRead(i.id, user.id);
    return msgs;
  },
});

// ── Capability: post crew message ─────────────────────────────────────────────

cap({
  name: 'post_crew_message',
  method: 'POST',
  path: '/crew-threads/:id/messages',
  tag: TAG,
  status: 201,
  summary: 'Post a message to a crew thread. msg_type: text (default), emergency (broadcast priority alert to all participants), roster_change (structured roster notice), handover (structured handover note). Send client_id so a retry never duplicates. Personal free text is encrypted at rest.',
  input: z.object({
    id,
    body: z.string().trim().max(2000).default(''),
    msg_type: msgType.default('text'),
    reply_to_id: id.optional(),
    client_id: z.string().min(8).max(64).optional(),
  }).refine((x) => x.body.length > 0 || ['attachment', 'system'].includes(x.msg_type), {
    message: 'A message body is required',
    path: ['body'],
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { th, ev } = await assertThreadAccess(c, i.id, user.id);

      if (th.archived_at) throw conflict('This thread is archived');

      // Idempotency: return existing if client_id matches
      if (i.client_id) {
        const prior = (await c.query(
          'SELECT id FROM crew_messages WHERE thread_id=$1 AND sender_id=$2 AND client_id=$3',
          [i.id, user.id, i.client_id],
        )).rows[0];
        if (prior) {
          const [msg] = await fetchThreadMessages(i.id, user.id, { afterSeq: 0, limit: 500 });
          return msg ?? prior;
        }
      }

      if (i.reply_to_id) {
        const parent = (await c.query(
          'SELECT 1 FROM crew_messages WHERE id=$1 AND thread_id=$2 AND deleted_at IS NULL',
          [i.reply_to_id, i.id],
        )).rowCount;
        if (!parent) throw notFound('Message to reply to');
      }

      // Encrypt personal free text; store plain for system messages
      const bodyEnc = i.body ? await encryptField(i.body) : null;
      const priority = i.msg_type === 'emergency' ? 100 : 0;

      const msg = (await c.query(
        `INSERT INTO crew_messages(thread_id, sender_id, body_enc, msg_type, priority, reply_to_id, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (thread_id, sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [i.id, user.id, bodyEnc, i.msg_type, priority, i.reply_to_id ?? null, i.client_id ?? null],
      )).rows[0];

      if (!msg) {
        // Conflict: return the existing row
        const existing = (await c.query(
          'SELECT id FROM crew_messages WHERE thread_id=$1 AND sender_id=$2 AND client_id=$3',
          [i.id, user.id, i.client_id],
        )).rows[0];
        const [formatted] = await fetchThreadMessages(i.id, user.id, { limit: 1 });
        return formatted ?? { id: existing?.id };
      }

      // Mark read for sender
      await markThreadRead(i.id, user.id);

      // Update thread updated_at
      await c.query('UPDATE crew_threads SET updated_at=now() WHERE id=$1', [i.id]);

      // Notify participants
      const participants = (await c.query(
        'SELECT user_id FROM crew_thread_participants WHERE thread_id=$1 AND user_id<>$2 AND removed_at IS NULL',
        [i.id, user.id],
      )).rows;

      const notifTitle = i.msg_type === 'emergency'
        ? `🚨 Emergency: ${th.title}`
        : i.msg_type === 'roster_change'
        ? `👥 Roster change: ${th.title}`
        : `💬 ${th.title}`;

      for (const p of participants) {
        await notify(c, p.user_id, {
          kind: i.msg_type === 'emergency' ? 'crew_emergency' : 'crew_message',
          title: notifTitle,
          body: i.body.slice(0, 120),
          data: { fixture_id: th.fixture_id, thread_id: i.id, message_id: msg.id },
          dedupe_key: `crew_msg:${msg.id}`,
        });
      }

      return formatMessage({ ...msg, sender_name: null, sender_avatar: null, read_by: [], read_count: 0, attachments: [] }, user.id);
    });
  },
});

// ── Capability: mark messages read ───────────────────────────────────────────

cap({
  name: 'mark_crew_messages_read',
  method: 'POST',
  path: '/crew-threads/:id/messages/read',
  tag: TAG,
  summary: 'Mark all messages in a thread as read up to now. Also marks individual messages with a per-user read receipt.',
  input: z.object({ id, message_ids: z.array(id).max(100).optional() }),
  async handler({ user }, i) {
    await tx(async (c) => {
      await assertThreadAccess(c, i.id, user.id);
      if (i.message_ids?.length) {
        for (const mid of i.message_ids) {
          await c.query(
            'INSERT INTO crew_message_reads(message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [mid, user.id],
          );
        }
      }
      await markThreadRead(i.id, user.id);
    });
    return { ok: true };
  },
});

// ── Capability: archive crew thread ──────────────────────────────────────────

cap({
  name: 'archive_crew_thread',
  method: 'POST',
  path: '/crew-threads/:id/archive',
  tag: TAG,
  summary: 'Archive a thread (organiser or creator only). Archived threads are read-only and excluded from the default listing but never deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { th, isOrg } = await assertThreadAccess(c, i.id, user.id);
      if (!isOrg && th.created_by !== user.id) throw forbidden('Only the organiser or thread creator can archive a thread');
      if (th.archived_at) throw conflict('Thread is already archived');
      await c.query('UPDATE crew_threads SET archived_at=now(), archived_by=$2 WHERE id=$1', [i.id, user.id]);
      await audit(c, user.id, 'crew_thread.archived', 'crew_threads', i.id);
      return { ok: true, thread_id: i.id };
    });
  },
});

// ── Capability: create pre-match briefing ────────────────────────────────────

cap({
  name: 'create_crew_briefing',
  method: 'POST',
  path: '/fixtures/:id/crew-briefings',
  tag: TAG,
  status: 201,
  summary: 'Organiser or supervisor creates a pre-match briefing distributed to the full accepted crew. If requires_ack is true, each official must acknowledge before the fixture starts. Briefing body is encrypted at rest.',
  input: z.object({
    id,
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(5000),
    sport_context: z.string().max(100).optional(),
    requires_ack: z.boolean().default(true),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { f, ev, isOrg } = await assertCrewAccess(c, i.id, user.id);
      if (!isOrg) throw forbidden('Only the organiser can create briefings');

      const bodyEnc = await encryptField(i.body);
      const brief = (await c.query(
        `INSERT INTO crew_briefings(fixture_id, event_id, sent_by, title, body_enc, sport_context, requires_ack)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [i.id, ev.id, user.id, i.title, bodyEnc, i.sport_context ?? null, i.requires_ack],
      )).rows[0];

      // Notify full accepted crew
      const crew = (await c.query(
        "SELECT user_id FROM fixture_officials WHERE fixture_id=$1 AND status='accepted' AND user_id<>$2",
        [i.id, user.id],
      )).rows;
      for (const m of crew) {
        await notify(c, m.user_id, {
          kind: 'crew_briefing',
          title: `📋 Briefing: ${i.title}`,
          body: `${ev.name}${i.requires_ack ? ' — acknowledgement required' : ''}`,
          data: { fixture_id: i.id, briefing_id: brief.id },
          dedupe_key: `crew_brief:${brief.id}`,
        });
      }
      await audit(c, user.id, 'crew_briefing.created', 'crew_briefings', brief.id);
      return { ...brief, body: i.body, ack_count: 0, total_crew: crew.length };
    });
  },
});

// ── Capability: list crew briefings ──────────────────────────────────────────

cap({
  name: 'list_crew_briefings',
  method: 'GET',
  path: '/fixtures/:id/crew-briefings',
  tag: TAG,
  summary: 'List pre-match briefings for a fixture with acknowledgement status. Returns body decrypted for the calling user. Archived briefings excluded by default.',
  input: z.object({
    id,
    include_archived: z.coerce.boolean().default(false),
  }),
  async handler({ user }, i) {
    await tx(async (c) => assertCrewAccess(c, i.id, user.id));
    const cond = i.include_archived ? '' : 'AND b.archived_at IS NULL';
    const rows = (await query(
      `SELECT b.*,
              u.name AS sent_by_name,
              count(DISTINCT ba.official_id)::int AS ack_count,
              bool_or(ba.official_id = $2) AS caller_acked,
              ba2.acked_at AS caller_acked_at
         FROM crew_briefings b
         JOIN users u ON u.id = b.sent_by
         LEFT JOIN crew_briefing_acks ba ON ba.briefing_id = b.id
         LEFT JOIN crew_briefing_acks ba2 ON ba2.briefing_id = b.id AND ba2.official_id = $2
        WHERE b.fixture_id = $1 ${cond}
        GROUP BY b.id, u.name, ba2.acked_at
        ORDER BY b.created_at DESC`,
      [i.id, user.id],
    )).rows;

    return Promise.all(rows.map(async (r) => ({
      ...r,
      body: await decryptField(r.body_enc),
      body_enc: undefined,
    })));
  },
});

// ── Capability: acknowledge briefing ─────────────────────────────────────────

cap({
  name: 'ack_crew_briefing',
  method: 'POST',
  path: '/crew-briefings/:id/ack',
  tag: TAG,
  summary: 'Official acknowledges a pre-match briefing. Idempotent. Records the ack timestamp for audit.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const brief = (await c.query('SELECT * FROM crew_briefings WHERE id=$1', [i.id])).rows[0];
      if (!brief) throw notFound('Briefing');
      await assertCrewAccess(c, brief.fixture_id, user.id);
      if (brief.archived_at) throw conflict('Briefing is archived');
      await c.query(
        'INSERT INTO crew_briefing_acks(briefing_id, official_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [i.id, user.id],
      );
      const { ack_count } = (await c.query(
        'SELECT count(*)::int AS ack_count FROM crew_briefing_acks WHERE briefing_id=$1', [i.id],
      )).rows[0];
      await audit(c, user.id, 'crew_briefing.acked', 'crew_briefings', i.id);
      return { ok: true, briefing_id: i.id, acked_at: new Date(), ack_count };
    });
  },
});

// ── Capability: share crew doc ────────────────────────────────────────────────

cap({
  name: 'share_crew_doc',
  method: 'POST',
  path: '/fixtures/:id/crew-docs',
  tag: TAG,
  status: 201,
  summary: 'Organiser or supervisor shares a rules/permit/form document with the crew for a fixture. The URL is encrypted at rest. thread_id scopes the doc to a specific thread; omit for fixture-wide.',
  input: z.object({
    id,
    name: z.string().trim().min(1).max(300),
    description: z.string().max(500).optional(),
    doc_category: z.enum(DOC_CATEGORIES).default('rules'),
    mime_type: z.string().min(1).max(127),
    file_size_bytes: z.number().int().positive().max(52428800).optional(),
    url: z.string().url().max(2000),
    thread_id: id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, isOrg } = await assertCrewAccess(c, i.id, user.id);
      if (!isOrg) throw forbidden('Only the organiser can share documents');

      if (i.thread_id) {
        const th = (await c.query('SELECT fixture_id FROM crew_threads WHERE id=$1', [i.thread_id])).rows[0];
        if (!th || th.fixture_id !== i.id) throw badRequest('Thread does not belong to this fixture');
      }

      const urlEnc = await encryptField(i.url);
      const doc = (await c.query(
        `INSERT INTO crew_shared_docs(fixture_id, thread_id, shared_by, doc_category, name, description, mime_type, file_size_bytes, url_enc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [i.id, i.thread_id ?? null, user.id, i.doc_category, i.name, i.description ?? null, i.mime_type, i.file_size_bytes ?? null, urlEnc],
      )).rows[0];

      // Notify crew if fixture-wide doc
      if (!i.thread_id) {
        const crew = (await c.query(
          "SELECT user_id FROM fixture_officials WHERE fixture_id=$1 AND status='accepted' AND user_id<>$2",
          [i.id, user.id],
        )).rows;
        for (const m of crew) {
          await notify(c, m.user_id, {
            kind: 'crew_doc',
            title: `📄 New doc: ${i.name}`,
            body: `${ev.name} · ${i.doc_category}`,
            data: { fixture_id: i.id, doc_id: doc.id },
            dedupe_key: `crew_doc:${doc.id}`,
          });
        }
      }

      return { ...doc, url_enc: undefined };
    });
  },
});

// ── Capability: list crew docs ────────────────────────────────────────────────

cap({
  name: 'list_crew_docs',
  method: 'GET',
  path: '/fixtures/:id/crew-docs',
  tag: TAG,
  summary: 'List shared documents for a fixture, optionally filtered by category or thread. The URL is returned decrypted only to the calling user (each call is audit-logged).',
  input: z.object({
    id,
    doc_category: z.enum(DOC_CATEGORIES).optional(),
    thread_id: id.optional(),
    include_archived: z.coerce.boolean().default(false),
  }),
  async handler({ user }, i) {
    await tx(async (c) => assertCrewAccess(c, i.id, user.id));
    const conds = ['d.fixture_id=$1'];
    const params = [i.id];
    if (!i.include_archived) conds.push('d.archived_at IS NULL');
    if (i.doc_category) { params.push(i.doc_category); conds.push(`d.doc_category=$${params.length}`); }
    if (i.thread_id) { params.push(i.thread_id); conds.push(`d.thread_id=$${params.length}`); }
    const rows = (await query(
      `SELECT d.*, u.name AS shared_by_name FROM crew_shared_docs d JOIN users u ON u.id=d.shared_by WHERE ${conds.join(' AND ')} ORDER BY d.created_at DESC`,
      params,
    )).rows;

    // Decrypt URL per row and audit
    return Promise.all(rows.map(async (r) => {
      const url = await decryptField(r.url_enc);
      await query('INSERT INTO audit_log(actor_id, action, resource_type, resource_id) VALUES ($1,$2,$3,$4)', [user.id, 'crew_doc.url_read', 'crew_shared_docs', r.id]);
      return { ...r, url, url_enc: undefined };
    }));
  },
});

// ── Capability: flag / moderate a message ────────────────────────────────────

cap({
  name: 'flag_crew_message',
  method: 'POST',
  path: '/crew-messages/:id/flag',
  tag: TAG,
  status: 201,
  summary: 'Report a message for supervisor review. The message is not deleted until a supervisor acts. The reporting reason and optional notes are stored; notes are encrypted.',
  input: z.object({
    id,
    reason: z.enum(FLAG_REASONS),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const msg = (await c.query('SELECT * FROM crew_messages WHERE id=$1 AND deleted_at IS NULL', [i.id])).rows[0];
      if (!msg) throw notFound('Message');
      await assertThreadAccess(c, msg.thread_id, user.id);

      // One active flag per user per message
      const existing = (await c.query(
        "SELECT 1 FROM crew_message_flags WHERE message_id=$1 AND flagged_by=$2 AND status='pending'",
        [i.id, user.id],
      )).rowCount;
      if (existing) throw conflict('You have already flagged this message');

      const notesEnc = i.notes ? await encryptField(i.notes) : null;
      const flag = (await c.query(
        `INSERT INTO crew_message_flags(message_id, thread_id, flagged_by, reason, notes_enc)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [i.id, msg.thread_id, user.id, i.reason, notesEnc],
      )).rows[0];

      // Notify organiser
      const th = (await c.query('SELECT fixture_id FROM crew_threads WHERE id=$1', [msg.thread_id])).rows[0];
      const ev = (await c.query('SELECT organizer_id FROM events WHERE id=(SELECT event_id FROM fixtures WHERE id=$1)', [th.fixture_id])).rows[0];
      if (ev?.organizer_id) {
        await notify(c, ev.organizer_id, {
          kind: 'crew_flag',
          title: '⚠️ Message flagged for review',
          body: `A crew message has been flagged: ${i.reason.replace(/_/g, ' ')}`,
          data: { fixture_id: th.fixture_id, message_id: i.id, flag_id: flag.id },
          dedupe_key: `crew_flag:${flag.id}`,
        });
      }

      return { ok: true, flag_id: flag.id };
    });
  },
});

// ── Capability: resolve moderation flag ──────────────────────────────────────

cap({
  name: 'resolve_crew_flag',
  method: 'POST',
  path: '/crew-flags/:id/resolve',
  tag: TAG,
  summary: 'Organiser or supervisor resolves a moderation flag. Status: resolved (action taken) or dismissed (no action needed). The resolution note is stored in plain text for the audit record.',
  input: z.object({
    id,
    status: z.enum(['resolved', 'dismissed']),
    resolution: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const flag = (await c.query('SELECT * FROM crew_message_flags WHERE id=$1', [i.id])).rows[0];
      if (!flag) throw notFound('Flag');
      const th = (await c.query('SELECT fixture_id FROM crew_threads WHERE id=$1', [flag.thread_id])).rows[0];
      const { isOrg } = await assertCrewAccess(c, th.fixture_id, user.id);
      if (!isOrg) throw forbidden('Only the organiser can resolve moderation flags');
      if (flag.status !== 'pending') throw conflict('This flag is already resolved');

      await c.query(
        'UPDATE crew_message_flags SET status=$2, resolved_by=$3, resolved_at=now(), resolution=$4 WHERE id=$1',
        [i.id, i.status, user.id, i.resolution ?? null],
      );
      await audit(c, user.id, `crew_flag.${i.status}`, 'crew_message_flags', i.id);
      return { ok: true, flag_id: i.id, status: i.status };
    });
  },
});

// ── Capability: get thread detail (with participants + expiry) ────────────────

cap({
  name: 'get_crew_thread',
  method: 'GET',
  path: '/crew-threads/:id',
  tag: TAG,
  summary: 'Full thread detail: metadata, participants (with online presence placeholder), access expiry, and briefing acknowledgement status for briefing-type threads.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { th, f, ev } = await assertThreadAccess(c, i.id, user.id);

      const participants = (await c.query(
        `SELECT tp.user_id, tp.added_at, u.name, u.avatar_url,
                fo.role,
                (ev.organizer_id = tp.user_id) AS is_organiser
           FROM crew_thread_participants tp
           JOIN users u ON u.id = tp.user_id
           LEFT JOIN fixture_officials fo ON fo.fixture_id=$2 AND fo.user_id=tp.user_id AND fo.status='accepted'
           JOIN events ev ON ev.id=$3
          WHERE tp.thread_id=$1 AND tp.removed_at IS NULL
          ORDER BY is_organiser DESC, u.name`,
        [i.id, th.fixture_id, th.event_id],
      )).rows;

      const expiresAt = th.access_expires_at
        ?? (f.ends_at ? new Date(new Date(f.ends_at).getTime() + 2 * 60 * 60 * 1000) : null);

      let briefingAck = null;
      if (th.type === 'briefing') {
        briefingAck = (await c.query(
          'SELECT count(*)::int AS ack_count FROM crew_briefing_acks ba JOIN crew_briefings b ON b.id=ba.briefing_id WHERE b.fixture_id=$1',
          [th.fixture_id],
        )).rows[0];
      }

      return {
        ...th,
        participants,
        access_expires_at: expiresAt,
        fixture_id: th.fixture_id,
        event_id: th.event_id,
        event_name: ev.name,
        briefing_ack: briefingAck,
      };
    });
  },
});
