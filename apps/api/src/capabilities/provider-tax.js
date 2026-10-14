// Practice tax profile + revenue/tax report (#210). The platform makes no tax determination: the provider records their registration
// and the rate with its source, and the report applies exactly that. It is a management report, not a tax invoice or a filing.
import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { validTimezone } from '../booking/time.js';

const TAG = 'Health';
const day = z.string().date();

cap({
  name: 'set_tax_profile', method: 'POST', path: '/me/tax-profile', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: record your practice tax profile (legal billing name, jurisdiction, whether you are tax registered, registration number). Each save is a new effective-dated version; earlier ones are kept. Prices are treated as tax-inclusive. Nothing here is a tax determination.',
  input: z.object({ legal_name: z.string().trim().min(2).max(160), jurisdiction: z.string().trim().min(2).max(80), registration_status: z.enum(['registered', 'not_registered']), registration_id: z.string().trim().min(3).max(40).optional(), effective_from: z.string().datetime({ offset: true }).optional() }),
  async handler({ user }, i) {
    if (i.registration_status === 'registered' && !i.registration_id) throw badRequest('Enter your registration number');
    const r = await one('INSERT INTO provider_tax_profiles(provider_id, legal_name, jurisdiction, registration_status, registration_id_enc, effective_from) VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now())) RETURNING id, legal_name, jurisdiction, registration_status, price_display, effective_from',
      [user.id, i.legal_name, i.jurisdiction, i.registration_status, encrypt(i.registration_id, 'provider_tax_profiles.registration_id'), i.effective_from ?? null]);
    await audit(null, user.id, 'write_tax_profile', 'provider_tax_profiles', r.id);
    return r;
  },
});

cap({
  name: 'get_tax_profile', method: 'GET', path: '/me/tax-profile', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: your tax profile in force now, its version history and the configured rates with their sources. Reading is audit-logged.',
  async handler({ user }) {
    const versions = await many('SELECT * FROM provider_tax_profiles WHERE provider_id=$1 ORDER BY effective_from DESC, created_at DESC', [user.id]);
    const rates = await many('SELECT id, tax_class, rate_bp, source, effective_from FROM provider_tax_rates WHERE provider_id=$1 ORDER BY effective_from DESC, created_at DESC', [user.id]);
    if (versions.length) await audit(null, user.id, 'read_tax_profile', 'provider_tax_profiles', user.id);
    const show = ({ registration_id_enc, ...v }) => ({ ...v, registration_id: decrypt(registration_id_enc, 'provider_tax_profiles.registration_id') });
    const now = Date.now();
    return { current: versions.find((v) => +new Date(v.effective_from) <= now) ? show(versions.find((v) => +new Date(v.effective_from) <= now)) : null, history: versions.map(show), rates };
  },
});

cap({
  name: 'set_tax_rate', method: 'POST', path: '/me/tax-rates', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: record the tax rate that applies to your `taxable` services from a date, with its source (e.g. the official notice you relied on). Rates are append-only; earlier periods keep the rate that was in force. The platform does not look up or validate rates.',
  input: z.object({ rate_percent: z.number().min(0).max(100), source: z.string().trim().min(5).max(300), effective_from: z.string().datetime({ offset: true }).optional() }),
  async handler({ user }, i) {
    return one("INSERT INTO provider_tax_rates(provider_id, tax_class, rate_bp, source, effective_from) VALUES ($1,'taxable',$2,$3,COALESCE($4::timestamptz, now())) RETURNING id, tax_class, rate_bp, source, effective_from", [user.id, Math.round(i.rate_percent * 100), i.source, i.effective_from ?? null]);
  },
});

/** gross-inclusive tax, half-up per line: tax = round(gross * r / (10000 + r)) */
export const inclusiveTax = (gross, rateBp) => Math.floor((gross * rateBp * 2 + (10000 + rateBp)) / (2 * (10000 + rateBp)));

const inForce = (list, at, key = 'effective_from') => list.find((x) => +new Date(x[key]) <= +at); // list is newest-first

