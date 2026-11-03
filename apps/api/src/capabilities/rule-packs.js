// Season rule packs (#563): one immutable, versioned bundle of REFERENCES to the rules that govern a season — standings rules (#476), eligibility
// policy (#477), federation policy versions (#475) and local playing rules (#68) — with their resolved content and a hash frozen at publish time.
// A season is pinned to a pack; the pin history is append-only and a completed or archived season keeps the pack it finished under.
// Nothing here edits the underlying versions; it only records which ones applied, so history replays exactly after later rule changes.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx, many } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { lineage } from '../federation.js';
import { pool } from '../db.js';
import { manageComp, readComp, readSeason, manageSeason, asOpen } from './competitions.js';

const TAG = 'Governance';
export const packHash = (content) => createHash('sha256').update(JSON.stringify(content)).digest('hex');

/** Resolve the referenced versions into the frozen content. Every reference must belong to this competition / its governing hierarchy. */
async function resolve(c, cm, i) {
  const content = {};
  let standings = null; let reg = null; let local = null;
  if (i.standings_rule_version_id) {
    standings = (await c.query(
      `SELECT v.* FROM comp_rule_versions v JOIN comp_seasons s ON s.id=v.season_id WHERE v.id=$1 AND s.competition_id=$2`, [i.standings_rule_version_id, cm.id])).rows[0];
    if (!standings) throw badRequest('That standings rule version does not belong to this competition');
    content.standings = standings.rules; content.standings_version = standings.version;
  }
  if (i.reg_policy_id) {
    reg = (await c.query(
      `SELECT p.* FROM reg_policies p JOIN comp_seasons s ON s.event_id=p.event_id WHERE p.id=$1 AND s.competition_id=$2`, [i.reg_policy_id, cm.id])).rows[0];
    if (!reg) throw badRequest('That eligibility policy does not belong to this competition');
    content.eligibility = reg.rules; content.eligibility_version = reg.version; content.eligibility_enforcement = reg.enforcement;
  }
  if (i.fed_policy_version_ids.length) {
    const body = cm.organisation_id ? (await c.query('SELECT id FROM governing_bodies WHERE organisation_id=$1', [cm.organisation_id])).rows[0] : null;
    if (!body) throw badRequest('Federation policies can only be bundled by a competition run by a governing body');
    const chain = await lineage(body.id, c);
    const rows = (await c.query(
      `SELECT v.id, v.version, v.effective_from, v.params, p.kind, p.body_id FROM fed_policy_versions v JOIN fed_policies p ON p.id=v.policy_id WHERE v.id = ANY($1::uuid[])`, [i.fed_policy_version_ids])).rows;
    if (rows.length !== new Set(i.fed_policy_version_ids).size || rows.some((r) => !chain.includes(r.body_id))) throw badRequest('Federation policies must come from this competition\'s governing body or one above it');
    content.federation = rows.map((r) => ({ version_id: r.id, kind: r.kind, version: r.version, effective_from: String(r.effective_from).slice(0, 10), params: r.params }));
  }
  if (i.local_rule_version_id) {
    local = (await c.query('SELECT id, version, settings, base_hash FROM local_rule_versions WHERE id=$1', [i.local_rule_version_id])).rows[0];
    if (!local) throw notFound('Local rule version');
    content.local_rules = { version_id: local.id, version: local.version, settings: local.settings, base_hash: local.base_hash };
  }
  if (!Object.keys(content).length) throw badRequest('A rule pack needs at least one rule reference');
  return content;
}

