// Academy talent scouting (issue #790), part 1: campaigns (the brief, evaluation model, safeguarding and committee rules), the team, referral
// sources and launch. A campaign never holds a prospect of its own: prospects are Talent CRM entries (see academy-scouting-pipeline.js).
// Authorisation is enforced here, never in the UI: owners/admins and the campaign owner manage; scouts and committee members see what their role needs.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { STAFF } from '../academy.js';
import { POSITIONS } from '../athlete-profile.js';
import { isVerifiedRecruiter } from '../recruiter.js';
import {
  BASES, CONTACT_POLICIES, CRITERIA, ENTRY_STAGES, LEVELS, MEMBER_ROLES, OBJECTIVES, REFERRAL_KINDS, RESIDENCY, SCOUTING_MODES, SLA_KEYS,
  campaignFor, logEvent, mayManage, mayRead, membersOf, readiness, reachesMinors, stale, bandAges,
} from '../academy-scouting.js';

const TAG = 'Academy';
const iso = z.string().date();
const version = z.number().int().min(1);
const text = (n) => z.string().trim().min(1).max(n);

const FIELDS = {
  name: text(120), objective: z.enum(OBJECTIVES), season_label: text(60).nullable(),
  sport_ids: z.array(id).max(12), programme_ids: z.array(id).max(12), owner_id: id.nullable(),
  target_places: z.number().int().min(1).max(10000).nullable(), scholarship_places: z.number().int().min(0).max(10000).nullable(), pipeline_target: z.number().int().min(1).max(100000).nullable(),
  starts_on: iso.nullable(), ends_on: iso.nullable(), decision_by: iso.nullable(),
  budget_minor: z.number().int().min(0).nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), cost_centre: text(80).nullable(),
  birth_year_min: z.number().int().min(1950).max(2100).nullable(), birth_year_max: z.number().int().min(1950).max(2100).nullable(),
  genders: z.array(z.enum(['boys', 'girls', 'mixed'])).max(3), dominance: z.array(z.enum(['right', 'left', 'either'])).max(3),
  positions: z.array(text(60)).max(30), levels: z.array(z.enum(LEVELS)).max(4),
  benchmarks: z.array(z.object({ metric: text(60), unit: text(20), min: z.number().nullable().optional(), ideal: z.number().nullable().optional() })).max(20),
  flag_relative_age: z.boolean(), languages: z.array(text(40)).max(10), residency: z.enum(RESIDENCY).nullable(),
  requirements: z.object({ academic: text(300).optional(), eligibility_rules: text(300).optional() }).strict(),
  regions: z.array(text(80)).max(30), event_ids: z.array(id).max(50), venue_ids: z.array(id).max(50), referral_source_ids: z.array(id).max(100),
  scouting_modes: z.array(z.enum(SCOUTING_MODES)).max(5),
  rubric: z.array(z.object({ key: z.enum(CRITERIA), weight: z.number().int().min(0).max(100) })).max(CRITERIA.length),
  min_evaluations: z.number().int().min(1).max(10), required_bases: z.array(z.enum(BASES)).max(5),
  guardian_consent_required: z.boolean(), notes_private: z.boolean(), video_requires_grant: z.boolean(),
  contact_policy: z.enum(CONTACT_POLICIES), retention_months: z.number().int().min(1).max(120),
  committee_quorum: z.number().int().min(1).max(15), committee_rule: z.enum(['majority', 'unanimous']),
  sla_days: z.object(Object.fromEntries(SLA_KEYS.map((k) => [k, z.number().int().min(1).max(365).optional()]))).strict(),
  step_reached: z.number().int().min(1).max(8),
};
const PARTIAL = z.object(FIELDS).partial().strict();
const LOCKED_AFTER_LAUNCH = ['sport_ids', 'birth_year_min', 'birth_year_max', 'rubric'];
const SET_ONCE_DISTINCT = (a) => [...new Set(a)];
const ARRAYS = ['sport_ids', 'programme_ids', 'genders', 'dominance', 'positions', 'levels', 'languages', 'regions', 'event_ids', 'venue_ids', 'referral_source_ids', 'scouting_modes', 'required_bases'];
const JSONB = ['benchmarks', 'requirements', 'rubric', 'sla_days'];

async function isOrgMember(c, orgId, userId) {
  return !!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, userId])).rows.length;
}

