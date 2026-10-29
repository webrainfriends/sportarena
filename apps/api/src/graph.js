// Canonical Sports Graph helpers (#561). The graph never stores a copy of an entity: a node is (kind, id) and resolves to the canonical row in
// users / organisations / teams / events / venues. Edges, aliases and external ids are the only graph-owned data (migration 124).
import { many, one } from './db.js';
import { isAdmin } from './helpers.js';
import { forbidden, notFound } from './errors.js';
import { canSeeYouth, guardianLink, YOUTH_SQL } from './youth.js';
import { hasOrgGrant } from './org-access.js';
import { canManageTeam } from './capabilities/teams.js';
import { canManage as canManageVenue } from './booking/engine.js';

export const KINDS = ['person', 'organisation', 'team', 'event', 'venue'];
export const RELS = {
  member_of: { from: ['person', 'team', 'organisation'], to: ['organisation'], label: 'is a member of', hierarchy: true },
  part_of: { from: ['organisation', 'team', 'venue'], to: ['organisation'], label: 'is part of', hierarchy: true },
  affiliated_with: { from: ['organisation', 'team'], to: ['organisation'], label: 'is affiliated with', hierarchy: true },
  represents: { from: ['person'], to: ['person'], label: 'represents', hierarchy: false },
  competes_in: { from: ['team', 'person'], to: ['event'], label: 'competes in', hierarchy: false },
  based_at: { from: ['team', 'organisation'], to: ['venue'], label: 'is based at', hierarchy: false },
};
export const SCHEMES = ['federation_licence', 'league_registration', 'club_member_no', 'olympic_id', 'data_provider', 'wikidata', 'other'];

/** Every entity the issue lists, with how this release covers it. Read by AI agents through get_graph_schema. */
export const COVERAGE = [
  ['Person', 'native', 'users'], ['Athlete', 'native', 'users + sport_profiles'], ['Coach', 'native', 'users (role coach)'], ['Official', 'native', 'users (role referee)'],
  ['Doctor', 'native', 'users (role doctor)'], ['Physio', 'native', 'users (role physio)'], ['Agent', 'native', 'graph_edges represents'], ['Guardian', 'native', 'guardian links'],
  ['Organisation', 'native', 'organisations'], ['Federation', 'native', 'governing_bodies (an organisation)'], ['Association', 'native', 'organisations'], ['League', 'native', 'events (kind league) / governing_bodies'],
  ['Club', 'native', 'organisations'], ['Academy', 'native', 'organisations'], ['School/University', 'native', 'organisations'], ['Team', 'native', 'teams'], ['Competition', 'native', 'events'],
  ['Season', 'native', 'org_seasons (timeline)'], ['Division', 'native', 'reg_divisions (shown on registrations)'], ['Event', 'native', 'events'], ['Fixture', 'native', 'fixtures'], ['Match', 'native', 'games'],
  ['Venue', 'native', 'venues'], ['Sponsor', 'native', 'sponsorships (timeline; sponsor owners and the athlete)'], ['Supplier', 'native', 'svc_orders / svc_profiles (organisation timeline, staff)'], ['Contract', 'native', 'player_contracts (timeline, 360)'], ['Opportunity', 'native', 'billboard_responses (timeline)'],
  ['Registration', 'native', 'reg_registrations (timeline)'], ['Accreditation', 'native', 'accreditations (timeline)'], ['Ticket', 'gap', 'no ticketing store exists in the platform yet; nothing to link'], ['Payment', 'native', 'payments (timeline, payer only)'], ['Invoice', 'native', 'invoices (timeline, bill-to and organisation staff)'],
  ['Travel', 'native', 'trips + trip_participants (timeline)'], ['Media rights/assets', 'native', 'mr_assets (timeline)'], ['Health episode', 'native', 'clinical clearances (availability only, consent-gated)'], ['Training session', 'native', 'training_sessions (timeline)'],
  ['Assessment', 'native', 'academy_assessments (timeline, approved only)'], ['Result', 'native', 'game_participants (every sport: outcome, score, rank)'], ['Achievement', 'native', 'awards'],
].map(([entity, status, stored_in]) => ({ entity, status, stored_in }));
// native = search, 360 or timeline read it today; projected = lives in its own canonical table, reachable through the source link; gap = no store exists. No entity is copied.

