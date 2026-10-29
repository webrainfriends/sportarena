// Canonical Sports Graph (#561): search, entity identity, effective-dated relationships, aliases and verified external ids. One definition
// feeds REST, OpenAPI and MCP. The graph reads the canonical tables; it owns only edges, aliases and external ids (migration 124).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { blindIndex, decrypt, encrypt } from '../crypto.js';
import { hasOrgGrant } from '../org-access.js';
import { hiddenYouth } from '../youth.js';
import { COVERAGE, EDGE_COLS, KINDS, RELS, SCHEMES, aliasKey, canManageEntity, describe, ownerLike, personAccess, requireEntity } from '../graph.js';

const TAG = 'Sports Graph';
const kind = z.enum(KINDS);
const iso = z.string().date();
const EXT = 'graph_external_ids.value';

/** Walk the entity's own visibility: a person the viewer may not see is a 404, like any other missing record. */
export async function mustSee(viewer, k, entityId) {
  if (k === 'person') { if (!(await personAccess(viewer, entityId))) throw notFound('Person'); return; }
  await requireEntity(k, entityId);
}

/** Edges the viewer may see. Edges that touch a person are visible to that person, their guardian, the other end's managers and admins. */
export async function visibleEdges(viewer, rows) {
  const out = [];
  const people = new Map();
  const access = async (pid) => { if (!people.has(pid)) people.set(pid, await personAccess(viewer, pid)); return people.get(pid); };
  for (const e of rows) {
    const ends = [[e.from_kind, e.from_id], [e.to_kind, e.to_id]];
    let ok = true;
    let touchesPerson = false;
    for (const [k, eid] of ends) if (k === 'person') { touchesPerson = true; if (!(await access(eid))) ok = false; }
    if (!ok) continue;
    if (touchesPerson) {
      let allowed = false;
      for (const [k, eid] of ends) if (k === 'person' ? ownerLike(await access(eid)) : false) allowed = true;
      for (const [k, eid] of ends) if (!allowed && (await canManageEntity(viewer, k, eid))) allowed = true;
      if (!allowed && e.rel !== 'represents' && e.verification_state === 'verified' && e.status === 'active') allowed = true;
      if (!allowed) continue;
    } else if (e.verification_state === 'rejected' || e.status === 'withdrawn') {
      if (!(await canManageEntity(viewer, e.from_kind, e.from_id)) && !(await canManageEntity(viewer, e.to_kind, e.to_id))) continue;
    }
    out.push(e);
  }
  return out;
}
export async function withEnds(rows) {
  const by = {};
  for (const e of rows) for (const [k, i] of [[e.from_kind, e.from_id], [e.to_kind, e.to_id]]) (by[k] ??= new Set()).add(i);
  const maps = {};
  for (const [k, set] of Object.entries(by)) maps[k] = await describe(k, [...set]);
  const label = (k, i) => { const d = maps[k]?.get(i); return d ? { kind: k, id: i, label: d.label, sub: d.sub, emoji: d.emoji } : { kind: k, id: i, label: 'Unavailable', sub: null, emoji: null }; };
  return rows.map((e) => ({ ...e, from: label(e.from_kind, e.from_id), to: label(e.to_kind, e.to_id), rel_label: RELS[e.rel].label }));
}
const snap = async (c, edgeId, action, actor, reason) => c.query(
  `INSERT INTO graph_edge_revisions(edge_id, row_version, action, snapshot, reason, actor_id) SELECT e.id, e.row_version, $2, to_jsonb(e) - 'idempotency_key', $3, $4 FROM graph_edges e WHERE e.id=$1`, [edgeId, action, reason ?? null, actor]);
const userById = async (uid) => one('SELECT id, roles FROM users WHERE id=$1', [uid]);

