// Deterministic replay of a game's event stream. A correction changes one event in the middle of the stream; this proves every event that
// follows is still legal under the pinned ruleset before the correction is accepted, and reports the first one that is not.
import { rejectReason, computeScore } from './engine.js';

/**
 * @param {object} rs pinned ruleset
 * @param {Array} events every event in play order (voided ones are skipped)
 * @param {object} [ctx] facts only the caller knows, for example { knockout }
 * @returns {{ ok: true, score: object } | { ok: false, failed: { seq: number|null, kind: string, reason: string } }}
 */
export function replayStream(rs, events, ctx) {
  const applied = [];
  for (const e of events) {
    if (e.voided_at) continue;
    const reason = rejectReason(rs, applied, e, ctx);
    if (reason) return { ok: false, failed: { seq: e.seq ?? null, kind: e.kind, reason } };
    applied.push(e);
  }
  return { ok: true, score: computeScore(rs, applied) };
}

/** The stream as it would be after replacing `target` with `replacement` (which takes the replaced event's place in play order). */
export function withCorrection(events, targetId, replacement) {
  const out = [];
  for (const e of events) {
    if (e.id === targetId) {
      out.push({ ...e, voided_at: e.voided_at ?? new Date().toISOString() }, replacement);
    } else out.push(e);
  }
  return out;
}
