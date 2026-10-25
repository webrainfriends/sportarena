import { z } from 'zod';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { cap, id } from '../registry.js';
import { one, many, tx, query } from '../db.js';
import { badRequest, conflict, forbidden, notFound, AppError } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit } from '../helpers.js';
import { newOpaqueToken, sha256, encrypt, decrypt } from '../crypto.js';
import { guardianLink, hasConsent, isYouth, requireConsent } from '../youth.js';
import { config } from '../config.js';
import { fetchIcs, localParts, normalizeCalendarUrl, parseBusy, validZone, writeIcs } from '../ics.js';
import { buildSchedule } from './athlete-schedule.js';

const TAG = 'Calendar sync';
const DAY = 86400000;
const FEED_KINDS = ['match', 'team', 'event', 'venue', 'training', 'health', 'duty', 'recovery'];
const BUFFER_KINDS = ['match', 'team', 'event', 'venue', 'training', 'duty'];
const zone = z.string().max(64).refine(validZone, 'Unknown time zone');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const athlete = { athlete_id: id.optional().describe('For a verified guardian: the young person this is about') };

/**
 * Whose calendar is this call about? Yourself, or a young person you are a verified guardian of (anything else is a 404, so existence is not leaked).
 * `sharing` is true for outbound feeds and inbound imports: a young person cannot arrange those alone, and a guardian needs current consent.
 */
async function subjectOf(user, athleteId, sharing = false) {
  if (!athleteId || athleteId === user.id) {
    if (sharing && await isYouth(user.id)) throw forbidden('A parent or guardian needs to arrange calendar sharing for you');
    return user.id;
  }
  if (!(await guardianLink(user.id, athleteId))) throw notFound('Athlete');
  if (sharing) await requireConsent(athleteId, 'calendar_sharing', 'calendar sharing');
  return athleteId;
}
/** A row you own, or one of a young person you are a verified guardian of. */
async function manageable(user, table, rowId, what) {
  const r = await one(`SELECT * FROM ${table} WHERE id=$1`, [rowId]);
  if (!r || (r.user_id !== user.id && !(await guardianLink(user.id, r.user_id)))) throw notFound(what);
  return r;
}
const apiBase = () => String(config.apiUrl ?? config.appUrl ?? '').replace(/\/$/, '');

// ---- preferences: time zone, availability windows, travel buffers -----------------------------------------------------

const windowIn = z.object({ weekday: z.number().int().min(0).max(6).describe('0 = Sunday'), from_time: hhmm, to_time: hhmm });
const bufferIn = z.object({ kind: z.enum(BUFFER_KINDS), before_min: z.number().int().min(0).max(480), after_min: z.number().int().min(0).max(480) });

async function loadPrefs(userId) {
  const [prefs, windows, buffers] = await Promise.all([
    one('SELECT timezone, version FROM calendar_prefs WHERE user_id=$1', [userId]),
    many(`SELECT id, weekday, to_char(from_time,'HH24:MI') AS from_time, to_char(to_time,'HH24:MI') AS to_time, timezone FROM availability_windows WHERE user_id=$1 AND archived_at IS NULL ORDER BY weekday, from_time`, [userId]),
    many('SELECT kind, before_min, after_min FROM travel_buffers WHERE user_id=$1 ORDER BY kind', [userId]),
  ]);
  return { timezone: prefs?.timezone ?? 'UTC', version: prefs?.version ?? 0, windows, buffers };
}

const FEED_COLS = 'id, label, kinds, detail, version, revoked_at, fetch_count, last_fetched_at, created_at';
const IMPORT_COLS = 'id, label, source_host, status, last_error, last_synced_at, event_count, version, created_at';
const feedStatus = (r) => ({ ...r, status: r.revoked_at ? 'revoked' : 'active' });