cap({
  name: 'get_graph_schema', method: 'GET', path: '/graph/schema', tag: TAG, auth: 'public',
  summary: 'What the Sports Graph contains: node kinds, relationship types with the kinds they may join, accepted external-id schemes, and how each entity in the master list is covered (native, or projected from its own canonical table). Read this first as an agent.',
  async handler() {
    return {
      node_kinds: KINDS, relationships: Object.entries(RELS).map(([rel, r]) => ({ rel, label: r.label, from: r.from, to: r.to, hierarchy: r.hierarchy })), external_id_schemes: SCHEMES,
      entities: COVERAGE,
      rules: ['A node is (kind, id) and resolves to the canonical row; the graph stores no copy of a person, team, event, payment or health record.', 'Identities are never merged on a name; only a verified external id resolves an identity.',
        'Relationships are effective-dated (valid_from, valid_to), keep provenance, source authority and verification state, and are ended or withdrawn, never deleted.', 'Every read is filtered by the caller\'s permissions; hidden domains are reported as forbidden or omitted.'],
    };
  },
});

cap({
  name: 'graph_search', method: 'GET', path: '/graph/search', tag: TAG,
  summary: 'Cross-domain search across people, organisations, teams, events and venues by name, handle or alias, or by an exact verified external id (scheme + value). A name match is only ever a candidate and is never merged with another record; matched_by says why a record was found. Young people the caller may not see are never returned.',
  input: z.object({ q: z.string().trim().min(2).max(80).optional(), kinds: z.string().max(120).optional().describe('comma separated node kinds; default all'),
    external_scheme: z.enum(SCHEMES).optional(), external_value: z.string().trim().min(1).max(120).optional(), ...page }),
  async handler({ user }, i) {
    if (!i.q && !(i.external_scheme && i.external_value)) throw badRequest('Search by name, or give an external id scheme and value');
    if (!!i.external_scheme !== !!i.external_value) throw badRequest('Give both the scheme and the value');
    const kinds = i.kinds ? i.kinds.split(',').map((s) => s.trim()).filter(Boolean) : KINDS;
    for (const k of kinds) if (!KINDS.includes(k)) throw badRequest(`Unknown kind ${k}`);
    const rows = [];
    if (i.external_scheme) {
      const hit = await one(`SELECT kind, entity_id FROM graph_external_ids WHERE scheme=$1 AND value_idx=$2 AND verification_state='verified' AND archived_at IS NULL AND kind = ANY($3)`, [i.external_scheme, blindIndex(`${i.external_scheme}|${i.external_value}`), kinds]);
      if (hit) rows.push({ kind: hit.kind, id: hit.entity_id, matched_by: 'external_id', verified_external: true });
    } else {
      const like = `%${i.q.replace(/[%_\\]/g, '\\$&')}%`;
      const key = `%${aliasKey(i.q)}%`;
      const take = i.limit + i.offset;
      const finders = {
        person: `SELECT u.id, 'name' AS matched_by FROM users u WHERE (u.display_name ILIKE $1 OR u.handle ILIKE $1) UNION SELECT a.entity_id, 'alias' FROM graph_aliases a WHERE a.kind='person' AND a.archived_at IS NULL AND a.alias_key LIKE $2`,
        organisation: `SELECT o.id, 'name' FROM organisations o WHERE o.status='active' AND o.name ILIKE $1 UNION SELECT a.entity_id, 'alias' FROM graph_aliases a WHERE a.kind='organisation' AND a.archived_at IS NULL AND a.alias_key LIKE $2`,
        team: `SELECT t.id, 'name' FROM teams t WHERE t.name ILIKE $1 UNION SELECT a.entity_id, 'alias' FROM graph_aliases a WHERE a.kind='team' AND a.archived_at IS NULL AND a.alias_key LIKE $2`,
        event: `SELECT e.id, 'name' FROM events e WHERE e.name ILIKE $1 UNION SELECT a.entity_id, 'alias' FROM graph_aliases a WHERE a.kind='event' AND a.archived_at IS NULL AND a.alias_key LIKE $2`,
        venue: `SELECT v.id, 'name' FROM venues v WHERE v.name ILIKE $1 UNION SELECT a.entity_id, 'alias' FROM graph_aliases a WHERE a.kind='venue' AND a.archived_at IS NULL AND a.alias_key LIKE $2`,
      };
      for (const k of kinds) for (const r of await many(`${finders[k]} LIMIT ${take + 20}`, [like, key])) rows.push({ kind: k, id: r.id, matched_by: r.matched_by, verified_external: false });
    }
    const seen = new Set();
    const uniq = rows.filter((r) => { const s = `${r.kind}:${r.id}`; if (seen.has(s)) return false; seen.add(s); return true; });
    const hidden = await hiddenYouth(user, uniq.filter((r) => r.kind === 'person').map((r) => r.id));
    const shown = [];
    for (const k of KINDS) {
      const part = uniq.filter((r) => r.kind === k && !hidden.has(r.id));
      const d = await describe(k, part.map((r) => r.id));
      for (const r of part) if (d.has(r.id)) shown.push({ ...r, ...d.get(r.id) });
    }
    shown.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const ids = shown.slice(i.offset, i.offset + i.limit);
    const verified = ids.length ? await many(`SELECT kind, entity_id, scheme FROM graph_external_ids WHERE verification_state='verified' AND archived_at IS NULL AND entity_id = ANY($1::uuid[])`, [ids.map((r) => r.id)]) : [];
    return ids.map((r) => ({ ...r, verified_schemes: verified.filter((v) => v.kind === r.kind && v.entity_id === r.id).map((v) => v.scheme), identity: r.matched_by === 'external_id' ? 'verified' : 'candidate' }));
  },
});

