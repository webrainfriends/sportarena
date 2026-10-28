// Team travel (#485) background work: content-free, deduplicated reminders. Nothing here changes a trip; it only tells the right people.
//  - a passport that will not be valid long enough after the return (also catches a trip whose dates moved after the passport was recorded)
//  - a trip leaving within three days that still has travellers who are not ready
// Messages never carry document numbers or names of young travellers.
import { many, tx } from './db.js';
import { notify } from './notify.js';
import { addMonths, guardiansOfMany, localDay, readiness, youthIdsAmong } from './trips.js';
import { pool } from './db.js';

export async function remindPassports() {
  let n = 0;
  const rows = await many(
    `SELECT d.id AS doc_id, to_char(d.expires_on,'YYYY-MM-DD') AS expires_on, p.user_id, t.id AS trip_id, t.name, t.manager_id, t.return_at, t.timezone, t.passport_min_months
       FROM trip_documents d JOIN trip_participants p ON p.id=d.participant_id AND p.status IN ('invited','confirmed') JOIN trips t ON t.id=d.trip_id
      WHERE d.kind='passport' AND d.status='held' AND d.expires_on IS NOT NULL AND t.documents_required AND t.status NOT IN ('completed','cancelled') AND t.return_at > now() LIMIT 1000`);
  for (const r of rows) {
    if (r.expires_on >= addMonths(localDay(r.return_at, r.timezone), r.passport_min_months)) continue;
    const kids = await youthIdsAmong(pool, [r.user_id]);
    const who = [...new Set([r.user_id, r.manager_id, ...(await guardiansOfMany(pool, kids))])];
    for (const u of who) n += await tx(async (c) => (await notify(c, u, { kind: 'trip_document_alert', title: 'A passport expires too soon for this trip', body: r.name, data: { trip_id: r.trip_id }, dedupe_key: `trip:doc-expiry:${r.doc_id}:${r.expires_on}:${u}` })) ? 1 : 0);
  }
  return n;
}

export async function remindReadiness() {
  let n = 0;
  const trips = await many("SELECT * FROM trips WHERE status IN ('planning','approval_pending','confirmed') AND depart_at BETWEEN now() AND now() + interval '3 days' LIMIT 200");
  for (const t of trips) {
    const r = await readiness(pool, t);
    const open = [...r.byId.values()].filter((x) => !x.ready).length;
    if (!open) continue;
    n += await tx(async (c) => (await notify(c, t.manager_id, { kind: 'trip_readiness', title: `${open} traveller${open === 1 ? ' is' : 's are'} not ready yet`, body: `${t.name} leaves soon. Open the trip board.`, data: { trip_id: t.id }, dedupe_key: `trip:ready:${t.id}:${localDay(new Date(), t.timezone)}` })) ? 1 : 0);
  }
  return n;
}

export const runTripSweeps = async () => ({ passport_alerts: await remindPassports(), readiness_reminders: await remindReadiness() });