/** Everything a brief points at must exist and belong to this academy: the server never trusts ids sent by the app. */
async function checkRefs(c, orgId, f) {
  if (f.sport_ids?.length && (await c.query('SELECT count(*)::int AS n FROM sports WHERE id = ANY($1)', [f.sport_ids])).rows[0].n !== f.sport_ids.length) throw notFound('Sport');
  if (f.programme_ids?.length && (await c.query('SELECT count(*)::int AS n FROM academy_programmes WHERE id = ANY($1) AND organisation_id=$2', [f.programme_ids, orgId])).rows[0].n !== f.programme_ids.length) throw badRequest('A programme is not part of this academy');
  if (f.owner_id && !(await isOrgMember(c, orgId, f.owner_id))) throw badRequest('The campaign owner must be a member of the academy');
  if (f.referral_source_ids?.length && (await c.query('SELECT count(*)::int AS n FROM academy_referral_sources WHERE id = ANY($1) AND organisation_id=$2 AND archived_at IS NULL', [f.referral_source_ids, orgId])).rows[0].n !== f.referral_source_ids.length) throw badRequest('A referral source is not part of this academy');
  if (f.venue_ids?.length && (await c.query('SELECT count(*)::int AS n FROM venues WHERE id = ANY($1)', [f.venue_ids])).rows[0].n !== f.venue_ids.length) throw notFound('Venue');
  if (f.event_ids?.length && (await c.query('SELECT count(*)::int AS n FROM events WHERE id = ANY($1)', [f.event_ids])).rows[0].n !== f.event_ids.length) throw notFound('Event');
}

function normalise(f) {
  const out = { ...f };
  for (const k of ARRAYS) if (out[k]) out[k] = SET_ONCE_DISTINCT(out[k]);
  if (out.rubric) out.rubric = out.rubric.filter((r) => r.weight > 0);
  if (out.rubric && new Set(out.rubric.map((r) => r.key)).size !== out.rubric.length) throw badRequest('Each criterion can appear once in the rubric');
  return out;
}

const COUNTS_SQL = `
  SELECT ce.campaign_id,
         count(*) FILTER (WHERE ce.stage NOT IN ('withdrawn'))::int AS prospects,
         count(*) FILTER (WHERE ce.stage = 'prospect')::int AS in_prospect,
         count(*) FILTER (WHERE ce.stage = 'evaluated')::int AS in_evaluated,
         count(*) FILTER (WHERE ce.stage = 'committee')::int AS in_committee,
         count(*) FILTER (WHERE ce.stage = 'decided')::int AS decided,
         count(*) FILTER (WHERE ce.invited_at IS NOT NULL)::int AS invited,
         count(*) FILTER (WHERE a.stage = 'enrolled')::int AS enrolled
    FROM academy_campaign_entries ce LEFT JOIN academy_applications a ON a.id = ce.application_id
   WHERE ce.campaign_id = ANY($1) GROUP BY ce.campaign_id`;
const ZERO = { prospects: 0, in_prospect: 0, in_evaluated: 0, in_committee: 0, decided: 0, invited: 0, enrolled: 0 };

async function present(campaign, { members = null, full = false } = {}) {
  const ms = members ?? (await membersOf(null, campaign.id));
  const counts = (await many(COUNTS_SQL, [[campaign.id]]))[0] ?? ZERO;
  const { campaign_id, ...cnt } = counts;
  const out = { ...campaign, counts: cnt, ages: bandAges(campaign), reaches_minors: reachesMinors(campaign) };
  if (!full) return out;
  const names = (ids, sql) => (ids.length ? many(sql, [ids]) : []);
  return {
    ...out, members: ms, readiness: await readiness(campaign, ms),
    sports: await names(campaign.sport_ids, 'SELECT id, slug, name, emoji FROM sports WHERE id = ANY($1) ORDER BY name, id'),
    programmes: await names(campaign.programme_ids, 'SELECT id, title, sport, status FROM academy_programmes WHERE id = ANY($1) ORDER BY title, id'),
    referral_sources: await names(campaign.referral_source_ids, 'SELECT id, name, kind, region FROM academy_referral_sources WHERE id = ANY($1) ORDER BY name, id'),
    owner: campaign.owner_id ? await one('SELECT id, display_name FROM users WHERE id=$1', [campaign.owner_id]) : null,
  };
}

