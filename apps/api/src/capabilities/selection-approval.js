// Issue #1194: Configurable approval hierarchy for selection campaigns
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';

const TAG = 'Selection';

async function requireCampaignRole(user, campaignId) {
  const campaign = await one(
    `SELECT sc.*, om.role AS member_role FROM selection_campaigns sc
     LEFT JOIN organisation_members om ON om.organisation_id=sc.org_id AND om.user_id=$2 AND om.left_at IS NULL
     WHERE sc.id=$1 AND sc.archived_at IS NULL`,
    [campaignId, user.id]
  );
  if (!campaign) throw notFound();
  if (!campaign.member_role && !isAdmin(user)) throw forbidden();
  return campaign;
}

async function logAudit(c, campaignId, actorId, eventType, payload = {}) {
  await c.one(
    `INSERT INTO selection_audit_events (campaign_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
    [campaignId, actorId, eventType, JSON.stringify(payload)]
  );
}

cap({
  name: 'resolve_selection_approvers',
  method: 'GET',
  path: '/selection-campaigns/:id/approvers',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Resolve the approval chain for a campaign based on org hierarchy',
  input: z.object({ id }),
  async handler({ user }, i) {
    const campaign = await requireCampaignRole(user, i.id);
    const chain = [];

    // Org owners
    const orgOwners = await many(
      `SELECT u.id, u.display_name, 'org_owner' AS approver_role
       FROM organisation_members om JOIN users u ON u.id=om.user_id
       WHERE om.organisation_id=$1 AND om.role IN ('owner','admin') AND om.left_at IS NULL`,
      [campaign.org_id]
    );
    chain.push(...orgOwners);

    // Team manager
    if (campaign.team_id) {
      const mgr = await one(
        `SELECT u.id, u.display_name, 'team_manager' AS approver_role
         FROM team_members tm JOIN users u ON u.id=tm.user_id
         WHERE tm.team_id=$1 AND tm.role='manager' AND tm.left_at IS NULL LIMIT 1`,
        [campaign.team_id]
      );
      if (mgr) chain.push(mgr);

      const coach = await one(
        `SELECT u.id, u.display_name, 'head_coach' AS approver_role
         FROM team_members tm JOIN users u ON u.id=tm.user_id
         WHERE tm.team_id=$1 AND tm.role='head_coach' AND tm.left_at IS NULL LIMIT 1`,
        [campaign.team_id]
      );
      if (coach) chain.push(coach);
    }

    // SoD: flag if proposer is in chain
    const sodConflict = chain.some(a => a.id === campaign.proposer_id);
    if (sodConflict && !campaign.sod_exception) {
      return { chain, sod_conflict: true, sod_exception_required: true };
    }
    return { chain, sod_conflict: sodConflict };
  },
});

cap({
  name: 'submit_selection_for_approval',
  method: 'POST',
  path: '/selection-campaigns/:id/submit-for-approval',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Submit a campaign recommendation for approval — creates route records',
  input: z.object({
    id,
    recommendation_id: id,
    approver_ids: z.array(id).min(1),
  }),
  async handler({ user }, i) {
    const campaign = await requireCampaignRole(user, i.id);
    if (campaign.stage < 9) throw badRequest('Campaign must be at recommendation stage before submitting for approval');
    const rec = await one(`SELECT * FROM selection_recommendations WHERE id=$1 AND campaign_id=$2`, [i.recommendation_id, i.id]);
    if (!rec) throw notFound();
    if (rec.status !== 'submitted') throw badRequest('Recommendation must be submitted before sending for approval');

    // SoD check
    if (!campaign.sod_exception && i.approver_ids[0] === campaign.proposer_id) {
      throw badRequest('Proposer cannot be first approver — SoD violation. Set sod_exception=true in campaign settings if this is intentional.');
    }

    return tx(async (c) => {
      const routes = [];
      for (let idx = 0; idx < i.approver_ids.length; idx++) {
        const route = await c.one(
          `INSERT INTO selection_approval_routes (campaign_id, step_order, approver_role, approver_id, status, activated_at)
           VALUES ($1,$2,'org_owner',$3,$4,$5) RETURNING *`,
          [i.id, idx + 1, i.approver_ids[idx], idx === 0 ? 'active' : 'pending', idx === 0 ? new Date() : null]
        );
        routes.push(route);
      }
      await c.one(`UPDATE selection_campaigns SET stage=10, updated_at=now() WHERE id=$1 RETURNING stage`, [i.id]);
      await logAudit(c, i.id, user.id, 'submitted_for_approval', { recommendation_id: i.recommendation_id, approver_count: i.approver_ids.length });
      return { routes };
    });
  },
});

cap({
  name: 'decide_selection_approval',
  method: 'POST',
  path: '/selection-campaigns/:id/approval-decision',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Approve, reject, return, or abstain on a selection campaign',
  input: z.object({
    id,
    route_id: id,
    recommendation_id: id,
    decision: z.enum(['approve','reject','return','abstain']),
    reason: z.string().trim().min(10).max(2000),
    conditions: z.string().trim().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const campaign = await requireCampaignRole(user, i.id);
    const route = await one(`SELECT * FROM selection_approval_routes WHERE id=$1 AND campaign_id=$2`, [i.route_id, i.id]);
    if (!route) throw notFound();
    if (route.approver_id !== user.id && !isAdmin(user)) throw forbidden();
    if (route.status !== 'active') throw conflict('This approval step is not currently active');

    const reasonEnc = await encrypt(i.reason, 'selection_approval_reason');
    const conditionsEnc = i.conditions ? await encrypt(i.conditions, 'selection_approval_conditions') : null;

    return tx(async (c) => {
      const decision = await c.one(
        `INSERT INTO selection_approval_decisions (route_id, campaign_id, recommendation_id, approver_id, decision, reason_enc, conditions_enc)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [i.route_id, i.id, i.recommendation_id, user.id, i.decision, reasonEnc, conditionsEnc]
      );
      await c.one(`UPDATE selection_approval_routes SET status='completed' WHERE id=$1 RETURNING id`, [i.route_id]);

      if (i.decision === 'approve') {
        // Activate next step or advance campaign to stage 11
        const nextRoute = await c.one(
          `SELECT id FROM selection_approval_routes WHERE campaign_id=$1 AND status='pending' ORDER BY step_order ASC LIMIT 1`,
          [i.id]
        );
        if (nextRoute) {
          await c.one(`UPDATE selection_approval_routes SET status='active', activated_at=now() WHERE id=$1 RETURNING id`, [nextRoute.id]);
        } else {
          await c.one(`UPDATE selection_campaigns SET stage=11, updated_at=now() WHERE id=$1 RETURNING stage`, [i.id]);
        }
      } else if (i.decision === 'reject' || i.decision === 'return') {
        // Return to recommendation stage
        await c.one(`UPDATE selection_campaigns SET stage=$2, updated_at=now() WHERE id=$1 RETURNING stage`, [i.id, i.decision === 'return' ? 9 : 8]);
        await c.one(`UPDATE selection_recommendations SET status='returned', updated_at=now() WHERE id=$1 RETURNING id`, [i.recommendation_id]);
        await c.one(`UPDATE selection_approval_routes SET status='skipped' WHERE campaign_id=$1 AND status IN ('pending','active') RETURNING id`, [i.id]);
      }
      await logAudit(c, i.id, user.id, 'approval_decision', { decision: i.decision, route_id: i.route_id });
      return decision;
    });
  },
});

