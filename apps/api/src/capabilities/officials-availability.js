// Official availability and scheduling preferences (#994, REF-R03). The official's own time: weekly hours (optionally per season), one-off
// and recurring time off, public holidays, explicit extra availability, buffers, notice, load caps, preferred sports / levels / roles and a
// coarse travel area. Extends the availability first shipped with Officials Home (#88): same table, same routes, same capability names.
// Rules are enforced by the server through official-availability.js. Nothing here stores a home address or coordinates, an organiser only
// ever gets free / busy with no reason, and every change is versioned and written to an append-only history.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { validZone } from '../ics.js';
import { addDays } from '../booking/time.js';
import { ASSIGNMENT_SQL, OFFICIAL_ROLES } from '../officials.js';
import {
  CATEGORIES, LEVELS, AGE_BANDS, BLOCK_KINDS, BLOCK_COLS, DEFAULT_PREFS, loadAvailability, expandBlocks, weeklyOn, withinHours, assess, freeBusy,
  localDate, localToMs, weekStart, distanceBand, BAND_LABEL, travelKm, NOTE_CTX, noteOf,
} from '../official-availability.js';
import { hasOrgGrant } from '../org-access.js';

const TAG = 'Officials';
const DAY = 864e5, MIN = 60000;
const dt = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const minute = z.number().int().min(0).max(1439), endMinute = z.number().int().min(1).max(1440);
const expected = z.number().int().min(0).optional().describe('the version you loaded; when sent and someone has changed it since, the call is refused with 409 stale_version');
const stale = (current) => conflict('Your availability was changed on another device. The latest version has been loaded; check it and try again', { code: 'stale_version', current_version: current });

const recurrence = z.object({
  starts_on: day, ends_on: day, weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), every_n_weeks: z.number().int().min(1).max(8).default(1),
  start_minute: minute.default(0), end_minute: endMinute.default(1440), exclude_dates: z.array(day).max(120).default([]),
}).refine((r) => r.ends_on >= r.starts_on, 'The pattern must end on or after the day it starts')
  .refine((r) => r.end_minute > r.start_minute, 'The block must end after it starts')
  .refine((r) => r.ends_on <= addDays(r.starts_on, 730), 'A repeating block can run for up to two years');

