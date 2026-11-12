// Coach profile wizard (#1126): 7-step self-declaration profile for coach roles.
// Auto-saves after every step; resumable from any step_reached. PII encrypted; bank/VAT audit-logged on admin read.
import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { isYouth } from '../youth.js';

const TAG = 'Coach profile';
const text = (n) => z.string().trim().max(n);
const PLATFORM_LANGS = ['es','hi','ta','te','ml','mr','kn','bn','or','si','ur','id'];
const QUAL_KINDS = ['licence','certification','course','badge','diploma','level1','level2','level3','level4','other'];
const OFFERING_TYPES = ['individual','group','team','online','camp','clinic','assessment'];
const PAYOUT_METHODS = ['bank_transfer','stripe','other'];
const PRONOUNS = ['he/him','she/her','they/them','prefer_not_to_say'];
const LEVELS = ['grassroots','local','district','county','regional','national','international','elite'];

function computeCompleteness(p, sportCount, qualCount, expCount, refCount, offeringCount, hasAvailability) {
  // 7 checkpoints × ~14 pts each = 100
  let score = 0;
  if (p.display_name_pref) score += 15;
  if (sportCount > 0) score += 15;
  if (qualCount > 0) score += 10;
  if (expCount > 0) score += 15;
  if (hasAvailability) score += 15;
  if (offeringCount > 0) score += 15;
  if (p.payout_method) score += 10;
  if (p.bio_translations && Object.keys(p.bio_translations).length > 0) score += 5;
  return Math.min(100, score);
}

function cleanSensitive(row) {
  const { bank_account_enc, bank_routing_enc, bank_name_enc, vat_number_enc, bio_enc, ...rest } = row;
  return rest;
}

// ---- options
cap({
  name: 'get_coach_profile_options', method: 'GET', path: '/me/coach-profile/options', tag: TAG,
  summary: 'Wizard dropdown data: sports catalogue, qualification kinds, levels, offering types, payout methods.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const sports = await many('SELECT id, name, emoji FROM sports ORDER BY name');
    return { sports, qual_kinds: QUAL_KINDS, levels: LEVELS, offering_types: OFFERING_TYPES, payout_methods: PAYOUT_METHODS, pronouns: PRONOUNS, platform_langs: PLATFORM_LANGS };
  },
});

// ---- get my profile
cap({
  name: 'get_my_coach_profile', method: 'GET', path: '/me/coach-profile', tag: TAG,
  summary: 'Full draft coach profile for wizard resume. Returns 404 if no profile exists yet.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT * FROM coach_profiles WHERE user_id=$1', [user.id]);
    if (!p) throw notFound('Coach profile');
    return cleanSensitive(p);
  },
});

