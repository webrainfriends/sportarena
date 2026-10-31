// Quiet hours: pure, so the rule is one place a reviewer can read. During the window push, WhatsApp and SMS are held back (the item still
// lands in the in-app inbox and email still queues). An urgent notice breaks through unless the person switched that off.

const parts = (now, tz) => {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now);
  const get = (t) => f.find((p) => p.type === t)?.value;
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: get('weekday') };
};
const toMinutes = (t) => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };

export const validTimezone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

/** Is `now` inside the person's quiet window? A window that crosses midnight (22:00 to 07:00) is handled; "weekdays only" means the evening or morning falls on Mon-Fri. */
export function inQuietHours(prefs, now = new Date()) {
  if (!prefs?.quiet_start || !prefs?.quiet_end) return false;
  const tz = validTimezone(prefs.quiet_tz) ? prefs.quiet_tz : 'Asia/Kolkata';
  const { minutes, weekday } = parts(now, tz);
  const a = toMinutes(prefs.quiet_start), b = toMinutes(prefs.quiet_end);
  if (a === b) return false;
  const inside = a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
  if (!inside) return false;
  return !(prefs.quiet_weekdays_only && ['Sat', 'Sun'].includes(weekday));
}

/** Should this notification hold back push / WhatsApp / SMS now? */
export const holdsBack = (prefs, { urgent = false } = {}, now = new Date()) =>
  inQuietHours(prefs, now) && !(urgent && prefs?.quiet_urgent_override !== false);
