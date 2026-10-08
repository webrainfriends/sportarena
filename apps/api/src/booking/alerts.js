// "Tell me when a slot opens": watches a venue (optionally one court, days, time window) and tells the person the
// moment a matching run of free slots appears. Checked after cancellations / released blocks and by the background worker.
import { many, one, query } from '../db.js';
import { notify } from '../notify.js';
import { loadVenueCtx, loadBusy, daySlots } from './engine.js';
import { toLocal, fromLocal, addDays } from './time.js';

/** Earliest run of `a.slots` free, back-to-back slots matching the alert, or null. */
export function matchAlert(ctx, resources, busy, a, now = new Date()) {
  const tz = ctx.venue.timezone;
  const today = toLocal(now, tz).date;
  const last = addDays(today, ctx.venue.max_advance_days);
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const from = iso(a.date_from) > today ? iso(a.date_from) : today;
  const to = iso(a.date_to) < last ? iso(a.date_to) : last;
  let best = null;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = toLocal(fromLocal(d, 720, tz), tz).weekday;
    if (a.weekdays && !a.weekdays.includes(wd)) continue;
    for (const r of resources) {
      const grid = daySlots(ctx, r, d, { ...busy, now });
      for (let i = 0; i + a.slots <= grid.length; i++) {
        const run = grid.slice(i, i + a.slots);
        if (!run.every((s, k) => s.status === 'free' && (k === 0 || +run[k - 1].ends_at === +s.starts_at))) continue;
        const startMin = toLocal(run[0].starts_at, tz).minutes;
        const endMin = startMin + a.slots * r.slot_minutes;
        if ((a.from_min != null && startMin < a.from_min) || (a.to_min != null && endMin > a.to_min)) continue;
        if (!best || run[0].starts_at < best.starts_at) best = { resource_id: r.id, resource_name: r.name, starts_at: run[0].starts_at, ends_at: run[a.slots - 1].ends_at, date: d, price_cents: run.reduce((s, x) => s + x.price_cents, 0) };
        break;
      }
    }
    if (best) return best; // earliest day wins
  }
  return best;
}

/** Resources an alert covers. */
export const alertResources = (c, a) => c.query(
  `SELECT * FROM resources WHERE venue_id=$1 AND active AND kind <> 'equipment' AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR sport_id=$3) ORDER BY name`, [a.venue_id, a.resource_id, a.sport_id]).then((r) => r.rows);

/** Check active alerts (all, or one venue's) and notify whoever now has a match. Returns how many were fulfilled. */
export async function checkSlotAlerts({ venueId } = {}) {
  await query("UPDATE slot_alerts SET status='expired' WHERE status='active' AND date_to < (now() AT TIME ZONE 'UTC')::date - 1");
  const alerts = await many("SELECT * FROM slot_alerts WHERE status='active' AND ($1::uuid IS NULL OR venue_id=$1) ORDER BY created_at", [venueId ?? null]);
  let fulfilled = 0;
  for (const vid of [...new Set(alerts.map((a) => a.venue_id))]) {
    const mine = alerts.filter((a) => a.venue_id === vid);
    const ctx = await loadVenueCtx({ query }, vid).catch(() => null);
    if (!ctx || !ctx.venue.active) continue;
    const lo = new Date(Math.min(...mine.map((a) => +fromLocal(String(a.date_from instanceof Date ? a.date_from.toISOString() : a.date_from).slice(0, 10), 0, ctx.venue.timezone))));
    const hi = fromLocal(addDays(toLocal(new Date(), ctx.venue.timezone).date, ctx.venue.max_advance_days + 1), 0, ctx.venue.timezone);
    const busy = await loadBusy({ query }, vid, new Date(Math.min(+lo, Date.now())), hi);
    for (const a of mine) {
      const found = matchAlert(ctx, await alertResources({ query }, a), busy, a);
      if (!found) continue;
      const claimed = await one("UPDATE slot_alerts SET status='fulfilled', notified_at=now(), found_starts_at=$2, found_resource_id=$3 WHERE id=$1 AND status='active' RETURNING id", [a.id, found.starts_at, found.resource_id]);
      if (!claimed) continue;
      fulfilled++;
      await notify(null, a.user_id, {
        kind: 'slot_available', title: `A slot opened at ${ctx.venue.name}`,
        body: `${found.resource_name} · ${found.starts_at.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ctx.venue.timezone })}. Book it before someone else does.`,
        data: { venue_id: vid, resource_id: found.resource_id, date: found.date, starts_at: found.starts_at, alert_id: a.id },
      });
    }
  }
  return fulfilled;
}

/** After something frees capacity (cancellation, released block): re-check that venue's alerts once the data is committed. */
export const kickAlerts = (venueId) => setImmediate(() => checkSlotAlerts({ venueId }).catch((e) => console.error('[alerts]', e.message)));
