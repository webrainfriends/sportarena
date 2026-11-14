// Issue #1194: Atomic roster publication — eligibility recheck, idempotent write to
// team_squads, competition-registration handoff, authorised notifications, PDF/CSV export.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';

const TAG = 'Selection';

async function orgMember(c, orgId, userId) {
  return !!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND left_at IS NULL", [orgId, userId])).rows.length;
}
async function campaignAccess(c, campaignId, userId, adminOk = false) {
  const camp = (await c.query('SELECT * FROM selection_campaigns WHERE id=$1', [campaignId])).rows[0];
  if (!camp) throw notFound('SelectionCampaign');
  if (!(await orgMember(c, camp.org_id, userId)) && !adminOk) throw forbidden();
  return camp;
}

cap({
  name: 'publish_selection_roster',
  method: 'POST',
  path: '/selection/campaigns/:id/publish',
  tag: TAG,
  auth: ['admin','organizer'],
  status: 200,
  summary: 'Atomically publish the approved roster — rechecks eligibility, writes to team_squads, notifies athletes',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const camp = await campaignAccess(c, i.id, user.id, isAdmin(user));
      if (camp.row_version !== i.row_version) throw conflict('Campaign was modified; reload and try again');
      if (camp.stage < 11) throw badRequest('The campaign must reach the publication stage (stage 11) before publishing');
      const dec = (await c.query(
        `SELECT sad.* FROM selection_approval_decisions sad
         JOIN selection_approval_routes sar ON sar.id=sad.route_id
         WHERE sar.campaign_id=$1 AND sad.decision='approve'
         ORDER BY sad.decided_at DESC LIMIT 1`, [i.id])).rows[0];
      if (!dec) throw badRequest('The roster cannot be published without a final approval decision');
      const rec = (await c.query("SELECT * FROM selection_recommendations WHERE campaign_id=$1 AND status='submitted' ORDER BY version_number DESC LIMIT 1", [i.id])).rows[0];
      if (!rec) throw badRequest('No submitted recommendation found for publication');
      const snap = rec.squad_snapshot ?? {};
      const allSelected = [...(snap.starting ?? []), ...(snap.reserves ?? [])];
      if (allSelected.length) {
        const ineligible = (await c.query("SELECT id FROM selection_nominations WHERE id=ANY($1) AND eligibility_status='fail'", [allSelected])).rows;
        if (ineligible.length) throw badRequest(`Eligibility recheck failed: ${ineligible.length} selected candidate(s) are ineligible. Resolve before publishing.`);
      }
      const existing = (await c.query('SELECT id FROM selection_roster_publications WHERE campaign_id=$1', [i.id])).rows[0];
      if (existing) throw conflict('This campaign has already been published. Use a substitution flow for changes.');
      let squadWritten = 0;
      if (camp.team_id && camp.competition_id) {
        for (const nomId of allSelected) {
          const nom = (await c.query('SELECT user_id FROM selection_nominations WHERE id=$1', [nomId])).rows[0];
          if (!nom?.user_id) continue;
          const existing = (await c.query('SELECT id FROM team_squads WHERE team_id=$1 AND user_id=$2 AND event_id=$3', [camp.team_id, nom.user_id, camp.competition_id])).rows[0];
          if (!existing) {
            await c.query(
              "INSERT INTO team_squads(team_id, user_id, event_id, role, status) VALUES ($1,$2,$3,'player','selected') ON CONFLICT DO NOTHING",
              [camp.team_id, nom.user_id, camp.competition_id]);
            squadWritten++;
          }
        }
      }
      const pubId = (await c.query(
        'INSERT INTO selection_roster_publications(campaign_id, approval_decision_id, recommendation_id, roster_snapshot, eligibility_recheck_at, published_by) VALUES ($1,$2,$3,$4,now(),$5) RETURNING id',
        [i.id, dec.id, rec.id, JSON.stringify(snap), user.id]
      )).rows[0].id;
      await c.query("UPDATE selection_campaigns SET status='completed', row_version=row_version+1, updated_at=now() WHERE id=$1", [i.id]);
      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4)',
        [i.id, user.id, 'roster_published', JSON.stringify({ publication_id: pubId, starting_count: (snap.starting ?? []).length, squad_written: squadWritten })]);
      for (const nomId of (snap.starting ?? [])) {
        const nom = (await c.query('SELECT user_id FROM selection_nominations WHERE id=$1', [nomId])).rows[0];
        if (nom?.user_id) await notify(nom.user_id, 'selection_squad_published', { campaign_id: i.id, campaign_name: camp.name, role: 'starting' }).catch(() => {});
      }
      await c.query('UPDATE selection_roster_publications SET notifications_sent_at=now() WHERE id=$1', [pubId]);
      return { id: pubId, squad_written: squadWritten, starting_count: (snap.starting ?? []).length, reserve_count: (snap.reserves ?? []).length };
    });
  },
});

