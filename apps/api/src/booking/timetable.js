// Timetable plumbing shared by the capabilities: windows, carving a range, syncing opening hours, inheriting a sibling's timetable.
import { randomUUID } from 'node:crypto';
import { conflict } from '../errors.js';
import { fmtMin } from './time.js';

const same = (a, b) => (a ?? null) === (b ?? null);
export const dateKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export const view = (w) => ({ id: w.id, resource_id: w.resource_id, category_id: w.category_id, weekdays: w.weekdays, start: fmtMin(w.start_min), end: fmtMin(w.end_min), valid_from: dateKey(w.valid_from), valid_to: dateKey(w.valid_to) });

export const insertWindow = (c, v, w) => c.query(
  'INSERT INTO schedule_windows(venue_id, resource_id, category_id, weekdays, start_min, end_min, valid_from, valid_to, batch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [v, w.resource_id, w.category_id ?? null, [...w.weekdays].sort(), w.start_min, w.end_min, w.valid_from ?? null, w.valid_to ?? null, w.batch_id ?? null]);

/** The venue's opening hours follow the timetable: the union of every window, per weekday. */
export async function syncHours(c, venueId) {
  if (!(await c.query('SELECT 1 FROM venues WHERE id=$1 AND timetable_enabled', [venueId])).rowCount) return; // venues without a timetable keep their own opening hours
  const { rows } = await c.query('SELECT weekdays, start_min, end_min FROM schedule_windows WHERE venue_id=$1 AND removed_at IS NULL', [venueId]);
  await c.query('UPDATE venue_hours SET removed_at=now() WHERE venue_id=$1 AND removed_at IS NULL', [venueId]);
  for (let d = 0; d < 7; d++) {
    const iv = rows.filter((w) => w.weekdays.includes(d)).map((w) => [w.start_min, w.end_min]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [o, e] of iv) { const l = merged[merged.length - 1]; if (l && o <= l[1]) l[1] = Math.max(l[1], e); else merged.push([o, e]); }
    for (const [o, e] of merged) await c.query('INSERT INTO venue_hours(venue_id, weekday, opens_min, closes_min) VALUES ($1,$2,$3,$4)', [venueId, d, o, e]);
  }
}

/** First time a venue uses the timetable: its existing opening hours become windows on every court, so nothing closes by surprise. */
export async function enableTimetable(c, venueId) {
  const v = (await c.query('SELECT timetable_enabled FROM venues WHERE id=$1 FOR UPDATE', [venueId])).rows[0];
  if (v.timetable_enabled) return;
  const hours = (await c.query('SELECT weekday, opens_min, closes_min FROM venue_hours WHERE venue_id=$1 AND removed_at IS NULL', [venueId])).rows;
  const courts = (await c.query('SELECT id FROM resources WHERE venue_id=$1 AND active', [venueId])).rows;
  const batch = randomUUID();
  const spans = hours.map((h) => ({ weekdays: [h.weekday], start_min: h.opens_min, end_min: h.closes_min })); // no hours set (open around the clock by default) = start from an empty timetable
  for (const r of courts) for (const s of spans) await insertWindow(c, venueId, { ...s, resource_id: r.id, batch_id: batch });
  await c.query('UPDATE venues SET timetable_enabled=true WHERE id=$1', [venueId]);
}

/** Open (or close) `scope` courts for [start,end) on `days`, carving whatever was there in the same date scope. Returns what changed. */
export async function carve(c, venueId, resourceId, { days, start, end, categoryId, closed, valid_from, valid_to, replace, batch }) {
  const { rows } = await c.query('SELECT * FROM schedule_windows WHERE venue_id=$1 AND removed_at IS NULL AND resource_id=$2 FOR UPDATE', [venueId, resourceId]);
  let removed = 0;
  for (const w of rows) {
    if (!same(dateKey(w.valid_from), valid_from) || !same(dateKey(w.valid_to), valid_to)) continue;
    const both = w.weekdays.filter((d) => days.includes(d));
    if (!both.length || w.start_min >= end || w.end_min <= start) continue;
    if (!replace) throw conflict('That overlaps slots you already set up — choose "replace" to overwrite them');
    await c.query('UPDATE schedule_windows SET removed_at=now() WHERE id=$1', [w.id]);
    removed++;
    const keep = { resource_id: w.resource_id, category_id: w.category_id, valid_from: dateKey(w.valid_from), valid_to: dateKey(w.valid_to) };
    const rest = w.weekdays.filter((d) => !days.includes(d));
    if (rest.length) await insertWindow(c, venueId, { ...keep, weekdays: rest, start_min: w.start_min, end_min: w.end_min });
    if (w.start_min < start) await insertWindow(c, venueId, { ...keep, weekdays: both, start_min: w.start_min, end_min: start });
    if (w.end_min > end) await insertWindow(c, venueId, { ...keep, weekdays: both, start_min: end, end_min: w.end_min });
  }
  if (!closed) await insertWindow(c, venueId, { resource_id: resourceId, category_id: categoryId, weekdays: days, start_min: start, end_min: end, valid_from, valid_to, batch_id: batch });
  return removed;
}

/** A new court gets the timetable of a sibling (same kind, else any) so it is bookable straight away. */
export async function inheritTimetable(c, venueId, resourceId, fromId) {
  const v = (await c.query('SELECT timetable_enabled FROM venues WHERE id=$1', [venueId])).rows[0];
  if (!v?.timetable_enabled) return 0;
  const src = fromId ?? (await c.query(
    `SELECT r.id FROM resources r WHERE r.venue_id=$1 AND r.active AND r.id <> $2 AND EXISTS (SELECT 1 FROM schedule_windows w WHERE w.resource_id=r.id AND w.removed_at IS NULL)
      ORDER BY (r.kind = (SELECT kind FROM resources WHERE id=$2)) DESC, r.created_at LIMIT 1`, [venueId, resourceId])).rows[0]?.id;
  if (!src) return 0;
  const { rows } = await c.query('SELECT * FROM schedule_windows WHERE resource_id=$1 AND removed_at IS NULL', [src]);
  for (const w of rows) await insertWindow(c, venueId, { ...w, resource_id: resourceId, valid_from: dateKey(w.valid_from), valid_to: dateKey(w.valid_to) });
  return rows.length;
}

