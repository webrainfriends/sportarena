// Education pathways, part 1: what an athlete can learn and where they can study. Sport rules (curated by the platform team),
// institution profiles, programmes (courses, certifications, diplomas, degrees) and brochures. An institution is an ordinary
// organisation (kind college / university / academy ...), so its staff are the organisation's owners and admins.
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { orgFor } from '../org-access.js';
import { builtinRuleset, describeRuleset, rulesetSchema } from '../scoring/rulesets.js';
import { BOOKS, bookFor, cardsFor } from '../rulebook/catalog.js';
import { standardMetricKinds } from '../scoring/metric-defs.js';
import { ADMISSIONS } from '../education.js';
import { ratingsFor } from './education-discovery.js';
import { AGE, levels } from '../opportunity-fields.js';

const TAG = 'Education';
const https = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'Links must use https');
const KINDS = ['course', 'certification', 'diploma', 'degree', 'postgraduate', 'short_course'];
const MODES = ['on_campus', 'online', 'hybrid'];

const sportOr404 = async (v) => (await sportBySlugOrId(v)) ?? Promise.reject(notFound('Sport'));

// ------------------------------------------------------------------ rules of a sport
cap({
  name: 'list_sport_rules', method: 'GET', path: '/sports/:sport/rules', tag: TAG, auth: 'public',
  summary: 'The rules of a sport in short sections, each with the source it comes from. Start here when you are new to a sport. Includes how the sport is scored (from the built-in scoring rules, so every sport with one has something to read), any sections the platform team has written, and the written rulebook (`rulebook`) where one exists. Localise it in Tools > Rules & rulebook.',
  input: z.object({ sport: z.string().min(1) }),
  async handler(_, i) {
    const sport = await sportOr404(i.sport);
    // the platform's standard rules are always returned; a governed default (if one was published) is reported next to them, never instead of them
    const gov = await one("SELECT id, version, format_key, label, ruleset, created_at FROM ruleset_versions WHERE sport_id=$1 AND format_key='default' ORDER BY version DESC LIMIT 1", [sport.id]);
    const standard = builtinRuleset(sport);
    return { sport: { id: sport.id, slug: sport.slug, name: sport.name, emoji: sport.emoji }, scoring: describeRuleset(standard), standard_ruleset: standard, standard_metrics: standardMetricKinds(sport), default_metric_kind: sport.scoring,
      in_force: gov ? { version: gov.version, format_key: gov.format_key, label: gov.label, published_at: gov.created_at, scoring: describeRuleset(gov.ruleset), differs_from_standard: !isDeepStrictEqual(rulesetSchema.parse(gov.ruleset), standard) } : null, rules: await many("SELECT id, title, body, source_url, position FROM sport_rules WHERE sport_id=$1 AND status='active' ORDER BY position, created_at, id", [sport.id]),
      // the written rulebook (Tools > Rules & rulebook): the same cards, so learners and scorers read one set of rules
      rulebook: (() => { const b = bookFor(sport.slug); return b ? { slug: b.slug, body: b.book.body, official_url: b.book.official_url, formats: b.book.formats ?? null, cards: cardsFor(b.book, b.format).map((c) => ({ no: c.no, title: c.title, body: c.body })) } : null; })() };
  },
});

