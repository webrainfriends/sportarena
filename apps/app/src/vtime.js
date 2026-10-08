// Venue-local time helpers for the booking screens. The server owns all rules; the app only needs to turn a
// venue-local wall-clock time into an instant (and back) for display and for forms that take "date + time".

const fmts = new Map();
const parts = (tz, ms) => {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmts.set(tz, f); }
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
};

export const todayIn = (tz) => { const p = parts(tz, Date.now()); return `${p.year}-${p.month}-${p.day}`; };
export const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const dayLabel = (date, i) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }));
export const longDay = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** 'HH:MM' on `date` in `tz` -> ISO instant. */
export function localToIso(date, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000;
  const off = (ms) => { const p = parts(tz, ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
  let t = guess - off(guess);
  t = guess - off(t);
  return new Date(t).toISOString();
}

export const timeIn = (iso, tz) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz });
export const dateTimeIn = (iso, tz) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz });
export const localDate = (iso, tz) => { const p = parts(tz, Date.parse(iso)); return `${p.year}-${p.month}-${p.day}`; };
export const localHHMM = (iso, tz) => { const p = parts(tz, Date.parse(iso)); return `${p.hour}:${p.minute}`; };

export const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const digitsOf = (currency) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
/** Minor units (paise, cents, whole yen …) in the currency's own format: ₹1,200 · $25.50 · ¥5,000. */
export const moneyIn = (minor = 0, currency = 'INR') => {
  const d = digitsOf(currency);
  const major = minor / 10 ** d;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: minor % 10 ** d ? d : 0, maximumFractionDigits: d }).format(major); }
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
