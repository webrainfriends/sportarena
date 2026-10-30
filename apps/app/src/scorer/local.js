// The device's copy of a game. The same pure engine the server uses (apps/api/src/scoring: no database, no clock) is run here over the
// saved log plus the taps still waiting to be sent, so the score, the period and what may be tapped next are right with no signal.
// What this shows is provisional and says so: the server replays every tap under the pinned rules again when it arrives, and stays the
// only authority on order and legality.
import { computeScore, matchPhase, rejectReason } from '../../../api/src/scoring/engine.js';

const CONTROL = { start: 'live', pause: 'paused', resume: 'live', end: 'finished' };
const STATUS_OK = { start: ['scheduled'], pause: ['live'], resume: ['paused'], end: ['live', 'paused'] };

/** A queued item is a control (kick off, pause, resume, full time) when it has `op`, otherwise it is a game event. */
export const isControl = (p) => !!p.op;

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

/** The game with every waiting tap applied on top of the last log the device holds. `pending` is the queue, oldest first. */
export function project(game, pending) {
  if (!game || !pending?.length) return game;
  let fixture = { ...game.fixture };
  const events = [...game.events];
  let seq = game.last_seq;
  for (const p of pending) {
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