cap({
  name: 'publish_rule_pack', method: 'POST', path: '/competitions/:id/rule-packs', tag: TAG, status: 201, auth: ['organizer', 'admin'],
  summary: 'Publish an immutable, versioned rule pack for a competition: the standings rules, eligibility policy, federation policy versions and local playing rules that will govern a season, with their content and a hash frozen now. Pin it to a season with pin_season_rule_pack.',
  input: z.object({
    id, name: z.string().trim().min(2).max(120), note: z.string().trim().max(500).optional(),
    standings_rule_version_id: id.optional(), reg_policy_id: id.optional(), fed_policy_version_ids: z.array(id).max(30).default([]), local_rule_version_id: id.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const cm = await manageComp(c, user, i.id, { lock: true });
    const content = await resolve(c, cm, i);
    const version = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM gov_rule_packs WHERE competition_id=$1', [cm.id])).rows[0].v;
    const r = (await c.query(
      `INSERT INTO gov_rule_packs(competition_id,version,name,standings_rule_version_id,reg_policy_id,fed_policy_version_ids,local_rule_version_id,content,hash,note,published_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [cm.id, version, i.name, i.standings_rule_version_id ?? null, i.reg_policy_id ?? null, i.fed_policy_version_ids, i.local_rule_version_id ?? null, content, packHash(content), i.note ?? null, user.id])).rows[0];
    await audit(c, user.id, 'governance.rule_pack_publish', 'rule_pack', r.id);
    return r;
  }),
});

cap({
  name: 'list_rule_packs', method: 'GET', path: '/competitions/:id/rule-packs', tag: TAG,
  summary: 'The rule packs of a competition, newest first, with the seasons each one governs.',
  input: z.object({ id, ...page }),
  handler: async ({ user }, i) => {
    const { staff } = await readComp(pool, user, i.id);
    if (!staff) throw notFound('Competition');
    const rows = await many(
      `SELECT p.id, p.version, p.name, p.hash, p.note, p.backfilled, p.created_at, p.content,
              coalesce((SELECT json_agg(json_build_object('season_id', s.id, 'label', s.label, 'status', s.status) ORDER BY s.starts_on)
                          FROM comp_seasons s WHERE (SELECT pk.pack_id FROM gov_season_rule_pins pk WHERE pk.season_id=s.id ORDER BY pk.pinned_at DESC, pk.id DESC LIMIT 1) = p.id), '[]') AS seasons
         FROM gov_rule_packs p WHERE p.competition_id=$1 ORDER BY p.version DESC LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'pin_season_rule_pack', method: 'POST', path: '/seasons/:id/rule-pack', tag: TAG, auth: ['organizer', 'admin'],
  summary: 'Pin a season to a published rule pack of its competition. The earlier pin stays in the history; a completed or archived season keeps the pack it finished under.',
  input: z.object({ id, pack_id: id, reason: z.string().trim().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await manageSeason(c, user, i.id, { lock: true });
    const pack = (await c.query('SELECT * FROM gov_rule_packs WHERE id=$1 AND competition_id=$2', [i.pack_id, s.competition_id])).rows[0];
    if (!pack) throw notFound('Rule pack');
    try {
      const r = (await c.query('INSERT INTO gov_season_rule_pins(season_id,pack_id,reason,pinned_by) VALUES ($1,$2,$3,$4) RETURNING *', [s.id, pack.id, i.reason ?? null, user.id])).rows[0];
      await c.query('UPDATE comp_seasons SET rule_policy_ref=$2 WHERE id=$1', [s.id, `pack:${pack.id}`.slice(0, 120)]);
      await audit(c, user.id, 'governance.rule_pack_pin', 'competition_season', s.id);
      return { ...r, pack: { id: pack.id, version: pack.version, name: pack.name, hash: pack.hash } };
    } catch (e) { return asOpen(e); }
  }),
});

/** The pack in force for a season, plus the pin history. Readable wherever the season is. */
export async function packOf(c, seasonId) {
  const pins = (await c.query(
    `SELECT k.id, k.reason, k.pinned_at, k.pinned_by, p.id AS pack_id, p.version, p.name, p.hash, p.content, p.backfilled
       FROM gov_season_rule_pins k JOIN gov_rule_packs p ON p.id=k.pack_id WHERE k.season_id=$1 ORDER BY k.pinned_at DESC, k.id DESC`, [seasonId])).rows;
  return { current: pins[0] ?? null, history: pins.slice(1) };
}

cap({
  name: 'get_season_rule_pack', method: 'GET', path: '/seasons/:id/rule-pack', tag: TAG, auth: 'public',
  summary: 'The rule pack a season is governed by (its resolved content and hash) and the history of earlier pins. A completed season returns the pack it finished under, whatever the rules are today.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const { s } = await readSeason(pool, user, i.id);
    return { season_id: s.id, status: s.status, ...(await packOf(pool, s.id)) };
  },
});

