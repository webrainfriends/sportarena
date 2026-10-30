// The device's copy of a game. The same pure engine the server uses (apps/api/src/scoring: no database, no clock) is run here over the
// saved log plus the taps still waiting to be sent, so the score, the period and what may be tapped next are right with no signal.
// What this shows is provisional and says so: the server replays every tap under the pinned rules again when it arrives, and stays the
// only authority on order and legality.
import { computeScore, matchPhase, rejectReason } from '../../../api/src/scoring/engine.js';
import { replayStream, withCorrection } from '../../../api/src/scoring/replay.js';
import { sessionPlugin } from '../../../api/src/scoring/plugins/index.js';

const CONTROL = { start: 'live', pause: 'paused', resume: 'live', end: 'finished' };
const STATUS_OK = { start: ['scheduled'], pause: ['live'], resume: ['paused'], end: ['live', 'paused'] };

/** A queued item is a control (kick off, pause, resume, full time) when its `op` is one of those; `void` / `correct` edit an event already in the log; otherwise it is a game event. */
export const isControl = (p) => !!p.op && p.op in CONTROL;
export const isEdit = (p) => p.op === 'void' || p.op === 'correct';

const logged = (events) => events.filter((e) => !e.voided_at);

/**
 * Why a tap cannot be made right now, or null. The same refusals the server gives for the unambiguous cases (a game that is not live,
 * a period that is not open, the sport's own rules), so the scorer is told at once instead of when the signal returns.
 */
export function localReject(game, ev) {
  const f = game.fixture;
  if (f.status === 'paused') return 'The game is paused';
  if (f.status !== 'live') return f.status === 'scheduled' ? 'Start the match first' : `The game is ${f.status}`;
  const rs = game.ruleset, events = game.events;
  const phase = matchPhase(rs, events);
  if (ev.kind === 'period_start' && phase.period_open) return `${rs.periods?.label ?? 'Period'} ${phase.period} is still running`;
  if (ev.kind === 'period_end' && !phase.period_open) return 'No period is running';
  return rejectReason(rs, events, ev, { knockout: !!game.knockout });
}

/** Why a control cannot be pressed right now, or null. */
export function controlReject(game, op) {
  const st = game.fixture.status;
  if (!STATUS_OK[op].includes(st)) return `A game that is ${st} cannot do that`;
  return null;
}

/**
 * Why a correction cannot be made right now, or null: the same replay the server runs, so a correction that would make a later event
 * illegal is refused here, naming it, instead of when the signal returns.
 */
export function correctionReject(game, target, patch) {
  const events = game.events.filter((e) => !e.voided_at);
  const cur = events.find((e) => e.id === target);
  if (!cur) return 'That moment is already voided or corrected';
  const next = { ...cur, id: null, seq: game.last_seq + 1, kind: patch.kind ?? cur.kind, side: patch.side !== undefined ? patch.side : cur.side, supersedes_id: cur.id, position_seq: cur.position_seq ?? cur.seq };
  const ctx = { knockout: !!game.knockout };
  const before = replayStream(game.ruleset, events, ctx), after = replayStream(game.ruleset, withCorrection(events, cur.id, next), ctx);
  if (!after.ok && (before.ok || after.failed.seq !== before.failed.seq)) return `This correction would make a later event illegal (event ${after.failed.seq ?? 'new'}, ${after.failed.kind}: ${after.failed.reason})`;
  return null;
}

/** The game with every waiting tap applied on top of the last log the device holds. `pending` is the queue, oldest first. */
export function project(game, pending) {
  if (!game || !pending?.length) return game;
  let fixture = { ...game.fixture };
  const events = [...game.events];
  let seq = game.last_seq;
  const WAITING = 'Waiting to be sent';
  for (const p of pending) {
    if (isEdit(p)) {   // a void or correction of an event already saved: shown at once, sent in order
      const i = events.findIndex((e) => e.id === p.target && !e.voided_at);
      if (i < 0) continue;
      const old = events[i];
      events[i] = { ...old, voided_at: p.occurred_at ?? 'local', void_reason: p.op === 'correct' ? `Corrected: ${p.reason} (${WAITING.toLowerCase()})` : WAITING, local_edit: true };
      if (p.op === 'correct') events.splice(i + 1, 0, { ...old, id: `local-${p.client_key}`, kind: p.kind ?? old.kind, side: p.side !== undefined ? p.side : old.side, voided_at: null, void_reason: null, supersedes_id: old.id, local: true });
      continue;
    }
    if (isControl(p)) {
      if (STATUS_OK[p.op].includes(fixture.status)) {
        fixture = { ...fixture, status: CONTROL[p.op], ...(p.op === 'start' ? { started_at: p.occurred_at } : {}), ...(p.op === 'end' ? { finished_at: p.occurred_at } : {}) };
      }
      continue;
    }
    const phase = matchPhase(game.ruleset, events);
    const period = p.kind === 'period_start' ? (p.period ?? phase.period + 1) : (p.period ?? (phase.period || 1));
    seq += 1;
    events.push({ id: `local-${p.client_key}`, seq, kind: p.kind, side: p.side ?? null, player_id: p.player_id ?? null, period, clock_seconds: p.clock_seconds ?? null, payload: p.payload ?? {}, voided_at: null, local: true });
  }
  const rs = game.ruleset;
  const phase = matchPhase(rs, events);
  return {
    ...game, fixture, events, last_seq: seq,
    score: phase.score, phase: { ...phase, score: undefined },
    live: { ...game.live, state: fixture.status === 'finished' ? 'provisional' : game.live?.state, paused: fixture.status === 'paused' },
    provisional: true, waiting: pending.length,
  };
}

