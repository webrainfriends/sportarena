// Sports Concierge capabilities — nine REST/OpenAPI/MCP endpoints (issue #72).
// All session ownership enforced with 404 (never 403) to avoid existence leaks.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { decrypt } from '../crypto.js';
import { turn, executeApproval, redactResult } from '../concierge-engine.js';
import { conciergeConfigured } from '../ai-providers.js';

const sessionId = z.string().uuid();
const approvalId = z.string().uuid();

/** Load session, assert ownership; throw 404 if not found/not owner. */
async function requireSession(sid, userId) {
  const s = await one('SELECT * FROM concierge_sessions WHERE id=$1', [sid]);
  if (!s || s.user_id !== userId) throw notFound('Session');
  return s;
}

/** Decrypt messages content for the owner. Strip *_enc fields from tool_results. */
function decryptMessages(rows, userId) {
  return rows.map((r) => {
    let content = null;
    if (r.content_enc) {
      try { content = decrypt(r.content_enc, 'concierge_messages.content'); } catch { content = null; }
    }
    const toolResults = r.tool_results ? redactResult(r.tool_results) : null;
    return {
      id: r.id, seq: r.seq, role: r.role, content,
      tool_calls: r.tool_calls ?? null,
      tool_results: toolResults,
      model: r.model, provider: r.provider,
      tokens_in: r.tokens_in, tokens_out: r.tokens_out,
      latency_ms: r.latency_ms, created_at: r.created_at,
    };
  });
}

// 1. Create a new concierge session
cap({
  name: 'start_concierge_session',
  summary: 'Start a new Sports Concierge conversation session',
  method: 'POST',
  path: '/me/concierge/sessions',
  auth: 'user',
  input: z.object({
    title: z.string().max(120).optional(),
    context: z.object({
      org_id: z.string().uuid().optional(),
      event_id: z.string().uuid().optional(),
      sport: z.string().max(60).optional(),
    }).optional(),
    client_key: z.string().max(100).optional(),
  }),
  async handler(i, { user }) {
    if (i.client_key) {
      const existing = await one(
        `SELECT cs.id, cs.title, cs.status, cs.context, cs.created_at FROM concierge_sessions cs
         JOIN concierge_messages cm ON cm.session_id=cs.id AND cm.content_hash=$1
         WHERE cs.user_id=$2 LIMIT 1`,
        [i.client_key, user.id]
      );
      if (existing) return existing;
    }
    const session = await one(
      `INSERT INTO concierge_sessions(user_id, title, context)
       VALUES ($1, $2, $3) RETURNING id, title, status, context, created_at, updated_at`,
      [user.id, i.title ?? null, JSON.stringify(i.context ?? {})]
    );
    return session;
  },
});

// 2. List concierge sessions
cap({
  name: 'list_concierge_sessions',
  summary: 'List your Sports Concierge conversation sessions',
  method: 'GET',
  path: '/me/concierge/sessions',
  auth: 'user',
  input: z.object({
    status: z.enum(['active', 'archived']).default('active'),
    ...page(),
  }),
  async handler(i, { user }) {
    const rows = await many(
      `SELECT cs.id, cs.title, cs.status, cs.context, cs.last_message_at, cs.created_at,
              cm.id AS last_message_id,
              CASE WHEN cm.content_enc IS NOT NULL THEN
                LEFT(convert_from(decode(split_part(cm.content_enc, '.', 2), 'base64'), 'UTF8'), 1) ELSE NULL
              END AS has_last_content,
              cm.role AS last_role,
              cm.tokens_out AS last_tokens_out
         FROM concierge_sessions cs
         LEFT JOIN LATERAL (
           SELECT id, content_enc, role, tokens_out FROM concierge_messages
           WHERE session_id=cs.id ORDER BY seq DESC LIMIT 1
         ) cm ON true
        WHERE cs.user_id=$1 AND cs.status=$2
        ORDER BY cs.last_message_at DESC NULLS LAST, cs.created_at DESC
        LIMIT $3 OFFSET $4`,
      [user.id, i.status, i.limit ?? 20, i.offset ?? 0]
    );
    // Decrypt last message preview (first 120 chars)
    const sessions = rows.map((r) => {
      let last_preview = null;
      if (r.last_message_id && r.has_last_content !== null) {
        // We only fetched a flag; return role + preview indicator
        last_preview = { role: r.last_role };
      }
      return { id: r.id, title: r.title, status: r.status, context: r.context, last_message_at: r.last_message_at, created_at: r.created_at, last_preview };
    });
    return { sessions, total: sessions.length };
  },
});

