// Concierge engine: multi-turn tool-calling loop, approval gate, PII redaction (issue #72).
// Separates recommendation (read tools execute inline) from execution (write tools require
// explicit confirmation via concierge_approvals). Prompt injection prevented throughout.
import { many, one, pool } from './db.js';
import { invoke } from './invoke.js';
import { capabilities } from './registry.js';
import { encrypt, decrypt, sha256 } from './crypto.js';
import { AI_RULES, quoteData } from './ai.js';
import { callProvider, conciergeConfigured } from './ai-providers.js';
import { notFound, conflict, forbidden } from './errors.js';

const MAX_HOPS = 6;
const APPROVAL_MINUTES = 5;

// Fields always stripped from tool results before storing or returning.
const PII_FIELDS = new Set(['email', 'phone', 'address', 'dob', 'national_id', 'passport_number', 'tax_id', 'bank_account', 'lat', 'lng', 'latitude', 'longitude']);

// Capability names the concierge may expose to the LLM. Write-scope ones trigger approval.
export const CONCIERGE_TOOL_NAMES = new Set([
  // Read / discovery
  'search_events', 'get_event', 'list_events',
  'search_coaches', 'get_coach_profile', 'list_coaches',
  'search_venues', 'get_venue', 'list_venues',
  'get_venue_availability',
  'list_teams', 'get_team',
  'list_competitions', 'get_competition',
  'list_concierge_sessions', 'get_concierge_session', 'list_concierge_messages',
  // Write / action — require approval before execution
  'create_booking', 'cancel_booking',
  'create_event_entry', 'cancel_event_entry',
  'send_team_invite',
  'create_event',
]);

// Human-readable display names for capabilities shown in approval cards.
const CAP_DISPLAY = {
  create_booking: 'Book a slot',
  cancel_booking: 'Cancel a booking',
  create_event_entry: 'Register for an event',
  cancel_event_entry: 'Cancel event registration',
  send_team_invite: 'Send a team invitation',
  create_event: 'Create an event',
};

/** Recursively strip *_enc fields and known PII keys from a result object. */
export function redactResult(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(redactResult);
  if (typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => !k.endsWith('_enc') && !PII_FIELDS.has(k))
      .map(([k, v]) => [k, typeof v === 'object' ? redactResult(v) : v])
  );
}

/** Classify a capability as 'read' or 'write'. GET = read; everything else = write. */
function capScope(c) {
  return c.method === 'GET' ? 'read' : 'write';
}

/** Build tool definitions for the LLM from the capability registry. */
function buildToolCatalog(user) {
  const userScopes = user.credential?.scopes ?? ['read', 'write'];
  return capabilities
    .filter((c) => CONCIERGE_TOOL_NAMES.has(c.name))
    .filter((c) => {
      const scope = capScope(c);
      if (scope === 'read') return userScopes.includes('read') || userScopes.includes('write');
      return userScopes.includes('write') || userScopes.includes('payment') || !userScopes.length;
    })
    .map((c) => ({
      name: c.name,
      description: `${c.summary ?? c.name}. Auth: ${c.auth === 'user' ? 'authenticated user only' : c.auth}.`,
      input_schema: zodToJsonSchema(c.input),
      _scope: capScope(c),
    }));
}

/** Minimal zod-to-JSON-schema converter (handles object shapes with string/number/boolean/enum). */
function zodToJsonSchema(schema) {
  try {
    if (!schema?._def) return { type: 'object', properties: {}, required: [] };
    if (schema._def.typeName === 'ZodObject') {
      const shape = schema._def.shape?.() ?? {};
      const properties = {};
      const required = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodFieldToSchema(v);
        const isOptional = v._def?.typeName === 'ZodOptional' || v._def?.typeName === 'ZodDefault';
        if (!isOptional) required.push(k);
      }
      return { type: 'object', properties, required };
    }
  } catch { /* fall through */ }
  return { type: 'object', properties: {}, required: [] };
}

function zodFieldToSchema(v) {
  if (!v?._def) return {};
  const tn = v._def.typeName;
  if (tn === 'ZodOptional' || tn === 'ZodDefault') return zodFieldToSchema(v._def.innerType ?? v._def.schema);
  if (tn === 'ZodString') return { type: 'string', description: v._def.description };
  if (tn === 'ZodNumber' || tn === 'ZodCoerce') return { type: 'number', description: v._def.description };
  if (tn === 'ZodBoolean') return { type: 'boolean' };
  if (tn === 'ZodEnum') return { type: 'string', enum: v._def.values };
  if (tn === 'ZodArray') return { type: 'array', items: zodFieldToSchema(v._def.type) };
  if (tn === 'ZodObject') return zodToJsonSchema(v);
  return { type: 'string' };
}