// ------------------------------------------------------------------ options (the pickers of the creation flow)
cap({
  name: 'get_academy_scouting_options', method: 'GET', path: '/organisations/:id/academy/scouting/options', tag: TAG,
  summary: 'Everything the campaign creation flow picks from, in one call: objectives, evidence bases, rubric criteria, the academy\'s sports with each sport\'s position catalogue, its published programmes, its members (committee, owner), the verified recruiters linked to it (scouts) and its referral sources. Owner/admin only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    const sports = await many('SELECT id, slug, name, emoji FROM sports ORDER BY name, id');
    const members = await many("SELECT m.user_id, m.role AS org_role, u.display_name, u.handle FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' ORDER BY u.display_name, m.user_id LIMIT 300", [i.id]);
    const candidates = await many(
      `SELECT DISTINCT u.id AS user_id, u.display_name, u.handle, rp.regions FROM recruiter_profiles rp JOIN users u ON u.id=rp.user_id
        WHERE rp.organisation_id=$1 OR rp.user_id IN (SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active') ORDER BY u.display_name, u.id LIMIT 200`, [i.id]);
    const scouts = [];
    for (const s of candidates) if (await isVerifiedRecruiter(s.user_id)) scouts.push(s);
    return {
      objectives: OBJECTIVES, scouting_modes: SCOUTING_MODES, member_roles: MEMBER_ROLES, criteria: CRITERIA, bases: BASES, levels: LEVELS, residency: RESIDENCY, contact_policies: CONTACT_POLICIES, referral_kinds: REFERRAL_KINDS, sla_keys: SLA_KEYS,
      sports: sports.map((s) => ({ ...s, positions: POSITIONS[s.slug] ?? [] })),
      programmes: await many("SELECT id, title, sport, status FROM academy_programmes WHERE organisation_id=$1 AND status IN ('published','draft') ORDER BY title, id", [i.id]),
      members, scouts, referral_sources: await many('SELECT id, name, kind, region FROM academy_referral_sources WHERE organisation_id=$1 AND archived_at IS NULL ORDER BY name, id', [i.id]),
    };
  },
});

