// Academy curriculum licensing & content marketplace (#804): the capability surface (REST + OpenAPI + MCP from one definition each).
// Rules live in src/academy-content.js. Publisher side needs the academy's `curriculum` permission; buyer side needs an owner/admin of the buying
// organisation; readers need an assigned seat. Everything is read live (revocation is immediate) and non-eligible callers get 404, never 403.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { opsAccess, sessionFor } from '../academy-ops.js';
import { openSession, savePlan } from './coaching-journal.js';
import { CASE_KINDS, ELIGIBILITY, ITEM_KINDS, LICENCE_ACTIONS, REASONS, activateLicence, buyerAccess, endAccess, entitlement, logLicence, orgCountry, publisherAccess, resolveReference, seatsUsed, stageNow, termEnd, whyNotEligible, ymd, planBlocks } from '../academy-content.js';
import { territoryWithin, terr } from '../media-rights.js';

const TAG = 'Academy content licensing';
const country = z.string().regex(/^[A-Z]{2}$/);
const territory = { territory_mode: z.enum(['worldwide', 'include', 'exclude']).default('worldwide'), countries: z.array(country).max(250).default([]) };
const share = z.object({ name: z.string().min(2).max(120), kind: z.enum(['academy', 'author', 'partner']), user_id: id.optional(), organisation_id: id.optional(), bp: z.number().int().min(1).max(10000) });
const person = z.object({ name: z.string().min(2).max(120), role: z.string().max(80).optional(), user_id: id.optional() });
const attribution = z.object({ title: z.string().min(2).max(160), owner: z.string().min(2).max(160), licence: z.string().max(160).optional() });
const packFields = {
  title: z.string().min(2).max(140), summary: z.string().max(1000).optional(), sport: z.string().min(2).max(40), level_key: z.string().max(40).optional(),
  age_min: z.number().int().min(3).max(99).optional(), age_max: z.number().int().min(3).max(99).optional(), languages: z.array(z.string().min(2).max(10)).max(20).default([]),
  methodology_id: id.optional(), eligibility: z.enum(ELIGIBILITY).default('affiliated'), ...territory, max_seats: z.number().int().min(1).max(100000).optional(),
  offline_allowed: z.boolean().default(false), offline_max_days: z.number().int().min(1).max(90).default(14), price_minor: z.number().int().min(0).default(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'), term_months: z.number().int().min(1).max(60).default(12), grace_days: z.number().int().min(0).max(90).default(14),
  revenue_share: z.array(share).max(12).default([]), authors: z.array(person).max(20).default([]), attributions: z.array(attribution).max(40).default([]),
};
const itemSchema = z.object({
  kind: z.enum(ITEM_KINDS), ref_id: id.optional(), ref_version: z.number().int().min(1).optional(), ref_key: z.string().max(80).optional(), title: z.string().min(2).max(160),
  body: z.object({ blocks: z.array(z.object({ type: z.enum(['heading', 'text', 'checklist', 'tip']), text: z.string().min(1).max(4000) })).max(60).optional(), sources: z.array(z.object({ title: z.string().max(200), url: z.string().url().optional(), evidence: z.enum(['peer_reviewed', 'consensus', 'practitioner', 'academy_internal']).optional() })).max(20).optional() }).default({}),
  external_url: z.string().url().startsWith('https://').optional(), youth_footage: z.boolean().default(false), required: z.boolean().default(true), minutes: z.number().int().min(1).max(1440).optional(),
});

const checkShares = (sh) => { if (sh.reduce((n, x) => n + x.bp, 0) > 10000) throw badRequest('Revenue shares add up to more than 100%'); };
const checkAges = (p) => { if (p.age_min != null && p.age_max != null && p.age_min > p.age_max) throw badRequest('Minimum age is above the maximum age'); if (p.territory_mode !== 'worldwide' && !p.countries.length) throw badRequest('Choose at least one country for this territory'); };

async function packOf(c, packId, lock = false) {
  const p = (await c.query(`SELECT * FROM academy_content_packs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [packId])).rows[0];
  if (!p) throw notFound('Pack');
  return p;
}
/** The publisher's own pack: 404 for anyone without curriculum access to the owning academy. */
async function ownPack(c, user, packId, { write = false, lock = false } = {}) {
  const p = await packOf(c, packId, lock);
  try { await publisherAccess(user, p.organisation_id, { write, c }); } catch (e) { if (e.status === 403 || e.status === 404) throw notFound('Pack'); throw e; }
  return p;
}
async function licenceSides(c, user, licenceId, { write = false } = {}) {
  const l = (await c.query('SELECT l.*, p.organisation_id AS publisher_org, p.title AS pack_title, p.currency AS pack_currency FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id WHERE l.id=$1', [licenceId])).rows[0];
  if (!l) throw notFound('Licence');
  let side = null;
  try { await publisherAccess(user, l.publisher_org, { write, c }); side = 'publisher'; } catch { /* not the publisher */ }
  if (!side) { try { await buyerAccess(user, l.licensee_org_id, { write, c }); side = 'licensee'; } catch { /* not the buyer */ } }
  if (!side) throw notFound('Licence');
  return { l, side };
}
const admins = async (c, orgId) => (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [orgId])).rows.map((r) => r.user_id);
const tell = async (c, orgId, kind, title, body, data, dedupe) => { for (const u of await admins(c, orgId)) await notify(c, u, { kind, title, body, data, dedupe_key: `${dedupe}:${u}` }); };

async function draftOf(c, p, userId) {
  let v = (await c.query("SELECT * FROM academy_content_pack_versions WHERE pack_id=$1 AND status='draft'", [p.id])).rows[0];
  if (v) return v;
  const last = (await c.query('SELECT * FROM academy_content_pack_versions WHERE pack_id=$1 ORDER BY version DESC LIMIT 1', [p.id])).rows[0];
  v = (await c.query('INSERT INTO academy_content_pack_versions(pack_id, version, objectives, assessment, cpd_hours, prerequisites, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [p.id, (last?.version ?? 0) + 1, JSON.stringify(last?.objectives ?? []), JSON.stringify(last?.assessment ?? {}), last?.cpd_hours ?? 0, JSON.stringify(last?.prerequisites ?? []), userId])).rows[0];
  if (last) await c.query(`INSERT INTO academy_content_pack_items(version_id, position, kind, ref_id, ref_version, ref_key, title, body, external_url, youth_footage, required, minutes)
    SELECT $1, position, kind, ref_id, ref_version, ref_key, title, body, external_url, youth_footage, required, minutes FROM academy_content_pack_items WHERE version_id=$2`, [v.id, last.id]);
  return v;
}
const itemsOf = async (c, versionId, bodies) => (await c.query(`SELECT id, position, kind, ref_id, ref_version, ref_key, title, ${bodies ? 'body, external_url,' : ''} youth_footage, required, minutes,
  EXISTS (SELECT 1 FROM academy_content_takedowns t WHERE t.item_id=i.id AND t.lifted_at IS NULL) AS withdrawn FROM academy_content_pack_items i WHERE version_id=$1 ORDER BY position`, [versionId])).rows;

/** An item must point at content its publisher owns and has approved: a published curriculum version or a methodology version. */
async function checkItem(c, orgId, it) {
  if (it.kind === 'curriculum') {
    const r = (await c.query("SELECT 1 FROM academy_curriculum_versions v JOIN academy_curricula cu ON cu.id=v.curriculum_id WHERE v.id=$1 AND cu.organisation_id=$2 AND v.status IN ('published','superseded')", [it.ref_id, orgId])).rowCount;
    if (!r) throw badRequest(`“${it.title}” must point at a published curriculum version of your academy`);
  } else if (it.kind === 'methodology' || it.kind === 'drill') {
    if (!it.ref_id || !it.ref_version) throw badRequest(`“${it.title}” needs a methodology and version`);
    const r = (await c.query("SELECT mv.drills FROM academy_methodology_versions mv JOIN academy_methodologies m ON m.id=mv.methodology_id WHERE m.id=$1 AND mv.version=$2 AND m.organisation_id=$3", [it.ref_id, it.ref_version, orgId])).rows[0];
    if (!r) throw badRequest(`“${it.title}” must point at a methodology version of your academy`);
    if (it.kind === 'drill' && !(r.drills ?? []).some((d) => d.key === it.ref_key)) throw badRequest(`“${it.title}” is not a drill in that methodology version`);
  } else if (it.kind === 'module') {
    if (!(it.body?.blocks?.length)) throw badRequest(`“${it.title}” needs at least one content block`);
  } else if (!it.external_url) throw badRequest(`“${it.title}” needs an https link`);
}

// ================================================================================================================== publisher: packs
cap({
  name: 'list_content_packs', method: 'GET', path: '/organisations/:id/academy/content/packs', tag: TAG,
  summary: 'The academy’s own licensable packs with their version, licences, seats and revenue (curriculum permission).',
  input: z.object({ id, status: z.enum(['draft', 'published', 'retired']).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await publisherAccess(user, i.id, { c });
      return (await c.query(`SELECT p.*, (SELECT count(*)::int FROM academy_content_licences l WHERE l.pack_id=p.id AND l.stage IN ('active','suspended')) AS live_licences,
          (SELECT coalesce(sum(l.seats),0)::int FROM academy_content_licences l WHERE l.pack_id=p.id AND l.stage='active') AS licensed_seats,
          (SELECT count(*)::int FROM academy_content_pack_items it JOIN academy_content_pack_versions v ON v.id=it.version_id WHERE v.pack_id=p.id AND v.version=GREATEST(p.current_version,1)) AS items,
          (SELECT round(avg(r.stars)::numeric,1) FROM academy_content_ratings r JOIN academy_content_licences l ON l.id=r.licence_id WHERE l.pack_id=p.id) AS rating
        FROM academy_content_packs p WHERE p.organisation_id=$1 AND ($2::text IS NULL OR p.status=$2) ORDER BY p.updated_at DESC LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset])).rows;
    });
  },
});