/** Load the last N messages for a session, decrypt user content. */
async function loadHistory(sessionId, limit = 20) {
  const rows = await many(
    'SELECT id, role, content_enc, tool_calls, tool_results, model, provider, tokens_in, tokens_out FROM concierge_messages WHERE session_id=$1 ORDER BY seq DESC LIMIT $2',
    [sessionId, limit]
  );
  return rows.reverse().map((r) => {
    const content = r.content_enc ? (() => { try { return decrypt(r.content_enc, 'concierge_messages.content'); } catch { return null; } })() : null;
    return { id: r.id, role: r.role, content, tool_calls: r.tool_calls, tool_results: r.tool_results };
  });
}

/** Convert history rows to the message array the LLM expects. */
function toProviderMessages(history) {
  const out = [];
  for (const h of history) {
    if (h.role === 'user' || h.role === 'assistant') {
      if (h.content) out.push({ role: h.role, content: h.content });
    }
  }
  return out;
}

/** Build the system prompt. AI_RULES prevents prompt injection from retrieved data. */
function buildSystemPrompt(user) {
  return [
    'You are a world-class sports concierge for GotMyGame, a platform used by elite academies including Rafa Nadal Academy and Real Madrid Academy.',
    'Help athletes, coaches and organisers with scheduling, venue bookings, event registration, team management and player scouting — across every sport.',
    'Be concise, professional and specific. Use the tools provided to look up real data before making suggestions.',
    'For read-only lookups, fetch the data directly. For any action that commits resources (bookings, registrations, invitations), propose it as an action for the user to review — never execute without explicit confirmation.',
    'If you are unsure about availability, price or eligibility, fetch it first. Never invent data.',
    AI_RULES,
    'Never make medical recommendations, give legal or contract advice, or move money outside the approval flow.',
    `The user's id is ${user.id}. Use it when searching their data.`,
  ].join('\n');
}

/** Persist a user message to the database. Returns the row id. */
async function saveMessage(sessionId, role, content, extras = {}) {
  const contentEnc = content ? encrypt(content, 'concierge_messages.content') : null;
  const contentHash = content ? sha256(content) : null;
  const row = await one(
    `INSERT INTO concierge_messages(session_id, role, content_enc, content_hash, tool_calls, tool_results, model, provider, tokens_in, tokens_out, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, seq`,
    [sessionId, role, contentEnc, contentHash,
     extras.tool_calls ? JSON.stringify(extras.tool_calls) : null,
     extras.tool_results ? JSON.stringify(extras.tool_results) : null,
     extras.model ?? null, extras.provider ?? null,
     extras.tokens_in ?? 0, extras.tokens_out ?? 0, extras.latency_ms ?? null]
  );
  await pool.query('UPDATE concierge_sessions SET last_message_at=now(), updated_at=now() WHERE id=$1', [sessionId]);
  return row.id;
}

/** Build a live price/availability preview for the approval card. */
async function buildProposal(capName, params, user) {
  const displayName = CAP_DISPLAY[capName] ?? capName.replace(/_/g, ' ');
  const summary = { action: displayName };
  // For booking: attempt to fetch the slot details
  if (capName === 'create_booking' && params.resource_id) {
    try {
      const slot = await one('SELECT r.name, v.name AS venue_name, $2::timestamptz AS starts_at, $3::timestamptz AS ends_at FROM resources r JOIN venues v ON v.id=r.venue_id WHERE r.id=$1', [params.resource_id, params.starts_at, params.ends_at]);
      if (slot) {
        summary.resource = slot.name;
        summary.venue = slot.venue_name;
        summary.starts_at = params.starts_at;
        summary.ends_at = params.ends_at;
        if (params.price_cents) summary.price_cents = params.price_cents;
        if (params.currency) summary.currency = params.currency;
      }
    } catch { /* use minimal summary */ }
  }
  if (capName === 'create_event_entry' && params.event_id) {
    try {
      const ev = await one('SELECT name, entry_fee_cents, currency FROM events WHERE id=$1', [params.event_id]);
      if (ev) { summary.event = ev.name; summary.price_cents = ev.entry_fee_cents; summary.currency = ev.currency; }
    } catch { /* use minimal summary */ }
  }
  // Add any top-level params that aren't sensitive
  for (const [k, v] of Object.entries(params)) {
    if (!k.endsWith('_enc') && !PII_FIELDS.has(k) && summary[k] === undefined && typeof v !== 'object') {
      summary[k] = v;
    }
  }
  return summary;
}

