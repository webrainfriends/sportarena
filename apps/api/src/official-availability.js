// One availability engine for match officials (#994). Every caller (invite, accept, reschedule, the official's own calendar, the organiser's
// pool, suggestions and the free/busy view) reads an official's time through this file, so they can never disagree.
// Wall-clock rules (weekly hours, recurring time off, public holidays) are anchored in an IANA zone and expanded to instants with the
// same Intl-based helpers the calendar feeds use, so they hold their local time across daylight saving and across the date line.
import { zonedToUtc, localParts, validZone } from './ics.js';
import { addDays } from './booking/time.js';
import { decrypt } from './crypto.js';

export const CATEGORIES = ['holiday', 'work', 'family', 'injury', 'travel', 'study', 'faith', 'federation_duty', 'other_sport', 'personal'];
export const LEVELS = ['grassroots', 'local', 'district', 'county', 'regional', 'national', 'international', 'olympic'];
export const AGE_BANDS = ['u8', 'u10', 'u12', 'u14', 'u16', 'u18', 'u21', 'senior', 'masters'];
export const BLOCK_KINDS = ['blackout', 'recurring', 'holiday'];
const MIN = 60000, DAY = 864e5;
export const NOTE_CTX = 'official_availability.note';
/** The official's private note on a block: encrypted for new rows, plain for rows written before #994. Only ever returned to its owner. */
export const noteOf = (r) => (r?.note_enc ? decrypt(r.note_enc, NOTE_CTX) : r?.note ?? null);

/** Columns of official_availability with dates as text (pg would otherwise hand back Date objects in the server's zone). */
export const BLOCK_COLS = `id, user_id, kind, weekday, start_minute, end_minute, starts_at, ends_at, category, all_day, timezone,
  starts_on::text AS starts_on, ends_on::text AS ends_on, weekdays, every_n_weeks, exclude_dates::text[] AS exclude_dates,
  valid_from::text AS valid_from, valid_to::text AS valid_to, holiday_day_id, label, note, note_enc, version, created_at, updated_at`;

export const DEFAULT_PREFS = {
  timezone: 'UTC', buffer_min: 0, buffer_same_venue_min: null, travel_km: null, region: null, country: null, sport_ids: [], levels: [], roles: [], age_bands: [],
  outside_hours_policy: 'warn', tentative_policy: 'allow', min_notice_hours: 0, max_per_day: null, max_per_week: null, max_consecutive_days: null, version: 0,
};

const zoneOf = (tz) => (tz && validZone(tz) ? tz : 'UTC');
const ymd = (d) => d.split('-').map(Number);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
/** Instant of a local date + minutes-from-midnight in a zone (1440 = the next local midnight). */
export function localToMs(date, minute, tz) {
  const [y, m, d] = ymd(minute >= 1440 ? addDays(date, 1) : date);
  const mm = minute >= 1440 ? minute - 1440 : minute;
  return zonedToUtc(y, m, d, Math.floor(mm / 60), mm % 60, 0, tz);
}
export const localDate = (ms, tz) => localParts(ms, tz).date;
/** Monday of the local week a date falls in. */
export const weekStart = (date) => addDays(date, -((dow(date) + 6) % 7));

/** Load an official's preferences (defaults when they have never saved) and every live availability row. */
export async function loadAvailability(c, userId) {
  const prefs = (await c.query('SELECT * FROM official_prefs WHERE user_id=$1', [userId])).rows[0];
  const rows = (await c.query(`SELECT ${BLOCK_COLS} FROM official_availability WHERE user_id=$1 AND archived_at IS NULL ORDER BY kind, starts_at NULLS LAST, starts_on NULLS LAST, weekday, start_minute, id`, [userId])).rows;
  return { prefs: { ...DEFAULT_PREFS, user_id: userId, ...(prefs ?? {}) }, saved: !!prefs, rows };
}

/**
 * Turn time-off rows (one-off, recurring, public holiday) into concrete instants that touch [fromMs, toMs).
 * Each occurrence keeps the id of the row it came from, so a calendar entry always points at its canonical source.
 */
