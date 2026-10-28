// Sports Graph 360 views and the cross-domain timeline (#561). Everything is assembled at read time from the canonical tables, section by
// section, each decided by the caller's relationship to the record; nothing is copied or stored. Sections the caller may not see are
// reported as forbidden (never silently empty), and a person the caller may not see at all is a 404.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { orgFor, hasOrgGrant } from '../org-access.js';
import { isYouth } from '../youth.js';
import { currentClearance } from '../clearance.js';
import { publicCareer } from '../career.js';
import { canManageTeam } from './teams.js';
import { sharedClearance } from './academy-athlete360.js';
import { EDGE_COLS, RELS, canManageEntity, describe, ownerLike, personAccess } from '../graph.js';
import { visibleEdges, withEnds } from './graph.js';

const TAG = 'Sports Graph';
const denied = (reason = 'Not shared with you') => ({ access: 'forbidden', reason });
const ok = (source, data) => ({ access: 'ok', source, data });
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

async function identity(viewer, kind, entityId, privileged) {
  const d = (await describe(kind, [entityId])).get(entityId);
  const aliases = await many('SELECT alias, language FROM graph_aliases WHERE kind=$1 AND entity_id=$2 AND archived_at IS NULL ORDER BY alias_key', [kind, entityId]);
  const ext = await many(`SELECT scheme, verification_state, issuer_org_id, verified_at FROM graph_external_ids WHERE kind=$1 AND entity_id=$2 AND archived_at IS NULL AND verification_state <> 'rejected' ORDER BY scheme`, [kind, entityId]);
  return { ...d, aliases, external_ids: ext, can_manage: privileged };
}
async function relationships(viewer, kind, entityId) {
  const rows = await many(`SELECT ${EDGE_COLS} FROM graph_edges e WHERE ((e.from_kind=$1 AND e.from_id=$2) OR (e.to_kind=$1 AND e.to_id=$2)) AND e.status <> 'withdrawn' ORDER BY e.valid_from DESC, e.id LIMIT 200`, [kind, entityId]);
  return withEnds(await visibleEdges(viewer, rows));
}
/** Moves between clubs, derived from consecutive career stints in one sport (a gap of at most 62 days). Labelled derived, never stored. */
function moves(career) {
  const out = [];
  const bySport = {};
  for (const m of career) (bySport[m.sport_slug] ??= []).push(m);
  for (const list of Object.values(bySport)) {
    const asc = [...list].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    for (let k = 1; k < asc.length; k++) {
      const prev = asc[k - 1], next = asc[k];
      if (!prev.ends_on || prev.club === next.club) continue;
      const gap = (new Date(next.starts_on) - new Date(prev.ends_on)) / 864e5;
      if (gap <= 62) out.push({ on: next.starts_on, from_club: prev.club, to_club: next.club, sport: next.sport, provenance: 'derived', from_membership_id: prev.id, to_membership_id: next.id });
    }
  }
  return out.sort((a, b) => b.on.localeCompare(a.on));
}
const appearances = (userId) => many(
  `SELECT a.id, a.status, a.minutes_played, a.minutes_basis, a.verified_at, f.id AS fixture_id, f.scheduled_at, f.status AS fixture_status, f.home_score, f.away_score,
          t.id AS team_id, t.name AS team, (f.home_team_id = a.team_id) AS is_home, e.id AS event_id, e.name AS competition, s.name AS sport, s.slug AS sport_slug,
          CASE WHEN f.home_team_id = a.team_id THEN at.name ELSE ht.name END AS opponent
     FROM match_appearances a JOIN fixtures f ON f.id=a.fixture_id JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id JOIN teams t ON t.id=a.team_id
     LEFT JOIN teams ht ON ht.id=f.home_team_id LEFT JOIN teams at ON at.id=f.away_team_id
    WHERE a.user_id=$1 AND a.archived_at IS NULL ORDER BY f.scheduled_at DESC, a.id LIMIT 300`, [userId]);
