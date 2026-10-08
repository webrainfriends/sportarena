// Organisation workspaces for clubs, academies and schools. An organisation delegates to the existing
// identities, teams, events and venues (it never duplicates them): people hold a scoped role, assets are linked
// by organisation_id, and cohorts/seasons/attendance sit on top. Membership is checked live on every call, so
// revoking access is immediate. Nothing is deleted: people leave, cohorts and organisations are archived.
//
//   owner   everything incl. ownership transfer + archive      admin   people, structure, linked assets
//   coach   their own cohorts: enrolment + attendance          finance money views only (no rosters, never clinical data)
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, PUBLIC_USER } from '../helpers.js';
import { blindIndex } from '../crypto.js';
import { csvToObjects } from '../csv.js';
import { notify } from '../notify.js';
import { orgFor, orgRole } from '../org-access.js';

const ROLES = ['owner', 'admin', 'coach', 'finance'];
const STAFF = ['owner', 'admin'];
const role = z.enum(ROLES);
const day = z.string().date();
const MAX_ROWS = 500;

const person = (ref) => {
  const r = String(ref).trim();
  return r.includes('@') ? one('SELECT id, handle, display_name FROM users WHERE email_idx=$1', [blindIndex(r)]) : one('SELECT id, handle, display_name FROM users WHERE lower(handle)=lower($1)', [r.replace(/^@/, '')]);
};
const lockOrg = (c, orgId) => c.query('SELECT id FROM organisations WHERE id=$1 FOR UPDATE', [orgId]);
const activeOwners = async (c, orgId, except) => (await c.query("SELECT count(*)::int AS n FROM organisation_members WHERE organisation_id=$1 AND role='owner' AND status='active' AND user_id<>$2", [orgId, except])).rows[0].n;

/** Cohort + the caller's right to run it: owner/admin always, a coach only for cohorts assigned to them. */
async function cohortFor(user, cohortId, { write = false, c } = {}) {
  const cohort = c ? (await c.query('SELECT * FROM org_cohorts WHERE id=$1', [cohortId])).rows[0] : await one('SELECT * FROM org_cohorts WHERE id=$1', [cohortId]);
  if (!cohort) throw notFound('Cohort');
  const { org, role: r } = await orgFor(user, cohort.organisation_id, ['owner', 'admin', 'coach'], { write, c });
  if (r === 'coach' && cohort.coach_id !== user.id) throw forbidden('This cohort is assigned to another coach');
  if (write && cohort.status !== 'active') throw conflict('This cohort is archived and read-only');
  return { cohort, org, role: r };
}