cap({
  name: 'get_graph_entity', method: 'GET', path: '/graph/entities/:kind/:id', tag: TAG,
  summary: 'Identity card for one node: canonical label, aliases and external ids. External id values are shown only to the record\'s owner, guardian, managers and admins (the read is audit-logged); everyone else sees the scheme and whether it is verified.',
  input: z.object({ kind, id }),
  async handler({ user }, i) {
    await mustSee(user, i.kind, i.id);
    const d = (await describe(i.kind, [i.id])).get(i.id);
    if (!d) throw notFound(i.kind);
    const privileged = i.kind === 'person' ? ownerLike(await personAccess(user, i.id)) : await canManageEntity(user, i.kind, i.id);
    const aliases = await many('SELECT id, alias, language FROM graph_aliases WHERE kind=$1 AND entity_id=$2 AND archived_at IS NULL ORDER BY alias_key', [i.kind, i.id]);
    const ext = await many('SELECT id, scheme, value_enc, verification_state, issuer_org_id, verified_at FROM graph_external_ids WHERE kind=$1 AND entity_id=$2 AND archived_at IS NULL AND verification_state <> $3 ORDER BY scheme, created_at', [i.kind, i.id, privileged ? 'none' : 'rejected']);
    if (privileged && ext.length) await audit(null, user.id, 'read_graph_external_ids', i.kind, i.id);
    return { ...d, can_manage: privileged, aliases, external_ids: ext.map(({ value_enc, ...e }) => ({ ...e, value: privileged ? decrypt(value_enc, EXT) : undefined })) };
  },
});

