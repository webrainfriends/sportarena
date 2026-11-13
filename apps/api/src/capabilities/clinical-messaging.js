import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

const enc = (v) => encrypt(v, 'clinical_messages.body');
const dec = (v) => (v ? decrypt(v, 'clinical_messages.body') : null);
const decRow = (r) => r ? { ...r, body: dec(r.body_enc), body_enc: undefined } : r;

cap({
  name: 'send_clinical_message', method: 'POST', path: '/clinical/messages',
  tag: 'Physio', auth: true, summary: 'Send an encrypted clinical message in a thread',
  input: z.object({
    recipient_id: z.string().uuid(),
    thread_id: z.string().uuid().optional(),
    body: z.string().min(1).max(5000),
  }),
  handler: async ({ user }, i) => {
    const threadId = i.thread_id ?? crypto.randomUUID();
    const row = await one(
      `INSERT INTO clinical_messages (thread_id, sender_id, recipient_id, body_enc)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [threadId, user.id, i.recipient_id, enc(i.body)],
    );
    return decRow(row);
  },
});

cap({
  name: 'list_clinical_threads', method: 'GET', path: '/clinical/threads',
  tag: 'Physio', auth: true, summary: 'List clinical message threads for current user',
  input: z.object({}),
  handler: async ({ user }) => {
    return many(
      `SELECT DISTINCT ON (m.thread_id)
         m.thread_id,
         CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END AS other_party_id,
         m.created_at AS last_message_at,
         (SELECT count(*) FROM clinical_messages
          WHERE thread_id=m.thread_id AND recipient_id=$1 AND read_at IS NULL AND archived_at IS NULL
         )::int AS unread_count
       FROM clinical_messages m
       WHERE (m.sender_id=$1 OR m.recipient_id=$1) AND m.archived_at IS NULL
       ORDER BY m.thread_id, m.created_at DESC`,
      [user.id],
    );
  },
});

cap({
  name: 'get_clinical_thread', method: 'GET', path: '/clinical/threads/:thread_id',
  tag: 'Physio', auth: true, summary: 'Get all messages in a clinical thread',
  input: z.object({ thread_id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT * FROM clinical_messages
       WHERE thread_id=$1 AND (sender_id=$2 OR recipient_id=$2) AND archived_at IS NULL
       ORDER BY created_at`,
      [i.thread_id, user.id],
    );
    // mark unread messages as read
    await one(
      `UPDATE clinical_messages SET read_at=COALESCE(read_at,now())
       WHERE thread_id=$1 AND recipient_id=$2 AND read_at IS NULL`,
      [i.thread_id, user.id],
    );
    return rows.map(decRow);
  },
});

cap({
  name: 'archive_clinical_message', method: 'POST', path: '/clinical/messages/:id/archive',
  tag: 'Physio', auth: true, summary: 'Archive a clinical message (sender or recipient)',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    return one(
      `UPDATE clinical_messages SET archived_at=now()
       WHERE id=$1 AND (sender_id=$2 OR recipient_id=$2)
       RETURNING id`,
      [i.id, user.id],
    );
  },
});