// ------------------------------------------------------------------ referral sources
cap({
  name: 'list_academy_referral_sources', method: 'GET', path: '/organisations/:id/academy/referral-sources', tag: TAG,
  summary: 'The academy\'s referral sources (schools, clubs, federations, coaches, events). Owner/admin, or anyone on one of its campaigns.',
  input: z.object({ id, archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const staff = await orgFor(user, i.id, STAFF).then(() => true, () => false);
    if (!staff && !(await one('SELECT 1 FROM academy_campaign_members m JOIN academy_scouting_campaigns c ON c.id=m.campaign_id WHERE c.organisation_id=$1 AND m.user_id=$2 AND m.removed_at IS NULL', [i.id, user.id]))) throw notFound('Academy');
    return many(`SELECT id, name, kind, region, organisation_ref_id, archived_at FROM academy_referral_sources WHERE organisation_id=$1 AND ($2::boolean OR archived_at IS NULL) ORDER BY lower(name), id`, [i.id, i.archived]);
  },
});

cap({
  name: 'save_academy_referral_source', method: 'POST', path: '/organisations/:id/academy/referral-sources', tag: TAG,
  summary: 'Add or change a referral source, or archive it (never deleted, so reports keep their history). Send source_id to change one. Owner/admin only.',
  input: z.object({ id, source_id: id.optional(), name: text(120).optional(), kind: z.enum(REFERRAL_KINDS).optional(), region: text(80).nullable().optional(), organisation_ref_id: id.nullable().optional(), archived: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    if (i.organisation_ref_id && !(await c.query('SELECT 1 FROM organisations WHERE id=$1', [i.organisation_ref_id])).rows.length) throw notFound('Organisation');
    try {
      if (!i.source_id) {
        if (!i.name || !i.kind) throw badRequest('A name and a kind are needed');
        const r = (await c.query('INSERT INTO academy_referral_sources(organisation_id, name, kind, region, organisation_ref_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, i.name, i.kind, i.region ?? null, i.organisation_ref_id ?? null, user.id])).rows[0];
        return r;
      }
      const cur = (await c.query('SELECT * FROM academy_referral_sources WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.source_id, i.id])).rows[0];
      if (!cur) throw notFound('Referral source');
      return (await c.query(
        `UPDATE academy_referral_sources SET name=$2, kind=$3, region=$4, organisation_ref_id=$5, archived_at=CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 RETURNING *`,
        [cur.id, i.name ?? cur.name, i.kind ?? cur.kind, i.region === undefined ? cur.region : i.region, i.organisation_ref_id === undefined ? cur.organisation_ref_id : i.organisation_ref_id, i.archived ?? null])).rows[0];
    } catch (e) { throw e.code === '23505' ? conflict('A referral source with that name already exists') : e; }
  }),
});

// ------------------------------------------------------------------ campaigns
cap({
  name: 'list_academy_scouting_campaigns', method: 'GET', path: '/organisations/:id/academy/scouting/campaigns', tag: TAG,
  summary: 'The academy\'s scouting campaigns with stage counts. Owner/admin see all; scouts and committee members see the campaigns they are on.',
  input: z.object({ id, status: z.enum(['draft', 'active', 'paused', 'closed', 'archived']).optional(), ...page }),
  async handler({ user }, i) {
    const staff = isAdmin(user) || await orgFor(user, i.id, STAFF).then(() => true, () => false);
    const rows = await many(
      `SELECT c.* FROM academy_scouting_campaigns c WHERE c.organisation_id=$1 AND ($2::text IS NULL OR c.status=$2) AND ($3::boolean OR c.owner_id=$4 OR EXISTS (SELECT 1 FROM academy_campaign_members m WHERE m.campaign_id=c.id AND m.user_id=$4 AND m.removed_at IS NULL))
        ORDER BY (c.status='active') DESC, c.created_at DESC, c.id LIMIT $5 OFFSET $6`, [i.id, i.status ?? null, staff, user.id, i.limit, i.offset]);
    if (!rows.length && !staff && !(await one('SELECT 1 FROM organisations WHERE id=$1', [i.id]))) throw notFound('Academy');
    const counts = new Map((await many(COUNTS_SQL, [rows.map((r) => r.id)])).map((r) => [r.campaign_id, r]));
    return rows.map((r) => { const { campaign_id, ...cnt } = counts.get(r.id) ?? ZERO; return { ...r, counts: cnt, reaches_minors: reachesMinors(r), can_manage: staff || r.owner_id === user.id }; });
  },
});

cap({
  name: 'list_my_scouting_campaigns', method: 'GET', path: '/me/scouting/campaigns', tag: TAG,
  summary: 'Campaigns you are on as a scout, regional lead or committee member, across academies, with your role and region. Used to add a Talent CRM prospect to a campaign.',
  input: z.object({ status: z.enum(['active', 'paused', 'closed']).optional(), ...page }),
  async handler({ user }, i) {
    return many(
      `SELECT c.id, c.organisation_id, o.name AS organisation, c.name, c.status, c.sport_ids, c.regions, c.birth_year_min, c.birth_year_max, c.positions,
              array_agg(DISTINCT m.role) AS roles, array_remove(array_agg(DISTINCT m.region), NULL) AS my_regions, sum(m.capacity)::int AS my_capacity,
              (SELECT count(*)::int FROM academy_campaign_entries ce WHERE ce.campaign_id=c.id AND ce.scout_id=$1 AND ce.stage NOT IN ('declined','withdrawn')) AS my_prospects
         FROM academy_campaign_members m JOIN academy_scouting_campaigns c ON c.id=m.campaign_id JOIN organisations o ON o.id=c.organisation_id
        WHERE m.user_id=$1 AND m.removed_at IS NULL AND c.status IN ('active','paused','closed') AND ($2::text IS NULL OR c.status=$2) GROUP BY c.id, o.name ORDER BY (c.status='active') DESC, c.created_at DESC, c.id LIMIT $3 OFFSET $4`,
      [user.id, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_academy_scouting_campaign', method: 'GET', path: '/academy/scouting/campaigns/:id', tag: TAG,
  summary: 'One campaign with its team, stage counts and the launch readiness check (what is ready and what still blocks launch, each with the creation step that fixes it).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await campaignFor(user, i.id);
    mayRead(a);
    const full = await present(a.campaign, { full: true });
    return { ...full, can_manage: a.staff, my_roles: [...a.roles] };
  },
});

cap({
  name: 'create_academy_scouting_campaign', method: 'POST', path: '/organisations/:id/academy/scouting/campaigns', tag: TAG, status: 201,
  summary: 'Start a scouting campaign as a draft. Only a name is needed; every other part of the brief is saved step by step with update_academy_scouting_campaign. Owner/admin only.',
  input: z.object({ id }).merge(PARTIAL).extend({ name: FIELDS.name }),
  handler: ({ user }, { id: orgId, ...rest }) => tx(async (c) => {
    await orgFor(user, orgId, STAFF, { write: true, c });
    const f = normalise({ owner_id: user.id, ...rest });
    await checkRefs(c, orgId, f);
    const cols = Object.keys(f);
    const row = (await c.query(
      `INSERT INTO academy_scouting_campaigns(organisation_id, created_by, ${cols.join(', ')}) VALUES ($1,$2,${cols.map((_, k) => `$${k + 3}`).join(',')}) RETURNING *`,
      [orgId, user.id, ...cols.map((k) => (JSONB.includes(k) ? JSON.stringify(f[k]) : f[k]))])).rows[0];
    await logEvent(c, row.id, null, 'campaign_created', { actor: user.id, note: row.name });
    await audit(c, user.id, 'create_scouting_campaign', 'academy_scouting_campaigns', row.id);
    return present(row, { members: [] });
  }),
});

cap({
  name: 'update_academy_scouting_campaign', method: 'PATCH', path: '/academy/scouting/campaigns/:id', tag: TAG,
  summary: 'Save any part of the brief (one creation step at a time, autosave-friendly). Send the row_version you loaded. After launch the sports, birth years and rubric are fixed so results stay comparable; guardian consent cannot be switched off for an age band that includes young people.',
  input: z.object({ id, row_version: version }).merge(PARTIAL),
  handler: ({ user }, { id: cid, row_version, ...rest }) => tx(async (c) => {
    const a = await campaignFor(user, cid, { c, lock: true });
    mayManage(a);
    const cur = a.campaign;
    if (cur.row_version !== row_version) throw stale();
    if (['closed', 'archived'].includes(cur.status)) throw conflict('A closed campaign cannot be changed');
    const f = normalise(rest);
    if (cur.status !== 'draft') for (const k of LOCKED_AFTER_LAUNCH) if (k in f && JSON.stringify(f[k]) !== JSON.stringify(cur[k])) throw conflict(`${k.replaceAll('_', ' ')} is fixed once a campaign has launched, so results stay comparable`);
    const next = { ...cur, ...f };
    if (next.birth_year_max != null && next.birth_year_min != null && next.birth_year_max < next.birth_year_min) throw badRequest('The last birth year cannot be before the first');
    if (next.scholarship_places != null && next.target_places != null && next.scholarship_places > next.target_places) throw badRequest('Scholarship places cannot exceed the target places');
    if (next.ends_on && next.starts_on && next.ends_on < next.starts_on) throw badRequest('The campaign cannot end before it starts');
    if (reachesMinors(next) && next.guardian_consent_required === false) throw badRequest('Guardian consent cannot be switched off for an age band that includes young people');
    await checkRefs(c, cur.organisation_id, f);
    const cols = Object.keys(f);
    if (!cols.length) return present(cur);
    const row = (await c.query(
      `UPDATE academy_scouting_campaigns SET ${cols.map((k, n) => `${k}=$${n + 3}`).join(', ')}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`,
      [cur.id, row_version, ...cols.map((k) => (JSONB.includes(k) ? JSON.stringify(f[k]) : f[k]))])).rows[0];
    await logEvent(c, cur.id, null, 'campaign_updated', { actor: user.id, note: cols.join(', ').slice(0, 480) });
    return present(row);
  }),
});

cap({
  name: 'set_academy_campaign_team', method: 'POST', path: '/academy/scouting/campaigns/:id/team', tag: TAG,
  summary: 'Replace the campaign team: scouts and regional leads (verified recruiters linked to the academy, each with a region and prospect capacity), committee members, chair and safeguarding officer (active members of the academy). Removed people are kept in history, not deleted.',
  input: z.object({ id, row_version: version, members: z.array(z.object({ user_id: id, role: z.enum(MEMBER_ROLES), region: text(80).nullable().optional(), capacity: z.number().int().min(1).max(500).nullable().optional() })).max(200) }),
  handler: async ({ user }, i) => present(await tx(async (c) => {
    const a = await campaignFor(user, i.id, { c, lock: true });
    mayManage(a);
    const cur = a.campaign;
    if (cur.row_version !== i.row_version) throw stale();
    if (['closed', 'archived'].includes(cur.status)) throw conflict('A closed campaign cannot be changed');
    const want = new Map();
    for (const m of i.members) {
      const region = ['scout', 'regional_lead'].includes(m.role) ? (m.region ?? null) : null;
      if (['scout', 'regional_lead'].includes(m.role)) {
        if (!region) throw badRequest('Scouts and regional leads need a region');
        if (cur.regions.length && !cur.regions.includes(region)) throw badRequest(`${region} is not one of this campaign's regions`);
        if (!(await isVerifiedRecruiter(m.user_id))) throw badRequest('Scouts must be verified recruiters with a current verification');
        const linked = (await c.query('SELECT 1 FROM recruiter_profiles WHERE user_id=$1 AND organisation_id=$2', [m.user_id, cur.organisation_id])).rows.length || await isOrgMember(c, cur.organisation_id, m.user_id);
        if (!linked) throw badRequest('Scouts must be linked to this academy (their recruiter profile names it, or they are a member)');
      } else if (!(await isOrgMember(c, cur.organisation_id, m.user_id))) throw badRequest('Committee members must be members of the academy');
      want.set(`${m.user_id}|${m.role}|${region ?? ''}`, { ...m, region });
    }
    const live = (await c.query('SELECT * FROM academy_campaign_members WHERE campaign_id=$1 AND removed_at IS NULL', [cur.id])).rows;
    for (const m of live) {
      const k = `${m.user_id}|${m.role}|${m.region ?? ''}`;
      const w = want.get(k);
      if (!w) { await c.query('UPDATE academy_campaign_members SET removed_at=now() WHERE id=$1', [m.id]); await logEvent(c, cur.id, null, 'member_removed', { actor: user.id, note: m.role }); }
      else { if ((w.capacity ?? null) !== m.capacity) await c.query('UPDATE academy_campaign_members SET capacity=$2 WHERE id=$1', [m.id, w.capacity ?? null]); want.delete(k); }
    }
    for (const w of want.values()) { await c.query('INSERT INTO academy_campaign_members(campaign_id, user_id, role, region, capacity, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [cur.id, w.user_id, w.role, w.region, w.capacity ?? null, user.id]); await logEvent(c, cur.id, null, 'member_added', { actor: user.id, note: w.role }); }
    return (await c.query('UPDATE academy_scouting_campaigns SET row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [cur.id])).rows[0];
  }), { full: true }),
});

async function transition(user, cid, to, row_version, c) {
  const a = await campaignFor(user, cid, { c, lock: true });
  mayManage(a);
  const cur = a.campaign;
  if (cur.row_version !== row_version) throw stale();
  const OK = { draft: ['active', 'archived'], active: ['paused', 'closed'], paused: ['active', 'closed'], closed: ['archived'] };
  if (!(OK[cur.status] ?? []).includes(to)) throw conflict(`A ${cur.status} campaign cannot become ${to}`);
  if (to === 'active') {
    const r = await readiness(cur, await membersOf(c, cur.id));
    if (r.blockers.length) { const e = conflict('This campaign is not ready to launch', { code: 'not_ready', blockers: r.blockers }); throw e; }
  }
  const row = (await c.query(
    `UPDATE academy_scouting_campaigns SET status=$2, launched_at=CASE WHEN $2='active' THEN coalesce(launched_at, now()) ELSE launched_at END, closed_at=CASE WHEN $2='closed' THEN now() ELSE closed_at END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, to])).rows[0];
  await logEvent(c, cur.id, null, `campaign_${to}`, { from: cur.status, to, actor: user.id });
  await audit(c, user.id, `scouting_campaign_${to}`, 'academy_scouting_campaigns', cur.id);
  return row;
}

cap({
  name: 'launch_academy_scouting_campaign', method: 'POST', path: '/academy/scouting/campaigns/:id/launch', tag: TAG,
  summary: 'Launch (or resume) a campaign. The server runs the readiness check and refuses with the exact blockers (no scout for a region, committee below quorum, rubric not 100%, no safeguarding officer for an under-16 campaign...). Owner/admin or the campaign owner.',
  input: z.object({ id, row_version: version }),
  handler: async ({ user }, i) => present(await tx((c) => transition(user, i.id, 'active', i.row_version, c)), { full: true }),
});

cap({
  name: 'set_academy_scouting_campaign_status', method: 'POST', path: '/academy/scouting/campaigns/:id/status', tag: TAG,
  summary: 'Pause, close or archive a campaign (nothing is deleted: prospects, evaluations, votes and applications stay readable). Closed campaigns take no new prospects.',
  input: z.object({ id, row_version: version, status: z.enum(['paused', 'closed', 'archived']) }),
  handler: async ({ user }, i) => present(await tx((c) => transition(user, i.id, i.status, i.row_version, c))),
});