cap({
  name: 'get_calendar_sync', method: 'GET', path: '/me/calendar-sync', tag: TAG,
  summary: 'Everything about calendar sync in one read: your home time zone, weekly availability windows, travel buffers, the calendar subscription links you made and the other calendars you imported as busy time. Secrets (feed links, import addresses) are never returned again. `version` is what to send when saving preferences. Pass athlete_id as a verified guardian to see a young person\'s.',
  input: z.object({ ...athlete }),
  async handler({ user }, i) {
    const owner = await subjectOf(user, i.athlete_id);
    const [prefs, feeds, imports] = await Promise.all([
      loadPrefs(owner),
      many(`SELECT ${FEED_COLS} FROM calendar_feeds WHERE user_id=$1 ORDER BY created_at DESC, id LIMIT 50`, [owner]),
      many(`SELECT ${IMPORT_COLS} FROM calendar_imports WHERE user_id=$1 AND removed_at IS NULL ORDER BY created_at DESC, id LIMIT 20`, [owner]),
    ]);
    const sharing_allowed = (owner === user.id ? !(await isYouth(owner)) : true) && await hasConsent(owner, 'calendar_sharing');
    return { ...prefs, feeds: feeds.map(feedStatus), imports, sharing_allowed, is_youth: await isYouth(owner) };
  },
});

cap({
  name: 'save_calendar_preferences', method: 'POST', path: '/me/calendar-preferences', tag: TAG,
  summary: 'Save your home time zone, weekly availability windows (wall-clock hours in your time zone, so daylight-saving changes keep the same local hours) and travel buffers (minutes needed before and after each kind of commitment). Send only the parts you change; windows are replaced as a set. Send the version you last saw (0 the first time); a stale version is refused (409) so two devices cannot overwrite each other. Replaced windows are archived, not deleted.',
  input: z.object({ ...athlete, version: z.number().int().min(0), timezone: zone.optional(), windows: z.array(windowIn).max(28).optional(), buffers: z.array(bufferIn).max(BUFFER_KINDS.length).optional() }),
  async handler({ user }, i) {
    const owner = await subjectOf(user, i.athlete_id);
    if (i.windows) {
      for (const w of i.windows) if (toMin(w.to_time) <= toMin(w.from_time)) throw badRequest('A window must end after it starts');
      const sorted = [...i.windows].sort((a, b) => a.weekday - b.weekday || toMin(a.from_time) - toMin(b.from_time));
      for (let n = 1; n < sorted.length; n++) if (sorted[n].weekday === sorted[n - 1].weekday && toMin(sorted[n].from_time) < toMin(sorted[n - 1].to_time)) throw badRequest('Availability windows on the same day cannot overlap');
    }
    if (i.buffers && new Set(i.buffers.map((b) => b.kind)).size !== i.buffers.length) throw badRequest('Give each kind of commitment one buffer');
    await tx(async (c) => {
      const stale = () => conflict('Your calendar settings were changed elsewhere; reload and try again', { code: 'stale_version' });
      let prefs;
      if (i.version === 0) {
        prefs = (await c.query('INSERT INTO calendar_prefs(user_id, timezone) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING RETURNING timezone', [owner, i.timezone ?? 'UTC'])).rows[0];
      } else {
        prefs = (await c.query('UPDATE calendar_prefs SET timezone=coalesce($3,timezone), version=version+1, updated_at=now() WHERE user_id=$1 AND version=$2 RETURNING timezone', [owner, i.version, i.timezone ?? null])).rows[0];
      }
      if (!prefs) throw stale();
      if (i.windows) {
        await c.query('UPDATE availability_windows SET archived_at=now() WHERE user_id=$1 AND archived_at IS NULL', [owner]);
        for (const w of i.windows) await c.query('INSERT INTO availability_windows(user_id, weekday, from_time, to_time, timezone) VALUES ($1,$2,$3,$4,$5)', [owner, w.weekday, w.from_time, w.to_time, prefs.timezone]);
      }
      for (const b of i.buffers ?? []) await c.query(
        `INSERT INTO travel_buffers(user_id, kind, before_min, after_min) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, kind) DO UPDATE SET before_min=EXCLUDED.before_min, after_min=EXCLUDED.after_min, updated_at=now()`, [owner, b.kind, b.before_min, b.after_min]);
    });
    return loadPrefs(owner);
  },
});