// ---- upsert (auto-save per step)
const UPSERT_INPUT = z.object({
  row_version: z.number().int().optional(),
  step_reached: z.number().int().min(0).max(6).optional(),
  display_name_pref: text(120).optional(),
  pronouns: z.enum(PRONOUNS).optional(),
  bio: text(1000).optional(),
  nationality_code: z.string().length(2).optional(),
  coaching_since: z.number().int().min(1950).max(new Date().getFullYear()).optional(),
  photo_url: z.string().url().optional(),
  sports: z.array(z.object({
    sport_id: z.string().uuid(),
    level: z.enum(LEVELS),
    primary_sport: z.boolean().optional(),
    coaching_since_year: z.number().int().optional(),
  })).optional(),
  qualifications: z.array(z.object({
    sport_id: z.string().uuid().optional(),
    kind: z.enum(QUAL_KINDS),
    title: text(200),
    issuing_body: text(200).optional(),
    issue_year: z.number().int().optional(),
    expiry_year: z.number().int().optional(),
    licence_number: text(100).optional(),
  })).optional(),
  experience: z.array(z.object({
    organisation: text(200),
    role_title: text(200),
    sport_id: z.string().uuid().optional(),
    from_year: z.number().int().min(1950),
    to_year: z.number().int().optional(),
    is_current: z.boolean().optional(),
    achievements: text(500).optional(),
  })).optional(),
  references_data: z.array(z.object({
    name: text(200),
    role_title: text(200),
    organisation: text(200),
    contact_email: z.string().email().optional(),
    relationship: z.string().optional(),
    consent_given: z.boolean(),
  })).max(3).optional(),
  availability: z.any().optional(),
  offerings: z.array(z.object({
    type: z.enum(OFFERING_TYPES),
    duration_minutes: z.number().int().min(15).max(480),
    fee_minor: z.number().int().min(0),
    fee_currency: z.string().length(3),
    trial_available: z.boolean().optional(),
    remote_available: z.boolean().optional(),
    max_group_size: z.number().int().optional(),
  })).optional(),
  portfolio_links: z.array(z.object({ kind: z.string(), url: z.string().url(), title: text(200).optional() })).optional(),
  bio_translations: z.record(z.string().max(1000)).optional(),
  payout_method: z.enum(PAYOUT_METHODS).optional(),
  bank_name: text(200).optional(),
  bank_account: text(100).optional(),
  bank_routing: text(50).optional(),
  tax_country: z.string().length(2).optional(),
  vat_number: text(50).optional(),
});