/** A block as its owner sees it. `note` is the private note; nobody else is ever sent it. */
const blockOut = (r) => ({
  id: r.id, kind: r.kind, category: r.category ?? null, all_day: !!r.all_day, label: r.label ?? null, note: noteOf(r),
  starts_at: r.starts_at ?? null, ends_at: r.ends_at ?? null, timezone: r.timezone ?? null,
  starts_on: r.starts_on ?? null, ends_on: r.ends_on ?? null, weekdays: r.weekdays ?? null, every_n_weeks: r.every_n_weeks ?? 1, exclude_dates: r.exclude_dates ?? [],
  start_minute: r.start_minute ?? null, end_minute: r.end_minute ?? null, holiday_day_id: r.holiday_day_id ?? null, version: r.version, updated_at: r.updated_at,
});
/** What history keeps of a row: its shape, never the note. */
const shape = (r) => (r ? Object.fromEntries(Object.entries(blockOut(r)).filter(([k]) => !['note', 'updated_at'].includes(k))) : null);
const record = (c, userId, actor, entity, entityId, action, before, after) =>
  c.query('INSERT INTO official_availability_history(user_id, actor_id, entity, entity_id, action, before, after) VALUES ($1,$2,$3,$4,$5,$6,$7)', [userId, actor, entity, entityId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);

const myAssignments = (q, userId, where = 'TRUE', args = []) =>
  q.query(`SELECT x.* FROM (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x WHERE ${where} ORDER BY x.scheduled_at, x.id`, [userId, ...args]).then((r) => r.rows);
const brief = (a) => ({ id: a.id, fixture_id: a.fixture_id, status: a.status, role: a.role, scheduled_at: a.scheduled_at, duration_min: a.duration_min, event_name: a.event_name });
const span = (a) => [new Date(a.scheduled_at).getTime(), new Date(a.scheduled_at).getTime() + a.duration_min * MIN];

/** Open (requested or confirmed) upcoming assignments that a set of time-off rows would land on. Nothing is ever dropped for the official. */
async function affectedBy(q, userId, rows, tz) {
  const open = await myAssignments(q, userId, "x.status IN ('invited','accepted') AND x.fixture_status IN ('scheduled','live') AND x.scheduled_at + x.duration_min * interval '1 minute' > now()");
  if (!open.length || !rows.length) return [];
  const last = Math.max(...open.map((a) => span(a)[1]));
  const occ = expandBlocks(rows, Date.now() - DAY, last + DAY, tz);
  return open.filter((a) => { const [s, e] = span(a); return occ.some((o) => o.startMs < e && o.endMs > s); }).map(brief);
}

/** Take the availability document forward one version; refuses a stale writer. Creates the preference row the first time. */
async function bump(c, userId, expectedVersion) {
  const cur = (await c.query('SELECT version FROM official_prefs WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
  if (expectedVersion !== undefined && expectedVersion !== (cur?.version ?? 0)) throw stale(cur?.version ?? 0);
  if (!cur) { await c.query('INSERT INTO official_prefs(user_id) VALUES ($1)', [userId]); return 1; }
  return (await c.query('UPDATE official_prefs SET version=version+1, updated_at=now() WHERE user_id=$1 RETURNING version', [userId])).rows[0].version;
}

const blockInput = {
  starts_at: dt.optional(), ends_at: dt.optional(), recurrence: recurrence.optional(),
  all_day: z.boolean().default(false), category: z.enum(CATEGORIES).optional(),
  note: z.string().trim().max(200).optional().describe('a private note for yourself; stored encrypted and never shown to an organiser'),
};
const oneShape = (i) => {
  const single = !!(i.starts_at && i.ends_at);
  if (single === !!i.recurrence) throw badRequest('Send either starts_at and ends_at (one block) or recurrence (a repeating block)');
  if (single && !(new Date(i.ends_at) > new Date(i.starts_at))) throw badRequest('ends_at must be after starts_at');
  if (single && new Date(i.ends_at) - new Date(i.starts_at) > 366 * DAY) throw badRequest('One block can cover up to a year');
};
/** The row a time-off request would create (without an id), for both the real insert and the dry run. */
const draftRow = (i, tz) => (i.recurrence
  ? { kind: 'recurring', timezone: tz, ...i.recurrence, all_day: i.all_day || (i.recurrence.start_minute === 0 && i.recurrence.end_minute === 1440) }
  : { kind: 'blackout', starts_at: i.starts_at, ends_at: i.ends_at, all_day: i.all_day });

// ------------------------------------------------------------------ read
cap({
  name: 'get_my_official_availability', method: 'GET', path: '/me/officials/availability', tag: TAG,
  summary: 'My availability as a match official: weekly hours, one-off and repeating time off, public holidays, extra open windows, the next 90 days laid out, preferences (sports, levels, roles, age groups, buffers, notice, load caps, coarse travel area) and a load summary. Returns the version to send back when saving.',
  async handler({ user }) {
    const { prefs, rows } = await loadAvailability(pool, user.id);
    const tz = prefs.timezone, now = Date.now();
    const blocks = rows.filter((r) => BLOCK_KINDS.includes(r.kind));
    const upcoming = expandBlocks(blocks, now, now + 90 * DAY, tz);
    const today = localDate(now, tz), wk = weekStart(today);
    const all = await myAssignments(pool, user.id, "x.status IN ('invited','accepted','completed') AND x.scheduled_at > now() - interval '50 days' AND x.scheduled_at < now() + interval '100 days'");
    const open = all.filter((a) => ['invited', 'accepted'].includes(a.status) && ['scheduled', 'live'].includes(a.fixture_status) && span(a)[1] > now);
    const blockedDays = new Set();
    for (const o of upcoming) for (let d = localDate(Math.max(o.startMs, now), tz); d <= localDate(o.endMs - 1, tz); d = addDays(d, 1)) blockedDays.add(d);
    const colliding = open.filter((a) => { const [s, e] = span(a); return upcoming.some((o) => o.startMs < e && o.endMs > s); });
    const outside = open.filter((a) => withinHours(rows, span(a)[0], a.duration_min, tz) === false);
    const live = weeklyOn(rows, today);
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => live.filter((w) => w.weekday === d).reduce((n, w) => n + (w.end_minute - w.start_minute), 0));
    // twelve weeks of real load around today: six behind, this week, five ahead
    const load = [];
    for (let k = -6; k <= 5; k++) {
      const ws = addDays(wk, k * 7);
      const inWeek = all.filter((a) => weekStart(localDate(span(a)[0], tz)) === ws);
      load.push({ week_start: ws, confirmed: inWeek.filter((a) => ['accepted', 'completed'].includes(a.status)).length, tentative: inWeek.filter((a) => a.status === 'invited' && span(a)[1] > now).length });
    }
    if (rows.some((r) => r.note_enc)) await audit(null, user.id, 'official_availability.read_notes', 'official_availability', null);
    return {
      prefs,
      weekly: rows.filter((r) => r.kind === 'weekly').map((r) => ({ id: r.id, weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute, valid_from: r.valid_from, valid_to: r.valid_to })),
      time_off: rows.filter((r) => r.kind === 'blackout' && new Date(r.ends_at).getTime() > now).map(blockOut),
      recurring: rows.filter((r) => r.kind === 'recurring' && r.ends_on >= today).map(blockOut),
      holidays: rows.filter((r) => r.kind === 'holiday' && r.starts_on >= today).map(blockOut),
      extra: rows.filter((r) => r.kind === 'available' && new Date(r.ends_at).getTime() > now).map(blockOut),
      upcoming: upcoming.map((o) => ({ source_id: o.id, kind: o.kind, category: o.category, label: o.label, all_day: o.all_day, starts_at: new Date(o.startMs).toISOString(), ends_at: new Date(o.endMs).toISOString() })),
      summary: {
        open_minutes_week: live.length ? hours.reduce((a, b) => a + b, 0) : null, minutes_by_weekday: hours,
        blocked_days_90: blockedDays.size, tentative_holds: open.filter((a) => a.status === 'invited').length, confirmed_upcoming: open.filter((a) => a.status === 'accepted').length,
        conflicts: colliding.length, outside_hours: outside.length,
        this_week: { confirmed: load[6].confirmed, tentative: load[6].tentative, cap: prefs.max_per_week ?? null },
        load,
      },
      attention: [...colliding.map((a) => ({ ...brief(a), issue: 'time_off' })), ...outside.filter((a) => !colliding.includes(a)).map((a) => ({ ...brief(a), issue: 'outside_hours' }))],
      options: { categories: CATEGORIES, levels: LEVELS, roles: OFFICIAL_ROLES, age_bands: AGE_BANDS, outside_hours_policies: ['warn', 'block'], tentative_policies: ['allow', 'one_per_slot'] },
      privacy: { organisers_see: ['free_busy', 'coarse_region', 'distance_band', 'preferred_sports_levels_roles'], organisers_never_see: ['notes', 'reasons', 'home_address', 'coordinates', 'other_match_details'] },
    };
  },
});

// ------------------------------------------------------------------ preferences
cap({
  name: 'save_my_official_prefs', method: 'POST', path: '/me/officials/availability/prefs', tag: TAG,
  summary: 'Set my timezone, the gap I need between matches (a shorter one when both are at the same venue), minimum notice, daily / weekly / consecutive-day caps, how requests outside my hours and overlapping requests are treated, my travel range and coarse region, and the sports, levels, roles and age groups I prefer. Enforced on the server when I am asked or confirmed. Send expected_version to guard against a change from another device.',
  input: z.object({
    timezone: z.string().min(1).max(60), buffer_min: z.number().int().min(0).max(240).default(0), travel_km: z.number().int().min(1).max(1000).nullable().optional(),
    region: z.string().trim().max(80).nullable().optional().describe('a city or area, never an address'), sport_ids: z.array(id).max(30).default([]), levels: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
    buffer_same_venue_min: z.number().int().min(0).max(240).nullable().optional(), min_notice_hours: z.number().int().min(0).max(336).optional(),
    max_per_day: z.number().int().min(1).max(12).nullable().optional(), max_per_week: z.number().int().min(1).max(40).nullable().optional(), max_consecutive_days: z.number().int().min(1).max(14).nullable().optional(),
    outside_hours_policy: z.enum(['warn', 'block']).optional(), tentative_policy: z.enum(['allow', 'one_per_slot']).optional(),
    roles: z.array(z.enum(OFFICIAL_ROLES)).max(OFFICIAL_ROLES.length).optional(), age_bands: z.array(z.enum(AGE_BANDS)).max(AGE_BANDS.length).optional(),
    country: z.string().trim().min(2).max(60).nullable().optional().describe('used to offer public holidays'), expected_version: expected,
  }),
  async handler({ user }, i) {
    if (!validZone(i.timezone)) throw badRequest('That is not a known timezone');
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM official_prefs WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0];
      if (i.expected_version !== undefined && i.expected_version !== (cur?.version ?? 0)) throw stale(cur?.version ?? 0);
      const legacy = new Set(cur?.levels ?? []);
      const bad = i.levels.find((l) => !LEVELS.includes(l) && !legacy.has(l));
      if (bad) throw badRequest(`Unknown level: ${bad}`);
      if (i.sport_ids.length) {
        const known = (await c.query('SELECT count(*)::int AS n FROM sports WHERE id = ANY($1::uuid[])', [i.sport_ids])).rows[0].n;
        if (known !== new Set(i.sport_ids).size) throw badRequest('One of those sports is not in the catalogue');
      }
      const keep = (k) => (i[k] !== undefined ? i[k] : (cur ? cur[k] : DEFAULT_PREFS[k]));
      const v = {
        buffer_same_venue_min: keep('buffer_same_venue_min'), min_notice_hours: keep('min_notice_hours') ?? 0, max_per_day: keep('max_per_day'), max_per_week: keep('max_per_week'),
        max_consecutive_days: keep('max_consecutive_days'), outside_hours_policy: keep('outside_hours_policy'), tentative_policy: keep('tentative_policy'), roles: keep('roles'), age_bands: keep('age_bands'), country: keep('country'),
      };
      const row = (await c.query(
        `INSERT INTO official_prefs(user_id, timezone, buffer_min, travel_km, region, sport_ids, levels, buffer_same_venue_min, min_notice_hours, max_per_day, max_per_week, max_consecutive_days, outside_hours_policy, tentative_policy, roles, age_bands, country)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (user_id) DO UPDATE SET timezone=$2, buffer_min=$3, travel_km=$4, region=$5, sport_ids=$6, levels=$7, buffer_same_venue_min=$8, min_notice_hours=$9, max_per_day=$10, max_per_week=$11,
           max_consecutive_days=$12, outside_hours_policy=$13, tentative_policy=$14, roles=$15, age_bands=$16, country=$17, version=official_prefs.version+1, updated_at=now() RETURNING *`,
        [user.id, i.timezone, i.buffer_min, i.travel_km ?? null, i.region || null, [...new Set(i.sport_ids)], [...new Set(i.levels)], v.buffer_same_venue_min, v.min_notice_hours, v.max_per_day, v.max_per_week,
          v.max_consecutive_days, v.outside_hours_policy, v.tentative_policy, [...new Set(v.roles)], [...new Set(v.age_bands)], v.country || null])).rows[0];
      await record(c, user.id, user.id, 'prefs', null, cur ? 'updated' : 'created', cur ?? null, row);
      return row;
    });
  },
});