// ---- outbound: subscription links ---------------------------------------------------------------------------------------

const kindsIn = z.array(z.enum(FEED_KINDS)).min(1).max(FEED_KINDS.length);
const feedUrl = (token) => { const path = `/api/v1/calendar/feed/${encodeURIComponent(token)}.ics`; const base = apiBase(); return { path, url: base ? `${base}${path}` : null, webcal_url: base ? `${base.replace(/^https?:/, 'webcal:')}${path}` : null }; };

cap({
  name: 'create_calendar_feed', method: 'POST', path: '/me/calendar-feeds', tag: TAG, status: 201,
  summary: 'Create a private calendar subscription link (ICS) that Apple Calendar, Google Calendar and Outlook keep up to date by themselves. You choose which kinds of commitment it carries and whether it shows details or only "Busy". Health items always show as "Busy". The secret is shown once. A young person\'s link is arranged by their verified guardian (pass athlete_id) and works only while the guardian\'s calendar_sharing consent is in force.',
  input: z.object({ ...athlete, label: z.string().trim().max(60).optional(), kinds: kindsIn.default(['match', 'team', 'event', 'venue', 'training', 'duty', 'recovery']), detail: z.enum(['busy', 'full']).default('busy') }),
  async handler({ user }, i) {
    const owner = await subjectOf(user, i.athlete_id, true);
    if ((await one("SELECT count(*)::int AS n FROM calendar_feeds WHERE user_id=$1 AND revoked_at IS NULL", [owner])).n >= 10) throw conflict('You can keep up to 10 active subscription links; revoke one first');
    const token = newOpaqueToken();
    const row = await one(`INSERT INTO calendar_feeds(user_id, created_by, token_hash, label, kinds, detail) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${FEED_COLS}`,
      [owner, user.id, sha256(token), i.label || null, [...new Set(i.kinds)], i.detail]);
    await audit(null, user.id, 'create', 'calendar_feeds', row.id);
    return { ...feedStatus(row), token, ...feedUrl(token) };
  },
});

cap({
  name: 'update_calendar_feed', method: 'PATCH', path: '/me/calendar-feeds/:id', tag: TAG,
  summary: 'Change what an active subscription link carries, its detail level or its label. Send the version you last saw; a stale version is refused (409). Takes effect on the next refresh by the calendar app.',
  input: z.object({ id, version: z.number().int().min(1), label: z.string().trim().max(60).nullable().optional(), kinds: kindsIn.optional(), detail: z.enum(['busy', 'full']).optional() }),
  async handler({ user }, i) {
    const f = await manageable(user, 'calendar_feeds', i.id, 'Calendar link');
    if (f.revoked_at) throw conflict('This link is switched off; create a new one');
    const row = await one(`UPDATE calendar_feeds SET label=CASE WHEN $3 THEN $4 ELSE label END, kinds=coalesce($5,kinds), detail=coalesce($6,detail), version=version+1, updated_at=now()
                            WHERE id=$1 AND version=$2 AND revoked_at IS NULL RETURNING ${FEED_COLS}`,
      [i.id, i.version, i.label !== undefined, i.label || null, i.kinds ? [...new Set(i.kinds)] : null, i.detail ?? null]);
    if (!row) throw conflict('This link was changed elsewhere; reload and try again', { code: 'stale_version' });
    return feedStatus(row);
  },
});

