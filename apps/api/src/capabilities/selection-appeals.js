// Issue #1194: Appeals, emergency substitutions, post-event outcome recording.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, pool } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { encrypt } from '../crypto.js';

const TAG = 'Selection';
const text = (n) => z.string().trim().min(1).max(n);

async function orgMember(c, orgId, userId) {
  return !!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND left_at IS NULL", [orgId, userId])).rows.length;
}

cap({
  name: 'submit_selection_appeal',
  method: 'POST',
  path: '/selection/nominations/:id/appeal',
  tag: TAG,
  auth: 'user',
  status: 201,
  summary: 'Submit an appeal against a selection decision',
  input: z.object({ id, grounds: text(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const nom = (await c.query('SELECT * FROM selection_nominations WHERE id=$1', [i.id])).rows[0];
      if (!nom) throw notFound('Nomination');
      if (nom.user_id !== user.id && !isAdmin(user)) throw forbidden();
      const camp = (await c.query('SELECT * FROM selection_campaigns WHERE id=$1', [nom.campaign_id])).rows[0];
      if (!['completed'].includes(camp.status) && camp.stage < 10) throw badRequest('Appeals can only be submitted after the selection has reached the approval stage');
      const existing = (await c.query("SELECT id FROM selection_appeals WHERE nomination_id=$1 AND status NOT IN ('withdrawn','dismissed')", [i.id])).rows[0];
      if (existing) throw badRequest('An active appeal already exists for this nomination');
      const appId = (await c.query(
        'INSERT INTO selection_appeals(campaign_id, nomination_id, appellant_id, grounds_enc) VALUES ($1,$2,$3,$4) RETURNING id',
        [nom.campaign_id, i.id, user.id, encrypt(i.grounds, 'appeal_grounds')]
      )).rows[0].id;
      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, nomination_id, payload) VALUES ($1,$2,$3,$4,$5)',
        [nom.campaign_id, user.id, 'appeal_submitted', i.id, JSON.stringify({ appeal_id: appId })]);
      return { id: appId };
    });
  },
});

cap({
  name: 'resolve_selection_appeal',
  method: 'POST',
  path: '/selection/appeals/:id/resolve',
  tag: TAG,
  auth: ['admin','organizer'],
  status: 200,
  summary: 'Resolve an appeal (uphold or dismiss)',
  input: z.object({
    id,
    status: z.enum(['upheld','dismissed']),
    reviewer_note: text(1000),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const appeal = (await c.query('SELECT * FROM selection_appeals WHERE id=$1', [i.id])).rows[0];
      if (!appeal) throw notFound('Appeal');
      if (!['submitted','under_review'].includes(appeal.status)) throw badRequest('This appeal cannot be resolved in its current state');
      const camp = (await c.query('SELECT org_id FROM selection_campaigns WHERE id=$1', [appeal.campaign_id])).rows[0];
      if (!(await orgMember(c, camp.org_id, user.id)) && !isAdmin(user)) throw forbidden();
      await c.query('UPDATE selection_appeals SET status=$1, reviewer_id=$2, reviewer_note_enc=$3, resolved_at=now() WHERE id=$4',
        [i.status, user.id, encrypt(i.reviewer_note, 'reviewer_note'), i.id]);
      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, nomination_id, payload) VALUES ($1,$2,$3,$4,$5)',
        [appeal.campaign_id, user.id, 'appeal_resolved', appeal.nomination_id, JSON.stringify({ appeal_id: i.id, status: i.status })]);
      if (appeal.appellant_id) await notify(appeal.appellant_id, 'selection_appeal_resolved', { appeal_id: i.id, status: i.status }).catch(() => {});
      return { id: i.id, status: i.status };
    });
  },
});

cap({
  name: 'list_selection_appeals',
  method: 'GET',
  path: '/selection/campaigns/:id/appeals',
  tag: TAG,
  auth: ['admin','organizer','coach'],
  status: 200,
  summary: 'List all appeals for a campaign',
  input: z.object({ id }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      const camp = (await c.query('SELECT * FROM selection_campaigns WHERE id=$1', [i.id])).rows[0];
      if (!camp) throw notFound('SelectionCampaign');
      if (!(await orgMember(c, camp.org_id, user.id)) && !isAdmin(user)) throw forbidden();
      return (await c.query(
        `SELECT sa.id, sa.status, sa.created_at, sa.resolved_at,
                u.display_name AS appellant_name, sn.position, sn.stage AS nomination_stage
         FROM selection_appeals sa
         JOIN users u ON u.id=sa.appellant_id
         LEFT JOIN selection_nominations sn ON sn.id=sa.nomination_id
         WHERE sa.campaign_id=$1 ORDER BY sa.created_at DESC`, [i.id])).rows;
    });
  },
});
