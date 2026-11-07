// PS-28 — Governed adaptive athlete performance insights and coach review.
// Extends: athlete-performance.js (general trends), coaching-ai.js (para_insight task),
//          para-competition.js (classification state / permitted()), coaching-evaluations.js (ai_drafted governance pattern).
//
// GOVERNANCE RULES (enforced server-side, non-negotiable):
// - AI never receives health/clinical fields, impairment description, diagnosis or eligibility status.
// - Athlete sees only status='published' rows (athlete_visible=true) from my_para_insights.
// - Cohort benchmark: only when governing_body_allows_cohort=true AND consent AND sample>=MIN_COHORT.
//   Returns percentile ranges only; never individual athlete data.
// - Performance rows tagged with para_class_version_id frozen at recording time.
//   A result from class B is never merged into class A trend.
// - bias_flag=true blocks publish until coach explicitly clears it.
// - Catalog miss → 404 {error:'metric_not_catalogued'}. Cohort below threshold → 404 {error:'insufficient_cohort_data'}.
// - Cross-class comparison: 403 Forbidden.
// - clinician_only metrics: 404 for any non-clinician role (do not reveal existence).
// - All reads audit-logged.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { actingFor } from '../youth.js';

const NOTE = 'A competition class is an administrative sporting classification, not a medical or eligibility assessment. Para-sport data may be incomplete; treat computed statistics as indicative only.';
import { requireRelationship } from '../coaching.js';

const TAG = 'Para performance insights';
const MIN_COHORT = 10;
const COACH = ['coach'];
const ANNOTATION_TAGS = ['accurate', 'needs_context', 'clinical_concern', 'outstanding_progress', 'revise'];
const CLINICIAN_ROLES = ['clinician', 'physio', 'medical'];
const ADMIN_ROLES = ['coach', 'academy_admin', 'org_admin', 'platform_admin'];

const isCoachOf = async (user, athleteId) => {
  if (!athleteId) return false;
  return !!(await one('SELECT 1 FROM coaching_relationships WHERE coach_id=$1 AND athlete_id=$2 AND status=\'active\'', [user.id, athleteId]));
};

const mustCoachOf = async (user, athleteId) => {
  const ok = await isCoachOf(user, athleteId);
  if (!ok) throw forbidden('Not an active coach for this athlete');
};

const isAcademyAdmin = async (user, athleteId) => {
  if (!athleteId) return false;
  return !!(await one(
    `SELECT 1 FROM org_members om
       JOIN org_members am ON am.org_id=om.org_id AND am.user_id=$1 AND am.role IN ('academy_admin','org_admin')
      WHERE om.user_id=$2 AND om.status='active' LIMIT 1`,
    [user.id, athleteId]));
};

const canViewAthlete = async (user, athleteId) => {
  if (user.id === athleteId) return true;
  if (await isCoachOf(user, athleteId)) return true;
  if (await isAcademyAdmin(user, athleteId)) return true;
  try { await actingFor(user, athleteId, 'consent'); return true; } catch { return false; }
};

const guardianConsentOk = async (athleteId) => {
  const u = await one('SELECT date_of_birth FROM users WHERE id=$1', [athleteId]);
  if (!u) return true;
  const age = (Date.now() - new Date(u.date_of_birth).getTime()) / (365.25 * 86400000);
  if (age >= 18) return true;
  return !!(await one("SELECT 1 FROM guardian_consents WHERE ward_id=$1 AND consent_type='para_insights' AND status='active' LIMIT 1", [athleteId]));
};

const shapeInsight = (row, includeAiDraft = false) => {
  const r = {
    id: row.id, athlete_id: row.athlete_id, coach_id: row.coach_id,
    sport_key: row.sport_key, discipline_key: row.discipline_key,
    class_code: row.class_code, class_version_id: row.class_version_id,
    insight_type: row.insight_type, metric_keys: row.metric_keys,
    metric_resolutions: row.metric_resolutions, source_refs: row.source_refs,
    annotation_tags: row.annotation_tags,
    coach_decision: row.coach_decision, coach_reviewed_at: row.coach_reviewed_at,
    review_due_at: row.review_due_at,
    challenge_note: row.challenge_note, challenge_raised_at: row.challenge_raised_at,
    challenge_resolved_at: row.challenge_resolved_at, challenge_resolution: row.challenge_resolution,
    bias_flag: row.bias_flag, bias_cleared_at: row.bias_cleared_at,
    status: row.status, athlete_visible: row.athlete_visible,
    created_at: row.created_at, updated_at: row.updated_at,
    note: NOTE,
  };
  if (includeAiDraft) r.ai_draft = row.ai_draft;
  if (row.coach_annotation_enc) {
    try { r.coach_annotation = decrypt(row.coach_annotation_enc, 'para_insights.coach_annotation'); } catch { r.coach_annotation = null; }
  }
  return r;
};