cap({
  name: 'upsert_coach_profile', method: 'POST', path: '/me/coach-profile', tag: TAG,
  summary: 'Create or update coach profile draft. Auto-saves after each wizard step. row_version required on updates (409 on stale). step_reached is never decremented.',
  input: UPSERT_INPUT,
  async handler({ user, body }) {
    await requireApproved(user);
    if (await isYouth(user.id)) throw badRequest('Managed/youth profiles cannot hold a coach profile');
    const existing = await one('SELECT id, row_version, step_reached FROM coach_profiles WHERE user_id=$1', [user.id]);
    if (existing && body.row_version != null && body.row_version !== existing.row_version) {
      throw conflict('Coach profile was updated elsewhere. Please reload and try again.');
    }
    const enc = (v) => v ? encrypt(v) : null;
    const newStep = Math.max(existing?.step_reached ?? 0, body.step_reached ?? 0);
    const fields = {
      display_name_pref: body.display_name_pref,
      pronouns: body.pronouns,
      bio: body.bio,
      nationality_code: body.nationality_code,
      coaching_since: body.coaching_since,
      photo_url: body.photo_url,
      sports: body.sports !== undefined ? JSON.stringify(body.sports) : undefined,
      qualifications: body.qualifications !== undefined ? JSON.stringify(body.qualifications) : undefined,
      experience: body.experience !== undefined ? JSON.stringify(body.experience) : undefined,
      references_data: body.references_data !== undefined ? JSON.stringify(body.references_data) : undefined,
      availability: body.availability !== undefined ? JSON.stringify(body.availability) : undefined,
      offerings: body.offerings !== undefined ? JSON.stringify(body.offerings) : undefined,
      portfolio_links: body.portfolio_links !== undefined ? JSON.stringify(body.portfolio_links) : undefined,
      bio_translations: body.bio_translations !== undefined ? JSON.stringify(body.bio_translations) : undefined,
      payout_method: body.payout_method,
      bank_name_enc: body.bank_name !== undefined ? enc(body.bank_name) : undefined,
      bank_account_enc: body.bank_account !== undefined ? enc(body.bank_account) : undefined,
      bank_routing_enc: body.bank_routing !== undefined ? enc(body.bank_routing) : undefined,
      tax_country: body.tax_country,
      vat_number_enc: body.vat_number !== undefined ? enc(body.vat_number) : undefined,
      step_reached: newStep,
      updated_at: new Date(),
    };
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    let row;
    if (!existing) {
      const cols = ['user_id', ...Object.keys(defined)];
      const vals = [user.id, ...Object.values(defined)];
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
      row = await one(`INSERT INTO coach_profiles (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    } else {
      const setClauses = Object.keys(defined).map((k, i) => `${k}=$${i + 2}`).join(', ');
      row = await one(
        `UPDATE coach_profiles SET ${setClauses}, row_version=row_version+1 WHERE user_id=$1 RETURNING *`,
        [user.id, ...Object.values(defined)]
      );
    }
    // recompute completeness
    const pct = computeCompleteness(
      row,
      (row.sports ?? []).length,
      (row.qualifications ?? []).length,
      (row.experience ?? []).length,
      (row.references_data ?? []).length,
      (row.offerings ?? []).length,
      !!row.availability
    );
    if (pct !== row.completeness_pct) {
      row = await one('UPDATE coach_profiles SET completeness_pct=$1 WHERE user_id=$2 RETURNING *', [pct, user.id]);
    }
    return cleanSensitive(row);
  },
});

// ---- publish
cap({
  name: 'publish_coach_profile', method: 'POST', path: '/me/coach-profile/publish', tag: TAG,
  summary: 'Publish draft coach profile. Requires completeness ≥ 60. Adds sport_profiles and coach role.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT * FROM coach_profiles WHERE user_id=$1', [user.id]);
    if (!p) throw notFound('Coach profile');
    if (p.completeness_pct < 60) throw badRequest(`Profile is only ${p.completeness_pct}% complete. Reach 60% to publish.`);
    const row = await tx(async (client) => {
      const updated = await client.query(
        "UPDATE coach_profiles SET status='published', published_at=now(), updated_at=now(), row_version=row_version+1 WHERE user_id=$1 RETURNING *",
        [user.id]
      );
      await client.query(
        "UPDATE users SET roles=array_append(COALESCE(roles,'{}'), 'coach') WHERE id=$1 AND NOT ('coach'=ANY(COALESCE(roles,'{}')))",
        [user.id]
      );
      return updated.rows[0];
    });
    return cleanSensitive(row);
  },
});

// ---- retract
cap({
  name: 'retract_coach_profile', method: 'POST', path: '/me/coach-profile/retract', tag: TAG,
  summary: 'Retract published coach profile back to draft. Keeps all data.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT id, status FROM coach_profiles WHERE user_id=$1', [user.id]);
    if (!p) throw notFound('Coach profile');
    if (p.status !== 'published') throw badRequest('Profile is not published');
    const row = await one(
      "UPDATE coach_profiles SET status='draft', published_at=NULL, updated_at=now(), row_version=row_version+1 WHERE user_id=$1 RETURNING *",
      [user.id]
    );
    return cleanSensitive(row);
  },
});

// ---- completeness
cap({
  name: 'get_coach_profile_completeness', method: 'GET', path: '/me/coach-profile/completeness', tag: TAG,
  summary: 'Completeness score 0–100 with per-checkpoint guidance.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT * FROM coach_profiles WHERE user_id=$1', [user.id]);
    if (!p) return { score: 0, guidance: ['Start by filling in your identity'] };
    const checks = [
      { key: 'identity', done: !!p.display_name_pref, label: 'Display name and bio' },
      { key: 'sports', done: (p.sports ?? []).length > 0, label: 'At least one sport' },
      { key: 'qualifications', done: (p.qualifications ?? []).length > 0, label: 'At least one qualification' },
      { key: 'experience', done: (p.experience ?? []).length > 0, label: 'At least one experience entry' },
      { key: 'availability', done: !!p.availability, label: 'Availability schedule' },
      { key: 'offerings', done: (p.offerings ?? []).length > 0, label: 'At least one offering with pricing' },
      { key: 'payout', done: !!p.payout_method, label: 'Payout method' },
    ];
    const guidance = checks.filter(c => !c.done).map(c => c.label);
    return { score: p.completeness_pct, checks, guidance };
  },
});