cap({
  name: 'graph_neighbours', method: 'GET', path: '/graph/entities/:kind/:id/neighbours', tag: TAG,
  summary: 'The stable query layer for relationships: every effective-dated edge touching a node, optionally as of a date or for one relationship type. Federation links are included for organisations. Filtered by what the caller may see.',
  input: z.object({ kind, id, rel: z.enum(Object.keys(RELS)).optional(), as_of: iso.optional(), include_ended: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    await mustSee(user, i.kind, i.id);
    const rows = await many(
      `SELECT ${EDGE_COLS} FROM graph_edges e WHERE ((e.from_kind=$1 AND e.from_id=$2) OR (e.to_kind=$1 AND e.to_id=$2)) AND ($3::text IS NULL OR e.rel=$3)
          AND ($4::date IS NULL OR (e.valid_from <= $4 AND (e.valid_to IS NULL OR e.valid_to >= $4)))
          AND ($5 OR $4::date IS NOT NULL OR e.status='active') AND ($4::date IS NOT NULL OR $5 OR e.valid_to IS NULL OR e.valid_to >= current_date)
        ORDER BY e.valid_from DESC, e.id LIMIT 500`, [i.kind, i.id, i.rel ?? null, i.as_of ?? null, i.include_ended]);
    const seen = (await visibleEdges(user, rows)).slice(i.offset, i.offset + i.limit);
    const edges = await withEnds(seen);
    let federation = [];
    if (i.kind === 'organisation' && !i.rel) {
      federation = await many(
        `SELECT l.id, 'governing_body_link' AS source_table, l.effective_from::text AS valid_from, l.effective_to::text AS valid_to, l.status,
                po.id AS parent_org_id, po.name AS parent_name, co.id AS child_org_id, co.name AS child_name
           FROM governing_body_links l JOIN governing_bodies p ON p.id=l.parent_id JOIN organisations po ON po.id=p.organisation_id
           JOIN governing_bodies c ON c.id=l.child_id JOIN organisations co ON co.id=c.organisation_id
          WHERE l.status='recognised' AND (po.id=$1 OR co.id=$1) AND ($2::date IS NULL OR ((l.effective_from IS NULL OR l.effective_from <= $2) AND (l.effective_to IS NULL OR l.effective_to >= $2)))
          ORDER BY l.created_at DESC LIMIT 100`, [i.id, i.as_of ?? null]);
    }
    return { edges, federation_links: federation };
  },
});

// ------------------------------------------------------------------------------------------------------------------ edges
const edgeIn = z.object({
  from_kind: kind, from_id: id, rel: z.enum(Object.keys(RELS)), to_kind: kind, to_id: id, valid_from: iso, valid_to: iso.optional(),
  external_ref: z.string().trim().min(1).max(160).optional(), note: z.string().trim().max(500).optional(), idempotency_key: z.string().min(8).max(80).optional(),
});

async function cycles(c, e) {
  if (!RELS[e.rel].hierarchy || e.from_kind !== 'organisation' || e.to_kind !== 'organisation') return false;
  return (await c.query(
    `WITH RECURSIVE up(id) AS (SELECT $1::uuid UNION SELECT g.to_id FROM graph_edges g JOIN up ON g.from_id=up.id
        WHERE g.from_kind='organisation' AND g.to_kind='organisation' AND g.status='active' AND g.rel IN ('part_of','member_of','affiliated_with')) SELECT 1 FROM up WHERE id=$2`, [e.to_id, e.from_id])).rowCount > 0;
}
async function overlaps(c, e, exceptId = null) {
  return (await c.query(
    `SELECT 1 FROM graph_edges g WHERE g.from_kind=$1 AND g.from_id=$2 AND g.rel=$3 AND g.to_kind=$4 AND g.to_id=$5 AND g.status='active' AND ($8::uuid IS NULL OR g.id <> $8)
        AND g.valid_from <= coalesce($7::date, 'infinity') AND coalesce(g.valid_to, 'infinity') >= $6::date`, [e.from_kind, e.from_id, e.rel, e.to_kind, e.to_id, e.valid_from, e.valid_to ?? null, exceptId])).rowCount > 0;
}

cap({
  name: 'create_graph_edge', method: 'POST', path: '/graph/edges', tag: TAG,
  summary: 'Record an effective-dated relationship between two existing records (organisation hierarchy and memberships, affiliation, agent representation, competition entry, home venue). The caller must manage one end: that end sets the source authority and the other end can verify it. Overlapping duplicates and hierarchy cycles are refused.',
  input: edgeIn,
  async handler({ user }, i) {
    const r = RELS[i.rel];
    if (!r.from.includes(i.from_kind) || !r.to.includes(i.to_kind)) throw badRequest(`A "${i.rel}" relationship cannot join a ${i.from_kind} to a ${i.to_kind}`);
    if (i.valid_to && i.valid_to < i.valid_from) throw badRequest('The end date is before the start date');
    if (i.from_kind === i.to_kind && i.from_id === i.to_id) throw badRequest('A record cannot relate to itself');
    await mustSee(user, i.from_kind, i.from_id); await mustSee(user, i.to_kind, i.to_id);
    const fromOk = await canManageEntity(user, i.from_kind, i.from_id);
    const toOk = !fromOk && (await canManageEntity(user, i.to_kind, i.to_id));
    if (!fromOk && !toOk) throw forbidden('You can only record relationships for records you manage');
    const authority = isAdmin(user) ? 'platform' : fromOk ? (i.from_kind === 'person' ? 'self' : 'organisation') : 'counterparty';
    return tx(async (c) => {
      if (i.idempotency_key) {
        const prior = (await c.query('SELECT * FROM graph_edges WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
        if (prior) return (await withEnds([prior]))[0];
      }
      if (await overlaps(c, i)) throw conflict('That relationship is already recorded for an overlapping period');
      if (await cycles(c, i)) throw conflict('That would make the organisation hierarchy circular');
      const row = (await c.query(
        `INSERT INTO graph_edges(from_kind, from_id, rel, to_kind, to_id, valid_from, valid_to, status, source_authority, external_ref, note, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7::date IS NOT NULL AND $7::date < current_date THEN 'ended' ELSE 'active' END, $8,$9,$10,$11,$12) RETURNING *`,
        [i.from_kind, i.from_id, i.rel, i.to_kind, i.to_id, i.valid_from, i.valid_to ?? null, authority, i.external_ref ?? null, i.note ?? null, i.idempotency_key ?? null, user.id])).rows[0];
      await snap(c, row.id, 'created', user.id);
      await audit(c, user.id, 'create_graph_edge', 'graph_edges', row.id);
      return (await withEnds([row]))[0];
    });
  },
});

async function editableEdge(user, c, edgeId, lock = true) {
  const e = (await c.query(`SELECT * FROM graph_edges WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [edgeId])).rows[0];
  if (!e) throw notFound('Relationship');
  if (!(await visibleEdges(user, [e])).length) throw notFound('Relationship');
  return e;
}
const canTouch = async (user, e) => (await canManageEntity(user, e.from_kind, e.from_id)) || (await canManageEntity(user, e.to_kind, e.to_id));

cap({
  name: 'update_graph_edge', method: 'PATCH', path: '/graph/edges/:id', tag: TAG,
  summary: 'Correct the dates, note or external reference of a relationship. The change is versioned (send the row_version you read), re-opens verification, and the earlier values stay in the history.',
  input: z.object({ id, row_version: z.number().int().min(1), valid_from: iso.optional(), valid_to: iso.nullable().optional(), note: z.string().trim().max(500).nullable().optional(), external_ref: z.string().trim().min(1).max(160).nullable().optional(), reason: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await editableEdge(user, c, i.id);
      if (!(await canTouch(user, e))) throw forbidden('You do not manage either end of this relationship');
      if (e.status === 'withdrawn') throw conflict('This relationship was withdrawn');
      if (e.row_version !== i.row_version) throw conflict('This relationship was changed somewhere else. Reload and try again.', { code: 'stale_version' });
      const next = { ...e, valid_from: i.valid_from ?? e.valid_from, valid_to: i.valid_to === undefined ? e.valid_to : i.valid_to };
      const f = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
      next.valid_from = f(next.valid_from); next.valid_to = f(next.valid_to);
      if (next.valid_to && next.valid_to < next.valid_from) throw badRequest('The end date is before the start date');
      if (await overlaps(c, next, e.id)) throw conflict('That would overlap another record of the same relationship');
      const row = (await c.query(
        `UPDATE graph_edges SET valid_from=$2, valid_to=$3, note=$4, external_ref=$5, verification_state='unverified', verified_by=NULL, verified_at=NULL,
                status=CASE WHEN $3::date IS NOT NULL AND $3::date < current_date THEN 'ended' ELSE 'active' END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [e.id, next.valid_from, next.valid_to ?? null, i.note === undefined ? e.note : i.note, i.external_ref === undefined ? e.external_ref : i.external_ref])).rows[0];
      await snap(c, e.id, 'corrected', user.id, i.reason);
      await audit(c, user.id, 'update_graph_edge', 'graph_edges', e.id);
      return (await withEnds([row]))[0];
    });
  },
});

