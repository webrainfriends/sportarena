// Venue-local time helpers. A venue's hours, slot grid and price rules are all expressed in its own IANA
// time zone, so we convert explicitly instead of trusting the server's zone.

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function validTimezone(tz) {
  try { fmt(tz); return true; } catch { return false; }
}

const parts = (tz, ms) => Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));

/** Wall-clock parts of an instant in `tz`: { date: 'YYYY-MM-DD', minutes: since local midnight, weekday: 0=Sun }. */
export function toLocal(instant, tz) {
  const p = parts(tz, new Date(instant).getTime());
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: weekdayOf(date) };
}

export const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The instant at which the wall clock in `tz` reads `date` + `minutes`. */
export function fromLocal(date, minutes, tz) {
  const guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const off = (ms) => {
    const p = parts(tz, ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  let t = guess - off(guess);
  t = guess - off(t);
  return new Date(t);
}

/** 'HH:MM' -> minutes since midnight ('24:00' allowed as end of day). */
export function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return NaN;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && v <= 1440 ? v : NaN;
}
export const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Every local date from `from` to `to` inclusive. */
export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
