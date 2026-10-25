// Reminders for the deadlines an athlete added to their pathway plan (issue #335). One reminder per deadline, claimed atomically so several
// instances cannot double up; moving the date re-arms it. Wording is generic: email and push leave the system in clear text.
import { tx } from './db.js';
import { notify } from './notify.js';
import { guardiansOf } from './youth.js';

export async function queuePathwayReminders({ limit = 200 } = {}) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT d.id, d.user_id, d.due_on FROM pathway_deadlines d
        WHERE d.removed_at IS NULL AND d.done_at IS NULL AND d.reminded_at IS NULL AND d.due_on >= current_date AND d.due_on - d.remind_days <= current_date
        ORDER BY d.due_on, d.id LIMIT $1 FOR UPDATE OF d SKIP LOCKED`, [limit]);
    for (const d of rows) {
      for (const uid of new Set([d.user_id, ...(await guardiansOf(d.user_id, c))])) {
        await notify(c, uid, { kind: 'pathway_deadline', title: 'A pathway deadline is coming up', body: 'You have a deadline coming up in your pathway plan. Open it to see which.', data: { deadline_id: d.id }, dedupe_key: `pathway_deadline:${d.id}:${d.due_on instanceof Date ? d.due_on.toISOString().slice(0, 10) : d.due_on}:${uid}` });
      }
      await c.query('UPDATE pathway_deadlines SET reminded_at=now() WHERE id=$1', [d.id]);
    }
    return rows.length;
  });
}
