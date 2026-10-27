// Pure scoring engine: turns an ordered list of match events into a score. No database, no clock.
// side is 'home' | 'away'. Voided events must be filtered out by the caller (computeScore and the others also drop them defensively).
// The sport-specific rules live in scoring plugins (see scoring/plugins/index.js); this file only dispatches to them, so adding a sport
// means registering a plugin, not editing the engine.

import { pluginFor, CONTROL_KINDS } from './plugins/index.js';
import { otherSide } from './basic.js';

export { CONTROL_KINDS };

/** @returns {{home:number, away:number, winner:'home'|'away'|null, level:boolean, over:boolean, periods?:any[], sets?:any[], current_set?:any, stats:any}} */
export function computeScore(rs, events) {
  const live = events.filter((e) => !e.voided_at);
  return pluginFor(rs).state(rs, live);
}

/** Where the match is: current period, whether it is running, and whether more points may still be logged. */
export function matchPhase(rs, events) {
  const live = events.filter((e) => !e.voided_at);
  const plugin = pluginFor(rs);
  const score = plugin.state(rs, live);
  const phase = plugin.phase(rs, live, score);
  const decided = (rs.kind === 'sets' || rs.kind === 'cricket') && score.over;
  const shootoutDone = !!score.shootout?.over;
  return { ...phase, can_score: !decided && !shootoutDone, score };
}

/** Why an event cannot be logged right now, or null. `ctx` carries facts only the caller knows (for example `{ knockout }`). */
export function rejectReason(rs, events, next, ctx) {
  return pluginFor(rs).validate(rs, events.filter((e) => !e.voided_at), next, ctx);
}
export { otherSide };
