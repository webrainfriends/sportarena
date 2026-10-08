// Sold-out waitlist for a specific court and time.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { config } from '../config.js';
import { mustFind } from '../helpers.js';
import { loadVenueCtx, checkWindow, blockedBy, usedUnits, mustManage } from '../booking/engine.js';

const TAG = 'Waitlist';
const dt = z.string().datetime({ offset: true });

cap({
  name: 'join_waitlist', method: 'POST', path: '/waitlist', tag: TAG, status: 201,
  summary: `Join the queue for a sold-out slot (a specific court and time, same rules as a booking). When it frees up the person first in line is offered it: the slot is held for them for ${config.waitlistHoldMinutes} minutes (everyone else sees it as taken) and they book it normally. If you already hold an offer or the slot is free, you are told to just book it.`,
  input: z.object({ resource_id: id, starts_at: dt, ends_at: dt, quantity: z.number().int().min(1).max(1000).default(1) }),
  async handler({ user }, i) {
    const res = await mustFind('resources', i.resource_id);
    if (!res.active) throw notFound('Bookable area');
    const ctx = await loadVenueCtx(pool, res.venue_id);
    if (!ctx.venue.active) throw conflict('That venue is not taking bookings');
    const start = new Date(i.starts_at), end = new Date(i.ends_at);
    checkWindow(ctx, res, start, end);
    if (i.quantity > res.capacity) throw badRequest(`${res.name} has ${res.capacity} unit(s)`);
    if (await blockedBy(pool, res.venue_id, res.id, start, end)) throw conflict('That time is closed — there is nothing to wait for');
    const used = await usedUnits(pool, res.id, start, end, undefined, user.id);
    if (used + i.quantity <= res.capacity) throw conflict('That slot is available right now — book it instead');
    if (await one("SELECT 1 FROM waitlist_entries WHERE user_id=$1 AND resource_id=$2 AND status IN ('waiting','offered') AND starts_at < $4 AND ends_at > $3", [user.id, res.id, start, end])) throw conflict("You're already on the waitlist for that time");
    if ((await one("SELECT count(*)::int AS n FROM waitlist_entries WHERE user_id=$1 AND status IN ('waiting','offered')", [user.id])).n >= 10) throw conflict('You can be on 10 waitlists at a time — leave one first');
    const e = await one('INSERT INTO waitlist_entries(user_id, venue_id, resource_id, starts_at, ends_at, quantity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [user.id, res.venue_id, res.id, start, end, i.quantity]);
    return { ...e, position: await positionOf(e) };
  },
});

const positionOf = async (e) => (e.status !== 'waiting' ? null : (await one(
  "SELECT count(*)::int + 1 AS p FROM waitlist_entries w WHERE w.resource_id=$1 AND w.status='waiting' AND w.starts_at < $3 AND w.ends_at > $2 AND w.created_at < $4", [e.resource_id, e.starts_at, e.ends_at, e.created_at])).p);

cap({
  name: 'list_waitlist', method: 'GET', path: '/me/waitlist', tag: TAG, summary: 'Your waitlist entries: waiting (with your place in line), offered (with when the hold ends), and finished ones.', input: z.object({ include_done: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT w.*, v.name AS venue_name, v.timezone, r.name AS resource_name FROM waitlist_entries w JOIN venues v ON v.id=w.venue_id JOIN resources r ON r.id=w.resource_id
        WHERE w.user_id=$1 AND ($2 OR w.status IN ('waiting','offered')) ORDER BY (w.status IN ('waiting','offered')) DESC, w.starts_at LIMIT 100`, [user.id, i.include_done]);
    return Promise.all(rows.map(async (w) => ({ ...w, position: await positionOf(w) })));
  },
});

cap({
  name: 'leave_waitlist', method: 'DELETE', path: '/waitlist/:id', tag: TAG, summary: 'Leave the queue (or give up an offered slot, which then goes to the next person).', input: z.object({ id }),
  async handler({ user }, i) {
    const e = await one("UPDATE waitlist_entries SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status IN ('waiting','offered') RETURNING *", [i.id, user.id]);
    if (!e) throw notFound('Active waitlist entry');
    if (e.offer_expires_at) import('../booking/freed.js').then((m) => m.kickFreed(e.venue_id));
    return { ok: true };
  },
});

cap({
  name: 'venue_waitlist', method: 'GET', path: '/venues/:id/waitlist', tag: TAG,
  summary: 'Demand you could not serve (venue team): for each court and time people are queueing for — how many are waiting and how many offers are out. No personal details.', input: z.object({ id }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(
      `SELECT r.id AS resource_id, r.name AS resource_name, w.starts_at, w.ends_at, count(*) FILTER (WHERE w.status='waiting')::int AS waiting, count(*) FILTER (WHERE w.status='offered')::int AS offered, sum(w.quantity) FILTER (WHERE w.status='waiting')::int AS units_wanted
         FROM waitlist_entries w JOIN resources r ON r.id=w.resource_id WHERE w.venue_id=$1 AND w.status IN ('waiting','offered') AND w.starts_at > now()
        GROUP BY r.id, w.starts_at, w.ends_at ORDER BY w.starts_at LIMIT 200`, [i.id]);
  },
});
