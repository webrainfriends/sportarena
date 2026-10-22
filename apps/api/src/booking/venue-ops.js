// Background upkeep for the venue operations workspace: tell the venue team when a contract is about to end and when
// maintenance work is due, and mark contracts that have run out. Each reminder goes out once (reminded_at).
import { tx } from '../db.js';
import { notify, venueTeam } from '../notify.js';

const day = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

export async function venueOpsReminders({ limit = 200 } = {}) {
  return tx(async (c) => {
    let sent = 0;
    // Contracts: reminder `notice_days` before the end (a contract that renews itself still needs a decision before the notice date).
    const ending = (await c.query(
      `SELECT k.id, k.title, k.venue_id, k.ends_on, k.auto_renews, v.name AS venue_name FROM venue_contracts k JOIN venues v ON v.id=k.venue_id
        WHERE k.status='active' AND k.ends_on IS NOT NULL AND k.reminded_at IS NULL AND k.ends_on <= current_date + k.notice_days
        ORDER BY k.ends_on LIMIT $1 FOR UPDATE OF k SKIP LOCKED`, [limit])).rows;
    for (const k of ending) {
      for (const u of await venueTeam(c, k.venue_id)) {
        await notify(c, u, { kind: 'contract_ending', title: `Contract ending: ${k.title}`, dedupe_key: `contract_ending:${k.id}`,
          body: `${k.title} at ${k.venue_name} ${k.ends_on < new Date() ? 'ended' : 'ends'} on ${day(k.ends_on)}${k.auto_renews ? ' and renews itself unless you give notice' : ''}. Renew, replace or end it.`, data: { venue_id: k.venue_id, contract_id: k.id } });
        sent++;
      }
      await c.query('UPDATE venue_contracts SET reminded_at=now() WHERE id=$1', [k.id]);
    }
    // Maintenance due today or tomorrow, or overdue.
    const due = (await c.query(
      `SELECT m.id, m.title, m.venue_id, m.due_on, m.priority, r.name AS court, v.name AS venue_name FROM venue_maintenance m JOIN venues v ON v.id=m.venue_id LEFT JOIN resources r ON r.id=m.resource_id
        WHERE m.status IN ('scheduled','in_progress') AND m.due_on IS NOT NULL AND m.reminded_at IS NULL AND m.due_on <= current_date + 1
        ORDER BY m.due_on LIMIT $1 FOR UPDATE OF m SKIP LOCKED`, [limit])).rows;
    for (const m of due) {
      for (const u of await venueTeam(c, m.venue_id)) {
        await notify(c, u, { kind: 'maintenance_due', title: `Maintenance due: ${m.title}`, dedupe_key: `maintenance_due:${m.id}`,
          body: `${m.title}${m.court ? ` (${m.court})` : ''} at ${m.venue_name} is due ${day(m.due_on)}.`, data: { venue_id: m.venue_id, maintenance_id: m.id } });
        sent++;
      }
      await c.query('UPDATE venue_maintenance SET reminded_at=now() WHERE id=$1', [m.id]);
    }
    // Contracts that have run out and do not renew are over (kept on record).
    await c.query("UPDATE venue_contracts SET status='ended', updated_at=now() WHERE status='active' AND NOT auto_renews AND ends_on < current_date");
    return sent;
  });
}
