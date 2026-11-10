// Official profile onboarding wizard (#991 R00). Multi-step self-declaration profile for referee and official roles.
// Reuses official_availability and official_prefs (migration 121); on publish upserts sport_profiles and adds 'referee' to users.roles.
// PII encrypted throughout; payout/bank fields audit-logged on every admin read; public profile strips all _enc fields.
// Godmode (#991): completeness scoring, portfolio links, multi-language bio, compliance summary cached on write.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { isYouth, requireConsent } from '../youth.js';
import { buildComplianceSummary } from './official-profile-compliance.js';

const PLATFORM_LANGS = ['es','hi','ta','te','ml','mr','kn','bn','or','si','ur','id'];
const PORTFOLIO_KINDS = ['video','article','match_report','interview','other'];

function computeCompleteness(p, sportCount, expCount, credCount, refCount, rateCount, hasAvailability) {
  // 10 checkpoints × 10 points each = 100
  let score = 0;
  if (p.display_name_pref) score += 10;                      // identity
  if (sportCount > 0) score += 10;                           // sports
  if (expCount > 0) score += 10;                             // experience
  if (credCount > 0) score += 10;                            // credentials
  if (refCount > 0) score += 10;                             // references
  if (hasAvailability) score += 10;                          // availability
  if (rateCount > 0) score += 10;                            // rates
  if (p.payout_method) score += 10;                          // payout
  if (p.bio_translations && Object.keys(p.bio_translations).length > 0) score += 5;  // multilang bio
  if (p.portfolio_links && p.portfolio_links.length > 0) score += 5;                 // portfolio
  return Math.min(100, score);
}

const TAG = 'Official profile';
const text = (n) => z.string().trim().max(n);
const textMin = (n, x) => z.string().trim().min(n).max(x);
const ROLES = ['referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee'];
const LEVELS = ['grassroots','local','district','county','regional','national','international','olympic'];
const CRED_KINDS = ['licence','certification','course','badge','clearance','first_aid','fitness','safeguarding','other'];
const FIXTURE_TYPES = ['training','friendly','cup','league','tournament','international','other'];
const RELATIONSHIPS = ['governing_body','club','association','colleague','employer','other'];

const role = z.enum(ROLES);
const level = z.enum(LEVELS);

function cleanPayout(row) {
  const { bank_account_enc, bank_sort_code_enc, bank_iban_enc, vat_number_enc, bio_enc, career_highlights_enc, ...rest } = row;
  return rest;
}

// ------------------------------------------------------------------ options (wizard dropdowns)
cap({
  name: 'get_official_profile_options', method: 'GET', path: '/me/official-profile/options', tag: TAG,
  summary: 'Wizard dropdown data: sports catalogue, official role labels, experience levels, credential kinds, fixture types, relationship types, payout methods.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const sports = await many("SELECT id, name, emoji FROM sports ORDER BY name");
    return {
      sports,
      roles: ROLES,
      levels: LEVELS,
      cred_kinds: CRED_KINDS,
      fixture_types: FIXTURE_TYPES,
      relationships: RELATIONSHIPS,
      payout_methods: ['bank_transfer','stripe','other'],
      pronouns: ['he/him','she/her','they/them','prefer_not_to_say'],
    };
  },
});

