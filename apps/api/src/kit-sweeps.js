// Background reminders for academy kit (#798): kit that is due for collection (or waiting for a fitting) and loaned kit that is overdue for return.
// Idempotent: every message carries a dedupe key (per entitlement and due date, per issue and week), so a retried or concurrent run cannot double up.
// Nothing here changes stock, money or kit records.
import { many, tx, pool } from './db.js';
import { needs } from './kit-reports.js';
import { tellAthlete } from './kit.js';

const week = (d = new Date()) => `${d.getUTCFullYear()}-${Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / (7 * 864e5))}`;

export async function sweepKit() {
  let sent = 0;
  const orgs = await many("SELECT DISTINCT organisation_id AS id FROM academy_kit_entitlements WHERE archived_at IS NULL");
  const today = new Date().toISOString().slice(0, 10);
  for (const o of orgs) {
    for (const r of await needs(pool, o.id, null)) {
      if (r.outstanding <= 0) continue;
      const due = String(r.due_on?.toISOString?.().slice(0, 10) ?? r.due_on);
      if (due > today) continue;
      const fitting = r.size_required && !r.size;
      await tx((c) => tellAthlete(c, r.athlete_id, o.id, fitting ? 'fitting' : 'due', fitting ? 'A kit fitting is needed' : 'Kit is ready to collect', `${r.entitlement_id}:${due}`));
      sent++;
    }
  }
  const late = await many("SELECT id, organisation_id, athlete_id FROM academy_kit_issues WHERE status='issued' AND due_back_at IS NOT NULL AND due_back_at < now()");
  for (const r of late) { await tx((c) => tellAthlete(c, r.athlete_id, r.organisation_id, 'overdue', 'Kit is due back', `${r.id}:${week()}`)); sent++; }
  return sent;
}
