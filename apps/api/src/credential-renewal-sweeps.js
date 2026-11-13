// Credential renewal reminder sweeps: nightly check for expiring coach/referee/physio badges.
// Idempotent: verification_renewal_reminders unique index (case_id, window_days) prevents double-sending.
import { pool } from './db.js';
import { notify } from './notify.js';

const WINDOWS = [90, 60, 30, 7];
const ROLE_LABEL = { coach: 'coach', referee: 'official', physio: 'physio' };

export async function sweepVerificationRenewals(db) {
  const pg = db ?? pool;
  let sent = 0;

  for (const window of WINDOWS) {
    // Cases approved, not revoked/withdrawn, expiring within `window` days, reminder not yet sent for this window
    const { rows } = await pg.query(
      `SELECT vc.id AS case_id, vc.type, vc.requested_by AS user_id, vc.expires_at
         FROM verification_cases vc
        WHERE vc.type IN ('coach','referee','physio')
          AND vc.status = 'approved'
          AND vc.expires_at > now()
          AND vc.expires_at <= now() + make_interval(days => $1)
          AND NOT EXISTS (
            SELECT 1 FROM verification_renewal_reminders r
             WHERE r.case_id = vc.id AND r.window_days = $1
          )`,
      [window]);

    for (const row of rows) {
      try {
        const label = ROLE_LABEL[row.type] ?? row.type;
        const body = window <= 7
          ? `Your ${label} credential expires in ${window} days — final notice. Submit your renewal now.`
          : window <= 30
            ? `Your ${label} credential expires in ${window} days — urgent: begin renewal immediately.`
            : `Your ${label} credential expires in ${window} days — start your renewal now to avoid a gap.`;
        await notify(pg, row.user_id, {
          kind: 'credential_renewal_reminder',
          title: `${label[0].toUpperCase() + label.slice(1)} credential expiring in ${window} days`,
          body,
          data: { case_id: row.case_id, window_days: window, expires_at: row.expires_at },
        });
        // Record idempotently — ON CONFLICT DO NOTHING handles races
        await pg.query(
          'INSERT INTO verification_renewal_reminders(case_id, window_days) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [row.case_id, window]);
        sent++;
      } catch {
        // log but keep going so one failed notify doesn't stop the sweep
      }
    }
  }

  return sent;
}
