// iCalendar (RFC 5545) reading and writing for calendar sync, plus the guarded fetch used for imports.
// Imports keep busy time only: titles, places, attendees and descriptions of the other calendar are read and thrown away.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { AppError, badRequest } from './errors.js';

const DAY = 86400000;
const MAX_BYTES = 2 * 1024 * 1024;

// ---- time zones --------------------------------------------------------------------------------------------------

export const validZone = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };

const dtf = new Map();
function offsetAt(ms, tz) {
  let f = dtf.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); dtf.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in a zone to an instant. In a skipped hour (spring forward) the later offset is used; in a repeated hour the first. */
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === 'UTC') return guess;
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

/** Local weekday (0 = Sunday), minutes since local midnight and date of an instant in a zone. */
export function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: +p.hour * 60 + +p.minute, date: `${p.year}-${p.month}-${p.day}` };
}

// ---- parsing -----------------------------------------------------------------------------------------------------

function unfold(text) { return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); }

function parseLine(line) {
  const i = line.search(/[:;]/);
  if (i < 1) return null;
  const name = line.slice(0, i).toUpperCase();
  let rest = line.slice(i), params = {};
  while (rest[0] === ';') {
    const m = /^;([A-Za-z0-9-]+)=("[^"]*"|[^;:]*)/.exec(rest);
    if (!m) break;
    params[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
    rest = rest.slice(m[0].length);
  }
  return rest[0] === ':' ? { name, params, value: rest.slice(1) } : null;
}

/** Read a DATE or DATE-TIME. Returns local wall-clock fields and the zone they belong to. */
function parseWhen(value, params, fallbackTz, stats) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (!m[4]) return { allDay: true, y, mo, d, h: 0, mi: 0, s: 0, tz: 'UTC' };
  let tz = fallbackTz;
  if (m[7]) tz = 'UTC';
  else if (params.TZID) {
    if (validZone(params.TZID)) tz = params.TZID; else stats.unknown_timezone++;
  }
  return { allDay: false, y, mo, d, h: +m[4], mi: +m[5], s: +m[6], tz };
}

const instant = (w) => zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, w.s, w.tz);

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRule(v) {
  const r = Object.fromEntries(v.split(';').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, x]) => [k.toUpperCase(), x]));
  const supported = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'];
  const unsupported = Object.keys(r).some((k) => !supported.includes(k)) || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.FREQ);
  return { freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null, until: r.UNTIL ?? null,
    byday: r.BYDAY ? r.BYDAY.split(',').map((d) => WD[d.slice(-2)]).filter((d) => d !== undefined) : null,
    plainByday: !r.BYDAY || /^([A-Z]{2},?)+$/.test(r.BYDAY), unsupported };
}

/** Occurrences (start, end instants) of one event inside [winStart, winEnd). Recurrence runs in wall-clock time so daylight-saving changes keep the local hour. */
function expand(ev, winStart, winEnd, stats) {
  const { start, durationMs, rule, ex } = ev;
  const dur = durationMs;
  const out = [];
  const push = (ms) => { if (!ex.has(ms) && ms + dur > winStart && ms < winEnd) out.push([ms, ms + dur]); };
  if (!rule) { push(instant(start)); return out; }
  const r = parseRule(rule);
  if (r.unsupported || !r.plainByday) { stats.unsupported_rules++; push(instant(start)); return out; }
  let untilMs = Infinity;
  if (r.until) { const u = parseWhen(r.until, {}, 'UTC', stats); if (u) untilMs = u.allDay ? zonedToUtc(u.y, u.mo, u.d, 23, 59, 59, 'UTC') : instant(u); }
  const baseDay = Date.UTC(start.y, start.mo - 1, start.d);
  const at = (dayMs) => { const t = new Date(dayMs); return zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), start.h, start.mi, start.s, start.tz); };
  let n = 0;
  const take = (ms) => {
    if (ms < instant(start) || ms > untilMs) return ms > untilMs ? false : true;
    n++;
    if (r.count && n > r.count) return false;
    push(ms);
    return ms < winEnd + 2 * DAY;
  };
  for (let k = 0; k < 6000; k++) {
    if (r.freq === 'DAILY') { if (!take(at(baseDay + k * r.interval * DAY))) break; continue; }
    if (r.freq === 'WEEKLY') {
      const dow = new Date(baseDay).getUTCDay();
      const monday = baseDay - ((dow + 6) % 7) * DAY + k * r.interval * 7 * DAY;
      const days = (r.byday?.length ? r.byday : [dow]).map((d) => (d + 6) % 7).sort((a, b) => a - b);
      let go = true;
      for (const d of days) if (!take(at(monday + d * DAY))) { go = false; break; }
      if (!go) break;
      continue;
    }
    const base = new Date(baseDay);
    if (r.freq === 'MONTHLY') {
      const t = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + k * r.interval, 1));
      if (new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), base.getUTCDate())).getUTCMonth() !== t.getUTCMonth()) continue; // no 31st this month
      if (!take(at(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), base.getUTCDate())))) break;
    } else {
      const t = Date.UTC(base.getUTCFullYear() + k * r.interval, base.getUTCMonth(), base.getUTCDate());
      if (new Date(t).getUTCMonth() !== base.getUTCMonth()) continue;
      if (!take(at(t))) break;
    }
  }
  return out;
}

/**
 * Busy blocks from ICS text, within [winStart, winEnd) (epoch ms). Cancelled and "free" (TRANSPARENT) events are ignored.
 * Returns { busy: [{ uid, startMs, endMs, allDay }], stats } and throws a 400 when the text is not a calendar.
 */