cap({
  name: 'end_graph_edge', method: 'POST', path: '/graph/edges/:id/end', tag: TAG,
  summary: 'End a relationship on a date, or withdraw one recorded by mistake. Nothing is deleted: the edge stays in the history with its revisions.',
  input: z.object({ id, valid_to: iso.optional(), withdraw: z.boolean().default(false), reason: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await editableEdge(user, c, i.id);
      if (!(await canTouch(user, e))) throw forbidden('You do not manage either end of this relationship');
      if (e.status !== 'active') throw conflict('This relationship has already ended');
      const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
      const to = i.valid_to ?? new Date().toISOString().slice(0, 10);
      if (!i.withdraw && to < day(e.valid_from)) throw badRequest('The end date is before the start date');
      const row = (await c.query(
        `UPDATE graph_edges SET status=$2, valid_to=CASE WHEN $2='withdrawn' THEN valid_to ELSE $3::date END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [e.id, i.withdraw ? 'withdrawn' : 'ended', to])).rows[0];
      await snap(c, e.id, i.withdraw ? 'withdrawn' : 'ended', user.id, i.reason);
      await audit(c, user.id, 'end_graph_edge', 'graph_edges', e.id);
      return (await withEnds([row]))[0];
    });
  },
});

cap({
  name: 'verify_graph_edge', method: 'POST', path: '/graph/edges/:id/verify', tag: TAG,
  summary: 'Confirm or reject a relationship from the other side. The verifier must manage an end the recorder does not (the club confirms the player, the league confirms the club); nobody verifies their own record.',
  input: z.object({ id, decision: z.enum(['verified', 'rejected']), reason: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await editableEdge(user, c, i.id);
      if (e.status === 'withdrawn') throw conflict('This relationship was withdrawn');
      if (e.created_by === user.id) throw forbidden('Someone else has to verify what you recorded');
      const creator = await userById(e.created_by);
      let ok = isAdmin(user);
      for (const [k, eid] of [[e.from_kind, e.from_id], [e.to_kind, e.to_id]]) {
        if (!ok && (await canManageEntity(user, k, eid)) && !(creator && (await canManageEntity(creator, k, eid)))) ok = true;
      }
      if (!ok) throw forbidden('Only the other side of this relationship can verify it');
      const row = (await c.query(
        `UPDATE graph_edges SET verification_state=$2, verified_by=$3, verified_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [e.id, i.decision, user.id])).rows[0];
      await snap(c, e.id, i.decision === 'verified' ? 'verified' : 'rejected', user.id, i.reason);
      await audit(c, user.id, 'verify_graph_edge', 'graph_edges', e.id);
      return (await withEnds([row]))[0];
    });
  },
});