// ------------------------------------------------------------------ my profile CRUD
cap({
  name: 'get_my_official_profile', method: 'GET', path: '/me/official-profile', tag: TAG,
  summary: 'Full draft profile for wizard resume: identity, privacy, sports, experience, credentials, references, rate cards. Returns 404 if no profile exists yet.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT * FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [user.id]);
    if (!p) throw notFound('Official profile');
    const [sports, experience, credentials, references, rates] = await Promise.all([
      many('SELECT * FROM official_profile_sports WHERE profile_id=$1 ORDER BY primary_sport DESC, sport_id', [p.id]),
      many('SELECT id, sport_id, role, level, body_name, competition_name, from_year, to_year, match_count_est, display_order, created_at FROM official_profile_experience WHERE profile_id=$1 AND archived_at IS NULL ORDER BY display_order, created_at', [p.id]),
      many('SELECT id, sport_id, role, kind, issuing_body, credential_name, issue_date, expiry_date, level_label, status, verified_at, archived_at, created_at FROM official_profile_credentials WHERE profile_id=$1 AND archived_at IS NULL ORDER BY created_at', [p.id]),
      many('SELECT id, role_title, organisation, relationship, consent_given, contacted_at, display_order FROM official_profile_references WHERE profile_id=$1 AND archived_at IS NULL ORDER BY display_order, created_at', [p.id]),
      many('SELECT id, sport_id, role, fixture_type, level_label, fee_minor, fee_currency, includes_travel, travel_allowance_per_km_minor, expenses_note, valid_from, valid_until FROM official_profile_rates WHERE profile_id=$1 AND archived_at IS NULL ORDER BY created_at', [p.id]),
    ]);
    const bio = p.bio_enc ? decrypt(p.bio_enc, 'official_profiles.bio') : null;
    // decrypt multi-lang bios (map lang→plain)
    let bioTranslations = null;
    if (p.bio_translations) {
      const enc = typeof p.bio_translations === 'string' ? JSON.parse(p.bio_translations) : p.bio_translations;
      bioTranslations = {};
      for (const [lang, v] of Object.entries(enc)) bioTranslations[lang] = decrypt(v, `official_profiles.bio_translations.${lang}`);
    }
    const portfolioLinks = p.portfolio_links ? (typeof p.portfolio_links === 'string' ? JSON.parse(p.portfolio_links) : p.portfolio_links) : [];
    const complianceSummary = p.compliance_summary ? (typeof p.compliance_summary === 'string' ? JSON.parse(p.compliance_summary) : p.compliance_summary) : null;
    return { ...cleanPayout(p), bio, bio_translations: bioTranslations, portfolio_links: portfolioLinks, compliance_summary: complianceSummary, sports, experience, credentials, references, rates };
  },
});