// ------------------------------------------------------------------ organisations
cap({
  name: 'create_organisation', method: 'POST', path: '/organisations', tag: 'Organisations', status: 201,
  summary: 'Create a workspace for a club, academy or school. You become its owner.',
  input: z.object({ name: z.string().min(2).max(80), kind: z.enum(['club', 'academy', 'school', 'other']).default('club'), city: z.string().max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const org = (await c.query('INSERT INTO organisations(name, kind, city, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.name, i.kind, i.city ?? null, user.id])).rows[0];
    await c.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at, invited_by) VALUES ($1,$2,'owner','active',now(),$2)", [org.id, user.id]);
    await audit(c, user.id, 'create_organisation', 'organisations', org.id);
    return { ...org, my_role: 'owner' };
  }),
});

cap({
  name: 'list_my_organisations', method: 'GET', path: '/organisations', tag: 'Organisations',
  summary: 'Workspaces you belong to, including pending invitations and archived ones (kept for history).',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT o.id, o.name, o.kind, o.city, o.status, m.role AS my_role, m.status AS my_status
       FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
      WHERE m.user_id=$1 AND m.status IN ('active','invited') ORDER BY (m.status='invited') DESC, o.name, o.id LIMIT $2 OFFSET $3`,
    [user.id, i.limit, i.offset],
  ),
});

cap({
  name: 'get_organisation', method: 'GET', path: '/organisations/:id', tag: 'Organisations', auth: 'public',
  summary: 'Organisation profile. Everyone sees name, kind and city; members also see their own role.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const o = await one('SELECT id, name, kind, city, status FROM organisations WHERE id=$1', [i.id]);
    if (!o) throw notFound('Organisation');
    return { ...o, my_role: user ? await orgRole(user, i.id) : null };
  },
});

cap({
  name: 'update_organisation', method: 'PATCH', path: '/organisations/:id', tag: 'Organisations', summary: 'Rename or edit the organisation (owner/admin).',
  input: z.object({ id, name: z.string().min(2).max(80).optional(), kind: z.enum(['club', 'academy', 'school', 'other']).optional(), city: z.string().max(80).optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF, { write: true });
    if (i.name === undefined && i.kind === undefined && i.city === undefined) throw badRequest('Nothing to update');
    return one('UPDATE organisations SET name=coalesce($2,name), kind=coalesce($3,kind), city=coalesce($4,city) WHERE id=$1 RETURNING *', [i.id, i.name, i.kind, i.city]);
  },
});

cap({
  name: 'archive_organisation', method: 'POST', path: '/organisations/:id/archive', tag: 'Organisations',
  summary: 'Archive the workspace (owner). It becomes read-only and delegated access to linked teams, events and venues pauses; all data is kept.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, ['owner'], { c });
    const o = (await c.query("UPDATE organisations SET status='archived', archived_at=now() WHERE id=$1 AND status='active' RETURNING *", [i.id])).rows[0];
    if (!o) throw conflict('Already archived');
    await audit(c, user.id, 'archive_organisation', 'organisations', i.id);
    return o;
  }),
});

cap({
  name: 'restore_organisation', method: 'POST', path: '/organisations/:id/restore', tag: 'Organisations', summary: 'Re-open an archived workspace (owner).',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, ['owner'], { c });
    const o = (await c.query("UPDATE organisations SET status='active', archived_at=NULL WHERE id=$1 AND status='archived' RETURNING *", [i.id])).rows[0];
    if (!o) throw conflict('This organisation is not archived');
    await audit(c, user.id, 'restore_organisation', 'organisations', i.id);
    return o;
  }),
});

// ------------------------------------------------------------------ people
cap({
  name: 'invite_org_member', method: 'POST', path: '/organisations/:id/members', tag: 'Organisations', status: 201,
  summary: 'Invite a registered person (by handle or email) to a role. Only owners can invite other owners.',
  input: z.object({ id, person: z.string().min(2).max(200).describe('handle or email of a registered person'), role: role.default('coach') }),
  async handler({ user }, i) {
    const { org, role: mine } = await orgFor(user, i.id, STAFF, { write: true });
    if (i.role === 'owner' && mine !== 'owner') throw forbidden('Only an owner can invite another owner');
    const u = await person(i.person);
    if (!u) throw notFound('Person (they need a SportArena account first)');
    const m = await one("INSERT INTO organisation_members(organisation_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4) RETURNING id, organisation_id, user_id, role, status, invited_at", [i.id, u.id, i.role, user.id]); // live-membership unique index -> 409 on repeat
    await notify(null, u.id, { kind: 'org_invite', title: `Invitation to ${org.name}`, body: `You have been invited to join ${org.name} as ${i.role}.`, data: { organisation_id: i.id } });
    await audit(null, user.id, 'invite_org_member', 'organisations', i.id);
    return { ...m, handle: u.handle, display_name: u.display_name };
  },
});

cap({
  name: 'respond_org_invite', method: 'POST', path: '/organisations/:id/invite/respond', tag: 'Organisations', summary: 'Accept or decline your invitation to a workspace.',
  input: z.object({ id, accept: z.boolean() }),
  async handler({ user }, i) {
    const org = await one('SELECT status FROM organisations WHERE id=$1', [i.id]);
    if (org?.status === 'archived') throw conflict('This organisation is archived');
    const m = await one(
      "UPDATE organisation_members SET status=$3, joined_at=CASE WHEN $3='active' THEN now() END, left_at=CASE WHEN $3='declined' THEN now() END WHERE organisation_id=$1 AND user_id=$2 AND status='invited' RETURNING id, organisation_id, role, status",
      [i.id, user.id, i.accept ? 'active' : 'declined'],
    );
    if (!m) throw notFound('Invitation');
    return m;
  },
});

cap({
  name: 'list_org_members', method: 'GET', path: '/organisations/:id/members', tag: 'Organisations',
  summary: 'Staff of the workspace with their roles (any member can see the staff list; no contact details).',
  input: z.object({ id, status: z.enum(['active', 'invited', 'left', 'declined']).default('active'), ...page }),
  async handler({ user }, i) {
    const { role: mine } = await orgFor(user, i.id);
    if (i.status !== 'active' && !STAFF.includes(mine)) throw forbidden('Only owners and admins can see invitations and former staff');
    return many(
      `SELECT ${PUBLIC_USER}, m.role AS org_role, m.status, m.joined_at, m.left_at
         FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status=$2
        ORDER BY array_position(ARRAY['owner','admin','coach','finance'], m.role), u.display_name, u.id LIMIT $3 OFFSET $4`,
      [i.id, i.status, i.limit, i.offset],
    );
  },
});

cap({
  name: 'set_org_member_role', method: 'PATCH', path: '/organisations/:id/members/:user_id', tag: 'Organisations',
  summary: 'Change a staff member\'s role. Admins cannot change owners or make owners; the last owner cannot be demoted (transfer ownership instead).',
  input: z.object({ id, user_id: id, role }),
  handler: ({ user }, i) => tx(async (c) => {
    await lockOrg(c, i.id);
    const { role: mine } = await orgFor(user, i.id, STAFF, { write: true, c });
    const t = (await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.user_id])).rows[0];
    if (!t) throw notFound('Active member');
    if (mine !== 'owner' && (t.role === 'owner' || i.role === 'owner')) throw forbidden('Only an owner can change owners');
    if (t.role === 'owner' && i.role !== 'owner' && (await activeOwners(c, i.id, i.user_id)) < 1) throw conflict('An organisation needs at least one owner — transfer ownership first');
    const m = (await c.query("UPDATE organisation_members SET role=$3 WHERE organisation_id=$1 AND user_id=$2 AND status='active' RETURNING id, organisation_id, user_id, role, status", [i.id, i.user_id, i.role])).rows[0];
    await audit(c, user.id, 'set_org_member_role', 'organisations', i.id);
    return m;
  }),
});

cap({
  name: 'remove_org_member', method: 'DELETE', path: '/organisations/:id/members/:user_id', tag: 'Organisations',
  summary: 'Leave the workspace, or remove (or cancel the invitation of) a staff member. Access ends immediately; history is kept.',
  input: z.object({ id, user_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    await lockOrg(c, i.id);
    const { org, role: mine } = await orgFor(user, i.id, null, { c });
    const self = i.user_id === user.id;
    if (!self && !STAFF.includes(mine)) throw forbidden('Only owners and admins can remove staff');
    const t = (await c.query("SELECT role, status FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status IN ('active','invited')", [i.id, i.user_id])).rows[0];
    if (!t) throw notFound('Membership');
    if (!self && mine !== 'owner' && t.role === 'owner') throw forbidden('Only an owner can remove an owner');
    if (t.role === 'owner' && t.status === 'active' && (await activeOwners(c, i.id, i.user_id)) < 1) throw conflict('The last owner cannot leave — transfer ownership first');
    await c.query("UPDATE organisation_members SET status='left', left_at=now() WHERE organisation_id=$1 AND user_id=$2 AND status IN ('active','invited')", [i.id, i.user_id]);
    await audit(c, user.id, 'remove_org_member', 'organisations', i.id);
    if (!self) await notify(c, i.user_id, { kind: 'org_removed', title: `Access to ${org.name} ended`, body: `You no longer have access to ${org.name}.`, data: { organisation_id: i.id } });
    return { ok: true };
  }),
});

cap({
  name: 'transfer_org_ownership', method: 'POST', path: '/organisations/:id/transfer', tag: 'Organisations',
  summary: 'Hand ownership to another active member (owner only). You stay on as admin.',
  input: z.object({ id, to_user_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    await lockOrg(c, i.id);
    await orgFor(user, i.id, ['owner'], { write: true, c });
    if (i.to_user_id === user.id) throw badRequest('Choose someone else');
    const t = await c.query("UPDATE organisation_members SET role='owner' WHERE organisation_id=$1 AND user_id=$2 AND status='active' RETURNING id", [i.id, i.to_user_id]);
    if (!t.rowCount) throw notFound('Active member');
    if (!isAdmin(user)) await c.query("UPDATE organisation_members SET role='admin' WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, user.id]);
    await audit(c, user.id, 'transfer_org_ownership', 'organisations', i.id);
    return { ok: true, owner_id: i.to_user_id };
  }),
});

// ------------------------------------------------------------------ linked teams / events / venues
const ASSETS = {
  team: { table: 'teams', owner: 'owner_id', cols: 'a.id, a.name' },
  event: { table: 'events', owner: 'organizer_id', cols: 'a.id, a.name' },
  venue: { table: 'venues', owner: 'owner_id', cols: 'a.id, a.name' },
};
const assetKind = z.enum(['team', 'event', 'venue']);

cap({
  name: 'link_org_asset', method: 'POST', path: '/organisations/:id/assets', tag: 'Organisations',
  summary: 'Bring an existing team, event or venue you own into the workspace. Owners and admins of the workspace then manage it too.',
  input: z.object({ id, kind: assetKind, asset_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    const a = ASSETS[i.kind];
    const row = (await c.query(`SELECT ${a.owner} AS owner_id, organisation_id FROM ${a.table} WHERE id=$1 FOR UPDATE`, [i.asset_id])).rows[0];
    if (!row) throw notFound(i.kind);
    if (!isAdmin(user) && row.owner_id !== user.id) throw forbidden(`Only the ${i.kind} owner can bring it into a workspace`);
    if (row.organisation_id && row.organisation_id !== i.id) throw conflict(`This ${i.kind} already belongs to another organisation`);
    await c.query(`UPDATE ${a.table} SET organisation_id=$2 WHERE id=$1`, [i.asset_id, i.id]);
    await audit(c, user.id, 'link_org_asset', a.table, i.asset_id);
    return { ok: true, kind: i.kind, asset_id: i.asset_id, organisation_id: i.id };
  }),
});

cap({
  name: 'unlink_org_asset', method: 'DELETE', path: '/organisations/:id/assets/:asset_id', tag: 'Organisations',
  summary: 'Take a team, event or venue out of the workspace. Its owner keeps it; delegated access ends.',
  input: z.object({ id, asset_id: id, kind: assetKind }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    const a = ASSETS[i.kind];
    const r = await c.query(`UPDATE ${a.table} SET organisation_id=NULL WHERE id=$1 AND organisation_id=$2`, [i.asset_id, i.id]);
    if (!r.rowCount) throw notFound(`Linked ${i.kind}`);
    await audit(c, user.id, 'unlink_org_asset', a.table, i.asset_id);
    return { ok: true };
  }),
});

cap({
  name: 'list_org_assets', method: 'GET', path: '/organisations/:id/assets', tag: 'Organisations',
  summary: 'Teams, events or venues linked to the workspace.',
  input: z.object({ id, kind: assetKind, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ['owner', 'admin', 'coach']);
    const a = ASSETS[i.kind];
    return many(`SELECT ${a.cols} FROM ${a.table} a WHERE a.organisation_id=$1 ORDER BY a.name, a.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ seasons & cohorts
cap({
  name: 'create_org_season', method: 'POST', path: '/organisations/:id/seasons', tag: 'Organisations', status: 201, summary: 'Define a season (owner/admin).',
  input: z.object({ id, name: z.string().min(2).max(80), starts_on: day, ends_on: day }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF, { write: true });
    if (i.ends_on < i.starts_on) throw badRequest('A season cannot end before it starts');
    return one('INSERT INTO org_seasons(organisation_id, name, starts_on, ends_on) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, i.name, i.starts_on, i.ends_on]);
  },
});

cap({
  name: 'list_org_seasons', method: 'GET', path: '/organisations/:id/seasons', tag: 'Organisations',
  summary: 'Seasons with how many cohorts and enrolled people each has.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ['owner', 'admin', 'coach']);
    return many(
      `SELECT s.*, (SELECT count(*)::int FROM org_cohorts k WHERE k.season_id=s.id) AS cohorts,
              (SELECT count(DISTINCT e.user_id)::int FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.season_id=s.id AND e.status='enrolled') AS enrolled
         FROM org_seasons s WHERE s.organisation_id=$1 ORDER BY s.starts_on DESC, s.id LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset],
    );
  },
});

cap({
  name: 'create_cohort', method: 'POST', path: '/organisations/:id/cohorts', tag: 'Organisations', status: 201,
  summary: 'Create a cohort (a class, age group or squad) optionally tied to a season, a team and a coach.',
  input: z.object({ id, name: z.string().min(2).max(80), season_id: id.optional(), team_id: id.optional(), coach_id: id.optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF, { write: true });
    if (i.season_id && !(await one("SELECT 1 FROM org_seasons WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.season_id, i.id]))) throw badRequest('That season is not part of this organisation');
    if (i.team_id && !(await one('SELECT 1 FROM teams WHERE id=$1 AND organisation_id=$2', [i.team_id, i.id]))) throw badRequest('Link the team to this organisation first');
    if (i.coach_id && !(await one("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('coach','admin','owner')", [i.id, i.coach_id]))) throw badRequest('The coach must be active staff of this organisation');
    return one('INSERT INTO org_cohorts(organisation_id, name, season_id, team_id, coach_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.id, i.name, i.season_id ?? null, i.team_id ?? null, i.coach_id ?? null]);
  },
});

cap({
  name: 'list_cohorts', method: 'GET', path: '/organisations/:id/cohorts', tag: 'Organisations',
  summary: 'Cohorts you run: all of them for owners/admins, only your own for coaches.',
  input: z.object({ id, season_id: id.optional(), status: z.enum(['active', 'archived']).default('active'), ...page }),
  async handler({ user }, i) {
    const { role: mine } = await orgFor(user, i.id, ['owner', 'admin', 'coach']);
    return many(
      `SELECT k.*, (SELECT count(*)::int FROM org_enrolments e WHERE e.cohort_id=k.id AND e.status='enrolled') AS enrolled
         FROM org_cohorts k WHERE k.organisation_id=$1 AND k.status=$2 AND ($3::uuid IS NULL OR k.season_id=$3) AND ($4::uuid IS NULL OR k.coach_id=$4)
        ORDER BY k.name, k.id LIMIT $5 OFFSET $6`,
      [i.id, i.status, i.season_id ?? null, mine === 'coach' ? user.id : null, i.limit, i.offset],
    );
  },
});

cap({
  name: 'archive_cohort', method: 'POST', path: '/cohorts/:id/archive', tag: 'Organisations', summary: 'Archive a cohort (owner/admin). Enrolments and attendance are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cohort = await one('SELECT organisation_id FROM org_cohorts WHERE id=$1', [i.id]);
    if (!cohort) throw notFound('Cohort');
    await orgFor(user, cohort.organisation_id, STAFF, { write: true });
    return one("UPDATE org_cohorts SET status='archived' WHERE id=$1 RETURNING *", [i.id]);
  },
});

// ------------------------------------------------------------------ enrolment
/** Validate CSV rows (columns: handle or email, consent) against the people and enrolments that exist. Writes nothing. */
async function checkRows(csv, cohortId, c) {
  const rows = csvToObjects(csv);
  if (!rows.length) throw badRequest('The file has no rows. Use columns: handle (or email) and consent.');
  if (rows.length > MAX_ROWS) throw badRequest(`Upload at most ${MAX_ROWS} rows at a time`);
  const db = c ?? pool;
  const seen = new Set();
  const out = [];
  for (const [n, r] of rows.entries()) {
    const line = n + 2, ref = r.handle || r.email || '';
    const bad = (reason) => out.push({ line, ref: r.handle ?? '(email)', status: 'invalid', reason });
    if (!ref) { bad('Row has no handle or email'); continue; }
    if (!/^(yes|y|true|1)$/i.test(r.consent ?? '')) { bad('Consent is not confirmed (consent column must be yes)'); continue; }
    const u = ref.includes('@') ? (await db.query('SELECT id, handle FROM users WHERE email_idx=$1', [blindIndex(ref)])).rows[0] : (await db.query('SELECT id, handle FROM users WHERE lower(handle)=lower($1)', [ref.replace(/^@/, '')])).rows[0];
    if (!u) { bad('No registered person matches'); continue; }
    if (seen.has(u.id)) { out.push({ line, ref: u.handle, status: 'duplicate', reason: 'Appears more than once in this file', user_id: u.id }); continue; }
    seen.add(u.id);
    const e = (await db.query('SELECT status FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2', [cohortId, u.id])).rows[0];
    if (e?.status === 'enrolled') { out.push({ line, ref: u.handle, status: 'duplicate', reason: 'Already enrolled in this cohort', user_id: u.id }); continue; }
    out.push({ line, ref: u.handle, status: 'ok', reason: e ? 'Re-enrolling after withdrawal' : null, user_id: u.id });
  }
  const count = (s) => out.filter((x) => x.status === s).length;
  return { rows: out, summary: { total: out.length, ok: count('ok'), duplicate: count('duplicate'), invalid: count('invalid') } };
}
const publicRow = ({ user_id, ...r }) => r;

cap({
  name: 'preview_bulk_enrolment', method: 'POST', path: '/cohorts/:id/enrolments/preview', tag: 'Organisations',
  summary: 'Check a CSV (columns: handle or email, consent) before enrolling. Reports duplicates and invalid rows; nothing is written.',
  input: z.object({ id, csv: z.string().min(3).max(200000) }),
  async handler({ user }, i) {
    await cohortFor(user, i.id, { write: true });
    const r = await checkRows(i.csv, i.id);
    return { rows: r.rows.map(publicRow), summary: r.summary };
  },
});

cap({
  name: 'commit_bulk_enrolment', method: 'POST', path: '/cohorts/:id/enrolments', tag: 'Organisations', status: 201,
  summary: 'Enrol everyone in the CSV in one step. By default nothing is enrolled if any row has a problem; set allow_partial to enrol the valid rows. Safe to repeat.',
  input: z.object({ id, csv: z.string().min(3).max(200000), allow_partial: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    await c.query('SELECT id FROM org_cohorts WHERE id=$1 FOR UPDATE', [i.id]);
    await cohortFor(user, i.id, { write: true, c });
    const r = await checkRows(i.csv, i.id, c);
    const problems = r.summary.invalid + r.summary.duplicate;
    if (problems && !i.allow_partial) throw conflict('Some rows need attention, so nobody was enrolled', { rows: r.rows.map(publicRow), summary: r.summary });
    for (const row of r.rows.filter((x) => x.status === 'ok')) {
      await c.query(
        `INSERT INTO org_enrolments(cohort_id, user_id, consent_at, enrolled_by) VALUES ($1,$2,now(),$3)
         ON CONFLICT (cohort_id, user_id) DO UPDATE SET status='enrolled', consent_at=now(), enrolled_by=$3, withdrawn_at=NULL WHERE org_enrolments.status='withdrawn'`,
        [i.id, row.user_id, user.id],
      );
    }
    await audit(c, user.id, 'bulk_enrol', 'org_cohorts', i.id);
    return { rows: r.rows.map(publicRow), summary: { ...r.summary, enrolled: r.summary.ok } };
  }),
});

cap({
  name: 'list_cohort_enrolments', method: 'GET', path: '/cohorts/:id/enrolments', tag: 'Organisations', summary: 'Who is enrolled in a cohort (cohort staff only).',
  input: z.object({ id, status: z.enum(['enrolled', 'withdrawn']).default('enrolled'), ...page }),
  async handler({ user }, i) {
    await cohortFor(user, i.id);
    return many(
      `SELECT ${PUBLIC_USER}, e.status, e.enrolled_at, e.consent_at, e.withdrawn_at FROM org_enrolments e JOIN users u ON u.id=e.user_id
        WHERE e.cohort_id=$1 AND e.status=$2 ORDER BY u.display_name, u.id LIMIT $3 OFFSET $4`,
      [i.id, i.status, i.limit, i.offset],
    );
  },
});

cap({
  name: 'withdraw_org_enrolment', method: 'DELETE', path: '/cohorts/:id/enrolments/:user_id', tag: 'Organisations',
  summary: 'Withdraw from a cohort (yourself) or withdraw someone (cohort staff). Attendance history is kept.',
  input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    if (i.user_id !== user.id) await cohortFor(user, i.id, { write: true });
    const r = await one("UPDATE org_enrolments SET status='withdrawn', withdrawn_at=now() WHERE cohort_id=$1 AND user_id=$2 AND status='enrolled' RETURNING id", [i.id, i.user_id]);
    if (!r) throw notFound('Enrolment');
    return { ok: true };
  },
});

cap({
  name: 'list_my_enrolments', method: 'GET', path: '/me/enrolments', tag: 'Organisations',
  summary: 'Your own cohorts across every organisation, including finished ones.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT e.cohort_id, k.name AS cohort, o.id AS organisation_id, o.name AS organisation, e.status, e.enrolled_at, e.withdrawn_at
       FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN organisations o ON o.id=k.organisation_id
      WHERE e.user_id=$1 ORDER BY e.enrolled_at DESC, e.id LIMIT $2 OFFSET $3`,
    [user.id, i.limit, i.offset],
  ),
});

// ------------------------------------------------------------------ attendance
cap({
  name: 'record_attendance', method: 'POST', path: '/cohorts/:id/attendance', tag: 'Organisations',
  summary: 'Record attendance for one session. Re-sending the same date corrects earlier marks. Only enrolled people can be marked.',
  input: z.object({ id, session_date: day, records: z.array(z.object({ user_id: id, status: z.enum(['present', 'absent', 'excused']) })).min(1).max(300) }),
  handler: ({ user }, i) => tx(async (c) => {
    await cohortFor(user, i.id, { write: true, c });
    if (i.session_date > new Date().toISOString().slice(0, 10)) throw badRequest('Attendance cannot be recorded for a future date');
    const ids = [...new Set(i.records.map((r) => r.user_id))];
    const ok = (await c.query("SELECT user_id FROM org_enrolments WHERE cohort_id=$1 AND status='enrolled' AND user_id = ANY($2)", [i.id, ids])).rows.map((r) => r.user_id);
    const missing = ids.filter((x) => !ok.includes(x));
    if (missing.length) throw badRequest('Some people are not enrolled in this cohort, so nothing was saved', { not_enrolled: missing });
    for (const r of i.records) {
      await c.query(
        `INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cohort_id, user_id, session_date) DO UPDATE SET status=EXCLUDED.status, recorded_by=EXCLUDED.recorded_by, recorded_at=now()`,
        [i.id, r.user_id, i.session_date, r.status, user.id],
      );
    }
    return { ok: true, session_date: i.session_date, saved: i.records.length };
  }),
});

cap({
  name: 'get_cohort_attendance', method: 'GET', path: '/cohorts/:id/attendance', tag: 'Organisations',
  summary: 'Attendance per person for a cohort. Cohort staff see everyone; an enrolled person sees only their own record (kept after leaving).',
  input: z.object({ id, from: day.optional(), to: day.optional(), ...page }),
  async handler({ user }, i) {
    const cohort = await one('SELECT * FROM org_cohorts WHERE id=$1', [i.id]);
    if (!cohort) throw notFound('Cohort');
    let only = null;
    try { await cohortFor(user, i.id); } catch (e) {
      if (!(await one('SELECT 1 FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2', [i.id, user.id]))) throw notFound('Cohort');
      only = user.id;
    }
    const args = [i.id, i.from ?? null, i.to ?? null, only];
    const people = await many(
      `SELECT ${PUBLIC_USER}, count(*) FILTER (WHERE a.status='present')::int AS present, count(*) FILTER (WHERE a.status='absent')::int AS absent, count(*) FILTER (WHERE a.status='excused')::int AS excused,
              count(a.id)::int AS sessions
         FROM org_enrolments e JOIN users u ON u.id=e.user_id
         LEFT JOIN org_attendance a ON a.cohort_id=e.cohort_id AND a.user_id=e.user_id AND ($2::date IS NULL OR a.session_date>=$2) AND ($3::date IS NULL OR a.session_date<=$3)
        WHERE e.cohort_id=$1 AND ($4::uuid IS NULL OR e.user_id=$4) GROUP BY u.id ORDER BY u.display_name, u.id LIMIT $5 OFFSET $6`,
      [...args, i.limit, i.offset],
    );
    const records = await many(
      `SELECT a.user_id, a.session_date, a.status FROM org_attendance a WHERE a.cohort_id=$1 AND ($2::date IS NULL OR a.session_date>=$2) AND ($3::date IS NULL OR a.session_date<=$3) AND ($4::uuid IS NULL OR a.user_id=$4)
        ORDER BY a.session_date DESC, a.user_id LIMIT 1000`, args);
    return { cohort: { id: cohort.id, name: cohort.name, status: cohort.status }, people, records };
  },
});

// ------------------------------------------------------------------ dashboard & export
cap({
  name: 'get_org_dashboard', method: 'GET', path: '/organisations/:id/dashboard', tag: 'Organisations',
  summary: 'Overview for your role: owners/admins see people and structure, coaches their cohorts, finance only the money.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { org, role: r } = await orgFor(user, i.id);
    const out = { organisation: { id: org.id, name: org.name, kind: org.kind, status: org.status }, role: r };
    if (r === 'owner' || r === 'admin') {
      const n = await one(
        `SELECT (SELECT count(*)::int FROM organisation_members WHERE organisation_id=$1 AND status='active') AS staff,
                (SELECT count(*)::int FROM teams WHERE organisation_id=$1) AS teams, (SELECT count(*)::int FROM events WHERE organisation_id=$1) AS events,
                (SELECT count(*)::int FROM venues WHERE organisation_id=$1) AS venues,
                (SELECT count(*)::int FROM org_cohorts WHERE organisation_id=$1 AND status='active') AS cohorts,
                (SELECT count(DISTINCT e.user_id)::int FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.status='enrolled') AS people`, [i.id]);
      out.counts = n;
    }
    if (r !== 'finance') {
      out.attendance_30d = await one(
        `SELECT count(*) FILTER (WHERE a.status='present')::int AS present, count(a.id)::int AS marked
           FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id
          WHERE k.organisation_id=$1 AND a.session_date >= current_date - 30 AND ($2::uuid IS NULL OR k.coach_id=$2)`, [i.id, r === 'coach' ? user.id : null]);
      out.seasons = await many(
        `SELECT s.id, s.name, s.starts_on, s.ends_on, s.status, (SELECT count(*)::int FROM org_cohorts k WHERE k.season_id=s.id AND ($2::uuid IS NULL OR k.coach_id=$2)) AS cohorts
           FROM org_seasons s WHERE s.organisation_id=$1 ORDER BY s.starts_on DESC, s.id LIMIT 12`, [i.id, r === 'coach' ? user.id : null]);
    }
    if (r === 'owner' || r === 'finance') {
      out.finance = await many(
        `SELECT p.currency, p.status, count(*)::int AS entries, sum(p.amount_cents)::bigint AS amount_cents FROM team_payouts p JOIN teams t ON t.id=p.team_id
          WHERE t.organisation_id=$1 AND p.status<>'cancelled' GROUP BY p.currency, p.status ORDER BY p.currency, p.status`, [i.id]);
    }
    return out;
  },
});

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\n') + '\n';

cap({
  name: 'export_org_data', method: 'GET', path: '/organisations/:id/export', tag: 'Organisations',
  summary: 'Export a section as CSV: staff, enrolments and attendance (owner/admin), finance (owner/finance). No contact details or clinical data are ever included.',
  input: z.object({ id, section: z.enum(['staff', 'enrolments', 'attendance', 'finance']) }),
  async handler({ user }, i) {
    const allowed = { staff: STAFF, enrolments: STAFF, attendance: STAFF, finance: ['owner', 'finance'] }[i.section];
    await orgFor(user, i.id, allowed);
    const q = {
      staff: [['handle', 'display_name', 'role', 'status', 'joined_at', 'left_at'], `SELECT u.handle, u.display_name, m.role, m.status, m.joined_at, m.left_at FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 ORDER BY u.handle, m.invited_at`],
      enrolments: [['cohort', 'handle', 'display_name', 'status', 'enrolled_at', 'withdrawn_at'], `SELECT k.name AS cohort, u.handle, u.display_name, e.status, e.enrolled_at, e.withdrawn_at FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id WHERE k.organisation_id=$1 ORDER BY k.name, u.handle`],
      attendance: [['cohort', 'handle', 'session_date', 'status'], `SELECT k.name AS cohort, u.handle, a.session_date, a.status FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id JOIN users u ON u.id=a.user_id WHERE k.organisation_id=$1 ORDER BY k.name, a.session_date, u.handle`],
      finance: [['team', 'handle', 'kind', 'amount_cents', 'currency', 'status', 'due_on', 'paid_at'], `SELECT t.name AS team, u.handle, p.kind, p.amount_cents, p.currency, p.status, p.due_on, p.paid_at FROM team_payouts p JOIN teams t ON t.id=p.team_id JOIN users u ON u.id=p.user_id WHERE t.organisation_id=$1 ORDER BY t.name, p.created_at, p.id`],
    }[i.section];
    const rows = await many(q[1], [i.id]);
    await audit(null, user.id, `export_org_${i.section}`, 'organisations', i.id);
    return { filename: `${i.section}.csv`, rows: rows.length, csv: toCsv(q[0], rows) };
  },
});