export function parseBusy(text, { tz = 'UTC', winStart, winEnd, maxEvents = 5000 }) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw badRequest('That address did not return a calendar (.ics) file');
  const stats = { events: 0, unknown_timezone: 0, unsupported_rules: 0 };
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = { ex: new Set(), props: {} }; continue; }
    if (/^END:VEVENT/i.test(line)) { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'EXDATE') { for (const v of p.value.split(',')) { const w = parseWhen(v, p.params, tz, stats); if (w) cur.ex.add(instant(w)); } continue; }
    if (['UID', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'STATUS', 'TRANSP', 'RECURRENCE-ID'].includes(p.name)) cur.props[p.name] = p;
  }
  const overridden = new Map(); // uid -> original starts replaced by an edited instance
  const built = [];
  for (const e of events) {
    const P = e.props;
    if (!P.DTSTART || /CANCELLED/i.test(P.STATUS?.value ?? '') || /TRANSPARENT/i.test(P.TRANSP?.value ?? '')) continue;
    const start = parseWhen(P.DTSTART.value, P.DTSTART.params, tz, stats);
    if (!start) continue;
    let durationMs = null;
    if (P.DTEND) { const end = parseWhen(P.DTEND.value, P.DTEND.params, start.tz, stats); if (end) durationMs = instant(end) - instant(start); }
    else if (P.DURATION) durationMs = parseDuration(P.DURATION.value);
    else if (start.allDay) durationMs = DAY;
    if (!durationMs || durationMs <= 0) continue;
    const uid = P.UID?.value ?? `${P.DTSTART.value}-${durationMs}`;
    if (P['RECURRENCE-ID']) {
      const r = parseWhen(P['RECURRENCE-ID'].value, P['RECURRENCE-ID'].params, tz, stats);
      if (r) overridden.set(uid, [...(overridden.get(uid) ?? []), instant(r)]);
    }
    built.push({ uid, start, durationMs, rule: P.RRULE?.value ?? null, ex: e.ex, isOverride: !!P['RECURRENCE-ID'] });
  }
  const busy = [];
  for (const ev of built) {
    for (const x of overridden.get(ev.uid) ?? []) if (!ev.isOverride) ev.ex.add(x);
    for (const [s, e] of expand(ev, winStart, winEnd, stats)) {
      busy.push({ uid: ev.uid, startMs: s, endMs: e, allDay: ev.start.allDay });
      if (busy.length >= maxEvents) { stats.events = busy.length; return { busy, stats: { ...stats, truncated: true } }; }
    }
  }
  stats.events = busy.length;
  return { busy, stats };
}

// ---- writing -----------------------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

function fold(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const parts = [];
  let i = 0, limit = 75;
  while (i < buf.length) {
    let end = Math.min(i + limit, buf.length);
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--; // never split a multi-byte character
    parts.push(buf.subarray(i, end).toString('utf8'));
    i = end; limit = 74;
  }
  return parts.join('\r\n ');
}

/** events: [{ uid, startMs, endMs, allDay, summary, description?, cancelled? }] -> RFC 5545 text. */
export function writeIcs({ name, tz, events, now = Date.now() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sportarena//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@sportarena`, `DTSTAMP:${stamp(now)}`);
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${dateOnly(e.startMs)}`, `DTEND;VALUE=DATE:${dateOnly(e.endMs)}`);
    else lines.push(`DTSTART:${stamp(e.startMs)}`, `DTEND:${stamp(e.endMs)}`);
    lines.push(`SUMMARY:${esc(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push(`STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ---- guarded fetch -----------------------------------------------------------------------------------------------

export function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

/** Validate an address typed by a person. webcal:// is https://. Only https on the default port, never an address on a private network. */
export function normalizeCalendarUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim().replace(/^webcals?:\/\//i, 'https://')); } catch { throw badRequest('That is not a valid calendar address'); }
  if (u.protocol !== 'https:') throw badRequest('Calendar addresses must use https:// (or webcal://)');
  if (u.username || u.password) throw badRequest('Calendar addresses cannot contain a username or password');
  if (u.port && u.port !== '443') throw badRequest('Calendar addresses must use the standard https port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) ? isPrivateAddress(host) : /^localhost$|\.(local|internal|localhost)$/i.test(host)) throw badRequest('That address points to a private network and cannot be imported');
  return u;
}

const safeLookup = (hostname, opts, cb) => dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
  if (err) return cb(err);
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) return cb(new Error('private address'));
  if (opts?.all) return cb(null, addrs);
  cb(null, addrs[0].address, addrs[0].family);
});

function getOnce(u) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: u.hostname, path: u.pathname + u.search, lookup: safeLookup, timeout: 10_000, headers: { accept: 'text/calendar, text/plain;q=0.5', 'user-agent': 'Sportarena-Calendar/1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: new URL(res.headers.location, u) }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new AppError(502, 'calendar_unreachable', `The calendar server answered ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new AppError(502, 'calendar_too_large', 'That calendar is larger than 2 MB')); return; } chunks.push(c); });
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new AppError(502, 'calendar_timeout', 'The calendar server took too long to answer')));
    req.on('error', (e) => reject(e instanceof AppError ? e : new AppError(502, 'calendar_unreachable', e.message === 'private address' ? 'That address points to a private network' : 'Could not reach that calendar address')));
  });
}

async function safeFetch(url) {
  let u = normalizeCalendarUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    const r = await getOnce(u);
    if (r.text !== undefined) return r.text;
    u = normalizeCalendarUrl(r.redirect.href);
  }
  throw new AppError(502, 'calendar_unreachable', 'Too many redirects');
}

let fetcher = safeFetch;
/** Test seam: replace how calendar text is fetched. Pass nothing to restore the guarded fetch. */
export const setIcsFetcher = (f) => { fetcher = f ?? safeFetch; };
export const fetchIcs = (url) => fetcher(url);
