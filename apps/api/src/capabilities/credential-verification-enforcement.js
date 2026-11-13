// Credential verification enforcement: booking gates, org/event policies, lapse handling, at-risk listings.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { pool } from '../db.js';

/** Check whether a user may be hired/assigned in a role under a given org's or event's policy.
 *  Returns { allowed, policy_required, verified, grace_days }. */
export async function checkRoleVerificationGate(db, { userId, role, ownerId, ownerType }) {
  const policyRow = await (db ?? pool).query(
    'SELECT require_verified, grace_days FROM credential_verification_policies WHERE owner_type=$1 AND owner_id=$2 AND role=$3',
    [ownerType, ownerId, role]);
  const policy = policyRow.rows[0];
  if (!policy?.require_verified) return { allowed: true, policy_required: false };

  const credRow = await (db ?? pool).query(
    `SELECT id FROM verification_cases WHERE subject_type='user' AND subject_id=$1 AND type=$2
       AND status='approved' AND expires_at > now() - make_interval(days => $3)
     ORDER BY decided_at DESC LIMIT 1`,
    [userId, role, policy.grace_days ?? 0]);
  if (credRow.rows[0]) return { allowed: true, policy_required: true, verified: true };
  return { allowed: false, policy_required: true, verified: false, grace_days: policy.grace_days };
}

/** Notify the holder that a credential has lapsed, and surface at-risk engagements. */
export async function handleVerificationLapse(db, { caseId, userId, role }) {
  await notify(db ?? pool, userId, {
    kind: 'credential_lapsed',
    title: `Your ${role} credential has lapsed`,
    body: 'Your verification badge has expired. Renew before your next booking or assignment to stay eligible.',
    data: { case_id: caseId, role },
  });
  const { rows: eng } = await (db ?? pool).query(
    `SELECT id, 'hire' AS kind FROM coach_hire_requests
       WHERE coach_id=$1 AND status IN ('confirmed','upcoming')
         AND session_date >= current_date AND session_date <= current_date + 90
     UNION ALL
     SELECT id, 'assignment' AS kind FROM event_assignments
       WHERE user_id=$1 AND role=$2 AND cancelled_at IS NULL
         AND assigned_date >= current_date AND assigned_date <= current_date + 90`,
    [userId, role]).catch(() => ({ rows: [] }));
  return { lapse_notified: true, at_risk_engagements: eng.length };
}

cap({
  name: 'set_credential_policy', method: 'POST', path: '/credential-policies', tag: 'credentials', auth: true,
  summary: 'Set per-org or per-event credential verification requirement for a role (coach, referee, physio).',
  input: z.object({
    owner_type: z.enum(['org','event']),
    owner_id:   id,
    role:       z.enum(['coach','referee','physio']),
    require_verified: z.boolean(),
    grace_days: z.number().int().min(0).max(90).default(0),
  }),
  async handler(c, i) {
    if (i.owner_type === 'org') {
      const { rows } = await c.db.query(
        "SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND left_at IS NULL",
        [i.owner_id, c.user.id]);
      if (!rows[0]) throw forbidden();
    } else {
      const { rows } = await c.db.query('SELECT 1 FROM events WHERE id=$1 AND created_by=$2', [i.owner_id, c.user.id]);
      if (!rows[0]) throw forbidden();
    }
    const { rows } = await c.db.query(
      `INSERT INTO credential_verification_policies(owner_type, owner_id, role, require_verified, grace_days)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_type, owner_id, role)
       DO UPDATE SET require_verified=$4, grace_days=$5, updated_at=now()
       RETURNING *`,
      [i.owner_type, i.owner_id, i.role, i.require_verified, i.grace_days]);
    return rows[0];
  },
});

cap({
  name: 'get_credential_policy', method: 'GET', path: '/credential-policies', tag: 'credentials', auth: true,
  summary: 'Get credential verification policy for an org or event (all roles).',
  input: z.object({ owner_type: z.enum(['org','event']), owner_id: id }),
  async handler(c, i) {
    const { rows } = await c.db.query(
      'SELECT * FROM credential_verification_policies WHERE owner_type=$1 AND owner_id=$2 ORDER BY role',
      [i.owner_type, i.owner_id]);
    return rows;
  },
});

cap({
  name: 'list_engagements_at_risk', method: 'GET', path: '/credential-policies/at-risk', tag: 'credentials', auth: true,
  summary: "List upcoming engagements at risk because a staff member's credential is missing or expired, under a policy that requires it.",
  input: z.object({
    owner_type: z.enum(['org','event']),
    owner_id:   id,
    days_ahead: z.coerce.number().int().min(1).max(365).default(90),
  }),
  async handler(c, i) {
    const { rows } = await c.db.query(
      `SELECT u.id AS user_id, u.display_name, r.role, r.engagement_kind, r.engagement_id, r.engagement_date,
              CASE WHEN vc.id IS NULL THEN 'unverified'
                   WHEN vc.status='approved' AND vc.expires_at > now() THEN 'verified'
                   ELSE 'issue' END AS badge_state
         FROM (
           SELECT chr.coach_id AS user_id, 'coach' AS role, 'hire' AS engagement_kind,
                  chr.id AS engagement_id, chr.session_date AS engagement_date
             FROM coach_hire_requests chr
            WHERE chr.org_id=$1 AND chr.status IN ('confirmed','upcoming')
              AND chr.session_date >= current_date AND chr.session_date <= current_date + $3
           UNION ALL
           SELECT ea.user_id, ea.role, 'assignment' AS engagement_kind, ea.id, ea.assigned_date
             FROM event_assignments ea JOIN events ev ON ev.id=ea.event_id
            WHERE ($2='org' AND ev.org_id=$1 OR $2='event' AND ea.event_id=$1::uuid)
              AND ea.cancelled_at IS NULL
              AND ea.assigned_date >= current_date AND ea.assigned_date <= current_date + $3
         ) r
         JOIN users u ON u.id=r.user_id
         JOIN credential_verification_policies p
           ON p.owner_type=$2 AND p.owner_id=$1 AND p.role=r.role AND p.require_verified=true
         LEFT JOIN LATERAL (
           SELECT id, status, expires_at FROM verification_cases
            WHERE subject_type='user' AND subject_id=r.user_id AND type=r.role
              AND status='approved' AND expires_at > now()
            LIMIT 1
         ) vc ON true
        WHERE vc.id IS NULL
        ORDER BY r.engagement_date, u.display_name`,
      [i.owner_id, i.owner_type, i.days_ahead]);
    return rows;
  },
});
