// Para-sport Classification (#488) 3/3: the competition-facing outcome, review/protest/appeal, and external-authority references.
// An outcome carries only what a competition may see (class, status, dates, authority, decision reference, version). A new decision supersedes the live one
// prospectively; earlier rows are never edited, so a past match can be reproduced from what was in force then. External references are never name-matched
// and never authoritative until a second officer verifies them (the signed exchange itself is #483 and is not simulated here).
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt, blindIndex } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { authority, need, canSome, mustBeActive } from '../federation.js';
import { actingFor, guardiansOf, guardianLink } from '../youth.js';
import { STATUSES, hist, liveClassifier, caseParty, classIn, outcomeAt, publicOutcome, today, addDays, addMonths } from '../para.js';

const TAG = 'Para classification';
const t = (n) => z.string().trim().max(n);
const day = z.string().date();
const ref = () => `PC-${new Date().getUTCFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;

/** Write the new live outcome inside the caller's transaction, superseding the previous one prospectively. */
async function writeOutcome(c, { athleteId, sportId, discipline, version, classCode, status, effectiveFrom, authorityId, issuedBy, caseId = null, appealId = null, reviewBy = null, expiresOn = null }) {
  const prev = (await c.query('SELECT id FROM para_outcomes WHERE athlete_id=$1 AND sport_id=$2 AND discipline=$3 AND superseded_at IS NULL FOR UPDATE', [athleteId, sportId, discipline])).rows[0];
  if (prev) await c.query('UPDATE para_outcomes SET superseded_at=now() WHERE id=$1', [prev.id]);
  let rv = reviewBy, ex = expiresOn;
  if (version.review_rule === 'fixed_term' && !ex) ex = addMonths(effectiveFrom, version.review_months);
  if (version.review_rule === 'review_required' && !rv) rv = addMonths(effectiveFrom, version.review_months);
  if (status === 'review_required' && !rv) rv = addMonths(effectiveFrom, version.review_months ?? 12);
  const o = (await c.query(
    `INSERT INTO para_outcomes(athlete_id, sport_id, discipline, version_id, case_id, appeal_id, class_code, status, effective_from, review_by, expires_on, authority_id, decision_ref, supersedes_id, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, decision_ref`,
    [athleteId, sportId, discipline, version.id, caseId, appealId, classCode, status, effectiveFrom, rv, ex, authorityId, ref(), prev?.id ?? null, issuedBy])).rows[0];
  await hist(c, 'outcome', o.id, athleteId, prev ? 'superseded_previous' : 'issued', { to: status, actor: issuedBy, detail: { class_code: classCode, supersedes: prev?.id ?? null } });
  return { ...o, review_by: rv, expires_on: ex, supersedes_id: prev?.id ?? null };
}
const tellAthlete = async (c, athleteId, title, body, data) => { for (const u of new Set([athleteId, ...(await guardiansOf(athleteId, c))])) await notify(c, u, { kind: 'para_outcome', title, body, data }); };

cap({
  name: 'issue_para_outcome', method: 'POST', path: '/para/cases/:id/outcome', tag: TAG, scope: 'clinical', status: 201,
  summary: 'Issue the classification decision. Only the case\'s lead classifier, with a live credential covering the class, and only when the governing version\'s required number of independent panel decisions agree. Supersedes the live outcome prospectively; earlier outcomes and the matches that used them stay reproducible.',
  input: z.object({ id, effective_from: day.optional(), review_by: day.optional(), expires_on: day.optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const row = (await c.query('SELECT * FROM para_cases WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    const party = await caseParty(c, user, row);
    if (party.kind !== 'panel' || party.panel.role !== 'lead') throw forbidden('Only the lead classifier issues the decision');
    if (row.status !== 'panel_review') throw conflict('The case must be in panel review');
    const { v } = await classIn(c, row.version_id, null);
    const votes = (await c.query("SELECT p.decision_class_code, p.decision_status, k.id AS kid FROM para_case_panel p JOIN para_classifiers k ON k.id=p.classifier_id WHERE p.case_id=$1 AND p.role <> 'observer' AND p.decided_at IS NOT NULL", [row.id])).rows;
    if (votes.length < v.panel_size) throw conflict(`This classification needs ${v.panel_size} independent decision(s); ${votes.length} recorded`);
    const key = (x) => `${x.decision_class_code ?? ''}|${x.decision_status}`;
    if (new Set(votes.map(key)).size !== 1) throw conflict('The panel\'s decisions do not agree; the panel must reconcile before a decision is issued', { code: 'panel_disagreement' });
    const final = votes[0];
    const k = await liveClassifier(c, user.id, { sportId: row.sport_id, discipline: row.discipline, classCode: final.decision_class_code, lock: true });
    if (!k) throw forbidden('Your classifier credential is not live for this class');
    if (final.decision_class_code) await classIn(c, row.version_id, final.decision_class_code);
    const eff = i.effective_from ?? today();
    const o = await writeOutcome(c, { athleteId: row.athlete_id, sportId: row.sport_id, discipline: row.discipline, version: v, classCode: final.decision_class_code, status: final.decision_status, effectiveFrom: eff, authorityId: row.body_id, issuedBy: user.id, caseId: row.id, reviewBy: i.review_by ?? null, expiresOn: i.expires_on ?? null });
    await c.query("UPDATE para_cases SET status='decision_issued', outcome_id=$2, closed_at=now(), updated_at=now() WHERE id=$1", [row.id, o.id]);
    await hist(c, 'case', row.id, row.athlete_id, 'decision_issued', { from: 'panel_review', to: 'decision_issued', actor: user.id });
    await audit(c, user.id, 'write_clinical', 'para_outcomes', o.id);
    await tellAthlete(c, row.athlete_id, 'Classification decision issued', `Your classification decision (${o.decision_ref}) was issued. You can ask for a review if you disagree.`, { outcome_id: o.id });
    return { id: o.id, decision_ref: o.decision_ref, class_code: final.decision_class_code, status: final.decision_status, review_by: o.review_by, expires_on: o.expires_on, supersedes_id: o.supersedes_id };
  }),
});

cap({
  name: 'get_para_classification', method: 'GET', path: '/para/classification', tag: TAG, scope: 'clinical',
  summary: 'The competition-facing classification of an athlete in a sport on a date: class, status, effective and review dates, issuing authority, decision reference and version. Never any case, panel, evidence or grounds. Visible to the athlete, a verified guardian and the issuing authority\'s staff.',
  input: z.object({ athlete_id: id, sport_id: id, discipline: t(60).optional(), on: day.optional() }),
  handler: async ({ user }, i) => {
    const at = i.on ? new Date(`${i.on}T12:00:00Z`) : new Date();
    const o = await outcomeAt(pool, i.athlete_id, i.sport_id, at, i.discipline ?? null);
    const self = i.athlete_id === user.id || !!(await guardianLink(user.id, i.athlete_id));
    if (!self) {
      const auth = o ? await authority(user, o.authority_id, { optional: true }) : null;
      if (!auth || !canSome(auth, 'governance')) throw notFound('Classification');
    }
    if (!o) return { classification: null, note: 'No classification on record. A competition class is an administrative sporting classification, not a medical diagnosis.' };
    return { classification: publicOutcome(o), note: 'A competition class is an administrative sporting classification, not a medical diagnosis.' };
  },
});

cap({
  name: 'list_para_outcomes', method: 'GET', path: '/para/outcomes', tag: TAG, scope: 'clinical',
  summary: 'The full, immutable history of an athlete\'s classification outcomes (every superseded decision with its version and dates), for the athlete/guardian or the issuing authority\'s staff.',
  input: z.object({ athlete_id: id, sport_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const self = i.athlete_id === user.id || !!(await guardianLink(user.id, i.athlete_id));
    const rows = await many(
      `SELECT o.id, s.name AS sport, o.sport_id, o.discipline, o.class_code, o.status, o.effective_from::text AS effective_from, o.review_by::text AS review_by, o.expires_on::text AS expires_on, o.decision_ref, v.version,
              org.name AS authority, o.authority_id, o.supersedes_id, o.superseded_at, o.created_at, (o.appeal_id IS NOT NULL) AS from_appeal
         FROM para_outcomes o JOIN sports s ON s.id=o.sport_id JOIN para_class_versions v ON v.id=o.version_id JOIN governing_bodies b ON b.id=o.authority_id JOIN organisations org ON org.id=b.organisation_id
        WHERE o.athlete_id=$1 AND ($2::uuid IS NULL OR o.sport_id=$2) ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`, [i.athlete_id, i.sport_id ?? null, i.limit, i.offset]);
    if (!self) {
      const ok = [];
      for (const r of rows) { const a = await authority(user, r.authority_id, { optional: true }); if (a && canSome(a, 'governance')) ok.push(r); }
      if (!ok.length) throw notFound('Classification');
      return { outcomes: ok.map(({ authority_id, ...r }) => r) };
    }
    return { outcomes: rows.map(({ authority_id, ...r }) => r) };
  },
});

// ------------------------------------------------------------------ review / protest / appeal
cap({
  name: 'lodge_para_appeal', method: 'POST', path: '/para/outcomes/:id/appeals', tag: TAG, scope: 'clinical', status: 201,
  summary: 'Ask for a review, protest or appeal of the live classification within the governing version\'s deadline. One open request per decision; grounds are encrypted; history is immutable. The existing outcome stays in force until a new decision supersedes it.',
  input: z.object({ id, kind: z.enum(['review', 'protest', 'appeal']), grounds: t(2000).min(10) }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT o.*, v.appeal_days FROM para_outcomes o JOIN para_class_versions v ON v.id=o.version_id WHERE o.id=$1 FOR UPDATE OF o', [i.id])).rows[0];
    if (!o) throw notFound('Classification outcome');
    await actingFor(user, o.athlete_id, 'consent');
    if (o.superseded_at) throw conflict('This decision has been superseded; ask about the current one');
    const deadline = addDays(o.created_at.toISOString().slice(0, 10), o.appeal_days);
    if (today() > deadline) throw conflict(`The deadline for asking for a review of this decision was ${deadline}`, { code: 'appeal_deadline_passed' });
    const a = (await c.query('INSERT INTO para_appeals(outcome_id, kind, grounds_enc, lodged_by, deadline_on) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, status, deadline_on::text AS deadline_on',
      [o.id, i.kind, encrypt(i.grounds, 'para_appeals.grounds'), user.id, deadline])).rows[0]; // a second open one hits the partial unique index -> 409
    await hist(c, 'appeal', a.id, o.athlete_id, 'lodged', { to: 'open', actor: user.id, detail: { kind: i.kind } });
    await audit(c, user.id, 'write_clinical', 'para_appeals', a.id);
    return a;
  }),
});

cap({
  name: 'list_para_appeals', method: 'GET', path: '/para/appeals', tag: TAG, scope: 'clinical',
  summary: 'Review/protest/appeal requests: a body\'s queue (deadline, kind, status; no grounds), the ones assigned to you as reviewer (with grounds), or your own.',
  input: z.object({ scope: z.enum(['mine', 'assigned', 'body']).default('mine'), body_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const base = `SELECT a.id, a.outcome_id, a.kind, a.status, a.deadline_on::text AS deadline_on, a.created_at, a.ruled_at, o.sport_id, s.name AS sport, o.class_code, o.decision_ref, o.athlete_id, u.display_name AS athlete,
                         (a.reviewer_id IS NOT NULL) AS reviewer_assigned, a.grounds_enc
                    FROM para_appeals a JOIN para_outcomes o ON o.id=a.outcome_id JOIN sports s ON s.id=o.sport_id JOIN users u ON u.id=o.athlete_id`;
    let rows, withGrounds = false;
    if (i.scope === 'mine') {
      rows = await many(`${base} WHERE (o.athlete_id=$1 OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$1 AND l.child_id=o.athlete_id AND l.status='active' AND l.revoked_at IS NULL)) ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
      withGrounds = true;
    } else if (i.scope === 'assigned') {
      rows = await many(`${base} JOIN para_classifiers k ON k.id=a.reviewer_id WHERE k.user_id=$1 ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
      withGrounds = true;
    } else {
      if (!i.body_id) throw badRequest('body_id is required for a body queue');
      const auth = await authority(user, i.body_id);
      if (!canSome(auth, 'governance')) throw notFound('Governing body');
      rows = await many(`${base} WHERE o.authority_id=$1 ORDER BY (a.status='open') DESC, a.created_at DESC LIMIT $2 OFFSET $3`, [i.body_id, i.limit, i.offset]);
    }
    if (withGrounds && rows.length) await audit(null, user.id, 'read_clinical', 'para_appeals', rows[0].id);
    return { appeals: rows.map(({ grounds_enc, ...r }) => ({ ...r, ...(withGrounds ? { grounds: decrypt(grounds_enc, 'para_appeals.grounds') } : {}) })) };
  },
});

cap({
  name: 'assign_para_appeal_reviewer', method: 'POST', path: '/para/appeals/:id/reviewer', tag: TAG, scope: 'clinical',
  summary: 'Assign an independent reviewer: a live-credentialed classifier who was not on the original case\'s panel.',
  input: z.object({ id, classifier_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT a.*, o.sport_id, o.discipline, o.authority_id, o.athlete_id, o.case_id FROM para_appeals a JOIN para_outcomes o ON o.id=a.outcome_id WHERE a.id=$1 FOR UPDATE OF a', [i.id])).rows[0];
    if (!a) throw notFound('Appeal');
    const auth = await authority(user, a.authority_id, { c, optional: true });
    if (!auth || !canSome(auth, 'governance')) throw notFound('Appeal');
    need(auth, 'governance', a.sport_id);
    if (a.status !== 'open') throw conflict(`This request is ${a.status}`);
    const k = (await c.query("SELECT * FROM para_classifiers WHERE id=$1 AND sport_id=$2 AND status='active' AND issued_on <= current_date AND expires_on >= current_date AND (discipline='' OR discipline=$3)", [i.classifier_id, a.sport_id, a.discipline])).rows[0];
    if (!k) throw badRequest('The reviewer needs a live classifier credential for this sport/discipline');
    if (k.user_id === a.athlete_id || (await guardiansOf(a.athlete_id, c)).includes(k.user_id)) throw conflict('The reviewer cannot be the athlete or their guardian');
    if (a.case_id && (await c.query('SELECT 1 FROM para_case_panel WHERE case_id=$1 AND classifier_id=$2', [a.case_id, k.id])).rowCount) throw conflict('The reviewer must be independent of the original panel');
    await c.query('UPDATE para_appeals SET reviewer_id=$2 WHERE id=$1', [a.id, k.id]);
    await hist(c, 'appeal', a.id, a.athlete_id, 'reviewer_assigned', { actor: user.id });
    await notify(c, k.user_id, { kind: 'para_appeal', title: 'Classification review assigned', body: 'You were assigned to review a classification decision.', data: { appeal_id: a.id } });
    return { id: a.id, reviewer_assigned: true };
  }),
});

cap({
  name: 'rule_para_appeal', method: 'POST', path: '/para/appeals/:id/rule', tag: TAG, scope: 'clinical',
  summary: 'The assigned independent reviewer rules. Dismissing changes nothing. Upholding needs the new class/status and issues a new outcome that supersedes the old one prospectively; prior outcomes and competition records are not rewritten.',
  input: z.object({ id, ruling: z.enum(['upheld', 'dismissed']), note: t(1000).min(2), class_code: t(20).optional(), status: z.enum(STATUSES).optional(), effective_from: day.optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT a.*, o.sport_id, o.discipline, o.authority_id, o.athlete_id, o.version_id FROM para_appeals a JOIN para_outcomes o ON o.id=a.outcome_id WHERE a.id=$1 FOR UPDATE OF a', [i.id])).rows[0];
    if (!a) throw notFound('Appeal');
    const k = a.reviewer_id ? (await c.query('SELECT * FROM para_classifiers WHERE id=$1', [a.reviewer_id])).rows[0] : null;
    if (!k || k.user_id !== user.id) throw notFound('Appeal');
    if (a.status !== 'open') throw conflict(`This request is ${a.status}`);
    const live = await liveClassifier(c, user.id, { sportId: a.sport_id, discipline: a.discipline, classCode: i.class_code?.toUpperCase() ?? null, lock: true });
    if (!live) throw forbidden('Your classifier credential is not live for this sport, discipline and class');
    let resulting = null;
    if (i.ruling === 'upheld') {
      if (!i.status || (!i.class_code && !['not_eligible', 'other'].includes(i.status))) throw badRequest('Upholding needs the new class and status');
      // a changed definition applies: the newest published version for this body/sport/discipline governs new decisions
      const ver = (await c.query("SELECT * FROM para_class_versions WHERE body_id=$1 AND sport_id=$2 AND discipline=$3 AND status='published' ORDER BY version DESC LIMIT 1", [a.authority_id, a.sport_id, a.discipline])).rows[0] ?? (await c.query('SELECT * FROM para_class_versions WHERE id=$1', [a.version_id])).rows[0];
      if (i.class_code) await classIn(c, ver.id, i.class_code.toUpperCase());
      resulting = await writeOutcome(c, { athleteId: a.athlete_id, sportId: a.sport_id, discipline: a.discipline, version: ver, classCode: i.class_code?.toUpperCase() ?? null, status: i.status, effectiveFrom: i.effective_from ?? today(), authorityId: a.authority_id, issuedBy: user.id, appealId: a.id });
    }
    await c.query('UPDATE para_appeals SET status=$2, ruling_enc=$3, ruled_by=$4, ruled_at=now(), resulting_outcome_id=$5 WHERE id=$1', [a.id, i.ruling, encrypt(i.note, 'para_appeals.ruling'), user.id, resulting?.id ?? null]);
    await hist(c, 'appeal', a.id, a.athlete_id, i.ruling, { from: 'open', to: i.ruling, actor: user.id });
    await audit(c, user.id, 'write_clinical', 'para_appeals', a.id);
    await tellAthlete(c, a.athlete_id, `Classification review ${i.ruling}`, i.ruling === 'upheld' ? `A new classification decision (${resulting.decision_ref}) was issued.` : 'The original classification decision stands.', { appeal_id: a.id });
    return { id: a.id, status: i.ruling, outcome_id: resulting?.id ?? null, decision_ref: resulting?.decision_ref ?? null };
  }),
});

cap({
  name: 'withdraw_para_appeal', method: 'POST', path: '/para/appeals/:id/withdraw', tag: TAG, scope: 'clinical',
  summary: 'The athlete or guardian withdraws their own open request. It stays on record.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT a.*, o.athlete_id FROM para_appeals a JOIN para_outcomes o ON o.id=a.outcome_id WHERE a.id=$1 FOR UPDATE OF a', [i.id])).rows[0];
    if (!a) throw notFound('Appeal');
    await actingFor(user, a.athlete_id, 'consent');
    if (a.status !== 'open') throw conflict(`This request is ${a.status}`);
    await c.query("UPDATE para_appeals SET status='withdrawn', ruled_at=now() WHERE id=$1", [a.id]);
    await hist(c, 'appeal', a.id, a.athlete_id, 'withdrawn', { from: 'open', to: 'withdrawn', actor: user.id });
    return { id: a.id, status: 'withdrawn' };
  }),
});

// ------------------------------------------------------------------ external authority references (reference-only; signed exchange is #483)
cap({
  name: 'record_para_external_ref', method: 'POST', path: '/para/external-refs', tag: TAG, scope: 'admin', status: 201,
  summary: 'Record a classification held by an external classification authority, keyed by the authority\'s stable ID and tied to the athlete by their canonical account (never by name). Stays unverified, and is not authoritative, until a second officer verifies it. A competition only consumes it when it explicitly allows external references.',
  input: z.object({ body_id: id.describe('the external authority (a governing body on the platform)'), athlete_id: id, sport_id: id, discipline: t(60).default(''), external_id: t(120).min(2), class_code: t(20).min(1),
    class_status: z.enum(STATUSES), effective_from: day, review_by: day.optional(), provenance: t(300).min(2).describe('where this record came from, e.g. the authority\'s register and date consulted') }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.body_id, { c });
    need(auth, 'governance', i.sport_id);
    mustBeActive(auth.body);
    if (!(await c.query("SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL", [i.body_id, i.sport_id])).rowCount) throw badRequest('That authority does not govern this sport');
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.athlete_id])).rowCount) throw notFound('Athlete');
    const idx = blindIndex(`${i.body_id}:${i.external_id}`);
    const prev = (await c.query('SELECT * FROM para_external_refs WHERE source_body_id=$1 AND external_id_idx=$2', [i.body_id, idx])).rows[0];
    if (prev) {
      if (prev.athlete_id !== i.athlete_id) throw conflict('That external ID is already linked to a different athlete; reconcile identities before recording it again', { code: 'identity_conflict' });
      return { id: prev.id, status: prev.status, replayed: true };
    }
    const r = (await c.query(
      `INSERT INTO para_external_refs(athlete_id, sport_id, discipline, source_body_id, external_id_idx, external_id_enc, class_code, class_status, effective_from, review_by, provenance, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, status`,
      [i.athlete_id, i.sport_id, i.discipline, i.body_id, idx, encrypt(i.external_id, 'para_external_refs.external_id'), i.class_code.toUpperCase(), i.class_status, i.effective_from, i.review_by ?? null, i.provenance, user.id])).rows[0];
    await hist(c, 'external_ref', r.id, i.athlete_id, 'recorded', { to: 'unverified', actor: user.id });
    await audit(c, user.id, 'write_pii', 'para_external_refs', r.id);
    return { ...r, replayed: false };
  }),
});

cap({
  name: 'verify_para_external_ref', method: 'POST', path: '/para/external-refs/:id/verify', tag: TAG, scope: 'admin',
  summary: 'A second officer of the authority verifies (or rejects) an external reference. The person who recorded it cannot verify it.',
  input: z.object({ id, decision: z.enum(['verified', 'rejected']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const x = (await c.query('SELECT * FROM para_external_refs WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!x) throw notFound('External reference');
    const auth = await authority(user, x.source_body_id, { c, optional: true });
    if (!auth || !canSome(auth, 'governance')) throw notFound('External reference');
    need(auth, 'governance', x.sport_id);
    if (x.recorded_by === user.id) throw conflict('A second officer verifies an external reference');
    if (x.status !== 'unverified') throw conflict(`This reference is already ${x.status}`);
    await c.query('UPDATE para_external_refs SET status=$2, verified_by=$3, verified_at=now() WHERE id=$1', [x.id, i.decision, user.id]);
    await hist(c, 'external_ref', x.id, x.athlete_id, i.decision, { from: 'unverified', to: i.decision, actor: user.id });
    return { id: x.id, status: i.decision };
  }),
});

cap({
  name: 'list_para_external_refs', method: 'GET', path: '/para/external-refs', tag: TAG, scope: 'admin',
  summary: 'The external classification references recorded against an authority, with verification state and provenance. The authority\'s own ID is never listed.',
  input: z.object({ body_id: id, status: z.enum(['unverified', 'verified', 'rejected']).optional(), ...page }),
  handler: async ({ user }, i) => {
    const auth = await authority(user, i.body_id);
    if (!canSome(auth, 'governance')) throw notFound('Governing body');
    return { references: await many(
      `SELECT x.id, x.athlete_id, u.display_name AS athlete, s.name AS sport, x.class_code, x.class_status, x.effective_from::text AS effective_from, x.review_by::text AS review_by, x.provenance, x.status, x.created_at
         FROM para_external_refs x JOIN users u ON u.id=x.athlete_id JOIN sports s ON s.id=x.sport_id WHERE x.source_body_id=$1 AND ($2::text IS NULL OR x.status=$2) ORDER BY x.created_at DESC LIMIT $3 OFFSET $4`,
      [i.body_id, i.status ?? null, i.limit, i.offset]) };
  },
});
