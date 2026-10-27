// Federation OS background work (#475). Standing is always read live (an approved affiliation past its end date already reads as expired), so nothing
// waits for this sweep: it makes the stored status match what everyone is already shown, lifts timed suspensions, writes the history rows, and sends the
// renewal reminders. Every step is idempotent (row-locked, guarded by status, deduplicated notifications), so a retried or concurrent run cannot double up.
import { tx, many } from './db.js';
import { notify } from './notify.js';
import { logFed } from './federation.js';

const REMIND_DAYS = [30, 7];

async function orgAdmins(c, orgId) {
  return (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [orgId])).rows.map((r) => r.user_id);
}

/** Affiliations and licences that ran out become expired (with a history row); timed suspensions that ended are lifted. Returns how many records changed. */
export async function expireFederationRecords() {
  let n = 0;
  for (const a of await many("SELECT id FROM fed_affiliations WHERE status IN ('approved','suspended') AND effective_to < current_date ORDER BY effective_to, id LIMIT 200")) {
    n += await tx(async (c) => {
      const r = (await c.query("UPDATE fed_affiliations SET status='expired', row_version=row_version+1, updated_at=now() WHERE id=$1 AND status IN ('approved','suspended') AND effective_to < current_date RETURNING *", [a.id])).rows[0];
      if (!r) return 0;
      await logFed(c, r.body_id, 'affiliation', r.id, 'expired', { to: 'expired', reason: 'End date reached' });
      for (const uid of await orgAdmins(c, r.organisation_id)) await notify(c, uid, { kind: 'federation_affiliation_expired', title: 'Affiliation expired', body: `Affiliation ${r.affiliation_no} has run out. Renew it to stay affiliated.`, data: { affiliation_id: r.id }, dedupe_key: `fed-aff-expired:${r.id}:${uid}` });
      return 1;
    });
  }
  for (const l of await many("SELECT id FROM fed_licences WHERE status IN ('active','suspended') AND expires_on < current_date ORDER BY expires_on, id LIMIT 200")) {
    n += await tx(async (c) => {
      const r = (await c.query("UPDATE fed_licences SET status='expired', row_version=row_version+1, updated_at=now() WHERE id=$1 AND status IN ('active','suspended') AND expires_on < current_date RETURNING *", [l.id])).rows[0];
      if (!r) return 0;
      await logFed(c, r.body_id, 'licence', r.id, 'expired', { to: 'expired', reason: 'Expiry date reached' });
      for (const uid of new Set([r.holder_id, r.applicant_id])) await notify(c, uid, { kind: 'federation_licence_expired', title: 'Licence expired', body: `Licence ${r.licence_no} has expired. Renew it to compete or officiate.`, data: { licence_id: r.id }, dedupe_key: `fed-lic-expired:${r.id}:${uid}` });
      return 1;
    });
  }
  for (const l of await many("SELECT id FROM fed_licences WHERE status='suspended' AND suspended_until IS NOT NULL AND suspended_until < current_date ORDER BY suspended_until, id LIMIT 200")) {
    n += await tx(async (c) => {
      const r = (await c.query("UPDATE fed_licences SET status='active', suspended_until=NULL, row_version=row_version+1, updated_at=now() WHERE id=$1 AND status='suspended' AND suspended_until < current_date AND expires_on >= current_date RETURNING *", [l.id])).rows[0];
      if (!r) return 0;
      await logFed(c, r.body_id, 'licence', r.id, 'suspension_ended', { from: 'suspended', to: 'active', reason: 'The suspension period ended' });
      for (const uid of new Set([r.holder_id, r.applicant_id])) await notify(c, uid, { kind: 'federation_licence_reinstate', title: 'Licence active again', body: `Your suspension ended; licence ${r.licence_no} is active.`, data: { licence_id: r.id }, dedupe_key: `fed-lic-lift:${r.id}:${uid}` });
      return 1;
    });
  }
  return n;
}

/** One reminder per record at 30 and at 7 days before it runs out. */
export async function sendFederationReminders() {
  let n = 0;
  for (const d of REMIND_DAYS) {
    for (const a of await many("SELECT a.*, bo.name AS body_name, (a.effective_to - current_date)::int AS left FROM fed_affiliations a JOIN governing_bodies b ON b.id=a.body_id JOIN organisations bo ON bo.id=b.organisation_id WHERE a.status='approved' AND a.effective_to BETWEEN current_date AND current_date + $1::int ORDER BY a.effective_to LIMIT 500", [d])) {
      if (REMIND_DAYS.find((x) => x < d && a.left <= x)) continue;      // the closer reminder covers it
      await tx(async (c) => { for (const uid of await orgAdmins(c, a.organisation_id)) if (await notify(c, uid, { kind: 'federation_affiliation_renewal', title: 'Affiliation renewal due', body: `${a.body_name}: affiliation ${a.affiliation_no} ends in ${a.left} days.`, data: { affiliation_id: a.id }, dedupe_key: `fed-aff-renew:${a.id}:${d}:${uid}` })) n++; });
    }
    for (const l of await many("SELECT l.*, bo.name AS body_name, (l.expires_on - current_date)::int AS left FROM fed_licences l JOIN governing_bodies b ON b.id=l.body_id JOIN organisations bo ON bo.id=b.organisation_id WHERE l.status='active' AND l.expires_on BETWEEN current_date AND current_date + $1::int ORDER BY l.expires_on LIMIT 500", [d])) {
      if (REMIND_DAYS.find((x) => x < d && l.left <= x)) continue;
      await tx(async (c) => { for (const uid of new Set([l.holder_id, l.applicant_id])) if (await notify(c, uid, { kind: 'federation_licence_renewal', title: 'Licence renewal due', body: `${l.body_name}: licence ${l.licence_no} expires in ${l.left} days.`, data: { licence_id: l.id }, dedupe_key: `fed-lic-renew:${l.id}:${d}:${uid}` })) n++; });
    }
  }
  return n;
}

export const runFederationSweeps = async () => ({ changed: await expireFederationRecords(), reminders: await sendFederationReminders() });