const individualResults = (userId) => many(
  `SELECT g.id AS game_id, g.title, g.starts_at, s.name AS sport, s.slug AS sport_slug, p.outcome, p.rank, p.score, p.score_units, g.competition_id AS event_id
     FROM game_participants p JOIN games g ON g.id=p.game_id JOIN sports s ON s.id=g.sport_id WHERE p.user_id=$1 AND g.status='post-event' ORDER BY g.starts_at DESC, g.id LIMIT 300`, [userId]);
const awardsOf = (userId) => many(`SELECT a.id, a.name, a.kind, a.awarded_at, e.name AS competition, e.id AS event_id FROM awards a LEFT JOIN events e ON e.id=a.event_id WHERE a.user_id=$1 ORDER BY a.awarded_at DESC LIMIT 100`, [userId]);
const contractsOf = (userId) => many(
  `SELECT c.id, c.title, c.role, c.status, c.team_id, t.name AS team, c.event_id, c.ended_on::text AS ended_on, c.created_at, v.starts_on::text AS starts_on, v.ends_on::text AS ends_on
     FROM player_contracts c LEFT JOIN teams t ON t.id=c.team_id LEFT JOIN player_contract_versions v ON v.contract_id=c.id AND v.version=c.current_version
    WHERE c.payee_id=$1 AND c.status IN ('active','completed','terminated') ORDER BY coalesce(v.starts_on, c.created_at::date) DESC, c.id LIMIT 100`, [userId]);
/** Contract terms are the athlete's, their guardian's, and the managers of the contracting team. Money never appears here. */
async function visibleContracts(viewer, access, userId) {
  const rows = await contractsOf(userId);
  if (ownerLike(access)) return rows;
  const out = [];
  for (const r of rows) if (r.team_id) { const t = await one('SELECT * FROM teams WHERE id=$1', [r.team_id]); if (t && (await canManageTeam(viewer, t))) out.push(r); }
  return out;
}
/** Availability only (status and validity), never diagnosis or notes: the athlete or guardian, or an organisation they chose to share with. */
async function availability(viewer, access, userId, orgId) {
  if (ownerLike(access)) {
    const c = await currentClearance(userId);
    return ok('clinical_clearances', { status: c.status, as_of: c.as_of, valid_until: c.valid_until, review_due: c.review_due, source: c.source === 'none' ? 'none' : 'verified clinical decision' });
  }
  if (orgId && (await hasOrgGrant(viewer, orgId, ['owner', 'admin', 'coach']))) {
    const s = await sharedClearance(orgId, userId);
    return s.state === 'shared' ? ok('academy_clearance_shares', s) : denied('The athlete has not shared health availability with this organisation');
  }
  return denied();
}