export function expandBlocks(rows, fromMs, toMs, fallbackTz = 'UTC') {
  const out = [];
  for (const r of rows) {
    if (r.kind === 'blackout' || r.kind === 'available') {
      const s = new Date(r.starts_at).getTime(), e = new Date(r.ends_at).getTime();
      if (s < toMs && e > fromMs) out.push({ id: r.id, kind: r.kind, category: r.category ?? null, all_day: !!r.all_day, label: r.label ?? null, startMs: s, endMs: e, date: null });
      continue;
    }
    const tz = zoneOf(r.timezone ?? fallbackTz);
    if (r.kind === 'holiday') {
      const s = localToMs(r.starts_on, 0, tz), e = localToMs(r.starts_on, 1440, tz);
      if (s < toMs && e > fromMs) out.push({ id: r.id, kind: r.kind, category: 'holiday', all_day: true, label: r.label ?? null, startMs: s, endMs: e, date: r.starts_on });
      continue;
    }
    if (r.kind !== 'recurring') continue;
    const skip = new Set(r.exclude_dates ?? []);
    const first = [r.starts_on, addDays(localDate(fromMs, tz), -1)].sort()[1];
    const last = [r.ends_on, addDays(localDate(toMs, tz), 1)].sort()[0];
    const startDow = dow(r.starts_on), every = r.every_n_weeks ?? 1;
    for (let d = first; d <= last; d = addDays(d, 1)) {
      if (!r.weekdays.includes(dow(d)) || skip.has(d)) continue;
      if (Math.floor((daysBetween(r.starts_on, d) + startDow) / 7) % every !== 0) continue;
      const s = localToMs(d, r.start_minute, tz), e = localToMs(d, r.end_minute, tz);
      if (s < toMs && e > fromMs) out.push({ id: r.id, kind: r.kind, category: r.category ?? null, all_day: !!r.all_day, label: r.label ?? null, startMs: s, endMs: e, date: d });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || String(a.id).localeCompare(String(b.id)));
}

/** Weekly windows that apply on a local date (a window may be limited to a season). */
export const weeklyOn = (rows, date) => rows.filter((r) => r.kind === 'weekly' && (!r.valid_from || r.valid_from <= date) && (!r.valid_to || r.valid_to >= date));

/**
 * Is a match inside the official's stated hours? null = they have set no weekly hours for that part of the year (no restriction),
 * true = inside a weekly window or an explicit "available" window, false = outside.
 */
export function withinHours(rows, startMs, durationMin, tz) {
  const endMs = startMs + durationMin * MIN;
  if (rows.some((r) => r.kind === 'available' && new Date(r.starts_at).getTime() <= startMs && new Date(r.ends_at).getTime() >= endMs)) return true;
  const lp = localParts(startMs, tz);
  const live = weeklyOn(rows, lp.date);
  if (!live.length) return null;
  return live.some((w) => w.weekday === lp.weekday && lp.minutes >= w.start_minute && lp.minutes + durationMin <= w.end_minute);
}

/** The official's other open work near an instant: confirmed and tentative fixtures, one row per fixture (confirmed wins). */
export async function nearbyWork(c, userId, fromMs, toMs, exceptFixtureId = null) {
  const rows = (await c.query(
    `SELECT f.id, f.scheduled_at, f.duration_min, r.venue_id,
            bool_or(f.referee_id=$1 OR fo.status='accepted') AS confirmed
       FROM fixtures f LEFT JOIN resources r ON r.id=f.resource_id
       LEFT JOIN fixture_officials fo ON fo.fixture_id=f.id AND fo.user_id=$1 AND fo.status IN ('invited','accepted')
      WHERE f.status IN ('scheduled','live') AND ($4::uuid IS NULL OR f.id <> $4) AND (f.referee_id=$1 OR fo.id IS NOT NULL)
        AND f.scheduled_at < $3 AND f.scheduled_at + f.duration_min * interval '1 minute' > $2
      GROUP BY f.id, r.venue_id ORDER BY f.scheduled_at, f.id`,
    [userId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), exceptFixtureId])).rows;
  return rows.map((r) => ({ fixture_id: r.id, startMs: new Date(r.scheduled_at).getTime(), endMs: new Date(r.scheduled_at).getTime() + r.duration_min * MIN, venue_id: r.venue_id, confirmed: r.confirmed }));
}

/** The gap an official needs around a match: their same-venue gap when both matches share a venue, otherwise their travel gap. */
export const bufferMs = (prefs, venueA, venueB) =>
  ((venueA && venueB && venueA === venueB && prefs.buffer_same_venue_min != null) ? prefs.buffer_same_venue_min : (prefs.buffer_min ?? 0)) * MIN;