cap({
  name: 'upsert_official_profile', method: 'POST', path: '/me/official-profile', tag: TAG, status: 201,
  summary: 'Create or update an official profile draft. Auto-saves after each wizard step. row_version required on updates (optimistic concurrency). step_reached is never decremented.',
  input: z.object({
    row_version: z.number().int().optional(),
    display_name_pref: text(80).optional(),
    bio: text(1000).optional(),
    preferred_pronouns: text(40).optional(),
    nationality: text(80).optional(),
    privacy_show_sports: z.boolean().optional(),
    privacy_show_experience: z.boolean().optional(),
    privacy_show_credentials: z.boolean().optional(),
    privacy_show_rates: z.boolean().optional(),
    started_year: z.number().int().min(1950).max(new Date().getFullYear()).optional(),
    highest_level: level.optional(),
    total_matches_est: z.number().int().min(0).max(99999).optional(),
    career_highlights: text(1000).optional(),
    tax_country: text(80).optional(),
    vat_registered: z.boolean().optional(),
    vat_number: text(40).optional(),
    payout_method: z.enum(['bank_transfer','stripe','other']).optional(),
    bank_account: text(40).optional(),
    bank_sort_code: text(20).optional(),
    bank_iban: text(40).optional(),
    step_reached: z.number().int().min(0).max(9).optional(),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      let p = (await c.query('SELECT * FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (p && i.row_version !== undefined && p.row_version !== i.row_version) throw conflict('Profile was updated elsewhere; reload and retry');
      const enc = {};
      if (i.bio !== undefined) enc.bio_enc = i.bio ? encrypt(i.bio, 'official_profiles.bio') : null;
      if (i.career_highlights !== undefined) enc.career_highlights_enc = i.career_highlights ? encrypt(i.career_highlights, 'official_profiles.career_highlights') : null;
      if (i.vat_number !== undefined) enc.vat_number_enc = i.vat_number ? encrypt(i.vat_number, 'official_profiles.vat_number') : null;
      if (i.bank_account !== undefined) enc.bank_account_enc = i.bank_account ? encrypt(i.bank_account, 'official_profiles.bank_account') : null;
      if (i.bank_sort_code !== undefined) enc.bank_sort_code_enc = i.bank_sort_code ? encrypt(i.bank_sort_code, 'official_profiles.bank_sort_code') : null;
      if (i.bank_iban !== undefined) enc.bank_iban_enc = i.bank_iban ? encrypt(i.bank_iban, 'official_profiles.bank_iban') : null;
      const cols = {
        ...(i.display_name_pref !== undefined && { display_name_pref: i.display_name_pref || null }),
        ...(i.preferred_pronouns !== undefined && { preferred_pronouns: i.preferred_pronouns || null }),
        ...(i.nationality !== undefined && { nationality: i.nationality || null }),
        ...(i.privacy_show_sports !== undefined && { privacy_show_sports: i.privacy_show_sports }),
        ...(i.privacy_show_experience !== undefined && { privacy_show_experience: i.privacy_show_experience }),
        ...(i.privacy_show_credentials !== undefined && { privacy_show_credentials: i.privacy_show_credentials }),
        ...(i.privacy_show_rates !== undefined && { privacy_show_rates: i.privacy_show_rates }),
        ...(i.started_year !== undefined && { started_year: i.started_year }),
        ...(i.highest_level !== undefined && { highest_level: i.highest_level }),
        ...(i.total_matches_est !== undefined && { total_matches_est: i.total_matches_est }),
        ...(i.tax_country !== undefined && { tax_country: i.tax_country || null }),
        ...(i.vat_registered !== undefined && { vat_registered: i.vat_registered }),
        ...(i.payout_method !== undefined && { payout_method: i.payout_method }),
        ...enc,
      };
      if (!p) {
        // the first save is a wizard step too: keep the step it reached, or the wizard reopens at the start
        const keys = ['user_id', ...Object.keys(cols), 'step_reached'];
        const vals = [user.id, ...Object.values(cols), i.step_reached ?? 0];
        const ph = vals.map((_, j) => `$${j + 1}`).join(',');
        p = (await c.query(`INSERT INTO official_profiles(${keys.join(',')}) VALUES(${ph}) RETURNING *`, vals)).rows[0];
        await audit(c, user.id, 'official_profile_created', 'official_profiles', p.id);
      } else {
        const entries = Object.entries(cols);
        if (entries.length || i.step_reached !== undefined) {
          const step = i.step_reached !== undefined ? Math.max(p.step_reached, i.step_reached) : p.step_reached;
          const setClause = [...entries.map(([k], j) => `${k}=$${j + 3}`), `step_reached=${step}`, 'row_version=row_version+1', 'updated_at=now()'].join(',');
          p = (await c.query(`UPDATE official_profiles SET ${setClause} WHERE id=$1 AND row_version=$2 RETURNING *`, [p.id, p.row_version, ...entries.map(([, v]) => v)])).rows[0];
          if (!p) throw conflict('Profile was updated elsewhere; reload and retry');
        }
      }
      const bio = p.bio_enc ? decrypt(p.bio_enc, 'official_profiles.bio') : null;
      return { ...cleanPayout(p), bio };
    });
  },
});

// ------------------------------------------------------------------ sports (step 2)
cap({
  name: 'save_official_profile_sports', method: 'PUT', path: '/me/official-profile/sports', tag: TAG,
  summary: 'Full-replace the sports / roles / disciplines on the profile.',
  input: z.object({
    sports: z.array(z.object({
      sport_id: id,
      role,
      discipline: text(60).optional(),
      primary_sport: z.boolean().optional(),
    })),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      await c.query('DELETE FROM official_profile_sports WHERE profile_id=$1', [p.id]);
      for (const s of i.sports) {
        if (!(await c.query('SELECT 1 FROM sports WHERE id=$1', [s.sport_id])).rowCount) throw badRequest(`Sport ${s.sport_id} not found`);
        await c.query('INSERT INTO official_profile_sports(profile_id, sport_id, role, discipline, primary_sport) VALUES($1,$2,$3,$4,$5) ON CONFLICT(profile_id,sport_id,role) DO UPDATE SET discipline=$4, primary_sport=$5', [p.id, s.sport_id, s.role, s.discipline || null, s.primary_sport ?? false]);
      }
      await c.query("UPDATE official_profiles SET step_reached=GREATEST(step_reached,2), row_version=row_version+1, updated_at=now() WHERE id=$1", [p.id]);
      return many('SELECT * FROM official_profile_sports WHERE profile_id=$1 ORDER BY primary_sport DESC', [p.id]);
    });
  },
});

