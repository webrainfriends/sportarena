// Open games follow their canonical booking and close themselves when nobody finished them. Run by the maintenance worker; every step is
// safe to repeat (notifications carry dedupe keys, updates are conditional).
import { many, tx } from './db.js';
import { logger } from './logger.js';
import { CHAT_GRACE_HOURS, lockOpenGame, notifyAll } from './open-games.js';
import { notify } from './notify.js';

export async function syncOpenGames() {
  let changed = 0;
  // the venue booking was cancelled: tell the host and everyone holding a place (the booking stays the source of truth)
  const cancelled = await many(
    `SELECT og.id, og.booking_id FROM open_games og JOIN games g ON g.id=og.game_id JOIN bookings b ON b.id=og.booking_id
      WHERE og.status='open' AND b.status <> 'confirmed' AND g.starts_at > now()`);
  for (const r of cancelled) {
    try {
      await tx(async (c) => {
        const lock = await lockOpenGame(c, r.id);
        if (!lock || lock.og.status !== 'open') return;
        const { og, g } = lock;
        await notify(c, og.host_id, { kind: 'open_game_venue_lost', title: 'Your game has no venue booking', body: `The booking behind "${g.title}" was cancelled. Book another slot and link it, or cancel the game.`, data: { open_game_id: og.id }, dedupe_key: `og_booking_cancelled:${og.id}:${og.booking_id}` });
        await notifyAll(c, og, g, { kind: 'open_game_venue_lost', title: 'Venue booking cancelled', body: `The venue booking for "${g.title}" was cancelled. The host is sorting it out.`, key: `og_booking_cancelled:${og.booking_id}` });
        changed++;
      });
    } catch (e) { logger.error('open game booking sync failed', { open_game_id: r.id, error: String(e.message).slice(0, 200) }); }
  }
  // the booking was moved at the venue: the game follows it and the players are told
  const moved = await many(
    `SELECT og.id FROM open_games og JOIN games g ON g.id=og.game_id JOIN bookings b ON b.id=og.booking_id
      WHERE og.status='open' AND b.status='confirmed' AND g.starts_at > now() AND (g.starts_at <> b.starts_at OR g.ends_at IS DISTINCT FROM b.ends_at)`);
  for (const r of moved) {
    try {
      await tx(async (c) => {
        const lock = await lockOpenGame(c, r.id);
        if (!lock || lock.og.status !== 'open') return;
        const { og, g } = lock;
        const b = (await c.query('SELECT starts_at, ends_at, resource_id FROM bookings WHERE id=$1', [og.booking_id])).rows[0];
        const res = (await c.query('SELECT venue_id FROM resources WHERE id=$1', [b.resource_id])).rows[0];
        await c.query('UPDATE games SET starts_at=$2, ends_at=$3, resource_id=$4, venue_id=$5, updated_at=now() WHERE id=$1', [g.id, b.starts_at, b.ends_at, b.resource_id, res.venue_id]);
        await c.query('UPDATE open_games SET row_version=row_version+1, last_synced_starts_at=$2, updated_at=now() WHERE id=$1', [og.id, b.starts_at]);
        await notify(c, og.host_id, { kind: 'open_game_changed', title: 'Game time changed', body: `The venue moved the booking behind "${g.title}"; the game follows it.`, data: { open_game_id: og.id }, dedupe_key: `og_moved:${og.id}:${og.row_version + 1}` });
        await notifyAll(c, og, g, { kind: 'open_game_changed', title: 'Game time or place changed', body: `"${g.title}" has a new time or place. Open the app to check it still works for you.`, key: `og_moved:${og.id}:${og.row_version + 1}` });
        changed++;
      });
    } catch (e) { logger.error('open game time sync failed', { open_game_id: r.id, error: String(e.message).slice(0, 200) }); }
  }
  // games nobody completed: close them once the chat window is over. Nobody is counted as attended or as a no-show.
  const stale = await many(
    `SELECT og.id FROM open_games og JOIN games g ON g.id=og.game_id WHERE og.status='open' AND coalesce(g.ends_at, g.starts_at + interval '3 hours') + make_interval(hours => $1) < now()`, [CHAT_GRACE_HOURS]);
  for (const r of stale) {
    await tx(async (c) => {
      const lock = await lockOpenGame(c, r.id);
      if (!lock || lock.og.status !== 'open') return;
      await c.query("UPDATE open_games SET status='completed', row_version=row_version+1, updated_at=now() WHERE id=$1", [r.id]);
      await c.query("UPDATE games SET status='post-event', updated_at=now() WHERE id=$1", [lock.g.id]);
      changed++;
    });
  }
  return changed;
}