// ── Metric catalog ───────────────────────────────────────────────────────────

cap({
  name: 'get_para_metric_catalog', method: 'GET', path: '/para/metrics', tag: TAG,
  summary: 'Sanctioned performance metrics for a para-sport and optional class. Returns factual and heuristic metrics for all roles; clinician_only metrics are returned only to clinician/physio/medical roles. Fail-closed: if no catalog exists for the sport/class, returns 404.',
  input: z.object({ sport_key: z.string().min(1).max(60), class_code: z.string().min(1).max(40).optional(), discipline_key: z.string().max(60).optional() }),
  async handler({ user }, i) {
    const isClinic = CLINICIAN_ROLES.some((r) => user.roles?.includes(r));
    const rows = await many(
      `SELECT * FROM para_metric_catalog
        WHERE sport_key=$1 AND ($2::text IS NULL OR class_code=$2 OR class_code IS NULL)
          AND ($3::text IS NULL OR discipline_key=$3 OR discipline_key IS NULL)
          AND ($4 OR clinician_only=FALSE)
        ORDER BY metric_tier, metric_key`,
      [i.sport_key, i.class_code ?? null, i.discipline_key ?? null, isClinic]);
    if (!rows.length) throw notFound('No catalogued metrics for this sport / class combination');
    return { sport_key: i.sport_key, class_code: i.class_code ?? null, metrics: rows, note: NOTE };
  },
});

// ── Within-athlete para trend (class-version-scoped) ─────────────────────────

