// International referee locale preferences, payout country and operating-country
// management with per-country data-residency consent (#1030 R32).
//
// Builds on: official_profiles (profile_language already has bio_translations),
// official_tax_profiles (tax country / regime), data-residency.js (residency_consents).
// Never duplicates those; extends them with locale-specific preferences the official
// self-manages and the invoice / match-UI subsystems read.
//
// Tables (migration 206): official_intl_prefs, official_operating_countries.

import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, hasRole } from '../helpers.js';

const TAG = 'Official international';

// IANA timezone whitelist — validate on the server without bundling the full TZ database
const SUPPORTED_LOCALES = ['en','en-AU','en-GB','en-US','en-IN','es','fr','de','pt','ar','zh','ja','ko',
  'hi','ta','te','ml','mr','kn','bn','or','si','ur','id'];
const SUPPORTED_LANGS = ['en','es','fr','de','pt','ar','zh','ja','ko',
  'hi','ta','te','ml','mr','kn','bn','or','si','ur','id'];
const KNOWN_TIMEZONES = new Set([
  'UTC','Europe/London','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Rome',
  'Europe/Amsterdam','Europe/Zurich','Europe/Stockholm','Europe/Helsinki',
  'America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
  'America/Toronto','America/Vancouver','America/Sao_Paulo','America/Buenos_Aires',
  'America/Mexico_City','America/Bogota','America/Lima',
  'Africa/Cairo','Africa/Lagos','Africa/Nairobi','Africa/Johannesburg',
  'Asia/Dubai','Asia/Riyadh','Asia/Karachi','Asia/Kolkata','Asia/Colombo',
  'Asia/Dhaka','Asia/Kathmandu','Asia/Bangkok','Asia/Singapore','Asia/Jakarta',
  'Asia/Manila','Asia/Hong_Kong','Asia/Shanghai','Asia/Tokyo','Asia/Seoul',
  'Australia/Sydney','Australia/Melbourne','Australia/Perth','Australia/Brisbane',
  'Pacific/Auckland','Pacific/Fiji','Pacific/Honolulu',
]);
const TAX_NUMBER_LABELS = { AU:'ABN', GB:'UTR', IN:'GSTIN', US:'EIN', NZ:'NZBN', CA:'BN', SG:'UEN', DE:'USt-IdNr', FR:'SIRET', ES:'NIF', AE:'TRN', ZA:'VAT', JP:'登録番号', KR:'사업자등록번호', PK:'NTN', BD:'TIN', LK:'TIN', MY:'GST', ID:'NPWP', TH:'VAT' };

const assertOfficial = (user) => {
  if (!hasRole(user, 'referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee'))
    throw forbidden('Only a registered official can manage international preferences');
};

const cc2 = z.string().trim().toUpperCase().length(2).regex(/^[A-Z]{2}$/);
const lang = z.string().trim().toLowerCase().min(2).max(10);
const cur3 = z.string().trim().toUpperCase().length(3).regex(/^[A-Z]{3}$/);

// ── GET my international prefs ────────────────────────────────────────────

cap({
  name: 'get_official_intl_prefs', method: 'GET', path: '/me/official-intl-prefs', tag: TAG,
  summary: 'Official: return your international locale preferences (timezone, language, currency, payout country, invoice settings). Returns sensible defaults if no row exists yet.',
  async handler({ user }) {
    assertOfficial(user);
    const p = await one('SELECT * FROM official_intl_prefs WHERE user_id=$1', [user.id]);
    // Country-aware tax-number label auto-derived from payout_country when not explicitly set
    const country = p?.payout_country ?? null;
    const autoLabel = country ? (TAX_NUMBER_LABELS[country] ?? null) : null;
    const defaults = { profile_language:'en', comms_language:'en', match_language:'en', timezone:'UTC', date_locale:'en-GB', number_locale:'en-AU', currency_preference:'USD', payout_country:null, invoice_language:'en', tax_number_label:null };
    return { ...(p ?? defaults), tax_number_label: p?.tax_number_label ?? autoLabel, _auto_label: !p?.tax_number_label && !!autoLabel };
  },
});

