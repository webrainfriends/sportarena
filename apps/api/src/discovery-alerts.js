// Saved-search alerts (#696): the worker re-runs each alerting search as its owner and tells them once about every NEW match.
// Same notify route and one-shot-per-item idea as slot alerts (booking/alerts.js); the search runs with the owner's own visibility,
// so a young person's listing is never announced to an adult.
import { z } from 'zod';
import { many, query } from './db.js';
import { notify } from './notify.js';
import { discover } from './discovery.js';
import { filtersShape } from './capabilities/discovery.js';

const parse = z.object({ ...filtersShape, limit: z.coerce.number().int().default(100), offset: z.coerce.number().int().default(0) });
const KEEP = 500;

export async function checkSavedSearches() {
  const rows = await many(`SELECT s.*, u.id AS uid FROM saved_searches s JOIN users u ON u.id=s.user_id WHERE s.archived_at IS NULL AND s.alerts_on ORDER BY s.created_at LIMIT 500`);
  let sent = 0;
  for (const s of rows) {
    try {
      const user = { id: s.user_id };
      const f = parse.parse(s.filters);
      if (f.from && new Date(f.to ?? f.from) < new Date()) { await query('UPDATE saved_searches SET alerts_on=false, last_checked_at=now() WHERE id=$1', [s.id]); continue; } // its date range is over
      const res = await discover(user, f);
      const keys = res.items.filter((x) => x.kind !== 'venue').map((x) => `${x.kind}:${x.id}`); // venues are always there; only new games and classes are news
      const fresh = res.items.filter((x) => x.kind !== 'venue' && !s.notified_keys.includes(`${x.kind}:${x.id}`));
      const first = s.last_checked_at == null; // the first run records what already exists instead of announcing it
      if (fresh.length && !first) {
        await notify(null, s.user_id, {
          kind: 'search_match', title: `New match for “${s.name}”`,
          body: fresh.length === 1 ? `${fresh[0].title} · ${fresh[0].place?.name ?? ''}`.trim() : `${fresh.length} new games and classes match your saved search.`,
          data: { saved_search_id: s.id, items: fresh.slice(0, 5).map((x) => ({ kind: x.kind, id: x.id })) }, dedupe_key: `search_match:${s.id}:${fresh.map((x) => x.id).sort().join(',').slice(0, 120)}`,
        });
        sent++;
      }
      await query('UPDATE saved_searches SET last_checked_at=now(), last_notified_at=CASE WHEN $3 THEN now() ELSE last_notified_at END, notified_keys=$2 WHERE id=$1',
        [s.id, [...new Set([...s.notified_keys, ...keys])].slice(-KEEP), fresh.length > 0 && !first]);
    } catch (e) { console.error('[saved-search]', s.id, e.message); }
  }
  return sent;
}