cap({
  name: 'save_sport_rule', method: 'POST', path: '/sports/:sport/rules', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: add a section of rules to a sport. Cite the official source (a governing body page) where you can.',
  input: z.object({ sport: z.string().min(1), title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(8000), source_url: https.optional(), position: z.number().int().min(0).max(1000).default(0) }),
  async handler({ user }, i) {
    const sport = await sportOr404(i.sport);
    return one('INSERT INTO sport_rules(sport_id, title, body, source_url, position, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [sport.id, i.title, i.body, i.source_url ?? null, i.position, user.id]);
  },
});

cap({
  name: 'update_sport_rule', method: 'PATCH', path: '/sport-rules/:id', tag: TAG, auth: ['admin'],
  summary: 'Platform team: edit, reorder or archive (status archived) a rules section. Archived sections are kept.',
  input: z.object({ id, title: z.string().trim().min(2).max(120).optional(), body: z.string().trim().min(2).max(8000).optional(), source_url: https.nullable().optional(), position: z.number().int().min(0).max(1000).optional(), status: z.enum(['active', 'archived']).optional() }),
  async handler(_, i) {
    const row = await one(
      `UPDATE sport_rules SET title=coalesce($2,title), body=coalesce($3,body), source_url=CASE WHEN $4::boolean THEN $5 ELSE source_url END,
              position=coalesce($6,position), status=coalesce($7,status), updated_at=now() WHERE id=$1 RETURNING *`,
      [i.id, i.title ?? null, i.body ?? null, i.source_url !== undefined, i.source_url ?? null, i.position ?? null, i.status ?? null]);
    if (!row) throw notFound('Rules section');
    return row;
  },
});

// ------------------------------------------------------------------ the institution's public face
const contactOf = (p) => ({ email: p.contact_email_enc ? decrypt(p.contact_email_enc, 'institution_profiles.contact_email') : null, phone: p.contact_phone_enc ? decrypt(p.contact_phone_enc, 'institution_profiles.contact_phone') : null });

cap({
  name: 'get_institution_profile', method: 'GET', path: '/organisations/:id/institution', tag: TAG,
  summary: 'Admissions staff: your institution\'s listing (about, website, country, whether it is listed, contact email and phone). Reading the contacts is logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { org } = await orgFor(user, i.id, ADMISSIONS);
    const p = await one('SELECT * FROM institution_profiles WHERE organisation_id=$1', [i.id]);
    if (p) await audit(null, user.id, 'read_pii', 'institution_profiles', i.id);
    return { organisation_id: org.id, name: org.name, kind: org.kind, city: org.city, about: p?.about ?? null, website: p?.website ?? null, country: p?.country ?? null, listed: p?.listed ?? false, ...(p ? contactOf(p) : { email: null, phone: null }) };
  },
});

cap({
  name: 'save_institution_profile', method: 'PATCH', path: '/organisations/:id/institution', tag: TAG,
  summary: 'Admissions staff: write your institution\'s listing. Contact email and phone are stored encrypted. Set `listed` to appear in the directory; a listing needs a contact email or a website so enquirers can reach you.',
  input: z.object({ id, about: z.string().max(3000).nullable().optional(), website: https.nullable().optional(), country: z.string().trim().max(60).nullable().optional(), listed: z.boolean().optional(), contact_email: z.string().email().max(200).nullable().optional(), contact_phone: z.string().trim().max(30).nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, ADMISSIONS, { write: true, c });
    const cur = (await c.query('SELECT * FROM institution_profiles WHERE organisation_id=$1 FOR UPDATE', [i.id])).rows[0];
    const has = (k) => i[k] !== undefined;
    const enc = (v, ctx) => (v ? encrypt(v, ctx) : null);
    const next = {
      about: has('about') ? i.about : cur?.about ?? null, website: has('website') ? i.website : cur?.website ?? null, country: has('country') ? i.country : cur?.country ?? null,
      listed: has('listed') ? i.listed : cur?.listed ?? false,
      email: has('contact_email') ? enc(i.contact_email, 'institution_profiles.contact_email') : cur?.contact_email_enc ?? null,
      phone: has('contact_phone') ? enc(i.contact_phone, 'institution_profiles.contact_phone') : cur?.contact_phone_enc ?? null,
    };
    if (next.listed && !next.email && !next.website) throw badRequest('Add a contact email or a website before listing, so athletes can reach you');
    await c.query(
      `INSERT INTO institution_profiles(organisation_id, about, website, country, listed, contact_email_enc, contact_phone_enc) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organisation_id) DO UPDATE SET about=$2, website=$3, country=$4, listed=$5, contact_email_enc=$6, contact_phone_enc=$7, updated_at=now()`,
      [i.id, next.about, next.website, next.country, next.listed, next.email, next.phone]);
    await audit(c, user.id, 'save_institution_profile', 'institution_profiles', i.id);
    return { organisation_id: i.id, about: next.about, website: next.website, country: next.country, listed: next.listed, has_email: !!next.email, has_phone: !!next.phone };
  }),
});

const LISTED = "o.status='active' AND ip.listed";
const PROG_SPORTS = `coalesce((SELECT json_agg(json_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'emoji', s.emoji) ORDER BY s.name) FROM programme_sports ps JOIN sports s ON s.id=ps.sport_id WHERE ps.programme_id=p.id AND ps.removed_at IS NULL), '[]'::json)`;

