// Managing a booked coaching series: read it, skip (or pause) dates, move a date, cancel what is left with a pro-rata refund.
// Booking and pricing live in hire.js / coach-pricing.js; the money rules in coach-series.js. One series, one place.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { assertCoachFree } from './hire.js';
import { cancelDate, refundPreview, resyncSeries, upcomingDates } from '../coach-series.js';
import { setTransitionContext } from '../lifecycle.js';
import { fromLocal, hhmm, validTimezone } from '../booking/time.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TAG = 'Hire';

/** The series if the caller is its hirer, its coach or an admin; anyone else gets a 404 so existence is not leaked. */
async function mine(user, seriesId, c) {
  const q = (sql, a) => (c ? c.query(sql, a).then((r) => r.rows[0]) : one(sql, a));
  const s = await q(`SELECT s.*, uc.display_name AS coach_name, uh.display_name AS hirer_name FROM coach_series s JOIN users uc ON uc.id=s.coach_id JOIN users uh ON uh.id=s.hirer_id WHERE s.id=$1${c ? ' FOR UPDATE OF s' : ''}`, [seriesId]);
  if (!s || (s.hirer_id !== user.id && s.coach_id !== user.id && !isAdmin(user))) throw notFound('Series');
  return s;
}

const datesOf = (seriesId) => many(
  `SELECT h.id, h.starts_at, h.duration_min, h.list_cents, h.total_cents, h.loyalty_credit_cents, h.status, h.payment_status, h.series_state, h.rescheduled_from
     FROM coach_hires h WHERE h.series_id=$1 ORDER BY h.starts_at, h.id`, [seriesId]);

const shape = (s, dates) => {
  const live = dates.filter((d) => ['requested', 'confirmed'].includes(d.status) && new Date(d.starts_at) > new Date());
  return {
    id: s.id, coach_id: s.coach_id, hirer_id: s.hirer_id, coach_name: s.coach_name, hirer_name: s.hirer_name, status: s.status, pay_mode: s.pay_mode, currency: s.currency,
    list_total_cents: Number(s.list_total_cents), discount_pct: Number(s.discount_pct), discount_cents: Number(s.discount_cents), total_cents: Number(s.total_cents),
    pay_hire_id: s.pay_mode === 'once' && !s.payment_id ? s.anchor_hire_id : null, paid_once: !!s.payment_id, rate_card_id: s.rate_card_id, pattern: s.pattern, created_at: s.created_at, paused_at: s.paused_at, cancelled_at: s.cancelled_at,
    upcoming: live.length, refundable_cents: refundPreview(live), dates,
  };
};

cap({
  name: 'get_coach_series', method: 'GET', path: '/hires/series/:id', tag: TAG,
  summary: 'One booked coaching series: the block price (list, discount, total), how it is paid, every date with its own share of the price, its status (booked, skipped, moved, cancelled) and what a cancel of the remaining dates would refund right now. Only the hirer, the coach and an admin can read it; history is kept.',
  input: z.object({ id }),
  async handler({ user }, i) { const s = await mine(user, i.id); return shape(s, await datesOf(s.id)); },
});

cap({
  name: 'list_coach_series', method: 'GET', path: '/hires/series', tag: TAG,
  summary: 'Your coaching series, as hirer or as coach, newest first, each with its price, discount, status and how many dates are still to come.',
  input: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT s.*, uc.display_name AS coach_name, uh.display_name AS hirer_name FROM coach_series s JOIN users uc ON uc.id=s.coach_id JOIN users uh ON uh.id=s.hirer_id
        WHERE s.hirer_id=$1 OR s.coach_id=$1 ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    const out = [];
    for (const s of rows) out.push(shape(s, await datesOf(s.id)));
    return out.map(({ dates, pattern, ...r }) => ({ ...r, dates_total: dates.length }));
  },
});

