// Platform (SportArena team) helpers: who counts as platform staff, the bootstrap of the platform owner account,
// the approval switch, the contract text and the explainable "assistant" scoring used by the partner module.
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { one } from './db.js';
import { blindIndex, encrypt, hashPassword } from './crypto.js';

/** Platform team = the `admin` role. The platform owner additionally holds `platform_admin` and is the only one who can add team members. */
export const isPlatform = (user) => !!user?.roles?.includes('admin');
export const isPlatformOwner = (user) => !!user?.roles?.includes('platform_admin');

/** When false (development / tests only) venues and prices go live without platform approval. Production always requires it. */
export const approvalsOn = () => config.isProd || process.env.PLATFORM_APPROVALS !== 'off';

/**
 * Create the platform owner account from PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD (+ optional _HANDLE, _NAME).
 * Idempotent. It never changes the password of an existing account and never promotes an account that is not already the
 * platform owner (an existing ordinary account with that email is left alone and reported).
 */
export async function bootstrapPlatformOwner(log = console) {
  const { PLATFORM_ADMIN_EMAIL: email, PLATFORM_ADMIN_PASSWORD: password } = process.env;
  if (!email || !password) return null;
  const handle = (process.env.PLATFORM_ADMIN_HANDLE ?? 'platformarena').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24);
  const name = process.env.PLATFORM_ADMIN_NAME ?? 'PlatformArena';
  const existing = await one('SELECT id, roles FROM users WHERE email_idx = $1', [blindIndex(email)]);
  if (existing) {
    if (existing.roles.includes('platform_admin')) return existing.id;
    log.error('[platform] PLATFORM_ADMIN_EMAIL belongs to an ordinary account; refusing to promote it. Use a fresh email address.');
    return null;
  }
  if (await one('SELECT 1 AS x FROM users WHERE handle = $1', [handle])) { log.error(`[platform] handle "${handle}" is taken; set PLATFORM_ADMIN_HANDLE`); return null; }
  const row = await one(
    `INSERT INTO users(handle, display_name, roles, password_hash, email_enc, email_idx, avatar_emoji, avatar_color)
     VALUES ($1,$2,'{admin,platform_admin}',$3,$4,$5,'🏛️','#4F46E5') RETURNING id`,
    [handle, name, hashPassword(password), encrypt(email, 'users.email'), blindIndex(email)]);
  log.log(`[platform] created platform owner account "${handle}"`);
  return row.id;
}

// ------------------------------------------------------------------ contract terms and text
export const DEFAULT_TERMS = {
  commission_bp: 1500, commission_tax_bp: 1800, gateway_fee_bp: 200, reserve_bp: 500, reserve_days: 30,
  settlement_cycle: 'weekly', settlement_delay_days: 3, term_months: 12, auto_renew: true, notice_days: 30,
  exclusivity: false, governing_law: 'the laws of India',
};

export const DEFAULT_TEMPLATE = `PARTNER VENUE AGREEMENT  {{contract_no}}

Between SportArena (the "Platform") and {{partner_legal_name}} (the "Partner"){{venue_clause}}.

1. TERM. Effective {{effective_from}}{{effective_to_clause}}, for {{term_months}} months{{auto_renew_clause}}. Either side may end it with {{notice_days}} days' written notice.
2. LISTING AND PRICING. The Platform lists the Partner's venue and publishes the price list the Platform sets for it, taking into account location, demand, rating, facilities and discounts. The Partner may propose price changes through the Platform; a change takes effect only once the Platform approves it.
3. REVENUE SHARE. The Platform retains {{commission_pct}}% commission on ex-tax booking sales (net of refunds and credit notes). Tax of {{commission_tax_pct}}% applies to the commission. Online payment costs of {{gateway_fee_pct}}% are deducted from money the Platform collects.
4. SETTLEMENT. Settled {{settlement_cycle}}, paid {{settlement_delay_days}} days after the period closes. {{reserve_clause}} Bookings paid at the venue are collected by the Partner; the commission on them is set off against the Partner's next payout, or invoiced if the balance is negative.
5. REFUNDS AND DISPUTES. Refunds follow the venue's published cancellation policy and are deducted from the period in which they are issued. Disputes follow the Platform's dispute process.
6. EXCLUSIVITY. {{exclusivity_clause}}
7. GOVERNING LAW. This agreement is governed by {{governing_law}}.
{{custom_clauses}}`;

const pct = (bp) => (bp / 100).toFixed(2).replace(/\.00$/, '');

