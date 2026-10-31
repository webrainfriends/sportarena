// Open coaching slots: the coach's weekly hours (in their own time zone) minus sessions already requested or confirmed.
// A coach who has published no hours has no grid: athletes then propose a time and the coach accepts or declines.
import { many, one } from './db.js';
import { addDays, dateRange, fromLocal, toLocal } from './booking/time.js';
import { commitmentBusy } from './coach-commitments.js';

export const MIN_NOTICE_MIN = 60;
export const MAX_RANGE_DAYS = 31;

export async function loadCoachSchedule(coachId) {
  const [profile, windows] = await Promise.all([
    one('SELECT timezone, slot_min FROM coach_profiles WHERE user_id=$1', [coachId]),
    many('SELECT weekday, start_min, end_min FROM coach_availability WHERE coach_id=$1 AND removed_at IS NULL ORDER BY weekday, start_min', [coachId]),
  ]);
  return { timezone: profile?.timezone ?? 'UTC', slot_min: profile?.slot_min ?? 60, windows };
}

/** Start instants between `from` and `to` (Dates) where `duration` minutes fit inside one window and nothing else is booked. */
export async function openCoachSlots(coachId, from, to, { duration, schedule } = {}) {
  const sched = schedule ?? await loadCoachSchedule(coachId);
  if (!sched.windows.length) return [];
  const booked = await many("SELECT starts_at, duration_min FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2", [coachId, from, to]);
  const busy = [...booked.map((b) => [+new Date(b.starts_at), +new Date(b.starts_at) + b.duration_min * 60_000]), ...(await commitmentBusy(coachId, from, to))];
  const len = duration ?? sched.slot_min, earliest = Date.now() + MIN_NOTICE_MIN * 60_000, out = [];
  // one day of slack either side because the local date can differ from the UTC date
  for (const date of dateRange(addDays(toLocal(from, sched.timezone).date, -1), addDays(toLocal(to, sched.timezone).date, 1))) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const w of sched.windows.filter((x) => x.weekday === weekday)) {
      for (let m = w.start_min; m + len <= w.end_min; m += sched.slot_min) {
        const start = fromLocal(date, m, sched.timezone), s = +start, e = s + len * 60_000;
        if (s < +from || s >= +to || s < earliest) continue;
        if (busy.some(([a, b]) => s < b && e > a)) continue;
        out.push(start.toISOString());
      }
    }
  }
  return [...new Set(out)].sort();
}

/** Is this exact start bookable on the coach's grid? A coach without a grid accepts any proposed time. */
export async function coachSlotOk(coachId, startsAt, duration) {
  const start = new Date(startsAt), sched = await loadCoachSchedule(coachId);
  if (!sched.windows.length) return { grid: false, ok: true };
  const slots = await openCoachSlots(coachId, start, new Date(+start + 1000), { duration, schedule: sched });
  return { grid: true, ok: slots.includes(start.toISOString()) };
}