cap({
  name: 'get_athlete_360', method: 'GET', path: '/graph/athletes/:id/360', tag: TAG,
  summary: 'Universal 360 of one person assembled from the canonical sources, section by section: identity, relationships, career (with derived moves between clubs), competitions played, results in every sport, achievements, contracts (terms only), and health availability (status only, shared by the athlete or guardian). Each section is decided by the caller\'s relationship; sections they cannot see say so. Pass organisation_id to read health availability the athlete shared with that organisation.',
  input: z.object({ id, organisation_id: id.optional() }),
  async handler({ user }, i) {
    const access = await personAccess(user, i.id);
    if (!access) throw notFound('Athlete');
    const youth = await isYouth(i.id);
    const owner = ownerLike(access);
    const limited = youth && !owner;
    const s = {};
    s.identity = ok('users', await identity(user, 'person', i.id, owner));
    s.relationships = ok('graph_edges', await relationships(user, 'person', i.id));
    if (limited) {
      for (const k of ['career', 'competitions', 'results', 'achievements', 'contracts']) s[k] = denied('Shown only to the young person and their guardian');
    } else {
      const career = await publicCareer(i.id);
      s.career = ok('career_memberships', { stints: career, moves: moves(career) });
      const ap = await appearances(i.id);
      const verified = ap.filter((a) => a.minutes_played != null);
      s.competitions = ok('match_appearances', { totals: { matches: ap.filter((a) => a.status !== 'dnp' && a.status !== 'unused_sub').length, verified_minutes: Math.round(verified.reduce((n, a) => n + Number(a.minutes_played), 0)), competitions: new Set(ap.map((a) => a.event_id)).size }, recent: ap.slice(0, 20) });
      const res = await individualResults(i.id);
      s.results = ok('game_participants', { note: 'Outcome, rank and score are recorded in each sport\'s own units', recent: res.slice(0, 20), by_sport: Object.values(res.reduce((m, r) => { (m[r.sport_slug] ??= { sport: r.sport, sport_slug: r.sport_slug, games: 0, wins: 0, podiums: 0 }); m[r.sport_slug].games++; if (r.outcome === 'win') m[r.sport_slug].wins++; if (r.rank && r.rank <= 3) m[r.sport_slug].podiums++; return m; }, {})) });
      s.achievements = ok('awards', await awardsOf(i.id));
      const contracts = await visibleContracts(user, access, i.id);
      s.contracts = owner || contracts.length ? ok('player_contracts', contracts) : denied('Contract terms are shown to the athlete, their guardian and the contracting team');
    }
    s.health = limited ? denied() : await availability(user, access, i.id, i.organisation_id);
    if (s.health.access === 'ok') await audit(null, user.id, 'read_graph_360_health', 'users', i.id);
    await audit(null, user.id, 'read_graph_360', 'users', i.id);
    return { subject: { kind: 'person', id: i.id }, viewer_relation: access, sections: s };
  },
});

cap({
  name: 'get_organisation_360', method: 'GET', path: '/graph/organisations/:id/360', tag: TAG,
  summary: 'Universal 360 of one organisation: identity, effective-dated hierarchy and memberships (graph edges plus recognised federation links), teams, events, venues and seasons for everyone; the people list and counts of verified career stints only for its owners and admins.',
  input: z.object({ id, as_of: z.string().date().optional() }),
  async handler({ user }, i) {
    const org = await one("SELECT id FROM organisations WHERE id=$1 AND status='active'", [i.id]);
    if (!org) throw notFound('Organisation');
    const staff = await canManageEntity(user, 'organisation', i.id);
    const s = {};
    s.identity = ok('organisations', await identity(user, 'organisation', i.id, staff));
    const edges = (await relationships(user, 'organisation', i.id)).filter((e) => !i.as_of || (e.valid_from <= i.as_of && (!e.valid_to || e.valid_to >= i.as_of)));
    const fed = await many(
      `SELECT l.id, po.id AS parent_org_id, po.name AS parent, co.id AS child_org_id, co.name AS child, l.effective_from::text AS valid_from, l.effective_to::text AS valid_to
         FROM governing_body_links l JOIN governing_bodies p ON p.id=l.parent_id JOIN organisations po ON po.id=p.organisation_id JOIN governing_bodies c ON c.id=l.child_id JOIN organisations co ON co.id=c.organisation_id
        WHERE l.status='recognised' AND (po.id=$1 OR co.id=$1) ORDER BY l.created_at DESC LIMIT 100`, [i.id]);
    s.hierarchy = ok('graph_edges + governing_body_links', { edges: edges.filter((e) => RELS[e.rel].hierarchy), federation_links: fed });
    s.teams = ok('teams', await many('SELECT t.id, t.name, t.emoji, s.name AS sport FROM teams t JOIN sports s ON s.id=t.sport_id WHERE t.organisation_id=$1 AND t.parent_team_id IS NULL ORDER BY t.name LIMIT 100', [i.id]));
    s.events = ok('events', await many("SELECT e.id, e.name, e.kind, e.status, e.starts_on::text AS starts_on, e.ends_on::text AS ends_on, s.name AS sport FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.organisation_id=$1 AND e.status <> 'draft' ORDER BY e.starts_on DESC NULLS LAST LIMIT 50", [i.id]));
    s.venues = ok('venues', await many('SELECT v.id, v.name, v.city FROM venues v WHERE v.organisation_id=$1 ORDER BY v.name LIMIT 50', [i.id]));
    s.seasons = ok('org_seasons', await many("SELECT id, name, starts_on::text AS starts_on, ends_on::text AS ends_on, status FROM org_seasons WHERE organisation_id=$1 ORDER BY starts_on DESC LIMIT 20", [i.id]));
    if (staff) {
      s.people = ok('organisation_members', await many(
        `SELECT m.id, m.role, m.status, m.joined_at, u.id AS user_id, u.display_name FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' ORDER BY u.display_name LIMIT 200`, [i.id]));
      s.memberships = ok('career_memberships', (await one(
        `SELECT count(*) FILTER (WHERE c.ends_on IS NULL)::int AS current, count(*)::int AS total, count(*) FILTER (WHERE c.verification_status='verified')::int AS verified
           FROM career_memberships c WHERE c.archived_at IS NULL AND (c.organisation_id=$1 OR c.team_id IN (SELECT id FROM teams WHERE organisation_id=$1))`, [i.id])));
      await audit(null, user.id, 'read_graph_360', 'organisations', i.id);
    } else { s.people = denied('Shown to the organisation\'s owners and admins'); s.memberships = denied('Shown to the organisation\'s owners and admins'); }
    return { subject: { kind: 'organisation', id: i.id }, viewer_relation: staff ? 'staff' : 'public', as_of: i.as_of ?? null, sections: s };
  },
});