export function renderContract({ template = DEFAULT_TEMPLATE, contractNo, partner, venue, terms, clauses = [], effectiveFrom, effectiveTo }) {
  const v = {
    contract_no: contractNo, partner_legal_name: partner.legal_name || partner.name,
    venue_clause: venue ? ` for the venue "${venue.name}"${venue.city ? `, ${venue.city}` : ''}` : ' for all venues the Partner operates on the Platform',
    effective_from: effectiveFrom, effective_to_clause: effectiveTo ? ` until ${effectiveTo}` : '', term_months: terms.term_months,
    auto_renew_clause: terms.auto_renew ? ', renewing automatically for further periods of the same length' : ', without automatic renewal', notice_days: terms.notice_days,
    commission_pct: pct(terms.commission_bp), commission_tax_pct: pct(terms.commission_tax_bp), gateway_fee_pct: pct(terms.gateway_fee_bp),
    settlement_cycle: terms.settlement_cycle, settlement_delay_days: terms.settlement_delay_days,
    reserve_clause: terms.reserve_bp > 0 ? `${pct(terms.reserve_bp)}% of each online payout is held as a reserve for ${terms.reserve_days} days against refunds and chargebacks, then released.` : 'No reserve is held.',
    exclusivity_clause: terms.exclusivity ? 'The Partner lists the venue for online booking only on the Platform during the term.' : 'The Partner may also list the venue elsewhere.',
    governing_law: terms.governing_law,
    custom_clauses: clauses.length ? '\nADDITIONAL CLAUSES\n' + clauses.map((c, n) => `A${n + 1}. ${c.title ? `${c.title.toUpperCase()}. ` : ''}${c.text}`).join('\n') : '',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(v[k] ?? ''));
}
export const sha = (s) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ assistant scoring (deterministic and explainable)
/** Application review: completeness, risk and recommended commercial terms. Every point of the score is explained. */
export function reviewApplication({ partner, venues, docs, checklist }) {
  const reasons = [];
  let risk = 50;
  const add = (delta, why) => { risk += delta; reasons.push({ delta, why }); };
  if (docs.tax_id) add(-10, 'Tax id on file'); else add(+15, 'No tax id yet');
  if (docs.payout) add(-10, 'Payout account on file'); else add(+10, 'No payout account yet');
  if (docs.contact) add(-5, 'Contact details complete'); else add(+10, 'Contact details incomplete');
  if (partner.legal_name) add(-5, 'Legal name given'); else add(+5, 'Legal name missing');
  const resources = venues.reduce((s, v) => s + v.resources, 0);
  if (venues.length && resources === 0) add(+10, 'Venue has no courts / areas yet');
  if (venues.some((v) => v.latitude != null)) add(-5, 'Venue has map coordinates'); else if (venues.length) add(+5, 'Venue has no map location');
  if (venues.some((v) => v.hours > 0)) add(-3, 'Opening hours set');
  const verified = venues.some((v) => v.verified);
  if (verified) add(-10, 'Venue already carries a verified badge');
  const open = ['tax_id', 'payout', 'contract_signed'].filter((k) => !checklist[k]);
  risk = Math.max(0, Math.min(100, risk));
  const band = risk <= 30 ? 'low' : risk <= 60 ? 'medium' : 'high';
  // Terms scale with risk and size: lower risk earns a lower commission and reserve.
  const terms = {
    commission_bp: band === 'low' ? 1200 : band === 'medium' ? 1500 : 1800,
    reserve_bp: band === 'low' ? 0 : band === 'medium' ? 500 : 1000,
    settlement_cycle: band === 'high' ? 'monthly' : band === 'medium' ? 'biweekly' : 'weekly',
  };
  const missing = [];
  if (!docs.tax_id) missing.push('tax id');
  if (!docs.payout) missing.push('payout account');
  if (!docs.contact) missing.push('contact details');
  return { risk_score: risk, risk_band: band, reasons, missing, open_checklist: open, recommended_terms: terms,
    recommendation: missing.length ? `Ask the partner for: ${missing.join(', ')}.` : band === 'high' ? 'Approve with a reserve and a monthly cycle, or request more information.' : 'Ready to approve.' };
}

/** Anomaly flags for a settlement draft. */
export function settlementFlags(s, prev) {
  const f = [];
  if (s.net_payable_cents < 0) f.push({ code: 'negative_payable', text: 'The partner owes the platform money this period (cash bookings exceed online collections).' });
  const denom = s.sales_cents + Math.abs(s.refunds_cents ?? 0);
  if (denom > 0 && (s.refunds_cents ?? 0) / denom > 0.2) f.push({ code: 'high_refunds', text: 'Refunds are above 20% of sales.' });
  const collected = s.platform_collected_cents + s.venue_collected_cents;
  if (collected > 0 && s.venue_collected_cents / collected > 0.8) f.push({ code: 'mostly_cash', text: 'Over 80% of money was collected at the venue; commission relies on set-off.' });
  if (prev && prev.sales_cents > 0 && Math.abs(s.sales_cents - prev.sales_cents) / prev.sales_cents > 0.5) f.push({ code: 'swing', text: 'Sales moved more than 50% against the previous settlement.' });
  if (s.invoices_count === 0) f.push({ code: 'empty', text: 'No unsettled invoices in this period.' });
  return f;
}
