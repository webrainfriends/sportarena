// Compliance reminders and escalation (#595): gentle, content-free, idempotent. A record that is about to expire is reminded at each of its requirement's
// reminder days (once per stage); once it has expired the holder is told, and after the requirement's escalation period the scope's managers are told too.
// Linked requirements (a platform verification, a federation licence, a supplier credential) are reminded by the module that owns them.
import { many, tx } from './db.js';
import { notify } from './notify.js';
import { guardiansOf } from './youth.js';
import { managerIds } from './compliance.js';

const stageFor = (daysLeft, reminderDays, escalateAfter) => {
  if (daysLeft < 0) return -daysLeft > escalateAfter ? 'escalated' : 'expired';
  const next = [...reminderDays].sort((a, b) => a - b).find((d) => daysLeft <= d);
  return next === undefined ? null : `before:${next}`;
};

/** Who is reminded: the holder (and a young person's guardians), or the managers of an organisation / event. */
async function audience(c, rec) {
  if (rec.subject_kind === 'person') return [rec.subject_id, ...await guardiansOf(rec.subject_id, c)];
  return managerIds(c, rec.subject_kind === 'organisation' ? 'organisation' : 'event', rec.subject_id);
}

export async function remindCompliance() {
  let n = 0;
  const rows = await many(
    `SELECT k.id, k.subject_kind, k.subject_id, k.expires_on::text AS expires_on, (k.expires_on - current_date)::int AS left, q.name, q.reminder_days, q.escalate_after_days, q.scope_kind, q.scope_id
       FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id
      WHERE k.status='valid' AND k.expires_on IS NOT NULL AND q.archived_at IS NULL AND q.method <> 'linked'
        AND k.expires_on <= current_date + (SELECT coalesce(max(m), 0) FROM unnest(q.reminder_days) m)
        AND NOT EXISTS (SELECT 1 FROM comp_records nx WHERE nx.previous_id = k.id AND nx.status = 'valid')
      ORDER BY k.expires_on LIMIT 1000`);
  for (const r of rows) {
    const stage = stageFor(r.left, r.reminder_days, r.escalate_after_days);
    if (!stage) continue;
    n += await tx(async (c) => {
      const ins = await c.query('INSERT INTO comp_reminders(record_id, stage) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [r.id, stage]);
      if (!ins.rowCount) return 0;
      const escalated = stage === 'escalated';
      const who = escalated ? await managerIds(c, r.scope_kind, r.scope_id) : await audience(c, r);
      const title = escalated ? `${r.name} is overdue` : stage === 'expired' ? `${r.name} has expired` : `${r.name} expires in ${r.left} day${r.left === 1 ? '' : 's'}`;
      const body = escalated ? 'A requirement has stayed expired. Open Compliance to follow it up.' : stage === 'expired' ? 'Renew it in Compliance to stay in good standing.' : `It is valid until ${r.expires_on}. Renew it in Compliance.`;
      for (const u of who) await notify(c, u, { kind: escalated ? 'compliance_escalated' : 'compliance_expiring', title, body, data: { record_id: r.id }, dedupe_key: `comp:${r.id}:${stage}:${u}` });
      return who.length ? 1 : 0;
    });
  }
  return n;
}

export const runComplianceSweeps = async () => ({ reminders: await remindCompliance() });