// ------------------------------------------------------------------ weekly hours
const weeklyWindow = z.object({ weekday: z.number().int().min(0).max(6), start_minute: minute, end_minute: endMinute, valid_from: day.nullable().optional(), valid_to: day.nullable().optional() })
  .refine((w) => w.end_minute > w.start_minute, 'A window must end after it starts')
  .refine((w) => !w.valid_from || !w.valid_to || w.valid_to >= w.valid_from, 'A season must end on or after the day it starts');

cap({
  name: 'set_my_weekly_availability', method: 'POST', path: '/me/officials/availability/weekly', tag: TAG,
  summary: 'Replace my weekly hours (weekday 0 = Sunday, minutes from local midnight in my timezone, so they keep their local time across daylight saving). A window may be limited to a season with valid_from / valid_to. Earlier windows are archived, not deleted. An empty list means "no weekly restriction". Send expected_version to guard against a change from another device.',
  input: z.object({ windows: z.array(weeklyWindow).max(56), expected_version: expected }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await bump(c, user.id, i.expected_version);
      const before = (await c.query("SELECT weekday, start_minute, end_minute, valid_from::text AS valid_from, valid_to::text AS valid_to FROM official_availability WHERE user_id=$1 AND kind='weekly' AND archived_at IS NULL ORDER BY weekday, start_minute", [user.id])).rows;
      await c.query("UPDATE official_availability SET archived_at=now(), updated_at=now() WHERE user_id=$1 AND kind='weekly' AND archived_at IS NULL", [user.id]);
      for (const w of i.windows) await c.query("INSERT INTO official_availability(user_id, kind, weekday, start_minute, end_minute, valid_from, valid_to) VALUES ($1,'weekly',$2,$3,$4,$5,$6)", [user.id, w.weekday, w.start_minute, w.end_minute, w.valid_from ?? null, w.valid_to ?? null]);
      const rows = (await c.query("SELECT id, weekday, start_minute, end_minute, valid_from::text AS valid_from, valid_to::text AS valid_to FROM official_availability WHERE user_id=$1 AND kind='weekly' AND archived_at IS NULL ORDER BY weekday, start_minute", [user.id])).rows;
      await record(c, user.id, user.id, 'weekly', null, 'replaced', { windows: before }, { windows: rows.map(({ id: _id, ...w }) => w) });
      return rows;
    });
  },
});

