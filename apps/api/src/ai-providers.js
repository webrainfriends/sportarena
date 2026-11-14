// LLM provider adapter for the sports concierge (issue #72).
// Supports Anthropic (default), OpenAI (stub) and Google (stub). Never modifies ai.js.
// Keys always come from env vars — never stored in the database.
//
// CONCIERGE_PROVIDER=anthropic|openai|google  (default: anthropic)
// CONCIERGE_MODEL=…                           (default: claude-sonnet-5-5 / gpt-4o / gemini-1.5-pro)
// ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY

const TIMEOUT_MS = 30_000;
let transport = null; // replaced in tests via setConciergeTransport

export const setConciergeTransport = (fn) => { transport = fn; };

export function conciergeConfigured() {
  const provider = process.env.CONCIERGE_PROVIDER ?? 'anthropic';
  if (transport) return true;
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  if (provider === 'google') return Boolean(process.env.GOOGLE_API_KEY);
  return false;
}

function defaultModel(provider) {
  if (provider === 'openai') return 'gpt-4o';
  if (provider === 'google') return 'gemini-1.5-pro';
  return process.env.AI_MODEL || 'claude-sonnet-5-5';
}

/** Map Anthropic tool definitions to the unified format the engine uses. */
function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema ?? { type: 'object', properties: {}, required: [] },
  }));
}

async function anthropicAdapter(messages, tools, { model, maxTokens, timeoutMs, system }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn(`[concierge/anthropic] request failed (${res.status})`); return null; }
    const data = await res.json();
    const textBlocks = (data.content ?? []).filter((b) => b.type === 'text');
    const toolBlocks = (data.content ?? []).filter((b) => b.type === 'tool_use');
    return {
      content: textBlocks.map((b) => b.text).join('').trim() || null,
      tool_calls: toolBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
      usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
      stop_reason: data.stop_reason ?? (toolBlocks.length ? 'tool_use' : 'end_turn'),
    };
  } catch (e) {
    console.warn(`[concierge/anthropic] ${e?.name === 'TimeoutError' ? 'timed out' : 'call failed'}: ${e?.message}`);
    return null;
  }
}

/** OpenAI adapter stub — maps to unified format. Returns null if key missing. */
async function openaiAdapter(messages, tools, { model, maxTokens, timeoutMs, system }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const oaiMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const oaiTools = tools?.length ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object', properties: {} } } })) : undefined;
  const body = { model, max_tokens: maxTokens, messages: oaiMessages, ...(oaiTools ? { tools: oaiTools, tool_choice: 'auto' } : {}) };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn(`[concierge/openai] request failed (${res.status})`); return null; }
    const data = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const toolCalls = (msg?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function?.name, input: JSON.parse(tc.function?.arguments ?? '{}') }));
    return {
      content: msg?.content?.trim() || null,
      tool_calls: toolCalls,
      usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
      stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    };
  } catch (e) {
    console.warn(`[concierge/openai] call failed: ${e?.message}`);
    return null;
  }
}

/** Google Gemini stub — returns null if key missing. */
async function googleAdapter(messages, tools, { model, maxTokens, timeoutMs, system }) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return null;
  // Convert OpenAI-style messages to Gemini contents format
  const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content ?? '' }] }));
  if (system) contents.unshift({ role: 'user', parts: [{ text: system }] });
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens } };
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn(`[concierge/google] request failed (${res.status})`); return null; }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() || null;
    return { content: text, tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' };
  } catch (e) {
    console.warn(`[concierge/google] call failed: ${e?.message}`);
    return null;
  }
}

/**
 * Call the configured LLM provider for the concierge.
 * @param {Array} messages — [{role:'user'|'assistant', content:string}]
 * @param {Array} tools — [{name, description, input_schema}]
 * @param {object} opts — {provider?, model?, maxTokens?, timeoutMs?, system?}
 * @returns {Promise<{content:string|null, tool_calls:Array, usage:{input_tokens,output_tokens}, stop_reason:string}|null>}
 */
export async function callProvider(messages, tools, opts = {}) {
  const provider = opts.provider ?? process.env.CONCIERGE_PROVIDER ?? 'anthropic';
  const model = opts.model ?? process.env.CONCIERGE_MODEL ?? defaultModel(provider);
  const maxTokens = opts.maxTokens ?? 1500;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const system = opts.system ?? null;

  if (transport) {
    const result = await transport({ messages, tools, provider, model, maxTokens, system });
    if (result == null) return null;
    return { content: result.content ?? null, tool_calls: result.tool_calls ?? [], usage: result.usage ?? { input_tokens: 0, output_tokens: 0 }, stop_reason: result.stop_reason ?? 'end_turn' };
  }

  if (provider === 'openai') return openaiAdapter(messages, tools, { model, maxTokens, timeoutMs, system });
  if (provider === 'google') return googleAdapter(messages, tools, { model, maxTokens, timeoutMs, system });
  return anthropicAdapter(messages, tools, { model, maxTokens, timeoutMs, system });
}
