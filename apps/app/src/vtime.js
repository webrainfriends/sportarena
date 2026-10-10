// Venue-local time helpers for the booking screens. The server owns all rules; the app only needs to turn a
// venue-local wall-clock time into an instant (and back) for display and for forms that take "date + time".

import { locale } from './locale';

const fmts = new Map();
const parts = (tz, ms) => {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmts.set(tz, f); }
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
};

export const todayIn = (tz) => { const p = parts(tz, Date.now()); return `${p.year}-${p.month}-${p.day}`; };
export const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const dayLabel = (date, i) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }));
export const longDay = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** 'HH:MM' on `date` in `tz` -> ISO instant. */
export function localToIso(date, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000;
  const off = (ms) => { const p = parts(tz, ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
  let t = guess - off(guess);
  t = guess - off(t);
  return new Date(t).toISOString();
}

export const timeIn = (iso, tz) => new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz });
export const dateTimeIn = (iso, tz) => new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz });
export const localDate = (iso, tz) => { const p = parts(tz, Date.parse(iso)); return `${p.year}-${p.month}-${p.day}`; };
export const localHHMM = (iso, tz) => { const p = parts(tz, Date.parse(iso)); return `${p.hour}:${p.minute}`; };

export const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const digitsOf = (currency) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
/** Minor units (paise, cents, whole yen …) in the currency's own format: ₹1,200 · $25.50 · ¥5,000. */
export const moneyIn = (minor = 0, currency = 'INR') => {
  const d = digitsOf(currency);
  const major = minor / 10 ** d;
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: minor % 10 ** d ? d : 0, maximumFractionDigits: d }).format(major); }
  catch { return `${currency} ${major.toFixed(d)}`; }
};

/** Summarise weekly hours: "Mon–Sun 06:00–22:00" (groups days that share the same hours). */
export function hoursSummary(hours) {
  if (!hours?.length) return 'Open 24 hours';
  const byDay = WEEKDAYS.map((_, d) => hours.filter((h) => h.weekday === d).map((h) => `${fmtMin(h.opens_min)}–${fmtMin(h.closes_min)}`).join(', ') || 'Closed');
  const out = [];
  let start = 0;
  for (let d = 1; d <= 7; d++) {
    if (d === 7 || byDay[d] !== byDay[start]) { out.push(`${start === d - 1 ? WEEKDAYS[start] : `${WEEKDAYS[start]}–${WEEKDAYS[d - 1]}`} ${byDay[start]}`); start = d; }
  }
  return out.join(' · ');
}

/** Wall-clock now in a zone: { date, minutes, weekday }. */
export const nowIn = (tz) => { const p = parts(tz, Date.now()); return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`).getUTCDay() }; };

/** Is a venue open right now, and when does that change? hours = [{weekday, opens_min, closes_min}] (empty = 24h). */
export function openStatus(hours, tz) {
  if (!hours?.length) return { open: true, text: 'Open 24 hours' };
  const n = nowIn(tz);
  const today = hours.filter((h) => h.weekday === n.weekday).sort((a, b) => a.opens_min - b.opens_min);
  const cur = today.find((h) => n.minutes >= h.opens_min && n.minutes < h.closes_min);
  if (cur) return { open: true, text: `Open now · closes ${fmtClock(cur.closes_min)}` };
  const later = today.find((h) => h.opens_min > n.minutes);
  if (later) return { open: false, text: `Closed · opens ${fmtClock(later.opens_min)}` };
  for (let k = 1; k <= 7; k++) { const d = (n.weekday + k) % 7; const h = hours.filter((x) => x.weekday === d).sort((a, b) => a.opens_min - b.opens_min)[0]; if (h) return { open: false, text: `Closed · opens ${k === 1 ? 'tomorrow' : WEEKDAYS[d]} ${fmtClock(h.opens_min)}` }; }
  return { open: false, text: 'Closed' };
}
export const fmtClock = (m) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`; };

/** "Weekday mornings · 15% off" — the name already says it when it mentions the saving. */
export const offerLabel = (o, currency) => {
  const v = o.kind === 'percent' ? `${o.value}% off` : `${moneyIn(o.value, currency)} off`;
  return /off|%|save|free/i.test(o.name) ? o.name : `${o.name} · ${v}`;
};
