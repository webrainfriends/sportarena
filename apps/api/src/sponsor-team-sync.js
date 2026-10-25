// An organization sponsor entity linked to an organisation (staff_sync) is run by that organisation's staff (#347). They are not a second
// authority: each active member with a sponsor role is mirrored as a representative (source='organisation') of the entity, so the one
// resolver in sponsor-access.js reads one table. Every organisation membership change calls this inside its own transaction, so ending a
// person's membership ends their sponsor access in the same commit. Representatives invited by hand (source='manual') are never touched.
// Nothing is deleted: a mirrored representative who is no longer staff is marked 'left'.

/** Organisation role -> representative role. A coach (or 'staff') has no part in sponsorship. */
export const ORG_TO_REP = { owner: 'owner', admin: 'admin', manager: 'manager', finance: 'finance', evaluator: 'evaluator', legal: 'legal', approver: 'approver', auditor: 'auditor' };
/** Organisation roles that carry a sponsor role. */
export const SPONSOR_ORG_ROLES = Object.keys(ORG_TO_REP);

// the mirrored role: a department-scoped owner/admin only ever acted as a scoped manager, so they stay one
const DESIRED = `SELECT m.user_id, m.invited_by, coalesce(m.joined_at, now()) AS joined_at, m.department_id,
       CASE WHEN m.role IN ('owner','admin') AND m.department_id IS NOT NULL THEN 'manager' ELSE m.role END AS role
  FROM organisation_members m
 WHERE m.organisation_id=$2 AND m.status='active' AND m.role = ANY($3::text[])`;

/** Bring one entity's mirrored representatives in line with its organisation's staff. */
export async function syncEntityTeam(c, entityId) {
  const e = (await c.query('SELECT id, organisation_id, staff_sync FROM sponsor_entities WHERE id=$1', [entityId])).rows[0];
  if (!e) return;
  const roles = SPONSOR_ORG_ROLES;
  const org = e.staff_sync ? e.organisation_id : null;
  // 1. mirrored people who are no longer staff (or whose link was removed) lose access now
  const gone = await c.query(
    `UPDATE sponsor_representatives r SET status='left', left_at=now()
      WHERE r.entity_id=$1 AND r.source='organisation' AND r.status IN ('invited','active')
        AND NOT EXISTS (WITH d AS (${DESIRED}) SELECT 1 FROM d WHERE d.user_id=r.user_id) RETURNING r.id`, [e.id, org, roles]);
  if (gone.rowCount) await c.query('UPDATE sponsor_portfolio_assignments SET ended_at=now() WHERE representative_id = ANY($1::uuid[]) AND ended_at IS NULL', [gone.rows.map((r) => r.id)]);
  if (!org) return;
  // 2. role or department changed in the organisation
  await c.query(
    `WITH d AS (${DESIRED})
     UPDATE sponsor_representatives r SET role=d.role, department_id=d.department_id
       FROM d WHERE r.entity_id=$1 AND r.user_id=d.user_id AND r.source='organisation' AND r.status='active'
        AND (r.role IS DISTINCT FROM d.role OR r.department_id IS DISTINCT FROM d.department_id)`, [e.id, org, roles]);
  // 3. new staff join (someone already on the team by hand keeps that entry)
  await c.query(
    `WITH d AS (${DESIRED})
     INSERT INTO sponsor_representatives(entity_id, user_id, role, status, invited_by, joined_at, department_id, source)
     SELECT $1, d.user_id, d.role, 'active', d.invited_by, d.joined_at, d.department_id, 'organisation' FROM d
      WHERE NOT EXISTS (SELECT 1 FROM sponsor_representatives r WHERE r.entity_id=$1 AND r.user_id=d.user_id AND r.status IN ('invited','active'))`, [e.id, org, roles]);
}

/** After any change to an organisation's staff: refresh every sponsor team that mirrors it. */
export async function syncOrgSponsorTeams(c, orgId) {
  const { rows } = await c.query('SELECT id FROM sponsor_entities WHERE organisation_id=$1 ORDER BY id', [orgId]);
  for (const r of rows) await syncEntityTeam(c, r.id);
}
