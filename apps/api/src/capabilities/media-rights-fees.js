// Sports Media, Broadcast & Rights (#482): rights-fee billing. The contracted fee lives on the licence; fees are what the organiser has invoiced against it and
// what has been collected, either through the platform's hosted checkout (payments purpose `media_rights_fee`) or recorded as received outside it. A licence can never
// be invoiced beyond its contracted fee, each currency stands alone, and every step is in the append-only history.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { logMr, eventOf, isOrganiserOf, partnerFor, partnerAdmins, WRITE_ROLES, LIC_STAGE } from '../media-rights.js';

const TAG = 'Media rights fees';
const text = (n) => z.string().trim().max(n);

async function side(user, licenceId, c = pool) {
  const lic = (await c.query(`SELECT l.*, ${LIC_STAGE('l')} AS stage_now, p.event_id, e.name AS event_name FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN events e ON e.id=p.event_id WHERE l.id=$1`, [licenceId])).rows[0];
  if (!lic) throw notFound('Licence');
  const ev = await eventOf(lic.event_id, c);
  const organiser = await isOrganiserOf(user, ev, c);
  let partner = null; try { partner = await partnerFor(user, lic.partner_id, { c }); } catch { /* not a member */ }
  if (!organiser && !partner) throw notFound('Licence');
  return { lic, ev, organiser, partner, partnerCanAct: !!partner && WRITE_ROLES.includes(partner.role) };
}
const feeSide = async (user, feeId, c = pool, lock = false) => {
  const f = (await c.query(`SELECT * FROM mr_fees WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [feeId])).rows[0];
  if (!f) throw notFound('Fee');
  return { f, ...(await side(user, f.licence_id, c)) };
};
const totals = (lic, fees) => {
  const sum = (...st) => fees.filter((x) => st.includes(x.status)).reduce((t, x) => t + Number(x.amount_minor), 0);
  const invoiced = sum('awaiting_payment', 'paid', 'refunded');
  return { currency: lic.currency, contracted_minor: Number(lic.fee_minor), invoiced_minor: invoiced, collected_minor: sum('paid'), outstanding_minor: sum('awaiting_payment'), refunded_minor: sum('refunded'), not_yet_invoiced_minor: Math.max(0, Number(lic.fee_minor) - invoiced) };
};
const FEE_VIEW = `f.id, f.licence_id, f.number, f.kind, f.description, f.amount_minor, f.currency, f.due_on::text AS due_on, f.status, f.paid_at, f.paid_method, f.offline_ref, f.cancel_reason, f.payer_id, u.display_name AS payer_name, f.created_at,
  (f.status='awaiting_payment' AND f.due_on IS NOT NULL AND f.due_on < current_date) AS overdue`;

cap({
  name: 'issue_media_fee', method: 'POST', path: '/media/licences/:id/fees', tag: TAG, status: 201,
  summary: 'Invoice a rights fee against a licence (organiser only): the amount (default: everything not yet invoiced), a due date and a description. The total invoiced can never exceed the licence\'s contracted fee, and it is billed in the licence currency. The partner pays it by hosted checkout (payment purpose `media_rights_fee`), or you record it as received outside the platform. The payer is a partner member who can act (default: its first owner or admin).',
  input: z.object({ id, amount_minor: z.number().int().min(1).max(1_000_000_000_000).optional(), description: text(200).optional(), due_on: z.string().date().optional(), payer_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await side(user, i.id, c);
    await c.query('SELECT id FROM mr_licences WHERE id=$1 FOR UPDATE', [i.id]);
    if (!a.organiser) throw forbidden('Only the organiser can invoice a rights fee');
    if (!['active', 'suspended', 'expired'].includes(a.lic.stage_now)) throw conflict('Only a licence that has been agreed can be invoiced');
    const fees = (await c.query('SELECT status, amount_minor FROM mr_fees WHERE licence_id=$1', [i.id])).rows;
    const t = totals(a.lic, fees);
    const amount = i.amount_minor ?? t.not_yet_invoiced_minor;
    if (amount <= 0) throw conflict('The contracted fee has already been invoiced in full', { code: 'fee_fully_invoiced' });
    if (amount > t.not_yet_invoiced_minor) throw badRequest(`That is more than the ${t.not_yet_invoiced_minor} still to invoice of the contracted fee`, { code: 'exceeds_contracted_fee', remaining_minor: t.not_yet_invoiced_minor });
    const admins = await partnerAdmins(c, a.lic.partner_id);
    const payer = i.payer_id ?? admins[0];
    if (!payer || !admins.includes(payer)) throw badRequest('The payer must be a member of the partner who can act for it');
    const seq = (await c.query('UPDATE media_partners SET fee_seq=fee_seq+1 WHERE id=$1 RETURNING fee_seq AS n', [a.lic.partner_id])).rows[0].n;
    const number = `MRF-${new Date().getFullYear()}-${a.lic.partner_id.slice(0, 4).toUpperCase()}-${String(seq).padStart(4, '0')}`;
    const f = (await c.query(
      'INSERT INTO mr_fees(licence_id, number, kind, description, amount_minor, currency, due_on, payer_id, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [i.id, number, amount === Number(a.lic.fee_minor) ? 'licence_fee' : 'instalment', i.description ?? null, amount, a.lic.currency, i.due_on ?? null, payer, user.id])).rows[0];
    await logMr(c, a.lic.event_id, 'fee', f.id, 'issued', { actor: user.id, detail: { number, amount_minor: amount, currency: f.currency, licence_id: i.id } });
    await notify(c, payer, { kind: 'media_fee_issued', title: 'Rights fee to pay', body: `${number} · ${a.lic.event_name}${i.due_on ? ` · due ${i.due_on}` : ''}.`, data: { fee_id: f.id, licence_id: i.id }, dedupe_key: `mr-fee-issued:${f.id}` });
    return (await c.query(`SELECT ${FEE_VIEW} FROM mr_fees f JOIN users u ON u.id=f.payer_id WHERE f.id=$1`, [f.id])).rows[0];
  }),
});

cap({
  name: 'list_media_fees', method: 'GET', path: '/media/licences/:id/fees', tag: TAG,
  summary: 'The fees invoiced against a licence with what is contracted, invoiced, collected, outstanding and refunded (one currency: the licence\'s). The organiser and the partner\'s members can read it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await side(user, i.id);
    const fees = await many(`SELECT ${FEE_VIEW} FROM mr_fees f JOIN users u ON u.id=f.payer_id WHERE f.licence_id=$1 ORDER BY f.created_at`, [i.id]);
    return { fees, totals: totals(a.lic, fees), as: { organiser: a.organiser, can_pay: a.partnerCanAct } };
  },
});

cap({
  name: 'take_over_media_fee', method: 'POST', path: '/media/fees/:id/payer', tag: TAG,
  summary: 'Make yourself the payer of an unpaid rights fee (any partner member who can act for the partner). Only the payer can start the checkout.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await feeSide(user, i.id, c, true);
    if (!a.partnerCanAct) throw a.organiser ? forbidden('Only the partner chooses who pays') : notFound('Fee');
    if (a.f.status !== 'awaiting_payment') throw conflict('This fee is not awaiting payment');
    await c.query('UPDATE mr_fees SET payer_id=$2 WHERE id=$1', [a.f.id, user.id]);
    await logMr(c, a.lic.event_id, 'fee', a.f.id, 'payer_changed', { actor: user.id });
    return { id: a.f.id, payer_id: user.id };
  }),
});

cap({
  name: 'cancel_media_fee', method: 'POST', path: '/media/fees/:id/cancel', tag: TAG,
  summary: 'Cancel a rights fee that has not been paid (organiser). It stays on record as cancelled, no longer counts as invoiced, and can be re-issued.',
  input: z.object({ id, reason: text(500).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await feeSide(user, i.id, c, true);
    if (!a.organiser) throw forbidden('Only the organiser can cancel a fee');
    if (a.f.status !== 'awaiting_payment') throw conflict('Only an unpaid fee can be cancelled');
    await c.query("UPDATE mr_fees SET status='cancelled', cancel_reason=$2 WHERE id=$1", [a.f.id, i.reason]);
    await logMr(c, a.lic.event_id, 'fee', a.f.id, 'cancelled', { actor: user.id, detail: { reason: i.reason } });
    await notify(c, a.f.payer_id, { kind: 'media_fee_cancelled', title: 'Rights fee cancelled', body: `${a.f.number}: ${i.reason}`, data: { fee_id: a.f.id }, dedupe_key: `mr-fee-cancel:${a.f.id}` });
    return { id: a.f.id, status: 'cancelled' };
  }),
});

cap({
  name: 'record_media_fee_payment', method: 'POST', path: '/media/fees/:id/received', tag: TAG,
  summary: 'Record that a rights fee was received outside the platform (bank transfer, cheque): organiser only, with a reference. It then counts as collected, marked offline. If an online payment arrives later for a fee already paid, it is refunded automatically.',
  input: z.object({ id, reference: text(160).min(2) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await feeSide(user, i.id, c, true);
    if (!a.organiser) throw forbidden('Only the organiser can record a payment received');
    if (a.f.status !== 'awaiting_payment') throw conflict('Only an unpaid fee can be marked received');
    await c.query("UPDATE mr_fees SET status='paid', paid_at=now(), paid_method='offline', offline_ref=$2, recorded_by=$3 WHERE id=$1", [a.f.id, i.reference, user.id]);
    await logMr(c, a.lic.event_id, 'fee', a.f.id, 'paid', { actor: user.id, detail: { method: 'offline', reference: i.reference, amount_minor: Number(a.f.amount_minor), currency: a.f.currency } });
    await notify(c, a.f.payer_id, { kind: 'media_fee_received', title: 'Rights fee received', body: `${a.f.number} was recorded as received.`, data: { fee_id: a.f.id }, dedupe_key: `mr-fee-recv:${a.f.id}` });
    return { id: a.f.id, status: 'paid', paid_method: 'offline' };
  }),
});