cap({
  name: 'revoke_calendar_feed', method: 'POST', path: '/me/calendar-feeds/:id/revoke', tag: TAG,
  summary: 'Switch a subscription link off immediately (you, or a young person\'s verified guardian). The next refresh by any calendar app gets "not found". The record stays so you can see it existed.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await manageable(user, 'calendar_feeds', i.id, 'Calendar link');
    const row = await one('UPDATE calendar_feeds SET revoked_at=now(), updated_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id, revoked_at', [i.id]);
    if (!row) throw notFound('Calendar link');
    await audit(null, user.id, 'revoke', 'calendar_feeds', i.id);
    return row;
  },
});

/** The ICS text for one feed: the window is a week back to twelve weeks ahead, and imported calendars are never re-published. */
async function renderFeed(feed) {
  const tz = (await one('SELECT timezone FROM calendar_prefs WHERE user_id=$1', [feed.user_id]))?.timezone ?? 'UTC';
  const from = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10), to = new Date(Date.now() + 84 * DAY).toISOString().slice(0, 10);
  const sched = await buildSchedule({ id: feed.user_id }, { from, to, kinds: feed.kinds.join(',') });
  const events = sched.items.filter((x) => feed.kinds.includes(x.kind) && x.ends_at).map((x) => {
    const allDay = x.all_day;
    const startMs = Date.parse(x.starts_at);
    const endMs = allDay ? Date.parse(String(x.ends_at).slice(0, 10)) + DAY : Date.parse(x.ends_at);
    const shown = feed.detail === 'full' && x.kind !== 'health';
    return { uid: createHash('sha256').update(`${x.source_type}|${x.source_id}`).digest('hex').slice(0, 32), startMs, endMs, allDay,
      summary: shown ? x.title : 'Busy', description: shown ? x.context ?? undefined : undefined, cancelled: x.status === 'cancelled' || x.status === 'declined' };
  });
  return { ics: writeIcs({ name: 'Sportarena', tz, events }), count: events.length };
}

cap({
  name: 'preview_calendar_feed', method: 'GET', path: '/me/calendar-feeds/:id/preview', tag: TAG,
  summary: 'The calendar text a subscription link currently produces, so you can check what a subscriber sees before sharing it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const f = await manageable(user, 'calendar_feeds', i.id, 'Calendar link');
    if (f.revoked_at) throw conflict('This link is switched off');
    const r = await renderFeed(f);
    return { events: r.count, ics: r.ics };
  },
});

/** Public ICS endpoint used by calendar apps: GET /api/v1/calendar/feed/:token(.ics). A wrong, revoked or consent-withdrawn link is always a plain 404. */
export function calendarFeedRouter() {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 60 : 2000, standardHeaders: true, legacyHeaders: false });
  r.get('/calendar/feed/:token', limiter, async (req, res) => {
    try {
      const token = String(req.params.token).replace(/\.ics$/i, '');
      if (token.length < 10 || token.length > 200) throw notFound('Calendar link');
      const feed = await one('SELECT * FROM calendar_feeds WHERE token_hash=$1 AND revoked_at IS NULL', [sha256(token)]);
      if (!feed || (await isYouth(feed.user_id) && !(await hasConsent(feed.user_id, 'calendar_sharing')))) throw notFound('Calendar link');
      await query('UPDATE calendar_feeds SET fetch_count=fetch_count+1, last_fetched_at=now() WHERE id=$1', [feed.id]);
      await audit(null, null, 'read_pii', 'calendar_feeds', feed.id);
      const { ics } = await renderFeed(feed);
      res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="sportarena.ics"', 'Cache-Control': 'private, max-age=300' });
      res.send(ics);
    } catch (e) { const b = toErrorBody(e); res.status(b.status).json({ error: { code: b.code, message: b.message } }); }
  });
  return r;
}

// ---- inbound: other calendars as busy time ---------------------------------------------------------------------------------

const WINDOW_BACK = DAY, WINDOW_AHEAD = 120 * DAY;