// ------------------------------------------------------------------ experience (step 3)
cap({
  name: 'save_official_profile_experience', method: 'PUT', path: '/me/official-profile/experience', tag: TAG,
  summary: 'Full-replace experience entries.',
  input: z.object({
    entries: z.array(z.object({
      sport_id: id,
      role,
      level,
      body_name: textMin(1,100),
      competition_name: text(100).optional(),
      from_year: z.number().int().min(1950).max(2100).optional(),
      to_year: z.number().int().min(1950).max(2100).optional(),
      match_count_est: z.number().int().min(0).max(99999).optional(),
      notable: text(500).optional(),
      display_order: z.number().int().optional(),
    })),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      await c.query("UPDATE official_profile_experience SET archived_at=now() WHERE profile_id=$1 AND archived_at IS NULL", [p.id]);
      for (const [idx, e] of i.entries.entries()) {
        const notable_enc = e.notable ? encrypt(e.notable, 'official_profile_experience.notable') : null;
        await c.query('INSERT INTO official_profile_experience(profile_id,sport_id,role,level,body_name,competition_name,from_year,to_year,match_count_est,notable_enc,display_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [p.id, e.sport_id, e.role, e.level, e.body_name, e.competition_name||null, e.from_year||null, e.to_year||null, e.match_count_est||null, notable_enc, e.display_order??idx]);
      }
      await c.query("UPDATE official_profiles SET step_reached=GREATEST(step_reached,3), row_version=row_version+1, updated_at=now() WHERE id=$1", [p.id]);
      return many('SELECT id, sport_id, role, level, body_name, competition_name, from_year, to_year, match_count_est, display_order FROM official_profile_experience WHERE profile_id=$1 AND archived_at IS NULL ORDER BY display_order, created_at', [p.id]);
    });
  },
});

// ------------------------------------------------------------------ credentials (step 4)
cap({
  name: 'upsert_official_credential', method: 'POST', path: '/me/official-profile/credentials', tag: TAG, status: 201,
  summary: 'Add a licence, certification, course, clearance or other credential to the profile.',
  input: z.object({
    sport_id: id.optional(),
    role: role.optional(),
    kind: z.enum(CRED_KINDS),
    issuing_body: textMin(1,100),
    credential_name: textMin(1,100),
    issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    level_label: text(60).optional(),
    reference_no: text(80).optional(),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      const reference_no_enc = i.reference_no ? encrypt(i.reference_no, 'official_profile_credentials.reference_no') : null;
      const status = i.expiry_date && new Date(i.expiry_date) < new Date() ? 'expired' : 'active';
      const cred = (await c.query('INSERT INTO official_profile_credentials(profile_id,sport_id,role,kind,issuing_body,credential_name,issue_date,expiry_date,level_label,reference_no_enc,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,sport_id,role,kind,issuing_body,credential_name,issue_date,expiry_date,level_label,status,created_at',
        [p.id, i.sport_id||null, i.role||null, i.kind, i.issuing_body, i.credential_name, i.issue_date||null, i.expiry_date||null, i.level_label||null, reference_no_enc, status])).rows[0];
      await c.query("UPDATE official_profiles SET step_reached=GREATEST(step_reached,4), row_version=row_version+1, updated_at=now() WHERE id=$1", [p.id]);
      return cred;
    });
  },
});

cap({
  name: 'archive_official_credential', method: 'POST', path: '/me/official-profile/credentials/:credId/archive', tag: TAG,
  summary: 'Soft-delete a credential from the profile.',
  input: z.object({ credId: id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      const cred = (await c.query("UPDATE official_profile_credentials SET archived_at=now() WHERE id=$1 AND profile_id=$2 AND archived_at IS NULL RETURNING id", [i.credId, p.id])).rows[0];
      if (!cred) throw notFound('Credential');
      return { id: cred.id, archived: true };
    });
  },
});