// ------------------------------------------------------------------ time off
cap({
  name: 'add_my_time_off', method: 'POST', path: '/me/officials/availability/time-off', tag: TAG, status: 201,
  summary: 'Block time: one period (starts_at / ends_at) or a repeating pattern (recurrence: weekdays, every n weeks, local start and end minutes, between two local dates, minus excluded dates). Give it a category if you like; no reason is ever shared and the note is private and encrypted. Returns any requested or confirmed matches that fall inside it so you can withdraw from them; it never silently drops an assignment. An idempotency_key makes a retry return the same block.',
  input: z.object({ ...blockInput, idempotency_key: z.string().trim().min(8).max(80).optional() }),
  async handler({ user }, i) {
    oneShape(i);
    return tx(async (c) => {
      if (i.idempotency_key) {
        const dup = (await c.query(`SELECT ${BLOCK_COLS} FROM official_availability WHERE user_id=$1 AND idempotency_key=$2`, [user.id, i.idempotency_key])).rows[0];
        if (dup) return { ...blockOut(dup), replayed: true, affected_assignments: await affectedBy(c, user.id, [dup], dup.timezone ?? 'UTC') };
      }
      const tz = (await c.query('SELECT timezone FROM official_prefs WHERE user_id=$1', [user.id])).rows[0]?.timezone ?? 'UTC';
      const d = draftRow(i, tz);
      const row = (await c.query(
        `INSERT INTO official_availability(user_id, kind, starts_at, ends_at, timezone, starts_on, ends_on, weekdays, every_n_weeks, start_minute, end_minute, exclude_dates, all_day, category, note_enc, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${BLOCK_COLS}`,
        [user.id, d.kind, d.starts_at ?? null, d.ends_at ?? null, d.timezone ?? null, d.starts_on ?? null, d.ends_on ?? null, d.weekdays ? [...new Set(d.weekdays)].sort() : null, d.every_n_weeks ?? 1,
          d.kind === 'recurring' ? d.start_minute : null, d.kind === 'recurring' ? d.end_minute : null, d.exclude_dates ?? [], d.all_day, i.category ?? null, encrypt(i.note ?? null, NOTE_CTX), i.idempotency_key ?? null])).rows[0];
      await record(c, user.id, user.id, 'block', row.id, 'created', null, shape(row));
      return { ...blockOut(row), affected_assignments: await affectedBy(c, user.id, [row], tz) };
    });
  },
});