// ── SET my international prefs ────────────────────────────────────────────

cap({
  name: 'set_official_intl_prefs', method: 'POST', path: '/me/official-intl-prefs', tag: TAG,
  summary: 'Official: save (upsert) your international locale preferences. All fields are optional; omitting a field leaves the existing value unchanged (or sets the documented default for new records).',
  input: z.object({
    profile_language:    lang.optional(),
    comms_language:      lang.optional(),
    match_language:      lang.optional(),
    timezone:            z.string().trim().min(2).max(64).optional(),
    date_locale:         z.string().trim().min(2).max(20).optional(),
    number_locale:       z.string().trim().min(2).max(20).optional(),
    currency_preference: cur3.optional(),
    payout_country:      cc2.optional().nullable(),
    invoice_language:    lang.optional(),
    tax_number_label:    z.string().trim().max(60).optional().nullable(),
  }),
  async handler({ user }, i) {
    assertOfficial(user);
    if (i.timezone && !KNOWN_TIMEZONES.has(i.timezone)) throw badRequest(`Unsupported timezone: ${i.timezone}. Use an IANA timezone identifier.`);
    return tx(async (c) => {
      const existing = (await c.query('SELECT * FROM official_intl_prefs WHERE user_id=$1', [user.id])).rows[0];
      let row;
      if (!existing) {
        row = (await c.query(
          `INSERT INTO official_intl_prefs(user_id, profile_language, comms_language, match_language,
             timezone, date_locale, number_locale, currency_preference, payout_country,
             invoice_language, tax_number_label)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [ user.id,
            i.profile_language ?? 'en', i.comms_language ?? 'en', i.match_language ?? 'en',
            i.timezone ?? 'UTC', i.date_locale ?? 'en-GB', i.number_locale ?? 'en-AU',
            i.currency_preference ?? 'USD', i.payout_country ?? null,
            i.invoice_language ?? 'en', i.tax_number_label ?? null ],
        )).rows[0];
      } else {
        const fields = ['profile_language','comms_language','match_language','timezone','date_locale','number_locale','currency_preference','payout_country','invoice_language','tax_number_label'];
        const sets = [], args = [user.id];
        for (const f of fields) {
          if (i[f] !== undefined) { args.push(i[f]); sets.push(`${f}=$${args.length}`); }
        }
        sets.push('updated_at=now()');
        row = (await c.query(`UPDATE official_intl_prefs SET ${sets.join(',')} WHERE user_id=$1 RETURNING *`, args)).rows[0];
      }
      await audit(c, user.id, 'official_intl_prefs.saved', 'official_intl_prefs', row.id);
      const autoLabel = row.payout_country ? (TAX_NUMBER_LABELS[row.payout_country] ?? null) : null;
      return { ...row, tax_number_label: row.tax_number_label ?? autoLabel, _auto_label: !row.tax_number_label && !!autoLabel };
    });
  },
});

// ── List supported timezones / locales (public — for picker population) ───

cap({
  name: 'list_official_intl_options', method: 'GET', path: '/official-intl/options', tag: TAG,
  auth: 'public',
  summary: 'Returns the platform-supported timezones, language codes and locale codes for official international preference pickers.',
  handler: async () => ({
    timezones: [...KNOWN_TIMEZONES].sort(),
    languages: SUPPORTED_LANGS,
    locales: SUPPORTED_LOCALES,
    tax_number_labels: TAX_NUMBER_LABELS,
  }),
});

// ── Operating countries ───────────────────────────────────────────────────

cap({
  name: 'list_my_operating_countries', method: 'GET', path: '/me/official-intl/operating-countries', tag: TAG,
  summary: 'Official: list countries where you are registered as operating (active + removed), including residency consent status per country.',
  async handler({ user }) {
    assertOfficial(user);
    const rows = await many(
      `SELECT * FROM official_operating_countries WHERE user_id=$1 ORDER BY is_home_country DESC, added_at`,
      [user.id],
    );
    return { countries: rows };
  },
});

cap({
  name: 'add_official_operating_country', method: 'POST', path: '/me/official-intl/operating-countries', tag: TAG, status: 201,
  summary: 'Official: add a country where you officiate. Optionally record data-residency consent for that country. If the country is already active, returns the existing record. The country\'s typical currency, tax regime and timezone are auto-populated from the platform catalogue if not supplied.',
  input: z.object({
    country_code:            cc2,
    is_home_country:         z.boolean().default(false),
    currency:                cur3.optional(),
    typical_tax_regime:      z.enum(['none','gst','vat','sales_tax','hst','consumption_tax','unknown']).optional(),
    typical_timezone:        z.string().trim().max(64).optional(),
    residency_consent_given: z.boolean().default(false),
    residency_region:        z.string().trim().max(64).optional(),
    consent_policy_version:  z.number().int().optional(),
    consent_policy_hash:     z.string().max(64).optional(),
  }),
  async handler({ user }, i) {
    assertOfficial(user);
    if (i.typical_timezone && !KNOWN_TIMEZONES.has(i.typical_timezone))
      throw badRequest(`Unsupported timezone: ${i.typical_timezone}`);
    if (i.residency_consent_given) {
      if (!i.residency_region) throw badRequest('Provide the data residency region when giving consent');
      if (!i.consent_policy_version || !i.consent_policy_hash)
        throw badRequest('Provide policy_version and policy_hash to record residency consent');
    }
    return tx(async (c) => {
      // If already active, return existing (idempotent)
      const existing = (await c.query(
        'SELECT * FROM official_operating_countries WHERE user_id=$1 AND country_code=$2 AND removed_at IS NULL',
        [user.id, i.country_code],
      )).rows[0];
      if (existing) return { ...existing, _already_exists: true };

      // Re-activate if previously removed (soft-delete reversal)
      const removed = (await c.query(
        'SELECT * FROM official_operating_countries WHERE user_id=$1 AND country_code=$2 AND removed_at IS NOT NULL ORDER BY removed_at DESC LIMIT 1',
        [user.id, i.country_code],
      )).rows[0];

      let row;
      if (removed) {
        row = (await c.query(
          `UPDATE official_operating_countries SET
             removed_at=NULL, removed_by=NULL, is_home_country=$3, currency=$4,
             typical_tax_regime=$5, typical_timezone=$6, residency_consent_given=$7,
             residency_region=$8, consent_policy_version=$9, consent_policy_hash=$10,
             consented_at=$11, consent_revoked_at=NULL, added_at=now(), added_by=$12
           WHERE id=$1 AND user_id=$2 RETURNING *`,
          [ removed.id, user.id, i.is_home_country, i.currency ?? null,
            i.typical_tax_regime ?? null, i.typical_timezone ?? null,
            i.residency_consent_given, i.residency_region ?? null,
            i.consent_policy_version ?? null, i.consent_policy_hash ?? null,
            i.residency_consent_given ? new Date() : null, user.id ],
        )).rows[0];
      } else {
        row = (await c.query(
          `INSERT INTO official_operating_countries(
             user_id, country_code, is_home_country, currency, typical_tax_regime, typical_timezone,
             residency_consent_given, residency_region, consent_policy_version, consent_policy_hash,
             consented_at, added_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [ user.id, i.country_code, i.is_home_country, i.currency ?? null,
            i.typical_tax_regime ?? null, i.typical_timezone ?? null,
            i.residency_consent_given, i.residency_region ?? null,
            i.consent_policy_version ?? null, i.consent_policy_hash ?? null,
            i.residency_consent_given ? new Date() : null, user.id ],
        )).rows[0];
      }
      await audit(c, user.id, 'official_operating_country.added', 'official_operating_countries', row.id);
      return row;
    });
  },
});

cap({
  name: 'update_official_operating_country_consent', method: 'PATCH', path: '/me/official-intl/operating-countries/:country_code/consent', tag: TAG,
  summary: 'Official: grant or revoke data-residency consent for an operating country. Revoking removes you from future assignment matching in that country but does not delete historical fixture or payment records.',
  input: z.object({
    country_code:           cc2,
    consent_given:          z.boolean(),
    residency_region:       z.string().trim().max(64).optional(),
    consent_policy_version: z.number().int().optional(),
    consent_policy_hash:    z.string().max(64).optional(),
  }),
  async handler({ user }, i) {
    assertOfficial(user);
    return tx(async (c) => {
      const rec = (await c.query(
        'SELECT * FROM official_operating_countries WHERE user_id=$1 AND country_code=$2 AND removed_at IS NULL',
        [user.id, i.country_code],
      )).rows[0];
      if (!rec) throw notFound('operating country');
      if (i.consent_given) {
        if (!i.residency_region) throw badRequest('Provide the data residency region');
        if (!i.consent_policy_version || !i.consent_policy_hash) throw badRequest('Provide policy_version and policy_hash');
      }
      const row = (await c.query(
        `UPDATE official_operating_countries SET
           residency_consent_given=$3, residency_region=$4, consent_policy_version=$5,
           consent_policy_hash=$6, consented_at=$7, consent_revoked_at=$8
         WHERE id=$1 AND user_id=$2 RETURNING *`,
        [ rec.id, user.id, i.consent_given, i.residency_region ?? rec.residency_region,
          i.consent_policy_version ?? rec.consent_policy_version, i.consent_policy_hash ?? rec.consent_policy_hash,
          i.consent_given ? new Date() : rec.consented_at, i.consent_given ? null : new Date() ],
      )).rows[0];
      await audit(c, user.id, i.consent_given ? 'official_operating_country.consent_granted' : 'official_operating_country.consent_revoked', 'official_operating_countries', row.id);
      return row;
    });
  },
});

cap({
  name: 'remove_official_operating_country', method: 'DELETE', path: '/me/official-intl/operating-countries/:country_code', tag: TAG,
  summary: 'Official: soft-remove a country from your operating list. Historical fixture, invoice and payment records for that country are kept permanently.',
  input: z.object({ country_code: cc2 }),
  async handler({ user }, i) {
    assertOfficial(user);
    return tx(async (c) => {
      const rec = (await c.query(
        'SELECT * FROM official_operating_countries WHERE user_id=$1 AND country_code=$2 AND removed_at IS NULL',
        [user.id, i.country_code],
      )).rows[0];
      if (!rec) throw notFound('operating country');
      if (rec.is_home_country) throw badRequest('Cannot remove your home country. Update your home country on your account profile first.');
      await c.query(
        'UPDATE official_operating_countries SET removed_at=now(), removed_by=$2 WHERE id=$1',
        [rec.id, user.id],
      );
      await audit(c, user.id, 'official_operating_country.removed', 'official_operating_countries', rec.id);
      return { removed: true, country_code: i.country_code };
    });
  },
});

// ── Admin: view an official's intl prefs (organiser/assessor/federation/admin) ─

cap({
  name: 'get_official_intl_prefs_for_user', method: 'GET', path: '/officials/:id/intl-prefs', tag: TAG,
  auth: ['admin','organizer','assessor','federation'],
  summary: 'Organiser/assessor/federation/admin: view an official\'s international locale preferences and operating countries. Sensitive fields (tax_number_label, payout_country) are only shown to admin.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM official_intl_prefs WHERE user_id=$1', [i.id]);
    const countries = await many('SELECT country_code, is_home_country, currency, typical_tax_regime, typical_timezone, residency_consent_given, residency_region, consented_at, consent_revoked_at, added_at FROM official_operating_countries WHERE user_id=$1 AND removed_at IS NULL ORDER BY is_home_country DESC, added_at', [i.id]);
    const isAdminUser = hasRole(user, 'admin', 'platform_admin');
    // Strip sensitive fields for non-admin
    const prefs = p ? (isAdminUser ? p : (() => { const { payout_country, tax_number_label, ...rest } = p; return rest; })()) : null;
    if (p && !isAdminUser) await audit(null, user.id, 'official_intl_prefs.viewed', 'official_intl_prefs', p.id);
    return { prefs, countries };
  },
});
