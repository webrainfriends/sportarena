// Season archive (#563): when a season is finished it is SEALED into one immutable bundle — the rule pack it ran under, who was in which division,
// the frozen tables, a digest of every match-day eligibility snapshot, and (once those domains hold rows) transfers and disciplinary decisions —
// with a hash, so a later rule, team or policy change can never rewrite it. The bundle references canonical records; it does not replace them.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { pool, tx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { manageSeason, readSeason, canManageCompetition, comp } from './competitions.js';
import { packOf } from './rule-packs.js';

const TAG = 'Governance';
// jsonb does not keep key order, so the hash is taken over a canonical (sorted-key) form that survives the round trip
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v instanceof Date ? v.toISOString() : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sha = (o) => createHash('sha256').update(JSON.stringify(canon(o))).digest('hex');
const tableExists = async (c, t) => (await c.query('SELECT to_regclass($1) AS r', [t])).rows[0].r != null;

/** Build the bundle from canonical records as they stand now (the season is closed, so they no longer change). */
export async function buildBundle(c, s) {
  const { current } = await packOf(c, s.id);
  const memberships = (await c.query(
    `SELECT m.team_id, t.name AS team, m.division_id, d.name AS division, m.status, m.decided_at FROM comp_memberships m JOIN teams t ON t.id=m.team_id
       LEFT JOIN comp_divisions d ON d.id=m.division_id WHERE m.season_id=$1 ORDER BY d.tier NULLS LAST, t.name`, [s.id])).rows;
  const tables = (await c.query(
    `SELECT sn.division_id, d.name AS division, sn.rule_version, sn.hash, sn.table_json FROM comp_standing_snapshots sn JOIN comp_divisions d ON d.id=sn.division_id WHERE sn.season_id=$1 ORDER BY d.tier, d.name`, [s.id])).rows;
  const elig = (await c.query(
    `SELECT stage, decision, count(*)::int AS n FROM reg_snapshots WHERE event_id=$1 GROUP BY stage, decision ORDER BY stage, decision`, [s.event_id])).rows;
  const adjustments = (await c.query(
    `SELECT id, division_id, team_id, points_delta, reason, reverses_id, created_at FROM comp_adjustments WHERE season_id=$1 ORDER BY created_at, id`, [s.id])).rows;
  const bundle = {
    season: { id: s.id, label: s.label, starts_on: s.starts_on, ends_on: s.ends_on, champion_team_id: s.champion_team_id, completed_at: s.completed_at },
    rule_pack: current ? { pack_id: current.pack_id, version: current.version, name: current.name, hash: current.hash, content: current.content } : null,
    memberships, final_tables: tables, adjustments, eligibility_decisions: elig,
  };
  if (await tableExists(c, 'tr_transfers')) {
    bundle.transfers = (await c.query(
      `SELECT id, kind, status, player_id, from_team_id, to_team_id, effective_on, completed_at FROM tr_transfers WHERE season_id=$1 ORDER BY created_at, id`, [s.id])).rows;
  }
  if (await tableExists(c, 'disc_sanctions')) {
    bundle.disciplinary = (await c.query(
      `SELECT id, case_id, kind, status, subject_user_id, matches, starts_on, ends_on, points, decided_at FROM disc_sanctions WHERE season_id=$1 ORDER BY decided_at, id`, [s.id])).rows;
  }
  return bundle;
}

/** Seal a closed season. Idempotent: an already sealed season returns its seal untouched. */
export async function sealSeason(c, s, userId) {
  const had = (await c.query('SELECT * FROM gov_season_archives WHERE season_id=$1', [s.id])).rows[0];
  if (had) return had;
  const bundle = await buildBundle(c, s);
  const r = (await c.query('INSERT INTO gov_season_archives(season_id,bundle,hash,sealed_by) VALUES ($1,$2,$3,$4) RETURNING *', [s.id, bundle, sha(bundle), userId])).rows[0];
  await audit(c, userId, 'governance.season_seal', 'competition_season', s.id);
  return r;
}

cap({
  name: 'archive_season_pack', method: 'POST', path: '/seasons/:id/archive-pack', tag: TAG, auth: ['organizer', 'admin'],
  summary: 'Seal a completed (or archived) season into its immutable archive: rule pack, memberships, final tables, adjustments, eligibility decisions, transfers and disciplinary decisions, with a hash. Sealing twice returns the same seal.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await manageSeason(c, user, i.id, { lock: true, open: false });
    if (!['completed', 'archived'].includes(s.status)) throw conflict('Complete the season before sealing its archive', { code: 'not_completed' });
    const r = await sealSeason(c, s, user.id);
    return { season_id: s.id, hash: r.hash, sealed_at: r.sealed_at, sealed_by: r.sealed_by };
  }),
});

cap({
  name: 'get_season_archive', method: 'GET', path: '/seasons/:id/archive-pack', tag: TAG, auth: 'public',
  summary: 'The sealed archive of a season. Staff get the full bundle; everyone else gets the public summary (rule pack identity, final tables, champion) — never per-player decisions. The hash is recomputed on read so tampering is evident.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const { s } = await readSeason(pool, user, i.id);
    const r = (await pool.query('SELECT * FROM gov_season_archives WHERE season_id=$1', [s.id])).rows[0];
    if (!r) throw notFound('Season archive');
    const cm = await comp(pool, s.competition_id);
    const staff = await canManageCompetition(user, cm);
    const intact = sha(r.bundle) === r.hash;
    const b = r.bundle;
    if (staff) return { season_id: s.id, sealed_at: r.sealed_at, hash: r.hash, intact, bundle: b };
    return {
      season_id: s.id, sealed_at: r.sealed_at, hash: r.hash, intact,
      summary: { season: b.season, rule_pack: b.rule_pack ? { version: b.rule_pack.version, name: b.rule_pack.name, hash: b.rule_pack.hash } : null, final_tables: b.final_tables, teams: b.memberships.filter((m) => m.status === 'accepted').map((m) => ({ team_id: m.team_id, team: m.team, division: m.division })) },
    };
  },
});
