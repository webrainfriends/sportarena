// Academy OS 1/3: the academy profile, programme catalogue (versioned commercial terms) and versioned policies/agreements.
// Everything hangs off an existing organisation; athletes, guardians, consent and money are never copied here.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { isSupportedCurrency } from '../currency.js';
import { STAFF, questionsShape, checkQuestions, lockProgramme, promoteWaitlist, actFor, outstandingPolicies } from '../academy.js';

const day = z.string().date();
const FOCUS = ['recreational', 'development', 'elite'];
const FORMATS = ['term_course', 'rolling', 'camp', 'clinic', 'trial_programme', 'one_to_one', 'squad_pathway', 'custom'];
const MODES = ['direct', 'trial_then_enrol', 'application', 'invite_only', 'waitlist_only'];
const sha = (t) => createHash('sha256').update(t).digest('hex');
const stale = () => conflict('This was changed by someone else. Reload and try again.');
const currency = z.string().length(3).transform((s) => s.toUpperCase()).refine(isSupportedCurrency, 'Unsupported currency');

// ------------------------------------------------------------------ academy profile (1:1 with the organisation)
cap({
  name: 'get_academy_profile', method: 'GET', path: '/organisations/:id/academy', tag: 'Academy',
  summary: 'The academy configuration of an organisation (any member). Empty until the first save.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id);
    return (await one('SELECT * FROM academy_profiles WHERE organisation_id=$1', [i.id])) ?? { organisation_id: i.id, sports: [], focus: 'mixed', currency: 'GBP', listed: false, row_version: 0 };
  },
});

cap({
  name: 'update_academy_profile', method: 'PATCH', path: '/organisations/:id/academy', tag: 'Academy',
  summary: 'Set the academy profile (owner/admin): legal name, sports, focus, ages, timezone, currency, listing and contact channel. Send row_version from the last read.',
  input: z.object({
    id, row_version: z.number().int().min(0), legal_name: z.string().max(120).optional(), sports: z.array(z.string().min(2).max(40)).max(20).optional(),
    focus: z.enum(['recreational', 'development', 'elite', 'mixed']).optional(), age_min: z.number().int().min(0).max(99).optional(), age_max: z.number().int().min(0).max(99).optional(),
    timezone: z.string().max(60).optional(), currency: currency.optional(), listed: z.boolean().optional(), policy_url: z.string().url().optional(), contact_channel: z.enum(['platform', 'email', 'phone']).optional(),
    invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,8}$/, '3–8 letters or digits').optional().describe('printed at the start of your invoice numbers'), tax_id: z.string().trim().max(40).optional().describe('printed on invoices'), billing_address: z.string().trim().max(300).optional().describe('printed on invoices'),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    const { id: oid, row_version, ...v } = i;
    if (row_version === 0) {
      const r = (await c.query(
        `INSERT INTO academy_profiles(organisation_id, legal_name, sports, focus, age_min, age_max, timezone, currency, listed, policy_url, contact_channel, invoice_prefix, tax_id, billing_address)
         VALUES ($1,$2,$3,coalesce($4,'mixed'),$5,$6,$7,coalesce($8,'GBP'),coalesce($9,false),$10,$11,$12,$13,$14) ON CONFLICT (organisation_id) DO NOTHING RETURNING *`,
        [oid, v.legal_name ?? null, v.sports ?? [], v.focus, v.age_min ?? null, v.age_max ?? null, v.timezone ?? null, v.currency, v.listed, v.policy_url ?? null, v.contact_channel ?? null, v.invoice_prefix ?? null, v.tax_id ?? null, v.billing_address ?? null])).rows[0];
      if (!r) throw stale();
      return r;
    }
    const r = (await c.query(
      `UPDATE academy_profiles SET legal_name=coalesce($3,legal_name), sports=coalesce($4,sports), focus=coalesce($5,focus), age_min=coalesce($6,age_min), age_max=coalesce($7,age_max),
              timezone=coalesce($8,timezone), currency=coalesce($9,currency), listed=coalesce($10,listed), policy_url=coalesce($11,policy_url), contact_channel=coalesce($12,contact_channel),
              invoice_prefix = CASE WHEN academy_profiles.invoice_prefix IS NULL THEN $13 ELSE academy_profiles.invoice_prefix END, tax_id=coalesce($14,tax_id), billing_address=coalesce($15,billing_address),
              row_version=row_version+1, updated_at=now() WHERE organisation_id=$1 AND row_version=$2 RETURNING *`,
      [oid, row_version, v.legal_name, v.sports, v.focus, v.age_min, v.age_max, v.timezone, v.currency, v.listed, v.policy_url, v.contact_channel, v.invoice_prefix, v.tax_id, v.billing_address])).rows[0];
    if (!r) throw stale();
    await audit(c, user.id, 'update_academy_profile', 'organisations', oid);
    return r;
  }),
});

