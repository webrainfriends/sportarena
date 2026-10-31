// Competition Season, Division & League management (issue #476): Competition → Season → Division → Round/Fixture → Standings, one definition per action
// (REST + OpenAPI + MCP). A season IS a canonical `events` row; teams enter through `event_entries`; games are ordinary `fixtures` with their ordinary results.
// This layer only adds the persistent identity, versioned rules, divisions, membership history, rounds, auditable adjustments, frozen tables and season-end
// movements (docs/competition-seasons.md). Authorisation, validation and audit are enforced here; outsiders get a 404, so existence is never leaked.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { hasOrgGrant } from '../org-access.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { canManageTeam } from './teams.js';
import { computeStandings, computeRankedStandings, tableModelOf, DEFAULT_PLACEMENT_POINTS, normaliseRules, tableHash, roundRobin, proposeMovements, unitFor, TIEBREAKERS, DEFAULT_RULES } from '../competition-standings.js';

const TAG = 'Competitions';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time (HH:MM)');
const txt = (n) => z.string().trim().min(1).max(n);
const GENDER = z.enum(['open', 'men', 'women', 'mixed']);
const LEVEL = z.enum(['elite', 'professional', 'semi_pro', 'amateur', 'recreational', 'school', 'youth']);
const today = () => new Date().toISOString().slice(0, 10);
// node-pg hands `date` columns back as local-midnight Date objects; every comparison and every response uses plain YYYY-MM-DD strings instead
export const ymd = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v == null ? null : String(v).slice(0, 10));
const SEASON_DATES = ['starts_on', 'ends_on', 'registration_opens_on', 'registration_closes_on', 'transfer_opens_on', 'transfer_closes_on'];
export const dates = (s) => (s ? { ...s, ...Object.fromEntries(SEASON_DATES.filter((k) => k in s).map((k) => [k, ymd(s[k])])) } : s);
const NEXT = { draft: ['open'], open: ['active', 'draft'], active: ['open'], completed: ['archived'], archived: [] };
export const CLOSED = new Set(['completed', 'archived']);
const rulesIn = z.object({
  points: z.object({ win: z.number().int().min(0).max(10), draw: z.number().int().min(0).max(10), loss: z.number().int().min(0).max(10) }).partial().optional(),
  forfeit: z.object({ winner_for: z.number().int().min(0).max(20), winner_against: z.number().int().min(0).max(20), loser_points: z.number().int().min(-10).max(10) }).partial().optional(),
  tiebreakers: z.array(z.enum(Object.keys(TIEBREAKERS))).min(1).max(9).optional(),
  placement_points: z.array(z.number().int().min(0).max(1000)).min(1).max(50).optional(),
  movement: z.object({ champion: z.boolean(), promote: z.number().int().min(0).max(20), relegate: z.number().int().min(0).max(20), playoff: z.number().int().min(0).max(20), qualify: z.number().int().min(0).max(20) }).partial().optional(),
}).strict();

// ------------------------------------------------------------------ access
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 70) || 'competition';
export const comp = async (c, cid, { lock = false } = {}) => {
  const r = (await c.query(`SELECT * FROM comp_competitions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [cid])).rows[0];
  if (!r) throw notFound('Competition');
  return r;
};
/** Who runs a competition: its owner, an owner/admin of the governing organisation, or the platform team. */
export async function canManageCompetition(user, cm, c = pool) {
  if (!user) return false;
  return isAdmin(user) || cm.owner_id === user.id || (cm.organisation_id ? hasOrgGrant(user, cm.organisation_id, ['owner', 'admin'], c) : false);
}
const visible = (cm, staff) => staff || (cm.is_public && cm.status !== 'draft');
export async function readComp(c, user, cid) {
  const cm = await comp(c, cid);
  const staff = await canManageCompetition(user, cm, c);
  if (!visible(cm, staff)) throw notFound('Competition');
  return { cm, staff };
}
export async function manageComp(c, user, cid, opts) {
  const cm = await comp(c, cid, opts);
  if (!(await canManageCompetition(user, cm, c))) throw notFound('Competition');
  return cm;
}
export const seasonRow = async (c, sid, { lock = false } = {}) => {
  const s = (await c.query(`SELECT * FROM comp_seasons WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [sid])).rows[0];
  if (!s) throw notFound('Season');
  return dates(s);
};
/** A season is public only once it is open or later; its draft is for staff. */
export async function readSeason(c, user, sid) {
  const s = await seasonRow(c, sid);
  const { cm, staff } = await readComp(c, user, s.competition_id);
  if (!staff && s.status === 'draft') throw notFound('Season');
  return { s, cm, staff };
}
export async function manageSeason(c, user, sid, { lock = false, open = true } = {}) {
  const s = await seasonRow(c, sid, { lock });
  const cm = await manageComp(c, user, s.competition_id);
  if (open && CLOSED.has(s.status)) throw conflict(`This season is ${s.status}; its history is closed`, { code: 'season_closed' });
  return { s, cm };
}
export const divisionRow = async (c, did, { lock = false } = {}) => {
  const d = (await c.query(`SELECT * FROM comp_divisions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [did])).rows[0];
  if (!d) throw notFound('Division');
  return d;
};
export const currentRules = async (c, sid) => (await c.query('SELECT * FROM comp_rule_versions WHERE season_id=$1 ORDER BY version DESC LIMIT 1', [sid])).rows[0];
export const asOpen = (e) => { if (e?.code === '23514') throw conflict(String(e.message).replace(/^.*?: /, ''), { code: 'history_closed' }); throw e; };

// ------------------------------------------------------------------ competitions
cap({
  name: 'create_competition', method: 'POST', path: '/competitions', tag: TAG, status: 201, auth: ['organizer', 'admin'],
  summary: 'Create a persistent competition (league / cup / series) that outlives any one season: sport, governing organisation, geography, level, category and a public profile. Seasons, divisions and teams are added to it afterwards.',
  input: z.object({ name: txt(120), sport: z.string().trim().min(1).max(80).describe('sport id or slug'), organisation_id: id.optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(), region: txt(80).optional(), level: LEVEL.optional(), gender: GENDER.default('open'), age_group: txt(40).optional(), description: z.string().trim().max(2000).optional(), is_public: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const sport = (await c.query('SELECT id FROM sports WHERE id::text=$1 OR slug=$1', [i.sport])).rows[0];
      if (!sport) throw badRequest('Unknown sport');
      if (i.organisation_id && !(isAdmin(user) || (await hasOrgGrant(user, i.organisation_id, ['owner', 'admin'], c)))) throw notFound('Organisation');
      let slug = slugify(i.name);
      if ((await c.query('SELECT 1 FROM comp_competitions WHERE lower(slug)=$1', [slug])).rowCount) slug = `${slug.slice(0, 66)}-${Math.random().toString(36).slice(2, 6)}`;
      const r = (await c.query(
        `INSERT INTO comp_competitions(name,slug,sport_id,organisation_id,owner_id,country,region,level,gender,age_group,description,is_public) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [i.name, slug, sport.id, i.organisation_id ?? null, user.id, i.country ?? null, i.region ?? null, i.level ?? null, i.gender, i.age_group ?? null, i.description ?? null, i.is_public],
      )).rows[0];
      await audit(c, user.id, 'competition.create', 'competition', r.id);
      return r;
    });
  },
});