cap({
  name: 'get_graph_edge_history', method: 'GET', path: '/graph/edges/:id/history', tag: TAG,
  summary: 'Every revision of one relationship (created, corrected, verified, ended) with who changed it and why.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const e = await editableEdge(user, { query: (q, p) => many(q, p).then((rows) => ({ rows })) }, i.id, false);
    return many(`SELECT r.id, r.row_version, r.action, r.reason, r.created_at, r.snapshot - 'created_by' AS snapshot, u.display_name AS actor FROM graph_edge_revisions r LEFT JOIN users u ON u.id=r.actor_id WHERE r.edge_id=$1 ORDER BY r.created_at, r.id`, [e.id]);
  },
});

// ------------------------------------------------------------------------------------------------------------------ aliases
cap({
  name: 'add_graph_alias', method: 'POST', path: '/graph/aliases', tag: TAG,
  summary: 'Add a name variant (former name, abbreviation, transliteration) to a record you manage, so search finds it. An alias never merges two records.',
  input: z.object({ kind, entity_id: id, alias: z.string().trim().min(2).max(120), language: z.string().regex(/^[a-z]{2,3}$/).optional() }),
  async handler({ user }, i) {
    await mustSee(user, i.kind, i.entity_id);
    if (!(await canManageEntity(user, i.kind, i.entity_id))) throw forbidden('You can only add aliases to records you manage');
    const key = aliasKey(i.alias);
    if (key.length < 2) throw badRequest('Use letters or numbers in the alias');
    const row = await one(`INSERT INTO graph_aliases(kind, entity_id, alias, alias_key, language, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id, alias, language`, [i.kind, i.entity_id, i.alias, key, i.language ?? null, user.id]);
    if (!row) throw conflict('That alias is already on this record');
    await audit(null, user.id, 'add_graph_alias', i.kind, i.entity_id);
    return row;
  },
});
cap({
  name: 'archive_graph_alias', method: 'POST', path: '/graph/aliases/:id/archive', tag: TAG,
  summary: 'Retire an alias. It is kept for the record but no longer used in search.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await one('SELECT * FROM graph_aliases WHERE id=$1 AND archived_at IS NULL', [i.id]);
    if (!a || !(await canManageEntity(user, a.kind, a.entity_id))) throw notFound('Alias');
    await one('UPDATE graph_aliases SET archived_at=now() WHERE id=$1', [i.id]);
    await audit(null, user.id, 'archive_graph_alias', a.kind, a.entity_id);
    return { id: i.id, archived: true };
  },
});

