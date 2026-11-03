// Para-sport Classification (#488) 2/3: the classification case (administrative workflow), the assessment panel and the sensitive evidence.
// Evidence and the requester's notes are readable only by the athlete (or a verified guardian of a young athlete) and by classifiers assigned to the case with a
// live credential in scope. Body staff run the queue and the stages but cannot read them; coaches, organisers, sponsors, media and administrators see nothing.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { B64_MAX_CHARS, documentMaxBytes } from '../platform-settings.js';
import { scanBuffer, scanPolicy } from '../malware-scan.js';
import { AppError } from '../errors.js';
import { authority, need, mustBeActive, canSome, policyAt, paramsOf } from '../federation.js';
import { actingFor, requireConsent, guardiansOf } from '../youth.js';
import { FLOW, STATUSES, hist, liveClassifier, caseParty, outcomeAt, publicOutcome, classIn } from '../para.js';

const TAG = 'Para classification';
const t = (n) => z.string().trim().max(n);
const DISCLAIMER = 'A competition class is an administrative sporting classification, not a medical diagnosis.';

const CASE_COLS = `c.id, c.athlete_id, c.body_id, org.name AS authority, c.sport_id, s.name AS sport, c.discipline, c.version_id, v.version, v.panel_size, v.appeal_days, c.requested_context, c.status,
  c.appointment_on, c.initiated_for, c.outcome_id, c.closed_at, c.created_at, c.updated_at`;
const CASE_FROM = 'para_cases c JOIN governing_bodies b ON b.id=c.body_id JOIN organisations org ON org.id=b.organisation_id JOIN sports s ON s.id=c.sport_id JOIN para_class_versions v ON v.id=c.version_id';

async function theCase(c, caseId, lock = false) {
  const row = (await c.query(`SELECT ${CASE_COLS} FROM ${CASE_FROM} WHERE c.id=$1 ${lock ? 'FOR UPDATE OF c' : ''}`, [caseId])).rows[0];
  if (!row) throw notFound('Classification case');
  return row;
}
/** Party (athlete / guardian / panel) or body staff, never anyone else. Staff get `staff:true` and no access to the sensitive workflow. */
async function viewer(c, user, row) {
  try { return await caseParty(c, user, row); } catch (e) {
    if (e.status !== 404) throw e;
    const auth = await authority(user, row.body_id, { c, optional: true });
    if (auth && canSome(auth, 'governance')) return { kind: 'staff', staff: true, auth };
    throw e;
  }
}
const staffOnly = async (c, user, row) => { const auth = await authority(user, row.body_id, { c, optional: true }); if (!auth || !canSome(auth, 'governance')) throw notFound('Classification case'); need(auth, 'governance', row.sport_id); return auth; };
const recipients = async (c, row) => [...new Set([row.athlete_id, ...(await guardiansOf(row.athlete_id, c))])];
const tell = async (c, row, title, body) => { for (const u of await recipients(c, row)) await notify(c, u, { kind: 'para_case', title, body, data: { case_id: row.id } }); };