cap({
  name: 'update_my_time_off', method: 'PATCH', path: '/me/officials/availability/:id', tag: TAG,
  summary: 'Change a time-off block: its period or pattern, category, all-day flag or private note, or skip single dates of a repeating block (skip_dates). Needs the version you loaded; a change made elsewhere in the meantime is refused with 409 stale_version. The earlier shape is kept in the history.',
  input: z.object({
    id, expected_version: z.number().int().min(1), starts_at: dt.optional(), ends_at: dt.optional(), recurrence: recurrence.optional(), all_day: z.boolean().optional(),
    category: z.enum(CATEGORIES).nullable().optional(), note: z.string().trim().max(200).nullable().optional(), skip_dates: z.array(day).max(60).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query(`SELECT ${BLOCK_COLS} FROM official_availability WHERE id=$1 AND user_id=$2 AND archived_at IS NULL AND kind IN ('blackout','recurring','available') FOR UPDATE`, [i.id, user.id])).rows[0];
      if (!cur) throw notFound('time off');
      if (cur.version !== i.expected_version) throw stale(cur.version);
      const n = { ...cur };
      if (cur.kind === 'recurring') {
        if (i.starts_at || i.ends_at) throw badRequest('This is a repeating block: change its recurrence');
        if (i.recurrence) Object.assign(n, i.recurrence);
        if (i.skip_dates) n.exclude_dates = [...new Set([...(n.exclude_dates ?? []), ...i.skip_dates])].sort();
        if (n.exclude_dates.length > 120) throw badRequest('Too many skipped dates; end the pattern and start a new one');
      } else {
        if (i.recurrence || i.skip_dates) throw badRequest('This is a one-off block: change starts_at and ends_at');
        n.starts_at = i.starts_at ?? cur.starts_at; n.ends_at = i.ends_at ?? cur.ends_at;
        if (!(new Date(n.ends_at) > new Date(n.starts_at))) throw badRequest('ends_at must be after starts_at');
      }
      if (i.all_day !== undefined) n.all_day = i.all_day;
      if (i.category !== undefined) n.category = i.category;
      const noteEnc = i.note !== undefined ? encrypt(i.note, NOTE_CTX) : (cur.note_enc ?? encrypt(cur.note, NOTE_CTX));
      const row = (await c.query(
        `UPDATE official_availability SET starts_at=$2, ends_at=$3, starts_on=$4, ends_on=$5, weekdays=$6, every_n_weeks=$7, start_minute=$8, end_minute=$9, exclude_dates=$10, all_day=$11, category=$12, note_enc=$13,
                version=version+1, updated_at=now() WHERE id=$1 RETURNING ${BLOCK_COLS}`,
        [cur.id, n.starts_at ?? null, n.ends_at ?? null, n.starts_on ?? null, n.ends_on ?? null, n.weekdays ?? null, n.every_n_weeks ?? 1, n.start_minute ?? null, n.end_minute ?? null, n.exclude_dates ?? [], n.all_day, n.category ?? null, noteEnc])).rows[0];
      await record(c, user.id, user.id, 'block', row.id, 'updated', shape(cur), shape(row));
      return { ...blockOut(row), affected_assignments: cur.kind === 'available' ? [] : await affectedBy(c, user.id, [row], row.timezone ?? 'UTC') };
    });
  },
});

cap({
  name: 'remove_my_time_off', method: 'POST', path: '/me/officials/availability/:id/remove', tag: TAG,
  summary: 'Remove a time-off block, a repeating block, a public holiday or an extra open window (it is archived, so the history is kept).',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query(`SELECT ${BLOCK_COLS} FROM official_availability WHERE id=$1 AND user_id=$2 AND kind IN ('blackout','recurring','holiday','available') AND archived_at IS NULL FOR UPDATE`, [i.id, user.id])).rows[0];
      if (!cur) throw notFound('time off');
      await c.query('UPDATE official_availability SET archived_at=now(), updated_at=now() WHERE id=$1', [cur.id]);
      await record(c, user.id, user.id, 'block', cur.id, 'removed', shape(cur), null);
      return { id: cur.id, removed: true };
    });
  },
});

