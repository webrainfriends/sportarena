// Sold-out waitlist. When capacity frees up, the first person in line (FIFO per court) whose slot now fits is OFFERED it:
// the slot is held for them for a few minutes (usedUnits / loadBusy count held offers as taken for everyone else).
// They claim it by booking normally; if they don't, the offer expires and the next person is offered it.
import { config } from '../config.js';
import { many, query, tx } from '../db.js';
import { notify } from '../notify.js';
import { blockedBy, lockResource, usedUnits } from './engine.js';
import { toLocal } from './time.js';

export async function processWaitlist({ venueId } = {}) {
  // offers nobody claimed, and waits for slots that have already started
  const stale = (await query("UPDATE waitlist_entries SET status='expired' WHERE status='offered' AND offer_expires_at <= now() RETURNING id, user_id, venue_id, resource_id, starts_at")).rows;
  await query("UPDATE waitlist_entries SET status='expired' WHERE status='waiting' AND starts_at <= now()");
  for (const e of stale) {
    await notify(null, e.user_id, { kind: 'waitlist_expired', title: 'Your waitlist offer expired', body: "You didn't book the slot in time, so it went to the next person.", data: { venue_id: e.venue_id, waitlist_id: e.id } });
  }
  const resources = await many("SELECT DISTINCT resource_id FROM waitlist_entries WHERE status='waiting' AND ($1::uuid IS NULL OR venue_id=$1)", [venueId ?? null]);
  let offered = 0;
  for (const { resource_id } of resources) {
    await tx(async (c) => {
      await lockResource(c, resource_id);
      const res = (await c.query('SELECT r.*, v.name AS venue_name, v.timezone FROM resources r JOIN venues v ON v.id=r.venue_id WHERE r.id=$1 AND r.active AND v.active', [resource_id])).rows[0];
      if (!res) return;
      const queue = (await c.query("SELECT * FROM waitlist_entries WHERE resource_id=$1 AND status='waiting' AND starts_at > now() ORDER BY created_at", [resource_id])).rows;
      for (const e of queue) {
        if (await blockedBy(c, res.venue_id, res.id, e.starts_at, e.ends_at)) continue;
        const used = await usedUnits(c, res.id, e.starts_at, e.ends_at, undefined, e.user_id);
        if (used + e.quantity > res.capacity) continue;
        const exp = (await c.query("UPDATE waitlist_entries SET status='offered', offered_at=now(), offer_expires_at=now() + make_interval(mins => $2) WHERE id=$1 RETURNING offer_expires_at", [e.id, config.waitlistHoldMinutes])).rows[0].offer_expires_at;
        offered++;
        await notify(c, e.user_id, {
          kind: 'waitlist_offer', title: `A slot opened at ${res.venue_name}!`,
          body: `${res.name}, ${e.starts_at.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: res.timezone })}. It's held for you for ${config.waitlistHoldMinutes} minutes — book it now.`,
          data: { venue_id: res.venue_id, resource_id: res.id, starts_at: e.starts_at, ends_at: e.ends_at, quantity: e.quantity, waitlist_id: e.id, expires_at: exp, date: toLocal(e.starts_at, res.timezone).date },
        });
      }
    });
  }
  return { offered, expired: stale.length };
}
