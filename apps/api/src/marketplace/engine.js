// Shared rules of the marketplace framework (#600): who is a party to an engagement, the credential gate, the timeline and the response shapes.
// Authorisation lives here and in the capabilities; the app only calls the API. Free text is encrypted at rest and every decrypted read is audit-logged.
import { createHash } from 'node:crypto';
import { many, query } from '../db.js';

const db = (c) => c ?? { query };
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { toMajor } from '../currency.js';
import { audit } from '../helpers.js';
import { isYouth } from '../youth.js';
import { FAMILY } from './families.js';

export const ctx = { brief: 'marketplace_engagements.brief', delivery: 'marketplace_engagements.delivery_note', terms: 'marketplace_quotes.terms', message: 'marketplace_messages.body' };

/** Children act through a guardian; the marketplace is adult-to-adult. */
export async function mustBeAdult(user, c) {
  if (await isYouth(user.id, c)) throw forbidden('A guardian must act for you in the marketplace');
}

/** Approved, unexpired verification of the family's credential for the provider (null credential = nothing to check). */
export async function credentialState(providerId, family, c) {
  const need = FAMILY[family]?.credential ?? null;
  if (!need) return { required: false, type: null, ok: true, expires_at: null };
  const v = await db(c).query(
    "SELECT expires_at FROM verification_cases WHERE subject_type='user' AND subject_id=$1 AND type=$2 AND status='approved' AND (expires_at IS NULL OR expires_at > now()) ORDER BY expires_at DESC NULLS FIRST LIMIT 1", [providerId, need]);
  const row = v.rows[0];
  return { required: true, type: need, ok: !!row, expires_at: row?.expires_at ?? null };
}
export const mustHoldCredential = async (providerId, family, c) => {
  const s = await credentialState(providerId, family, c);
  if (!s.ok) throw conflict(`The provider has no current verified ${FAMILY[family].label.toLowerCase()} credential, so this cannot be contracted yet`);
  return s;
};

/** Is the user the buyer or provider, or an owner/admin of the organisation on that side? */
export async function sideOf(user, e, c) {
  const orgAdmin = async (orgId) => orgId && (await db(c).query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [orgId, user.id])).rows.length > 0;
  if (e.buyer_id === user.id || (await orgAdmin(e.buyer_org_id))) return 'buyer';
  if (e.provider_id === user.id || (await orgAdmin(e.provider_org_id))) return 'provider';
  return null;
}