cap({
  name: 'add_my_holiday_windows', method: 'POST', path: '/me/officials/availability/holidays', tag: TAG, status: 201,
  summary: 'Take public holidays off: choose days from the public-holiday calendar (list_holidays) and each becomes a whole local day you are unavailable. A holiday already taken is skipped, so repeating the call is safe. Returns matches that fall on those days.',
  input: z.object({ holiday_ids: z.array(id).min(1).max(60) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const days = (await c.query('SELECT id, on_date::text AS on_date, label FROM holiday_calendar_days WHERE id = ANY($1::uuid[]) AND removed_at IS NULL ORDER BY on_date, id', [i.holiday_ids])).rows;
      if (days.length !== new Set(i.holiday_ids).size) throw notFound('holiday');
      const tz = (await c.query('SELECT timezone FROM official_prefs WHERE user_id=$1', [user.id])).rows[0]?.timezone ?? 'UTC';
      const added = [];
      for (const d of days) {
        const row = (await c.query(
          `INSERT INTO official_availability(user_id, kind, starts_on, timezone, all_day, category, label, holiday_day_id) VALUES ($1,'holiday',$2,$3,true,'holiday',$4,$5)
           ON CONFLICT (user_id, holiday_day_id) WHERE holiday_day_id IS NOT NULL AND archived_at IS NULL DO NOTHING RETURNING ${BLOCK_COLS}`, [user.id, d.on_date, tz, d.label, d.id])).rows[0];
        if (row) { added.push(row); await record(c, user.id, user.id, 'block', row.id, 'created', null, shape(row)); }
      }
      return { added: added.map(blockOut), skipped: days.length - added.length, affected_assignments: await affectedBy(c, user.id, added, tz) };
    });
  },
});

cap({
  name: 'add_my_extra_availability', method: 'POST', path: '/me/officials/availability/open', tag: TAG, status: 201,
  summary: 'Open a one-off window outside my weekly hours (for example a tournament weekend). Organisers see me as available then; time off and confirmed matches still take priority.',
  input: z.object({ starts_at: dt, ends_at: dt, idempotency_key: z.string().trim().min(8).max(80).optional() }),
  async handler({ user }, i) {
    if (!(new Date(i.ends_at) > new Date(i.starts_at))) throw badRequest('ends_at must be after starts_at');
    if (new Date(i.ends_at) - new Date(i.starts_at) > 31 * DAY) throw badRequest('An extra window can cover up to a month');
    return tx(async (c) => {
      if (i.idempotency_key) {
        const dup = (await c.query(`SELECT ${BLOCK_COLS} FROM official_availability WHERE user_id=$1 AND idempotency_key=$2`, [user.id, i.idempotency_key])).rows[0];
        if (dup) return { ...blockOut(dup), replayed: true };
      }
      const row = (await c.query(`INSERT INTO official_availability(user_id, kind, starts_at, ends_at, idempotency_key) VALUES ($1,'available',$2,$3,$4) RETURNING ${BLOCK_COLS}`, [user.id, i.starts_at, i.ends_at, i.idempotency_key ?? null])).rows[0];
      await record(c, user.id, user.id, 'block', row.id, 'created', null, shape(row));
      return blockOut(row);
    });
  },
});

// ------------------------------------------------------------------ dry run + history
cap({
  name: 'preview_my_availability_change', method: 'POST', path: '/me/officials/availability/preview', tag: TAG,
  summary: 'Dry run, nothing is saved: what a time-off block, a set of public holidays or new weekly hours would do. Returns the dates it lands on and the requested or confirmed matches it would collide with, so I can decide before saving.',
  input: z.object({ time_off: z.object({ starts_at: dt.optional(), ends_at: dt.optional(), recurrence: recurrence.optional(), all_day: z.boolean().default(false) }).optional(), holiday_ids: z.array(id).min(1).max(60).optional(), weekly: z.array(weeklyWindow).max(56).optional() }),
  async handler({ user }, i) {
    if ([i.time_off, i.holiday_ids, i.weekly].filter(Boolean).length !== 1) throw badRequest('Send exactly one of time_off, holiday_ids or weekly');
    const { prefs, rows } = await loadAvailability(pool, user.id);
    const tz = prefs.timezone, now = Date.now();
    if (i.weekly) {
      const draft = [...rows.filter((r) => r.kind !== 'weekly'), ...i.weekly.map((w) => ({ kind: 'weekly', ...w }))];
      const open = await myAssignments(pool, user.id, "x.status IN ('invited','accepted') AND x.fixture_status IN ('scheduled','live') AND x.scheduled_at > now()");
      return { occurrences: [], total_occurrences: 0, affected_assignments: open.filter((a) => withinHours(draft, span(a)[0], a.duration_min, tz) === false).map(brief), open_minutes_week: i.weekly.reduce((n, w) => n + (w.end_minute - w.start_minute), 0) };
    }
    let draft;
    if (i.time_off) { oneShape(i.time_off); draft = [{ id: null, ...draftRow(i.time_off, tz) }]; }
    else {
      const days = await many('SELECT id, on_date::text AS on_date, label FROM holiday_calendar_days WHERE id = ANY($1::uuid[]) AND removed_at IS NULL', [i.holiday_ids]);
      draft = days.map((d) => ({ id: d.id, kind: 'holiday', starts_on: d.on_date, timezone: tz, label: d.label }));
    }
    const occ = expandBlocks(draft, now - DAY, now + 731 * DAY, tz);
    return {
      occurrences: occ.slice(0, 24).map((o) => ({ starts_at: new Date(o.startMs).toISOString(), ends_at: new Date(o.endMs).toISOString(), label: o.label })), total_occurrences: occ.length,
      affected_assignments: await affectedBy(pool, user.id, draft, tz),
    };
  },
});

