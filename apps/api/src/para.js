// Para-sport Classification & Eligibility (#488): shared rules for the para-* capabilities and for the eligibility engine.
// An administrative sporting classification, never a diagnosis. The competition-facing outcome (para_outcomes) is separate from the sensitive
// workflow (cases, panel, evidence, appeals). AI never infers or assigns a class: every decision here is a person acting inside a credential.
import { notFound, conflict } from './errors.js';
import { isYouth, guardianLink } from './youth.js';

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); const day = d.getUTCDate(); d.setUTCMonth(d.getUTCMonth() + n); if (d.getUTCDate() !== day) d.setUTCDate(0); return d.toISOString().slice(0, 10); };

export const STATUSES = ['confirmed', 'review_required', 'temporary', 'not_eligible', 'other'];
export const STAGES = ['submitted', 'evidence_review', 'assessment_scheduled', 'assessment_completed', 'panel_review', 'decision_issued', 'incomplete', 'withdrawn', 'closed'];
export const OPEN_STAGES = STAGES.slice(0, 5);
/** The configurable stage flow. Panel review may send the case back for a further assessment. Nothing invents a universal process: the version's panel size decides who must agree. */
export const FLOW = {
  submitted: ['evidence_review', 'incomplete', 'withdrawn'],
  evidence_review: ['assessment_scheduled', 'incomplete', 'withdrawn'],
  assessment_scheduled: ['assessment_completed', 'incomplete', 'withdrawn'],
  assessment_completed: ['panel_review', 'incomplete', 'withdrawn'],
  panel_review: ['assessment_scheduled', 'incomplete', 'withdrawn'], // `decision_issued` only through issue_para_outcome
  decision_issued: ['closed'], incomplete: ['closed'], withdrawn: ['closed'], closed: [],
};