cap({
  name: 'create_content_pack', method: 'POST', path: '/organisations/:id/academy/content/packs', tag: TAG, status: 201,
  summary: 'Start a licensable pack (draft). Items are added with save_content_pack_draft and the pack is released with publish_content_pack.',
  input: z.object({ id, ...packFields }),
  async handler({ user }, i) {
    checkShares(i.revenue_share); checkAges(i);
    return tx(async (c) => {
      const { org } = await publisherAccess(user, i.id, { write: true, c });
      if (i.methodology_id && !(await c.query('SELECT 1 FROM academy_methodologies WHERE id=$1 AND organisation_id=$2', [i.methodology_id, org.id])).rowCount) throw badRequest('That methodology is not part of this academy');
      const { id: _o, ...f } = i;
      const p = (await c.query(`INSERT INTO academy_content_packs(organisation_id, title, summary, sport, level_key, age_min, age_max, languages, methodology_id, eligibility, territory_mode, countries, max_seats, offline_allowed, offline_max_days, price_minor, currency, term_months, grace_days, revenue_share, authors, attributions, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [org.id, f.title, f.summary ?? null, f.sport, f.level_key ?? null, f.age_min ?? null, f.age_max ?? null, f.languages, f.methodology_id ?? null, f.eligibility, f.territory_mode, f.countries, f.max_seats ?? null, f.offline_allowed, f.offline_max_days, f.price_minor, f.currency, f.term_months, f.grace_days, JSON.stringify(f.revenue_share), JSON.stringify(f.authors), JSON.stringify(f.attributions), user.id])).rows[0];
      await draftOf(c, p, user.id);
      await audit(c, user.id, 'create_content_pack', 'academy_content_packs', p.id);
      return p;
    });
  },
});

cap({
  name: 'update_content_pack', method: 'PATCH', path: '/academy/content/packs/:id', tag: TAG,
  summary: 'Change a pack’s details, distribution rules or pricing. Existing licences keep the terms they were sold under.',
  input: z.object({ id, row_version: z.number().int(), ...Object.fromEntries(Object.entries(packFields).map(([k, v]) => [k, v.optional()])) }).partial({ row_version: false }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await ownPack(c, user, i.id, { write: true, lock: true });
      if (p.row_version !== i.row_version) throw conflict('Someone else changed this pack; reload and try again');
      if (p.status === 'retired') throw conflict('A retired pack cannot be changed');
      const merged = { ...p, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && k in packFields)) };
      checkShares(merged.revenue_share); checkAges(merged);
      const cols = Object.keys(packFields).filter((k) => i[k] !== undefined);
      if (!cols.length) return p;
      const json = new Set(['revenue_share', 'authors', 'attributions']);
      const set = cols.map((k, n) => `${k}=$${n + 3}`).join(', ');
      const vals = cols.map((k) => (json.has(k) ? JSON.stringify(i[k]) : i[k]));
      const r = (await c.query(`UPDATE academy_content_packs SET ${set}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`, [p.id, i.row_version, ...vals])).rows[0];
      await audit(c, user.id, 'update_content_pack', 'academy_content_packs', p.id);
      return r;
    });
  },
});

cap({
  name: 'save_content_pack_draft', method: 'POST', path: '/academy/content/packs/:id/draft', tag: TAG,
  summary: 'Replace the draft version’s learning design and item list. Curriculum, methodology and drill items are references to your published content, never copies.',
  input: z.object({
    id, objectives: z.array(z.object({ title: z.string().min(2).max(200), success_criteria: z.string().max(500).optional() })).max(40).default([]),
    assessment: z.object({ kind: z.enum(['none', 'quiz', 'observation', 'portfolio']).default('none'), pass_mark: z.number().int().min(0).max(100).optional() }).default({ kind: 'none' }),
    cpd_hours: z.number().min(0).max(999).default(0), prerequisites: z.array(z.string().min(2).max(200)).max(20).default([]), note: z.string().max(500).optional(),
    items: z.array(itemSchema).max(200),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await ownPack(c, user, i.id, { write: true, lock: true });
      if (p.status === 'retired') throw conflict('A retired pack cannot be changed');
      const v = await draftOf(c, p, user.id);
      for (const it of i.items) await checkItem(c, p.organisation_id, it);
      await c.query('UPDATE academy_content_pack_versions SET objectives=$2, assessment=$3, cpd_hours=$4, prerequisites=$5, note_enc=$6 WHERE id=$1', [v.id, JSON.stringify(i.objectives), JSON.stringify(i.assessment), i.cpd_hours, JSON.stringify(i.prerequisites), i.note ? encrypt(i.note, 'academy_content_pack_versions.note_enc') : null]);
      await c.query('DELETE FROM academy_content_pack_items WHERE version_id=$1', [v.id]);   // draft rows only (a trigger forbids touching a published version)
      let n = 0;
      for (const it of i.items) await c.query('INSERT INTO academy_content_pack_items(version_id, position, kind, ref_id, ref_version, ref_key, title, body, external_url, youth_footage, required, minutes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [v.id, n++, it.kind, it.ref_id ?? null, it.ref_version ?? null, it.ref_key ?? null, it.title, JSON.stringify(it.body), it.external_url ?? null, it.youth_footage, it.required, it.minutes ?? null]);
      await c.query('UPDATE academy_content_packs SET updated_at=now() WHERE id=$1', [p.id]);
      await audit(c, user.id, 'save_content_pack_draft', 'academy_content_packs', p.id);
      return { version: v.version, items: await itemsOf(c, v.id, true) };
    });
  },
});

cap({
  name: 'publish_content_pack', method: 'POST', path: '/academy/content/packs/:id/publish', tag: TAG,
  summary: 'Release the draft as the next immutable version. Licensees on the latest version see it straight away; pinned licences keep theirs.',
  input: z.object({ id, note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await ownPack(c, user, i.id, { write: true, lock: true });
      if (p.status === 'retired') throw conflict('A retired pack cannot be published');
      const v = (await c.query("SELECT * FROM academy_content_pack_versions WHERE pack_id=$1 AND status='draft'", [p.id])).rows[0];
      if (!v) throw conflict('There is no draft to publish');
      const items = await itemsOf(c, v.id, true);
      const problems = [];
      if (!items.length) problems.push('Add at least one item');
      if (!(v.objectives ?? []).length) problems.push('State at least one learning objective');
      if (!p.authors.length) problems.push('Credit at least one author');
      if (p.price_minor > 0 && !p.revenue_share.length) problems.push('Set who receives the revenue');
      for (const it of items) { try { await checkItem(c, p.organisation_id, it); } catch (e) { problems.push(e.message); } }
      if (problems.length) throw new AppError(422, 'not_ready', 'This pack is not ready to publish', { problems });
      await c.query("UPDATE academy_content_pack_versions SET status='superseded' WHERE pack_id=$1 AND status='published'", [p.id]);
      await c.query("UPDATE academy_content_pack_versions SET status='published', published_by=$2, published_at=now() WHERE id=$1", [v.id, user.id]);
      const r = (await c.query("UPDATE academy_content_packs SET status='published', current_version=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [p.id, v.version])).rows[0];
      await audit(c, user.id, 'publish_content_pack', 'academy_content_packs', p.id);
      for (const l of (await c.query("SELECT licensee_org_id, id FROM academy_content_licences WHERE pack_id=$1 AND stage='active' AND pinned_version IS NULL", [p.id])).rows) await tell(c, l.licensee_org_id, 'content_pack_updated', 'Licensed pack updated', `“${p.title}” has a new version (v${v.version}).`, { licence_id: l.id }, `content-ver:${p.id}:${v.version}`);
      return r;
    });
  },
});

cap({
  name: 'retire_content_pack', method: 'POST', path: '/academy/content/packs/:id/retire', tag: TAG,
  summary: 'Stop selling a pack. Running licences continue to their end date; nothing is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await ownPack(c, user, i.id, { write: true, lock: true });
      const r = (await c.query("UPDATE academy_content_packs SET status='retired', retired_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [p.id])).rows[0];
      await c.query("UPDATE academy_content_licences SET stage='withdrawn', updated_at=now() WHERE pack_id=$1 AND stage IN ('requested','proposed','awaiting_payment')", [p.id]);
      await audit(c, user.id, 'retire_content_pack', 'academy_content_packs', p.id);
      return r;
    });
  },
});

cap({
  name: 'get_content_pack', method: 'GET', path: '/academy/content/packs/:id', tag: TAG,
  summary: 'A pack. The publisher sees every version and item body; a prospective buyer (org_id) sees the syllabus, rights and price but not the locked content.',
  input: z.object({ id, org_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await packOf(c, i.id);
      let own = false;
      try { await publisherAccess(user, p.organisation_id, { c }); own = true; } catch { /* a buyer */ }
      if (own) {
        const versions = (await c.query('SELECT id, version, status, objectives, assessment, cpd_hours, prerequisites, published_at FROM academy_content_pack_versions WHERE pack_id=$1 ORDER BY version DESC', [p.id])).rows;
        for (const v of versions) v.items = await itemsOf(c, v.id, true);
        return { ...p, side: 'publisher', versions };
      }
      if (!i.org_id) throw notFound('Pack');
      await buyerAccess(user, i.org_id, { c });
      if (p.status !== 'published') throw notFound('Pack');
      const mine = (await c.query("SELECT id, stage, seats, effective_to, pinned_version FROM academy_content_licences WHERE pack_id=$1 AND licensee_org_id=$2 AND stage NOT IN ('declined','withdrawn','expired','revoked') ORDER BY created_at DESC LIMIT 1", [p.id, i.org_id])).rows[0] ?? null;
      const v = (await c.query("SELECT id, version, objectives, assessment, cpd_hours, prerequisites FROM academy_content_pack_versions WHERE pack_id=$1 AND version=$2", [p.id, p.current_version])).rows[0];
      const items = v ? (await itemsOf(c, v.id, false)).map(({ ref_id, ref_version, ref_key, ...x }) => ({ ...x, locked: !(mine && ['active', 'suspended'].includes(mine.stage)) })) : [];
      const why = await whyNotEligible(c, p, i.org_id);
      const pub = (await c.query('SELECT id, name FROM organisations WHERE id=$1', [p.organisation_id])).rows[0];
      const { revenue_share, ...open } = p;
      return { ...open, side: 'buyer', publisher: pub, version: v ? { version: v.version, objectives: v.objectives, assessment: v.assessment, cpd_hours: v.cpd_hours, prerequisites: v.prerequisites } : null, items, my_licence: mine, eligible: !why, ineligible_reason: why };
    });
  },
});

cap({
  name: 'list_content_sources', method: 'GET', path: '/organisations/:id/academy/content/sources', tag: TAG,
  summary: 'What the academy may put in a pack: its published curriculum versions, methodology versions and their approved drills (the source of the pickers in the pack builder).',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await publisherAccess(user, i.id, { c });
      const curricula = (await c.query(`SELECT v.id, v.version, cu.title, cu.level_key, cu.age_min, cu.age_max, m.sport, v.published_at, jsonb_array_length(v.objectives)::int AS objectives
        FROM academy_curriculum_versions v JOIN academy_curricula cu ON cu.id=v.curriculum_id JOIN academy_methodologies m ON m.id=cu.methodology_id
        WHERE cu.organisation_id=$1 AND v.status IN ('published','superseded') ORDER BY m.sport, cu.title, v.version DESC`, [i.id])).rows;
      const methodologies = (await c.query(`SELECT m.id, m.title, m.sport, mv.version, jsonb_array_length(mv.competencies)::int AS competencies, mv.drills
        FROM academy_methodologies m JOIN academy_methodology_versions mv ON mv.methodology_id=m.id WHERE m.organisation_id=$1 AND m.status <> 'archived' ORDER BY m.sport, m.title, mv.version DESC`, [i.id])).rows;
      return { curricula, methodologies: methodologies.map(({ drills, ...m }) => ({ ...m, drills: (drills ?? []).map((d) => ({ key: d.key, title: d.title, duration_min: d.duration_min ?? null })) })) };
    });
  },
});

// ================================================================================================================== marketplace (buyer)
cap({
  name: 'browse_content_marketplace', method: 'GET', path: '/academy/content/marketplace', tag: TAG,
  summary: 'Published packs a buying organisation can see, with whether it is eligible and what it already holds. Listing never depends on price or promotion.',
  input: z.object({ org_id: id, sport: z.string().max(40).optional(), q: z.string().max(80).optional(), language: z.string().max(10).optional(), age: z.coerce.number().int().min(3).max(99).optional(), max_price_minor: z.coerce.number().int().min(0).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await buyerAccess(user, i.org_id, { c });
      const rows = (await c.query(`SELECT p.id, p.title, p.summary, p.sport, p.level_key, p.age_min, p.age_max, p.languages, p.eligibility, p.territory_mode, p.countries, p.offline_allowed, p.price_minor, p.currency, p.term_months, p.max_seats, p.authors, p.current_version, p.organisation_id, o.name AS publisher_name,
          (SELECT cpd_hours FROM academy_content_pack_versions v WHERE v.pack_id=p.id AND v.version=p.current_version) AS cpd_hours,
          (SELECT count(*)::int FROM academy_content_pack_items it JOIN academy_content_pack_versions v ON v.id=it.version_id WHERE v.pack_id=p.id AND v.version=p.current_version) AS items,
          (SELECT round(avg(r.stars)::numeric,1) FROM academy_content_ratings r JOIN academy_content_licences l ON l.id=r.licence_id WHERE l.pack_id=p.id) AS rating,
          (SELECT stage FROM academy_content_licences l WHERE l.pack_id=p.id AND l.licensee_org_id=$1 AND l.stage NOT IN ('declined','withdrawn','expired','revoked') ORDER BY created_at DESC LIMIT 1) AS my_stage
        FROM academy_content_packs p JOIN organisations o ON o.id=p.organisation_id
        WHERE p.status='published' AND p.organisation_id <> $1 AND ($2::text IS NULL OR p.sport=$2) AND ($3::text IS NULL OR p.title ILIKE '%'||$3||'%' OR p.summary ILIKE '%'||$3||'%')
          AND ($4::text IS NULL OR $4 = ANY(p.languages)) AND ($5::int IS NULL OR ((p.age_min IS NULL OR p.age_min <= $5) AND (p.age_max IS NULL OR p.age_max >= $5))) AND ($6::bigint IS NULL OR p.price_minor <= $6)
          AND (p.eligibility <> 'invited' OR EXISTS (SELECT 1 FROM academy_content_licences l WHERE l.pack_id=p.id AND l.licensee_org_id=$1))
        ORDER BY p.title, p.id LIMIT $7 OFFSET $8`, [i.org_id, i.sport ?? null, i.q ?? null, i.language ?? null, i.age ?? null, i.max_price_minor ?? null, i.limit, i.offset])).rows;
      for (const r of rows) { r.ineligible_reason = await whyNotEligible(c, { ...r, status: 'published' }, i.org_id); r.eligible = !r.ineligible_reason; }
      return rows;
    });
  },
});

// ================================================================================================================== licences
const licenceView = `l.id, l.pack_id, l.licensee_org_id, l.stage, l.seats, l.effective_from, l.effective_to, l.pinned_version, l.territory_mode, l.countries, l.offline_allowed, l.offline_max_days, l.price_minor, l.currency, l.grace_days, l.auto_renew, l.renewal_of, l.reason_code, l.paid_at, l.revoked_at, l.suspended_at, l.row_version, l.created_at, l.updated_at,
  p.title AS pack_title, p.sport, p.organisation_id AS publisher_org, po.name AS publisher_name, lo.name AS licensee_name,
  (SELECT count(*)::int FROM academy_content_seats s WHERE s.licence_id=l.id AND s.status='active') AS seats_used`;
const withState = (r) => ({ ...r, state: stageNow(r) });

cap({
  name: 'request_content_licence', method: 'POST', path: '/academy/content/packs/:id/request', tag: TAG, status: 201,
  summary: 'A buying organisation asks the publisher for a licence (owner/admin of the buyer). Eligibility and territory are checked now; the publisher sets the terms.',
  input: z.object({ id, org_id: id, seats: z.number().int().min(1).max(100000), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await buyerAccess(user, i.org_id, { write: true, c });
      const p = await packOf(c, i.id);
      if (p.eligibility === 'invited') throw notFound('Pack');
      const why = await whyNotEligible(c, p, i.org_id);
      if (why) throw new AppError(409, 'not_eligible', why);
      if (p.max_seats && i.seats > p.max_seats) throw badRequest(`This pack is licensed for at most ${p.max_seats} seats at a time`);
      if ((await c.query("SELECT 1 FROM academy_content_licences WHERE pack_id=$1 AND licensee_org_id=$2 AND stage IN ('requested','proposed','awaiting_payment')", [p.id, i.org_id])).rowCount) throw conflict('You already have an open request or offer for this pack');
      if ((await c.query("SELECT 1 FROM academy_content_licences WHERE pack_id=$1 AND licensee_org_id=$2 AND stage IN ('active','suspended')", [p.id, i.org_id])).rowCount) throw conflict('You already hold a licence; ask the publisher to renew it');
      const l = (await c.query("INSERT INTO academy_content_licences(pack_id, licensee_org_id, stage, seats, territory_mode, countries, offline_allowed, offline_max_days, price_minor, currency, grace_days, requested_by, note_enc, created_by) VALUES ($1,$2,'requested',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11) RETURNING *",
        [p.id, i.org_id, i.seats, p.territory_mode, p.countries, p.offline_allowed, p.offline_max_days, p.price_minor * i.seats, p.currency, p.grace_days, user.id, i.note ? encrypt(i.note, 'academy_content_licences.note_enc') : null])).rows[0];
      await logLicence(c, l.id, user.id, 'requested', { seats: i.seats });
      await audit(c, user.id, 'request_content_licence', 'academy_content_licences', l.id);
      await tell(c, p.organisation_id, 'content_licence_requested', 'Content licence requested', `A licence for “${p.title}” was requested (${i.seats} seats).`, { licence_id: l.id }, `content-req:${l.id}`);
      return withState(l);
    });
  },
});

cap({
  name: 'propose_content_licence', method: 'POST', path: '/academy/content/packs/:id/licences', tag: TAG, status: 201,
  summary: 'The publisher sets the terms of a licence for a buying organisation (answering a request, an invitation, or a renewal). Terms may narrow the pack’s territory and offline rules, never widen them.',
  input: z.object({
    id, licensee_org_id: id, seats: z.number().int().min(1).max(100000), effective_from: z.string().date().optional(), term_months: z.number().int().min(1).max(60).optional(),
    price_minor: z.number().int().min(0).optional(), pinned_version: z.number().int().min(1).optional(), ...Object.fromEntries(Object.entries(territory).map(([k, v]) => [k, v.optional()])),
    offline_allowed: z.boolean().optional(), grace_days: z.number().int().min(0).max(90).optional(), auto_renew: z.boolean().default(false), renewal_of: id.optional(), note: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await ownPack(c, user, i.id, { write: true, lock: true });
      if (p.status !== 'published') throw conflict('Publish the pack before licensing it');
      if (p.eligibility !== 'invited') { const why = await whyNotEligible(c, p, i.licensee_org_id); if (why) throw new AppError(409, 'not_eligible', why); }
      else if (!(await c.query("SELECT 1 FROM organisations WHERE id=$1 AND status='active'", [i.licensee_org_id])).rowCount) throw notFound('Organisation');
      if (i.licensee_org_id === p.organisation_id) throw badRequest('Use the pack in your own academy directly; it does not need a licence');
      if (p.max_seats && i.seats > p.max_seats) throw badRequest(`This pack is licensed for at most ${p.max_seats} seats at a time`);
      const mode = i.territory_mode ?? p.territory_mode, countries = i.countries ?? p.countries;
      if (mode !== 'worldwide' && !countries.length) throw badRequest('Choose at least one country');
      if (!territoryWithin({ mode, countries }, terr(p))) throw badRequest('The licence territory cannot be wider than the pack’s');
      if (i.offline_allowed && !p.offline_allowed) throw badRequest('Offline access is not enabled on this pack');
      if (i.pinned_version && !(await c.query("SELECT 1 FROM academy_content_pack_versions WHERE pack_id=$1 AND version=$2 AND status IN ('published','superseded')", [p.id, i.pinned_version])).rowCount) throw badRequest('That version is not published');
      const from = i.effective_from ?? new Date().toISOString().slice(0, 10), months = i.term_months ?? p.term_months;
      const price = i.price_minor ?? p.price_minor * i.seats;
      let renewalOf = null;
      if (i.renewal_of) {
        renewalOf = (await c.query("SELECT id FROM academy_content_licences WHERE id=$1 AND pack_id=$2 AND licensee_org_id=$3 AND stage IN ('active','suspended','expired')", [i.renewal_of, p.id, i.licensee_org_id])).rows[0]?.id;
        if (!renewalOf) throw badRequest('That licence cannot be renewed');
      }
      const pending = (await c.query("SELECT * FROM academy_content_licences WHERE pack_id=$1 AND licensee_org_id=$2 AND stage IN ('requested','proposed','awaiting_payment') FOR UPDATE", [p.id, i.licensee_org_id])).rows[0];
      if (!pending && !renewalOf && (await c.query("SELECT 1 FROM academy_content_licences WHERE pack_id=$1 AND licensee_org_id=$2 AND stage IN ('active','suspended')", [p.id, i.licensee_org_id])).rowCount) throw conflict('This organisation already holds a licence; renew it instead');
      const args = [i.seats, from, termEnd(from, months), i.pinned_version ?? null, mode, countries, i.offline_allowed ?? p.offline_allowed, p.offline_max_days, price, p.currency, i.grace_days ?? p.grace_days, i.auto_renew, user.id,
        i.note ? encrypt(i.note, 'academy_content_licences.note_enc') : pending?.note_enc ?? null];
      let l;
      if (pending) {
        if (pending.stage === 'awaiting_payment') throw conflict('The buyer has accepted and is paying; withdraw the offer first to change the terms');
        l = (await c.query("UPDATE academy_content_licences SET stage='proposed', seats=$2, effective_from=$3, effective_to=$4, pinned_version=$5, territory_mode=$6, countries=$7, offline_allowed=$8, offline_max_days=$9, price_minor=$10, currency=$11, grace_days=$12, auto_renew=$13, decided_by=$14, decided_at=now(), note_enc=$15, renewal_of=coalesce($16, renewal_of), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [pending.id, ...args, renewalOf])).rows[0];
      } else {
        l = (await c.query("INSERT INTO academy_content_licences(pack_id, licensee_org_id, stage, seats, effective_from, effective_to, pinned_version, territory_mode, countries, offline_allowed, offline_max_days, price_minor, currency, grace_days, auto_renew, decided_by, decided_at, note_enc, renewal_of, created_by) VALUES ($1,$2,'proposed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17,$15) RETURNING *",
          [p.id, i.licensee_org_id, ...args, renewalOf])).rows[0];
      }
      await logLicence(c, l.id, user.id, renewalOf ? 'renewal_proposed' : 'proposed', { seats: l.seats, price_minor: Number(l.price_minor), term_months: months });
      await audit(c, user.id, 'propose_content_licence', 'academy_content_licences', l.id);
      await tell(c, i.licensee_org_id, 'content_licence_offer', 'Content licence offer', `${p.title}: review and accept the licence terms.`, { licence_id: l.id }, `content-offer:${l.id}:${l.row_version}`);
      return withState(l);
    });
  },
});

cap({
  name: 'respond_content_licence', method: 'POST', path: '/academy/content/licences/:id/respond', tag: TAG,
  summary: 'The buying organisation accepts, declines or withdraws. Accepting a priced licence leaves it awaiting payment (pay with purpose_type content_licence); a free one is active at once.',
  input: z.object({ id, action: z.enum(['accept', 'decline', 'withdraw']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { l, side } = await licenceSides(c, user, i.id, { write: true });
      if (side !== 'licensee') throw notFound('Licence');
      await c.query('SELECT 1 FROM academy_content_licences WHERE id=$1 FOR UPDATE', [l.id]);
      const cur = (await c.query('SELECT stage FROM academy_content_licences WHERE id=$1', [l.id])).rows[0].stage;
      if (i.action === 'accept') {
        if (cur !== 'proposed') throw conflict('There is no offer to accept');
        const p = await packOf(c, l.pack_id);
        const why = await whyNotEligible(c, p, l.licensee_org_id);
        if (why) throw new AppError(409, 'not_eligible', why);
        await c.query('UPDATE academy_content_licences SET accepted_by=$2, accepted_at=now() WHERE id=$1', [l.id, user.id]);
        if (Number(l.price_minor) > 0) await c.query("UPDATE academy_content_licences SET stage='awaiting_payment', updated_at=now(), row_version=row_version+1 WHERE id=$1", [l.id]);
        else await activateLicence(c, l.id, user.id);
        await logLicence(c, l.id, user.id, 'accepted', { payable: Number(l.price_minor) > 0 });
        await tell(c, l.publisher_org, 'content_licence_accepted', 'Licence terms accepted', `${l.licensee_name ?? 'The buyer'} accepted the licence for “${l.pack_title}”.`, { licence_id: l.id }, `content-acc:${l.id}`);
      } else if (i.action === 'decline') {
        if (cur !== 'proposed') throw conflict('There is no offer to decline');
        await c.query("UPDATE academy_content_licences SET stage='declined', updated_at=now(), row_version=row_version+1 WHERE id=$1", [l.id]);
        await logLicence(c, l.id, user.id, 'declined');
      } else {
        if (!['requested', 'proposed', 'awaiting_payment'].includes(cur)) throw conflict('Only a pending request or offer can be withdrawn');
        await c.query("UPDATE academy_content_licences SET stage='withdrawn', updated_at=now(), row_version=row_version+1 WHERE id=$1", [l.id]);
        await logLicence(c, l.id, user.id, 'withdrawn');
      }
      await audit(c, user.id, `${i.action}_content_licence`, 'academy_content_licences', l.id);
      return withState((await c.query(`SELECT ${licenceView} FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id JOIN organisations po ON po.id=p.organisation_id JOIN organisations lo ON lo.id=l.licensee_org_id WHERE l.id=$1`, [l.id])).rows[0]);
    });
  },
});

cap({
  name: 'manage_content_licence', method: 'POST', path: '/academy/content/licences/:id/manage', tag: TAG,
  summary: 'The publisher suspends, reinstates or revokes a licence, or withdraws a pending offer, with a reason. Access is lost on the next request; the buyer’s own academy data is untouched.',
  input: z.object({ id, action: z.enum([...LICENCE_ACTIONS, 'withdraw_offer']), reason_code: z.enum(REASONS).optional(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { l, side } = await licenceSides(c, user, i.id, { write: true });
      if (side !== 'publisher') throw notFound('Licence');
      if (i.action !== 'reinstate' && i.action !== 'withdraw_offer' && !i.reason_code) throw badRequest('Choose a reason');
      const cur = (await c.query('SELECT stage FROM academy_content_licences WHERE id=$1 FOR UPDATE', [l.id])).rows[0].stage;
      const note = i.note ? encrypt(i.note, 'academy_content_licences.note_enc') : null;
      if (i.action === 'suspend') {
        if (cur !== 'active') throw conflict('Only an active licence can be suspended');
        await c.query("UPDATE academy_content_licences SET stage='suspended', suspended_at=now(), reason_code=$2, note_enc=coalesce($3,note_enc), updated_at=now(), row_version=row_version+1 WHERE id=$1", [l.id, i.reason_code, note]);
        await c.query('UPDATE academy_content_offline_grants SET revoked_at=now() WHERE licence_id=$1 AND revoked_at IS NULL', [l.id]);
      } else if (i.action === 'reinstate') {
        if (cur !== 'suspended') throw conflict('Only a suspended licence can be reinstated');
        await c.query("UPDATE academy_content_licences SET stage='active', suspended_at=NULL, reason_code=NULL, updated_at=now(), row_version=row_version+1 WHERE id=$1", [l.id]);
      } else if (i.action === 'revoke') {
        if (!['active', 'suspended'].includes(cur)) throw conflict('Only a running licence can be revoked');
        await c.query("UPDATE academy_content_licences SET stage='revoked', revoked_at=now(), reason_code=$2, note_enc=coalesce($3,note_enc), updated_at=now(), row_version=row_version+1 WHERE id=$1", [l.id, i.reason_code, note]);
        await endAccess(c, l.id);   // seats stay on the record (history); the licence stage alone blocks reading
      } else {
        if (!['requested', 'proposed', 'awaiting_payment'].includes(cur)) throw conflict('There is no pending offer to withdraw');
        await c.query("UPDATE academy_content_licences SET stage='withdrawn', updated_at=now(), row_version=row_version+1 WHERE id=$1", [l.id]);
      }
      await logLicence(c, l.id, user.id, i.action, { reason_code: i.reason_code ?? null });
      await audit(c, user.id, `${i.action}_content_licence`, 'academy_content_licences', l.id);
      if (i.action !== 'withdraw_offer') await tell(c, l.licensee_org_id, 'content_licence_changed', `Content licence ${i.action === 'reinstate' ? 'reinstated' : i.action === 'suspend' ? 'suspended' : 'revoked'}`, `${l.pack_title}: your access has changed. Open Academy > Content.`, { licence_id: l.id }, `content-chg:${l.id}:${i.action}:${Date.now()}`);
      return withState((await c.query(`SELECT ${licenceView} FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id JOIN organisations po ON po.id=p.organisation_id JOIN organisations lo ON lo.id=l.licensee_org_id WHERE l.id=$1`, [l.id])).rows[0]);
    });
  },
});

cap({
  name: 'list_content_licences', method: 'GET', path: '/organisations/:id/academy/content/licences', tag: TAG,
  summary: 'Licences an academy has granted (side=publisher, curriculum permission) or holds (side=licensee, owner/admin), newest first.',
  input: z.object({ id, side: z.enum(['publisher', 'licensee']), stage: z.string().max(30).optional(), pack_id: id.optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      if (i.side === 'publisher') await publisherAccess(user, i.id, { c }); else await buyerAccess(user, i.id, { c });
      const col = i.side === 'publisher' ? 'p.organisation_id' : 'l.licensee_org_id';
      const rows = (await c.query(`SELECT ${licenceView} FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id JOIN organisations po ON po.id=p.organisation_id JOIN organisations lo ON lo.id=l.licensee_org_id
        WHERE ${col}=$1 AND ($2::text IS NULL OR l.stage=$2) AND ($3::uuid IS NULL OR l.pack_id=$3) ORDER BY l.updated_at DESC LIMIT $4 OFFSET $5`, [i.id, i.stage ?? null, i.pack_id ?? null, i.limit, i.offset])).rows;
      return rows.map(withState);
    });
  },
});

cap({
  name: 'get_content_licence', method: 'GET', path: '/academy/content/licences/:id', tag: TAG,
  summary: 'One licence with its terms, seats, history and usage (publisher or licensee administrator).',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { l, side } = await licenceSides(c, user, i.id);
      const row = (await c.query(`SELECT ${licenceView}, l.note_enc, l.accepted_by, l.accepted_at FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id JOIN organisations po ON po.id=p.organisation_id JOIN organisations lo ON lo.id=l.licensee_org_id WHERE l.id=$1`, [l.id])).rows[0];
      const note = row.note_enc ? decrypt(row.note_enc, 'academy_content_licences.note_enc') : null;
      if (note) await audit(c, user.id, 'read_content_licence_note', 'academy_content_licences', l.id);
      delete row.note_enc;
      const seats = (await c.query("SELECT s.user_id, s.assigned_at, u.display_name, (SELECT count(*)::int FROM academy_content_consumption x WHERE x.licence_id=s.licence_id AND x.user_id=s.user_id AND x.event='opened') AS opens, (SELECT max(at) FROM academy_content_consumption x WHERE x.licence_id=s.licence_id AND x.user_id=s.user_id) AS last_seen FROM academy_content_seats s JOIN users u ON u.id=s.user_id WHERE s.licence_id=$1 AND s.status='active' ORDER BY u.display_name", [l.id])).rows;
      const events = (await c.query('SELECT e.action, e.detail, e.at, u.display_name AS actor FROM academy_content_licence_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.licence_id=$1 ORDER BY e.id DESC LIMIT 100', [l.id])).rows;
      return { ...withState(row), side, note, seat_holders: seats, events };
    });
  },
});

// renewal = propose_content_licence with renewal_of; this shortcut pre-fills the next term from the running licence
cap({
  name: 'renew_content_licence', method: 'POST', path: '/academy/content/licences/:id/renew', tag: TAG, status: 201,
  summary: 'Offer the next term of a licence (publisher). The current licence keeps running until the buyer accepts (and pays); then it ends and the seats move across.',
  input: z.object({ id, term_months: z.number().int().min(1).max(60).optional(), seats: z.number().int().min(1).max(100000).optional(), price_minor: z.number().int().min(0).optional(), auto_renew: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { l, side } = await licenceSides(c, user, i.id, { write: true });
      if (side !== 'publisher') throw notFound('Licence');
      if (!['active', 'suspended', 'expired'].includes(l.stage)) throw conflict('Only a running or expired licence can be renewed');
      const p = await packOf(c, l.pack_id, true);
      if (p.status !== 'published') throw conflict('Publish the pack before renewing');
      if ((await c.query("SELECT 1 FROM academy_content_licences WHERE pack_id=$1 AND licensee_org_id=$2 AND stage IN ('requested','proposed','awaiting_payment')", [p.id, l.licensee_org_id])).rowCount) throw conflict('A renewal or request is already pending for this buyer');
      const seats = i.seats ?? l.seats, months = i.term_months ?? p.term_months;
      const base = l.effective_to ? new Date(`${ymd(l.effective_to)}T12:00:00Z`) : new Date();
      base.setUTCDate(base.getUTCDate() + 1);
      const from = (base < new Date() ? new Date() : base).toISOString().slice(0, 10);
      const r = (await c.query(`INSERT INTO academy_content_licences(pack_id, licensee_org_id, stage, seats, effective_from, effective_to, pinned_version, territory_mode, countries, offline_allowed, offline_max_days, price_minor, currency, grace_days, auto_renew, renewal_of, decided_by, decided_at, created_by)
        VALUES ($1,$2,'proposed',$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$15) RETURNING *`,
        [p.id, l.licensee_org_id, seats, from, termEnd(from, months), l.territory_mode, l.countries, l.offline_allowed && p.offline_allowed, l.offline_max_days, i.price_minor ?? p.price_minor * seats, p.currency, l.grace_days, i.auto_renew ?? l.auto_renew, l.id, user.id])).rows[0];
      await logLicence(c, r.id, user.id, 'renewal_proposed', { of: l.id });
      await logLicence(c, l.id, user.id, 'renewal_offered', { next: r.id });
      await audit(c, user.id, 'renew_content_licence', 'academy_content_licences', r.id);
      await tell(c, l.licensee_org_id, 'content_licence_offer', 'Licence renewal offer', `${l.pack_title}: review the renewal terms.`, { licence_id: r.id }, `content-offer:${r.id}:1`);
      return withState(r);
    });
  },
});

// ================================================================================================================== seats
cap({
  name: 'assign_content_seat', method: 'POST', path: '/academy/content/licences/:id/seats', tag: TAG, status: 201,
  summary: 'Give a coach or staff member of the licensed organisation a seat (owner/admin of the buyer). Limited to the licensed number of seats; young athletes cannot hold one.',
  input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { l, side } = await licenceSides(c, user, i.id, { write: true });
      if (side !== 'licensee') throw notFound('Licence');
      const cur = (await c.query('SELECT stage FROM academy_content_licences WHERE id=$1 FOR UPDATE', [l.id])).rows[0].stage;
      if (!['active'].includes(cur)) throw conflict('Seats can be assigned once the licence is active');
      const m = (await c.query("SELECT u.id, u.display_name, (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS youth FROM organisation_members om JOIN users u ON u.id=om.user_id WHERE om.organisation_id=$1 AND om.user_id=$2 AND om.status='active' AND om.role IN ('owner','admin','coach','staff')", [l.licensee_org_id, i.user_id])).rows[0];
      if (!m) throw badRequest('Only coaches and staff of the licensed organisation can hold a seat');
      if (m.youth) throw forbidden('Young people cannot hold a coach seat');
      if (await seatsUsed(c, l.id) >= l.seats) throw new AppError(409, 'no_seats_left', 'All seats are in use; release one first');
      const s = (await c.query("INSERT INTO academy_content_seats(licence_id, user_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *", [l.id, i.user_id, user.id])).rows[0];
      if (!s) throw conflict('That person already holds a seat');
      await logLicence(c, l.id, user.id, 'seat_assigned', { user_id: i.user_id });
      await audit(c, user.id, 'assign_content_seat', 'academy_content_licences', l.id);
      await notify(c, i.user_id, { kind: 'content_seat', title: 'You have a licensed content seat', body: `${l.pack_title} is now in your library.`, data: { licence_id: l.id }, dedupe_key: `content-seat:${l.id}:${i.user_id}` });
      return { licence_id: l.id, user_id: i.user_id, display_name: m.display_name };
    });
  },
});

cap({
  name: 'release_content_seat', method: 'DELETE', path: '/academy/content/licences/:id/seats/:user_id', tag: TAG,
  summary: 'Release a seat (owner/admin of the buyer). The person’s usage history is kept; their offline copies stop working.',
  input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { l, side } = await licenceSides(c, user, i.id, { write: true });
      if (side !== 'licensee') throw notFound('Licence');
      const r = await c.query("UPDATE academy_content_seats SET status='released', released_at=now() WHERE licence_id=$1 AND user_id=$2 AND status='active'", [l.id, i.user_id]);
      if (!r.rowCount) throw notFound('Seat');
      await c.query('UPDATE academy_content_offline_grants SET revoked_at=now() WHERE licence_id=$1 AND user_id=$2 AND revoked_at IS NULL', [l.id, i.user_id]);
      await logLicence(c, l.id, user.id, 'seat_released', { user_id: i.user_id });
      await audit(c, user.id, 'release_content_seat', 'academy_content_licences', l.id);
      return { released: true };
    });
  },
});

// ================================================================================================================== reading (the coach)
cap({
  name: 'list_my_content_library', method: 'GET', path: '/me/academy/content', tag: TAG,
  summary: 'The licensed packs the caller holds a seat for, with the live state of each licence and the syllabus (no locked bodies).',
  input: z.object({}),
  async handler({ user }) {
    return tx(async (c) => {
      const rows = (await c.query(`SELECT ${licenceView}, p.current_version, p.summary, p.authors,
          (SELECT cpd_hours FROM academy_content_pack_versions v WHERE v.pack_id=p.id AND v.version=coalesce(l.pinned_version,p.current_version)) AS cpd_hours,
          (SELECT count(DISTINCT x.item_id)::int FROM academy_content_consumption x WHERE x.licence_id=l.id AND x.user_id=$1 AND x.event='completed') AS completed,
          (SELECT count(*)::int FROM academy_content_pack_items it JOIN academy_content_pack_versions v ON v.id=it.version_id WHERE v.pack_id=p.id AND v.version=coalesce(l.pinned_version,p.current_version)) AS items
        FROM academy_content_seats s JOIN academy_content_licences l ON l.id=s.licence_id JOIN academy_content_packs p ON p.id=l.pack_id JOIN organisations po ON po.id=p.organisation_id JOIN organisations lo ON lo.id=l.licensee_org_id
        JOIN organisation_members om ON om.organisation_id=l.licensee_org_id AND om.user_id=s.user_id AND om.status='active'
        WHERE s.user_id=$1 AND s.status='active' AND l.stage IN ('active','suspended','expired','revoked') ORDER BY l.updated_at DESC`, [user.id])).rows.map(withState);
      for (const r of rows) {
        const v = (await c.query('SELECT id FROM academy_content_pack_versions WHERE pack_id=$1 AND version=$2', [r.pack_id, r.pinned_version ?? r.current_version])).rows[0];
        r.locked = !['active', 'grace'].includes(r.state);
        r.syllabus = v ? (await itemsOf(c, v.id, false)).map(({ ref_id, ref_version, ref_key, ...x }) => x) : [];
        if (r.locked) r.syllabus = r.syllabus.map((x) => ({ ...x, withdrawn: true }));
      }
      return rows;
    });
  },
});

cap({
  name: 'open_content_item', method: 'GET', path: '/academy/content/licences/:id/items/:item_id', tag: TAG,
  summary: 'Read a licensed item. Entitlement (seat, live licence, window, territory, published version, not withdrawn) is checked now; footage showing young people is stream-only with the reader’s name as a watermark.',
  input: z.object({ id, item_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await entitlement(c, user, i.id, i.item_id);
      const ref = await resolveReference(c, e.item);
      await c.query("INSERT INTO academy_content_consumption(licence_id, item_id, user_id, event) VALUES ($1,$2,$3,'opened')", [i.id, e.item.id, user.id]);
      if (e.item.youth_footage) await audit(c, user.id, 'view_licensed_youth_footage', 'academy_content_pack_items', e.item.id);
      const me = (await c.query('SELECT display_name FROM users WHERE id=$1', [user.id])).rows[0];
      const { ref_id, ...item } = e.item;
      return { item: { ...item, body: e.item.kind === 'module' ? e.item.body : {} }, reference: ref, state: e.state, version: e.version.version, grace: e.state === 'grace', stream_only: !!e.item.youth_footage, watermark: e.item.youth_footage ? `${me.display_name} · licensed to ${e.licence.licensee_org_id.slice(0, 8)}` : null,
        offline_ok: !!e.licence.offline_allowed && !e.item.youth_footage };
    });
  },
});

cap({
  name: 'complete_content_item', method: 'POST', path: '/academy/content/licences/:id/items/:item_id/complete', tag: TAG,
  summary: 'Record that the reader finished an item (telemetry: ids and seconds only).',
  input: z.object({ id, item_id: id, seconds: z.number().int().min(0).max(86400).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await entitlement(c, user, i.id, i.item_id);
      await c.query("INSERT INTO academy_content_consumption(licence_id, item_id, user_id, event, seconds) VALUES ($1,$2,$3,'completed',$4)", [i.id, e.item.id, user.id, i.seconds ?? null]);
      return { recorded: true };
    });
  },
});

cap({
  name: 'use_content_item', method: 'POST', path: '/academy/content/licences/:id/items/:item_id/use', tag: TAG, status: 201,
  summary: 'Link a licensed item to one of the licensee’s own academy sessions (a reference, not a copy). The link stops resolving when the licence ends.',
  input: z.object({ id, item_id: id, session_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await entitlement(c, user, i.id, i.item_id);
      const s = (await c.query('SELECT id, organisation_id FROM academy_sessions WHERE id=$1', [i.session_id])).rows[0];
      if (!s || s.organisation_id !== e.licence.licensee_org_id) throw notFound('Session');
      const a = await opsAccess(user, s.organisation_id, { write: true, c });
      if (!a.has('attendance') && !a.has('schedule')) throw forbidden('You cannot plan sessions in this academy');
      await c.query('INSERT INTO academy_content_uses(licence_id, item_id, user_id, session_id) VALUES ($1,$2,$3,$4) ON CONFLICT (licence_id, item_id, session_id) DO UPDATE SET unlinked_at=NULL, user_id=EXCLUDED.user_id', [i.id, i.item_id, user.id, i.session_id]);
      await audit(c, user.id, 'use_content_item', 'academy_sessions', i.session_id);
      return { linked: true, session_id: i.session_id, item_id: i.item_id };
    });
  },
});

cap({
  name: 'rate_content_licence', method: 'POST', path: '/academy/content/licences/:id/rating', tag: TAG,
  summary: 'A seat holder rates the licensed pack (1–5). One rating per person.',
  input: z.object({ id, stars: z.number().int().min(1).max(5) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await entitlement(c, user, i.id);
      await c.query('INSERT INTO academy_content_ratings(licence_id, user_id, stars) VALUES ($1,$2,$3) ON CONFLICT (licence_id, user_id) DO UPDATE SET stars=EXCLUDED.stars', [i.id, user.id, i.stars]);
      return { rated: true };
    });
  },
});

// ================================================================================================================== offline
cap({
  name: 'grant_content_offline', method: 'POST', path: '/academy/content/licences/:id/offline', tag: TAG, status: 201,
  summary: 'Allow the reader to keep the licensed pack on their device for a limited time (only when the licence permits it). Footage showing young people is never included.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await entitlement(c, user, i.id, null, { offline: false });
      if (!e.licence.offline_allowed) throw new AppError(403, 'offline_not_allowed', 'Offline access is not part of this licence');
      if (e.state !== 'active') throw new AppError(402, 'licence_inactive', 'Offline copies are only available while the licence is active');
      const end = e.licence.effective_to ? new Date(`${ymd(e.licence.effective_to)}T23:59:59Z`) : null;
      let exp = new Date(Date.now() + e.licence.offline_max_days * 86400000);
      if (end && end < exp) exp = end;
      await c.query('UPDATE academy_content_offline_grants SET revoked_at=now() WHERE licence_id=$1 AND user_id=$2 AND revoked_at IS NULL', [i.id, user.id]);
      const g = (await c.query('INSERT INTO academy_content_offline_grants(licence_id, user_id, expires_at) VALUES ($1,$2,$3) RETURNING *', [i.id, user.id, exp])).rows[0];
      const items = (await itemsOf(c, e.version.id, false)).filter((x) => !x.youth_footage && !x.withdrawn);
      await logLicence(c, i.id, user.id, 'offline_granted', { grant_id: g.id });
      return { grant_id: g.id, expires_at: g.expires_at, item_ids: items.map((x) => x.id), excluded_youth_footage: (await itemsOf(c, e.version.id, false)).filter((x) => x.youth_footage).length };
    });
  },
});

cap({
  name: 'check_content_offline', method: 'GET', path: '/academy/content/offline/:id', tag: TAG,
  summary: 'The device asks whether its offline copy is still allowed (grant not expired or revoked, licence live, seat held). Called on every sync; a "no" means delete the local copy.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const g = (await c.query('SELECT * FROM academy_content_offline_grants WHERE id=$1 AND user_id=$2', [i.id, user.id])).rows[0];
      if (!g) throw notFound('Offline copy');
      let reason = null;
      if (g.revoked_at) reason = 'revoked'; else if (new Date(g.expires_at) < new Date()) reason = 'expired';
      else { try { const e = await entitlement(c, user, g.licence_id); if (e.state !== 'active') reason = 'licence_inactive'; } catch (e) { reason = e.code ?? 'licence_inactive'; } }
      if (!reason) await c.query("INSERT INTO academy_content_consumption(licence_id, item_id, user_id, event) SELECT $1, it.id, $2, 'offline_sync' FROM academy_content_pack_items it JOIN academy_content_licences l ON l.id=$1 JOIN academy_content_packs p ON p.id=l.pack_id JOIN academy_content_pack_versions v ON v.id=it.version_id AND v.pack_id=p.id AND v.version=coalesce(l.pinned_version,p.current_version) LIMIT 1", [g.licence_id, user.id]);
      return { valid: !reason, reason, expires_at: g.expires_at };
    });
  },
});

// ================================================================================================================== publisher: oversight
cap({
  name: 'get_content_overview', method: 'GET', path: '/organisations/:id/academy/content/overview', tag: TAG,
  summary: 'Publisher dashboard: live licences, seats, revenue, renewals due, consumption trend and alerts, from the licence and ledger records.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await publisherAccess(user, i.id, { c });
      const q = async (sql, p = [i.id]) => (await c.query(sql, p)).rows;
      const [k] = await q(`SELECT count(*) FILTER (WHERE l.stage='active')::int AS active_licences, count(DISTINCT l.licensee_org_id) FILTER (WHERE l.stage IN ('active','suspended'))::int AS licensees,
          coalesce(sum(l.seats) FILTER (WHERE l.stage='active'),0)::int AS seats_licensed,
          (SELECT count(*)::int FROM academy_content_seats s JOIN academy_content_licences l2 ON l2.id=s.licence_id JOIN academy_content_packs p2 ON p2.id=l2.pack_id WHERE p2.organisation_id=$1 AND s.status='active' AND l2.stage='active') AS seats_used,
          count(*) FILTER (WHERE l.stage IN ('active') AND l.effective_to BETWEEN current_date AND current_date+30)::int AS renewals_30, count(*) FILTER (WHERE l.stage='active' AND l.effective_to BETWEEN current_date AND current_date+90)::int AS renewals_90,
          count(*) FILTER (WHERE l.stage='requested')::int AS requests, count(*) FILTER (WHERE l.stage IN ('suspended'))::int AS suspended, count(*) FILTER (WHERE l.stage='active' AND l.effective_to < current_date)::int AS in_grace
        FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id WHERE p.organisation_id=$1`);
      const revenue = await q("SELECT l.currency, coalesce(sum(l.price_minor) FILTER (WHERE l.paid_at IS NOT NULL OR (l.price_minor=0 AND l.stage='active')),0)::bigint AS total_minor FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id WHERE p.organisation_id=$1 AND l.stage IN ('active','suspended','expired','revoked') GROUP BY l.currency");
      const byPack = await q("SELECT p.id, p.title, count(l.id) FILTER (WHERE l.stage='active')::int AS licences, coalesce(sum(l.price_minor) FILTER (WHERE l.paid_at IS NOT NULL),0)::bigint AS revenue_minor, p.currency FROM academy_content_packs p LEFT JOIN academy_content_licences l ON l.pack_id=p.id WHERE p.organisation_id=$1 AND p.status <> 'draft' GROUP BY p.id ORDER BY revenue_minor DESC, p.title LIMIT 12");
      const trend = await q("SELECT to_char(date_trunc('day', x.at),'YYYY-MM-DD') AS day, count(*) FILTER (WHERE x.event='opened')::int AS opened, count(*) FILTER (WHERE x.event='completed')::int AS completed FROM academy_content_consumption x JOIN academy_content_licences l ON l.id=x.licence_id JOIN academy_content_packs p ON p.id=l.pack_id WHERE p.organisation_id=$1 AND x.at > now() - interval '30 days' GROUP BY 1 ORDER BY 1");
      const [cr] = await q("SELECT CASE WHEN count(*) FILTER (WHERE x.event='opened')=0 THEN NULL ELSE round(100.0*count(*) FILTER (WHERE x.event='completed')/count(*) FILTER (WHERE x.event='opened'))::int END AS completion_pct FROM academy_content_consumption x JOIN academy_content_licences l ON l.id=x.licence_id JOIN academy_content_packs p ON p.id=l.pack_id WHERE p.organisation_id=$1");
      const expiring = await q("SELECT l.id, l.effective_to, l.seats, p.title, lo.name AS licensee_name FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id JOIN organisations lo ON lo.id=l.licensee_org_id WHERE p.organisation_id=$1 AND l.stage='active' AND l.effective_to BETWEEN current_date AND current_date+90 ORDER BY l.effective_to LIMIT 10");
      const [cases] = await q("SELECT count(*) FILTER (WHERE cs.status<>'resolved')::int AS open_cases FROM academy_content_cases cs JOIN academy_content_packs p ON p.id=cs.pack_id WHERE p.organisation_id=$1");
      const [pk] = await q("SELECT count(*) FILTER (WHERE status='published')::int AS published, count(*) FILTER (WHERE status='draft')::int AS drafts FROM academy_content_packs WHERE organisation_id=$1");
      return { kpis: { ...k, ...cr, ...cases, ...pk }, revenue, by_pack: byPack, trend, expiring };
    });
  },
});

cap({
  name: 'get_content_telemetry', method: 'GET', path: '/academy/content/packs/:id/telemetry', tag: TAG,
  summary: 'Consumption for one pack: opens, completions, unique readers and offline syncs per item and per licensee (ids and counts only; no personal viewing detail beyond who holds a seat).',
  input: z.object({ id, days: z.coerce.number().int().min(1).max(365).default(30) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await ownPack(c, user, i.id);
      const items = (await c.query(`SELECT it.id, it.title, it.kind, count(x.id) FILTER (WHERE x.event='opened')::int AS opened, count(x.id) FILTER (WHERE x.event='completed')::int AS completed, count(DISTINCT x.user_id)::int AS readers, count(x.id) FILTER (WHERE x.event='offline_sync')::int AS offline_syncs
        FROM academy_content_pack_items it JOIN academy_content_pack_versions v ON v.id=it.version_id AND v.pack_id=$1 LEFT JOIN academy_content_consumption x ON x.item_id=it.id AND x.at > now() - make_interval(days => $2) GROUP BY it.id, v.version ORDER BY v.version DESC, it.position`, [p.id, i.days])).rows;
      const licensees = (await c.query(`SELECT l.id AS licence_id, lo.name AS licensee_name, l.seats, count(DISTINCT s.user_id)::int AS seats_used, count(x.id) FILTER (WHERE x.event='opened')::int AS opened, count(x.id) FILTER (WHERE x.event='completed')::int AS completed, max(x.at) AS last_activity
        FROM academy_content_licences l JOIN organisations lo ON lo.id=l.licensee_org_id LEFT JOIN academy_content_seats s ON s.licence_id=l.id AND s.status='active' LEFT JOIN academy_content_consumption x ON x.licence_id=l.id AND x.at > now() - make_interval(days => $2)
        WHERE l.pack_id=$1 AND l.stage IN ('active','suspended') GROUP BY l.id, lo.name ORDER BY lo.name`, [p.id, i.days])).rows;
      await audit(c, user.id, 'read_content_telemetry', 'academy_content_packs', p.id);
      return { days: i.days, items, licensees };
    });
  },
});

cap({
  name: 'get_content_finance', method: 'GET', path: '/academy/content/packs/:id/finance', tag: TAG,
  summary: 'Revenue for one pack taken from canonical payments and the finance ledger, with the author/academy revenue-share statement (a statement only; payouts remain a finance action).',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await ownPack(c, user, i.id);
      const rows = (await c.query(`SELECT l.id AS licence_id, lo.name AS licensee_name, l.price_minor, l.currency, l.paid_at, l.stage, l.seats,
          (SELECT pay.id FROM payments pay WHERE pay.purpose_type='content_licence' AND pay.purpose_id=l.id AND pay.status='paid' ORDER BY pay.created_at DESC LIMIT 1) AS payment_id,
          (SELECT coalesce(sum(pay.refunded_cents),0)::bigint FROM payments pay WHERE pay.purpose_type='content_licence' AND pay.purpose_id=l.id) AS refunded_minor
        FROM academy_content_licences l JOIN organisations lo ON lo.id=l.licensee_org_id WHERE l.pack_id=$1 AND l.stage IN ('active','suspended','expired','revoked') ORDER BY l.created_at DESC`, [p.id])).rows;
      const gross = rows.reduce((n, r) => n + (r.paid_at ? Number(r.price_minor) : 0), 0), refunded = rows.reduce((n, r) => n + Number(r.refunded_minor), 0), net = gross - refunded;
      const split = (p.revenue_share ?? []).map((s) => ({ ...s, amount_minor: Math.floor((net * s.bp) / 10000) }));
      const rest = net - split.reduce((n, s) => n + s.amount_minor, 0);
      await audit(c, user.id, 'read_content_finance', 'academy_content_packs', p.id);
      return { currency: p.currency, gross_minor: gross, refunded_minor: refunded, net_minor: net, licences: rows, share_statement: split, academy_retained_minor: rest };
    });
  },
});

// ================================================================================================================== support & takedown
cap({
  name: 'raise_content_case', method: 'POST', path: '/academy/content/cases', tag: TAG, status: 201,
  summary: 'Raise a support, billing, rights-dispute, safeguarding or takedown case about a pack or item (a seat holder, a buyer administrator or the publisher). Safeguarding and takedown cases are routed to the publisher immediately.',
  input: z.object({ pack_id: id, licence_id: id.optional(), item_id: id.optional(), kind: z.enum(CASE_KINDS), note: z.string().min(5).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await packOf(c, i.pack_id);
      let allowed = false;
      try { await publisherAccess(user, p.organisation_id, { c }); allowed = true; } catch { /* maybe a licensee */ }
      if (!allowed && i.licence_id) { const l = (await c.query('SELECT licensee_org_id FROM academy_content_licences WHERE id=$1 AND pack_id=$2', [i.licence_id, p.id])).rows[0]; if (l) { try { await buyerAccess(user, l.licensee_org_id, { c }); allowed = true; } catch { allowed = (await c.query("SELECT 1 FROM academy_content_seats WHERE licence_id=$1 AND user_id=$2 AND status='active'", [i.licence_id, user.id])).rowCount > 0; } } }
      if (!allowed) throw notFound('Pack');
      if (i.item_id && !(await c.query('SELECT 1 FROM academy_content_pack_items it JOIN academy_content_pack_versions v ON v.id=it.version_id WHERE it.id=$1 AND v.pack_id=$2', [i.item_id, p.id])).rowCount) throw notFound('Item');
      const cs = (await c.query('INSERT INTO academy_content_cases(licence_id, pack_id, item_id, raised_by, kind, note_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, status, created_at', [i.licence_id ?? null, p.id, i.item_id ?? null, user.id, i.kind, encrypt(i.note, 'academy_content_cases.note_enc')])).rows[0];
      if (i.licence_id) await logLicence(c, i.licence_id, user.id, 'case_raised', { case_id: cs.id, kind: i.kind });
      await audit(c, user.id, 'raise_content_case', 'academy_content_cases', cs.id);
      await tell(c, p.organisation_id, 'content_case', ['safeguarding', 'takedown'].includes(i.kind) ? 'Content safeguarding / takedown case' : 'Content case raised', `A ${i.kind.replace('_', ' ')} case was raised about “${p.title}”.`, { case_id: cs.id }, `content-case:${cs.id}`);
      return cs;
    });
  },
});

cap({
  name: 'list_content_cases', method: 'GET', path: '/organisations/:id/academy/content/cases', tag: TAG,
  summary: 'Support, rights and takedown cases against the academy’s packs (curriculum permission). Case text is decrypted and the read is audit-logged.',
  input: z.object({ id, status: z.enum(['open', 'investigating', 'resolved']).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await publisherAccess(user, i.id, { c });
      const rows = (await c.query(`SELECT cs.id, cs.kind, cs.status, cs.pack_id, cs.item_id, cs.licence_id, cs.note_enc, cs.resolution_enc, cs.created_at, cs.resolved_at, p.title AS pack_title, it.title AS item_title, u.display_name AS raised_by_name
        FROM academy_content_cases cs JOIN academy_content_packs p ON p.id=cs.pack_id LEFT JOIN academy_content_pack_items it ON it.id=cs.item_id JOIN users u ON u.id=cs.raised_by
        WHERE p.organisation_id=$1 AND ($2::text IS NULL OR cs.status=$2) ORDER BY (cs.status='resolved'), cs.created_at DESC LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset])).rows;
      if (rows.length) await audit(c, user.id, 'read_content_cases', 'academy_content_cases', rows[0].id);
      return rows.map(({ note_enc, resolution_enc, ...r }) => ({ ...r, note: decrypt(note_enc, 'academy_content_cases.note_enc'), resolution: resolution_enc ? decrypt(resolution_enc, 'academy_content_cases.resolution_enc') : null }));
    });
  },
});

