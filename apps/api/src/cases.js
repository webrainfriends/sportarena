// Rules for support & dispute cases: categories, SLA targets, which linked records a person may attach, evidence handling.
import { createHash } from 'node:crypto';
import { one } from './db.js';
import { badRequest, notFound } from './errors.js';
import { encrypt } from './crypto.js';
import { isAdmin } from './helpers.js';

export const CATEGORIES = {
  support: ['account', 'bookings', 'payments', 'events', 'health', 'insurance', 'sponsorship', 'technical', 'other'],
  dispute: ['booking_charge', 'refund', 'payment_transfer', 'provider_payment', 'game_data', 'other'],
};
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const ACTIVE = ['open', 'in_progress', 'awaiting_user', 'escalated'];
export const REOPEN_WINDOW_DAYS = 14;

/** Hours until the first staff response / until resolution, by priority. */
export const SLA_HOURS = { urgent: [2, 24], high: [8, 72], normal: [24, 120], low: [72, 240] };
export const slaDue = (priority, from = Date.now()) => {
  const [first, resolve] = SLA_HOURS[priority];
  return { first: new Date(from + first * 36e5), resolution: new Date(from + resolve * 36e5) };
};
/** SQL for the live SLA state of a case row aliased `c`. */
export const SLA_SQL = `CASE WHEN c.status IN ('resolved','withdrawn') THEN NULL
  WHEN (c.first_responded_at IS NULL AND c.first_response_due < now()) OR c.resolution_due < now() THEN 'breached'
  WHEN (c.first_responded_at IS NULL AND c.first_response_due < now() + interval '2 hours') OR c.resolution_due < now() + interval '4 hours' THEN 'at_risk'
  ELSE 'ok' END`;

// How a person proves they are party to a linked record. Public records (events, games) only need to exist.
// A miss is reported as "not found" so nobody can probe for other people's ids.
const PARTY = {
  reservation: ['reservations', 'user_id'],
  booking: ['bookings', 'user_id'],
  invoice: ['invoices', 'user_id'],
  payment: ['payments', 'payer_id'],
  shop_order: ['shop_orders', 'buyer_id', 'seller_id'],
  coach_hire: ['coach_hires', 'hirer_id', 'coach_id'],
  appointment: ['appointments', 'athlete_id', 'provider_id'],
  insurance_policy: ['insurance_policies', 'holder_id'],
  sponsorship: ['sponsorships', 'proposed_by'],
  event: ['events'],
  game: ['games'],
};
export const LINK_TYPES = Object.keys(PARTY);

export async function assertCanLink(user, type, id) {
  const [table, ...cols] = PARTY[type];
  const row = await one(`SELECT * FROM ${table} WHERE id=$1`, [id]);
  const ok = row && (isAdmin(user) || !cols.length || cols.some((c) => row[c] === user.id)
    || (type === 'sponsorship' && row.target_type === 'athlete' && row.target_id === user.id));
  if (!ok) throw notFound(type.replace(/_/g, ' '));
}

const MAX_FILE = 5 * 2 ** 20;
function sniffDoc(b) {
  const hex = b.subarray(0, 8).toString('hex'), txt = b.subarray(0, 12).toString('latin1');
  if (txt.startsWith('%PDF-')) return 'application/pdf';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex === '89504e470d0a1a0a') return 'image/png';
  if (txt.startsWith('RIFF') && txt.slice(8) === 'WEBP') return 'image/webp';
  return null;
}

/** Validate one evidence item (https link and/or PDF/JPEG/PNG/WebP file up to 5 MB) and turn it into encrypted columns. */
export function prepEvidence(e) {
  if (e.reference && /^[a-z]+:\/\//i.test(e.reference) && !/^https:\/\//i.test(e.reference)) throw badRequest('Links must use https');
  const out = { label: e.label ?? null, reference_enc: e.reference ? encrypt(e.reference, 'case_evidence.reference') : null, file_name: null, content_type: null, size_bytes: null, sha256: null, file_enc: null };
  if (e.data) {
    const b64 = e.data.replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 16) throw badRequest('That file is empty');
    if (buf.length > MAX_FILE) throw badRequest(`Files can be up to ${MAX_FILE / 2 ** 20} MB`);
    const type = sniffDoc(buf);
    if (!type) throw badRequest('Unsupported file. Use PDF, JPEG, PNG or WebP.');
    Object.assign(out, { file_name: (e.file_name ?? 'document').replace(/[^\w. -]/g, '_').slice(0, 120), content_type: type, size_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), file_enc: encrypt(b64, 'case_evidence.file') });
  }
  return out;
}
