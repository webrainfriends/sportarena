// Live state of a heat / final / field flight (athletics, swimming and other timed or measured sessions), derived from an append-only event
// log. Pure functions, no database and no clock. The official result is still written by recordSessionResults when the session is
// finalised; until then everything here is PROVISIONAL.
//
// Event kinds (session_events): `status` {status}, `start` {}, `lane` {entry_id, lane}, `split` {entry_id, distance_m, value},
//   `finish` {entry_id, value, reaction?, wind_mps?}, `attempt` {entry_id, round, outcome: valid|foul|pass, value?, wind_mps?},
//   `entry_status` {entry_id, status: dns|dnf|dq, reason?}.
// Progression is only ever what the caller passes in (the pinned rules): `{ qp, qt }` for heats, `{ cut_after_round, cut_to }` for field.

export const SESSION_KINDS = ['status', 'start', 'lane', 'split', 'finish', 'attempt', 'entry_status'];
export const SESSION_STATUSES = ['scheduled', 'call_room', 'ready', 'in_progress', 'provisional'];
const ORDER = Object.fromEntries(SESSION_STATUSES.map((s, i) => [s, i]));
const OUTCOMES = ['valid', 'foul', 'pass'];
const ENTRY_STATUSES = ['dns', 'dnf', 'dq'];
const better = (type) => (type === 'time' ? (a, b) => a - b : (a, b) => b - a);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

const blank = (entryId) => ({ entry_id: entryId, lane: null, status: 'registered', reason: null, splits: [], result: null, reaction: null, wind_mps: null, attempts: [], best: null });

/** Rank marks best first; equal marks share a place. Field ties are broken by the next best valid attempt. */
function place(rows, type, key, tie) {
  const cmp = better(type);
  const ranked = rows.filter((r) => key(r) != null).sort((a, b) => cmp(key(a), key(b)) || (tie ? tie(a, b) : 0));
  const pos = new Map();
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    const same = prev && key(prev) === key(r) && (!tie || tie(prev, r) === 0);
    pos.set(r.entry_id, same ? pos.get(prev.entry_id) : i + 1);
  });
  return pos;
}

/**
 * @param {{ resultType: 'time'|'distance'|'score', entryIds: string[], progression?: object }} cfg
 * @param {Array<{kind:string, payload?:object, voided_at?:any}>} events in order
 */
export function sessionState(cfg, events) {
  const { resultType, entryIds, progression = {} } = cfg;
  const entries = new Map(entryIds.map((id) => [id, blank(id)]));
  let status = 'scheduled', started = false;
  for (const e of events.filter((x) => !x.voided_at)) {
    const p = e.payload ?? {};
    if (e.kind === 'status' && p.status in ORDER && ORDER[p.status] >= ORDER[status]) status = p.status;
    else if (e.kind === 'start') { started = true; if (ORDER[status] < ORDER.in_progress) status = 'in_progress'; }
    const en = entries.get(p.entry_id);
    if (!en) continue;
    if (e.kind === 'lane') en.lane = p.lane ?? null;
    else if (e.kind === 'split') en.splits.push({ distance_m: p.distance_m, value: p.value });
    else if (e.kind === 'finish') { en.result = p.value; en.reaction = p.reaction ?? null; en.wind_mps = p.wind_mps ?? null; en.status = 'finished'; }
    else if (e.kind === 'attempt') {
      en.attempts.push({ round: p.round, outcome: p.outcome, value: p.outcome === 'valid' ? p.value : null, wind_mps: p.wind_mps ?? null });
      if (en.status === 'registered') en.status = 'competing';
    } else if (e.kind === 'entry_status') { en.status = p.status; en.reason = p.reason ?? null; }
  }
  const rows = [...entries.values()];
  const field = rows.some((r) => r.attempts.length) || cfg.field === true;
  for (const r of rows) {
    const valid = r.attempts.filter((a) => a.outcome === 'valid' && num(a.value)).map((a) => a.value).sort(better(resultType));
    r.valid_marks = valid;
    r.best = field ? (valid[0] ?? null) : r.result;
    if (field && ENTRY_STATUSES.includes(r.status)) r.best = null;
  }
  const live = rows.filter((r) => !ENTRY_STATUSES.includes(r.status));
  const tie = field ? (a, b) => { // compare second, third … best marks
    for (let i = 1; i < Math.max(a.valid_marks.length, b.valid_marks.length); i++) {
      const x = a.valid_marks[i], y = b.valid_marks[i];
      if (x == null && y == null) return 0;
      if (x == null) return 1; if (y == null) return -1;
      if (x !== y) return better(resultType)(x, y);
    }
    return 0;
  } : null;
  const pos = place(live, resultType, (r) => r.best, tie);
  for (const r of rows) r.rank = pos.get(r.entry_id) ?? null;

  // progression comes only from the rules the caller pinned; nothing is invented here
  let qualified = new Set();
  if (!field && progression.qp != null) {
    const byPlace = live.filter((r) => r.rank != null).sort((a, b) => a.rank - b.rank);
    const direct = byPlace.filter((r) => r.rank <= progression.qp);
    const rest = byPlace.filter((r) => r.rank > progression.qp).slice(0, progression.qt ?? 0);
    direct.forEach((r) => { r.q = 'Q'; qualified.add(r.entry_id); });
    rest.forEach((r) => { r.q = 'q'; qualified.add(r.entry_id); });
  }
  const rounds = field ? Math.max(0, ...rows.flatMap((r) => r.attempts.map((a) => a.round ?? 0))) : null;
  if (field && progression.cut_after_round && rounds >= progression.cut_after_round && progression.cut_to) {
    const cutPos = rows.filter((r) => r.rank != null && r.rank <= progression.cut_to);
    cutPos.forEach((r) => qualified.add(r.entry_id));
    rows.forEach((r) => { r.continues = qualified.has(r.entry_id); });
  }
  const done = rows.length > 0 && rows.every((r) => ENTRY_STATUSES.includes(r.status) || (field ? false : r.status === 'finished'));
  return {
    kind: field ? 'field' : 'track', result_type: resultType, status: done && status === 'in_progress' ? 'provisional' : status, started,
    provisional: true, // becomes final only through the session's official result (recordSessionResults)
    round: rounds, entries: rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.lane ?? 99) - (b.lane ?? 99)),
    qualified: [...qualified],
  };
}