// 3. Get a concierge session with its last 50 messages
cap({
  name: 'get_concierge_session',
  summary: 'Get a Sports Concierge session and its recent messages',
  method: 'GET',
  path: '/me/concierge/sessions/:id',
  auth: 'user',
  input: z.object({ id: sessionId }),
  async handler(i, { user }) {
    const session = await requireSession(i.id, user.id);
    const rows = await many(
      `SELECT id, seq, role, content_enc, tool_calls, tool_results, model, provider, tokens_in, tokens_out, latency_ms, created_at
         FROM concierge_messages WHERE session_id=$1 ORDER BY seq ASC`,
      [i.id]
    );
    const messages = decryptMessages(rows, user.id);

    // Fetch pending approvals for this session
    const approvals = await many(
      `SELECT id, capability_name, proposal, proposal_hash, status, expires_at, created_at
         FROM concierge_approvals WHERE session_id=$1 AND status='pending' AND expires_at > now()
         ORDER BY created_at ASC`,
      [i.id]
    );

    return {
      id: session.id, title: session.title, status: session.status,
      context: session.context, last_message_at: session.last_message_at,
      created_at: session.created_at, updated_at: session.updated_at,
      messages, pending_approvals: approvals,
      ai_configured: conciergeConfigured(),
    };
  },
});

// 4. Send a message to the concierge
cap({
  name: 'send_concierge_message',
  summary: 'Send a message to the Sports Concierge and get a reply',
  method: 'POST',
  path: '/me/concierge/sessions/:id/messages',
  auth: 'user',
  input: z.object({
    id: sessionId,
    message: z.string().min(1).max(2000),
    client_key: z.string().max(100).optional(),
  }),
  async handler(i, { user }) {
    const session = await requireSession(i.id, user.id);
    if (session.status === 'archived') throw conflict('This conversation is archived', { code: 'session_archived' });

    // Idempotency: if client_key was used before, return the stored result
    if (i.client_key) {
      const dup = await one(
        `SELECT cm.id, cm.content_enc, cm.role, cm.created_at
           FROM concierge_messages cm
          WHERE cm.session_id=$1 AND cm.content_hash=$2 AND cm.role='user'
          LIMIT 1`,
        [i.id, i.client_key]
      );
      if (dup) {
        const assistantMsg = await one(
          `SELECT cm.id, cm.content_enc, cm.role, cm.created_at
             FROM concierge_messages cm
            WHERE cm.session_id=$1 AND cm.role='assistant' AND cm.created_at > $2
            ORDER BY cm.seq ASC LIMIT 1`,
          [i.id, dup.created_at]
        );
        let reply = null;
        if (assistantMsg?.content_enc) {
          try { reply = decrypt(assistantMsg.content_enc, 'concierge_messages.content'); } catch { reply = null; }
        }
        return { reply, ai_off: false, pending_approvals: [], usage: { input_tokens: 0, output_tokens: 0 }, idempotent: true };
      }
    }

    const result = await turn(session, i.message, { user });
    return result;
  },
});