cap({
  name: 'resolve_content_case', method: 'POST', path: '/academy/content/cases/:id/resolve', tag: TAG,
  summary: 'Resolve a case. For a case about an item, the publisher can withdraw that item from every licensee at once (takedown) or lift an earlier takedown.',
  input: z.object({ id, status: z.enum(['investigating', 'resolved']), resolution: z.string().max(1000).optional(), takedown: z.enum(['none', 'withdraw', 'lift']).default('none'), takedown_reason: z.enum(['youth_safeguarding', 'rights_dispute', 'accuracy', 'other']).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cs = (await c.query('SELECT cs.*, p.organisation_id FROM academy_content_cases cs JOIN academy_content_packs p ON p.id=cs.pack_id WHERE cs.id=$1 FOR UPDATE OF cs', [i.id])).rows[0];
      if (!cs) throw notFound('Case');
      await publisherAccess(user, cs.organisation_id, { write: true, c }).catch(() => { throw notFound('Case'); });
      if (i.takedown !== 'none') {
        if (!cs.item_id) throw badRequest('Only a case about an item can withdraw it');
        if (i.takedown === 'withdraw') {
          if (!i.takedown_reason) throw badRequest('Choose a takedown reason');
          await c.query('INSERT INTO academy_content_takedowns(item_id, case_id, reason, taken_by) VALUES ($1,$2,$3,$4) ON CONFLICT (item_id) DO UPDATE SET lifted_at=NULL, case_id=EXCLUDED.case_id, reason=EXCLUDED.reason, taken_by=EXCLUDED.taken_by, taken_at=now()', [cs.item_id, cs.id, i.takedown_reason, user.id]);
          await c.query('UPDATE academy_content_offline_grants SET revoked_at=now() WHERE revoked_at IS NULL AND licence_id IN (SELECT l.id FROM academy_content_licences l JOIN academy_content_pack_versions v ON v.pack_id=l.pack_id JOIN academy_content_pack_items it ON it.version_id=v.id WHERE it.id=$1)', [cs.item_id]);
        } else await c.query('UPDATE academy_content_takedowns SET lifted_at=now() WHERE item_id=$1 AND lifted_at IS NULL', [cs.item_id]);
      }
      const r = (await c.query("UPDATE academy_content_cases SET status=$2, resolution_enc=coalesce($3,resolution_enc), resolved_by=CASE WHEN $2='resolved' THEN $4::uuid END, resolved_at=CASE WHEN $2='resolved' THEN now() END WHERE id=$1 RETURNING id, kind, status, resolved_at", [cs.id, i.status, i.resolution ? encrypt(i.resolution, 'academy_content_cases.resolution_enc') : null, user.id])).rows[0];
      await audit(c, user.id, `resolve_content_case_${i.takedown}`, 'academy_content_cases', cs.id);
      return r;
    });
  },
});