const DOMAINS = ['career', 'competition', 'result', 'achievement', 'contract', 'relationship', 'health', 'organisation'];
cap({
  name: 'get_graph_timeline', method: 'GET', path: '/graph/timeline', tag: TAG,
  summary: 'Chronological timeline across domains for a person or an organisation, newest first. Every row names its domain and links back to the source record (table + id); domains the caller may not see are left out and listed in hidden_domains. Page with offset.',
  input: z.object({ kind: z.enum(['person', 'organisation']), id, domains: z.string().max(120).optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(30), organisation_id: id.optional() }),
  async handler({ user }, i) {
    const want = i.domains ? i.domains.split(',').map((x) => x.trim()) : DOMAINS;
    for (const w of want) if (!DOMAINS.includes(w)) throw notFound(`Domain ${w}`);
    const items = [];
    const hidden = [];
    const add = (domain, at, type, title, summary, table, rowId, extra = {}) => { if (at) items.push({ domain, at: day(at), type, title, summary, source: { table, id: rowId }, ...extra }); };
    if (i.kind === 'person') {
      const access = await personAccess(user, i.id);
      if (!access) throw notFound('Person');
      const owner = ownerLike(access);
      const youthLimited = (await isYouth(i.id)) && !owner;
      const gate = (d) => { if (!want.includes(d)) return false; if (youthLimited && d !== 'relationship') { hidden.push(d); return false; } return true; };
      if (gate('career')) {
        const career = await publicCareer(i.id);
        for (const m of career) {
          add('career', m.starts_on, 'joined', `Joined ${m.club}`, [m.sport, m.competition_level, m.position].filter(Boolean).join(' · '), 'career_memberships', m.id, { verification: m.verification_status });
          if (m.ends_on) add('career', m.ends_on, 'left', `Left ${m.club}`, m.sport, 'career_memberships', m.id, { verification: m.verification_status });
        }
        for (const mv of moves(career)) add('career', mv.on, 'transfer', `Moved from ${mv.from_club} to ${mv.to_club}`, mv.sport, 'career_memberships', mv.to_membership_id, { provenance: 'derived' });
      }
      if (gate('competition')) for (const a of await appearances(i.id)) {
        if (a.status === 'dnp') continue;
        const score = a.fixture_status === 'completed' ? ` (${a.is_home ? a.home_score : a.away_score}–${a.is_home ? a.away_score : a.home_score})` : '';
        add('competition', a.scheduled_at, 'appearance', `${a.team} vs ${a.opponent ?? 'TBC'}${score}`, `${a.competition} · ${a.sport}`, 'match_appearances', a.id, { verification: a.verified_at ? 'verified' : 'recorded' });
      }
      if (gate('result')) for (const r of await individualResults(i.id)) add('result', r.starts_at, 'result', r.title, [r.sport, r.outcome, r.rank ? `rank ${r.rank}` : null].filter(Boolean).join(' · '), 'games', r.game_id);
      if (gate('achievement')) for (const a of await awardsOf(i.id)) add('achievement', a.awarded_at, a.kind, a.name, a.competition, 'awards', a.id);
      if (gate('contract')) for (const c of await visibleContracts(user, access, i.id)) add('contract', c.starts_on ?? c.created_at, 'contract', c.title, [c.role, c.team, c.status].filter(Boolean).join(' · '), 'player_contracts', c.id);
      if (gate('relationship')) for (const e of await relationships(user, 'person', i.id)) add('relationship', e.valid_from, e.rel, `${e.from.label} ${e.rel_label} ${e.to.label}`, e.verification_state, 'graph_edges', e.id, { verification: e.verification_state });
      if (want.includes('health')) {
        const h = youthLimited ? denied() : await availability(user, access, i.id, i.organisation_id);
        if (h.access === 'ok' && h.data.status && h.data.status !== 'unknown' && h.data.as_of) {
          add('health', h.data.as_of, 'availability', `Availability: ${String(h.data.status).replace(/_/g, ' ')}`, h.data.valid_until ? `valid until ${day(h.data.valid_until)}` : null, h.source, i.id);
          await audit(null, user.id, 'read_graph_timeline_health', 'users', i.id);
        } else hidden.push('health');
      }
    } else {
      if (!(await one("SELECT 1 FROM organisations WHERE id=$1 AND status='active'", [i.id]))) throw notFound('Organisation');
      if (want.includes('relationship')) for (const e of await relationships(user, 'organisation', i.id)) add('relationship', e.valid_from, e.rel, `${e.from.label} ${e.rel_label} ${e.to.label}`, e.verification_state, 'graph_edges', e.id, { verification: e.verification_state });
      if (want.includes('organisation')) {
        for (const t of await many('SELECT id, name, created_at FROM teams WHERE organisation_id=$1 AND parent_team_id IS NULL', [i.id])) add('organisation', t.created_at, 'team_formed', `Team formed: ${t.name}`, null, 'teams', t.id);
        for (const s of await many('SELECT id, name, starts_on FROM org_seasons WHERE organisation_id=$1', [i.id])) add('organisation', s.starts_on, 'season', `Season ${s.name} began`, null, 'org_seasons', s.id);
      }
      if (want.includes('competition')) for (const e of await many("SELECT id, name, starts_on, kind FROM events WHERE organisation_id=$1 AND status <> 'draft' AND starts_on IS NOT NULL", [i.id])) add('competition', e.starts_on, e.kind, e.name, null, 'events', e.id);
      for (const d of want) if (['career', 'result', 'achievement', 'contract', 'health'].includes(d)) hidden.push(d);
    }
    const sorted = items.sort((a, b) => b.at.localeCompare(a.at) || a.source.id.localeCompare(b.source.id) || a.type.localeCompare(b.type));
    const rows = sorted.slice(i.offset, i.offset + i.limit);
    return { items: rows, next_offset: sorted.length > i.offset + i.limit ? i.offset + i.limit : null, hidden_domains: [...new Set(hidden)], domains: DOMAINS };
  },
});