cap({
  name: 'skip_series_dates', method: 'POST', path: '/hires/series/:id/skip', tag: TAG,
  summary: 'Skip dates of a series without losing the rest. Give `hire_ids` (specific dates) and/or a `from`..`to` range (a pause); only dates still to come can be skipped. Each skipped date is cancelled and gets its own share of the price back if it was paid; the other dates, the block price already agreed and the series history stay. `preview: true` returns the exact refund first. Either the hirer or the coach can skip.',
  input: z.object({ id, hire_ids: z.array(id).max(60).default([]), from: day.optional(), to: day.optional(), reason: z.string().trim().max(500).optional(), preview: z.boolean().default(false) }),
  async handler({ user }, i) {
    if (!i.hire_ids.length && !(i.from && i.to)) throw badRequest('Choose the dates to skip, or a from and to date');
    if ((i.from && !i.to) || (i.to && !i.from)) throw badRequest('Give both a from and a to date');
    if (i.from && i.to < i.from) throw badRequest('The end of the pause is before its start');
    const s = await mine(user, i.id);
    const tz = s.pattern?.timezone ?? 'UTC';
    const pick = (await upcomingDates(s.id)).filter((h) => {
      if (i.hire_ids.includes(h.id)) return true;
      if (!i.from) return false;
      const startLocal = fromLocal(i.from, 0, tz), endLocal = fromLocal(i.to, 1440, tz);
      return new Date(h.starts_at) >= startLocal && new Date(h.starts_at) < endLocal;
    });
    const unknown = i.hire_ids.filter((x) => !pick.some((h) => h.id === x));
    if (unknown.length) throw conflict('Some of those dates cannot be skipped (already done, cancelled or not in this series)', { hire_ids: unknown });
    if (!pick.length) throw conflict('No upcoming dates in that range');
    const preview = { skipped: pick.map((h) => ({ hire_id: h.id, starts_at: h.starts_at, refund_cents: h.payment_status === 'paid' ? Number(h.total_cents) - Number(h.loyalty_credit_cents) : 0 })), refund_cents: refundPreview(pick), currency: s.currency };
    if (i.preview) return { preview: true, ...preview };
    await tx(async (c) => {
      await mine(user, i.id, c);   // lock the series
      for (const h of pick) await cancelDate(c, user.id, h.id, { reason: i.reason, how: 'skipped' });
      await resyncSeries(c, s.id);
      const other = user.id === s.hirer_id ? s.coach_id : s.hirer_id;
      await notify(c, other, { kind: 'coach_series_skipped', title: `${user.display_name} skipped ${pick.length} coaching date${pick.length === 1 ? '' : 's'}`, body: '', data: { series_id: s.id } });
    });
    return { ...preview, series: shape(await mine(user, i.id), await datesOf(s.id)) };
  },
});

cap({
  name: 'pause_coach_series', method: 'POST', path: '/hires/series/:id/pause', tag: TAG,
  summary: 'Put a series on hold without losing anything. Every upcoming date is held: it keeps its price and payment (a paid date stays paid, nothing is refunded), stops blocking the coach\'s calendar, is not charged and cannot be confirmed. Resume later with `resume_coach_series`, or skip or cancel held dates as usual. `preview: true` lists the dates that would be held. The hirer or the coach can pause.',
  input: z.object({ id, reason: z.string().trim().max(500).optional(), preview: z.boolean().default(false) }),
  async handler({ user }, i) {
    const s = await mine(user, i.id);
    if (s.status !== 'active') throw conflict(s.status === 'paused' ? 'This series is already paused' : `A ${s.status} series cannot be paused`);
    const pick = (await upcomingDates(s.id)).filter((h) => h.series_state !== 'paused');
    if (!pick.length) throw conflict('Nothing is left to pause');
    const preview = { held: pick.map((h) => ({ hire_id: h.id, starts_at: h.starts_at, paid: h.payment_status === 'paid' })), currency: s.currency };
    if (i.preview) return { preview: true, ...preview };
    await tx(async (c) => {
      const cur = await mine(user, i.id, c);
      if (cur.status !== 'active') throw conflict('This series was just changed; reload and try again');
      await setTransitionContext(c, user.id, i.reason ?? 'Series paused');
      await c.query("UPDATE coach_hires SET series_state='paused' WHERE id = ANY($1::uuid[]) AND status IN ('requested','confirmed') AND starts_at > now()", [pick.map((h) => h.id)]);
      await resyncSeries(c, s.id);
      const other = user.id === s.hirer_id ? s.coach_id : s.hirer_id;
      await notify(c, other, { kind: 'coach_series_paused', title: `${user.display_name} paused the coaching series`, body: '', data: { series_id: s.id } });
    });
    return { ...preview, series: shape(await mine(user, i.id), await datesOf(s.id)) };
  },
});

cap({
  name: 'resume_coach_series', method: 'POST', path: '/hires/series/:id/resume', tag: TAG,
  summary: 'Resume a paused series. Each held date is checked again (still in the future, coach free, no clash): free dates go back on the calendar with their price and payment unchanged; dates that clash or have already passed are returned in `problems` and stay held so they can be moved (`reschedule_series_date`), skipped or cancelled. The hirer or the coach can resume.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mine(user, i.id);
    if (s.status !== 'paused') throw conflict('This series is not paused');
    const held = (await upcomingDates(s.id)).filter((h) => h.series_state === 'paused');
    const problems = [], resumed = [];
    await tx(async (c) => {
      await mine(user, i.id, c);
      await setTransitionContext(c, user.id, 'Series resumed');
      for (const h of held) {
        try {
          if (new Date(h.starts_at) <= new Date()) throw conflict('This date has already passed');
          await assertCoachFree(h.coach_id, h.starts_at, h.duration_min, h.id);
          await c.query("UPDATE coach_hires SET series_state='booked' WHERE id=$1 AND series_state='paused'", [h.id]);
          resumed.push(h.id);
        } catch (e) { if (!(e instanceof AppError)) throw e; problems.push({ hire_id: h.id, starts_at: h.starts_at, problem: e.message }); }
      }
      await resyncSeries(c, s.id);
      if (resumed.length) {
        const other = user.id === s.hirer_id ? s.coach_id : s.hirer_id;
        await notify(c, other, { kind: 'coach_series_resumed', title: `${user.display_name} resumed the coaching series`, body: '', data: { series_id: s.id } });
      }
    });
    return { resumed: resumed.length, problems, series: shape(await mine(user, i.id), await datesOf(s.id)) };
  },
});