cap({
  name: 'get_decision_pack',
  method: 'GET',
  path: '/selection/campaigns/:id/decision-pack',
  tag: TAG,
  auth: ['admin','coach','organizer'],
  status: 200,
  summary: 'Get the full signed decision pack for a campaign (for PDF/CSV export)',
  input: z.object({ id }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      const camp = await campaignAccess(c, i.id, user.id, isAdmin(user));
      const rec = (await c.query("SELECT * FROM selection_recommendations WHERE campaign_id=$1 ORDER BY version_number DESC LIMIT 1", [i.id])).rows[0];
      const decisions = (await c.query(
        `SELECT sad.*, u.display_name AS decided_by_name, sar.approver_role
         FROM selection_approval_decisions sad
         JOIN selection_approval_routes sar ON sar.id=sad.route_id
         JOIN users u ON u.id=sad.decided_by
         WHERE sar.campaign_id=$1 ORDER BY sad.decided_at`, [i.id])).rows;
      const auditEvents = (await c.query(
        `SELECT sae.*, u.display_name AS actor_name
         FROM selection_audit_events sae LEFT JOIN users u ON u.id=sae.actor_id
         WHERE sae.campaign_id=$1 ORDER BY sae.occurred_at`, [i.id])).rows;
      const policyVersion = (await c.query('SELECT * FROM selection_policy_versions WHERE campaign_id=$1 ORDER BY version_number DESC LIMIT 1', [i.id])).rows[0];
      const committeeReviews = (await c.query(
        `SELECT scr.vote, scr.conflict_declared, scr.created_at, u.display_name AS reviewer_name
         FROM selection_committee_reviews scr JOIN users u ON u.id=scr.reviewer_id
         WHERE scr.campaign_id=$1`, [i.id])).rows;
      return {
        campaign: { id: camp.id, name: camp.name, purpose: camp.purpose, sport_id: camp.sport_id, age_bracket: camp.age_bracket, season_label: camp.season_label, formation: camp.formation, target_squad_size: camp.target_squad_size, stage: camp.stage, status: camp.status, created_at: camp.created_at },
        policy_version: policyVersion,
        recommendation: rec ? { squad_snapshot: rec.squad_snapshot, submitted_at: rec.submitted_at, version: rec.version_number } : null,
        committee_reviews: committeeReviews,
        approval_decisions: decisions.map(d => ({ ...d, reason_enc: undefined })),
        audit_events: auditEvents,
        pack_generated_at: new Date().toISOString(),
        pack_version: decisions.length + 1,
      };
    });
  },
});