const SELECTS = {
  person: { sql: `SELECT u.id, u.display_name AS label, '@' || u.handle AS sub, u.avatar_emoji AS emoji FROM users u WHERE u.id = ANY($1::uuid[])` },
  organisation: { sql: `SELECT o.id, o.name AS label, concat_ws(' · ', o.kind, o.city) AS sub, NULL::text AS emoji FROM organisations o WHERE o.id = ANY($1::uuid[]) AND o.status='active'` },
  team: { sql: `SELECT t.id, t.name AS label, concat_ws(' · ', s.name, t.city) AS sub, t.emoji FROM teams t JOIN sports s ON s.id=t.sport_id WHERE t.id = ANY($1::uuid[])` },
  event: { sql: `SELECT e.id, e.name AS label, concat_ws(' · ', s.name, e.kind) AS sub, NULL::text AS emoji FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id = ANY($1::uuid[])` },
  venue: { sql: `SELECT v.id, v.name AS label, v.city AS sub, v.emoji FROM venues v WHERE v.id = ANY($1::uuid[])` },
};

/** Resolve nodes to display rows. Missing (or archived) entities are simply absent, never an error. */
export async function describe(kind, ids) {
  if (!ids.length) return new Map();
  const rows = await many(SELECTS[kind].sql, [ids]);
  return new Map(rows.map((r) => [r.id, { kind, ...r }]));
}

/** How the viewer relates to a person: self | guardian | admin | public, or null when a young person must stay hidden from them. */
export async function personAccess(viewer, personId) {
  if (!(await one('SELECT 1 FROM users WHERE id=$1', [personId]))) return null;
  if (viewer?.id === personId) return 'self';
  if (isAdmin(viewer)) return 'admin';
  if (viewer && (await guardianLink(viewer.id, personId))) return 'guardian';
  const youth = await one(`SELECT 1 FROM users u WHERE u.id=$1 AND ${YOUTH_SQL}`, [personId]);
  if (youth && !(await canSeeYouth(viewer, personId))) return null;
  return 'public';
}
export const ownerLike = (a) => a === 'self' || a === 'guardian' || a === 'admin';

/** May this user change the graph data of this entity (edges leaving it, aliases, external ids)? */
export async function canManageEntity(user, kind, id) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (kind === 'person') return user.id === id || !!(await guardianLink(user.id, id));
  if (kind === 'organisation') return hasOrgGrant(user, id, ['owner', 'admin']);
  if (kind === 'team') { const t = await one('SELECT * FROM teams WHERE id=$1', [id]); return !!t && canManageTeam(user, t); }
  if (kind === 'venue') return canManageVenue(user, id);
  if (kind === 'event') { const e = await one('SELECT organizer_id, organisation_id FROM events WHERE id=$1', [id]); return !!e && (e.organizer_id === user.id || (await hasOrgGrant(user, e.organisation_id, ['owner', 'admin']))); }
  return false;
}
export async function requireEntity(kind, id) {
  const ok = await one({ person: 'SELECT 1 FROM users WHERE id=$1', organisation: "SELECT 1 FROM organisations WHERE id=$1 AND status='active'", team: 'SELECT 1 FROM teams WHERE id=$1', event: 'SELECT 1 FROM events WHERE id=$1', venue: 'SELECT 1 FROM venues WHERE id=$1' }[kind], [id]);
  if (!ok) throw notFound(kind);
}
export const aliasKey = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function need(cond, msg) { if (!cond) throw forbidden(msg); }

export const EDGE_COLS = `e.id, e.from_kind, e.from_id, e.rel, e.to_kind, e.to_id, e.valid_from::text AS valid_from, e.valid_to::text AS valid_to, e.status, e.provenance,
  e.source_authority, e.verification_state, e.verified_at, e.external_ref, e.note, e.row_version, e.created_at`;