const csv = (max) => z.string().trim().max(max).optional().transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12) : undefined));
const multi = {
  sports: csv(300).describe('comma-separated sport slugs'), general: z.enum(['true', 'false']).optional().transform((v) => v === 'true').describe('also (or only) general sports programmes that are not tied to one sport'),
  countries: csv(500).describe('comma-separated countries'),
};
/** Sport ids to match (null = any sport), whether general programmes count, and lower-cased countries (null = anywhere). */
async function multiFilter(i, single) {
  const slugs = [...new Set([...(i.sports ?? []), ...(single ? [single] : [])])];
  const ids = [];
  for (const sl of slugs) ids.push((await sportOr404(sl)).id);
  return { ids: ids.length || i.general ? ids : null, general: !!i.general, countries: i.countries?.length ? i.countries.map((x) => x.toLowerCase()) : null };
}

cap({
  name: 'search_institutions', method: 'GET', path: '/institutions', tag: TAG, auth: 'public',
  summary: 'Colleges, universities and academies that list themselves on the platform. Filter by name, sport they teach, country, city or type. No contact details here; sign in and open the institution to get them.',
  input: z.object({ q: z.string().trim().max(80).optional(), sport: z.string().optional(), country: z.string().max(60).optional(), city: z.string().max(80).optional(), kind: z.enum(['academy', 'school', 'college', 'university', 'club', 'other']).optional(), region: z.string().trim().max(80).optional().describe('a city or country; matches either'), ...multi, ...page }),
  async handler(_, i) {
    const f = await multiFilter(i, i.sport);
    const rows = await many(
      `SELECT o.id, o.name, o.kind, o.city, ip.country, ip.about, ip.website,
              (SELECT count(*)::int FROM programmes p WHERE p.organisation_id=o.id AND p.status='active') AS programmes
         FROM organisations o JOIN institution_profiles ip ON ip.organisation_id=o.id
        WHERE ${LISTED} AND ($1::text IS NULL OR o.name ILIKE '%'||$1||'%') AND ($2::text IS NULL OR lower(ip.country)=lower($2)) AND ($3::text IS NULL OR lower(o.city)=lower($3))
          AND ($4::text IS NULL OR o.kind=$4) AND ($8::text IS NULL OR o.city ILIKE '%'||$8||'%' OR ip.country ILIKE '%'||$8||'%')
          AND ($5::uuid[] IS NULL OR EXISTS (SELECT 1 FROM programmes p WHERE p.organisation_id=o.id AND p.status='active' AND (EXISTS (SELECT 1 FROM programme_sports ps WHERE ps.programme_id=p.id AND ps.removed_at IS NULL AND ps.sport_id = ANY($5)) OR ($9 AND NOT EXISTS (SELECT 1 FROM programme_sports ps WHERE ps.programme_id=p.id AND ps.removed_at IS NULL)))))
          AND ($10::text[] IS NULL OR lower(ip.country) = ANY($10))
        ORDER BY o.name, o.id LIMIT $6 OFFSET $7`,
      [i.q ?? null, i.country ?? null, i.city ?? null, i.kind ?? null, f.ids, i.limit, i.offset, i.region ?? null, f.general, f.countries]);
    const r = await ratingsFor('institution', rows.map((x) => x.id));
    return rows.map((x) => ({ ...x, rating: r.get(x.id)?.rating ?? null, reviews: r.get(x.id)?.reviews ?? 0 }));
  },
});

cap({
  name: 'get_institution', method: 'GET', path: '/institutions/:id', tag: TAG, auth: 'public',
  summary: 'A listed institution with its active programmes and brochures. Contact details are not included; use get_institution_contact.',
  input: z.object({ id }),
  async handler(_, i) {
    const o = await one(`SELECT o.id, o.name, o.kind, o.city, ip.country, ip.about, ip.website FROM organisations o JOIN institution_profiles ip ON ip.organisation_id=o.id WHERE o.id=$1 AND ${LISTED}`, [i.id]);
    if (!o) throw notFound('Institution');
    const [programmes, brochures] = await Promise.all([
      many(`SELECT p.id, p.title, p.kind, p.mode, p.duration_months, p.fee_minor, p.currency, p.next_intake_on, ${PROG_SPORTS} AS sports FROM programmes p WHERE p.organisation_id=$1 AND p.status='active' ORDER BY p.title, p.id`, [i.id]),
      many("SELECT id, title, url, programme_id FROM brochures WHERE organisation_id=$1 AND status='active' AND programme_id IS NULL ORDER BY created_at DESC", [i.id]),
    ]);
    const [ri, rp] = await Promise.all([ratingsFor('institution', [o.id]), ratingsFor('programme', programmes.map((p) => p.id))]);
    return { ...o, rating: ri.get(o.id)?.rating ?? null, reviews: ri.get(o.id)?.reviews ?? 0, programmes: programmes.map((p) => ({ ...p, rating: rp.get(p.id)?.rating ?? null, reviews: rp.get(p.id)?.reviews ?? 0 })), brochures };
  },
});