/** Fetch an imported calendar and refresh its busy time. Safe to repeat or run twice at once: rows are keyed (calendar, event, start); vanished events are marked removed, never deleted. */
async function runSync(imp, actorId) {
  let text;
  try {
    await audit(null, actorId, 'read_pii', 'calendar_imports', imp.id);
    text = await fetchIcs(decrypt(imp.url_enc, 'calendar_imports.url_enc'));
  } catch (e) { return fail(imp, e); }
  const now = Date.now(), winStart = now - WINDOW_BACK, winEnd = now + WINDOW_AHEAD;
  let parsed;
  try {
    const tz = (await one('SELECT timezone FROM calendar_prefs WHERE user_id=$1', [imp.user_id]))?.timezone ?? 'UTC';
    parsed = parseBusy(text, { tz, winStart, winEnd });
  } catch (e) { return fail(imp, e); }
  const row = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [imp.id]);
    const seen = [];
    for (const b of parsed.busy) {
      const r = await c.query(
        `INSERT INTO calendar_import_events(import_id, uid_hash, starts_at, ends_at, all_day) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (import_id, uid_hash, starts_at) DO UPDATE SET ends_at=EXCLUDED.ends_at, all_day=EXCLUDED.all_day, removed_at=NULL RETURNING id`,
        [imp.id, sha256(b.uid), new Date(b.startMs).toISOString(), new Date(b.endMs).toISOString(), b.allDay]);
      seen.push(r.rows[0].id);
    }
    await c.query(`UPDATE calendar_import_events SET removed_at=now() WHERE import_id=$1 AND removed_at IS NULL AND NOT (id = ANY($2::uuid[])) AND ends_at > $3 AND starts_at < $4`,
      [imp.id, seen, new Date(winStart).toISOString(), new Date(winEnd).toISOString()]);
    return (await c.query(`UPDATE calendar_imports SET status='ok', last_error=NULL, last_synced_at=now(), event_count=$2, version=version+1 WHERE id=$1 RETURNING ${IMPORT_COLS}`, [imp.id, seen.length])).rows[0];
  });
  return { ok: true, row, stats: parsed.stats };
}
async function fail(imp, e) {
  const message = e instanceof AppError ? e.message : 'The calendar could not be read';
  const row = await one(`UPDATE calendar_imports SET status='error', last_error=$2, version=version+1 WHERE id=$1 RETURNING ${IMPORT_COLS}`, [imp.id, message.slice(0, 200)]);
  return { ok: false, row, error: e instanceof AppError ? e : new AppError(502, 'calendar_unreachable', message) };
}

