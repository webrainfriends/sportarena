/**
 * The start of a booking that begins about `aheadHours` from now and lasts `hours`, on a whole hour, without running past midnight UTC
 * (the engine refuses a booking that does). Late in the day it moves to the next midnight, which is still inside any 24 h cancellation window.
 */
export function slotAhead(aheadHours, hours) {
  const t = new Date(Date.now() + aheadHours * 3600e3);
  t.setUTCMinutes(0, 0, 0);
  if (t.getUTCHours() + hours > 24) t.setUTCHours(24, 0, 0, 0);
  return t;
}