/**
 * Bring a saved game up to date with a newer read of the same game. Returns the merged game, or null when the newer read does not
 * reach back far enough to join the saved log (it holds only the last page), in which case the whole game must be downloaded again.
 */
export function mergeLive(saved, live) {
  if (!saved) return null;
  if (live.last_seq < saved.last_seq && live.version <= saved.version) return saved;
  const bySeq = new Map(saved.events.map((e) => [e.seq, e]));
  const fresh = live.events.filter((e) => !bySeq.has(e.seq));
  if (fresh.length && Math.min(...fresh.map((e) => e.seq)) > saved.last_seq + 1) return null;   // a gap: events in between are not held
  for (const e of live.events) bySeq.set(e.seq, e);                                              // newer wins, so a void or correction is picked up
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const rs = live.ruleset ?? saved.ruleset;
  const phase = matchPhase(rs, events);
  return { ...saved, ...live, events, ruleset: rs, score: computeScore(rs, events), phase: { ...phase, score: undefined }, lineup: saved.lineup, knockout: saved.knockout, viewer: live.viewer ?? saved.viewer };
}

// ------------------------------------------------------------------ heats, finals and field flights (the session model)
// The pack carries the whole session log and the pinned config; the same pure plugin the server uses derives places, Q/q and what may be
// entered next, so a heat keeps going with no signal. Entries are named from the saved read (names follow the programme's privacy setting).
const sessionEvents = (events) => events.map((e) => ({ ...e, voided_at: e.voided ? (e.voided_at ?? 'v') : (e.voided_at ?? null), payload: { ...(e.payload ?? {}), ...(e.entry_id ? { entry_id: e.entry_id } : {}) } }));

/** Why an entry cannot be made right now (the plugin's own refusals), or null. `g` is the projected session, so its waiting taps count. */
export function sessionReject(g, kind, entry_id, payload = {}) {
  const evs = sessionEvents(g.events);
  return sessionPlugin.validate(g.config, sessionPlugin.state(g.config, evs), { kind, payload: { ...payload, ...(entry_id ? { entry_id } : {}) } });
}

/** The session with every waiting entry, void and result applied on top of the last log the device holds. */
export function projectSession(pack, pending) {
  if (!pack) return pack;
  const events = pack.events.map((e) => ({ ...e }));
  let seq = pack.last_seq;
  let finalizing = false;
  for (const p of pending ?? []) {
    if (p.op === 'void') { const e = events.find((x) => x.id === p.target && !x.voided); if (e) { e.voided = true; e.voided_at = p.occurred_at ?? 'local'; e.void_reason = 'Waiting to be sent'; } continue; }
    if (p.op === 'finalize') { finalizing = true; continue; }
    seq += 1;
    events.push({ id: `local-${p.client_key}`, seq, kind: p.kind, entry_id: p.entry_id ?? null, payload: p.payload ?? {}, voided: false, local: true });
  }
  const state = sessionPlugin.state(pack.config, sessionEvents(events));
  const view = sessionPlugin.publicView(state);
  const named = new Map(pack.projection.entries.map((e) => [e.entry_id, e]));
  const official = ['final', 'corrected'].includes(pack.live.state);
  const base = official ? pack.live.state : state.status === 'provisional' ? 'provisional' : pack.session.status === 'live' || state.started || state.status !== 'scheduled' ? 'live' : 'scheduled';
  return {
    ...pack, events, last_seq: seq,
    projection: { ...view, entries: view.entries.map((e) => ({ ...e, name: named.get(e.entry_id)?.name ?? null, house: named.get(e.entry_id)?.house ?? null })) },
    live: { state: base, provisional: !official, corrected: base === 'corrected' },
    provisional: !!(pending?.length), waiting: pending?.length ?? 0, finalizing,
  };
}
