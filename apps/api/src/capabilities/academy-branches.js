// Academy OS 3/3 close-out: branches. A branch groups programmes (and references the canonical venues they use) so the P&L and the executive home
// can be read by location. It holds no venue data and no money; programmes keep exactly one optional branch, branches are archived, never deleted.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { STAFF, STAFF_MONEY } from '../academy.js';

const venueIds = z.array(id).max(30);
const profile = { code: z.string().regex(/^[A-Za-z0-9-]{2,12}$/, 'Use 2-12 letters, digits or dashes').optional(), manager_id: id.optional(), address: z.string().max(200).optional(), opened_on: z.string().date().optional(), athlete_target: z.number().int().min(1).max(100000).optional() };
/** The branch manager must be an active member of this academy: a person already in the workspace, never a free-typed name. */
const checkManager = async (c, orgId, userId) => {
  if (!userId) return;
  if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, userId])).rows.length) throw badRequest('The branch manager must be an active member of this academy');
};
const check = async (c, ids) => {
  if (!ids?.length) return;
  const n = (await c.query('SELECT count(*)::int AS n FROM venues WHERE id = ANY($1::uuid[])', [ids])).rows[0].n;
  if (n !== new Set(ids).size) throw badRequest('One of those venues does not exist');
};

cap({
  name: 'create_academy_branch', method: 'POST', path: '/organisations/:id/academy/branches', tag: 'Academy', status: 201,
  summary: 'Create a branch / location for the academy (owner/admin). A branch groups programmes for reporting and references existing venues; it copies no venue data. Idempotent per idempotency_key.',
  input: z.object({ id, name: z.string().min(2).max(80), city: z.string().max(80).optional(), venue_ids: venueIds.default([]), ...profile, idempotency_key: z.string().min(8).max(80) }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    const prior = (await c.query('SELECT * FROM academy_branches WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
    if (prior) return prior;
    await check(c, i.venue_ids);
    await checkManager(c, i.id, i.manager_id);
    if ((await c.query('SELECT 1 FROM academy_branches WHERE organisation_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL', [i.id, i.name])).rows.length) throw conflict('A branch with that name already exists');
    const r = (await c.query('INSERT INTO academy_branches(organisation_id, name, city, venue_ids, code, manager_id, address, opened_on, athlete_target, created_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [i.id, i.name, i.city ?? null, i.venue_ids, i.code ?? null, i.manager_id ?? null, i.address ?? null, i.opened_on ?? null, i.athlete_target ?? null, user.id, i.idempotency_key])).rows[0];
    await audit(c, user.id, 'create_academy_branch', 'academy_branches', r.id);
    return r;
  }),
});

cap({
  name: 'list_academy_branches', method: 'GET', path: '/organisations/:id/academy/branches', tag: 'Academy',
  summary: 'Branches of the academy with their programmes and referenced venues (owner/admin/finance). Archived branches are included and flagged so history stays readable.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    const branches = await many(
      `SELECT b.*, (SELECT display_name FROM users WHERE id=b.manager_id) AS manager_name, coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'sport', p.sport) ORDER BY p.title, p.id) FROM academy_programmes p WHERE p.branch_id=b.id), '[]') AS programmes,
              coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'city', v.city) ORDER BY v.name, v.id) FROM venues v WHERE v.id = ANY(b.venue_ids)), '[]') AS venues
         FROM academy_branches b WHERE b.organisation_id=$1 ORDER BY (b.archived_at IS NOT NULL), b.name, b.id`, [i.id]);
    const unassigned = await many('SELECT id, title, sport FROM academy_programmes WHERE organisation_id=$1 AND branch_id IS NULL ORDER BY title, id', [i.id]);
    return { branches, unassigned_programmes: unassigned };
  },
});

cap({
  name: 'update_academy_branch', method: 'POST', path: '/academy/branches/:id', tag: 'Academy',
  summary: 'Rename a branch or change its city / referenced venues (owner/admin). Reports for past periods group programmes by their current branch.',
  input: z.object({ id, name: z.string().min(2).max(80).optional(), city: z.string().max(80).nullable().optional(), venue_ids: venueIds.optional(), code: profile.code.nullable(), manager_id: id.nullable().optional(), address: z.string().max(200).nullable().optional(), opened_on: z.string().date().nullable().optional(), athlete_target: z.number().int().min(1).max(100000).nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const b = (await c.query('SELECT * FROM academy_branches WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!b) throw notFound('Branch');
    await orgFor(user, b.organisation_id, STAFF, { write: true, c });
    if (b.archived_at) throw conflict('This branch is archived');
    await check(c, i.venue_ids);
    await checkManager(c, b.organisation_id, i.manager_id);
    if (i.name && (await c.query('SELECT 1 FROM academy_branches WHERE organisation_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL AND id<>$3', [b.organisation_id, i.name, b.id])).rows.length) throw conflict('A branch with that name already exists');
    const has = (k) => i[k] !== undefined;
    const r = (await c.query(
      `UPDATE academy_branches SET name=coalesce($2,name), city=CASE WHEN $3::boolean THEN $4 ELSE city END, venue_ids=coalesce($5,venue_ids),
              code=CASE WHEN $6::boolean THEN $7 ELSE code END, manager_id=CASE WHEN $8::boolean THEN $9 ELSE manager_id END, address=CASE WHEN $10::boolean THEN $11 ELSE address END,
              opened_on=CASE WHEN $12::boolean THEN $13 ELSE opened_on END, athlete_target=CASE WHEN $14::boolean THEN $15 ELSE athlete_target END WHERE id=$1 RETURNING *`,
      [b.id, i.name ?? null, has('city'), i.city ?? null, i.venue_ids ?? null, has('code'), i.code ?? null, has('manager_id'), i.manager_id ?? null, has('address'), i.address ?? null, has('opened_on'), i.opened_on ?? null, has('athlete_target'), i.athlete_target ?? null])).rows[0];
    await audit(c, user.id, 'update_academy_branch', 'academy_branches', b.id);
    return r;
  }),
});

cap({
  name: 'archive_academy_branch', method: 'POST', path: '/academy/branches/:id/archive', tag: 'Academy',
  summary: 'Archive a branch (owner/admin). Its programmes stay attached so past reports keep their grouping; nothing is deleted.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const b = (await c.query('SELECT * FROM academy_branches WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!b) throw notFound('Branch');
    await orgFor(user, b.organisation_id, STAFF, { write: true, c });
    if (b.archived_at) return b;
    const r = (await c.query('UPDATE academy_branches SET archived_at=now(), archived_by=$2 WHERE id=$1 RETURNING *', [b.id, user.id])).rows[0];
    await audit(c, user.id, 'archive_academy_branch', 'academy_branches', b.id);
    return r;
  }),
});

cap({
  name: 'set_academy_programme_branch', method: 'POST', path: '/academy/programmes/:id/branch', tag: 'Academy',
  summary: 'Place a programme in a branch, or clear it with branch_id null (owner/admin). A programme belongs to at most one live branch. Programme terms, versions and enrolments are not touched.',
  input: z.object({ id, branch_id: id.nullable() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT id, organisation_id, branch_id FROM academy_programmes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Programme');
    await orgFor(user, p.organisation_id, STAFF, { write: true, c });
    if (i.branch_id) {
      const b = (await c.query('SELECT archived_at FROM academy_branches WHERE id=$1 AND organisation_id=$2', [i.branch_id, p.organisation_id])).rows[0];
      if (!b) throw notFound('Branch');
      if (b.archived_at) throw conflict('That branch is archived');
    }
    await c.query('UPDATE academy_programmes SET branch_id=$2 WHERE id=$1', [p.id, i.branch_id]);
    await audit(c, user.id, 'set_academy_programme_branch', 'academy_programmes', p.id);
    return { programme_id: p.id, branch_id: i.branch_id, previous_branch_id: p.branch_id };
  }),
});
