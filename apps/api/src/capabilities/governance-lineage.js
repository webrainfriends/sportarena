// Governance lineage (#563): ONE read that resolves where a participant, team, club or governing body sits in the hierarchy
//   international / national → state / regional → league / competition organiser → club / academy / school → team → participant.
// No new store: it walks governing_body_links (recognised bodies), fed_affiliations (club → body, approved), organisations.parent_organisation_id
// (club groups) and teams.organisation_id (team → club). Configurable alternatives are handled by returning every approved affiliation as a branch.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { pool } from '../db.js';
import { notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { lineage } from '../federation.js';

const TAG = 'Governance';
const LEVEL_TIER = { international: 1, continental: 1, national: 1, regional: 2, state: 2, district: 3, league: 3, local: 3 };

const bodyNode = (b) => ({ type: 'body', id: b.id, organisation_id: b.organisation_id, name: b.name, level: b.level, tier: LEVEL_TIER[b.level] ?? 3, country: b.country, abbreviation: b.abbreviation });

async function bodyChain(c, bodyId) {
  const ids = await lineage(bodyId, c);
  if (!ids.length) return [];
  const rows = (await c.query(
    `SELECT b.id, b.organisation_id, b.level, b.country, b.abbreviation, o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id = ANY($1::uuid[])`, [ids])).rows;
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((x) => by.get(x)).filter(Boolean).map(bodyNode).reverse(); // topmost body first
}

/** Everything above an organisation: its recognised governing-body chains (one per approved affiliation) and its parent group. */
async function orgBranches(c, orgId) {
  const org = (await c.query('SELECT id, name, kind, parent_organisation_id FROM organisations WHERE id=$1', [orgId])).rows[0];
  if (!org) return null;
  const own = (await c.query('SELECT id FROM governing_bodies WHERE organisation_id=$1', [orgId])).rows[0];
  const aff = (await c.query(
    `SELECT a.body_id, a.affiliation_no, a.season_year, a.effective_to FROM fed_affiliations a
      WHERE a.organisation_id=$1 AND a.status='approved' AND (a.effective_to IS NULL OR a.effective_to >= current_date) ORDER BY a.season_year DESC`, [orgId])).rows;
  const branches = [];
  if (own) branches.push({ via: 'governing_body', chain: await bodyChain(c, own.id) });
  for (const a of aff) branches.push({ via: 'affiliation', affiliation_no: a.affiliation_no, season_year: a.season_year, chain: await bodyChain(c, a.body_id) });
  let parent = null;
  if (org.parent_organisation_id) parent = (await c.query('SELECT id, name, kind FROM organisations WHERE id=$1', [org.parent_organisation_id])).rows[0] ?? null;
  return { org, branches, parent };
}

cap({
  name: 'get_governance_lineage', method: 'GET', path: '/governance/lineage', tag: TAG, auth: 'user',
  summary: 'Resolve where a governing body, club, team or participant sits in the governance hierarchy (international/national → state/regional → league → club → team → participant), following recognised body links and approved affiliations. A participant can only be resolved by themself or the platform team; every other subject returns public names only.',
  input: z.object({ subject: z.enum(['body', 'organisation', 'team', 'person']), id }),
  async handler({ user }, i) {
    const c = pool;
    const out = { subject: i.subject, id: i.id, levels: [], branches: [] };
    if (i.subject === 'body') {
      const chain = await bodyChain(c, i.id);
      if (!chain.length) throw notFound('Governing body');
      return { ...out, branches: [{ via: 'governing_body', chain }] };
    }
    if (i.subject === 'organisation') {
      const r = await orgBranches(c, i.id);
      if (!r) throw notFound('Organisation');
      return { ...out, organisation: { id: r.org.id, name: r.org.name, kind: r.org.kind }, parent_group: r.parent, branches: r.branches };
    }
    if (i.subject === 'team') {
      const t = (await c.query('SELECT id, name, organisation_id FROM teams WHERE id=$1', [i.id])).rows[0];
      if (!t) throw notFound('Team');
      const o = t.organisation_id ? await orgBranches(c, t.organisation_id) : null;
      return { ...out, team: { id: t.id, name: t.name }, organisation: o ? { id: o.org.id, name: o.org.name, kind: o.org.kind } : null, parent_group: o?.parent ?? null, branches: o?.branches ?? [] };
    }
    // person: private — the participant or the platform team only
    if (!(isAdmin(user) || user.id === i.id)) throw notFound('Person');
    const teams = (await c.query(
      `SELECT t.id, t.name, t.organisation_id FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.status='active' ORDER BY t.name`, [i.id])).rows;
    const placements = [];
    for (const t of teams) {
      const o = t.organisation_id ? await orgBranches(c, t.organisation_id) : null;
      placements.push({ team: { id: t.id, name: t.name }, organisation: o ? { id: o.org.id, name: o.org.name, kind: o.org.kind } : null, parent_group: o?.parent ?? null, branches: o?.branches ?? [] });
    }
    if (user.id !== i.id) await audit(c, user.id, 'governance.read_lineage', 'user', i.id);
    return { ...out, placements };
  },
});