/**
 * Everything the official's own time says about one match slot.
 * `hard` rules always hold (time off; no overlap with confirmed work, including the buffer). `soft` rules are the official's stated limits
 * (hours when they chose to block outside them, minimum notice, daily / weekly / consecutive-day caps, one tentative offer per slot):
 * they stop a new invitation, but never stop the official accepting, and never stop an organiser re-timing a match already agreed.
 * `leadMin` is the reporting time before kick-off: time off and other work are checked from then.
 * Messages never carry a reason, a note or a place.
 */
export async function assess(c, { userId, start, durationMin, fixtureId = null, venueId, leadMin = 0, now = Date.now() }) {
  const { prefs, rows } = await loadAvailability(c, userId);
  const tz = zoneOf(prefs.timezone);
  const startMs = new Date(start).getTime(), endMs = startMs + durationMin * MIN;
  if (venueId === undefined && fixtureId) venueId = (await c.query('SELECT r.venue_id FROM fixtures f LEFT JOIN resources r ON r.id=f.resource_id WHERE f.id=$1', [fixtureId])).rows[0]?.venue_id ?? null;
  const hard = [], soft = [], notes = [];

  const fromMs = startMs - leadMin * MIN;   // the official is needed from their reporting time, not from kick-off
  const off = expandBlocks(rows.filter((r) => BLOCK_KINDS.includes(r.kind)), fromMs, endMs, tz);
  if (off.length) hard.push({ code: 'time_off', message: 'That official has marked this time as unavailable' });

  const work = await nearbyWork(c, userId, startMs - 9 * DAY, endMs + 9 * DAY, fixtureId);
  const confirmed = work.filter((w) => w.confirmed), tentative = work.filter((w) => !w.confirmed);
  const maxBuf = Math.max(prefs.buffer_min ?? 0, prefs.buffer_same_venue_min ?? 0) * MIN;
  const clash = confirmed.find((w) => { const b = bufferMs(prefs, venueId, w.venue_id); return w.startMs < endMs + b && w.endMs > fromMs - b; });
  if (clash) {
    const direct = clash.startMs < endMs && clash.endMs > fromMs;
    hard.push({ code: direct ? 'clash' : 'buffer', message: maxBuf ? 'Official already has a game in that window (including their travel buffer)' : 'Official already has a game in that window' });
  }

  const inside = withinHours(rows, startMs, durationMin, tz);
  if (inside === false) (prefs.outside_hours_policy === 'block' ? soft : notes).push({ code: 'outside_hours', message: 'That is outside the hours this official has said they officiate' });
  if (prefs.min_notice_hours && startMs - now < prefs.min_notice_hours * 3600000) soft.push({ code: 'short_notice', message: `This official asks for at least ${prefs.min_notice_hours} hours of notice` });

  const day = localDate(startMs, tz), wk = weekStart(day);
  const days = confirmed.map((w) => localDate(w.startMs, tz));
  const sameDay = days.filter((d) => d === day).length, sameWeek = days.filter((d) => weekStart(d) === wk).length;
  if (prefs.max_per_day && sameDay >= prefs.max_per_day) soft.push({ code: 'day_cap', message: `This official takes at most ${prefs.max_per_day} match(es) a day` });
  if (prefs.max_per_week && sameWeek >= prefs.max_per_week) soft.push({ code: 'week_cap', message: `This official takes at most ${prefs.max_per_week} match(es) a week` });
  if (prefs.max_consecutive_days) {
    const set = new Set(days);
    let run = 1;
    for (let d = addDays(day, -1); set.has(d); d = addDays(d, -1)) run++;
    for (let d = addDays(day, 1); set.has(d); d = addDays(d, 1)) run++;
    if (!set.has(day) && run > prefs.max_consecutive_days) soft.push({ code: 'consecutive_days', message: `This official works at most ${prefs.max_consecutive_days} day(s) in a row` });
  }
  const rivals = tentative.filter((w) => w.startMs < endMs + maxBuf && w.endMs > startMs - maxBuf);
  if (rivals.length) (prefs.tentative_policy === 'one_per_slot' ? soft : notes).push({ code: 'tentative_overlap', message: 'This official is already holding another request for that time' });

  return {
    timezone: tz, local_date: day, inside_hours: inside, hard, soft, notes,
    tentative_overlaps: rivals.map((w) => w.fixture_id),
    load: { day: sameDay, week: sameWeek, max_per_day: prefs.max_per_day ?? null, max_per_week: prefs.max_per_week ?? null },
    state: hard.length ? 'unavailable' : soft.length ? 'limited' : (notes.length ? 'check' : 'available'),
  };
}