cap({
  name: 'list_competitions', method: 'GET', path: '/competitions', tag: TAG, auth: 'public',
  summary: 'Search competitions. Public ones are listed for everyone; with mine=true you also see your own drafts and private competitions. Paginated.',
  input: z.object({ q: z.string().trim().max(80).optional(), sport: z.string().trim().max(80).optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(), mine: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const org = user ? "OR c.owner_id=$4 OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=c.organisation_id AND m.user_id=$4 AND m.status='active' AND m.role IN ('owner','admin'))" : '';
    const who = user && i.mine ? 'AND (c.owner_id=$4 OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=c.organisation_id AND m.user_id=$4 AND m.status=\'active\' AND m.role IN (\'owner\',\'admin\')))' : '';
    const vis = user ? `(c.is_public AND c.status<>'draft' ${org})` : "(c.is_public AND c.status<>'draft')";
    const params = [i.q ? `%${i.q}%` : null, i.sport ?? null, i.country ?? null];
    if (user) params.push(user.id);
    const rows = await many(
      `SELECT c.id,c.name,c.slug,c.country,c.region,c.level,c.gender,c.age_group,c.is_public,c.status,s.slug AS sport,s.name AS sport_name,s.emoji,
              (SELECT count(*)::int FROM comp_seasons x WHERE x.competition_id=c.id AND x.status<>'draft') AS seasons,
              (SELECT label FROM comp_seasons x WHERE x.competition_id=c.id AND x.status IN ('open','active') ORDER BY x.starts_on DESC LIMIT 1) AS current_season
         FROM comp_competitions c JOIN sports s ON s.id=c.sport_id
        WHERE ${vis} ${who} AND ($1::text IS NULL OR c.name ILIKE $1) AND ($2::text IS NULL OR s.slug=$2 OR s.id::text=$2) AND ($3::text IS NULL OR c.country=$3)
        ORDER BY c.name LIMIT ${i.limit} OFFSET ${i.offset}`, params);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'get_competition', method: 'GET', path: '/competitions/:id', tag: TAG, auth: 'public',
  summary: 'Competition Home: identity, governing organisation, the seasons (newest first), the defending champion and what the signed-in person may do. Draft seasons are visible to staff only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { cm, staff } = await readComp(pool, user, i.id);
    const sport = await one('SELECT slug,name,emoji,scoring FROM sports WHERE id=$1', [cm.sport_id]);
    const org = cm.organisation_id ? await one('SELECT id,name FROM organisations WHERE id=$1', [cm.organisation_id]) : null;
    const seasons = (await many(
      `SELECT s.id,s.label,s.status,s.starts_on,s.ends_on,s.event_id,s.champion_team_id,t.name AS champion_name,
              (SELECT count(*)::int FROM comp_divisions d WHERE d.season_id=s.id AND d.archived_at IS NULL) AS divisions,
              (SELECT count(*)::int FROM comp_memberships m WHERE m.season_id=s.id AND m.status='accepted') AS teams
         FROM comp_seasons s LEFT JOIN teams t ON t.id=s.champion_team_id WHERE s.competition_id=$1 ${staff ? '' : "AND s.status<>'draft'"} ORDER BY s.starts_on DESC`, [cm.id])).map(dates);
    const defending = seasons.find((s) => s.status === 'completed' && s.champion_team_id) ?? null;
    return { ...cm, sport, organisation: org, seasons, defending_champion: defending ? { team_id: defending.champion_team_id, name: defending.champion_name, season: defending.label } : null, can_manage: staff, scoring: unitFor(sport?.scoring) };
  },
});

cap({
  name: 'update_competition', method: 'PATCH', path: '/competitions/:id', tag: TAG,
  summary: 'Change a competition’s profile or lifecycle (draft / active / archived). Seasons and their history are never touched.',
  input: z.object({ id, name: txt(120).optional(), organisation_id: id.nullable().optional(), country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(), region: txt(80).nullable().optional(), level: LEVEL.nullable().optional(), gender: GENDER.optional(), age_group: txt(40).nullable().optional(), description: z.string().trim().max(2000).nullable().optional(), is_public: z.boolean().optional(), status: z.enum(['draft', 'active', 'archived']).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cm = await manageComp(c, user, i.id, { lock: true });
      if (i.organisation_id && !(isAdmin(user) || (await hasOrgGrant(user, i.organisation_id, ['owner', 'admin'], c)))) throw notFound('Organisation');
      const keys = ['name', 'organisation_id', 'country', 'region', 'level', 'gender', 'age_group', 'description', 'is_public', 'status'].filter((k) => i[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to update');
      const r = (await c.query(`UPDATE comp_competitions SET ${keys.map((k, n) => `${k}=$${n + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [cm.id, ...keys.map((k) => i[k])])).rows[0];
      await audit(c, user.id, 'competition.update', 'competition', cm.id);
      return r;
    });
  },
});

// ------------------------------------------------------------------ seasons
const seasonDates = { starts_on: day, ends_on: day, registration_opens_on: day.nullable().optional(), registration_closes_on: day.nullable().optional(), transfer_opens_on: day.nullable().optional(), transfer_closes_on: day.nullable().optional() };
const brandingIn = z.object({ primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), title_sponsor: txt(80).optional(), banner_emoji: txt(8).optional() }).strict();

/** Create a season (its canonical event, rule version 1 and the link to the previous season). Shared by create_season and rollover_season. */
export async function createSeasonRow(c, user, cm, i) {
  const prev = (await c.query('SELECT * FROM comp_seasons WHERE competition_id=$1 ORDER BY starts_on DESC, created_at DESC LIMIT 1', [cm.id])).rows[0];
  if ((await c.query('SELECT 1 FROM comp_seasons WHERE competition_id=$1 AND lower(label)=lower($2)', [cm.id, i.label])).rowCount) throw conflict('This competition already has a season with that label');
  let rules = i.rules;
  if (!rules && i.copy_rules_from_previous && prev) rules = (await currentRules(c, prev.id))?.rules;
  rules = normaliseRules(rules ?? {});
  const ev = (await c.query(
    `INSERT INTO events(name,sport_id,organizer_id,kind,status,starts_on,ends_on,points_win,points_draw,points_loss,organisation_id,description)
     VALUES ($1,$2,$3,'league','draft',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [`${cm.name} ${i.label}`.slice(0, 200), cm.sport_id, cm.owner_id, i.starts_on, i.ends_on, rules.points.win, rules.points.draw, rules.points.loss, cm.organisation_id, cm.description],
  )).rows[0];
  const s = (await c.query(
    `INSERT INTO comp_seasons(competition_id,event_id,label,starts_on,ends_on,registration_opens_on,registration_closes_on,transfer_opens_on,transfer_closes_on,rule_policy_ref,branding,previous_season_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [cm.id, ev.id, i.label, i.starts_on, i.ends_on, i.registration_opens_on ?? null, i.registration_closes_on ?? null, i.transfer_opens_on ?? null, i.transfer_closes_on ?? null, i.rule_policy_ref ?? null, JSON.stringify(i.branding ?? {}), prev?.id ?? null, user.id],
  )).rows[0];
  await c.query('INSERT INTO comp_rule_versions(season_id,version,rules,note,created_by) VALUES ($1,1,$2,$3,$4)', [s.id, JSON.stringify(rules), 'First version', user.id]);
  await audit(c, user.id, 'competition.season_create', 'competition_season', s.id);
  return { ...dates(s), rule_version: 1, rules };
}

cap({
  name: 'create_season', method: 'POST', path: '/competitions/:id/seasons', tag: TAG, status: 201,
  summary: 'Add a season (e.g. 2026/27) to a competition. It creates the season’s canonical event (no teams or games are copied), rule version 1 and links it to the previous season. Optionally start from the previous season’s rules.',
  input: z.object({ id, label: txt(60), ...seasonDates, rule_policy_ref: txt(120).optional(), branding: brandingIn.optional(), rules: rulesIn.optional(), copy_rules_from_previous: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cm = await manageComp(c, user, i.id, { lock: true });
      if (cm.status === 'archived') throw conflict('This competition is archived');
      if (i.ends_on < i.starts_on) throw badRequest('The season must end on or after it starts');
      return createSeasonRow(c, user, cm, i);
    });
  },
});

cap({
  name: 'list_seasons', method: 'GET', path: '/competitions/:id/seasons', tag: TAG, auth: 'public',
  summary: 'The seasons of a competition, newest first, with status, dates, champion and counts. Paginated.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { staff } = await readComp(pool, user, i.id);
    const rows = (await many(
      `SELECT s.id,s.label,s.status,s.starts_on,s.ends_on,s.event_id,s.champion_team_id,t.name AS champion_name,s.completed_at FROM comp_seasons s LEFT JOIN teams t ON t.id=s.champion_team_id
        WHERE s.competition_id=$1 ${staff ? '' : "AND s.status<>'draft'"} ORDER BY s.starts_on DESC LIMIT ${i.limit} OFFSET ${i.offset}`, [i.id])).map(dates);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'get_season', method: 'GET', path: '/seasons/:id', tag: TAG, auth: 'public',
  summary: 'One season: dates and windows, status, rule version in force, divisions with their member counts and the registration state for the signed-in person.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { s, cm, staff } = await readSeason(pool, user, i.id);
    const rv = await currentRules(pool, s.id);
    const divisions = await many(
      `SELECT d.*, (SELECT count(*)::int FROM comp_memberships m WHERE m.division_id=d.id AND m.status='accepted') AS teams,
              (SELECT count(*)::int FROM comp_fixture_links l WHERE l.division_id=d.id) AS fixtures FROM comp_divisions d WHERE d.season_id=$1 ORDER BY d.tier, d.name`, [s.id]);
    const counts = (await one("SELECT count(*) FILTER (WHERE status='accepted')::int AS accepted, count(*) FILTER (WHERE status IN ('applied','invited','waitlisted'))::int AS pending FROM comp_memberships WHERE season_id=$1", [s.id]));
    const sport = await one('SELECT scoring FROM sports WHERE id=$1', [cm.sport_id]);
    const win = s.registration_opens_on || s.registration_closes_on ? { opens_on: s.registration_opens_on, closes_on: s.registration_closes_on, open_now: (!s.registration_opens_on || s.registration_opens_on <= today()) && (!s.registration_closes_on || s.registration_closes_on >= today()) } : null;
    return { ...s, competition: { id: cm.id, name: cm.name, sport: (await one('SELECT slug FROM sports WHERE id=$1', [cm.sport_id]))?.slug }, rule_version: rv.version, rules: normaliseRules(rv.rules), divisions, counts, registration_window: win, can_manage: staff, scoring: unitFor(sport?.scoring), tiebreaker_labels: TIEBREAKERS };
  },
});

cap({
  name: 'update_season', method: 'PATCH', path: '/seasons/:id', tag: TAG,
  summary: 'Change a season’s dates, registration / transfer windows, policy reference or branding while it is not completed. A completed or archived season is closed.',
  input: z.object({ id, label: txt(60).optional(), starts_on: day.optional(), ends_on: day.optional(), registration_opens_on: day.nullable().optional(), registration_closes_on: day.nullable().optional(), transfer_opens_on: day.nullable().optional(), transfer_closes_on: day.nullable().optional(), rule_policy_ref: txt(120).nullable().optional(), branding: brandingIn.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await manageSeason(c, user, i.id, { lock: true });
      const keys = ['label', 'starts_on', 'ends_on', 'registration_opens_on', 'registration_closes_on', 'transfer_opens_on', 'transfer_closes_on', 'rule_policy_ref', 'branding'].filter((k) => i[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to update');
      try {
        const r = (await c.query(`UPDATE comp_seasons SET ${keys.map((k, n) => `${k}=$${n + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [s.id, ...keys.map((k) => (k === 'branding' ? JSON.stringify(i[k]) : i[k]))])).rows[0];
        if (i.starts_on || i.ends_on) await c.query('UPDATE events SET starts_on=$2, ends_on=$3 WHERE id=$1', [s.event_id, r.starts_on, r.ends_on]);
        await audit(c, user.id, 'competition.season_update', 'competition_season', s.id);
        return dates(r);
      } catch (e) { if (e.code === '23514') throw badRequest('Check the dates: each window must end on or after it opens, and the season on or after it starts'); if (e.code === '23505') throw conflict('This competition already has a season with that label'); throw e; }
    });
  },
});

cap({
  name: 'set_season_status', method: 'POST', path: '/seasons/:id/status', tag: TAG,
  summary: 'Move a season through draft → open (registration) → active (play). Completing is its own action (complete_season) because it freezes the tables. A completed season can be archived.',
  input: z.object({ id, status: z.enum(['draft', 'open', 'active', 'archived']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await seasonRow(c, i.id, { lock: true });
      await manageComp(c, user, s.competition_id);
      if (!NEXT[s.status].includes(i.status)) throw conflict(`A ${s.status} season cannot become ${i.status}`, { code: 'bad_transition', allowed: NEXT[s.status] });
      if (i.status === 'active') {
        const n = (await c.query("SELECT count(*)::int AS n FROM comp_memberships WHERE season_id=$1 AND status='accepted'", [s.id])).rows[0].n;
        if (n < 2) throw conflict('At least two accepted teams are needed to start play');
      }
      const r = (await c.query('UPDATE comp_seasons SET status=$2 WHERE id=$1 RETURNING *', [s.id, i.status])).rows[0];
      const ev = { draft: 'draft', open: 'open', active: 'ongoing' }[i.status];
      if (ev) await c.query('UPDATE events SET status=$2 WHERE id=$1', [s.event_id, ev]);
      await audit(c, user.id, `competition.season_${i.status}`, 'competition_season', s.id);
      return dates(r);
    });
  },
});

// ------------------------------------------------------------------ rules (versioned)
cap({
  name: 'set_season_rules', method: 'POST', path: '/seasons/:id/rules', tag: TAG, status: 201,
  summary: 'Publish a new version of the season’s rules: points for a win / draw / loss, forfeit score, ordered tie-breakers (points, head-to-head, difference, scored, wins, name…) and season-end movement (promote / relegate / playoff / qualify counts). Old versions are kept; a completed season is frozen on the version it ended with.',
  input: z.object({ id, rules: rulesIn, note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await manageSeason(c, user, i.id, { lock: true });
      const prev = await currentRules(c, s.id);
      const merged = normaliseRules({ ...prev.rules, ...i.rules, points: { ...prev.rules.points, ...(i.rules.points ?? {}) }, forfeit: { ...prev.rules.forfeit, ...(i.rules.forfeit ?? {}) }, movement: { ...prev.rules.movement, ...(i.rules.movement ?? {}) } });
      const r = (await c.query('INSERT INTO comp_rule_versions(season_id,version,rules,note,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [s.id, prev.version + 1, JSON.stringify(merged), i.note ?? null, user.id])).rows[0];
      await c.query('UPDATE events SET points_win=$2, points_draw=$3, points_loss=$4 WHERE id=$1', [s.event_id, merged.points.win, merged.points.draw, merged.points.loss]);
      await audit(c, user.id, 'competition.rules_version', 'competition_season', s.id);
      return r;
    });
  },
});

cap({
  name: 'list_season_rules', method: 'GET', path: '/seasons/:id/rules', tag: TAG, auth: 'public',
  summary: 'Every rule version of a season, newest first, with who published it and why. The tie-breaker catalogue is included so a client can offer the choices.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await readSeason(pool, user, i.id);
    const rows = await many('SELECT v.version,v.rules,v.note,v.created_at,u.display_name AS by FROM comp_rule_versions v JOIN users u ON u.id=v.created_by WHERE v.season_id=$1 ORDER BY v.version DESC LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
    return { items: rows, tiebreakers: TIEBREAKERS, defaults: DEFAULT_RULES, limit: i.limit, offset: i.offset };
  },
});

// ------------------------------------------------------------------ divisions
cap({
  name: 'create_division', method: 'POST', path: '/seasons/:id/divisions', tag: TAG, status: 201,
  summary: 'Add a division, conference, pool or category to a season, with its tier (1 = top: promotion goes up, relegation down), capacity and gender / age class. A conference or pool can sit inside a parent division.',
  input: z.object({ id, name: txt(80), kind: z.enum(['division', 'conference', 'pool', 'category']).default('division'), tier: z.number().int().min(1).max(20).default(1), parent_id: id.optional(), capacity: z.number().int().min(2).max(128).optional(), gender: GENDER.default('open'), min_age: z.number().int().min(4).max(99).optional(), max_age: z.number().int().min(4).max(99).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await manageSeason(c, user, i.id, { lock: true });
      if (i.parent_id && (await divisionRow(c, i.parent_id)).season_id !== s.id) throw badRequest('The parent division belongs to another season');
      try {
        const d = (await c.query('INSERT INTO comp_divisions(season_id,name,kind,tier,parent_id,capacity,gender,min_age,max_age,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [s.id, i.name, i.kind, i.tier, i.parent_id ?? null, i.capacity ?? null, i.gender, i.min_age ?? null, i.max_age ?? null, user.id])).rows[0];
        await audit(c, user.id, 'competition.division_create', 'competition_division', d.id);
        return d;
      } catch (e) { if (e.code === '23505') throw conflict('This season already has a division with that name'); if (e.code === '23514') asOpen(e); throw e; }
    });
  },
});

cap({
  name: 'update_division', method: 'PATCH', path: '/divisions/:id', tag: TAG,
  summary: 'Rename, resize or archive a division while the season is open. A division that has teams is archived rather than deleted; its history stays.',
  input: z.object({ id, name: txt(80).optional(), tier: z.number().int().min(1).max(20).optional(), capacity: z.number().int().min(2).max(128).nullable().optional(), gender: GENDER.optional(), min_age: z.number().int().min(4).max(99).nullable().optional(), max_age: z.number().int().min(4).max(99).nullable().optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await divisionRow(c, i.id, { lock: true });
      await manageSeason(c, user, d.season_id);
      if (i.capacity != null) { const n = (await c.query("SELECT count(*)::int AS n FROM comp_memberships WHERE division_id=$1 AND status='accepted'", [d.id])).rows[0].n; if (i.capacity < n) throw conflict(`${n} teams are already in this division`); }
      const set = { ...i }; delete set.id; delete set.archived;
      const keys = ['name', 'tier', 'capacity', 'gender', 'min_age', 'max_age'].filter((k) => set[k] !== undefined);
      if (!keys.length && i.archived === undefined) throw badRequest('Nothing to update');
      try {
        const q = [...keys.map((k, n) => `${k}=$${n + 2}`), ...(i.archived === undefined ? [] : [`archived_at=${i.archived ? 'coalesce(archived_at, now())' : 'NULL'}`])];
        const r = (await c.query(`UPDATE comp_divisions SET ${q.join(', ')} WHERE id=$1 RETURNING *`, [d.id, ...keys.map((k) => set[k])])).rows[0];
        await audit(c, user.id, 'competition.division_update', 'competition_division', d.id);
        return r;
      } catch (e) { if (e.code === '23505') throw conflict('This season already has a division with that name'); if (e.code === '23514') asOpen(e); throw e; }
    });
  },
});

// ------------------------------------------------------------------ team season registration
/** What the platform already knows about the team at the moment of the decision, frozen with the membership (never recomputed, never copied back). */
async function eligibilitySnapshot(c, cm, s, team, division) {
  const members = (await c.query('SELECT count(*)::int AS n FROM team_members WHERE team_id=$1', [team.id])).rows[0].n;
  const checks = [
    { rule: 'sport', pass: team.sport_id === cm.sport_id, note: 'The team plays the competition’s sport' },
    { rule: 'registration_window', pass: (!s.registration_opens_on || s.registration_opens_on <= today()) && (!s.registration_closes_on || s.registration_closes_on >= today()), note: 'Applied inside the registration window' },
    { rule: 'division_class', pass: null, note: division ? `Division class ${division.gender}${division.min_age || division.max_age ? ` ${division.min_age ?? ''}–${division.max_age ?? ''}` : ''} is confirmed by the organiser` : 'No division chosen yet' },
  ];
  return { taken_at: new Date().toISOString(), team: { id: team.id, name: team.name, sport_id: team.sport_id }, roster_size: members, division: division ? { id: division.id, name: division.name, tier: division.tier } : null, checks };
}
export const logMembership = (c, m, action, actor, { reason = null, from = null } = {}) =>
  c.query('INSERT INTO comp_membership_events(membership_id,season_id,team_id,division_id,action,from_division_id,reason,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [m.id, m.season_id, m.team_id, m.division_id, action, from, reason, actor]);
/** The canonical entry the rest of the platform already understands; created once per team, never duplicated. */
export const ensureEntry = (c, s, teamId) =>
  c.query("INSERT INTO event_entries(event_id,team_id,status) VALUES ($1,$2,'accepted') ON CONFLICT (event_id,team_id,user_id) DO UPDATE SET status='accepted'", [s.event_id, teamId]);
const dropEntry = (c, s, teamId) => c.query("UPDATE event_entries SET status='withdrawn' WHERE event_id=$1 AND team_id=$2", [s.event_id, teamId]);
const full = async (c, d) => d?.capacity != null && (await c.query("SELECT count(*)::int AS n FROM comp_memberships WHERE division_id=$1 AND status='accepted'", [d.id])).rows[0].n >= d.capacity;

cap({
  name: 'apply_to_season', method: 'POST', path: '/seasons/:id/memberships', tag: TAG, status: 201,
  summary: 'Register a canonical team into a season (and optionally a division) without copying it. A team manager applies inside the registration window; the organiser reviews it. An organiser can add a team directly with accept=true. The eligibility the platform knows is frozen with the decision.',
  input: z.object({ id, team_id: id, division_id: id.optional(), accept: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await seasonRow(c, i.id, { lock: true });
      const cm = await comp(c, s.competition_id);
      const staff = await canManageCompetition(user, cm, c);
      if (!visible(cm, staff) || (!staff && s.status === 'draft')) throw notFound('Season');
      if (CLOSED.has(s.status)) throw conflict(`This season is ${s.status}`, { code: 'season_closed' });
      const team = (await c.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
      if (!team || !(await canManageTeam(user, team))) throw notFound('Team');
      if (team.sport_id !== cm.sport_id) throw badRequest('This team plays a different sport from the competition');
      const d = i.division_id ? await divisionRow(c, i.division_id) : null;
      if (d && (d.season_id !== s.id || d.archived_at)) throw badRequest('Choose a division of this season');
      if (!staff) {
        if (s.status !== 'open') throw conflict('Registration is not open for this season');
        if ((s.registration_opens_on && s.registration_opens_on > today()) || (s.registration_closes_on && s.registration_closes_on < today())) throw conflict('The registration window is closed', { code: 'window_closed', opens_on: s.registration_opens_on, closes_on: s.registration_closes_on });
        if (i.accept) throw forbidden('Only the organiser can accept a team');
      }
      if ((await c.query("SELECT 1 FROM comp_memberships WHERE season_id=$1 AND team_id=$2 AND status IN ('applied','invited','accepted','waitlisted')", [s.id, team.id])).rowCount) throw conflict('This team is already registered for the season', { code: 'already_registered' });
      const elig = await eligibilitySnapshot(c, cm, s, team, d);
      const accept = i.accept && staff;
      if (accept && d && (await full(c, d))) throw conflict('This division is full', { code: 'division_full' });
      const m = (await c.query('INSERT INTO comp_memberships(season_id,division_id,team_id,status,eligibility,decided_by,decided_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [s.id, d?.id ?? null, team.id, accept ? 'accepted' : 'applied', JSON.stringify(elig), accept ? user.id : null, accept ? new Date() : null, user.id])).rows[0];
      await logMembership(c, m, 'applied', user.id);
      if (accept) { await logMembership(c, m, 'accepted', user.id); await ensureEntry(c, s, team.id); }
      else if (cm.owner_id !== user.id) await notify(c, cm.owner_id, { kind: 'competition_application', title: `${team.name} applied to ${cm.name} ${s.label}`, body: 'Review the application in the competition.', data: { season_id: s.id, membership_id: m.id } });
      await audit(c, user.id, 'competition.membership_apply', 'competition_membership', m.id);
      return m;
    });
  },
});

cap({
  name: 'decide_membership', method: 'POST', path: '/memberships/:id/decision', tag: TAG,
  summary: 'Decide a team’s place in a season. The organiser accepts (into a division, respecting its capacity), waitlists or removes it (a reason is required). The team manager can accept an invitation and can withdraw. Every step is kept in the membership history.',
  input: z.object({ id, action: z.enum(['accept', 'waitlist', 'withdraw', 'remove']), division_id: id.optional(), reason: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM comp_memberships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!m) throw notFound('Membership');
      const s = await seasonRow(c, m.season_id, { lock: true });
      const cm = await comp(c, s.competition_id);
      const staff = await canManageCompetition(user, cm, c);
      const team = (await c.query('SELECT * FROM teams WHERE id=$1', [m.team_id])).rows[0];
      const mine = await canManageTeam(user, team);
      if (!staff && !mine) throw notFound('Membership');
      if (CLOSED.has(s.status)) throw conflict(`This season is ${s.status}; its history is closed`, { code: 'season_closed' });
      if (['withdrawn', 'removed'].includes(m.status)) throw conflict(`This membership is already ${m.status}`);
      if (i.action === 'remove' && (!staff || !i.reason)) throw staff ? badRequest('Give a reason for removing a team') : forbidden('Only the organiser can remove a team');
      if (['waitlist'].includes(i.action) && !staff) throw forbidden('Only the organiser can do this');
      if (i.action === 'accept' && !(staff || (mine && m.status === 'invited'))) throw forbidden('A team can only accept an invitation; the organiser accepts applications');
      const status = { accept: 'accepted', waitlist: 'waitlisted', withdraw: 'withdrawn', remove: 'removed' }[i.action];
      let division = m.division_id;
      if (i.action === 'accept') {
        division = i.division_id ?? m.division_id;
        if (!division) throw badRequest('Choose the division the team joins');
        const d = await divisionRow(c, division);
        if (d.season_id !== s.id || d.archived_at) throw badRequest('Choose a division of this season');
        if (m.status !== 'accepted' && (await full(c, d))) throw conflict('This division is full', { code: 'division_full' });
      }
      const elig = i.action === 'accept' ? JSON.stringify(await eligibilitySnapshot(c, cm, s, team, division ? await divisionRow(c, division) : null)) : null;
      const r = (await c.query(`UPDATE comp_memberships SET status=$2, division_id=$3, decided_by=$4, decided_at=now(), updated_at=now(), eligibility=coalesce($5::jsonb, eligibility) WHERE id=$1 RETURNING *`, [m.id, status, division, user.id, elig])).rows[0];
      await logMembership(c, r, status === 'accepted' ? 'accepted' : status, user.id, { reason: i.reason });
      if (status === 'accepted') await ensureEntry(c, s, m.team_id); else if (status !== 'waitlisted') await dropEntry(c, s, m.team_id);
      if (staff && team.owner_id !== user.id) await notify(c, team.owner_id, { kind: 'competition_membership', title: `${team.name}: ${status} in ${cm.name} ${s.label}`, body: i.reason ?? 'See the competition for details.', data: { season_id: s.id, membership_id: m.id, status } });
      await audit(c, user.id, `competition.membership_${status}`, 'competition_membership', m.id);
      return r;
    });
  },
});

cap({
  name: 'move_team', method: 'POST', path: '/memberships/:id/move', tag: TAG,
  summary: 'Move an accepted team to another division of the same season (organiser only, with a reason). The earlier placement stays in the membership history.',
  input: z.object({ id, division_id: id, reason: z.string().trim().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM comp_memberships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!m) throw notFound('Membership');
      const { s } = await manageSeason(c, user, m.season_id, { lock: true });
      if (m.status !== 'accepted') throw conflict('Only an accepted team can be moved');
      const d = await divisionRow(c, i.division_id);
      if (d.season_id !== s.id || d.archived_at) throw badRequest('Choose a division of this season');
      if (d.id === m.division_id) throw badRequest('The team is already in that division');
      if (await full(c, d)) throw conflict('This division is full', { code: 'division_full' });
      if ((await c.query("SELECT 1 FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.division_id=$1 AND (f.home_team_id=$2 OR f.away_team_id=$2) AND f.status='completed'", [m.division_id, m.team_id])).rowCount) throw conflict('This team has played games in its division; they stay there. Remove or withdraw it instead', { code: 'has_results' });
      const r = (await c.query('UPDATE comp_memberships SET division_id=$2, updated_at=now() WHERE id=$1 RETURNING *', [m.id, d.id])).rows[0];
      await logMembership(c, r, 'moved', user.id, { reason: i.reason, from: m.division_id });
      await audit(c, user.id, 'competition.membership_move', 'competition_membership', m.id);
      return r;
    });
  },
});

cap({
  name: 'list_memberships', method: 'GET', path: '/seasons/:id/memberships', tag: TAG, auth: 'public',
  summary: 'The teams of a season with their division and status. The public sees accepted teams only; staff see applications, invitations, waitlist and the eligibility snapshot too. Paginated.',
  input: z.object({ id, division_id: id.optional(), status: z.enum(['applied', 'invited', 'accepted', 'waitlisted', 'withdrawn', 'removed']).optional(), ...page }),
  async handler({ user }, i) {
    const { staff } = await readSeason(pool, user, i.id);
    const rows = await many(
      `SELECT m.id,m.team_id,t.name AS team_name,t.emoji,t.color,m.division_id,d.name AS division_name,d.tier,m.status,m.decided_at,m.created_at${staff ? ',m.eligibility,m.source_movement_id' : ''}
         FROM comp_memberships m JOIN teams t ON t.id=m.team_id LEFT JOIN comp_divisions d ON d.id=m.division_id
        WHERE m.season_id=$1 AND ($2::uuid IS NULL OR m.division_id=$2) AND ($3::text IS NULL OR m.status=$3) ${staff ? '' : "AND m.status='accepted'"}
        ORDER BY d.tier NULLS LAST, d.name, t.name LIMIT ${i.limit} OFFSET ${i.offset}`, [i.id, i.division_id ?? null, i.status ?? null]);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'list_membership_history', method: 'GET', path: '/seasons/:id/membership-history', tag: TAG, auth: 'public',
  summary: 'The append-only membership history of a season (applied, accepted, moved, withdrawn…) with who and why. Public for a completed season so the historical membership is readable; staff only while it is running.',
  input: z.object({ id, team_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const { s, staff } = await readSeason(pool, user, i.id);
    if (!staff && !CLOSED.has(s.status)) throw notFound('Season');
    const rows = await many(
      `SELECT e.id,e.team_id,t.name AS team_name,e.action,e.reason,e.created_at,d.name AS division_name,f.name AS from_division_name${staff ? ',u.display_name AS by' : ''}
         FROM comp_membership_events e JOIN teams t ON t.id=e.team_id JOIN users u ON u.id=e.actor_id LEFT JOIN comp_divisions d ON d.id=e.division_id LEFT JOIN comp_divisions f ON f.id=e.from_division_id
        WHERE e.season_id=$1 AND ($2::uuid IS NULL OR e.team_id=$2) ORDER BY e.created_at, e.id LIMIT ${i.limit} OFFSET ${i.offset}`, [i.id, i.team_id ?? null]);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});

// ------------------------------------------------------------------ schedule: rounds & fixtures
export const acceptedTeams = async (c, did) => (await c.query(
  `SELECT t.id AS team_id, t.name FROM teams t WHERE t.id IN (SELECT team_id FROM comp_memberships WHERE division_id=$1 AND status='accepted' UNION SELECT team_id FROM comp_stage_entries WHERE division_id=$1) ORDER BY t.name, t.id`, [did])).rows;
export const stamp = (date, time, offset) => new Date(new Date(`${date}T${time}:00Z`).getTime() - offset * 60000).toISOString();
export const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

cap({
  name: 'create_round', method: 'POST', path: '/divisions/:id/rounds', tag: TAG, status: 201,
  summary: 'Add a match week / round to a division (number, label and dates). Fixtures are generated into rounds or linked to them.',
  input: z.object({ id, number: z.number().int().min(1).max(200).optional(), label: txt(60).optional(), starts_on: day.optional(), ends_on: day.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await divisionRow(c, i.id, { lock: true });
      await manageSeason(c, user, d.season_id);
      const number = i.number ?? ((await c.query('SELECT coalesce(max(number),0)+1 AS n FROM comp_rounds WHERE division_id=$1', [d.id])).rows[0].n);
      try {
        const r = (await c.query('INSERT INTO comp_rounds(season_id,division_id,number,label,starts_on,ends_on,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [d.season_id, d.id, number, i.label ?? `Round ${number}`, i.starts_on ?? null, i.ends_on ?? null, user.id])).rows[0];
        await audit(c, user.id, 'competition.round_create', 'competition_round', r.id);
        return r;
      } catch (e) { if (e.code === '23505') throw conflict('That round number already exists'); if (e.code === '23514') throw badRequest('A round must end on or after it starts'); throw e; }
    });
  },
});

cap({
  name: 'generate_division_fixtures', method: 'POST', path: '/divisions/:id/generate-fixtures', tag: TAG, status: 201,
  summary: 'Generate a single or double round robin for a division’s accepted teams: one round per match week, ordinary fixtures in the season’s event (so scoring, officials and results work as everywhere else), each linked to its round. Refused if the division already has linked fixtures.',
  input: z.object({ id, double: z.boolean().default(false), first_round_on: day, days_between_rounds: z.number().int().min(1).max(30).default(7), kickoff: hhmm.default('18:00'), duration_min: z.number().int().min(10).max(600).default(90), utc_offset_minutes: z.number().int().min(-720).max(840).default(0), meets: z.number().int().min(1).max(60).optional().describe('ranked-meet sports (time, distance, weight, judged): how many meets the series has') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await divisionRow(c, i.id, { lock: true });
      const { s } = await manageSeason(c, user, d.season_id, { lock: true });
      if (d.archived_at) throw conflict('This division is archived');
      if (await isRanked(c, d)) {
        if (!i.meets) throw badRequest('This sport is ranked by time, distance, weight or score: say how many meets the series has (meets)');
        if ((await c.query('SELECT 1 FROM comp_rounds WHERE division_id=$1 LIMIT 1', [d.id])).rowCount) throw conflict('This division already has meets', { code: 'already_scheduled' });
        for (let n = 0; n < i.meets; n++) { const on = addDays(i.first_round_on, n * i.days_between_rounds); await c.query('INSERT INTO comp_rounds(season_id,division_id,number,label,starts_on,ends_on,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [s.id, d.id, n + 1, `Meet ${n + 1}`, on, addDays(on, i.days_between_rounds - 1), user.id]); }
        await audit(c, user.id, 'competition.fixtures_generate', 'competition_division', d.id);
        return { division_id: d.id, rounds: i.meets, fixtures: 0, teams: (await acceptedTeams(c, d.id)).length, model: 'ranked_meets' };
      }
      if ((await c.query('SELECT 1 FROM comp_fixture_links WHERE division_id=$1 LIMIT 1', [d.id])).rowCount) throw conflict('This division already has fixtures; link or reschedule them instead', { code: 'already_scheduled' });
      const teams = await acceptedTeams(c, d.id);
      if (teams.length < 2) throw conflict('Accept at least two teams into this division first');
      const plan = roundRobin(teams.map((t) => t.team_id), { double: i.double });
      let games = 0;
      for (const [n, pairs] of plan.entries()) {
        const on = addDays(i.first_round_on, n * i.days_between_rounds);
        const r = (await c.query('INSERT INTO comp_rounds(season_id,division_id,number,label,starts_on,ends_on,created_by) VALUES ($1,$2,$3,$4,$5,$5,$6) RETURNING id', [s.id, d.id, n + 1, `Round ${n + 1}`, on, user.id])).rows[0];
        for (const [h, a] of pairs) {
          const f = (await c.query("INSERT INTO fixtures(event_id,round,home_team_id,away_team_id,scheduled_at,duration_min) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [s.event_id, `Round ${n + 1}`, h, a, stamp(on, i.kickoff, i.utc_offset_minutes), i.duration_min])).rows[0];
          await c.query('INSERT INTO comp_fixture_links(fixture_id,season_id,division_id,round_id,created_by) VALUES ($1,$2,$3,$4,$5)', [f.id, s.id, d.id, r.id, user.id]);
          games++;
        }
      }
      await audit(c, user.id, 'competition.fixtures_generate', 'competition_division', d.id);
      return { division_id: d.id, rounds: plan.length, fixtures: games, teams: teams.length };
    });
  },
});

cap({
  name: 'link_competition_fixture', method: 'POST', path: '/fixtures/:id/competition-link', tag: TAG, status: 201,
  summary: 'Attach an existing canonical fixture of the season’s event to a division and round, without copying it. Both teams must be accepted members of that division. Its result keeps flowing through the normal scoring.',
  input: z.object({ id, division_id: id, round_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!f) throw notFound('Fixture');
      const d = await divisionRow(c, i.division_id);
      const { s } = await manageSeason(c, user, d.season_id, { lock: true });
      if (f.event_id !== s.event_id) throw badRequest('This fixture belongs to a different event than the season');
      if (d.archived_at) throw conflict('This division is archived');
      const ok = await c.query("SELECT count(*)::int AS n FROM comp_memberships WHERE division_id=$1 AND status='accepted' AND team_id = ANY($2)", [d.id, [f.home_team_id, f.away_team_id]]);
      if (ok.rows[0].n !== 2) throw badRequest('Both teams must be accepted members of this division');
      if (i.round_id && (await c.query('SELECT 1 FROM comp_rounds WHERE id=$1 AND division_id=$2', [i.round_id, d.id])).rowCount === 0) throw badRequest('Choose a round of this division');
      try {
        const l = (await c.query('INSERT INTO comp_fixture_links(fixture_id,season_id,division_id,round_id,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [f.id, s.id, d.id, i.round_id ?? null, user.id])).rows[0];
        await audit(c, user.id, 'competition.fixture_link', 'fixture', f.id);
        return l;
      } catch (e) { if (e.code === '23505') throw conflict('This fixture is already part of a division'); throw e; }
    });
  },
});

cap({
  name: 'list_division_fixtures', method: 'GET', path: '/divisions/:id/fixtures', tag: TAG, auth: 'public',
  summary: 'A division’s fixtures grouped by round, with the canonical result, any forfeit decision and any postponement. Paginated by fixture.',
  input: z.object({ id, round_id: id.optional(), status: z.enum(['scheduled', 'live', 'completed', 'cancelled', 'postponed']).optional(), ...page }),
  async handler({ user }, i) {
    const d = await divisionRow(pool, i.id);
    await readSeason(pool, user, d.season_id);
    const rows = await many(
      `SELECT f.id,f.scheduled_at,f.status,f.home_score,f.away_score,f.home_team_id,f.away_team_id,h.name AS home_name,a.name AS away_name,
              l.round_id,r.number AS round_number,r.label AS round_label,l.outcome,l.outcome_reason,l.postponed_reason
         FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN comp_rounds r ON r.id=l.round_id
        WHERE l.division_id=$1 AND ($2::uuid IS NULL OR l.round_id=$2) AND ($3::text IS NULL OR f.status=$3) ORDER BY r.number NULLS LAST, f.scheduled_at, f.id LIMIT ${i.limit} OFFSET ${i.offset}`, [d.id, i.round_id ?? null, i.status ?? null]);
    const rounds = await many('SELECT id,number,label,starts_on,ends_on FROM comp_rounds WHERE division_id=$1 ORDER BY number', [d.id]);
    return { rounds, items: rows, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'decide_competition_fixture', method: 'POST', path: '/competition-fixtures/:id/decision', tag: TAG,
  summary: 'Record an administrative decision on a division fixture without editing the match result: a forfeit (home, away or both, with a reason — the table applies the season’s forfeit rule), a postponement, a reschedule to a new date and time, or a move to another round.',
  input: z.object({ id, outcome: z.enum(['played', 'forfeit_home', 'forfeit_away', 'double_forfeit']).optional(), postpone: z.boolean().optional(), scheduled_at: z.string().datetime({ offset: true }).optional(), round_id: id.optional(), outside_window: z.boolean().optional().describe('confirm a kick-off outside the round\'s scheduling window'), reason: z.string().trim().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l = (await c.query('SELECT * FROM comp_fixture_links WHERE fixture_id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!l) throw notFound('Fixture');
      await manageSeason(c, user, l.season_id, { lock: true });
      const f = (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!i.outcome && i.postpone === undefined && !i.scheduled_at && !i.round_id) throw badRequest('Nothing to decide');
      if (i.outcome && i.outcome !== 'played' && (await c.query('SELECT 1 FROM comp_standing_snapshots WHERE division_id=$1', [l.division_id])).rowCount) throw conflict('This division’s table is frozen');
      if (i.round_id && (await c.query('SELECT 1 FROM comp_rounds WHERE id=$1 AND division_id=$2', [i.round_id, l.division_id])).rowCount === 0) throw badRequest('Choose a round of this division');
      const round = l.round_id ? (await c.query('SELECT * FROM comp_rounds WHERE id=$1', [l.round_id])).rows[0] : null;
      if (round?.closed_at && (i.scheduled_at || i.postpone !== undefined || i.round_id || (i.outcome && i.outcome !== 'played'))) throw conflict(`${round.label} is closed; reopen it to change its games`, { code: 'round_closed' });
      if (i.scheduled_at || i.postpone !== undefined) {
        if (f.status === 'completed') throw conflict('A completed game cannot be rescheduled; its result is canonical');
        if (i.scheduled_at && round?.window_enforced && (round.starts_on || round.ends_on) && !i.outside_window) {
          const d = i.scheduled_at.slice(0, 10);
          if ((round.starts_on && d < ymd(round.starts_on)) || (round.ends_on && d > ymd(round.ends_on))) throw conflict(`That date is outside ${round.label}'s scheduling window (${ymd(round.starts_on) ?? '…'} to ${ymd(round.ends_on) ?? '…'}). Confirm it with outside_window, or move the game to another round.`, { code: 'outside_round_window', starts_on: ymd(round.starts_on), ends_on: ymd(round.ends_on) });
        }
        const status = i.postpone ? 'postponed' : 'scheduled';
        await c.query('UPDATE fixtures SET status=$2, scheduled_at=coalesce($3, scheduled_at) WHERE id=$1', [f.id, status, i.scheduled_at ?? null]);
        await c.query('INSERT INTO comp_schedule_changes(season_id,division_id,fixture_id,action,from_at,to_at,reason,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [l.season_id, l.division_id, f.id, i.postpone ? 'postponed' : f.status === 'postponed' ? 'restored' : 'rescheduled', f.scheduled_at, i.scheduled_at ?? f.scheduled_at, i.reason, user.id]);
      }
      const r = (await c.query(
        `UPDATE comp_fixture_links SET outcome=coalesce($2,outcome), outcome_reason=CASE WHEN $2::text IS NULL THEN outcome_reason ELSE $3 END, outcome_by=CASE WHEN $2::text IS NULL THEN outcome_by ELSE $4 END,
                postponed_reason=CASE WHEN $5::boolean IS TRUE THEN $3 WHEN $5::boolean IS FALSE THEN NULL ELSE postponed_reason END, round_id=coalesce($6,round_id) WHERE fixture_id=$1 RETURNING *`,
        [f.id, i.outcome ?? null, i.reason, user.id, i.postpone ?? null, i.round_id ?? null])).rows[0];
      await audit(c, user.id, `competition.fixture_${i.outcome ?? (i.postpone ? 'postpone' : 'reschedule')}`, 'fixture', f.id);
      return r;
    });
  },
});

// ------------------------------------------------------------------ standings & adjustments
/** Is this division's sport ranked by time / distance / weight / judged score (a meet series) rather than played as two-sided fixtures? */
export async function sportModel(c, d) {
  const r = (await c.query('SELECT sp.scoring FROM comp_seasons s JOIN comp_competitions cm ON cm.id=s.competition_id JOIN sports sp ON sp.id=cm.sport_id WHERE s.id=$1', [d.season_id])).rows[0];
  return tableModelOf(r?.scoring);
}
export const isRanked = async (c, d) => (await sportModel(c, d)).model === 'ranked_meets';
export async function liveTable(c, d, rv) {
  const teams = await acceptedTeams(c, d.id);
  if (await isRanked(c, d)) {
    const meets = (await c.query("SELECT rd.id, coalesce(jsonb_agg(jsonb_build_object('team_id', m.team_id, 'position', m.position, 'status', m.status)) FILTER (WHERE m.team_id IS NOT NULL), '[]') AS results FROM comp_rounds rd LEFT JOIN comp_meet_results m ON m.round_id=rd.id WHERE rd.division_id=$1 GROUP BY rd.id", [d.id])).rows;
    const adj = (await c.query('SELECT team_id, points_delta FROM comp_adjustments WHERE division_id=$1', [d.id])).rows;
    return { teams, table: computeRankedStandings(teams, meets, rv.rules, adj), fixtures: [] };
  }
  const fixtures = (await c.query("SELECT f.home_team_id,f.away_team_id,f.status,f.home_score,f.away_score,l.outcome FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.division_id=$1 AND f.status<>'cancelled'", [d.id])).rows;
  const adj = (await c.query('SELECT team_id, points_delta FROM comp_adjustments WHERE division_id=$1', [d.id])).rows;
  return { teams, table: computeStandings(teams, fixtures, rv.rules, adj), fixtures };
}

cap({
  name: 'get_division_standings', method: 'GET', path: '/divisions/:id/standings', tag: TAG, auth: 'public',
  summary: 'The division table computed from canonical results with the season’s versioned rules (points, head-to-head and other tie-breakers, forfeits) plus separately recorded adjustments. Once the season is completed it returns the frozen table and its hash, so it reads the same forever.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = await divisionRow(pool, i.id);
    const { s, cm } = await readSeason(pool, user, d.season_id);
    const sport = await one('SELECT scoring FROM sports WHERE id=$1', [cm.sport_id]);
    const snap = (await pool.query('SELECT * FROM comp_standing_snapshots WHERE division_id=$1', [d.id])).rows[0];
    const unit = unitFor(sport?.scoring);
    const adjustments = await many('SELECT a.id,a.team_id,t.name AS team_name,a.points_delta,a.reason,a.reverses_id,a.created_at FROM comp_adjustments a JOIN teams t ON t.id=a.team_id WHERE a.division_id=$1 ORDER BY a.created_at, a.id', [d.id]);
    if (snap) return { division: { id: d.id, name: d.name, tier: d.tier }, season: { id: s.id, label: s.label, status: s.status }, source: 'snapshot', rule_version: snap.rule_version, table: snap.table_json, hash: snap.hash, frozen_at: snap.created_at, adjustments, unit };
    const rv = await currentRules(pool, s.id);
    const { table } = await liveTable(pool, d, rv);
    return { division: { id: d.id, name: d.name, tier: d.tier }, season: { id: s.id, label: s.label, status: s.status }, source: 'live', rule_version: rv.version, table, hash: tableHash(table, rv.version), adjustments, unit };
  },
});

cap({
  name: 'add_standing_adjustment', method: 'POST', path: '/divisions/:id/adjustments', tag: TAG, status: 201,
  summary: 'Record an administrative points adjustment (a deduction or award) for a team in a division, with a mandatory reason. It never edits a match result and is append-only; correct a mistake with a reversing entry (reverses_id). Not possible once the table is frozen.',
  input: z.object({ id, team_id: id, points_delta: z.number().int().min(-100).max(100).refine((n) => n !== 0, 'Use a non-zero amount').optional(), reason: z.string().trim().min(3).max(500), reverses_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await divisionRow(c, i.id, { lock: true });
      await manageSeason(c, user, d.season_id);
      if ((await c.query('SELECT 1 FROM comp_standing_snapshots WHERE division_id=$1', [d.id])).rowCount) throw conflict('This division’s table is frozen');
      if (!(await c.query("SELECT 1 FROM comp_memberships WHERE division_id=$1 AND team_id=$2 AND status='accepted'", [d.id, i.team_id])).rowCount) throw badRequest('That team is not in this division');
      let delta = i.points_delta;
      if (i.reverses_id) {
        const o = (await c.query('SELECT * FROM comp_adjustments WHERE id=$1 AND division_id=$2 AND team_id=$3', [i.reverses_id, d.id, i.team_id])).rows[0];
        if (!o || o.reverses_id) throw badRequest('Choose an adjustment of this team to reverse');
        delta = -o.points_delta;
      }
      if (!delta) throw badRequest('Give the points to add or take away');
      try {
        const a = (await c.query('INSERT INTO comp_adjustments(season_id,division_id,team_id,points_delta,reason,reverses_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [d.season_id, d.id, i.team_id, delta, i.reason, i.reverses_id ?? null, user.id])).rows[0];
        await audit(c, user.id, 'competition.adjustment', 'competition_division', d.id);
        return a;
      } catch (e) { if (e.code === '23505') throw conflict('That adjustment has already been reversed'); throw e; }
    });
  },
});

cap({
  name: 'list_standing_adjustments', method: 'GET', path: '/divisions/:id/adjustments', tag: TAG, auth: 'public',
  summary: 'The adjustments applied to a division’s table, with reasons and who recorded them, so every point that is not from a result can be explained. Paginated.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const d = await divisionRow(pool, i.id);
    await readSeason(pool, user, d.season_id);
    const rows = await many('SELECT a.id,a.team_id,t.name AS team_name,a.points_delta,a.reason,a.reverses_id,a.created_at,u.display_name AS by FROM comp_adjustments a JOIN teams t ON t.id=a.team_id JOIN users u ON u.id=a.created_by WHERE a.division_id=$1 ORDER BY a.created_at, a.id LIMIT $2 OFFSET $3', [d.id, i.limit, i.offset]);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});

// ------------------------------------------------------------------ completing a season, promotion / relegation
cap({
  name: 'complete_season', method: 'POST', path: '/seasons/:id/complete', tag: TAG,
  summary: 'Finish an active season: every division’s final table is frozen with the rule version and a hash, the champion is recorded and the event is completed. Unfinished games block it unless force=true (they are then ignored). Afterwards divisions, teams, rounds and tables cannot change.',
  input: z.object({ id, force: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await manageSeason(c, user, i.id, { lock: true });
      if (s.status !== 'active') throw conflict('Only an active season can be completed', { code: 'not_active' });
      const open = (await c.query("SELECT count(*)::int AS n FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.season_id=$1 AND f.status NOT IN ('completed','cancelled') AND l.outcome='played'", [s.id])).rows[0].n;
      const ranked = (await sportModel(c, { season_id: s.id })).model === 'ranked_meets';
      const meetsOpen = ranked ? (await c.query("SELECT count(*)::int AS n FROM comp_rounds rd JOIN comp_divisions d ON d.id=rd.division_id WHERE rd.season_id=$1 AND d.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM comp_meet_results m WHERE m.round_id=rd.id)", [s.id])).rows[0].n : 0;
      if ((open + meetsOpen) && !i.force) throw conflict(`${open + meetsOpen} games or meets are not finished`, { code: 'games_open', open: open + meetsOpen });
      const rv = await currentRules(c, s.id);
      const divs = (await c.query('SELECT * FROM comp_divisions WHERE season_id=$1 AND archived_at IS NULL ORDER BY tier, name', [s.id])).rows;
      const tops = [];
      for (const d of divs) {
        const { teams, table } = await liveTable(c, d, rv);
        await c.query('INSERT INTO comp_standing_snapshots(season_id,division_id,rule_version,table_json,members_json,hash,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [s.id, d.id, rv.version, JSON.stringify(table), JSON.stringify(teams), tableHash(table, rv.version), user.id]);
        if (d.tier === divs.find((x) => x.kind !== 'playoff')?.tier && d.kind !== 'playoff' && table[0]?.played > 0) tops.push(table[0].team_id);
      }
      // a knockout play-off stage decides the champion when its final has been played; otherwise the single top-tier table does
      const final = (await c.query("SELECT f.winner_team_id FROM comp_divisions d JOIN comp_fixture_links l ON l.division_id=d.id JOIN fixtures f ON f.id=l.fixture_id WHERE d.season_id=$1 AND d.stage_format='knockout' AND f.round_kind='final' AND f.status='completed' AND f.winner_team_id IS NOT NULL ORDER BY f.scheduled_at DESC LIMIT 1", [s.id])).rows[0];
      const champion = final?.winner_team_id ?? (tops.length === 1 ? tops[0] : null);           // several top-tier divisions have no single champion until a playoff is recorded
      const r = (await c.query("UPDATE comp_seasons SET status='completed', completed_at=now(), champion_team_id=$2 WHERE id=$1 RETURNING *", [s.id, champion])).rows[0];
      await c.query("UPDATE events SET status='completed' WHERE id=$1", [s.event_id]);
      await audit(c, user.id, 'competition.season_complete', 'competition_season', s.id);
      return { ...dates(r), divisions_frozen: divs.length };
    });
  },
});

cap({
  name: 'propose_season_movements', method: 'POST', path: '/seasons/:id/movements/propose', tag: TAG,
  summary: 'Compute season-end movement from the frozen tables and the rule version’s promote / relegate / playoff / qualify counts: champion, promotion, relegation, playoff, qualification or stay for every team. Proposals only — nothing is created for next season until a person confirms them. Re-running refreshes unconfirmed proposals.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await manageSeason(c, user, i.id, { lock: true, open: false });
      if (s.status !== 'completed') throw conflict('Complete the season first', { code: 'not_completed' });
      const snaps = (await c.query('SELECT sn.*, d.tier, d.name FROM comp_standing_snapshots sn JOIN comp_divisions d ON d.id=sn.division_id WHERE sn.season_id=$1 ORDER BY d.tier, d.name', [s.id])).rows;
      const rv = await currentRules(c, s.id);
      const props = proposeMovements(snaps.map((sn) => ({ id: sn.division_id, tier: sn.tier, table: sn.table_json, rules: rv.rules })));
      for (const p of props) {
        const target = p.to_tier !== snaps.find((x) => x.division_id === p.from_division_id).tier ? `Tier ${p.to_tier}` : null;
        await c.query("INSERT INTO comp_movements(season_id,team_id,from_division_id,kind,rank,to_division_name,to_tier,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (season_id,team_id) DO UPDATE SET from_division_id=EXCLUDED.from_division_id, kind=EXCLUDED.kind, rank=EXCLUDED.rank, to_division_name=EXCLUDED.to_division_name, to_tier=EXCLUDED.to_tier WHERE comp_movements.status='proposed'", [s.id, p.team_id, p.from_division_id, p.kind, p.rank, target, p.to_tier, user.id]);
      }
      await audit(c, user.id, 'competition.movements_propose', 'competition_season', s.id);
      return { proposed: props.length };
    });
  },
});

cap({
  name: 'list_season_movements', method: 'GET', path: '/seasons/:id/movements', tag: TAG,
  summary: 'The proposed and confirmed season-end movements (promotion, relegation, playoff, qualification, champion, stay) with each team’s final rank. Staff only. Paginated.',
  input: z.object({ id, status: z.enum(['proposed', 'confirmed', 'declined']).optional(), ...page }),
  async handler({ user }, i) {
    await manageSeason(pool, user, i.id, { open: false });
    const rows = await many(
      `SELECT m.id,m.team_id,t.name AS team_name,m.from_division_id,d.name AS from_division,d.tier AS from_tier,m.kind,m.rank,m.to_tier,m.status,m.next_season_id,m.next_membership_id,m.decided_at
         FROM comp_movements m JOIN teams t ON t.id=m.team_id JOIN comp_divisions d ON d.id=m.from_division_id WHERE m.season_id=$1 AND ($2::text IS NULL OR m.status=$2) ORDER BY d.tier, d.name, m.rank LIMIT ${i.limit} OFFSET ${i.offset}`, [i.id, i.status ?? null]);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'confirm_season_movements', method: 'POST', path: '/seasons/:id/movements/confirm', tag: TAG,
  summary: 'A person confirms or declines proposed movements. Each confirmed team gets an invitation (a next-season membership in the division you choose) — the team manager still accepts it. Nothing is created without this step, and the finished season is not changed.',
  input: z.object({ id, next_season_id: id, decisions: z.array(z.object({ movement_id: id, action: z.enum(['confirm', 'decline']), division_id: id.optional() })).min(1).max(256) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await manageSeason(c, user, i.id, { lock: true, open: false });
      if (s.status !== 'completed' && s.status !== 'archived') throw conflict('Complete the season first');
      const next = await seasonRow(c, i.next_season_id, { lock: true });
      if (next.competition_id !== s.competition_id || next.id === s.id) throw badRequest('Choose another season of this competition');
      if (CLOSED.has(next.status)) throw conflict('The next season is closed');
      let invited = 0, declined = 0;
      for (const dec of i.decisions) {
        const m = (await c.query('SELECT * FROM comp_movements WHERE id=$1 AND season_id=$2 FOR UPDATE', [dec.movement_id, s.id])).rows[0];
        if (!m) throw notFound('Movement');
        if (m.status !== 'proposed') throw conflict('That movement was already decided', { code: 'already_decided', movement_id: m.id });
        if (dec.action === 'decline') { await c.query("UPDATE comp_movements SET status='declined', decided_by=$2, decided_at=now() WHERE id=$1", [m.id, user.id]); declined++; continue; }
        if (!dec.division_id) throw badRequest('Choose the next-season division for each confirmed team');
        const d = await divisionRow(c, dec.division_id);
        if (d.season_id !== next.id || d.archived_at) throw badRequest('Choose a division of the next season');
        if ((await c.query("SELECT 1 FROM comp_memberships WHERE season_id=$1 AND team_id=$2 AND status IN ('applied','invited','accepted','waitlisted')", [next.id, m.team_id])).rowCount) throw conflict('A team is already registered for the next season', { code: 'already_registered', team_id: m.team_id });
        const mem = (await c.query("INSERT INTO comp_memberships(season_id,division_id,team_id,status,source_movement_id,created_by) VALUES ($1,$2,$3,'invited',$4,$5) RETURNING *", [next.id, d.id, m.team_id, m.id, user.id])).rows[0];
        await logMembership(c, mem, 'invited', user.id, { reason: `Season-end ${m.kind} from rank ${m.rank}` });
        await c.query("UPDATE comp_movements SET status='confirmed', next_season_id=$2, next_membership_id=$3, decided_by=$4, decided_at=now() WHERE id=$1", [m.id, next.id, mem.id, user.id]);
        const team = (await c.query('SELECT owner_id,name FROM teams WHERE id=$1', [m.team_id])).rows[0];
        await notify(c, team.owner_id, { kind: 'competition_invitation', title: `${team.name} is invited to ${next.label}`, body: `Place in ${d.name}. Accept it in the competition.`, data: { season_id: next.id, membership_id: mem.id } });
        invited++;
      }
      await audit(c, user.id, 'competition.movements_confirm', 'competition_season', s.id);
      return { invited, declined };
    });
  },
});

// ------------------------------------------------------------------ history & reports
cap({
  name: 'get_competition_history', method: 'GET', path: '/competitions/:id/history', tag: TAG, auth: 'public',
  summary: 'Season-by-season archive of a competition: champion, divisions, the frozen final tables and the teams that took part. Completed seasons are read from their frozen records, so later rule, team or division changes never rewrite them. Paginated by season.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await readComp(pool, user, i.id);
    const seasons = (await many("SELECT s.id,s.label,s.starts_on,s.ends_on,s.champion_team_id,t.name AS champion_name FROM comp_seasons s LEFT JOIN teams t ON t.id=s.champion_team_id WHERE s.competition_id=$1 AND s.status IN ('completed','archived') ORDER BY s.starts_on DESC LIMIT $2 OFFSET $3", [i.id, i.limit, i.offset])).map(dates);
    const out = [];
    for (const s of seasons) {
      const snaps = await many('SELECT sn.division_id,d.name,d.tier,sn.rule_version,sn.table_json AS table,sn.members_json AS members,sn.hash FROM comp_standing_snapshots sn JOIN comp_divisions d ON d.id=sn.division_id WHERE sn.season_id=$1 ORDER BY d.tier, d.name', [s.id]);
      out.push({ ...s, divisions: snaps });
    }
    return { items: out, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'get_season_report', method: 'GET', path: '/seasons/:id/report', tag: TAG,
  summary: 'Season report for the organiser: teams per division, games scheduled / played / forfeited / postponed, scored totals, adjustments and movements. format=csv returns one row per team in the live or frozen tables for sharing.',
  input: z.object({ id, format: z.enum(['json', 'csv']).default('json') }),
  async handler({ user }, i) {
    const { s } = await manageSeason(pool, user, i.id, { open: false });
    const rv = await currentRules(pool, s.id);
    const divs = await many('SELECT * FROM comp_divisions WHERE season_id=$1 AND archived_at IS NULL ORDER BY tier, name', [s.id]);
    const rows = [], csv = [], cols = ['division', 'rank', 'team', 'played', 'won', 'drawn', 'lost', 'for', 'against', 'adjustment', 'points'];
    for (const d of divs) {
      const snap = (await pool.query('SELECT table_json FROM comp_standing_snapshots WHERE division_id=$1', [d.id])).rows[0];
      const table = snap ? snap.table_json : (await liveTable(pool, d, rv)).table;
      const fx = await one(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE f.status='completed')::int AS played, count(*) FILTER (WHERE l.outcome<>'played')::int AS forfeits, count(*) FILTER (WHERE f.status='postponed')::int AS postponed
           FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.division_id=$1`, [d.id]);
      const adj = (await one('SELECT count(*)::int AS n FROM comp_adjustments WHERE division_id=$1', [d.id])).n;
      rows.push({ division_id: d.id, name: d.name, tier: d.tier, teams: table.length, ...fx, adjustments: adj, frozen: !!snap });
      for (const r of table) csv.push({ division: d.name, rank: r.rank, team: r.name, played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, for: r.for, against: r.against, adjustment: r.adjustment, points: r.points });
    }
    const movements = await one("SELECT count(*) FILTER (WHERE status='proposed')::int AS proposed, count(*) FILTER (WHERE status='confirmed')::int AS confirmed FROM comp_movements WHERE season_id=$1", [s.id]);
    await audit(pool, user.id, 'competition.report', 'competition_season', s.id);
    return i.format === 'csv' ? { filename: `season-${s.label.replace(/[^\w-]+/g, '-')}.csv`, content_type: 'text/csv', content: toCsv(cols, csv) } : { season: { id: s.id, label: s.label, status: s.status }, rule_version: rv.version, divisions: rows, movements };
  },
});