cap({
  name: 'reschedule_series_date', method: 'POST', path: '/hires/series/:id/reschedule', tag: TAG,
  summary: 'Move one upcoming date of a series to another day or time without touching the rest. The coach must be free then (open slot, no clash, no other commitment); the date keeps its price and payment, and the other party is told. Times are in the series\' time zone.',
  input: z.object({ id, hire_id: id, date: day, start: z.string().describe('HH:MM local time') }),
  async handler({ user }, i) {
    const startMin = hhmm(i.start);
    if (Number.isNaN(startMin) || startMin >= 1440) throw badRequest('Start must be a time like 17:30');
    const s = await mine(user, i.id);
    const tz = s.pattern?.timezone ?? 'UTC';
    if (!validTimezone(tz)) throw badRequest('Unknown time zone');
    const startsAt = fromLocal(i.date, startMin, tz).toISOString();
    if (new Date(startsAt) <= new Date()) throw badRequest('Pick a time in the future');
    return tx(async (c) => {
      const h = (await c.query('SELECT * FROM coach_hires WHERE id=$1 AND series_id=$2 FOR UPDATE', [i.hire_id, s.id])).rows[0];
      if (!h) throw notFound('Date');
      if (!['requested', 'confirmed'].includes(h.status) || new Date(h.starts_at) <= new Date()) throw conflict('Only an upcoming date can be moved');
      await assertCoachFree(h.coach_id, startsAt, h.duration_min, h.id);
      await setTransitionContext(c, user.id, 'Date moved');
      const out = (await c.query('UPDATE coach_hires SET starts_at=$2, rescheduled_from=coalesce(rescheduled_from, starts_at) WHERE id=$1 RETURNING id, starts_at, rescheduled_from, status, payment_status, total_cents', [h.id, startsAt])).rows[0];
      await c.query("UPDATE session_venue_links SET released_at=now(), release_reason='session moved' WHERE session_type='coach_hire' AND session_id=$1 AND released_at IS NULL", [h.id]);
      const other = user.id === s.hirer_id ? s.coach_id : s.hirer_id;
      await notify(c, other, { kind: 'coach_series_moved', title: `${user.display_name} moved a coaching date`, body: `New time: ${startsAt.slice(0, 16).replace('T', ' ')} UTC`, data: { series_id: s.id, hire_id: h.id } });
      return out;
    });
  },
});

cap({
  name: 'cancel_coach_series', method: 'POST', path: '/hires/series/:id/cancel', tag: TAG,
  summary: 'Cancel everything still to come in a series. Dates already delivered (or started) stay as they are and are never refunded; every upcoming date is cancelled and refunded exactly its own share of what was paid (discount and loyalty credit included), pro rata. `preview: true` returns the exact refund first. The hirer or the coach can cancel; nothing is deleted.',
  input: z.object({ id, reason: z.string().trim().max(500).optional(), preview: z.boolean().default(false) }),
  async handler({ user }, i) {
    const s = await mine(user, i.id);
    if (s.status === 'cancelled') throw conflict('This series is already cancelled');
    const pick = await upcomingDates(s.id);
    if (!pick.length) throw conflict('Nothing is left to cancel');
    const kept = (await datesOf(s.id)).filter((d) => !pick.some((p) => p.id === d.id));
    const preview = { cancelled: pick.map((h) => ({ hire_id: h.id, starts_at: h.starts_at, refund_cents: h.payment_status === 'paid' ? Number(h.total_cents) - Number(h.loyalty_credit_cents) : 0 })), kept: kept.length, refund_cents: refundPreview(pick), currency: s.currency };
    if (i.preview) return { preview: true, ...preview };
    let refunded = 0;
    await tx(async (c) => {
      await mine(user, i.id, c);
      for (const h of pick) refunded += await cancelDate(c, user.id, h.id, { reason: i.reason, how: 'cancelled' });
      await c.query("UPDATE coach_series SET status='cancelled', cancelled_at=now(), cancelled_by=$2 WHERE id=$1", [s.id, user.id]);
      await resyncSeries(c, s.id);
      const other = user.id === s.hirer_id ? s.coach_id : s.hirer_id;
      await notify(c, other, { kind: 'coach_series_cancelled', title: `${user.display_name} cancelled the remaining coaching sessions`, body: '', data: { series_id: s.id } });
    });
    return { ...preview, refunded_cents: refunded, series: shape(await mine(user, i.id), await datesOf(s.id)) };
  },
});