// 5. List messages in a session (cursor-paginated by seq)
cap({
  name: 'list_concierge_messages',
  summary: 'List messages in a concierge session',
  method: 'GET',
  path: '/me/concierge/sessions/:id/messages',
  auth: 'user',
  input: z.object({
    id: sessionId,
    before_seq: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  }),
  async handler(i, { user }) {
    await requireSession(i.id, user.id);
    const rows = await many(
      `SELECT id, seq, role, content_enc, tool_calls, tool_results, model, provider, tokens_in, tokens_out, latency_ms, created_at
         FROM concierge_messages
        WHERE session_id=$1 ${i.before_seq ? 'AND seq < $4' : ''}
        ORDER BY seq DESC LIMIT $2 OFFSET $3`,
      i.before_seq ? [i.id, i.limit, 0, i.before_seq] : [i.id, i.limit, 0]
    );
    const messages = decryptMessages(rows.reverse(), user.id);
    return { messages, has_more: rows.length === i.limit };
  },
});

// 6. Get an approval (with live stale check)
cap({
  name: 'get_concierge_approval',
  summary: 'Get a pending concierge approval and check for stale data',
  method: 'GET',
  path: '/me/concierge/approvals/:id',
  auth: 'user',
  input: z.object({ id: approvalId }),
  async handler(i, { user }) {
    const a = await one('SELECT * FROM concierge_approvals WHERE id=$1', [i.id]);
    if (!a || a.actor_id !== user.id) throw notFound('Approval');
    const expired = new Date(a.expires_at) < new Date();
    return {
      id: a.id, session_id: a.session_id, capability_name: a.capability_name,
      proposal: a.proposal, proposal_hash: a.proposal_hash, status: a.status,
      expires_at: a.expires_at, decided_at: a.decided_at, created_at: a.created_at,
      is_expired: expired,
    };
  },
});

// 7. Approve a concierge action
cap({
  name: 'approve_concierge_action',
  summary: 'Confirm and execute a proposed concierge action',
  method: 'POST',
  path: '/me/concierge/approvals/:id/approve',
  auth: 'user',
  input: z.object({
    id: approvalId,
    proposal_hash: z.string().min(1).max(200),
  }),
  async handler(i, { user }) {
    // Client must echo back the proposal_hash it was shown — extra replay guard
    const a = await one('SELECT proposal_hash FROM concierge_approvals WHERE id=$1', [i.id]);
    if (!a || a.actor_id !== user.id) throw notFound('Approval');
    if (a.proposal_hash !== i.proposal_hash) throw conflict('The proposal you confirmed does not match. Ask the concierge again.', { code: 'hash_mismatch' });

    return executeApproval(i.id, user);
  },
});

// 8. Reject a concierge action
cap({
  name: 'reject_concierge_action',
  summary: 'Reject a proposed concierge action',
  method: 'POST',
  path: '/me/concierge/approvals/:id/reject',
  auth: 'user',
  input: z.object({ id: approvalId }),
  async handler(i, { user }) {
    const a = await one('SELECT * FROM concierge_approvals WHERE id=$1', [i.id]);
    if (!a || a.actor_id !== user.id) throw notFound('Approval');
    if (a.status !== 'pending') throw conflict('This action is no longer pending.', { code: 'not_pending' });

    await pool.query("UPDATE concierge_approvals SET status='rejected', decided_at=now() WHERE id=$1", [i.id]);
    await pool.query(
      `INSERT INTO concierge_audit(session_id, actor_id, event_kind, capability_name, params_hash, approval_id)
       VALUES ($1,$2,'tool_rejected',$3,$4,$5)`,
      [a.session_id, user.id, a.capability_name, a.params_hash, i.id]
    );
    return { id: i.id, status: 'rejected' };
  },
});

// 9. List audit events for a session
cap({
  name: 'list_concierge_audit',
  summary: 'List audit events for a concierge session',
  method: 'GET',
  path: '/me/concierge/sessions/:id/audit',
  auth: 'user',
  input: z.object({
    id: sessionId,
    ...page(),
  }),
  async handler(i, { user }) {
    await requireSession(i.id, user.id);
    const rows = await many(
      `SELECT id, event_kind, capability_name, approval_id, created_at
         FROM concierge_audit WHERE session_id=$1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit ?? 50, i.offset ?? 0]
    );
    return { events: rows };
  },
});
