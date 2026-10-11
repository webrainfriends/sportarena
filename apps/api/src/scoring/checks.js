// Deterministic sanity checks on a score sheet. Errors stop submission; warnings and notes go to the approver.
import { isKnockout } from '../tournament/advance.js';
import { computeScore, matchPhase } from './engine.js';

/** @returns {{code:string, severity:'error'|'warn'|'info', message:string}[]} */
export function sheetAnomalies(rs, events, sheet, fixture) {
  const out = [];
  const add = (code, severity, message) => out.push({ code, severity, message });
  const { home_score: h, away_score: a } = sheet;
  if (h == null || a == null) { add('no_score', 'error', 'The sheet has no final score yet'); return out; }
  const level = h === a;
  const leader = h > a ? fixture.home_team_id : fixture.away_team_id;
  if (!level && sheet.winner_team_id && sheet.winner_team_id !== leader) add('winner_contradicts_score', 'error', 'The winner named is not the side with the higher score');
  if (isKnockout(fixture) && level && !sheet.winner_team_id) add('knockout_needs_winner', 'error', 'A knockout game cannot end level: name the winner (e.g. after extra time or penalties)');
  if (!isKnockout(fixture) && level && rs.draw_allowed === false) add('draw_not_allowed', 'error', `${rs.label} games cannot end level`);
  if (rs.kind === 'sets' && rs.sets) {
    const need = Math.ceil(rs.sets.best_of / 2);
    if (Math.max(h, a) !== need || Math.min(h, a) >= need) add('impossible_sets', 'error', `A best-of-${rs.sets.best_of} match ends with one side on exactly ${need} sets and the other on fewer`);
  }
  if (rs.kind !== 'manual' && events.length) {
    const live = events.filter((e) => !e.voided_at);
    const computed = computeScore(rs, live);
    if (computed.home !== h || computed.away !== a) add('differs_from_log', 'warn', `The match log adds up to ${computed.home}–${computed.away}, the sheet says ${h}–${a}`);
    if (events.length >= 5 && (events.length - live.length) / events.length > 0.2) add('many_voids', 'warn', `${events.length - live.length} of ${events.length} logged events were voided`);
    if (matchPhase(rs, live).period_open) add('period_open', 'info', 'A period was never closed in the match log');
  } else if (rs.kind === 'points_events' && (h > 0 || a > 0)) {
    add('no_events_logged', 'info', 'The score was entered without a match log, so it cannot be cross-checked');
  }
  return out;
}
export const hasErrors = (list) => list.some((x) => x.severity === 'error');