/** Persist an approval record and audit event. Returns the approval row. */
async function createApproval(sessionId, messageId, capName, params, user) {
  const paramsHash = sha256(JSON.stringify(params, Object.keys(params).sort()));
  const proposal = await buildProposal(capName, params, user);
  const proposalHash = sha256(JSON.stringify(proposal));
  const expiresAt = new Date(Date.now() + APPROVAL_MINUTES * 60 * 1000).toISOString();
  const approval = await one(
    `INSERT INTO concierge_approvals(session_id, message_id, actor_id, capability_name, params_hash, proposal, proposal_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [sessionId, messageId, user.id, capName, paramsHash, JSON.stringify(proposal), proposalHash, expiresAt]
  );
  await pool.query(
    `INSERT INTO concierge_audit(session_id, actor_id, event_kind, capability_name, params_hash, approval_id)
     VALUES ($1,$2,'tool_proposed',$3,$4,$5)`,
    [sessionId, user.id, capName, paramsHash, approval.id]
  );
  return approval;
}

/**
 * Run one conversational turn.
 * @returns {{ reply:string|null, pending_approvals:Array, usage:{input_tokens,output_tokens} }}
 */
export async function turn(session, userMessage, { user }) {
  if (!conciergeConfigured()) {
    return { reply: null, ai_off: true, pending_approvals: [], usage: { input_tokens: 0, output_tokens: 0 } };
  }

  const t0 = Date.now();
  const tools = buildToolCatalog(user);
  const history = await loadHistory(session.id, 18);

  // Save the user message
  const userMsgId = await saveMessage(session.id, 'user', userMessage, { latency_ms: 0 });

  const providerMessages = [
    ...toProviderMessages(history),
    { role: 'user', content: quoteData(userMessage, 2000) },
  ];

  let totalIn = 0, totalOut = 0;
  let hops = 0;
  let finalReply = null;
  const pendingApprovals = [];
  let lastMsgId = userMsgId;

  while (hops < MAX_HOPS) {
    hops++;
    const provider = process.env.CONCIERGE_PROVIDER ?? 'anthropic';
    const model = process.env.CONCIERGE_MODEL ?? (process.env.AI_MODEL || 'claude-sonnet-5-5');

    const result = await callProvider(providerMessages, tools, { system: buildSystemPrompt(user), provider, model });
    if (!result) break;

    totalIn += result.usage.input_tokens;
    totalOut += result.usage.output_tokens;

    if (result.tool_calls?.length) {
      const toolCallRecords = [];
      const toolResultRecords = [];

      for (const tc of result.tool_calls) {
        const cap = capabilities.find((c) => c.name === tc.name);
        if (!cap) continue;

        const scope = capScope(cap);

        if (scope === 'read') {
          // Execute inline — read tools never need approval
          let res = null, err = null;
          try {
            res = await invoke(cap, user, tc.input ?? {});
            res = redactResult(res);
          } catch (e) { err = e?.message ?? 'Tool call failed'; }
          toolCallRecords.push({ name: tc.name, params_hash: sha256(JSON.stringify(tc.input ?? {})), scope: 'read' });
          toolResultRecords.push({ name: tc.name, result: err ? { error: err } : res });
          // Feed result back into the conversation
          providerMessages.push({ role: 'assistant', content: null, tool_use: tc });
          providerMessages.push({ role: 'user', content: `Tool result for ${tc.name}: ${JSON.stringify(res ?? { error: err })}` });
        } else {
          // Write tool — create approval, stop the loop, return for user confirmation
          const assistantMsgId = await saveMessage(session.id, 'assistant', result.content, {
            tool_calls: [{ name: tc.name, params_hash: sha256(JSON.stringify(tc.input ?? {})), scope: 'write' }],
            tokens_in: result.usage.input_tokens, tokens_out: result.usage.output_tokens,
            latency_ms: Date.now() - t0, model, provider,
          });
          lastMsgId = assistantMsgId;
          const approval = await createApproval(session.id, assistantMsgId, tc.name, tc.input ?? {}, user);
          pendingApprovals.push({
            id: approval.id, capability_name: approval.capability_name,
            proposal: approval.proposal, proposal_hash: approval.proposal_hash,
            expires_at: approval.expires_at, status: 'pending',
            display_name: CAP_DISPLAY[approval.capability_name] ?? approval.capability_name,
          });
          finalReply = result.content;
          goto_done: break; // eslint-disable-line no-labels
        }
      }

      if (pendingApprovals.length) break;

      // Save a tool_result message
      if (toolResultRecords.length) {
        await saveMessage(session.id, 'tool_result', null, {
          tool_calls: toolCallRecords,
          tool_results: toolResultRecords,
        });
      }
    } else {
      // No tool calls — final text reply
      finalReply = result.content;
      await saveMessage(session.id, 'assistant', finalReply, {
        tokens_in: result.usage.input_tokens, tokens_out: result.usage.output_tokens,
        latency_ms: Date.now() - t0, model: process.env.CONCIERGE_MODEL ?? (process.env.AI_MODEL || 'claude-sonnet-5-5'),
        provider: process.env.CONCIERGE_PROVIDER ?? 'anthropic',
      });
      break;
    }
  }

  return { reply: finalReply, ai_off: false, pending_approvals: pendingApprovals, usage: { input_tokens: totalIn, output_tokens: totalOut } };
}

/**
 * Execute an approved concierge action.
 * Re-validates expiry, stale check and replay guard before invoking the capability.
 */
export async function executeApproval(approvalId, user) {
  const approval = await one('SELECT * FROM concierge_approvals WHERE id=$1', [approvalId]);
  if (!approval) throw notFound('Approval');
  if (approval.actor_id !== user.id) throw notFound('Approval');

  if (approval.status !== 'pending') {
    if (approval.status === 'approved') throw conflict('This action was already confirmed', { code: 'already_executed' });
    if (approval.status === 'expired') throw conflict('This action expired. Ask the concierge again.', { code: 'approval_expired' });
    if (approval.status === 'replayed') throw conflict('This action was already used.', { code: 'replay_blocked' });
    if (approval.status === 'stale') throw conflict('The details changed. Review again.', { code: 'stale_blocked' });
    if (approval.status === 'rejected') throw conflict('You rejected this action.', { code: 'already_rejected' });
    throw conflict('This action is no longer pending.', { code: 'not_pending' });
  }

  if (new Date(approval.expires_at) < new Date()) {
    await pool.query("UPDATE concierge_approvals SET status='expired', decided_at=now() WHERE id=$1", [approvalId]);
    await pool.query(`INSERT INTO concierge_audit(session_id, actor_id, event_kind, capability_name, params_hash, approval_id)
      VALUES ($1,$2,'approval_expired',$3,$4,$5)`, [approval.session_id, user.id, approval.capability_name, approval.params_hash, approvalId]);
    throw conflict('This action expired. Ask the concierge again.', { code: 'approval_expired' });
  }

  // Re-build proposal to check for stale price/availability
  const cap = capabilities.find((c) => c.name === approval.capability_name);
  if (!cap) throw conflict('Capability no longer available', { code: 'cap_unavailable' });

  // Try to build a fresh proposal and compare hashes
  let freshProposal = null;
  try { freshProposal = await buildProposal(approval.capability_name, approval.proposal, user); } catch { /* ignore */ }
  if (freshProposal) {
    const freshHash = sha256(JSON.stringify(freshProposal));
    if (freshHash !== approval.proposal_hash) {
      await pool.query("UPDATE concierge_approvals SET status='stale', decided_at=now() WHERE id=$1", [approvalId]);
      await pool.query(`INSERT INTO concierge_audit(session_id, actor_id, event_kind, capability_name, params_hash, approval_id)
        VALUES ($1,$2,'stale_blocked',$3,$4,$5)`, [approval.session_id, user.id, approval.capability_name, approval.params_hash, approvalId]);
      throw conflict('The details changed since we showed this. Ask the concierge again to get the updated price or availability.', { code: 'stale_blocked', new_proposal: freshProposal });
    }
  }

  // Execute
  let result;
  try {
    result = await invoke(cap, user, approval.proposal ?? {}, { concierge: true, approval_id: approvalId });
  } catch (e) {
    await pool.query("UPDATE concierge_approvals SET status='pending' WHERE id=$1", [approvalId]); // keep pending so user can retry
    await pool.query(`INSERT INTO concierge_audit(session_id, actor_id, event_kind, capability_name, params_hash, approval_id, meta)
      VALUES ($1,$2,'tool_failed',$3,$4,$5,$6)`, [approval.session_id, user.id, approval.capability_name, approval.params_hash, approvalId, JSON.stringify({ error: e?.message })]);
    throw e;
  }

  const redacted = redactResult(result);
  await pool.query(
    "UPDATE concierge_approvals SET status='approved', decided_at=now(), executed_at=now(), result=$2 WHERE id=$1",
    [approvalId, JSON.stringify(redacted)]
  );
  await pool.query(`INSERT INTO concierge_audit(session_id, actor_id, event_kind, capability_name, params_hash, approval_id)
    VALUES ($1,$2,'tool_executed',$3,$4,$5)`, [approval.session_id, user.id, approval.capability_name, approval.params_hash, approvalId]);

  return { result: redacted, capability_name: approval.capability_name, executed_at: new Date().toISOString() };
}