cap({
  name: 'add_calendar_import', method: 'POST', path: '/me/calendar-imports', tag: TAG, status: 201,
  summary: 'Import another calendar (Google, Apple/iCloud, Outlook or any ICS address, https:// or webcal://) as busy time. Only the times are kept; titles, places and attendees are discarded, and the address is stored encrypted and never shown again. Busy time appears on your schedule and in conflicts. If the first read fails the import is kept with its error so you can retry. A young person\'s import is arranged by their verified guardian (pass athlete_id) and stops showing the moment calendar_sharing consent is withdrawn.',
  input: z.object({ ...athlete, url: z.string().trim().min(8).max(2000), label: z.string().trim().max(60).optional() }),
  async handler({ user }, i) {
    const owner = await subjectOf(user, i.athlete_id, true);
    const u = normalizeCalendarUrl(i.url);
    if ((await one('SELECT count(*)::int AS n FROM calendar_imports WHERE user_id=$1 AND removed_at IS NULL', [owner])).n >= 5) throw conflict('You can import up to 5 calendars; remove one first');
    let imp;
    try {
      imp = await one(`INSERT INTO calendar_imports(user_id, created_by, label, source_host, url_hash, url_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [owner, user.id, i.label || null, u.hostname, sha256(u.href), encrypt(u.href, 'calendar_imports.url_enc')]);
    } catch (e) { if (e.code === '23505') throw conflict('That calendar is already imported'); throw e; }
    const r = await runSync(imp, user.id);
    return r.row;
  },
});

cap({
  name: 'sync_calendar_import', method: 'POST', path: '/me/calendar-imports/:id/sync', tag: TAG,
  summary: 'Re-read an imported calendar now. Safe to repeat: events already imported are updated in place, events that disappeared from the source are marked removed, and nothing is duplicated. If the source cannot be read the previously imported busy time stays and the error is recorded (502).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const imp = await manageable(user, 'calendar_imports', i.id, 'Imported calendar');
    if (imp.removed_at) throw notFound('Imported calendar');
    if (await isYouth(imp.user_id)) await requireConsent(imp.user_id, 'calendar_sharing', 'calendar sharing');
    const r = await runSync(imp, user.id);
    if (!r.ok) throw r.error;
    return { ...r.row, skipped: { unknown_timezone: r.stats.unknown_timezone, unsupported_rules: r.stats.unsupported_rules, truncated: !!r.stats.truncated } };
  },
});

cap({
  name: 'remove_calendar_import', method: 'POST', path: '/me/calendar-imports/:id/remove', tag: TAG,
  summary: 'Stop using an imported calendar. Its busy time disappears from your schedule at once; the record is kept (soft removal), nothing is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await manageable(user, 'calendar_imports', i.id, 'Imported calendar');
    const row = await tx(async (c) => {
      const r = (await c.query('UPDATE calendar_imports SET removed_at=now() WHERE id=$1 AND removed_at IS NULL RETURNING id, removed_at', [i.id])).rows[0];
      if (r) await c.query('UPDATE calendar_import_events SET removed_at=now() WHERE import_id=$1 AND removed_at IS NULL', [i.id]);
      return r;
    });
    if (!row) throw notFound('Imported calendar');
    return row;
  },
});

// ---- conflicts ------------------------------------------------------------------------------------------------------------

const min = (ms) => Math.round(ms / 60000);
const ref = (x) => ({ source_type: x.source_type, source_id: x.source_id });

/** What can be done about one side of a conflict. Canonical bookings and appointments are never cancelled from here. */
function resolutionsFor(x) {
  const r = [];
  if (x.source_type === 'athlete_block') {
    r.push({ ...ref(x), action: 'move', label: 'Move this block', capability: 'update_athlete_block', args: { id: x.source_id, version: x.version } });
    r.push({ ...ref(x), action: 'remove', label: 'Remove this block', capability: 'archive_athlete_block', args: { id: x.source_id } });
  } else if (x.rsvp?.team_id) {
    r.push({ ...ref(x), action: 'rsvp_no', label: 'Tell the team you cannot make it', capability: 'set_event_rsvp', args: { id: x.rsvp.team_id, ...(x.rsvp.fixture_id ? { fixture_id: x.rsvp.fixture_id } : { event_id: x.rsvp.event_id }), rsvp: 'no' } });
  } else if (x.source_type === 'external_busy') {
    r.push({ ...ref(x), action: 'external', label: 'Change it in the other calendar, then sync', capability: 'sync_calendar_import' });
  } else {
    r.push({ ...ref(x), action: 'open', label: 'Open it to reschedule or respond', link: x.link ?? null, note: 'Bookings, appointments and fixtures are never cancelled automatically.' });
  }
  return r;
}

const brief = (x, tz) => ({ ...ref(x), kind: x.kind, title: x.title, context: x.context ?? null, starts_at: x.starts_at, ends_at: x.ends_at, timezone: x.timezone,
  local_start: localParts(Date.parse(x.starts_at), x.timezone && validZone(x.timezone) ? x.timezone : tz), duration_min: min(Date.parse(x.ends_at) - Date.parse(x.starts_at)), duration_assumed: !!x.duration_assumed });

cap({
  name: 'get_schedule_conflicts', method: 'GET', path: '/me/schedule-conflicts', tag: TAG,
  summary: 'Actionable conflicts on your calendar, computed from the real duration of every commitment (a duration is flagged "assumed" only when the source has none): hard overlaps, travel-buffer breaches (not enough time to travel between two commitments, using your buffers) and commitments outside your availability windows. Imported busy time counts. Each conflict lists the items, how bad it is and what you can do about each side; canonical bookings are never cancelled automatically.',
  input: z.object({ ...athlete, from: z.string().date().optional(), to: z.string().date().optional() }),
  async handler({ user }, i) {
    const owner = await subjectOf(user, i.athlete_id);
    const prefs = await loadPrefs(owner);
    const sched = await buildSchedule({ id: owner }, { from: i.from, to: i.to });
    const buf = Object.fromEntries(prefs.buffers.map((b) => [b.kind, b]));
    const open = (x) => !x.all_day && x.ends_at && !['cancelled', 'declined'].includes(x.status);
    const timed = sched.items.filter(open).map((x) => ({ x, s: Date.parse(x.starts_at), e: Date.parse(x.ends_at) })).sort((a, b) => a.s - b.s);
    const out = [];
    for (let n = 0; n < timed.length; n++) {
      const a = timed[n];
      for (let m = n + 1; m < timed.length; m++) {
        const b = timed[m];
        const need = (buf[a.x.kind]?.after_min ?? 0) + (buf[b.x.kind]?.before_min ?? 0);
        if (b.s >= a.e + need * 60000) break; // sorted by start: nothing later can clash with a
        const overlap = Math.min(a.e, b.e) - Math.max(a.s, b.s);
        if (overlap > 0) out.push({ type: 'overlap', severity: 'high', a, b, overlap_min: min(overlap), message: `${a.x.title} and ${b.x.title} overlap by ${min(overlap)} min.` });
        else out.push({ type: 'travel_buffer', severity: 'medium', a, b, gap_min: min(b.s - a.e), needed_min: need, message: `Only ${min(b.s - a.e)} min between ${a.x.title} and ${b.x.title}; your travel buffers need ${need} min.` });
      }
    }
    if (prefs.windows.length) {
      const checked = new Set(['match', 'team', 'event', 'venue', 'training', 'duty']);
      for (const t of timed) {
        if (!checked.has(t.x.kind)) continue;
        const fits = prefs.windows.some((w) => {
          const p = localParts(t.s, w.timezone), q = localParts(t.e, w.timezone);
          return p.weekday === w.weekday && p.date === q.date && p.minutes >= toMin(w.from_time) && q.minutes <= toMin(w.to_time);
        });
        if (!fits) out.push({ type: 'outside_availability', severity: 'info', a: t, b: null, message: `${t.x.title} is outside your availability windows.` });
      }
    }
    const conflicts = out.map((c) => ({
      id: createHash('sha256').update(`${c.type}|${c.a.x.source_type}|${c.a.x.source_id}|${c.b?.x.source_type ?? ''}|${c.b?.x.source_id ?? ''}`).digest('hex').slice(0, 24),
      type: c.type, severity: c.severity, message: c.message,
      ...(c.overlap_min !== undefined ? { overlap_min: c.overlap_min } : {}), ...(c.gap_min !== undefined ? { gap_min: c.gap_min, needed_min: c.needed_min } : {}),
      items: [brief(c.a.x, prefs.timezone), ...(c.b ? [brief(c.b.x, prefs.timezone)] : [])],
      resolutions: [...resolutionsFor(c.a.x), ...(c.b ? resolutionsFor(c.b.x) : [])],
    }));
    const count = (t) => conflicts.filter((c) => c.type === t).length;
    return { from: sched.from, to: sched.to, timezone: prefs.timezone, availability_configured: prefs.windows.length > 0, buffers_configured: prefs.buffers.some((b) => b.before_min || b.after_min),
      summary: { overlap: count('overlap'), travel_buffer: count('travel_buffer'), outside_availability: count('outside_availability') }, conflicts };
  },
});
