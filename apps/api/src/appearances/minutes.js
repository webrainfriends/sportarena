// Pure rules for appearances (issue #322). Clock values are GAME-clock seconds (the clock stops with the game), so stoppages are
// already excluded; anything without a usable clock yields NULL minutes, never a guessed number.

/** Source authority: a lower-ranked source can never overwrite a higher-ranked one. */
export const AUTHORITY = { backfill: 10, team_manager: 20, staff: 30, official_sheet: 40 };

/** Length of play in seconds: the last period_end clock, else the scheduled duration (labelled as such), else unknown. */
export function matchLength(events, durationMin) {
  const ends = events.filter((e) => e.kind === 'period_end' && !e.voided_at && Number.isInteger(e.clock_seconds)).map((e) => e.clock_seconds);
  if (ends.length) return { seconds: Math.max(...ends), basis: 'match_clock' };
  if (Number.isInteger(durationMin) && durationMin > 0) return { seconds: durationMin * 60, basis: 'scheduled_duration' };
  return { seconds: null, basis: null };
}

/** Minutes on the field from on/off clocks. Starters have on = 0. Returns null when the interval is not valid. */
export function minutesOn({ status, on, off }, length) {
  if (status !== 'started' && status !== 'substitute_on') return status === 'unused_sub' || status === 'dnp' ? 0 : null;
  const from = status === 'started' ? (on ?? 0) : on;
  if (from == null) return null;
  const to = off ?? length;
  if (to == null || to < from) return null;
  if (length != null && to > length) return null;
  return Math.round((to - from) / 6) / 10;
}

/** A scheduled duration is a guess about play time, so it never feeds per-minute rates. */
export const VALID_BASIS = ['match_clock', 'staff_entry', 'official_sheet'];

/** Per-minute rates only from rows with verified minutes; the rest are counted as excluded, never as zero minutes. */
export function ratesFrom(rows, { per = 90, minMinutes = 1 } = {}) {
  const used = rows.filter((r) => r.minutes_played != null && Number(r.minutes_played) >= minMinutes && VALID_BASIS.includes(r.minutes_basis));
  const minutes = used.reduce((s, r) => s + Number(r.minutes_played), 0);
  const totals = {};
  for (const r of used) for (const [k, v] of Object.entries(r.stats ?? {})) if (typeof v === 'number') totals[k] = (totals[k] ?? 0) + v;
  const rates = {};
  if (minutes >= minMinutes) for (const [k, v] of Object.entries(totals)) rates[k] = Math.round((v / minutes) * per * 100) / 100;
  return { per, unit: `per ${per} minutes of verified playing time`, minutes: Math.round(minutes * 10) / 10, matches_counted: used.length, matches_excluded: rows.length - used.length, totals, rates };
}
