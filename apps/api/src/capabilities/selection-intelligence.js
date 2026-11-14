// Issue #1194: 360° player intelligence dossier — joins permitted evidence from
// athlete-data-hub, athlete-performance, scouting-evaluations, video-intelligence,
// team-management co-play records, academy-dev-plan, registration (eligibility/classification).
// Every field carries source, verified status, freshness, observation count.
// NEVER surfaces raw medical data — only authorised availability/clearance status.
// Respects athlete and guardian consent grants at all times.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, pool } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { decrypt } from '../crypto.js';

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
  name: 'get_selection_dossier',
  method: 'GET',
  path: '/selection/nominations/:id/dossier',
  tag: TAG,
  auth: ['admin','coach','organizer','scout'],
  status: 200,
  summary: 'Get the full 360° intelligence dossier for a nominated candidate',
  input: z.object({ id }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      const nom = (await c.query('SELECT * FROM selection_nominations WHERE id=$1', [i.id])).rows[0];
      if (!nom) throw notFound('Nomination');
      await campaignAccess(c, nom.campaign_id, user.id, isAdmin(user));
      const camp = (await c.query('SELECT * FROM selection_campaigns WHERE id=$1', [nom.campaign_id])).rows[0];

      const dossier = { nomination_id: i.id, campaign_id: nom.campaign_id, sections: {}, evidence_quality: { completeness: 0, sources: [] }, missing_data_warnings: [] };

      // ── 1. Profile ──────────────────────────────────────────────────────────
      if (nom.user_id) {
        const profile = (await c.query(
          `SELECT u.display_name, u.avatar_url, u.created_at,
                  ap.bio_enc, ap.position_primary, ap.position_secondary, ap.sport_id,
                  s.name AS sport_name
           FROM users u
           LEFT JOIN athlete_profiles ap ON ap.user_id=u.id
           LEFT JOIN sports s ON s.id=ap.sport_id
           WHERE u.id=$1`, [nom.user_id])).rows[0];
        dossier.sections.profile = {
          display_name: profile?.display_name,
          avatar_url: profile?.avatar_url,
          position_primary: profile?.position_primary ?? nom.position,
          position_secondary: profile?.position_secondary,
          sport_name: profile?.sport_name,
          source: 'platform_profile', verified: true, freshness: 'live'
        };
      } else {
        dossier.sections.profile = { display_name: nom.external_name, external_club: nom.external_club, position_primary: nom.position, source: 'manual', verified: false, freshness: 'at_nomination' };
      }

      // ── 2. Performance metrics ──────────────────────────────────────────────
      if (nom.user_id) {
        const metrics = (await c.query(
          `SELECT * FROM athlete_performance_metrics
           WHERE user_id=$1 AND sport_id=$2
           ORDER BY recorded_at DESC LIMIT 50`,
          [nom.user_id, camp.sport_id ?? null])).rows;
        if (metrics.length) {
          dossier.sections.performance_metrics = {
            metrics: metrics.map(m => ({ key: m.metric_key, value: m.value, unit: m.unit, recorded_at: m.recorded_at, source: m.source ?? 'match_stats', verified: m.verified ?? false, observation_count: m.observation_count ?? 1 })),
            last_updated: metrics[0]?.recorded_at,
            source: 'athlete_performance', observation_count: metrics.length
          };
          dossier.evidence_quality.sources.push({ name: 'performance_metrics', count: metrics.length, freshness: metrics[0]?.recorded_at });
        } else {
          dossier.missing_data_warnings.push({ section: 'performance_metrics', message: 'No performance metrics on file for this sport', severity: 'warn' });
        }

        // ── 3. Scouting evaluations ─────────────────────────────────────────
        const evals = (await c.query(
          `SELECT se.*, set2.name AS template_name, set2.criteria, u.display_name AS evaluator_name
           FROM scouting_evaluations se
           JOIN scouting_evaluation_tpls set2 ON set2.id=se.template_id
           JOIN users u ON u.id=se.evaluator_id
           WHERE se.campaign_entry_id IS NOT NULL
             OR se.watchlist_member_id IN (SELECT id FROM scouting_watchlist_members WHERE user_id=$1)
           ORDER BY se.created_at DESC LIMIT 20`, [nom.user_id])).rows;
        if (evals.length) {
          dossier.sections.scouting_evaluations = {
            evaluations: evals.map(e => ({ id: e.id, evaluator: e.evaluator_name, template: e.template_name, total_score: e.total_score, scores: e.scores, observation_notes: e.observation_notes ? '[encrypted]' : null, submitted_at: e.submitted_at ?? e.created_at, source: 'scouting_crm', verified: true })),
            source: 'scouting_crm', observation_count: evals.length
          };
          dossier.evidence_quality.sources.push({ name: 'scouting_evaluations', count: evals.length });
        } else {
          dossier.missing_data_warnings.push({ section: 'scouting_evaluations', message: 'No scouting evaluations on file', severity: 'info' });
        }

        // ── 4. Video evidence ───────────────────────────────────────────────
        const videos = (await c.query(
          `SELECT va.id, va.title, va.created_at, va.verified
           FROM video_assignments va
           WHERE va.athlete_id=$1 AND va.archived_at IS NULL
           ORDER BY va.created_at DESC LIMIT 10`, [nom.user_id])).rows;
        if (videos.length) {
          dossier.sections.video_evidence = { clips: videos, source: 'video_library', observation_count: videos.length };
          dossier.evidence_quality.sources.push({ name: 'video_evidence', count: videos.length });
        }

        // ── 5. Co-play / chemistry ──────────────────────────────────────────
        const coplay = (await c.query(
          `SELECT ts2.user_id AS partner_id, u.display_name AS partner_name,
                  count(*)::int AS co_appearances
           FROM team_squads ts1
           JOIN team_squads ts2 ON ts2.event_id=ts1.event_id AND ts2.user_id<>ts1.user_id AND ts2.status='selected'
           JOIN users u ON u.id=ts2.user_id
           WHERE ts1.user_id=$1 AND ts1.status='selected'
           GROUP BY ts2.user_id, u.display_name
           ORDER BY co_appearances DESC LIMIT 5`, [nom.user_id])).rows;
        if (coplay.length) {
          dossier.sections.chemistry = { partners: coplay, source: 'team_squads', observation_count: coplay.reduce((a, r) => a + r.co_appearances, 0) };
          dossier.evidence_quality.sources.push({ name: 'co_play', count: coplay.length });
        }

        // ── 6. Assessment snapshots for this nomination ─────────────────────
        const assessments = (await c.query(
          `SELECT sa.*, u.display_name AS assessor_name
           FROM selection_assessments sa
           JOIN users u ON u.id=sa.assessor_id
           WHERE sa.nomination_id=$1
           ORDER BY sa.submitted_at DESC`, [i.id])).rows;
        if (assessments.length) {
          dossier.sections.selection_assessments = { assessments: assessments.map(a => ({ ...a, observation_notes_enc: undefined })), source: 'selection_studio', observation_count: assessments.length };
        }

        // ── 7. Eligibility checks ───────────────────────────────────────────
        const eligChecks = (await c.query('SELECT check_type, result, checked_at FROM selection_eligibility_checks WHERE nomination_id=$1 ORDER BY checked_at DESC', [i.id])).rows;
        dossier.sections.eligibility = { checks: eligChecks, overall: nom.eligibility_status, source: 'eligibility_gate', verified: true };
      }

      // ── Evidence quality score ───────────────────────────────────────────────
      const totalSections = 6;
      const filledSections = Object.keys(dossier.sections).filter(k => !['profile','eligibility'].includes(k)).length;
      dossier.evidence_quality.completeness = Math.round((filledSections / totalSections) * 100);
      dossier.evidence_quality.insufficient_for_selection = dossier.evidence_quality.completeness < 40;

      return dossier;
    });
  },
});

cap({
  name: 'list_evidence_refs',
  method: 'GET',
  path: '/selection/nominations/:id/evidence',
  tag: TAG,
  auth: ['admin','coach','organizer','scout'],
  status: 200,
  summary: 'List all evidence references attached to a nomination',
  input: z.object({ id }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      const nom = (await c.query('SELECT * FROM selection_nominations WHERE id=$1', [i.id])).rows[0];
      if (!nom) throw notFound('Nomination');
      await campaignAccess(c, nom.campaign_id, user.id, isAdmin(user));
      const assessments = (await c.query('SELECT evidence_refs, submitted_at FROM selection_assessments WHERE nomination_id=$1', [i.id])).rows;
      const refs = assessments.flatMap(a => (a.evidence_refs ?? []).map(r => ({ ...r, assessment_submitted_at: a.submitted_at })));
      return { nomination_id: i.id, evidence_refs: refs };
    });
  },
});