// ------------------------------------------------------------------ references (step 5)
cap({
  name: 'save_official_references', method: 'PUT', path: '/me/official-profile/references', tag: TAG,
  summary: 'Full-replace references. All contact PII is encrypted server-side. Up to 3 references.',
  input: z.object({
    references: z.array(z.object({
      referee_name: textMin(2,80),
      role_title: text(80).optional(),
      organisation: text(100).optional(),
      relationship: z.enum(RELATIONSHIPS),
      contact_email: z.string().email().optional(),
      contact_phone: text(30).optional(),
      consent_given: z.boolean().optional(),
      display_order: z.number().int().optional(),
    })).max(3),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      await c.query("UPDATE official_profile_references SET archived_at=now() WHERE profile_id=$1 AND archived_at IS NULL", [p.id]);
      for (const [idx, r] of i.references.entries()) {
        await c.query('INSERT INTO official_profile_references(profile_id,referee_name_enc,role_title,organisation,relationship,contact_email_enc,contact_phone_enc,consent_given,display_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [p.id, encrypt(r.referee_name, 'official_profile_references.referee_name'), r.role_title||null, r.organisation||null, r.relationship, r.contact_email ? encrypt(r.contact_email, 'official_profile_references.contact_email') : null, r.contact_phone ? encrypt(r.contact_phone, 'official_profile_references.contact_phone') : null, r.consent_given??false, r.display_order??idx]);
      }
      await c.query("UPDATE official_profiles SET step_reached=GREATEST(step_reached,5), row_version=row_version+1, updated_at=now() WHERE id=$1", [p.id]);
      return many('SELECT id, role_title, organisation, relationship, consent_given, display_order FROM official_profile_references WHERE profile_id=$1 AND archived_at IS NULL ORDER BY display_order', [p.id]);
    });
  },
});