/**
 * Busy / free for an organiser: when an official cannot be asked, with no title, opponent, venue, reason or note.
 * Adjacent and overlapping spans of the same state are merged.
 */
export async function freeBusy(c, userId, fromMs, toMs, exceptFixtureId = null) {
  const { prefs, rows } = await loadAvailability(c, userId);
  const tz = zoneOf(prefs.timezone);
  const spans = [];
  for (const o of expandBlocks(rows.filter((r) => BLOCK_KINDS.includes(r.kind)), fromMs, toMs, tz)) spans.push({ s: o.startMs, e: o.endMs, state: 'unavailable' });
  for (const w of await nearbyWork(c, userId, fromMs, toMs, exceptFixtureId)) spans.push({ s: w.startMs, e: w.endMs, state: w.confirmed ? 'busy' : 'tentative' });
  const out = [];
  for (const state of ['unavailable', 'busy', 'tentative']) {
    let cur = null;
    for (const x of spans.filter((p) => p.state === state).sort((a, b) => a.s - b.s)) {
      if (cur && x.s <= cur.e) cur.e = Math.max(cur.e, x.e);
      else { if (cur) out.push(cur); cur = { ...x }; }
    }
    if (cur) out.push(cur);
  }
  return {
    timezone: tz,
    spans: out.sort((a, b) => a.s - b.s).map((x) => ({ starts_at: new Date(Math.max(x.s, fromMs)).toISOString(), ends_at: new Date(Math.min(x.e, toMs)).toISOString(), state: x.state })),
  };
}

/** Per local day in [fromDate, toDate]: is the official open, limited (some hours / tentative) or closed. Used by the organiser pool. */
export async function dayStates(c, userId, fromDate, toDate) {
  const { prefs, rows } = await loadAvailability(c, userId);
  const tz = zoneOf(prefs.timezone);
  const fromMs = localToMs(fromDate, 0, tz), toMs = localToMs(toDate, 1440, tz);
  const off = expandBlocks(rows.filter((r) => BLOCK_KINDS.includes(r.kind)), fromMs, toMs, tz);
  const work = await nearbyWork(c, userId, fromMs, toMs);
  const out = {};
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const s = localToMs(d, 0, tz), e = localToMs(d, 1440, tz);
    const blocked = off.filter((o) => o.startMs < e && o.endMs > s);
    const wholeDay = blocked.some((o) => o.startMs <= s && o.endMs >= e);
    const live = weeklyOn(rows, d), hours = live.filter((w) => w.weekday === dow(d));
    const todays = work.filter((w) => w.startMs < e && w.endMs > s);
    let state = 'available';
    if (wholeDay || (live.length && !hours.length)) state = 'unavailable';
    else if (blocked.length || todays.length) state = 'limited';
    else if (!live.length) state = 'unknown';
    out[d] = { state, confirmed: todays.filter((w) => w.confirmed).length, tentative: todays.filter((w) => !w.confirmed).length };
  }
  return { timezone: tz, days: out };
}

/** A coarse distance band, never a number that could be used to find someone's home. */
export function distanceBand(km) {
  if (km == null) return 'unknown';
  return km < 25 ? 'under_25' : km < 50 ? '25_50' : km < 100 ? '50_100' : km < 200 ? '100_200' : km < 400 ? '200_400' : 'over_400';
}
export const BAND_LABEL = { under_25: 'Under 25 km away', '25_50': '25 to 50 km away', '50_100': '50 to 100 km away', '100_200': '100 to 200 km away', '200_400': '200 to 400 km away', over_400: 'Over 400 km away', unknown: 'Distance unknown' };

/** Great-circle km between an official's base (if they recorded one) and a venue. Internal only: callers must band it before returning it. */
export async function travelKm(c, userId, venueId) {
  if (!venueId) return null;
  const r = (await c.query(
    `SELECT (6371 * 2 * asin(sqrt(power(sin(radians(v.latitude - sp.base_lat) / 2), 2) + cos(radians(sp.base_lat)) * cos(radians(v.latitude)) * power(sin(radians(v.longitude - sp.base_lng) / 2), 2)))) AS km
       FROM venues v, sport_profiles sp WHERE v.id=$2 AND sp.user_id=$1 AND sp.base_lat IS NOT NULL AND sp.base_lng IS NOT NULL AND v.latitude IS NOT NULL AND v.longitude IS NOT NULL
      ORDER BY sp.is_default DESC LIMIT 1`, [userId, venueId])).rows[0];
  return r ? Math.round(Number(r.km)) : null;
}