/** Why a session event cannot be logged now, or null. `state` is sessionState before the event. */
export function sessionReject(cfg, state, next) {
  if (!SESSION_KINDS.includes(next.kind)) return `"${next.kind}" is not a session event`;
  const p = next.payload ?? {};
  if (next.kind === 'status') {
    if (!(p.status in ORDER)) return `status must be one of ${SESSION_STATUSES.join(', ')}`;
    if (ORDER[p.status] < ORDER[state.status]) return `The session is already ${state.status}`;
    return null;
  }
  if (next.kind === 'start') return state.started ? 'The start has already been recorded' : null;
  const en = state.entries.find((r) => r.entry_id === p.entry_id);
  if (!en) return 'entry_id does not belong to this session';
  if (next.kind === 'lane') return Number.isInteger(p.lane) && p.lane >= 1 && p.lane <= 20 ? null : 'lane must be 1 to 20';
  if (next.kind === 'entry_status') {
    if (!ENTRY_STATUSES.includes(p.status)) return `status must be one of ${ENTRY_STATUSES.join(', ')}`;
    return null;
  }
  if (ENTRY_STATUSES.includes(en.status)) return `This competitor is ${en.status.toUpperCase()}`;
  if (next.kind === 'split') {
    if (!num(p.value) || p.value <= 0) return 'A split needs a time in seconds';
    if (!num(p.distance_m) || p.distance_m <= 0) return 'A split needs the distance in metres';
    if (en.splits.some((s) => s.distance_m >= p.distance_m)) return 'Splits must be recorded in increasing distance';
    return null;
  }
  if (next.kind === 'finish') {
    if (!num(p.value) || p.value <= 0) return `A finish needs a ${cfg.resultType === 'time' ? 'time in seconds' : 'mark'}`;
    if (en.status === 'finished') return 'This competitor has already finished; correct the result instead';
    return null;
  }
  if (next.kind === 'attempt') {
    if (!OUTCOMES.includes(p.outcome)) return `outcome must be one of ${OUTCOMES.join(', ')}`;
    if (!Number.isInteger(p.round) || p.round < 1 || p.round > 12) return 'round must be 1 to 12';
    if (p.outcome === 'valid' && (!num(p.value) || p.value <= 0)) return 'A valid attempt needs a mark';
    if (en.attempts.some((a) => a.round === p.round)) return `Round ${p.round} already has an attempt for this competitor`;
    if (en.continues === false) return 'This competitor did not make the cut';
    return null;
  }
  return null;
}