cap({
  name: 'get_selection_outcomes',
  method: 'GET',
  path: '/selection/campaigns/:id/outcomes',
  tag: TAG,
  auth: ['admin','coach','organizer'],
  status: 200,
  summary: 'Get post-selection outcomes: forecast vs actual, development outcomes, fairness, calibration',
  input: z.object({ id }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      const camp = await campaignAccess(c, i.id, user.id, isAdmin(user));

      // Publication and final roster
      const pub = (await c.query('SELECT * FROM selection_roster_publications WHERE campaign_id=$1', [i.id])).rows[0];
      const rec = pub
        ? (await c.query('SELECT * FROM selection_recommendations WHERE id=$1', [pub.recommendation_id])).rows[0]
        : null;
      const snap = rec?.squad_snapshot ?? {};
      const allSelected = [...(snap.starting ?? []), ...(snap.reserves ?? [])];

      // Latest forecast run
      const forecast = (await c.query('SELECT * FROM selection_forecast_runs WHERE campaign_id=$1 ORDER BY run_at DESC LIMIT 1', [i.id])).rows[0];

      // All nominations with their assessment scores (for development outcomes)
      const nominations = (await c.query(
        `SELECT sn.id, sn.user_id, sn.position, sn.stage, u.display_name,
                sa.total_score, sa.confidence
         FROM selection_nominations sn
         LEFT JOIN users u ON u.id = sn.user_id
         LEFT JOIN LATERAL (
           SELECT total_score, confidence FROM selection_assessments
           WHERE nomination_id=sn.id ORDER BY submitted_at DESC LIMIT 1
         ) sa ON true
         WHERE sn.campaign_id=$1 AND sn.removed_at IS NULL
         ORDER BY sn.stage, sa.total_score DESC NULLS LAST`,
        [i.id])).rows;

      const selectedSet = new Set(allSelected);
      const developmentNominations = nominations.filter(n => !selectedSet.has(n.id));
      const selectedNominations = nominations.filter(n => selectedSet.has(n.id));

      // Build forecast vs actual per selected player
      // Actual performance: join team_squads appearance data where available
      const forecastCandidates = forecast?.result?.scenarios?.[0]?.candidates ?? [];
      const forecastMap = {};
      for (const fc of forecastCandidates) {
        forecastMap[fc.nomination_id] = fc;
      }

      const forecastVsActual = selectedNominations.map(nom => {
        const fc = forecastMap[nom.id];
        return {
          nomination_id: nom.id,
          display_name: nom.display_name,
          position: nom.position,
          projected_score_range: fc?.projected_score_range ?? null,
          actual_score: nom.total_score,
          confidence: nom.confidence,
          verdict: !fc ? 'no_forecast'
            : !nom.total_score ? 'insufficient_data'
            : nom.total_score >= (fc.projected_score_range?.[1] ?? 0) ? 'exceeded'
            : nom.total_score >= (fc.projected_score_range?.[0] ?? 0) ? 'met'
            : 'below',
        };
      });

      // Calibration metrics
      const calibration = (() => {
        const withBoth = forecastVsActual.filter(r => r.projected_score_range && r.actual_score);
        if (!withBoth.length) return { insufficient_data: true };
        const mae = withBoth.reduce((sum, r) => {
          const midForecast = ((r.projected_score_range[0] + r.projected_score_range[1]) / 2);
          return sum + Math.abs(r.actual_score - midForecast);
        }, 0) / withBoth.length;
        const withinRange = withBoth.filter(r => r.actual_score >= r.projected_score_range[0] && r.actual_score <= r.projected_score_range[1]).length;
        return {
          mae: Math.round(mae * 10) / 10,
          confidence_coverage_pct: Math.round((withinRange / withBoth.length) * 100),
          model_version: forecast?.model_version ?? 'v1',
          sample_size: withBoth.length,
          insufficient_data: false,
        };
      })();

      // Fairness: selection rate by position
      const positionGroups = {};
      for (const nom of nominations) {
        const pos = nom.position ?? 'unknown';
        if (!positionGroups[pos]) positionGroups[pos] = { total: 0, selected: 0 };
        positionGroups[pos].total++;
        if (selectedSet.has(nom.id)) positionGroups[pos].selected++;
      }
      const fairness = {
        positions: Object.entries(positionGroups).map(([pos, g]) => ({
          position: pos, total: g.total, selected: g.selected,
          rate_pct: Math.round((g.selected / g.total) * 100),
        })),
        disparity_flag: Object.values(positionGroups).some(g => g.total >= 3 && (g.selected / g.total) < 0.1),
      };

      return {
        campaign: { id: camp.id, name: camp.name, purpose: camp.purpose, sport_id: camp.sport_id },
        publication: pub ? { id: pub.id, published_at: pub.published_at } : null,
        starter_count: (snap.starting ?? []).length,
        reserve_count: (snap.reserves ?? []).length,
        development_count: developmentNominations.length,
        forecast_run_id: forecast?.id ?? null,
        forecast_vs_actual: forecastVsActual,
        development_nominations: developmentNominations.map(n => ({
          nomination_id: n.id, display_name: n.display_name, position: n.position, stage: n.stage
        })),
        fairness,
        calibration,
      };
    });
  },
});

cap({
  name: 'submit_committee_review',
  method: 'POST',
  path: '/selection/campaigns/:id/committee-reviews',
  tag: TAG,
  auth: ['admin','coach','organizer'],
  status: 201,
  summary: 'Submit a committee review/vote on the recommendation',
  input: z.object({
    id,
    recommendation_id: id,
    vote: z.enum(['approve','challenge','abstain']),
    comment: z.string().trim().max(1000).nullable().default(null),
    conflict_declared: z.boolean().default(false),
    conflict_note: z.string().trim().max(500).nullable().default(null),
    dissent_note: z.string().trim().max(500).nullable().default(null),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await campaignAccess(c, i.id, user.id, isAdmin(user));
      const { encrypt } = await import('../crypto.js');
      const rvId = (await c.query(
        'INSERT INTO selection_committee_reviews(campaign_id, recommendation_id, reviewer_id, comment_enc, vote, conflict_declared, conflict_note_enc, dissent_note_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [i.id, i.recommendation_id, user.id, i.comment ? encrypt(i.comment, 'review_comment') : null, i.vote, i.conflict_declared, i.conflict_note ? encrypt(i.conflict_note, 'conflict_note') : null, i.dissent_note ? encrypt(i.dissent_note, 'dissent_note') : null]
      )).rows[0].id;
      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4)',
        [i.id, user.id, 'committee_reviewed', JSON.stringify({ review_id: rvId, vote: i.vote, conflict_declared: i.conflict_declared })]);
      return { id: rvId };
    });
  },
});
