// Recurring and custom date lists, used by coaching series and recurring venue bookings. Dates are plain YYYY-MM-DD
// (the calendar day in whichever time zone the caller applies); the same rules drive the app's preview.
import { z } from 'zod';
import { addDays } from './booking/time.js';
import { badRequest } from './errors.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const MAX_OCCURRENCES = 60;

/** weekdays 0=Sun..6; stop at ends_on or after `count` dates. extra_dates are added as they are, exclude_dates removed. */
export const patternFields = {
  starts_on: day, ends_on: day.optional(), count: z.number().int().min(1).max(MAX_OCCURRENCES).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]), every_n_weeks: z.number().int().min(1).max(8).default(1),
  exclude_dates: z.array(day).max(120).default([]), extra_dates: z.array(day).max(MAX_OCCURRENCES).default([]),
};

export function expandDates(p) {
  const out = new Set(p.extra_dates ?? []);
  if (p.weekdays?.length) {
    if (!p.ends_on && !p.count) throw badRequest('Say when the pattern ends: an end date or a number of sessions');
    const limit = p.ends_on ?? addDays(p.starts_on, 730);
    if (limit < p.starts_on) throw badRequest('The end date is before the start date');
    const startDow = new Date(`${p.starts_on}T00:00:00Z`).getUTCDay();
    let n = 0;
    for (let d = p.starts_on, i = 0; d <= limit && i < 800; d = addDays(d, 1), i++) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      const week = Math.floor((i + startDow) / 7);
      if (!p.weekdays.includes(dow) || week % (p.every_n_weeks ?? 1) !== 0) continue;
      out.add(d);
      if (p.count && ++n >= p.count) break;
    }
  } else if (!out.size) out.add(p.starts_on);
  for (const x of p.exclude_dates ?? []) out.delete(x);
  const dates = [...out].sort();
  if (!dates.length) throw badRequest('No dates left after the exclusions');
  if (dates.length > MAX_OCCURRENCES) throw badRequest(`That is ${dates.length} dates; the most in one go is ${MAX_OCCURRENCES}`);
  return dates;
}