cap({
  name: 'get_selection_approval_routes',
  method: 'GET',
  path: '/selection-campaigns/:id/approval-routes',
  tag: TAG,
  auth: ['admin', 'coach', 'organizer'],
  status: 200,
  summary: 'Get the full approval chain for a campaign with current status and decisions',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireCampaignRole(user, i.id);
    const routes = await many(
      `SELECT sar.*,
              u.display_name AS approver_name,
              du.display_name AS delegate_name,
              sad.decision AS last_decision,
              sad.decided_at AS last_decided_at
       FROM selection_approval_routes sar
       LEFT JOIN users u ON u.id = sar.approver_id
       LEFT JOIN users du ON du.id = sar.delegate_id
       LEFT JOIN selection_approval_decisions sad ON sad.route_id = sar.id
       WHERE sar.campaign_id = $1
       ORDER BY sar.step_order ASC`,
      [i.id]
    );
    return routes;
  },
});

cap({
  name: 'save_selection_policy',
  method: 'POST',
  path: '/organisations/:org_id/selection-policies',
  tag: TAG,
  auth: ['admin', 'organizer'],
  status: 201,
  summary: 'Save or update the organisation selection approval policy',
  input: z.object({
    org_id: id,
    name: z.string().trim().min(1).max(120),
    approval_chain: z.array(z.object({
      step_order: z.number().int().min(1),
      approver_role: z.enum(['org_owner','club_owner','academy_director','team_manager','head_coach','named_delegate']),
      sla_hours: z.number().int().min(1).max(720).default(72),
      parallel: z.boolean().default(false),
      is_required: z.boolean().default(true),
    })).min(1).max(10),
    sod_rules: z.record(z.string(), z.boolean()).default({}),
    sport_templates: z.record(z.string(), z.object({
      weights: z.record(z.string(), z.number().min(0).max(100)).default({}),
      evidence_min: z.number().int().min(0).max(20).default(1),
    })).default({}),
    delegation_rules: z.record(z.string(), z.any()).default({}),
    changelog: z.string().trim().max(500).optional(),
    effective_at: z.string().datetime().optional(),
  }),
  async handler({ user }, i) {
    // Verify user is org owner/admin
    const membership = await one(
      `SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND left_at IS NULL`,
      [i.org_id, user.id]
    );
    if (!membership || !['owner','admin'].includes(membership.role)) {
      if (!isAdmin(user)) throw forbidden('Only organisation owners and admins can configure selection policies');
    }
    return tx(async (c) => {
      // Supersede existing active policy
      await c.one(
        `UPDATE selection_org_policies SET superseded_at=now() WHERE org_id=$1 AND superseded_at IS NULL RETURNING id`,
        [i.org_id]
      ).catch(() => {}); // ok if none exists
      const prevVersion = (await one(
        `SELECT max(version_number)::int AS v FROM selection_org_policies WHERE org_id=$1`,
        [i.org_id]
      ))?.v ?? 0;
      const policy = await c.one(
        `INSERT INTO selection_org_policies(org_id, name, version_number, approval_chain, sod_rules, sport_templates, delegation_rules, effective_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [i.org_id, i.name, prevVersion + 1, JSON.stringify(i.approval_chain), JSON.stringify(i.sod_rules), JSON.stringify(i.sport_templates), JSON.stringify(i.delegation_rules), i.effective_at ? new Date(i.effective_at) : new Date(), user.id]
      );
      await logAudit(c, null, user.id, 'selection_policy_saved', { org_id: i.org_id, policy_id: policy.id, version: prevVersion + 1, changelog: i.changelog });
      return policy;
    });
  },
});

cap({
  name: 'get_selection_policies',
  method: 'GET',
  path: '/organisations/:org_id/selection-policies',
  tag: TAG,
  auth: ['admin', 'coach', 'organizer'],
  status: 200,
  summary: 'List active and historical selection policies for an organisation',
  input: z.object({ org_id: id }),
  async handler({ user }, i) {
    const membership = await one(
      `SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND left_at IS NULL`,
      [i.org_id, user.id]
    );
    if (!membership && !isAdmin(user)) throw forbidden();
    const policies = await many(
      `SELECT sop.*, u.display_name AS created_by_name
       FROM selection_org_policies sop LEFT JOIN users u ON u.id=sop.created_by
       WHERE sop.org_id=$1 ORDER BY sop.version_number DESC`,
      [i.org_id]
    );
    return policies;
  },
});

cap({
  name: 'delegate_selection_approval',
  method: 'POST',
  path: '/selection-campaigns/:id/delegate-approval',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Delegate an approval step to another user',
  input: z.object({
    id,
    route_id: id,
    delegate_id: id,
    reason: z.string().trim().max(500),
  }),
  async handler({ user }, i) {
    const campaign = await requireCampaignRole(user, i.id);
    const route = await one(`SELECT * FROM selection_approval_routes WHERE id=$1 AND campaign_id=$2 AND status='active'`, [i.route_id, i.id]);
    if (!route) throw notFound();
    if (route.approver_id !== user.id && !isAdmin(user)) throw forbidden();
    return tx(async (c) => {
      const updated = await c.one(
        `UPDATE selection_approval_routes SET delegate_id=$2, status='delegated' WHERE id=$1 RETURNING *`,
        [i.route_id, i.delegate_id]
      );
      await logAudit(c, i.id, user.id, 'approval_delegated', { to: i.delegate_id, route_id: i.route_id });
      return updated;
    });
  },
});
