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
  fixture: ['fixtures'],
};
export const LINK_TYPES = Object.keys(PARTY);

// Who gets paid for a payment's purpose (so the payee can raise a "I was not paid" dispute against the payment).
const PAYEE = { coach_hire: ['coach_hires', 'coach_id'], shop_order: ['shop_orders', 'seller_id'], appointment: ['appointments', 'provider_id'] };
// payments.purpose_type that belongs to each linkable engagement type
const PURPOSE_OF = { coach_hire: 'coach_hire', shop_order: 'shop_order', appointment: 'appointment', invoice: 'venue_invoice', insurance_policy: 'insurance_policy' };

async function isPayee(user, payment) {
  const [table, col] = PAYEE[payment.purpose_type] ?? [];
  if (!table) return false;
  const row = await one(`SELECT ${col} AS payee FROM ${table} WHERE id=$1`, [payment.purpose_id]);
  return row?.payee === user.id;
}

export async function assertCanLink(user, type, id) {
  const [table, ...cols] = PARTY[type];
  const row = await one(`SELECT * FROM ${table} WHERE id=$1`, [id]);
  const ok = row && (isAdmin(user) || !cols.length || cols.some((c) => row[c] === user.id)
    || (type === 'sponsorship' && row.target_type === 'athlete' && row.target_id === user.id)
    || (type === 'payment' && await isPayee(user, row)));
  if (!ok) throw notFound(type.replace(/_/g, ' '));
}

// ---------------------------------------------------------------- typed disputes
// What each dispute category must reference, and whether it carries a disputed amount.
const DISPUTE_RULES = {
  booking_charge: { any: ['reservation', 'booking', 'invoice', 'payment'], amount: true },
  refund: { any: ['reservation', 'invoice', 'payment', 'shop_order', 'coach_hire'], amount: true },
  payment_transfer: { need: ['payment'], amount: true },
  provider_payment: { need: ['payment'], any: ['coach_hire', 'appointment'], amount: true },
  game_data: { any: ['game', 'fixture'], field: true },
  other: {},
};
export const GAME_FIELDS = { game: ['score', 'outcome', 'outcome_type', 'rank'], fixture: ['home_score', 'away_score'] };
const OUTCOMES = ['win', 'loss', 'tie', 'undecided', 'show', 'place'];
const OUTCOME_TYPES = ['regular', 'overtime', 'shootout', 'extra-time', 'random', 'authority-decision', 'decision-unanimous'];