cap({
  name: 'get_institution_contact', method: 'GET', path: '/institutions/:id/contact', tag: TAG,
  summary: 'Contact details (email, phone, website) of a listed institution, for signed-in people only. Each read is logged. To be answered through the platform, send an enquiry instead.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one(`SELECT ip.* FROM institution_profiles ip JOIN organisations o ON o.id=ip.organisation_id WHERE ip.organisation_id=$1 AND ${LISTED}`, [i.id]);
    if (!p) throw notFound('Institution');
    await audit(null, user.id, 'read_pii', 'institution_profiles', i.id);
    return { organisation_id: i.id, website: p.website, ...contactOf(p) };
  },
});

// ------------------------------------------------------------------ programmes
const programmeIn = {
  title: z.string().trim().min(2).max(120), kind: z.enum(KINDS), mode: z.enum(MODES), description: z.string().max(4000),
  sport_ids: z.array(id).max(12).describe('sports this programme teaches; leave empty for a general sports programme (e.g. sports management)'),
  duration_months: z.number().int().min(1).max(120), fee_minor: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/), next_intake_on: z.string().date(), apply_url: https,
};

async function checkSports(c, ids) {
  if (!ids?.length) return;
  const n = (await c.query('SELECT count(*)::int AS n FROM sports WHERE id = ANY($1)', [[...new Set(ids)]])).rows[0].n;
  if (n !== new Set(ids).size) throw badRequest('One of the sports does not exist');
}
const setSports = async (c, programmeId, ids) => {
  const keep = [...new Set(ids)];
  await c.query('UPDATE programme_sports SET removed_at=now() WHERE programme_id=$1 AND removed_at IS NULL AND NOT (sport_id = ANY($2))', [programmeId, keep]);
  for (const s of keep) await c.query('INSERT INTO programme_sports(programme_id, sport_id) VALUES ($1,$2) ON CONFLICT (programme_id, sport_id) DO UPDATE SET removed_at=NULL', [programmeId, s]);
};