cap({
  name: 'list_my_availability_history', method: 'GET', path: '/me/officials/availability/history', tag: TAG,
  summary: 'The append-only record of changes to my availability and preferences: what changed, when and by whom. Private notes are never part of it.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT h.id, h.entity, h.entity_id, h.action, h.before, h.after, h.at, h.actor_id, (h.actor_id = h.user_id) AS by_me
       FROM official_availability_history h WHERE h.user_id=$1 ORDER BY h.at DESC, h.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

// ------------------------------------------------------------------ insights: earnings forecast, season workload, AI scheduler hint
cap({
  name: 'get_my_availability_insights', method: 'GET', path: '/me/officials/availability/insights', tag: TAG,
  summary: 'Earnings forecast (confirmed + tentative assignments × the official\'s active rate card, by currency), season workload ring (confirmed / pending / remaining slots across the current season), and an AI scheduler hint when patterns warrant one (back-to-back weekends, approaching weekly cap, travel-heavy stretches). Read-only; never exposes a home address or exact location.',
  async handler({ user }) {
    const now = Date.now();
    const { prefs } = await loadAvailability(pool, user.id);
    const tz = prefs.timezone ?? 'UTC';

    // ── upcoming open assignments (next 90 days) ──────────────────────────────
    const upcoming = await pool.query(
      `SELECT x.id, x.fixture_id, x.status, x.fixture_status, x.scheduled_at, x.duration_min, x.sport_id, x.event_name
         FROM (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x
        WHERE x.status IN ('invited','accepted') AND x.fixture_status IN ('scheduled','live')
          AND x.scheduled_at > now() AND x.scheduled_at < now() + interval '90 days'
        ORDER BY x.scheduled_at`,
      [user.id],
    ).then((r) => r.rows);

    const confirmed = upcoming.filter((a) => a.status === 'accepted');
    const tentative = upcoming.filter((a) => a.status === 'invited');

    // ── earnings forecast: use the official's first active rate card per sport/currency ──
    const rateRows = await pool.query(
      `SELECT sport_id, fee_minor, fee_currency FROM official_profile_rates
        WHERE user_id=$1 AND status='active' ORDER BY created_at DESC`,
      [user.id],
    ).then((r) => r.rows);
    const rateMap = new Map(); // sport_id → { fee_minor, fee_currency }
    for (const r of rateRows) if (!rateMap.has(r.sport_id)) rateMap.set(r.sport_id, r);

    const totals = new Map(); // currency → { confirmed_minor, tentative_minor }
    for (const a of confirmed) {
      const rate = rateMap.get(a.sport_id);
      if (!rate) continue;
      const e = totals.get(rate.fee_currency) ?? { confirmed_minor: 0, tentative_minor: 0 };
      e.confirmed_minor += Number(rate.fee_minor);
      totals.set(rate.fee_currency, e);
    }
    for (const a of tentative) {
      const rate = rateMap.get(a.sport_id);
      if (!rate) continue;
      const e = totals.get(rate.fee_currency) ?? { confirmed_minor: 0, tentative_minor: 0 };
      e.tentative_minor += Number(rate.fee_minor);
      totals.set(rate.fee_currency, e);
    }
    const earnings = [...totals.entries()].map(([currency, e]) => ({
      currency, confirmed_minor: e.confirmed_minor, tentative_minor: e.tentative_minor,
      total_minor: e.confirmed_minor + e.tentative_minor,
    }));

    // ── season workload: current season = last 120 days + next 180 days ────────
    const seasonAll = await pool.query(
      `SELECT x.id, x.status, x.fixture_status, x.scheduled_at FROM (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x
        WHERE x.scheduled_at > now() - interval '120 days' AND x.scheduled_at < now() + interval '180 days'
        ORDER BY x.scheduled_at`,
      [user.id],
    ).then((r) => r.rows);
    const season_confirmed = seasonAll.filter((a) => a.status === 'accepted').length;
    const season_pending   = seasonAll.filter((a) => a.status === 'invited').length;
    const season_total     = season_confirmed + season_pending;
    const season_pct       = season_total === 0 ? 0 : Math.round((season_confirmed / season_total) * 100);

    // ── 12-week load for AI hint ───────────────────────────────────────────────
    const weekLoad = await pool.query(
      `SELECT date_trunc('week', x.scheduled_at AT TIME ZONE 'UTC')::date AS week_start,
              COUNT(*) FILTER (WHERE x.status='accepted') AS confirmed,
              COUNT(*) FILTER (WHERE x.status='invited')  AS tentative
         FROM (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x
        WHERE x.scheduled_at > now() - interval '6 weeks' AND x.scheduled_at < now() + interval '6 weeks'
          AND x.fixture_status IN ('scheduled','live')
        GROUP BY 1 ORDER BY 1`,
      [user.id],
    ).then((r) => r.rows.map((w) => ({ week_start: w.week_start, confirmed: Number(w.confirmed), tentative: Number(w.tentative) })));

    // ── AI scheduler hint ─────────────────────────────────────────────────────
    // Simple rule engine — no ML; pure deterministic analysis.
    const hints = [];
    const cap = prefs.max_per_week;
    const future = weekLoad.filter((w) => new Date(w.week_start).getTime() >= now - 7 * DAY);
    const overCap = cap ? future.filter((w) => w.confirmed + w.tentative >= cap) : [];
    if (overCap.length >= 2) hints.push('approaching_cap');
    // consecutive weekend blocks
    let backToBack = 0, maxBtB = 0;
    for (const w of future) { if (w.confirmed + w.tentative >= 2) backToBack++; else backToBack = 0; maxBtB = Math.max(maxBtB, backToBack); }
    if (maxBtB >= 3) hints.push('back_to_back_weekends');
    // heavy stretch: any 2 consecutive weeks ≥ 6
    for (let i = 0; i < future.length - 1; i++) {
      if (future[i].confirmed + future[i + 1].confirmed >= 12) { hints.push('heavy_stretch'); break; }
    }

    return {
      earnings,
      season: { confirmed: season_confirmed, pending: season_pending, total: season_total, pct: season_pct },
      week_load: weekLoad,
      scheduler_hint: hints.length ? hints[0] : null,
      scheduler_hints: hints,
    };
  },
});

// ------------------------------------------------------------------ the organiser's view
cap({
  name: 'get_fixture_official_availability', method: 'GET', path: '/fixtures/:id/officials/:user_id/availability', tag: TAG,
  summary: 'For the organiser of a fixture: can this official be asked for it? Returns free / busy around the match (no titles, opponents, venues, reasons or notes), whether the slot is open, limited or unavailable and why in plain terms, their load against their own caps, a coarse region and a distance band (never an address, coordinates or an exact distance), and whether the sport, role and level match what they prefer. Each look is audit-logged. Anyone who does not run the event gets 404.',
  input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    const f = await one('SELECT f.*, r.venue_id FROM fixtures f LEFT JOIN resources r ON r.id=f.resource_id WHERE f.id=$1', [i.id]);
    if (!f) throw notFound('fixture');
    const ev = await one('SELECT * FROM events WHERE id=$1', [f.event_id]);
    const runs = isAdmin(user) || ev.organizer_id === user.id || await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin']);
    if (!runs) throw notFound('fixture');
    const who = await one(
      `SELECT u.id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color FROM users u
        WHERE u.id=$1 AND (EXISTS (SELECT 1 FROM active_sport_profiles p WHERE p.user_id=u.id AND p.role='referee' AND p.sport_id=$2)
           OR EXISTS (SELECT 1 FROM fixture_officials fo WHERE fo.fixture_id=$3 AND fo.user_id=u.id))`, [i.user_id, ev.sport_id, f.id]);
    if (!who) throw notFound('official');
    const a = await assess(pool, { userId: who.id, start: f.scheduled_at, durationMin: f.duration_min, fixtureId: f.id, venueId: f.venue_id ?? null });
    const { prefs, saved } = await loadAvailability(pool, who.id);
    const fromMs = localToMs(addDays(a.local_date, -1), 0, a.timezone), toMs = localToMs(addDays(a.local_date, 1), 1440, a.timezone);
    const fb = await freeBusy(pool, who.id, fromMs, toMs, f.id);
    const km = await travelKm(pool, who.id, f.venue_id);
    const band = distanceBand(km);
    await audit(null, user.id, 'official_availability.view', 'user', who.id);
    return {
      official: who, timezone: a.timezone, has_set_availability: saved,
      fixture: { id: f.id, scheduled_at: f.scheduled_at, duration_min: f.duration_min, official_local_date: a.local_date },
      state: a.state, inside_hours: a.inside_hours,
      reasons: [...a.hard.map((r) => ({ ...r, level: 'blocked' })), ...a.soft.map((r) => ({ ...r, level: 'limit' })), ...a.notes.map((r) => ({ ...r, level: 'note' }))],
      load: a.load, min_notice_hours: prefs.min_notice_hours ?? 0, buffer_min: prefs.buffer_min ?? 0,
      free_busy: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), spans: fb.spans },
      travel: { region: prefs.region ?? null, band, band_label: BAND_LABEL[band], within_range: km == null || prefs.travel_km == null ? null : km <= prefs.travel_km },
      preferences: {
        sport: prefs.sport_ids?.length ? prefs.sport_ids.includes(ev.sport_id) : null, levels: prefs.levels ?? [], roles: prefs.roles ?? [], age_bands: prefs.age_bands ?? [],
      },
    };
  },
});