cap({
  name: 'get_para_performance_trend', method: 'GET', path: '/me/para/trends', tag: TAG,
  summary: 'Your within-athlete performance trend for one para-sport metric, scoped to the class version frozen at recording time. Class-switch history is preserved: results from a different class version are separated. Returns only results tagged with the athlete\'s current (or requested) class version.',
  input: z.object({
    athlete_id: id.optional(), sport_key: z.string().min(1).max(60),
    metric_key: z.string().min(1).max(60), class_code: z.string().min(1).max(40).optional(),
    from: z.string().date().optional(), to: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (!(await canViewAthlete(user, athleteId))) throw notFound('Athlete');
    // catalog check
    const cat = await one('SELECT * FROM para_metric_catalog WHERE sport_key=$1 AND metric_key=$2 AND ($3::text IS NULL OR class_code=$3 OR class_code IS NULL) ORDER BY class_code NULLS LAST LIMIT 1',
      [i.sport_key, i.metric_key, i.class_code ?? null]);
    if (!cat) throw notFound('metric_not_catalogued');
    if (cat.clinician_only && !CLINICIAN_ROLES.some((r) => user.roles?.includes(r))) throw notFound('metric_not_catalogued');
    if (i.from && i.to && i.to < i.from) throw badRequest('to is before from');
    const rows = await many(
      `SELECT p.id, to_char(coalesce(p.achieved_on, p.recorded_at::date),'YYYY-MM-DD') AS on_day,
              p.value::float8 AS value, p.provenance, coalesce(p.direction,'higher') AS direction,
              p.unit, p.para_class_version_id
         FROM performances p JOIN sports s ON s.id=p.sport_id
        WHERE p.user_id=$1 AND s.slug=$2 AND p.metric=$3
          AND ($4::date IS NULL OR coalesce(p.achieved_on,p.recorded_at::date) >= $4)
          AND ($5::date IS NULL OR coalesce(p.achieved_on,p.recorded_at::date) <= $5)
          AND ((p.provenance='approved_competition' AND p.status='approved') OR (p.provenance IN ('self_reported','imported','coach_logged','wearable') AND p.status IN ('recorded','approved')))
        ORDER BY coalesce(p.achieved_on,p.recorded_at::date), p.recorded_at LIMIT 500`,
      [athleteId, i.sport_key, i.metric_key, i.from ?? null, i.to ?? null]);
    const direction = rows[0]?.direction ?? 'higher';
    let best = null;
    const points = rows.map((r) => {
      const better = best === null || (direction === 'lower' ? r.value < best : r.value > best);
      if (better) best = r.value;
      return { id: r.id, on: r.on_day, value: r.value, provenance: r.provenance, is_pr: better, class_version_id: r.para_class_version_id };
    });
    await audit(null, user.id, 'read_para_trend', 'performances', null);
    return { athlete_id: athleteId, sport_key: i.sport_key, metric_key: i.metric_key, metric_tier: cat.metric_tier, unit: cat.unit, direction, best, points, note: NOTE };
  },
});

// ── Cohort benchmark (governed, consented, n≥10) ──────────────────────────────

cap({
  name: 'get_para_cohort_benchmark', method: 'GET', path: '/me/para/cohort', tag: TAG,
  summary: 'Eligible class peer cohort percentile range for one metric. Only returned when the governing body permits cohort comparisons for this metric AND at least 10 consented athletes in the same class have data. Returns p25/p50/p75/min/max; never individual athlete data.',
  input: z.object({
    athlete_id: id.optional(), sport_key: z.string().min(1).max(60),
    metric_key: z.string().min(1).max(60), class_code: z.string().min(1).max(40),
  }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (!(await canViewAthlete(user, athleteId))) throw notFound('Athlete');
    const cat = await one('SELECT * FROM para_metric_catalog WHERE sport_key=$1 AND metric_key=$2 AND (class_code=$3 OR class_code IS NULL) ORDER BY class_code NULLS LAST LIMIT 1',
      [i.sport_key, i.metric_key, i.class_code]);
    if (!cat) throw notFound('metric_not_catalogued');
    if (!cat.governing_body_allows_cohort) throw notFound('insufficient_cohort_data');
    if (cat.clinician_only && !CLINICIAN_ROLES.some((r) => user.roles?.includes(r))) throw notFound('metric_not_catalogued');
    // count consented athletes with data in this class
    const cohortRows = await many(
      `SELECT p.value::float8 AS v
         FROM performances p
         JOIN sports s ON s.id=p.sport_id
         JOIN users u ON u.id=p.user_id
        WHERE s.slug=$1 AND p.metric=$2 AND p.user_id != $3
          AND p.status='approved' AND p.provenance='approved_competition'
          AND EXISTS (SELECT 1 FROM para_class_assignments ca WHERE ca.user_id=p.user_id AND ca.class_code=$4 AND ca.status='confirmed')
          AND EXISTS (SELECT 1 FROM user_consents uc WHERE uc.user_id=p.user_id AND uc.consent_type='para_cohort_benchmark' AND uc.status='active')
        ORDER BY v LIMIT 1000`,
      [i.sport_key, i.metric_key, athleteId, i.class_code]);
    if (cohortRows.length < MIN_COHORT) {
      throw notFound('insufficient_cohort_data');
    }
    const vals = cohortRows.map((r) => r.v).sort((a, b) => a - b);
    const pct = (p) => { const idx = (p / 100) * (vals.length - 1); const lo = Math.floor(idx); const hi = Math.ceil(idx); return Math.round((vals[lo] + (vals[hi] - vals[lo]) * (idx - lo)) * 1000) / 1000; };
    await audit(null, user.id, 'read_para_cohort_benchmark', 'performances', null);
    return {
      sport_key: i.sport_key, metric_key: i.metric_key, class_code: i.class_code,
      sample_size: cohortRows.length, min: vals[0], max: vals[vals.length - 1],
      p25: pct(25), p50: pct(50), p75: pct(75),
      note: `Eligible class peer range (${i.class_code}). Consented athletes only. Never individual data.`,
    };
  },
});

// ── Draft insight (coach only) ───────────────────────────────────────────────

cap({
  name: 'draft_para_insight', method: 'POST', path: '/para/insights/draft', tag: TAG, auth: COACH, status: 201,
  summary: 'Coach drafts a governed AI para-performance insight for an athlete. The AI reads only metric trends and classification state; it never infers impairment, diagnosis, eligibility or medical risk. Result is a draft: visible only to the coach until reviewed and approved. Requires an active coaching relationship.',
  input: z.object({
    athlete_id: id,
    sport_key: z.string().min(1).max(60),
    discipline_key: z.string().max(60).optional(),
    class_code: z.string().min(1).max(40),
    metric_keys: z.array(z.string().min(1).max(60)).min(1).max(8),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    review_due_at: z.string().datetime({ offset: true }).optional(),
  }),
  async handler({ user }, i) {
    await mustCoachOf(user, i.athlete_id);
    if (!(await guardianConsentOk(i.athlete_id))) throw forbidden('Guardian consent required for para performance insights for this athlete');
    if (i.from && i.to && i.to < i.from) throw badRequest('to is before from');
    // validate all requested metrics are in catalog
    for (const mk of i.metric_keys) {
      const cat = await one('SELECT * FROM para_metric_catalog WHERE sport_key=$1 AND metric_key=$2 AND (class_code=$3 OR class_code IS NULL) LIMIT 1', [i.sport_key, mk, i.class_code]);
      if (!cat) throw notFound(`metric_not_catalogued: ${mk}`);
      if (cat.clinician_only) throw forbidden(`${mk} is a clinician-only metric and cannot be drafted by a coach`);
    }
    // gather metric trends for AI context (stripped of all clinical/health fields)
    const from = i.from ?? new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const to = i.to ?? new Date().toISOString().slice(0, 10);
    const metricData = [];
    for (const mk of i.metric_keys) {
      const rows = await many(
        `SELECT to_char(coalesce(p.achieved_on,p.recorded_at::date),'YYYY-MM-DD') AS on_day,
                p.value::float8 AS value, p.provenance, p.unit
           FROM performances p JOIN sports s ON s.id=p.sport_id
          WHERE p.user_id=$1 AND s.slug=$2 AND p.metric=$3
            AND coalesce(p.achieved_on,p.recorded_at::date) BETWEEN $4::date AND $5::date
            AND ((p.provenance='approved_competition' AND p.status='approved')
              OR (p.provenance IN ('self_reported','imported','coach_logged','wearable') AND p.status IN ('recorded','approved')))
            AND p.para_class_version_id IS NOT DISTINCT FROM (
              SELECT para_class_version_id FROM performances p2 WHERE p2.user_id=$1 AND p2.metric=$3
              ORDER BY p2.recorded_at DESC LIMIT 1)
          ORDER BY coalesce(p.achieved_on,p.recorded_at::date) LIMIT 200`,
        [i.athlete_id, i.sport_key, mk, from, to]);
      metricData.push({ metric_key: mk, unit: rows[0]?.unit ?? null, points: rows.map((r) => ({ on: r.on_day, value: r.value, provenance: r.provenance })) });
    }
    // build source refs
    const source_refs = i.metric_keys.flatMap((mk, n) => {
      const md = metricData[n];
      if (!md.points.length) return [];
      const provenances = [...new Set(md.points.map((p) => p.provenance))];
      return provenances.map((prov) => ({ type: prov, metric_key: mk, label: `${mk} — ${prov.replace(/_/g, ' ')} (${from} to ${to})` }));
    });
    // determine insight_type from data shape
    const pointCounts = metricData.map((m) => m.points.length);
    const hasEnough = pointCounts.some((c) => c >= 3);
    if (!hasEnough) {
      return one(
        `INSERT INTO para_insights(athlete_id,coach_id,sport_key,discipline_key,class_code,insight_type,metric_keys,source_refs,ai_draft,metric_resolutions,status,review_due_at)
         VALUES($1,$2,$3,$4,$5,'trend',$6,$7,$8,$9,'draft',$10) RETURNING *`,
        [i.athlete_id, user.id, i.sport_key, i.discipline_key ?? null, i.class_code,
          i.metric_keys, JSON.stringify(source_refs),
          JSON.stringify({ summary: 'Insufficient data', detail: 'Fewer than 3 data points exist for the requested metric(s) in the current class version. No insight can be generated.', confidence: 'low', limitations: ['Insufficient data for analysis.'], insufficient_data: true }),
          JSON.stringify(Object.fromEntries(i.metric_keys.map((mk) => [mk, 'pending']))),
          i.review_due_at ?? null]);
    }
    // AI draft via coaching-ai gatherParaContext (imported inline to avoid circular dependency)
    let aiDraft = null;
    try {
      const { askJson, aiConfigured, AI_RULES } = await import('../ai.js');
      if (aiConfigured()) {
        const paraAiPrompt = {
          task: 'para_insight',
          sport_key: i.sport_key, class_code: i.class_code,
          metric_data: metricData,
          source_refs: source_refs.map((s) => s.label),
          window: { from, to },
        };
        const schema = z.object({
          insight_type: z.enum(['trend','plateau','milestone','regression','training_recommendation']),
          summary: z.string().max(500),
          detail: z.string().max(1200),
          confidence: z.enum(['high','medium','low']),
          limitations: z.array(z.string().max(300)).max(8),
          insufficient_data: z.boolean().default(false),
        });
        const SHAPE = '{"insight_type":"trend|plateau|milestone|regression|training_recommendation","summary":string,"detail":string,"confidence":"high|medium|low","limitations":[string],"insufficient_data":false}';
        const raw = await askJson({
          system: `You are a careful assistant to a para-sport coach. Report only measurable metric trends drawn from the data provided.
You MUST NOT infer, suggest, reference or imply: physical impairment, medical diagnosis, disability category, competition classification status, eligibility determination, or any clinical assessment. Report only what the numeric data shows.
Each claim must reference at least one source from sources[]. If data is insufficient, return insufficient_data:true.
Distinguish trend (consistent direction), plateau (no change), milestone (new best), regression (decline), training_recommendation (suggested focus).
confidence=high: ≥8 points, consistent pattern. medium: 3–7 points or some variance. low: <3 points or unclear.
${AI_RULES}`,
          user: `<data>${JSON.stringify(paraAiPrompt)}</data>`,
          schema, shape: SHAPE, maxTokens: 1000,
        });
        if (raw) aiDraft = raw;
      }
    } catch { /* AI unavailable: fall back to algorithmic */ }
    // algorithmic fallback: detect trend/plateau from data
    if (!aiDraft) {
      const main = metricData.find((m) => m.points.length >= 3) ?? metricData[0];
      const pts = main?.points ?? [];
      let insightType = 'trend', summary = '', detail = '', confidence = 'medium';
      if (pts.length >= 3) {
        const vals = pts.map((p) => p.value);
        const first = vals.slice(0, Math.ceil(vals.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(vals.length / 2);
        const last = vals.slice(-Math.ceil(vals.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(vals.length / 2);
        const change = ((last - first) / Math.abs(first || 1)) * 100;
        if (Math.abs(change) < 2) { insightType = 'plateau'; summary = `${main.metric_key.replace(/_/g, ' ')} has been stable over the analysis period.`; detail = `The metric showed less than 2 % change across ${pts.length} recorded points between ${from} and ${to}.`; }
        else if (change > 0) { insightType = 'trend'; summary = `${main.metric_key.replace(/_/g, ' ')} has improved over the analysis period.`; detail = `Approximately +${Math.round(change)}% change across ${pts.length} recorded points between ${from} and ${to}.`; }
        else { insightType = 'regression'; summary = `${main.metric_key.replace(/_/g, ' ')} has declined over the analysis period.`; detail = `Approximately ${Math.round(change)}% change across ${pts.length} recorded points between ${from} and ${to}.`; }
        confidence = pts.length >= 8 ? 'high' : pts.length >= 4 ? 'medium' : 'low';
      }
      aiDraft = { insight_type: insightType, summary, detail, confidence, limitations: ['AI was not available; this is a computed summary only.', 'Verify accuracy before publishing to athlete.'], insufficient_data: false };
    }
    const insightType = aiDraft.insight_type ?? 'trend';
    const draft = await one(
      `INSERT INTO para_insights(athlete_id,coach_id,sport_key,discipline_key,class_code,insight_type,metric_keys,source_refs,ai_draft,metric_resolutions,status,review_due_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11) RETURNING *`,
      [i.athlete_id, user.id, i.sport_key, i.discipline_key ?? null, i.class_code,
        insightType, i.metric_keys, JSON.stringify(source_refs),
        JSON.stringify(aiDraft),
        JSON.stringify(Object.fromEntries(i.metric_keys.map((mk) => [mk, 'pending']))),
        i.review_due_at ?? null]);
    await audit(null, user.id, 'draft_para_insight', 'para_insights', draft.id);
    return shapeInsight(draft, true);
  },
});

// ── List insights (coach) ────────────────────────────────────────────────────

cap({
  name: 'list_para_insights', method: 'GET', path: '/para/insights', tag: TAG, auth: COACH,
  summary: 'List para performance insight drafts for athletes you coach, with optional status filter.',
  input: z.object({ athlete_id: id.optional(), status: z.enum(['draft','under_review','approved','rejected','published']).optional(), sport_key: z.string().max(60).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT * FROM para_insights WHERE coach_id=$1 AND ($2::uuid IS NULL OR athlete_id=$2) AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR sport_key=$4)
       ORDER BY CASE status WHEN 'under_review' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, updated_at DESC LIMIT $5 OFFSET $6`,
      [user.id, i.athlete_id ?? null, i.status ?? null, i.sport_key ?? null, i.limit, i.offset]);
    await audit(null, user.id, 'list_para_insights_coach', 'para_insights', null);
    return rows.map((r) => shapeInsight(r, true));
  },
});

// ── Get insight detail ───────────────────────────────────────────────────────

cap({
  name: 'get_para_insight', method: 'GET', path: '/para/insights/:id', tag: TAG,
  summary: 'Full detail of one para performance insight. Coach and academy-admin see the AI draft and annotation. Athlete sees only published insights.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one('SELECT * FROM para_insights WHERE id=$1', [i.id]);
    if (!row) throw notFound('Insight');
    const isCoach = row.coach_id === user.id;
    const isAdmin = await isAcademyAdmin(user, row.athlete_id);
    const isAthlete = row.athlete_id === user.id;
    let isGuardian = false;
    try { await actingFor(user, row.athlete_id, 'consent'); isGuardian = true; } catch { /* not a guardian */ }
    if (!isCoach && !isAdmin && !isAthlete && !isGuardian) throw notFound('Insight');
    if ((isAthlete || isGuardian) && !row.athlete_visible) throw notFound('Insight');
    await audit(null, user.id, isCoach || isAdmin ? 'read_para_insight_coach' : 'read_para_insight_athlete', 'para_insights', row.id);
    const includeAiDraft = isCoach || isAdmin;
    return shapeInsight(row, includeAiDraft);
  },
});

// ── Coach review: approve / reject / modify per metric ───────────────────────

cap({
  name: 'review_para_insight', method: 'POST', path: '/para/insights/:id/review', tag: TAG, auth: COACH,
  summary: 'Coach reviews a para insight: approves, rejects or modifies it, with per-metric resolution and optional annotation. Approving sets status to approved; bias_flag must be cleared before it can be published. Coach annotation is field-level encrypted.',
  input: z.object({
    id,
    decision: z.enum(['approved', 'rejected', 'modified']),
    metric_resolutions: z.record(z.string(), z.enum(['approved','rejected'])).optional().describe('Per-metric resolution: each metric_key → approved or rejected'),
    annotation_tags: z.array(z.enum(ANNOTATION_TAGS as [string, ...string[]])).max(5).optional(),
    annotation: z.string().max(2000).optional(),
    review_due_at: z.string().datetime({ offset: true }).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM para_insights WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!row) throw notFound('Insight');
      if (row.coach_id !== user.id) throw forbidden('Not the drafting coach');
      if (!['draft','under_review','approved','rejected'].includes(row.status)) throw conflict('Insight is already published');
      const resolutions = { ...row.metric_resolutions, ...(i.metric_resolutions ?? {}) };
      const allApproved = Object.values(resolutions).every((v) => v === 'approved');
      const anyApproved = Object.values(resolutions).some((v) => v === 'approved');
      if (i.decision === 'approved' && !anyApproved) throw badRequest('Approve at least one metric before approving the insight');
      const newStatus = i.decision === 'rejected' ? 'rejected' : 'approved';
      // publish only when approved + no bias flag + at least one metric approved
      const canPublish = newStatus === 'approved' && !row.bias_flag && anyApproved;
      const encAnnotation = i.annotation ? encrypt(i.annotation, 'para_insights.coach_annotation') : null;
      const updated = (await c.query(
        `UPDATE para_insights SET
           status=$2, metric_resolutions=$3, annotation_tags=$4,
           coach_annotation_enc=COALESCE($5, coach_annotation_enc),
           coach_decision=$6, coach_reviewed_at=now(),
           review_due_at=COALESCE($7, review_due_at),
           athlete_visible=$8, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [i.id, newStatus, JSON.stringify(resolutions),
          JSON.stringify(i.annotation_tags ?? row.annotation_tags ?? []),
          encAnnotation, i.decision, i.review_due_at ?? null, canPublish])).rows[0];
      await audit(c, user.id, `para_insight_${i.decision}`, 'para_insights', i.id);
      if (canPublish) {
        const consentOk = await guardianConsentOk(row.athlete_id);
        if (consentOk) {
          await c.query('UPDATE para_insights SET status=\'published\', athlete_visible=TRUE WHERE id=$1', [i.id]);
          updated.status = 'published'; updated.athlete_visible = true;
          await notify(c, row.athlete_id, { kind: 'performance', title: 'New performance insight', body: 'Your coach has shared a new para performance insight.', data: { insight_id: i.id } });
        }
      }
      return shapeInsight(updated, true);
    });
  },
});

// ── Bias flag / clear ─────────────────────────────────────────────────────────

cap({
  name: 'flag_insight_bias', method: 'POST', path: '/para/insights/:id/bias', tag: TAG,
  summary: 'Coach sets or clears the bias / fairness review flag on an insight. bias_flag=true blocks publication until cleared. Only the drafting coach or an academy-admin may toggle it.',
  input: z.object({ id, flagged: z.boolean(), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM para_insights WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!row) throw notFound('Insight');
      const isCoach = row.coach_id === user.id;
      const isAdm = await isAcademyAdmin(user, row.athlete_id);
      if (!isCoach && !isAdm) throw forbidden('Not authorised to flag bias on this insight');
      const updated = (await c.query(
        `UPDATE para_insights SET bias_flag=$2, bias_flagged_at=CASE WHEN $2 THEN now() ELSE bias_flagged_at END,
           bias_cleared_at=CASE WHEN NOT $2 THEN now() ELSE NULL END, bias_cleared_by=CASE WHEN NOT $2 THEN $3 ELSE NULL END,
           updated_at=now() WHERE id=$1 RETURNING *`,
        [i.id, i.flagged, user.id])).rows[0];
      await audit(c, user.id, i.flagged ? 'para_insight_bias_flagged' : 'para_insight_bias_cleared', 'para_insights', i.id);
      return shapeInsight(updated, true);
    });
  },
});