// ================================================================================================================== the coaching workflow (academy session)
/** Items linked to a session, each with the live state of its licence. Nothing licensed is returned here, only titles and state. */
async function linkedItems(c, sessionId, userId) {
  const rows = (await c.query(`SELECT u.licence_id, u.item_id, u.user_id AS linked_by, lu.display_name AS linked_by_name, u.created_at AS linked_at, it.title, it.kind, it.minutes, it.youth_footage, p.title AS pack_title, po.name AS publisher_name,
      l.stage, l.effective_to, l.grace_days, l.offline_allowed, l.pack_id,
      EXISTS (SELECT 1 FROM academy_content_takedowns t WHERE t.item_id=it.id AND t.lifted_at IS NULL) AS withdrawn,
      EXISTS (SELECT 1 FROM academy_content_seats s WHERE s.licence_id=l.id AND s.user_id=$2 AND s.status='active') AS i_hold_seat
    FROM academy_content_uses u JOIN academy_content_pack_items it ON it.id=u.item_id JOIN academy_content_licences l ON l.id=u.licence_id JOIN academy_content_packs p ON p.id=l.pack_id
    JOIN organisations po ON po.id=p.organisation_id JOIN users lu ON lu.id=u.user_id WHERE u.session_id=$1 AND u.unlinked_at IS NULL ORDER BY u.created_at, it.position`, [sessionId, userId])).rows;
  return rows.map((r) => { const state = stageNow(r); return { ...r, state, locked: !['active', 'grace'].includes(state) || r.withdrawn }; });
}