cap({
  name: 'create_programme', method: 'POST', path: '/organisations/:id/programmes', tag: TAG, status: 201,
  summary: 'Admissions staff: publish a course, certification, diploma or degree. Pick the sports it covers, the fee in a currency, the next intake date and where to apply on your website.',
  input: z.object({ id, title: programmeIn.title, kind: programmeIn.kind, mode: programmeIn.mode.default('on_campus'), description: programmeIn.description.optional(), sport_ids: programmeIn.sport_ids.default([]), duration_months: programmeIn.duration_months.optional(), fee_minor: programmeIn.fee_minor.optional(), currency: programmeIn.currency.optional(), next_intake_on: programmeIn.next_intake_on.optional(), apply_url: programmeIn.apply_url.optional(), levels: levels.default([]), ...AGE }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, ADMISSIONS, { write: true, c });
    if (i.min_age != null && i.max_age != null && i.max_age < i.min_age) throw badRequest('max_age is below min_age');
    if (i.fee_minor !== undefined && !i.currency) throw badRequest('Choose the currency of the fee');
    await checkSports(c, i.sport_ids);
    const p = (await c.query(
      `INSERT INTO programmes(organisation_id, title, kind, mode, description, duration_months, fee_minor, currency, next_intake_on, apply_url, created_by, levels, min_age, max_age) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [i.id, i.title, i.kind, i.mode, i.description ?? null, i.duration_months ?? null, i.fee_minor ?? null, i.fee_minor === undefined ? null : i.currency, i.next_intake_on ?? null, i.apply_url ?? null, user.id, i.levels, i.min_age ?? null, i.max_age ?? null])).rows[0];
    await setSports(c, p.id, i.sport_ids);
    return { ...p, sport_ids: [...new Set(i.sport_ids)] };
  }),
});

cap({
  name: 'update_programme', method: 'PATCH', path: '/programmes/:id', tag: TAG,
  summary: 'Admissions staff: edit a programme, change its sports, or archive it (status archived) when it stops running. Archived programmes disappear from search but their enquiries and credentials are kept.',
  input: z.object({ id, title: programmeIn.title.optional(), kind: programmeIn.kind.optional(), mode: programmeIn.mode.optional(), description: programmeIn.description.nullable().optional(), sport_ids: programmeIn.sport_ids.optional(), duration_months: programmeIn.duration_months.nullable().optional(), fee_minor: programmeIn.fee_minor.nullable().optional(), currency: programmeIn.currency.nullable().optional(), next_intake_on: programmeIn.next_intake_on.nullable().optional(), apply_url: programmeIn.apply_url.nullable().optional(), levels: levels.optional(), min_age: AGE.min_age.nullable(), max_age: AGE.max_age.nullable(), status: z.enum(['active', 'archived']).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM programmes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Programme');
    await orgFor(user, cur.organisation_id, ADMISSIONS, { write: true, c });
    const { id: _id, sport_ids, status, ...rest } = i;
    const keys = Object.keys(rest).filter((k) => rest[k] !== undefined);
    if (!keys.length && sport_ids === undefined && status === undefined) throw badRequest('Nothing to update');
    const merged = { ...cur, ...Object.fromEntries(keys.map((k) => [k, rest[k]])) };
    if (merged.fee_minor !== null && !merged.currency) throw badRequest('Choose the currency of the fee');
    if (merged.min_age != null && merged.max_age != null && merged.max_age < merged.min_age) throw badRequest('max_age is below min_age');
    if (sport_ids) { await checkSports(c, sport_ids); await setSports(c, cur.id, sport_ids); }
    const next = status ?? cur.status;
    const row = (await c.query(
      `UPDATE programmes SET title=$2, kind=$3, mode=$4, description=$5, duration_months=$6, fee_minor=$7, currency=$8, next_intake_on=$9, apply_url=$10, status=$11, levels=$12, min_age=$13, max_age=$14,
              archived_at = CASE WHEN $11 = 'archived' THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 RETURNING *`,
      [cur.id, merged.title, merged.kind, merged.mode, merged.description, merged.duration_months, merged.fee_minor, merged.currency, merged.next_intake_on, merged.apply_url, next, merged.levels, merged.min_age, merged.max_age])).rows[0];
    return row;
  }),
});

cap({
  name: 'list_org_programmes', method: 'GET', path: '/organisations/:id/programmes', tag: TAG,
  summary: 'Admissions staff: all your programmes (active and archived) with their sports and how many enquiries each has had.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ADMISSIONS);
    return many(
      `SELECT p.*, ${PROG_SPORTS} AS sports, (SELECT count(*)::int FROM enquiries e WHERE e.programme_id=p.id) AS enquiries
         FROM programmes p WHERE p.organisation_id=$1 ORDER BY (p.status='active') DESC, p.title, p.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'search_programmes', method: 'GET', path: '/programmes', tag: TAG, auth: 'public',
  summary: 'Find courses, certifications, diplomas and degrees at listed institutions. Filter by sport, type, how it is taught, country, city or words in the title. Sorted by next intake.',
  input: z.object({ q: z.string().trim().max(80).optional(), sport: z.string().optional(), kind: z.enum(KINDS).optional(), mode: z.enum(MODES).optional(), country: z.string().max(60).optional(), city: z.string().max(80).optional(), region: z.string().trim().max(80).optional().describe('a city or country; matches either'), ...multi, ...page }),
  async handler(_, i) {
    const f = await multiFilter(i, i.sport);
    const rows = await many(
      `SELECT p.id, p.title, p.kind, p.mode, p.description, p.duration_months, p.fee_minor, p.currency, p.next_intake_on, ${PROG_SPORTS} AS sports,
              o.id AS organisation_id, o.name AS institution, o.kind AS institution_kind, o.city, ip.country
         FROM programmes p JOIN organisations o ON o.id=p.organisation_id JOIN institution_profiles ip ON ip.organisation_id=o.id
        WHERE p.status='active' AND ${LISTED}
          AND ($1::text IS NULL OR p.title ILIKE '%'||$1||'%' OR o.name ILIKE '%'||$1||'%') AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM programme_sports ps WHERE ps.programme_id=p.id AND ps.removed_at IS NULL AND ps.sport_id = ANY($2)) OR ($10 AND NOT EXISTS (SELECT 1 FROM programme_sports ps WHERE ps.programme_id=p.id AND ps.removed_at IS NULL)))
          AND ($11::text[] IS NULL OR lower(ip.country) = ANY($11))
          AND ($3::text IS NULL OR p.kind=$3) AND ($4::text IS NULL OR p.mode=$4) AND ($5::text IS NULL OR lower(ip.country)=lower($5)) AND ($6::text IS NULL OR lower(o.city)=lower($6))
          AND ($9::text IS NULL OR o.city ILIKE '%'||$9||'%' OR ip.country ILIKE '%'||$9||'%')
        ORDER BY p.next_intake_on NULLS LAST, p.title, p.id LIMIT $7 OFFSET $8`,
      [i.q ?? null, f.ids, i.kind ?? null, i.mode ?? null, i.country ?? null, i.city ?? null, i.limit, i.offset, i.region ?? null, f.general, f.countries]);
    const r = await ratingsFor('programme', rows.map((x) => x.id));
    return rows.map((x) => ({ ...x, rating: r.get(x.id)?.rating ?? null, reviews: r.get(x.id)?.reviews ?? 0 }));
  },
});

cap({
  name: 'get_programme', method: 'GET', path: '/programmes/:id', tag: TAG, auth: 'public',
  summary: 'One programme at a listed institution: details, sports, brochures and the link to apply on the institution\'s website.',
  input: z.object({ id }),
  async handler(_, i) {
    const p = await one(
      `SELECT p.id, p.title, p.kind, p.mode, p.description, p.duration_months, p.fee_minor, p.currency, p.next_intake_on, p.apply_url, ${PROG_SPORTS} AS sports,
              o.id AS organisation_id, o.name AS institution, o.kind AS institution_kind, o.city, ip.country, ip.website
         FROM programmes p JOIN organisations o ON o.id=p.organisation_id JOIN institution_profiles ip ON ip.organisation_id=o.id
        WHERE p.id=$1 AND p.status='active' AND ${LISTED}`, [i.id]);
    if (!p) throw notFound('Programme');
    const rp = await ratingsFor('programme', [p.id]);
    return { ...p, rating: rp.get(p.id)?.rating ?? null, reviews: rp.get(p.id)?.reviews ?? 0, brochures: await many("SELECT id, title, url FROM brochures WHERE status='active' AND (programme_id=$1 OR (programme_id IS NULL AND organisation_id=$2)) ORDER BY created_at DESC", [p.id, p.organisation_id]) };
  },
});

// ------------------------------------------------------------------ brochures
cap({
  name: 'add_brochure', method: 'POST', path: '/organisations/:id/brochures', tag: TAG, status: 201,
  summary: 'Admissions staff: add a brochure (a link to a document on your own site, https). Attach it to one programme or leave it general. You can share it with an enquirer in the conversation.',
  input: z.object({ id, title: z.string().trim().min(2).max(120), url: https, programme_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, ADMISSIONS, { write: true, c });
    if (i.programme_id && !(await c.query('SELECT 1 FROM programmes WHERE id=$1 AND organisation_id=$2', [i.programme_id, i.id])).rowCount) throw notFound('Programme');
    return (await c.query('INSERT INTO brochures(organisation_id, programme_id, title, url, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.id, i.programme_id ?? null, i.title, i.url, user.id])).rows[0];
  }),
});

cap({
  name: 'update_brochure', method: 'PATCH', path: '/brochures/:id', tag: TAG,
  summary: 'Admissions staff: rename a brochure, change its link, or archive it (status archived). Archived brochures stay visible in old conversations.',
  input: z.object({ id, title: z.string().trim().min(2).max(120).optional(), url: https.optional(), status: z.enum(['active', 'archived']).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM brochures WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Brochure');
    await orgFor(user, cur.organisation_id, ADMISSIONS, { write: true, c });
    if (i.title === undefined && i.url === undefined && i.status === undefined) throw badRequest('Nothing to update');
    return (await c.query('UPDATE brochures SET title=coalesce($2,title), url=coalesce($3,url), status=coalesce($4,status) WHERE id=$1 RETURNING *', [i.id, i.title ?? null, i.url ?? null, i.status ?? null])).rows[0];
  }),
});

cap({
  name: 'list_brochures', method: 'GET', path: '/organisations/:id/brochures', tag: TAG,
  summary: 'Admissions staff: your brochures, newest first, with the programme each belongs to.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ADMISSIONS);
    return many('SELECT b.*, p.title AS programme_title FROM brochures b LEFT JOIN programmes p ON p.id=b.programme_id WHERE b.organisation_id=$1 ORDER BY (b.status=\'active\') DESC, b.created_at DESC LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
  },
});