/** Load an engagement the caller is a party to; anyone else gets 404 so its existence is not leaked. */
export async function loadEngagement(user, id, c, { lock = false } = {}) {
  const e = (await db(c).query(`SELECT * FROM marketplace_engagements WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  const side = e && (await sideOf(user, e, c));
  if (!side) throw notFound('Engagement');
  return { e, side };
}

export const need = (e, statuses, what) => { if (!statuses.includes(e.status)) throw conflict(`You cannot ${what} while the engagement is ${e.status}`); };

export const logEvent = (c, engagementId, actorId, kind, detail = {}) => c.query('INSERT INTO marketplace_events(engagement_id, actor_id, kind, detail) VALUES ($1,$2,$3,$4)', [engagementId, actorId, kind, detail]);

export const other = (e, side) => (side === 'buyer' ? e.provider_id : e.buyer_id);

/** The immutable terms snapshot written at contract time and its hash. */
export function snapshotTerms(e, quote, termsText) {
  const terms = { engagement: e.id, family: e.family, title: e.title, buyer: e.buyer_id, provider: e.provider_id, amount_minor: Number(quote.amount_minor), currency: quote.currency, quote_version: quote.version, valid_until: quote.valid_until, terms: termsText ?? null };
  return { terms, sha: createHash('sha256').update(JSON.stringify(terms)).digest('hex') };
}

export const seal = (text, key) => (text ? encrypt(text, ctx[key]) : null);

/** Public-safe engagement row for a party: names via the canonical identity, free text decrypted (and the read audit-logged). */
export async function describe(user, e, side, c) {
  const people = await many('SELECT id, display_name, handle, avatar_emoji, avatar_color FROM users WHERE id = ANY($1)', [[e.buyer_id, e.provider_id]]);
  const name = (id) => people.find((p) => p.id === id);
  if (e.brief_enc || e.delivery_note_enc) await audit(c, user.id, 'marketplace.read_text', 'marketplace_engagement', e.id);
  const { brief_enc, delivery_note_enc, terms_json, ...rest } = e;
  const cred = await credentialState(e.provider_id, e.family, c);
  const f = FAMILY[e.family];
  return {
    ...rest, my_side: side, buyer: name(e.buyer_id), provider: name(e.provider_id), family_label: f?.label,
    brief: decrypt(brief_enc, ctx.brief), delivery_note: decrypt(delivery_note_enc, ctx.delivery), contract: terms_json ?? null,
    credential: cred,
    next: nextSteps(e, side),
  };
}

/** What each side can do now; the app renders buttons from this so the rules stay on the server. */
export function nextSteps(e, side) {
  const s = e.status, steps = [];
  const live = ['requested', 'quoted', 'negotiating'];
  if (live.includes(s)) {
    steps.push('send_message');
    if (side === 'provider' && s === 'requested') steps.push('quote');
    if (s !== 'requested') steps.push('counter', 'accept_quote');
    if (side === 'provider') steps.push('decline');
    steps.push('cancel');
  }
  if (s === 'contracted') steps.push('schedule', 'send_message', 'cancel');
  if (s === 'scheduled') { steps.push('send_message', 'schedule', 'cancel'); if (side === 'provider') steps.push('deliver'); }
  if (s === 'delivered') { steps.push('send_message'); if (side === 'buyer') steps.push('accept_delivery'); }
  if (s === 'invoiced') { steps.push('send_message'); if (side === 'buyer') steps.push('pay'); }
  if (s === 'paid') { steps.push('send_message'); if (side === 'buyer') steps.push('review'); }
  if (s === 'reviewed') steps.push('send_message');
  return [...new Set(steps)];
}

export const badTimes = (starts, ends) => { if (ends && !(new Date(ends) > new Date(starts))) throw badRequest('The end must be after the start'); };

/** Gapless invoice number per provider, in the same promise venue, academy and team invoices make. */
async function invoiceNumber(c, provider) {
  const base = provider.display_name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
  const { seq } = (await c.query('INSERT INTO marketplace_invoice_counters(provider_id, seq) VALUES ($1,1) ON CONFLICT (provider_id) DO UPDATE SET seq = marketplace_invoice_counters.seq + 1 RETURNING seq', [provider.id])).rows[0];
  return `MK${base}${provider.id.replace(/-/g, '').toUpperCase().slice(0, 5)}-${new Date().getUTCFullYear()}-${String(seq).padStart(6, '0')}`;
}

/** The canonical invoice (shared `invoices` table) for accepted work: seller is the provider (or their organisation), the buyer is the payer. Paid at once when the agreement is free. */
export async function raiseInvoice(c, e) {
  const q = async (sql, p) => (await c.query(sql, p)).rows[0];
  const prov = await q('SELECT id, display_name FROM users WHERE id=$1', [e.provider_id]);
  const buyer = await q('SELECT id, display_name FROM users WHERE id=$1', [e.buyer_id]);
  const org = e.provider_org_id ? await q('SELECT name FROM organisations WHERE id=$1', [e.provider_org_id]) : null;
  const free = Number(e.agreed_minor) === 0;
  const lines = [{ description: `${e.title} (contract ${e.contract_number})`, amount_cents: Number(e.agreed_minor), tax_cents: 0 }];
  const inv = await q(
    `INSERT INTO invoices(kind, number, marketplace_engagement_id, user_id, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines, status, paid_at, payment_method)
     VALUES ('invoice',$1,$2,$3,$4,$5,0,'Tax',0,true,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [await invoiceNumber(c, prov), e.id, e.buyer_id, e.currency, Number(e.agreed_minor), JSON.stringify({ name: org?.name ?? prov.display_name, tax_id: null, address: null, phone: null, email: null }),
      encrypt(JSON.stringify({ name: buyer.display_name, address: null, tax_id: null }), 'invoices.buyer'), JSON.stringify(lines), free ? 'paid' : 'open', free ? new Date() : null, free ? 'other' : null]);
  return inv;
}

/** Payment landed: the engagement and its invoice become paid together. */
export async function fulfilMarketplacePaid(c, id) {
  const r = await c.query("UPDATE marketplace_engagements SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1 AND status='invoiced' RETURNING invoice_id", [id]);
  if (!r.rowCount) return false;
  await c.query("UPDATE invoices SET status='paid', paid_at=now(), payment_method='online' WHERE id=$1 AND status='open'", [r.rows[0].invoice_id]);
  await logEvent(c, id, null, 'paid');
  return true;
}
