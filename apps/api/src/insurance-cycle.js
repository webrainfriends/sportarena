// Background upkeep for insurance: expire quotes that ran out, and remind holders before a policy ends.
// Nothing is deleted: a quote just becomes 'expired', and the reminder step is remembered on the policy so it is sent once.
import { many, query, tx } from './db.js';
import { notify } from './notify.js';

export async function expireQuotes() {
  const rows = (await query("UPDATE insurance_quotes SET status='expired', decided_at=now(), updated_at=now() WHERE status='offered' AND valid_until < current_date RETURNING id, request_id, insurer_id, buyer_id")).rows;
  for (const q of rows) {
    await query("INSERT INTO insurance_quote_events(request_id, quote_id, insurer_id, actor_id, action, detail) VALUES ($1,$2,$3,NULL,'quote_expired','The quote was not accepted in time')", [q.request_id, q.id, q.insurer_id]);
    if (q.request_id) await query("UPDATE insurance_quote_requests SET status='open', updated_at=now() WHERE id=$1 AND status='quoted' AND NOT EXISTS (SELECT 1 FROM insurance_quotes WHERE request_id=$1 AND status='offered')", [q.request_id]);
  }
  return rows.length;
}

/** 30 days and again 7 days before the end, for policies that have not been renewed. */
export async function sendRenewalReminders() {
  let sent = 0;
  for (const step of [7, 30]) {
    const due = await many(
      `SELECT p.id, p.holder_id, p.ends_on, pl.name AS plan_name FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id
        WHERE p.status='active' AND p.ends_on >= current_date AND p.ends_on <= current_date + $1::int AND (p.renewal_notice_days IS NULL OR p.renewal_notice_days > $1)
          AND NOT EXISTS (SELECT 1 FROM insurance_policies r WHERE r.renewed_from = p.id)`, [step]);
    for (const p of due) {
      await tx(async (c) => {
        const won = await c.query('UPDATE insurance_policies SET renewal_notice_days=$2 WHERE id=$1 AND (renewal_notice_days IS NULL OR renewal_notice_days > $2)', [p.id, step]);
        if (!won.rowCount) return;
        const days = Math.max(0, Math.round((new Date(p.ends_on) - new Date(new Date().toISOString().slice(0, 10))) / 864e5));
        await notify(c, p.holder_id, { kind: 'insurance_renewal', title: 'Your insurance is due for renewal', body: `${p.plan_name} ends in ${days} day${days === 1 ? '' : 's'}. Renew it to stay covered.`, data: { policy_id: p.id } });
        sent++;
      });
    }
  }
  return sent;
}