/** Parse a claimed value for a contested game field. Throws badRequest for anything that could not be a valid value. */
export function parseClaim(field, raw) {
  const num = (min, int) => { const n = Number(raw); if (raw === '' || !Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw badRequest(`${field} must be ${int ? 'a whole number' : 'a number'} of at least ${min}`); return n; };
  if (field === 'score') return num(-1e9, false);
  if (field === 'rank') return num(1, true);
  if (field === 'home_score' || field === 'away_score') return num(0, true);
  const list = field === 'outcome' ? OUTCOMES : OUTCOME_TYPES;
  if (!list.includes(raw)) throw badRequest(`${field} must be one of: ${list.join(', ')}`);
  return raw;
}

async function involvedInGame(user, gameId) {
  return !!(await one(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM game_participants WHERE game_id=$1 AND user_id=$2)
        OR EXISTS (SELECT 1 FROM associations WHERE target_type='game' AND target_id=$1 AND user_id=$2 AND status='active')
        OR EXISTS (SELECT 1 FROM game_participants p JOIN team_members m ON m.team_id=p.team_id AND m.status='active' WHERE p.game_id=$1 AND m.user_id=$2)`, [gameId, user.id]));
}
async function involvedInFixture(user, f) {
  return !!(await one("SELECT 1 FROM team_members WHERE user_id=$1 AND status='active' AND team_id = ANY($2)", [user.id, [f.home_team_id, f.away_team_id].filter(Boolean)]));
}

/** A provider dispute that names the engagement (hire / appointment) but not its payment gets the engagement's latest payment linked. */
export async function inferPaymentLink(i) {
  if (i.kind !== 'dispute' || i.category !== 'provider_payment' || i.links.some((l) => l.type === 'payment')) return i.links;
  const eng = i.links.find((l) => PURPOSE_OF[l.type] && ['coach_hire', 'appointment'].includes(l.type));
  const pay = eng && await one("SELECT id FROM payments WHERE purpose_type=$1 AND purpose_id=$2 AND status IN ('paid','refunded') ORDER BY created_at DESC LIMIT 1", [PURPOSE_OF[eng.type], eng.id]);
  return pay ? [...i.links, { type: 'payment', id: pay.id }] : i.links;
}

/**
 * Check a dispute's category rules against the canonical records it links and build the stored `details`
 * (currency and ceiling come from those records, never from the client). Returns { details, routed_to }.
 */
export async function validateDispute(user, i) {
  const rule = DISPUTE_RULES[i.category];
  const of = (...t) => i.links.filter((l) => t.includes(l.type));
  for (const t of rule.need ?? []) if (!of(t).length) throw badRequest(`A ${i.category.replace(/_/g, ' ')} dispute must link a ${t.replace(/_/g, ' ')}`);
  if (rule.any && !of(...rule.any).length) throw badRequest(`A ${i.category.replace(/_/g, ' ')} dispute must link one of: ${rule.any.join(', ')}`);
  const details = { ...(i.details ?? {}) };

  // money: the payment (or invoice / reservation / hire) sets the currency and the ceiling of the disputed amount
  let ceiling = null;
  const pay = of('payment')[0] ? await one('SELECT * FROM payments WHERE id=$1', [of('payment')[0].id]) : null;
  for (const l of of(...Object.keys(PURPOSE_OF))) {
    if (pay && PURPOSE_OF[l.type] && (pay.purpose_type !== PURPOSE_OF[l.type] || pay.purpose_id !== l.id)) throw badRequest(`That payment is not for the ${l.type.replace(/_/g, ' ')} you linked`);
  }
  if (pay) ceiling = { cents: Number(pay.amount_cents), currency: pay.currency };
  else {
    const src = of('invoice')[0] ? ['invoices', of('invoice')[0].id] : of('reservation')[0] ? ['reservations', of('reservation')[0].id] : of('coach_hire')[0] ? ['coach_hires', of('coach_hire')[0].id] : null;
    const row = src && await one(`SELECT total_cents, ${src[0] === 'coach_hires' ? 'NULL::text' : 'currency'} AS currency FROM ${src[0]} WHERE id=$1`, [src[1]]);
    if (row) ceiling = { cents: Number(row.total_cents), currency: row.currency };
  }
  if (rule.amount) {
    if (!details.disputed_amount_cents) throw badRequest('Say how much is disputed (disputed_amount_cents)');
    if (ceiling && details.disputed_amount_cents > ceiling.cents) throw badRequest('The disputed amount is more than the linked record');
    if (ceiling?.currency) details.currency = ceiling.currency;
    else if (!details.currency) throw badRequest('currency is required');
  } else if (details.disputed_amount_cents !== undefined) throw badRequest('This category has no disputed amount');

  // game data: capture the contested field and its current value; the source record is not touched
  let routed_to = 'platform';
  if (rule.field) {
    routed_to = 'game_officials';
    const l = of('game', 'fixture')[0];
    if (of('game', 'fixture').length > 1) throw badRequest('Link one game or one fixture');
    if (!details.contested_field || details.claimed_value === undefined) throw badRequest('Say which field is wrong (contested_field) and what it should be (claimed_value)');
    if (!GAME_FIELDS[l.type].includes(details.contested_field)) throw badRequest(`contested_field must be one of: ${GAME_FIELDS[l.type].join(', ')}`);
    details.claimed_value = parseClaim(details.contested_field, details.claimed_value);
    if (l.type === 'game') {
      if (!details.participant_id) throw badRequest('participant_id is required for a game dispute');
      const p = await one('SELECT * FROM game_participants WHERE id=$1 AND game_id=$2', [details.participant_id, l.id]);
      if (!p) throw notFound('Participant');
      if (!(await involvedInGame(user, l.id))) throw notFound('game');
      details.current_value = p[details.contested_field] === null ? null : isNaN(Number(p[details.contested_field])) ? p[details.contested_field] : Number(p[details.contested_field]);
    } else {
      if (details.participant_id) throw badRequest('participant_id is only for games');
      const f = await one('SELECT * FROM fixtures WHERE id=$1', [l.id]);
      if (!(await involvedInFixture(user, f))) throw notFound('fixture');
      details.current_value = f[details.contested_field];
    }
  } else if (details.contested_field !== undefined || details.claimed_value !== undefined || details.participant_id !== undefined) throw badRequest('Contested fields are only for game data disputes');
  return { details, routed_to };
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