cap({
  name: 'practice_revenue_report', method: 'GET', path: '/me/practice-report', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: appointment revenue for a period, per currency and tax class, never summed across currencies. `basis=billed` counts confirmed/completed appointments by start date; `basis=collected` counts paid appointment payments by payment date, net of refunds. Tax is computed from your own profile and rates in force at the time (prices tax-inclusive, half-up per line); services with no tax class are shown as `unspecified` with no tax. A management report, not a tax invoice or filing. Dates use your profile time zone.',
  input: z.object({ from: day, to: day.describe('inclusive'), basis: z.enum(['billed', 'collected']).default('billed') }),
  async handler({ user }, i) {
    if (i.to < i.from) throw badRequest('The end date is before the start');
    if ((Date.parse(i.to) - Date.parse(i.from)) / 864e5 > 400) throw badRequest('Choose a period of at most 400 days');
    const tz = (await one('SELECT timezone FROM provider_profiles WHERE user_id=$1', [user.id]))?.timezone ?? 'UTC';
    if (!validTimezone(tz)) throw badRequest('Unknown time zone');
    const bounds = [user.id, i.from, i.to, tz];
    const win = (col) => `${col} >= ($2::date)::timestamp AT TIME ZONE $4 AND ${col} < (($3::date + 1)::timestamp AT TIME ZONE $4)`;
    const rows = i.basis === 'billed'
      ? await many(`SELECT a.currency, COALESCE(a.tax_class,'unspecified') AS tax_class, a.fee_cents AS gross, 0 AS refunded, COALESCE(a.list_price_cents, a.fee_cents) AS list, a.created_at AS at
                      FROM appointments a WHERE a.provider_id=$1 AND a.status IN ('confirmed','completed') AND a.fee_cents > 0 AND ${win('a.starts_at')}`, bounds)
      : await many(`SELECT p.currency, COALESCE(a.tax_class,'unspecified') AS tax_class, p.amount_cents AS gross, p.refunded_cents AS refunded, COALESCE(a.list_price_cents, p.amount_cents) AS list, p.paid_at AS at
                      FROM payments p JOIN appointments a ON a.id=p.purpose_id WHERE p.purpose_type='appointment' AND a.provider_id=$1 AND p.status IN ('paid','refunded') AND ${win('p.paid_at')}`, bounds);
    const profiles = await many('SELECT registration_status, effective_from FROM provider_tax_profiles WHERE provider_id=$1 ORDER BY effective_from DESC, created_at DESC', [user.id]);
    const rates = await many("SELECT rate_bp, effective_from FROM provider_tax_rates WHERE provider_id=$1 AND tax_class='taxable' ORDER BY effective_from DESC, created_at DESC", [user.id]);
    const groups = new Map();
    for (const r of rows) {
      const g = groups.get(`${r.currency}|${r.tax_class}`) ?? { currency: r.currency, tax_class: r.tax_class, lines: 0, list_price_cents: 0, discount_cents: 0, gross_cents: 0, refunded_cents: 0, tax_cents: 0, net_cents: 0, taxed_lines: 0 };
      const gross = Number(r.gross) - Number(r.refunded), at = new Date(r.at);
      const registered = inForce(profiles, at)?.registration_status === 'registered', rate = inForce(rates, at);
      const tax = r.tax_class === 'taxable' && registered && rate ? inclusiveTax(gross, rate.rate_bp) : 0;
      g.lines++; g.list_price_cents += Number(r.list); g.discount_cents += Number(r.list) - Number(r.gross); g.gross_cents += gross; g.refunded_cents += Number(r.refunded); g.tax_cents += tax; g.net_cents += gross - tax;
      if (r.tax_class === 'taxable' && !(registered && rate)) g.untaxed_taxable_lines = (g.untaxed_taxable_lines ?? 0) + 1;
      if (tax) g.taxed_lines++;
      groups.set(`${r.currency}|${r.tax_class}`, g);
    }
    await audit(null, user.id, 'read_practice_report', 'appointments', user.id);
    return {
      period: { from: i.from, to: i.to, timezone: tz }, basis: i.basis, price_display: 'inclusive',
      note: 'Management report from your own tax settings. Not a tax invoice, return or compliance statement. Package, subscription and pay-later revenue are not included yet.',
      groups: [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.tax_class.localeCompare(b.tax_class)),
    };
  },
});
