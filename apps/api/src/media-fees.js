// Media rights fees (#482): what the payments module calls when a rights fee is paid or refunded. A fee is paid once; a refund of the whole payment marks it refunded.
import { notify } from './notify.js';
import { logMr } from './media-rights.js';

/** The checkout was paid: mark the fee paid. Returns false when it can no longer be fulfilled (cancelled meanwhile), so the payment is refunded. */
export async function fulfilMediaFeePaid(c, feeId) {
  const f = (await c.query("UPDATE mr_fees SET status='paid', paid_at=now(), paid_method='online' WHERE id=$1 AND status='awaiting_payment' RETURNING *", [feeId])).rows[0];
  if (!f) return false;
  const lic = (await c.query('SELECT l.licence_no, p.event_id, e.organizer_id FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN events e ON e.id=p.event_id WHERE l.id=$1', [f.licence_id])).rows[0];
  await logMr(c, lic.event_id, 'fee', f.id, 'paid', { actor: f.payer_id, detail: { method: 'online', amount_minor: Number(f.amount_minor), currency: f.currency } });
  await notify(c, lic.organizer_id, { kind: 'media_fee_paid', title: 'Rights fee received', body: `${f.number} for ${lic.licence_no} was paid.`, data: { fee_id: f.id, licence_id: f.licence_id }, dedupe_key: `mr-fee-paid:${f.id}` });
  return true;
}

/** Part of an online fee payment went back to the payer; once all of it has, the fee reads refunded. */
export async function syncMediaFeeRefund(c, payment) {
  if (payment.purpose_type !== 'media_rights_fee') return;
  if (Number(payment.refunded_cents) >= Number(payment.amount_cents)) {
    const f = (await c.query("UPDATE mr_fees SET status='refunded' WHERE id=$1 AND status='paid' RETURNING licence_id", [payment.purpose_id])).rows[0];
    if (f) await c.query("INSERT INTO mr_log(subject_type, subject_id, action, detail) VALUES ('fee',$1,'refunded','{}')", [payment.purpose_id]);
  }
}