// ------------------------------------------------------------------ programmes
const programmeFields = {
  season_id: id.optional(), sport: z.string().min(2).max(40), discipline: z.string().max(60).optional(), title: z.string().min(2).max(120), description: z.string().max(4000).optional(),
  format: z.enum(FORMATS).default('term_course'), focus: z.enum(FOCUS).default('development'), age_min: z.number().int().min(0).max(99).optional(), age_max: z.number().int().min(0).max(99).optional(),
  skill_level: z.string().max(40).optional(), starts_on: day.optional(), ends_on: day.optional(), cadence: z.string().max(80).optional(), session_minutes: z.number().int().min(5).max(600).optional(),
  sessions_planned: z.number().int().min(0).max(1000).optional(), admission_mode: z.enum(MODES).default('direct'), capacity: z.number().int().min(1).max(5000).optional(), min_enrol: z.number().int().min(0).optional(),
  waitlist_enabled: z.boolean().default(true), trial_enabled: z.boolean().default(false), prerequisite_ids: z.array(id).max(10).default([]), equipment: z.string().max(500).optional(),
  coach_ids: z.array(id).max(20).default([]), venue_ids: z.array(id).max(20).default([]), public: z.boolean().default(false),
};
async function checkLinks(c, orgId, i) {
  if (i.season_id && !(await c.query("SELECT 1 FROM org_seasons WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.season_id, orgId])).rows.length) throw badRequest('That season is not part of this organisation');
  if (i.coach_ids?.length) {
    const n = (await c.query("SELECT count(*)::int AS n FROM organisation_members WHERE organisation_id=$1 AND user_id = ANY($2) AND status='active' AND role IN ('coach','admin','owner')", [orgId, i.coach_ids])).rows[0].n;
    if (n !== new Set(i.coach_ids).size) throw badRequest('Coaches must be active staff of this organisation');
  }
  if (i.venue_ids?.length) {
    const n = (await c.query('SELECT count(*)::int AS n FROM venues WHERE id = ANY($1)', [i.venue_ids])).rows[0].n;
    if (n !== new Set(i.venue_ids).size) throw badRequest('One of the venues does not exist');
  }
  if (i.prerequisite_ids?.length) {
    const n = (await c.query('SELECT count(*)::int AS n FROM academy_programmes WHERE id = ANY($1) AND organisation_id=$2', [i.prerequisite_ids, orgId])).rows[0].n;
    if (n !== new Set(i.prerequisite_ids).size) throw badRequest('Prerequisites must be programmes of this academy');
  }
  if (i.ends_on && i.starts_on && i.ends_on < i.starts_on) throw badRequest('A programme cannot end before it starts');
  if (i.age_max != null && i.age_min != null && i.age_max < i.age_min) throw badRequest('The maximum age is below the minimum age');
}

cap({
  name: 'create_academy_programme', method: 'POST', path: '/organisations/:id/academy/programmes', tag: 'Academy', status: 201,
  summary: 'Create a draft programme / course (owner/admin). Pricing and the application questions are set when you publish a version.',
  input: z.object({ id, ...programmeFields }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    await checkLinks(c, i.id, i);
    const p = (await c.query(
      `INSERT INTO academy_programmes(organisation_id, season_id, sport, discipline, title, description, format, focus, age_min, age_max, skill_level, starts_on, ends_on, cadence, session_minutes, sessions_planned,
         admission_mode, capacity, min_enrol, waitlist_enabled, trial_enabled, prerequisite_ids, equipment, coach_ids, venue_ids, public, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
      [i.id, i.season_id ?? null, i.sport, i.discipline ?? null, i.title, i.description ?? null, i.format, i.focus, i.age_min ?? null, i.age_max ?? null, i.skill_level ?? null, i.starts_on ?? null, i.ends_on ?? null,
        i.cadence ?? null, i.session_minutes ?? null, i.sessions_planned ?? null, i.admission_mode, i.capacity ?? null, i.min_enrol ?? null, i.waitlist_enabled, i.trial_enabled, i.prerequisite_ids, i.equipment ?? null, i.coach_ids, i.venue_ids, i.public, user.id])).rows[0];
    await audit(c, user.id, 'create_academy_programme', 'academy_programmes', p.id);
    return p;
  }),
});

cap({
  name: 'update_academy_programme', method: 'PATCH', path: '/academy/programmes/:id', tag: 'Academy',
  summary: 'Edit a programme (owner/admin). Send row_version. Descriptive edits apply going forward; the price, fees and questions of a published version never change - publish a new version instead.',
  input: z.object({ id, row_version: z.number().int().min(1), ...Object.fromEntries(Object.entries(programmeFields).map(([k, s]) => [k, s.optional()])), status: z.enum(['closed', 'archived']).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await lockProgramme(c, i.id);
    await orgFor(user, p.organisation_id, STAFF, { write: true, c });
    if (p.row_version !== i.row_version) throw stale();
    const { id: pid, row_version, status, ...v } = i;
    await checkLinks(c, p.organisation_id, { ...p, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) });
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    const sets = keys.map((k, n) => `${k}=$${n + 3}`);
    if (status) { sets.push(`status=$${keys.length + 3}`); }
    if (!sets.length) throw badRequest('Nothing to update');
    const params = [pid, row_version, ...keys.map((k) => v[k]), ...(status ? [status] : [])];
    const r = (await c.query(`UPDATE academy_programmes SET ${sets.join(', ')}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`, params)).rows[0];
    if (!r) throw stale();
    await audit(c, user.id, 'update_academy_programme', 'academy_programmes', pid);
    return r;
  }),
});

const terms = {
  billing_model: z.enum(['free', 'one_time', 'term', 'monthly', 'pack']).default('one_time'), currency, fee_minor: z.number().int().min(0).default(0),
  registration_fee_minor: z.number().int().min(0).default(0), trial_fee_minor: z.number().int().min(0).default(0), deposit_minor: z.number().int().min(0).default(0),
  instalments: z.number().int().min(1).max(24).default(1), sessions_in_pack: z.number().int().min(1).optional(), sibling_discount_bp: z.number().int().min(0).max(10000).default(0),
  multi_programme_discount_bp: z.number().int().min(0).max(10000).default(0), tax_rate_bp: z.number().int().min(0).max(10000).default(0), renewal_terms: z.string().max(1000).optional(),
  offer_valid_hours: z.number().int().min(1).max(2160).default(72), description: z.string().max(4000).optional(), eligibility: z.record(z.string(), z.any()).default({}),
  questions: questionsShape.default([]), policy_version_ids: z.array(id).max(10).default([]),
};
cap({
  name: 'publish_academy_programme', method: 'POST', path: '/academy/programmes/:id/versions', tag: 'Academy', status: 201,
  summary: 'Publish the commercial terms as a new immutable version (owner/admin): billing model, fees, instalments, discounts, application questions and the agreements people must acknowledge. People who already accepted an earlier version keep its terms.',
  input: z.object({ id, row_version: z.number().int().min(1), ...terms }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await lockProgramme(c, i.id);
    await orgFor(user, p.organisation_id, STAFF, { write: true, c });
    if (p.row_version !== i.row_version) throw stale();
    if (p.status === 'archived') throw conflict('This programme is archived');
    if (i.billing_model === 'pack' && !i.sessions_in_pack) throw badRequest('A session pack needs the number of sessions');
    if (i.billing_model !== 'free' && i.fee_minor + i.registration_fee_minor === 0) throw badRequest('Set a fee, or choose "free"');
    if (i.deposit_minor > i.fee_minor) throw badRequest('The deposit cannot exceed the fee');
    checkQuestions(i.questions);
    if (i.policy_version_ids.length) {
      const n = (await c.query('SELECT count(*)::int AS n FROM org_policy_versions v JOIN org_policies p ON p.id=v.policy_id WHERE v.id = ANY($1) AND p.organisation_id=$2', [i.policy_version_ids, p.organisation_id])).rows[0].n;
      if (n !== new Set(i.policy_version_ids).size) throw badRequest('An agreement does not belong to this academy');
    }
    const n = p.current_version + 1;
    // a pack or a monthly fee is sold through the shared memberships/passes engine: this version gets its own organisation-owned plan
    let planId = null;
    if (i.billing_model === 'pack' || i.billing_model === 'monthly') {
      if (i.fee_minor <= 0) throw badRequest('A pack or a monthly fee needs a price');
      const days = p.ends_on ? Math.max(30, Math.min(3650, Math.ceil((new Date(`${String(p.ends_on).slice(0, 10)}T00:00:00Z`) - Date.now()) / 864e5))) : 365;
      const pack = i.billing_model === 'pack';
      planId = (await c.query(
        `INSERT INTO venue_plans(organisation_id, currency, kind, name, description, price_cents, duration_days, duration_months, sessions, session_value_cents, valid_days, auto_renew)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [p.organisation_id, i.currency, pack ? 'pass' : 'membership', `${p.title} · v${n}`, pack ? 'Session pack' : 'Monthly membership', i.fee_minor, pack ? null : 30, pack ? null : 1, pack ? i.sessions_in_pack : null,
          pack ? Math.max(1, Math.floor(i.fee_minor / i.sessions_in_pack)) : null, pack ? days : null, !pack])).rows[0].id;
    }
    const v = (await c.query(
      `INSERT INTO academy_programme_versions(programme_id, version, billing_model, currency, fee_minor, registration_fee_minor, trial_fee_minor, deposit_minor, instalments, sessions_in_pack, sibling_discount_bp,
         multi_programme_discount_bp, tax_rate_bp, renewal_terms, offer_valid_hours, description, eligibility, questions, policy_version_ids, created_by, plan_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [p.id, n, i.billing_model, i.currency, i.fee_minor, i.registration_fee_minor, i.trial_fee_minor, i.deposit_minor, i.instalments, i.sessions_in_pack ?? null, i.sibling_discount_bp, i.multi_programme_discount_bp, i.tax_rate_bp,
        i.renewal_terms ?? null, i.offer_valid_hours, i.description ?? null, JSON.stringify(i.eligibility), JSON.stringify(i.questions), i.policy_version_ids, user.id, planId])).rows[0];
    const up = (await c.query("UPDATE academy_programmes SET current_version=$2, status='published', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [p.id, n])).rows[0];
    await audit(c, user.id, 'publish_academy_programme', 'academy_programmes', p.id);
    return { programme: up, version: v };
  }),
});

const SEATS_SQL = `(SELECT count(*)::int FROM org_enrolments e WHERE e.programme_id=p.id AND e.status IN ('enrolled','paused')) + (SELECT count(*)::int FROM academy_applications a WHERE a.programme_id=p.id AND a.stage IN ('offered','offer_accepted') AND (a.offer_expires_at IS NULL OR a.offer_expires_at > now()))`;
const WAIT_SQL = "(SELECT count(*)::int FROM academy_applications a WHERE a.programme_id=p.id AND a.stage='waitlisted')";
const publicProgramme = ({ created_by, ...p }) => p;

cap({
  name: 'search_academy_programmes', method: 'GET', path: '/academy/programmes', tag: 'Academy', auth: 'public',
  summary: 'Discover published, publicly listed academy programmes by sport, focus, age and organisation. Shows seats left and waitlist length honestly; no internal data.',
  input: z.object({ sport: z.string().max(40).optional(), focus: z.enum(FOCUS).optional(), format: z.enum(FORMATS).optional(), age: z.number().int().min(0).max(99).optional(), organisation_id: id.optional(), q: z.string().max(80).optional(), ...page }),
  async handler(_ctx, i) {
    return many(
      `SELECT p.created_by IS NULL AS _x, p.*, o.name AS organisation_name, o.city, v.billing_model, v.currency, v.fee_minor, v.registration_fee_minor, v.instalments, v.description AS terms_description, ${SEATS_SQL} AS seats_taken, ${WAIT_SQL} AS waitlisted
         FROM academy_programmes p JOIN organisations o ON o.id=p.organisation_id AND o.status='active'
         JOIN academy_profiles ap ON ap.organisation_id=o.id AND ap.listed
         JOIN academy_programme_versions v ON v.programme_id=p.id AND v.version=p.current_version
        WHERE p.status='published' AND p.public AND ($1::text IS NULL OR lower(p.sport)=lower($1)) AND ($2::text IS NULL OR p.focus=$2) AND ($3::text IS NULL OR p.format=$3)
          AND ($4::int IS NULL OR ((p.age_min IS NULL OR p.age_min<=$4) AND (p.age_max IS NULL OR p.age_max>=$4))) AND ($5::uuid IS NULL OR p.organisation_id=$5)
          AND ($6::text IS NULL OR p.title ILIKE '%'||$6||'%' OR o.name ILIKE '%'||$6||'%')
        ORDER BY p.starts_on NULLS LAST, p.title, p.id LIMIT $7 OFFSET $8`,
      [i.sport ?? null, i.focus ?? null, i.format ?? null, i.age ?? null, i.organisation_id ?? null, i.q ?? null, i.limit, i.offset]).then((rows) => rows.map(({ _x, ...p }) => publicProgramme(p)));
  },
});

cap({
  name: 'get_academy_programme', method: 'GET', path: '/academy/programmes/:id', tag: 'Academy', auth: 'public',
  summary: 'One programme with its current commercial terms and seats. Draft/closed programmes are visible to the academy staff only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM academy_programmes WHERE id=$1', [i.id]);
    if (!p) throw notFound('Programme');
    const staff = user ? await one("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin','coach','finance')", [p.organisation_id, user.id]) : null;
    const listed = await one("SELECT 1 FROM academy_profiles ap JOIN organisations o ON o.id=ap.organisation_id WHERE ap.organisation_id=$1 AND ap.listed AND o.status='active'", [p.organisation_id]);
    if (!staff && !(p.status === 'published' && p.public && listed)) throw notFound('Programme');
    const version = await one('SELECT * FROM academy_programme_versions WHERE programme_id=$1 AND version=$2', [p.id, p.current_version]);
    const seats = await one(`SELECT ${SEATS_SQL} AS seats_taken, ${WAIT_SQL} AS waitlisted FROM academy_programmes p WHERE p.id=$1`, [p.id]);
    return { ...publicProgramme(p), version, ...seats, organisation: await one('SELECT id, name, city FROM organisations WHERE id=$1', [p.organisation_id]) };
  },
});

cap({
  name: 'list_academy_programmes', method: 'GET', path: '/organisations/:id/academy/programmes', tag: 'Academy',
  summary: 'The academy\'s programmes with seats taken and waitlist (staff and coaches).',
  input: z.object({ id, status: z.enum(['draft', 'published', 'closed', 'archived']).optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ['owner', 'admin', 'coach', 'finance']);
    return many(
      `SELECT p.*, (SELECT count(*)::int FROM org_enrolments e WHERE e.programme_id=p.id AND e.status IN ('enrolled','paused')) AS enrolled, ${SEATS_SQL} AS seats_taken, ${WAIT_SQL} AS waitlisted
         FROM academy_programmes p WHERE p.organisation_id=$1 AND ($2::text IS NULL OR p.status=$2) ORDER BY (p.status='archived'), p.starts_on DESC NULLS LAST, p.title, p.id LIMIT $3 OFFSET $4`,
      [i.id, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'promote_academy_waitlist', method: 'POST', path: '/academy/programmes/:id/waitlist/promote', tag: 'Academy',
  summary: 'Offer the next waitlisted people while seats are free (owner/admin). Deterministic by waitlist order and safe to repeat; the worker does the same when offers expire.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await lockProgramme(c, i.id);
    await orgFor(user, p.organisation_id, STAFF, { write: true, c });
    return { promoted: (await promoteWaitlist(c, p, { actor: user.id })).length };
  }),
});

// ------------------------------------------------------------------ policies / agreements (versioned, never edited in place)
cap({
  name: 'create_org_policy', method: 'POST', path: '/organisations/:id/policies', tag: 'Academy', status: 201,
  summary: 'Create a policy or agreement and publish its first version (owner/admin). Published text is immutable; to change it publish a new version.',
  input: z.object({ id, kind: z.enum(['participation', 'code_of_conduct', 'refund_policy', 'media_consent', 'equipment', 'pickup', 'programme_declaration', 'other']), title: z.string().min(2).max(120), body: z.string().min(10).max(20000), consent_purpose: z.enum(['participation', 'media', 'contact']).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    const p = (await c.query('INSERT INTO org_policies(organisation_id, kind, title, consent_purpose, current_version, created_by) VALUES ($1,$2,$3,$4,1,$5) RETURNING *', [i.id, i.kind, i.title, i.consent_purpose ?? null, user.id])).rows[0];
    const v = (await c.query('INSERT INTO org_policy_versions(policy_id, version, body, body_sha256, published_by) VALUES ($1,1,$2,$3,$4) RETURNING *', [p.id, i.body, sha(i.body), user.id])).rows[0];
    await audit(c, user.id, 'create_org_policy', 'org_policies', p.id);
    return { ...p, latest: v };
  }),
});

cap({
  name: 'publish_org_policy_version', method: 'POST', path: '/policies/:id/versions', tag: 'Academy', status: 201,
  summary: 'Publish a new version of a policy (owner/admin). Set requires_reconsent when people who agreed earlier must agree again; otherwise earlier agreements still count.',
  input: z.object({ id, body: z.string().min(10).max(20000), requires_reconsent: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM org_policies WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Policy');
    await orgFor(user, p.organisation_id, STAFF, { write: true, c });
    if (p.archived_at) throw conflict('This policy is archived');
    const n = p.current_version + 1;
    const v = (await c.query('INSERT INTO org_policy_versions(policy_id, version, body, body_sha256, requires_reconsent, published_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [p.id, n, i.body, sha(i.body), i.requires_reconsent, user.id])).rows[0];
    await c.query('UPDATE org_policies SET current_version=$2 WHERE id=$1', [p.id, n]);
    await audit(c, user.id, 'publish_org_policy_version', 'org_policies', p.id);
    return v;
  }),
});

cap({
  name: 'list_org_policies', method: 'GET', path: '/organisations/:id/policies', tag: 'Academy',
  summary: 'Policies with their latest version (any member of the organisation).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id);
    return many(
      `SELECT p.id, p.kind, p.title, p.consent_purpose, p.current_version, v.id AS version_id, v.body, v.body_sha256, v.requires_reconsent, v.created_at AS published_at
         FROM org_policies p JOIN org_policy_versions v ON v.policy_id=p.id AND v.version=p.current_version
        WHERE p.organisation_id=$1 AND p.archived_at IS NULL ORDER BY p.title, p.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'acknowledge_policy', method: 'POST', path: '/policy-versions/:id/acknowledge', tag: 'Academy', status: 201,
  summary: 'Acknowledge an agreement for yourself or, as a verified guardian, for your child. Records who, for whom, when and which version. This is an acknowledgement, not a legal e-signature. Safe to repeat.',
  input: z.object({ id, athlete_id: id.optional().describe('the person the agreement is for (default: you)'), text_sha256: z.string().length(64).describe('hash of the text shown, from list_org_policies / the programme') }),
  handler: ({ user }, i) => tx(async (c) => {
    const athlete = i.athlete_id ?? user.id;
    const v = (await c.query('SELECT v.*, p.organisation_id FROM org_policy_versions v JOIN org_policies p ON p.id=v.policy_id WHERE v.id=$1', [i.id])).rows[0];
    if (!v) throw notFound('Agreement');
    const how = await actFor(user, athlete, c);
    if (v.body_sha256 !== i.text_sha256) throw conflict('The agreement text changed. Reload and read the latest version.');
    const r = (await c.query(
      `INSERT INTO org_acknowledgements(policy_version_id, subject_id, acknowledged_by, as_guardian, body_sha256) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (policy_version_id, subject_id) DO NOTHING RETURNING *`, [v.id, athlete, user.id, !how.self, v.body_sha256])).rows[0];
    await audit(c, user.id, 'acknowledge_policy', 'org_policy_versions', v.id);
    return r ?? (await c.query('SELECT * FROM org_acknowledgements WHERE policy_version_id=$1 AND subject_id=$2', [v.id, athlete])).rows[0];
  }),
});

cap({
  name: 'list_outstanding_agreements', method: 'GET', path: '/academy/programmes/:id/agreements', tag: 'Academy',
  summary: 'Which required agreements an athlete still has to acknowledge for a programme (the athlete, or their verified guardian).',
  input: z.object({ id, athlete_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const athlete = i.athlete_id ?? user.id;
    await actFor(user, athlete, c);
    const p = (await c.query('SELECT * FROM academy_programmes WHERE id=$1', [i.id])).rows[0];
    const v = p && (await c.query('SELECT * FROM academy_programme_versions WHERE programme_id=$1 AND version=$2', [p.id, p.current_version])).rows[0];
    if (!p || !v || p.status !== 'published') throw notFound('Programme');
    const missing = await outstandingPolicies(c, athlete, v.policy_version_ids);
    const full = [];
    for (const m of missing) full.push({ ...m, ...(await c.query('SELECT body, body_sha256 FROM org_policy_versions WHERE id=$1', [m.version_id])).rows[0] });
    return full;
  }),
});