// ------------------------------------------------------------------ rate cards (step 7)
cap({
  name: 'save_official_rate_cards', method: 'PUT', path: '/me/official-profile/rate-cards', tag: TAG,
  summary: 'Full-replace rate cards (wizard step 7). Accepts both legacy 11-field format and extended service-catalog fields (#1015).',
  input: z.object({
    rates: z.array(z.object({
      sport_id: id.optional(),
      role: role.optional(),
      fixture_type: z.enum(FIXTURE_TYPES),
      level_label: text(60).optional(),
      fee_minor: z.number().int().min(0),
      fee_currency: z.string().regex(/^[A-Z]{3}$/),
      includes_travel: z.boolean().optional(),
      travel_allowance_per_km_minor: z.number().int().min(0).optional(),
      expenses_note: text(300).optional(),
      valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // Extended service-catalog fields (optional for backwards compatibility)
      name: z.string().trim().max(120).optional(),
      service_type: z.enum(['hourly','match','session','day']).optional(),
      weekend_sat_pct: z.number().min(0).max(100).optional(),
      weekend_sun_pct: z.number().min(0).max(100).optional(),
      holiday_pct: z.number().min(0).max(100).optional(),
      overtime_rate_minor: z.number().int().min(0).optional(),
      min_fee_minor: z.number().int().min(0).optional(),
      deposit_type: z.enum(['none','pct','fixed']).optional(),
      deposit_pct: z.number().min(0).max(100).optional(),
      deposit_minor: z.number().int().min(0).optional(),
      tax_inclusive: z.boolean().optional(),
      status: z.enum(['draft','active']).optional(),
      is_indicative: z.boolean().optional(),
      private_notes: z.string().trim().max(2000).optional(),
    })),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      await c.query("UPDATE official_profile_rates SET archived_at=now() WHERE profile_id=$1 AND archived_at IS NULL", [p.id]);
      for (const r of i.rates) {
        const pnEnc = r.private_notes ? encrypt(r.private_notes, 'official_profile_rates.private_notes') : null;
        await c.query(`INSERT INTO official_profile_rates(
          profile_id,sport_id,role,fixture_type,level_label,fee_minor,fee_currency,
          includes_travel,travel_allowance_per_km_minor,expenses_note,valid_from,valid_until,
          name,service_type,weekend_sat_pct,weekend_sun_pct,holiday_pct,overtime_rate_minor,
          min_fee_minor,deposit_type,deposit_pct,deposit_minor,tax_inclusive,status,
          version_number,is_indicative,private_notes_enc
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
          [p.id, r.sport_id||null, r.role||null, r.fixture_type, r.level_label||null, r.fee_minor, r.fee_currency,
           r.includes_travel??false, r.travel_allowance_per_km_minor||null, r.expenses_note||null, r.valid_from||null, r.valid_until||null,
           r.name||null, r.service_type||null, r.weekend_sat_pct??0, r.weekend_sun_pct??0, r.holiday_pct??0, r.overtime_rate_minor??0,
           r.min_fee_minor??0, r.deposit_type??'none', r.deposit_pct??0, r.deposit_minor??0, r.tax_inclusive??true,
           r.status??'active', 1, r.is_indicative??true, pnEnc]);
      }
      await c.query("UPDATE official_profiles SET step_reached=GREATEST(step_reached,7), row_version=row_version+1, updated_at=now() WHERE id=$1", [p.id]);
      return many('SELECT id, sport_id, role, fixture_type, level_label, fee_minor, fee_currency, includes_travel, travel_allowance_per_km_minor, expenses_note, valid_from, valid_until, name, service_type, status, version_number, is_indicative FROM official_profile_rates WHERE profile_id=$1 AND archived_at IS NULL ORDER BY created_at', [p.id]);
    });
  },
});

// ------------------------------------------------------------------ publish / retract
cap({
  name: 'publish_official_profile', method: 'POST', path: '/me/official-profile/publish', tag: TAG,
  summary: 'Readiness check then publish the official profile. Adds referee to users.roles and upserts sport_profiles rows. Youth users need current guardian consent.',
  input: z.object({ row_version: z.number().int() }),
  async handler({ user }, i) {
    await requireApproved(user);
    if (await isYouth(user.id)) await requireConsent(user.id, 'participation', 'publishing an official profile', null);
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      if (p.row_version !== i.row_version) throw conflict('Profile was updated elsewhere; reload and retry');
      if (p.status === 'suspended') throw forbidden('Your profile is suspended; contact support');
      const sports = (await c.query('SELECT * FROM official_profile_sports WHERE profile_id=$1', [p.id])).rows;
      if (!sports.length) throw badRequest('Add at least one sport and role before publishing');
      const blockers = [];
      if (!p.display_name_pref) {
        const u = (await c.query('SELECT display_name FROM users WHERE id=$1', [user.id])).rows[0];
        if (!u?.display_name) blockers.push('Display name required');
      }
      if (blockers.length) throw badRequest(blockers.join('; '));
      for (const s of sports) {
        await c.query("INSERT INTO sport_profiles(user_id,sport_id,role) VALUES($1,$2,'referee') ON CONFLICT(user_id,sport_id,role) DO NOTHING", [user.id, s.sport_id]);
      }
      await c.query("UPDATE users SET roles = CASE WHEN 'referee' = ANY(roles) THEN roles ELSE array_append(roles,'referee') END WHERE id=$1", [user.id]);
      const updated = (await c.query("UPDATE official_profiles SET status='published', published_at=COALESCE(published_at,now()), step_reached=9, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING id, status, published_at, row_version", [p.id, p.row_version])).rows[0];
      if (!updated) throw conflict('Profile was updated elsewhere; reload and retry');
      await c.query('INSERT INTO official_profile_history(profile_id,from_status,to_status,actor_id) VALUES($1,$2,$3,$4)', [p.id, p.status, 'published', user.id]);
      await audit(c, user.id, 'official_profile_published', 'official_profiles', p.id);
      return updated;
    });
  },
});

cap({
  name: 'retract_official_profile', method: 'POST', path: '/me/official-profile/retract', tag: TAG,
  summary: 'Retract a published profile back to draft. Keeps all data.',
  input: z.object({ row_version: z.number().int() }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      if (p.row_version !== i.row_version) throw conflict('Profile was updated elsewhere; reload and retry');
      if (p.status !== 'published') throw conflict('Profile is not published');
      const updated = (await c.query("UPDATE official_profiles SET status='draft', row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING id, status, row_version", [p.id, p.row_version])).rows[0];
      await c.query('INSERT INTO official_profile_history(profile_id,from_status,to_status,actor_id) VALUES($1,$2,$3,$4)', [p.id, 'published', 'draft', user.id]);
      await audit(c, user.id, 'official_profile_retracted', 'official_profiles', p.id);
      return updated;
    });
  },
});

// ------------------------------------------------------------------ public view
cap({
  name: 'get_official_profile', method: 'GET', path: '/official-profiles/:profileId', tag: TAG,
  summary: 'Public view of a published official profile. Strips all encrypted fields, payout data and reference contact info. Respects privacy toggles.',
  input: z.object({ profileId: id }),
  async handler(_ctx, i) {
    const p = await one("SELECT p.*, u.display_name, u.avatar_emoji, u.avatar_color, u.handle FROM official_profiles p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND p.status='published' AND p.archived_at IS NULL", [i.profileId]);
    if (!p) throw notFound('Official profile');
    const name = p.display_name_pref || p.display_name;
    const result = {
      id: p.id, user_id: p.user_id, handle: p.handle, avatar_emoji: p.avatar_emoji, avatar_color: p.avatar_color,
      display_name: name, preferred_pronouns: p.preferred_pronouns, nationality: p.nationality,
      started_year: p.started_year, highest_level: p.highest_level, total_matches_est: p.total_matches_est, published_at: p.published_at,
    };
    if (p.privacy_show_sports) result.sports = await many('SELECT sport_id, role, discipline, primary_sport FROM official_profile_sports WHERE profile_id=$1 ORDER BY primary_sport DESC', [p.id]);
    if (p.privacy_show_experience) result.experience = await many('SELECT sport_id, role, level, body_name, competition_name, from_year, to_year, match_count_est FROM official_profile_experience WHERE profile_id=$1 AND archived_at IS NULL ORDER BY display_order', [p.id]);
    if (p.privacy_show_credentials) result.credentials = await many('SELECT sport_id, role, kind, issuing_body, credential_name, issue_date, expiry_date, level_label, status, verified_at FROM official_profile_credentials WHERE profile_id=$1 AND archived_at IS NULL ORDER BY created_at', [p.id]);
    if (p.privacy_show_rates) result.rates = await many('SELECT sport_id, role, fixture_type, level_label, fee_minor, fee_currency, includes_travel, travel_allowance_per_km_minor FROM official_profile_rates WHERE profile_id=$1 AND archived_at IS NULL ORDER BY created_at', [p.id]);
    return result;
  },
});

// ------------------------------------------------------------------ completeness score
cap({
  name: 'get_official_profile_completeness', method: 'GET', path: '/me/official-profile/completeness', tag: TAG,
  summary: 'Returns the 0–100 completeness score and per-step guidance array. Used by CompletenessBar in the wizard.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT * FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [user.id]);
    if (!p) return { score: 0, guidance: ['Create your profile to begin'] };
    const [sportCount, expCount, credCount, refCount, rateCount, avail] = await Promise.all([
      one('SELECT COUNT(*)::int AS n FROM official_profile_sports WHERE profile_id=$1', [p.id]).then((r) => r.n),
      one('SELECT COUNT(*)::int AS n FROM official_profile_experience WHERE profile_id=$1 AND archived_at IS NULL', [p.id]).then((r) => r.n),
      one('SELECT COUNT(*)::int AS n FROM official_profile_credentials WHERE profile_id=$1 AND archived_at IS NULL', [p.id]).then((r) => r.n),
      one('SELECT COUNT(*)::int AS n FROM official_profile_references WHERE profile_id=$1 AND archived_at IS NULL', [p.id]).then((r) => r.n),
      one("SELECT COUNT(*)::int AS n FROM official_profile_rates WHERE profile_id=$1 AND archived_at IS NULL AND status='active'", [p.id]).then((r) => r.n),
      one('SELECT 1 FROM official_availability WHERE user_id=$1 LIMIT 1', [user.id]).catch(() => null),
    ]);
    const score = computeCompleteness(p, sportCount, expCount, credCount, refCount, rateCount, !!avail);
    const guidance = [];
    if (!p.display_name_pref) guidance.push('Add your display name');
    if (!sportCount) guidance.push('Add at least one sport and role');
    if (!expCount) guidance.push('Add experience entries');
    if (!credCount) guidance.push('Add a credential or licence');
    if (!refCount) guidance.push('Add a reference');
    if (!avail) guidance.push('Set your availability and travel radius');
    if (!rateCount) guidance.push('Add an active rate card');
    if (!p.payout_method) guidance.push('Set payout method');
    if (!(p.bio_translations && Object.keys(p.bio_translations).length)) guidance.push('Add bio in a second language for wider reach');
    if (!(p.portfolio_links && p.portfolio_links.length)) guidance.push('Add a portfolio link to showcase your career');
    return { score, guidance: guidance.slice(0, 3) };
  },
});

// ------------------------------------------------------------------ portfolio links
cap({
  name: 'save_official_portfolio', method: 'PUT', path: '/me/official-profile/portfolio', tag: TAG,
  summary: 'Save portfolio / career media links (max 10). Each entry has kind (video|article|match_report|interview|other), label and url.',
  input: z.object({
    links: z.array(z.object({
      kind: z.enum(PORTFOLIO_KINDS),
      label: z.string().trim().min(1).max(120),
      url: z.string().url().max(500),
    })).max(10),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id, row_version FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      await c.query("UPDATE official_profiles SET portfolio_links=$1, row_version=row_version+1, updated_at=now() WHERE id=$2", [JSON.stringify(i.links), p.id]);
      return { links: i.links };
    });
  },
});

// ------------------------------------------------------------------ multi-language bio
cap({
  name: 'save_official_bio_translations', method: 'PUT', path: '/me/official-profile/bio-translations', tag: TAG,
  summary: 'Save encrypted bio text in up to 11 platform language packs (es,hi,ta,te,ml,mr,kn,bn,or,si,ur,id). English bio stays in bio_enc via upsert_official_profile.',
  input: z.object({
    translations: z.record(z.enum(PLATFORM_LANGS), z.string().trim().max(1000)),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      const encMap = {};
      for (const [lang, bio] of Object.entries(i.translations)) {
        if (bio) encMap[lang] = encrypt(bio, `official_profiles.bio_translations.${lang}`);
      }
      await c.query("UPDATE official_profiles SET bio_translations=$1, row_version=row_version+1, updated_at=now() WHERE id=$2", [JSON.stringify(encMap), p.id]);
      return { languages: Object.keys(encMap) };
    });
  },
});

cap({
  name: 'list_official_profiles', method: 'GET', path: '/official-profiles', tag: TAG,
  summary: 'Search published official profiles. Filterable by sport, role, level, free-text query.',
  input: z.object({
    sport_id: id.optional(),
    role: role.optional(),
    level: level.optional(),
    q: text(100).optional(),
    ...page,
  }),
  async handler(_ctx, i) {
    return many(
      `SELECT p.id, p.user_id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color, p.display_name_pref,
              p.preferred_pronouns, p.nationality, p.started_year, p.highest_level, p.published_at,
              (SELECT array_agg(DISTINCT ps.role) FROM official_profile_sports ps WHERE ps.profile_id=p.id) AS roles,
              (SELECT array_agg(DISTINCT sp.name) FROM official_profile_sports ps JOIN sports sp ON sp.id=ps.sport_id WHERE ps.profile_id=p.id) AS sport_names
         FROM official_profiles p JOIN users u ON u.id=p.user_id
        WHERE p.status='published' AND p.archived_at IS NULL
          AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM official_profile_sports ps WHERE ps.profile_id=p.id AND ps.sport_id=$1))
          AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM official_profile_sports ps WHERE ps.profile_id=p.id AND ps.role=$2))
          AND ($3::text IS NULL OR p.highest_level=$3)
          AND ($4::text IS NULL OR lower(coalesce(p.display_name_pref,u.display_name)) LIKE lower('%'||$4||'%'))
        ORDER BY p.published_at DESC LIMIT $5 OFFSET $6`,
      [i.sport_id||null, i.role||null, i.level||null, i.q||null, i.limit, i.offset]);
  },
});
