// Lightweight usage telemetry: AI tokens and API call counts per user.
// All writes are fire-and-forget — a failure here never blocks a user request.
import { query } from './db.js';

export async function trackAiUsage(userId, capability, model, tokensIn, tokensOut) {
  if (!userId) return;
  query(
    'INSERT INTO ai_token_usage(user_id, capability, model, tokens_in, tokens_out) VALUES ($1,$2,$3,$4,$5)',
    [userId, capability, model ?? null, tokensIn || 0, tokensOut || 0],
  ).catch((e) => console.warn('[usage] ai track failed', e.message));
}

export async function trackApiCall(userId) {
  if (!userId) return;
  query(
    `INSERT INTO user_daily_api_calls(user_id, date, call_count) VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, date) DO UPDATE SET call_count = user_daily_api_calls.call_count + 1`,
    [userId],
  ).catch((e) => console.warn('[usage] api track failed', e.message));
}