// ------------------------------------------------------------------ cases
cap({
  name: 'open_para_case', method: 'POST', path: '/para/cases', tag: TAG, scope: 'clinical', status: 201,
  summary: 'Start a classification case for an athlete (or, for a young athlete, as their verified guardian) with the responsible governing body, or as that body\'s staff. Only administrative data is held: no diagnosis, treatment or impairment notes. A published governing definition must exist for the sport.',
  input: z.object({
    athlete_id: id.optional().describe('omit for yourself'), body_id: id, sport_id: id, discipline: t(60).default(''),
    requested_context: z.enum(['initial', 'review', 'reassessment', 'international']).default('initial'),
    note: t(1000).optional().describe('administrative note for the classifiers; encrypted, visible only to the athlete/guardian and the assigned panel'),
  }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const athleteId = i.athlete_id ?? user.id;
    let by = 'federation';
    const auth = await authority(user, i.body_id, { c, optional: true });
    if (auth && canSome(auth, 'governance') && athleteId !== user.id) { need(auth, 'governance', i.sport_id); }
    else by = (await actingFor(user, athleteId, 'consent')) === 'guardian' ? 'guardian' : 'athlete';
    const body = auth?.body ?? (await c.query('SELECT b.*, o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id=$1', [i.body_id])).rows[0];
    if (!body) throw notFound('Governing body');
    mustBeActive(body);
    if (!(await c.query("SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL", [i.body_id, i.sport_id])).rowCount) throw badRequest('That governing body does not govern this sport');
    const v = (await c.query("SELECT * FROM para_class_versions WHERE body_id=$1 AND sport_id=$2 AND discipline=$3 AND status='published' AND effective_from <= current_date ORDER BY version DESC LIMIT 1", [i.body_id, i.sport_id, i.discipline])).rows[0];
    if (!v) throw conflict('This governing body has not published a classification definition for that sport/discipline, so no case can be opened', { code: 'no_definition' });
    // youth: classification touches sensitive information, so a verified guardian must currently consent
    await requireConsent(athleteId, 'medical', 'a para classification case', c);
    const policy = await policyAt(i.body_id, 'para_classification', { sportId: i.sport_id }, c);
    if (by === 'athlete' && policy && paramsOf('para_classification', policy).classification_required === false) throw forbidden('This body\'s policy does not take athlete-initiated cases for that sport');
    const r = (await c.query(
      `INSERT INTO para_cases(athlete_id, body_id, sport_id, discipline, version_id, requested_context, note_enc, initiated_by, initiated_for) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [athleteId, i.body_id, i.sport_id, i.discipline, v.id, i.requested_context, i.note ? encrypt(i.note, 'para_cases.note') : null, user.id, by])).rows[0];
    await hist(c, 'case', r.id, athleteId, 'opened', { to: 'submitted', actor: user.id, detail: { by, version: v.version } });
    await tell(c, { id: r.id, athlete_id: athleteId }, 'Classification case submitted', `Your classification case with ${body.name} was submitted.`);
    return { id: r.id, status: 'submitted', version: v.version, note: DISCLAIMER };
  }),
});

cap({
  name: 'list_para_cases', method: 'GET', path: '/para/cases', tag: TAG, scope: 'clinical',
  summary: 'Classification cases: your own (and your wards\'), the ones you are assigned to as a panel classifier, or a governing body\'s queue. Lists carry workflow state only: never notes or evidence.',
  input: z.object({ scope: z.enum(['mine', 'assigned', 'body']).default('mine'), body_id: id.optional(), status: z.enum(['submitted', 'evidence_review', 'assessment_scheduled', 'assessment_completed', 'panel_review', 'decision_issued', 'incomplete', 'withdrawn', 'closed']).optional(), ...page }),
  handler: async ({ user }, i) => {
    let where, args;
    if (i.scope === 'mine') { where = '(c.athlete_id=$1 OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$1 AND l.child_id=c.athlete_id AND l.status=\'active\' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())))'; args = [user.id]; }
    else if (i.scope === 'assigned') { where = 'EXISTS (SELECT 1 FROM para_case_panel p JOIN para_classifiers k ON k.id=p.classifier_id WHERE p.case_id=c.id AND k.user_id=$1)'; args = [user.id]; }
    else {
      if (!i.body_id) throw badRequest('body_id is required for a body queue');
      const auth = await authority(user, i.body_id);
      if (!canSome(auth, 'governance')) throw notFound('Governing body');
      where = 'c.body_id=$1'; args = [i.body_id];
    }
    const rows = await many(
      `SELECT ${CASE_COLS}, u.display_name AS athlete, (SELECT count(*)::int FROM para_case_panel p WHERE p.case_id=c.id) AS panel_assigned,
              (SELECT count(*)::int FROM para_case_panel p WHERE p.case_id=c.id AND p.decided_at IS NOT NULL) AS panel_decided,
              GREATEST(0, (current_date - c.created_at::date))::int AS age_days
         FROM ${CASE_FROM} JOIN users u ON u.id=c.athlete_id WHERE ${where} AND ($2::text IS NULL OR c.status=$2) ORDER BY (c.status IN ('decision_issued','incomplete','withdrawn','closed')), c.created_at DESC LIMIT $3 OFFSET $4`,
      [...args, i.status ?? null, i.limit, i.offset]);
    const summary = rows.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
    return { cases: rows, by_status: summary, note: DISCLAIMER };
  },
});

cap({
  name: 'get_para_case', method: 'GET', path: '/para/cases/:id', tag: TAG, scope: 'clinical',
  summary: 'One classification case. The athlete/guardian and assigned panel see the note and evidence list; body staff see the workflow, panel and history only. Everyone else gets 404.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const row = await theCase(c, i.id);
    const v = await viewer(c, user, row);
    const panel = (await c.query(
      `SELECT p.id, p.role, (p.decided_at IS NOT NULL) AS decided, u.display_name AS name, k.grade, (k.user_id=$2) AS you,
              CASE WHEN $3 OR k.user_id=$2 THEN p.decision_class_code END AS decision_class_code, CASE WHEN $3 OR k.user_id=$2 THEN p.decision_status END AS decision_status
         FROM para_case_panel p JOIN para_classifiers k ON k.id=p.classifier_id JOIN users u ON u.id=k.user_id WHERE p.case_id=$1 ORDER BY p.created_at`, [row.id, user.id, row.status === 'decision_issued' && v.kind !== 'staff'])).rows;
    const out = { ...row, panel, history: (await c.query("SELECT action, from_status, to_status, created_at FROM para_history WHERE subject_type='case' AND subject_id=$1 ORDER BY id", [row.id])).rows, next: FLOW[row.status], note: DISCLAIMER, viewer: v.kind };
    if (v.kind !== 'staff') {
      const full = (await c.query('SELECT note_enc FROM para_cases WHERE id=$1', [row.id])).rows[0];
      out.requester_note = full.note_enc ? decrypt(full.note_enc, 'para_cases.note') : null;
      out.evidence = (await c.query('SELECT id, label, file_name, content_type, size_bytes, created_at, (reference_enc IS NOT NULL) AS has_reference, (file_enc IS NOT NULL) AS has_file FROM para_evidence WHERE case_id=$1 AND retired_at IS NULL ORDER BY created_at', [row.id])).rows;
      await audit(c, user.id, 'read_clinical', 'para_cases', row.id);
    }
    out.outcome = row.outcome_id ? publicOutcome(await outcomeAt(c, row.athlete_id, row.sport_id, new Date(), row.discipline)) : null;
    return out;
  }),
});

cap({
  name: 'assign_para_panel', method: 'POST', path: '/para/cases/:id/panel', tag: TAG, scope: 'clinical',
  summary: 'Assign credentialed classifiers to a case. Each must hold a live credential for the sport/discipline; the athlete, their guardians and anyone without a classifier credential cannot be assigned. The version\'s panel size sets how many independent decisions are needed.',
  input: z.object({ id, members: z.array(z.object({ classifier_id: id, role: z.enum(['lead', 'member', 'observer']).default('member') }).strict()).min(1).max(7) }),
  handler: ({ user }, i) => tx(async (c) => {
    const row = await theCase(c, i.id, true);
    const auth = await staffOnly(c, user, row);
    mustBeActive(auth.body);
    if (['decision_issued', 'incomplete', 'withdrawn', 'closed'].includes(row.status)) throw conflict(`This case is ${row.status}`);
    for (const m of i.members) {
      const k = (await c.query("SELECT * FROM para_classifiers WHERE id=$1 AND sport_id=$2 AND status='active' AND issued_on <= current_date AND expires_on >= current_date AND (discipline='' OR discipline=$3)", [m.classifier_id, row.sport_id, row.discipline])).rows[0];
      if (!k) throw badRequest('Each member needs a live classifier credential for this sport/discipline');
      if (k.user_id === row.athlete_id || (await guardiansOf(row.athlete_id, c)).includes(k.user_id)) throw conflict('A classifier cannot assess themselves or someone they are guardian of');
      await c.query('INSERT INTO para_case_panel(case_id, classifier_id, role, assigned_by) VALUES ($1,$2,$3,$4) ON CONFLICT (case_id, classifier_id) DO UPDATE SET role=EXCLUDED.role', [row.id, m.classifier_id, m.role, user.id]);
      await notify(c, k.user_id, { kind: 'para_case', title: 'Classification case assigned', body: `You were assigned as ${m.role} to a classification case.`, data: { case_id: row.id } });
    }
    const leads = (await c.query("SELECT count(*)::int AS n FROM para_case_panel WHERE case_id=$1 AND role='lead'", [row.id])).rows[0].n;
    if (leads > 1) throw conflict('A case has at most one lead classifier');
    await hist(c, 'case', row.id, row.athlete_id, 'panel_assigned', { actor: user.id, detail: { members: i.members.length } });
    return { assigned: i.members.length, lead: leads === 1 };
  }),
});

cap({
  name: 'advance_para_case', method: 'POST', path: '/para/cases/:id/advance', tag: TAG, scope: 'clinical',
  summary: 'Move a case along the governed stages (submitted → evidence review → assessment scheduled → assessment completed → panel review). A decision is only issued through issue_para_outcome. Incomplete and closed outcomes need a reason.',
  input: z.object({ id, to: z.enum(['evidence_review', 'assessment_scheduled', 'assessment_completed', 'panel_review', 'incomplete', 'closed']), appointment_on: z.string().datetime({ offset: true }).optional(), appointment_ref: t(120).optional(), reason: t(500).optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const row = await theCase(c, i.id, true);
    const v = await viewer(c, user, row);
    if (v.kind === 'staff') need(v.auth, 'governance', row.sport_id); else if (v.kind !== 'panel') throw forbidden('Only the authority\'s staff or an assigned classifier can move a case');
    if (!FLOW[row.status].includes(i.to)) throw conflict(`A ${row.status.replace(/_/g, ' ')} case cannot move to ${i.to.replace(/_/g, ' ')}`);
    if (i.to === 'assessment_scheduled' && !i.appointment_on) throw badRequest('An appointment date and time is required');
    if (['incomplete', 'closed'].includes(i.to) && !i.reason) throw badRequest('Give a reason');
    if (i.to === 'panel_review') {
      const n = (await c.query("SELECT count(*)::int AS n FROM para_case_panel WHERE case_id=$1 AND role <> 'observer'", [row.id])).rows[0].n;
      if (n < row.panel_size) throw conflict(`This classification needs ${row.panel_size} assigned classifier(s) before panel review (${n} assigned)`);
    }
    await c.query('UPDATE para_cases SET status=$2, appointment_on=COALESCE($3, appointment_on), appointment_ref_enc=COALESCE($4, appointment_ref_enc), closed_at=CASE WHEN $2 IN (\'closed\',\'incomplete\') THEN now() ELSE closed_at END, updated_at=now() WHERE id=$1',
      [row.id, i.to, i.appointment_on ?? null, i.appointment_ref ? encrypt(i.appointment_ref, 'para_cases.appointment_ref') : null]);
    await hist(c, 'case', row.id, row.athlete_id, 'advanced', { from: row.status, to: i.to, actor: user.id, detail: i.reason ? { reason_given: true } : {} });
    await tell(c, row, 'Classification case update', `Your classification case is now: ${i.to.replace(/_/g, ' ')}.${i.appointment_on ? ` Appointment: ${i.appointment_on}.` : ''}`);
    return { id: row.id, status: i.to };
  }),
});

cap({
  name: 'withdraw_para_case', method: 'POST', path: '/para/cases/:id/withdraw', tag: TAG, scope: 'clinical',
  summary: 'The athlete (or a verified guardian) withdraws an open case. Nothing is deleted; the case and its history stay on record.',
  input: z.object({ id, reason: t(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const row = await theCase(c, i.id, true);
    const v = await caseParty(c, user, row);
    if (!v.athleteView) throw forbidden('Only the athlete or their guardian can withdraw a case');
    if (!FLOW[row.status].includes('withdrawn')) throw conflict(`A ${row.status.replace(/_/g, ' ')} case cannot be withdrawn`);
    await c.query("UPDATE para_cases SET status='withdrawn', closed_at=now(), updated_at=now() WHERE id=$1", [row.id]);
    await hist(c, 'case', row.id, row.athlete_id, 'withdrawn', { from: row.status, to: 'withdrawn', actor: user.id });
    return { id: row.id, status: 'withdrawn' };
  }),
});

cap({
  name: 'my_para_classification', method: 'GET', path: '/me/para-classification', tag: TAG, scope: 'clinical',
  summary: 'The athlete\'s (or ward\'s) classification at a glance: current class and status per sport, issuing authority, review date, pending appointments and actions, permitted decisions and the review/protest path. Competition-facing fields only.',
  input: z.object({ athlete_id: id.optional() }),
  handler: async ({ user }, i) => {
    const athleteId = i.athlete_id ?? user.id;
    await actingFor(user, athleteId, 'consent');
    const outcomes = await many(
      `SELECT o.id, o.sport_id, s.name AS sport, o.discipline, o.class_code, o.status, o.effective_from::text AS effective_from, o.review_by::text AS review_by, o.expires_on::text AS expires_on, o.decision_ref, v.version,
              org.name AS authority, (o.review_by IS NOT NULL AND o.review_by < current_date) AS review_overdue,
              (SELECT row_to_json(a) FROM (SELECT id, kind, status, deadline_on::text AS deadline_on FROM para_appeals WHERE outcome_id=o.id ORDER BY created_at DESC LIMIT 1) a) AS appeal,
              (o.created_at::date + v.appeal_days) AS appeal_by_raw
         FROM para_outcomes o JOIN sports s ON s.id=o.sport_id JOIN para_class_versions v ON v.id=o.version_id JOIN governing_bodies b ON b.id=o.authority_id JOIN organisations org ON org.id=b.organisation_id
        WHERE o.athlete_id=$1 AND o.superseded_at IS NULL ORDER BY s.name`, [athleteId]);
    const cases = await many(`SELECT ${CASE_COLS} FROM ${CASE_FROM} WHERE c.athlete_id=$1 ORDER BY c.created_at DESC LIMIT 20`, [athleteId]);
    const external = await many(`SELECT x.id, s.name AS sport, x.class_code, x.class_status AS status, x.effective_from::text AS effective_from, x.review_by::text AS review_by, x.status AS verification, org.name AS authority
      FROM para_external_refs x JOIN sports s ON s.id=x.sport_id JOIN governing_bodies b ON b.id=x.source_body_id JOIN organisations org ON org.id=b.organisation_id WHERE x.athlete_id=$1 ORDER BY x.created_at DESC`, [athleteId]);
    const today = new Date().toISOString().slice(0, 10);
    const open = cases.filter((x) => !['decision_issued', 'incomplete', 'withdrawn', 'closed'].includes(x.status));
    const actions = [];
    for (const x of open) {
      if (x.status === 'submitted' || x.status === 'evidence_review') actions.push({ kind: 'evidence', case_id: x.id, label: 'Supporting evidence may be requested by the authority' });
      if (x.appointment_on && String(x.appointment_on) >= today) actions.push({ kind: 'appointment', case_id: x.id, at: x.appointment_on });
    }
    for (const o of outcomes) if (o.review_overdue) actions.push({ kind: 'review_due', outcome_id: o.id, by: o.review_by });
    return { athlete_id: athleteId, outcomes: outcomes.map(({ appeal_by_raw, ...o }) => ({ ...o, appeal_open_until: String(appeal_by_raw).slice(0, 10), can_appeal: !o.appeal || o.appeal.status !== 'open' })), cases, external_references: external, pending_actions: actions, note: DISCLAIMER };
  },
});

// ------------------------------------------------------------------ panel decision
cap({
  name: 'record_para_panel_decision', method: 'POST', path: '/para/cases/:id/decision', tag: TAG, scope: 'clinical',
  summary: 'An assigned classifier records their independent recommendation (class and status). Authority is checked live against the credential\'s sport, discipline and class scope. Panel members do not see each other\'s decisions until the outcome is issued.',
  input: z.object({ id, class_code: t(20).optional(), status: z.enum(STATUSES) }).strict().refine((i) => ['not_eligible', 'other'].includes(i.status) || i.class_code, { message: 'class_code is required for this status' }),
  handler: ({ user }, i) => tx(async (c) => {
    const row = await theCase(c, i.id, true);
    const v = await caseParty(c, user, row);
    if (v.kind !== 'panel') throw forbidden('Only an assigned classifier can record a decision');
    if (v.panel.role === 'observer') throw forbidden('Observers do not decide');
    if (row.status !== 'panel_review') throw conflict('Decisions are recorded while the case is in panel review');
    const k = await liveClassifier(c, user.id, { sportId: row.sport_id, discipline: row.discipline, classCode: i.class_code?.toUpperCase() ?? null, lock: true });
    if (!k) throw forbidden('Your classifier credential is not live for this sport, discipline and class');
    if (i.class_code) await classIn(c, row.version_id, i.class_code.toUpperCase());
    await c.query('UPDATE para_case_panel SET decision_class_code=$2, decision_status=$3, decided_at=now() WHERE id=$1', [v.panel.id, i.class_code?.toUpperCase() ?? null, i.status]);
    await hist(c, 'case', row.id, row.athlete_id, 'panel_decision', { actor: user.id });
    await audit(c, user.id, 'write_clinical', 'para_case_panel', v.panel.id);
    return { recorded: true };
  }),
});

// ------------------------------------------------------------------ evidence
const evidenceIn = z.object({
  id, label: t(80).min(1).describe('what this evidences, e.g. a document title chosen by the governing process'),
  reference: t(500).min(2).optional().describe('an external-authority reference (number or https link)'),
  file_name: t(120).optional(), data: z.string().max(B64_MAX_CHARS).optional().describe('base64 file: PDF, JPEG, PNG or WebP'),
}).strict().refine((e) => e.reference || e.data, 'Give a reference or attach a file');
const sniff = (b) => { const hex = b.subarray(0, 8).toString('hex'), txt = b.subarray(0, 12).toString('latin1');
  if (txt.startsWith('%PDF-')) return 'application/pdf'; if (hex.startsWith('ffd8ff')) return 'image/jpeg'; if (hex === '89504e470d0a1a0a') return 'image/png'; if (txt.startsWith('RIFF') && txt.slice(8) === 'WEBP') return 'image/webp'; return null; };

cap({
  name: 'add_para_evidence', method: 'POST', path: '/para/cases/:id/evidence', tag: TAG, scope: 'clinical', status: 201,
  summary: 'Attach supporting evidence only where the governing policy requires it: an external-authority reference or an encrypted file. Held privately; readable only by the athlete/guardian and the assigned panel; every read is audited. Collect nothing the process does not need.',
  input: evidenceIn,
  handler: ({ user }, i) => tx(async (c) => {
    const row = await theCase(c, i.id, true);
    const v = await caseParty(c, user, row);
    if (['decision_issued', 'incomplete', 'withdrawn', 'closed'].includes(row.status)) throw conflict(`This case is ${row.status}`);
    if (v.kind === 'athlete' || v.kind === 'guardian') await requireConsent(row.athlete_id, 'medical', 'sensitive classification evidence', c);
    if ((await c.query('SELECT count(*)::int AS n FROM para_evidence WHERE case_id=$1 AND retired_at IS NULL', [row.id])).rows[0].n >= 20) throw conflict('At most 20 items per case');
    if (i.reference && /^[a-z]+:\/\//i.test(i.reference) && !/^https:\/\//i.test(i.reference)) throw badRequest('Links must use https');
    const f = { file_name: null, content_type: null, size_bytes: null, sha256: null, file_enc: null };
    if (i.data) {
      const b64 = i.data.replace(/^data:[^,]*,/, '');
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 16) throw badRequest('That file is empty');
      if (buf.length > documentMaxBytes()) throw badRequest(`Files can be up to ${documentMaxBytes() / 2 ** 20} MB`);
      const type = sniff(buf);
      if (!type) throw badRequest('Unsupported file. Use PDF, JPEG, PNG or WebP.');
      const scan = await scanBuffer(buf);
      if (scan.status === 'infected') throw badRequest('That file was rejected by the malware scan');
      if (scan.status === 'unavailable' && scanPolicy().mode === 'required') throw new AppError(503, 'scan_unavailable', 'Files cannot be checked right now. Try again shortly.');
      Object.assign(f, { file_name: (i.file_name ?? 'document').replace(/[^\w. -]/g, '_').slice(0, 120), content_type: type, size_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), file_enc: encrypt(b64, 'para_evidence.file') });
    }
    const r = (await c.query(
      `INSERT INTO para_evidence(case_id, label, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, label, file_name, content_type, size_bytes, created_at`,
      [row.id, i.label, i.reference ? encrypt(i.reference, 'para_evidence.reference') : null, f.file_name, f.content_type, f.size_bytes, f.sha256, f.file_enc, user.id])).rows[0];
    await hist(c, 'case', row.id, row.athlete_id, 'evidence_added', { actor: user.id });
    await audit(c, user.id, 'write_clinical', 'para_evidence', r.id);
    return r;
  }),
});

cap({
  name: 'read_para_evidence', method: 'GET', path: '/para/cases/:id/evidence/:evidence_id', tag: TAG, scope: 'clinical',
  summary: 'Open one evidence item. Only the athlete, a verified guardian of a young athlete, or a panel classifier with a live credential can; body staff, organisers, coaches, sponsors, media and administrators cannot. Every read is audit-logged.',
  input: z.object({ id, evidence_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const row = await theCase(c, i.id);
    await caseParty(c, user, row);
    const e = (await c.query('SELECT * FROM para_evidence WHERE id=$1 AND case_id=$2 AND retired_at IS NULL', [i.evidence_id, row.id])).rows[0];
    if (!e) throw notFound('Evidence');
    await audit(c, user.id, 'read_clinical', 'para_evidence', e.id);
    return { id: e.id, label: e.label, reference: e.reference_enc ? decrypt(e.reference_enc, 'para_evidence.reference') : null,
      file: e.file_enc ? { name: e.file_name, content_type: e.content_type, size_bytes: e.size_bytes, sha256: e.sha256, data: decrypt(e.file_enc, 'para_evidence.file') } : null };
  }),
});

cap({
  name: 'retire_para_evidence', method: 'DELETE', path: '/para/cases/:id/evidence/:evidence_id', tag: TAG, scope: 'clinical',
  summary: 'Hide an evidence item from the case (soft: the encrypted record is kept for audit). The athlete/guardian or the panel may retire it while the case is open.',
  input: z.object({ id, evidence_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const row = await theCase(c, i.id);
    await caseParty(c, user, row);
    if (['decision_issued', 'incomplete', 'withdrawn', 'closed'].includes(row.status)) throw conflict(`This case is ${row.status}`);
    const r = await c.query('UPDATE para_evidence SET retired_at=now() WHERE id=$1 AND case_id=$2 AND retired_at IS NULL RETURNING id', [i.evidence_id, row.id]);
    if (!r.rowCount) throw notFound('Evidence');
    await hist(c, 'case', row.id, row.athlete_id, 'evidence_retired', { actor: user.id });
    return { retired: true };
  }),
});