cap({
  name: 'list_academy_session_content', method: 'GET', path: '/academy/sessions/:id/content', tag: TAG,
  summary: 'The licensed items linked to an academy session (session staff), with the live state of each licence: active, in its grace period, or locked (revoked, expired, suspended, withdrawn). Titles and state only; the content itself is read through open_content_item with a seat.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await sessionFor(user, i.id, 'view', { c }).catch((e) => { throw e.status === 403 ? notFound('Session') : e; });
      const items = await linkedItems(c, i.id, user.id);
      return items.map(({ stage, effective_to, grace_days, pack_id, ...x }) => x);
    });
  },
});

cap({
  name: 'load_licensed_content_into_plan', method: 'POST', path: '/academy/sessions/:id/content/plan', tag: TAG, auth: ['coach'], status: 201,
  summary: 'Coach: put the licensed drills, curriculum objectives and micro-modules linked to this session into your own coaching plan as tagged blocks (the same coaching session record and plan versions as "Load drills"). Needs a seat and a live licence for each item. The text is copied into the block only when the licence allows offline copies; otherwise the block is a titled reference whose text stays behind the licence. Footage and documents are never plan blocks. Repeating adds nothing twice. A revoked, expired or suspended licence is refused with 402.',
  input: z.object({ id, item_ids: z.array(id).max(30).optional() }),
  async handler({ user }, i) {
    const acc = await sessionFor(user, i.id, 'view').catch((e) => { throw e.status === 403 ? notFound('Session') : e; });
    if (!acc.mine) throw forbidden('Only the session’s coaches can plan it');
    const linked = (await linkedItems(pool, i.id, user.id)).filter((x) => !i.item_ids || i.item_ids.includes(x.item_id));
    if (!linked.length) throw badRequest('Link at least one licensed item to the session first');
    const built = [], skipped = [];
    let firstBlock = null;
    for (const x of linked) {
      if (['video', 'document', 'methodology'].includes(x.kind)) { skipped.push({ item_id: x.item_id, title: x.title, reason: 'not_a_plan_block' }); continue; }
      try {
        const e = await entitlement(pool, user, x.licence_id, x.item_id);
        const ref = await resolveReference(pool, e.item);
        const copy = !!e.licence.offline_allowed && !e.item.youth_footage;
        built.push(...planBlocks(e.item, ref, x.licence_id, { copy }));
      } catch (err) { if (err.status === 402 || err.status === 404 || err.status === 410) { firstBlock ??= err; skipped.push({ item_id: x.item_id, title: x.title, reason: err.code ?? 'unavailable' }); } else throw err; }
    }
    if (!built.length && firstBlock) throw firstBlock;
    const rec = await openSession(user, { source_type: 'academy_session', source_id: i.id });
    const plan = await one('SELECT blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]);
    const blocks = plan?.blocks ?? [];
    const has = (b) => blocks.some((x) => (x.tags ?? []).includes(b.tags[0]) && (x.tags ?? []).includes(b.tags[1]));
    const fresh = built.filter((b) => !has(b));
    if (!fresh.length) return { record_id: rec.id, plan_version: rec.plan_version, added: [], skipped };
    if (blocks.length + fresh.length > 30) throw badRequest('The plan would exceed 30 blocks; remove some before loading more');
    const saved = await savePlan(user, rec.id, [...blocks, ...fresh], { expected_version: rec.plan_version });
    await audit(null, user.id, 'load_licensed_content_into_plan', 'academy_sessions', i.id);
    return { record_id: rec.id, plan_version: saved.plan.version, added: fresh.map((b) => b.title), skipped };
  },
});

cap({
  name: 'unlink_content_item', method: 'DELETE', path: '/academy/sessions/:id/content/:item_id', tag: TAG,
  summary: 'Unlink a licensed item from a session (the person who linked it, or academy curriculum staff). The link is kept as history; blocks already in a coaching plan are not touched.',
  input: z.object({ id, item_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { a } = await sessionFor(user, i.id, 'view', { write: true, c }).catch((e) => { throw e.status === 403 ? notFound('Session') : e; });
      const r = await c.query('UPDATE academy_content_uses SET unlinked_at=now() WHERE session_id=$1 AND item_id=$2 AND unlinked_at IS NULL AND (user_id=$3 OR $4::boolean)', [i.id, i.item_id, user.id, a.has('curriculum') || a.admin]);
      if (!r.rowCount) throw notFound('Link');
      await audit(c, user.id, 'unlink_content_item', 'academy_sessions', i.id);
      return { unlinked: true };
    });
  },
});