/** Append one step to the immutable history (never carries evidence or medical text). */
export const hist = (c, type, id, athleteId, action, { from = null, to = null, actor = null, detail = {} } = {}) =>
  c.query('INSERT INTO para_history(subject_type, subject_id, athlete_id, action, from_status, to_status, actor_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [type, id, athleteId, action, from, to, actor, detail]);

/**
 * The caller's live classifier credential for this scope, or null. Read on every call, never cached: expiry, suspension and scope are checked against the
 * row itself. Clinical roles, coaching roles, refereeing or admin never substitute for it. `lock` takes a row lock inside the deciding transaction.
 */
export async function liveClassifier(c, userId, { sportId, discipline = '', classCode = null, lock = false }) {
  const r = await c.query(
    `SELECT * FROM para_classifiers WHERE user_id=$1 AND sport_id=$2 AND status='active' AND issued_on <= current_date AND expires_on >= current_date
        AND (discipline='' OR discipline=$3) AND ($4::text IS NULL OR cardinality(class_codes)=0 OR $4 = ANY(class_codes))
        AND EXISTS (SELECT 1 FROM governing_body_sports s WHERE s.body_id=para_classifiers.body_id AND s.sport_id=$2 AND s.ended_on IS NULL)
      ORDER BY expires_on DESC LIMIT 1 ${lock ? 'FOR SHARE' : ''}`, [userId, sportId, discipline, classCode]);
  return r.rows[0] ?? null;
}

/**
 * Who the caller is to a case: the athlete (an adult), a verified guardian of a young athlete, or an assigned panel classifier with a live credential.
 * Everyone else gets a 404 (existence is never leaked). Platform admins and ordinary administrators are NOT parties: they cannot read the sensitive workflow.
 */
export async function caseParty(c, user, row) {
  if (!row) throw notFound('Classification case');
  if (row.athlete_id === user.id && !(await isYouth(row.athlete_id, c))) return { kind: 'athlete', athleteView: true };
  if (row.athlete_id !== user.id && (await guardianLink(user.id, row.athlete_id, c))) return { kind: 'guardian', athleteView: true };
  const p = (await c.query(
    `SELECT p.*, k.id AS cid FROM para_case_panel p JOIN para_classifiers k ON k.id=p.classifier_id
      WHERE p.case_id=$1 AND k.user_id=$2`, [row.id, user.id])).rows[0];
  if (p) {
    const live = await liveClassifier(c, user.id, { sportId: row.sport_id, discipline: row.discipline });
    if (live) return { kind: 'panel', panel: p, classifier: live, athleteView: false };
  }
  throw notFound('Classification case');
}

/**
 * The classification in force for an athlete in a sport on an instant, read live from the governed outcome and never copied.
 * Reproducible: an outcome counts if it had been issued and not yet superseded at `at`, so a later decision does not rewrite a past match.
 */
export async function outcomeAt(c, athleteId, sportId, at = new Date(), discipline = null) {
  const day = (at instanceof Date ? at : new Date(at)).toISOString().slice(0, 10);
  const r = await c.query(
    `SELECT o.id, o.class_code, o.status, o.effective_from::text AS effective_from, o.review_by::text AS review_by, o.expires_on::text AS expires_on, o.decision_ref,
            o.version_id, v.version, o.discipline, b.id AS authority_id, org.name AS authority
       FROM para_outcomes o JOIN para_class_versions v ON v.id=o.version_id JOIN governing_bodies b ON b.id=o.authority_id JOIN organisations org ON org.id=b.organisation_id
      WHERE o.athlete_id=$1 AND o.sport_id=$2 AND ($5::text IS NULL OR o.discipline=$5)
        AND o.effective_from <= $3::date AND o.created_at <= $4 AND (o.superseded_at IS NULL OR o.superseded_at > $4) AND (o.expires_on IS NULL OR o.expires_on >= $3::date)
      ORDER BY o.created_at DESC LIMIT 1`, [athleteId, sportId, day, at, discipline]);
  return r.rows[0] ?? null;
}
/** A verified external reference (second-officer confirmed) usable only where a competition explicitly allows an audited external classification. */
export async function verifiedExternalAt(c, athleteId, sportId, at = new Date()) {
  const day = (at instanceof Date ? at : new Date(at)).toISOString().slice(0, 10);
  const r = await c.query(
    `SELECT x.id, x.class_code, x.class_status AS status, x.effective_from::text AS effective_from, x.review_by::text AS review_by, org.name AS authority
       FROM para_external_refs x JOIN governing_bodies b ON b.id=x.source_body_id JOIN organisations org ON org.id=b.organisation_id
      WHERE x.athlete_id=$1 AND x.sport_id=$2 AND x.status='verified' AND x.effective_from <= $3::date AND (x.review_by IS NULL OR x.review_by >= $3::date)
      ORDER BY x.effective_from DESC, x.created_at DESC LIMIT 1`, [athleteId, sportId, day]);
  return r.rows[0] ?? null;
}

/** Competition-facing projection: exactly the fields policy permits. No case, panel, evidence, appeal grounds or classifier identity. */
export const publicOutcome = (o) => o && ({ id: o.id, class_code: o.class_code, status: o.status, effective_from: o.effective_from, review_by: o.review_by ?? null, expires_on: o.expires_on ?? null,
  authority: o.authority, decision_ref: o.decision_ref, version: o.version ?? null });

/** The deciding transaction must still see the class in a published, in-force version. */
export async function classIn(c, versionId, code) {
  const v = (await c.query('SELECT * FROM para_class_versions WHERE id=$1', [versionId])).rows[0];
  if (!v || v.status !== 'published') throw conflict('That classification version is not published');
  if (!code) return { v, cls: null };
  const cls = (await c.query('SELECT * FROM para_classes WHERE version_id=$1 AND code=$2', [versionId, code])).rows[0];
  if (!cls) throw conflict(`Class ${code} is not part of this version`);
  return { v, cls };
}