// ------------------------------------------------------------------------------------------------------------------ external ids
cap({
  name: 'add_graph_external_id', method: 'POST', path: '/graph/external-ids', tag: TAG,
  summary: 'Link a record to an external identifier (federation licence, league registration, club member number, data-provider id). The value is encrypted and starts as claimed; only a verified id resolves identity in search. One id can belong to one record only.',
  input: z.object({ kind, entity_id: id, scheme: z.enum(SCHEMES), value: z.string().trim().min(1).max(120), issuer_org_id: id.optional() }),
  async handler({ user }, i) {
    await mustSee(user, i.kind, i.entity_id);
    if (!(await canManageEntity(user, i.kind, i.entity_id))) throw forbidden('You can only add identifiers to records you manage');
    if (i.issuer_org_id && !(await one("SELECT 1 FROM organisations WHERE id=$1 AND status='active'", [i.issuer_org_id]))) throw notFound('Issuing organisation');
    const idx = blindIndex(`${i.scheme}|${i.value}`);
    return tx(async (c) => {
      if ((await c.query("SELECT 1 FROM graph_external_ids WHERE scheme=$1 AND value_idx=$2 AND archived_at IS NULL AND verification_state <> 'rejected'", [i.scheme, idx])).rowCount) throw conflict('That identifier is already linked to a record');
      const row = (await c.query(`INSERT INTO graph_external_ids(kind, entity_id, scheme, value_enc, value_idx, issuer_org_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, kind, entity_id, scheme, verification_state, issuer_org_id`,
        [i.kind, i.entity_id, i.scheme, encrypt(i.value.trim(), EXT), idx, i.issuer_org_id ?? null, user.id])).rows[0];
      await audit(c, user.id, 'add_graph_external_id', i.kind, i.entity_id);
      return row;
    });
  },
});
cap({
  name: 'verify_graph_external_id', method: 'POST', path: '/graph/external-ids/:id/verify', tag: TAG,
  summary: 'Confirm or reject an external identifier. Only the issuing organisation\'s owners and admins, or a platform admin, can do this; the owner of the record cannot verify their own id.',
  input: z.object({ id, decision: z.enum(['verified', 'rejected']) }),
  async handler({ user }, i) {
    const x = await one('SELECT * FROM graph_external_ids WHERE id=$1 AND archived_at IS NULL', [i.id]);
    if (!x) throw notFound('Identifier');
    const ok = isAdmin(user) || (x.issuer_org_id && (await hasOrgGrant(user, x.issuer_org_id, ['owner', 'admin'])));
    if (!ok) throw notFound('Identifier');
    if (x.created_by === user.id && !isAdmin(user)) throw forbidden('Someone else has to verify what you added');
    const row = await one('UPDATE graph_external_ids SET verification_state=$2, verified_by=$3, verified_at=now() WHERE id=$1 RETURNING id, kind, entity_id, scheme, verification_state, verified_at', [i.id, i.decision, user.id]);
    await audit(null, user.id, 'verify_graph_external_id', x.kind, x.entity_id);
    return row;
  },
});
cap({
  name: 'archive_graph_external_id', method: 'POST', path: '/graph/external-ids/:id/archive', tag: TAG,
  summary: 'Retire an external identifier (the row is kept, the id can be linked elsewhere afterwards).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await one('SELECT * FROM graph_external_ids WHERE id=$1 AND archived_at IS NULL', [i.id]);
    if (!x || !(await canManageEntity(user, x.kind, x.entity_id))) throw notFound('Identifier');
    await one('UPDATE graph_external_ids SET archived_at=now() WHERE id=$1', [i.id]);
    await audit(null, user.id, 'archive_graph_external_id', x.kind, x.entity_id);
    return { id: i.id, archived: true };
  },
});