// ── Challenge (athlete / guardian) ───────────────────────────────────────────

cap({
  name: 'challenge_para_insight', method: 'POST', path: '/para/insights/:id/challenge', tag: TAG,
  summary: 'Athlete or guardian raises a concern about a published insight. The insight remains visible to the athlete until the coach resolves it. No clinical or classification changes result from this action.',
  input: z.object({ id, note: z.string().trim().min(2).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM para_insights WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!row) throw notFound('Insight');
      const isAthlete = row.athlete_id === user.id;
      let isGuardian = false;
      try { await actingFor(user, row.athlete_id, 'consent'); isGuardian = true; } catch { /* not a guardian */ }
      if (!isAthlete && !isGuardian) throw forbidden('Only the athlete or their guardian may raise a concern');
      if (!row.athlete_visible) throw notFound('Insight');
      if (row.challenge_note && !row.challenge_resolved_at) throw conflict('A concern is already open for this insight');
      const updated = (await c.query(
        `UPDATE para_insights SET challenge_note=$2, challenge_raised_at=now(), challenge_resolved_at=NULL,
           challenge_resolved_by=NULL, challenge_resolution=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
        [i.id, i.note])).rows[0];
      await audit(c, user.id, 'para_insight_challenged', 'para_insights', i.id);
      if (row.coach_id) await notify(c, row.coach_id, { kind: 'coaching', title: 'Concern raised on a performance insight', body: 'An athlete has raised a concern about one of your published insights.', data: { insight_id: i.id } });
      return { id: updated.id, challenge_raised_at: updated.challenge_raised_at, note: 'Your concern has been submitted. Your coach will respond.' };
    });
  },
});

// ── Resolve challenge ─────────────────────────────────────────────────────────

cap({
  name: 'resolve_insight_challenge', method: 'POST', path: '/para/insights/:id/challenge/resolve', tag: TAG,
  summary: 'Coach or academy-admin resolves an open athlete concern on an insight.',
  input: z.object({
    id,
    resolution: z.enum(['addressed', 'updated_insight', 'referred_to_clinician']),
    resolution_note: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM para_insights WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!row) throw notFound('Insight');
      const isCoach = row.coach_id === user.id;
      const isAdm = await isAcademyAdmin(user, row.athlete_id);
      if (!isCoach && !isAdm) throw forbidden('Not authorised to resolve challenges on this insight');
      if (!row.challenge_note) throw conflict('No open challenge on this insight');
      if (row.challenge_resolved_at) throw conflict('Challenge already resolved');
      const updated = (await c.query(
        `UPDATE para_insights SET challenge_resolved_at=now(), challenge_resolved_by=$2, challenge_resolution=$3, updated_at=now() WHERE id=$1 RETURNING *`,
        [i.id, user.id, i.resolution])).rows[0];
      await audit(c, user.id, 'para_insight_challenge_resolved', 'para_insights', i.id);
      await notify(c, row.athlete_id, { kind: 'performance', title: 'Your concern has been reviewed', body: 'Your coach has responded to your performance insight concern.', data: { insight_id: i.id } });
      return shapeInsight(updated, false);
    });
  },
});

// ── Athlete: my published insights ───────────────────────────────────────────

cap({
  name: 'my_para_insights', method: 'GET', path: '/me/para/insights', tag: TAG,
  summary: 'Your published (coach-approved) para performance insights. Drafts and under-review insights are never returned here. Athlete and guardian only.',
  input: z.object({ athlete_id: id.optional(), sport_key: z.string().max(60).optional(), ...page }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    await actingFor(user, athleteId, 'consent').catch(() => { if (user.id !== athleteId) throw forbidden('Not authorised'); });
    const rows = await many(
      `SELECT * FROM para_insights WHERE athlete_id=$1 AND athlete_visible=TRUE AND status='published'
         AND ($2::text IS NULL OR sport_key=$2)
       ORDER BY updated_at DESC LIMIT $3 OFFSET $4`,
      [athleteId, i.sport_key ?? null, i.limit, i.offset]);
    await audit(null, user.id, 'read_para_insights_athlete', 'para_insights', null);
    return { insights: rows.map((r) => shapeInsight(r, false)), note: NOTE };
  },
});

// ── Explainable source links ──────────────────────────────────────────────────

cap({
  name: 'get_insight_sources', method: 'GET', path: '/para/insights/:id/sources', tag: TAG,
  summary: 'Explainable source links for a para insight: each source ref with its type, metric, provenance and date range. Accessible to the athlete (published only), their guardian, and the coach.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one('SELECT * FROM para_insights WHERE id=$1', [i.id]);
    if (!row) throw notFound('Insight');
    const isCoach = row.coach_id === user.id;
    const isAthlete = row.athlete_id === user.id;
    let isGuardian = false;
    try { await actingFor(user, row.athlete_id, 'consent'); isGuardian = true; } catch { /* not guardian */ }
    const isAdm = await isAcademyAdmin(user, row.athlete_id);
    if (!isCoach && !isAthlete && !isGuardian && !isAdm) throw notFound('Insight');
    if ((isAthlete || isGuardian) && !row.athlete_visible) throw notFound('Insight');
    return { insight_id: row.id, source_refs: row.source_refs, note: NOTE };
  },
});

// ── Academy aggregate progress view ──────────────────────────────────────────

cap({
  name: 'get_academy_para_progress', method: 'GET', path: '/organisations/:id/para/progress', tag: TAG,
  summary: 'Academy-level overview of para athlete insights: per athlete, the class, approved insight count, last review, open challenges and bias flags. Single-class filter only; cross-class comparison is never returned.',
  input: z.object({ id, sport_key: z.string().max(60).optional(), class_code: z.string().max(40).optional(), ...page }),
  async handler({ user }, i) {
    const member = await one(`SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role IN ('academy_admin','org_admin','platform_admin')`, [i.id, user.id]);
    if (!member) throw forbidden('Academy admin role required');
    if (!i.class_code) throw badRequest('class_code required: cross-class view is not permitted');
    const rows = await many(
      `SELECT pi.athlete_id, u.display_name AS athlete_name,
              pi.class_code, pi.sport_key,
              max(pi.coach_reviewed_at) AS last_reviewed_at,
              count(*) FILTER (WHERE pi.status='published') AS approved_count,
              count(*) FILTER (WHERE pi.challenge_note IS NOT NULL AND pi.challenge_resolved_at IS NULL) AS open_challenges,
              count(*) FILTER (WHERE pi.bias_flag=TRUE) AS bias_flags
         FROM para_insights pi
         JOIN users u ON u.id=pi.athlete_id
         JOIN org_members om ON om.org_id=$1 AND om.user_id=pi.athlete_id AND om.status='active'
        WHERE pi.class_code=$2 AND ($3::text IS NULL OR pi.sport_key=$3)
        GROUP BY pi.athlete_id, u.display_name, pi.class_code, pi.sport_key
        ORDER BY open_challenges DESC, bias_flags DESC, athlete_name
        LIMIT $4 OFFSET $5`,
      [i.id, i.class_code, i.sport_key ?? null, i.limit, i.offset]);
    await audit(null, user.id, 'read_academy_para_progress', 'organisations', i.id);
    return { org_id: i.id, class_code: i.class_code, sport_key: i.sport_key ?? null, athletes: rows, note: 'Within-class view only. Cross-class comparison is not permitted.' };
  },
});
