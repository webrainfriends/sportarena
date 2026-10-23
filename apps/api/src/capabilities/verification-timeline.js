// Onboarding timeline for physios, doctors, insurers, sponsors (and every other verification type): where each case is, what happens next,
// which documents are required / still missing, and who may read the uploaded documents. Documents stay encrypted (verification_evidence);
// only the uploader and people the uploader explicitly shared them with can read them, and each read is audit-logged.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { decrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { sponsorCanSql, CAN } from '../sponsor-identity-access.js';
import { notify } from '../notify.js';
import { EVIDENCE_KINDS, RULES, TYPES } from '../verification.js';

const TAG = 'Verification';
const STATE_SQL = "CASE WHEN c.status='approved' AND c.expires_at <= now() THEN 'expired' ELSE c.status END";
const day = (d) => new Date(d).toISOString().slice(0, 10);

/** Required / alternative documents for a type against what is on file. */
function documentChecklist(type, evidence) {
  const rule = RULES[type], by = (k) => evidence.filter((e) => e.kind === k).map((e) => ({ id: e.id, file_name: e.file_name, has_reference: e.has_reference, created_at: e.created_at }));
  const row = (k, requirement) => ({ kind: k, label: EVIDENCE_KINDS[k], requirement, provided: by(k).length > 0, items: by(k) });
  const docs = [...rule.required.map((k) => row(k, 'required')), ...(rule.one_of ?? []).map((k) => row(k, 'one_of'))];
  const extra = [...new Set(evidence.map((e) => e.kind))].filter((k) => !docs.some((d) => d.kind === k)).map((k) => row(k, 'extra'));
  const missingRequired = docs.filter((d) => d.requirement === 'required' && !d.provided).map((d) => d.label);
  const needOne = (rule.one_of?.length ?? 0) > 0 && !docs.some((d) => d.requirement === 'one_of' && d.provided);
  return { documents: [...docs, ...extra], missing: needOne ? [...missingRequired, `One of: ${rule.one_of.map((k) => EVIDENCE_KINDS[k]).join(' / ')}`] : missingRequired };
}

/** The five-step timeline and the "what's next" call to action for a case's current state. */
function buildTimeline(cs, history, missing) {
  const at = (action) => history.find((h) => h.action === action)?.created_at ?? null;
  const st = cs.status, decided = ['approved', 'rejected', 'needs_info', 'revoked', 'expired'].includes(st);
  const terminalStop = ['rejected', 'withdrawn'].includes(st);
  const stages = [
    { key: 'documents', title: 'Documents submitted', state: 'done', at: cs.submitted_at, detail: missing.length && st === 'needs_info' ? `Still needed: ${missing.join('; ')}` : 'Your documents are encrypted and on file.' },
    { key: 'queue', title: 'In the review queue', state: st === 'submitted' ? 'current' : st === 'withdrawn' ? 'blocked' : 'done', at: st === 'submitted' ? cs.submitted_at : at('claim'), detail: st === 'submitted' ? 'Waiting for a platform reviewer to pick it up.' : st === 'withdrawn' ? 'You withdrew this request.' : null },
    { key: 'review', title: 'Platform review', state: st === 'in_review' ? 'current' : decided ? 'done' : 'upcoming', at: at('claim'), detail: st === 'in_review' ? 'A reviewer is checking your documents against the checklist.' : null },
    { key: 'decision', title: st === 'needs_info' ? 'More information needed' : st === 'rejected' ? 'Declined' : st === 'revoked' ? 'Badge revoked' : 'Decision', state: st === 'needs_info' ? 'current' : st === 'rejected' || st === 'revoked' ? 'blocked' : ['approved', 'expired'].includes(st) ? 'done' : 'upcoming', at: cs.decided_at, detail: cs.decision_reason ?? null },
    { key: 'verified', title: st === 'expired' ? 'Badge expired' : 'Verified & public', state: st === 'approved' ? 'done' : st === 'expired' ? 'current' : 'upcoming', at: st === 'approved' ? cs.decided_at : cs.expires_at, detail: st === 'approved' ? `Your badge is public until ${day(cs.expires_at)}.` : st === 'expired' ? `Expired on ${day(cs.expires_at)}.` : null },
  ];
  if (terminalStop && st === 'withdrawn') stages.slice(2).forEach((s) => { s.state = 'upcoming'; });
  const next = {
    submitted: { actor: 'platform', title: 'A reviewer will pick this up', detail: 'Nothing to do right now. You can add more documents while you wait.' },
    in_review: { actor: 'platform', title: 'Review in progress', detail: 'You will be notified as soon as there is a decision.' },
    needs_info: { actor: 'you', title: 'Send the reviewer what they asked for', detail: cs.decision_reason ?? 'Add the missing documents, then send the case back for review.', missing },
    approved: { actor: 'none', title: 'You are verified', detail: `Renewal opens 30 days before ${day(cs.expires_at)}.` },
    expired: { actor: 'you', title: 'Renew your badge', detail: 'Submit fresh documents to get verified again.' },
    rejected: { actor: 'you', title: 'Start a new request', detail: cs.decision_reason ?? 'Fix the issue the reviewer raised and submit a new request.' },
    revoked: { actor: 'you', title: 'Badge revoked', detail: cs.decision_reason ?? 'Contact the platform team or submit a new request.' },
    withdrawn: { actor: 'you', title: 'Request withdrawn', detail: 'Submit a new request whenever you are ready.' },
  }[st];
  return { stages, next_step: next };
}

const subjectJoin = `LEFT JOIN sponsors s ON c.subject_type='sponsor' AND s.id=c.subject_id LEFT JOIN events e ON c.subject_type='event' AND e.id=c.subject_id LEFT JOIN users u ON c.subject_type='user' AND u.id=c.subject_id`;

cap({
  name: 'get_verification_timeline', method: 'GET', path: '/verification/cases/:id/timeline', tag: TAG,
  summary: 'The timeline of one onboarding / verification case: each stage with its state (done, current, upcoming, blocked), what is next and who must act, the required documents with which are provided or missing, and who the documents are shared with. Owner or platform team; never returns document contents.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cs = await one(`SELECT c.id, c.case_no, c.type, c.subject_type, c.subject_id, ${STATE_SQL} AS status, c.requested_by, c.decision_reason, c.decided_at, c.expires_at, c.submitted_at, coalesce(s.name, e.name, u.display_name) AS subject_name
      FROM verification_cases c ${subjectJoin} WHERE c.id=$1`, [i.id]);
    if (!cs || !(isAdmin(user) || cs.requested_by === user.id)) throw notFound('Verification case');
    const [evidence, history, shares] = await Promise.all([
      many('SELECT id, kind, file_name, created_at, (reference_enc IS NOT NULL) AS has_reference FROM verification_evidence WHERE case_id=$1 ORDER BY created_at', [i.id]),
      many('SELECT action, created_at FROM verification_events WHERE case_id=$1 ORDER BY created_at, id', [i.id]),
      cs.requested_by === user.id ? many('SELECT count(DISTINCT grantee_id)::int AS n FROM verification_shares WHERE case_id=$1 AND revoked_at IS NULL AND expires_at > now()', [i.id]) : Promise.resolve([{ n: null }]),
    ]);
    const { documents, missing } = documentChecklist(cs.type, evidence);
    const { stages, next_step } = buildTimeline(cs, history, missing);
    return { case_id: cs.id, case_no: cs.case_no, type: cs.type, label: RULES[cs.type].label, subject_name: cs.subject_name, status: cs.status, expires_at: cs.expires_at, stages, next_step, documents, missing, shared_with: shares[0].n };
  },
});

cap({
  name: 'list_my_onboarding', method: 'GET', path: '/me/onboarding', tag: TAG,
  summary: 'Your onboarding checklist: every verification you are eligible for (by role — physio, doctor, insurer, coach, athlete — plus each sponsor you own) with its current state, the next step and how many required documents are on file. `not_started` rows say which documents you will need.',
  input: z.object({}),
  async handler({ user }) {
    const [cases, sponsors] = await Promise.all([
      many(`SELECT DISTINCT ON (c.type, c.subject_id) c.id, c.type, c.subject_id, ${STATE_SQL} AS status, c.decision_reason, c.expires_at, c.submitted_at,
          (SELECT array_agg(DISTINCT v.kind) FROM verification_evidence v WHERE v.case_id=c.id) AS kinds
        FROM verification_cases c WHERE c.requested_by=$1 ORDER BY c.type, c.subject_id, c.submitted_at DESC`, [user.id]),
      many(`SELECT id, name FROM sponsors sp WHERE ${sponsorCanSql('$1', CAN.identity)} ORDER BY name, id`, [user.id]),
    ]);
    const latest = (type, subjectId) => cases.find((c) => c.type === type && c.subject_id === subjectId);
    const targets = [];
    for (const t of TYPES) {
      const r = RULES[t];
      if (r.subject === 'user' && user.roles.includes(r.needs_role)) targets.push({ type: t, subject_type: 'user', subject_id: user.id, subject_name: user.display_name });
      if (r.subject === 'sponsor') for (const s of sponsors) targets.push({ type: t, subject_type: 'sponsor', subject_id: s.id, subject_name: s.name });
    }
    return targets.map((t) => {
      const r = RULES[t.type], cs = latest(t.type, t.subject_id), kinds = cs?.kinds ?? [];
      const total = r.required.length + ((r.one_of?.length ?? 0) > 0 ? 1 : 0);
      const done = r.required.filter((k) => kinds.includes(k)).length + ((r.one_of ?? []).some((k) => kinds.includes(k)) ? 1 : 0);
      const status = cs?.status ?? 'not_started';
      const next = { not_started: 'Start: upload your documents', submitted: 'Waiting for a reviewer', in_review: 'Under review', needs_info: 'Action needed: send more information', approved: `Verified until ${cs?.expires_at ? day(cs.expires_at) : ''}`, expired: 'Renew your badge', rejected: 'Declined: start a new request', revoked: 'Revoked', withdrawn: 'Withdrawn: start again anytime' }[status];
      return { ...t, label: r.label, summary: r.summary, status, case_id: cs?.id ?? null, next, docs_total: total, docs_provided: done, required_documents: [...r.required, ...(r.one_of ?? [])].map((k) => ({ kind: k, label: EVIDENCE_KINDS[k], requirement: r.required.includes(k) ? 'required' : 'one_of' })) };
    });
  },
});

// ------------------------------------------------------------------ sharing and reading documents
cap({
  name: 'share_verification_documents', method: 'POST', path: '/verification/cases/:id/shares', tag: TAG, status: 201,
  summary: 'Owner: let one specific person read your uploaded documents for this case (all of them, or only chosen ones) for a limited time, e.g. an insurer or club validating you. Revoke any time. Every read is audit-logged.',
  input: z.object({ id, user_id: id.describe('who may read them'), evidence_ids: z.array(id).max(25).optional().describe('only these documents; omit for every document on the case'), purpose: z.string().max(200).optional(), days: z.coerce.number().int().min(1).max(365).default(30) }),
  async handler({ user }, i) {
    const cs = await one('SELECT id, case_no, type, requested_by FROM verification_cases WHERE id=$1', [i.id]);
    if (!cs || cs.requested_by !== user.id) throw notFound('Verification case');
    if (i.user_id === user.id) throw badRequest('These documents are already yours');
    if (!await one('SELECT 1 FROM users WHERE id=$1', [i.user_id])) throw notFound('User');
    const wanted = [...new Set(i.evidence_ids ?? [null])];
    if (i.evidence_ids?.length) {
      const have = await many('SELECT id FROM verification_evidence WHERE case_id=$1 AND id = ANY($2::uuid[])', [i.id, i.evidence_ids]);
      if (have.length !== wanted.length) throw badRequest('One of those documents is not on this case');
    }
    const expires = new Date(Date.now() + i.days * 864e5);
    const out = [];
    for (const ev of wanted) out.push(await one('INSERT INTO verification_shares(case_id, evidence_id, grantee_id, granted_by, purpose, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, evidence_id, grantee_id, expires_at', [i.id, ev, i.user_id, user.id, i.purpose ?? null, expires]));
    await notify(null, i.user_id, { kind: 'verification_shared', title: `${user.display_name} shared verification documents`, body: `${RULES[cs.type].label} case #${cs.case_no}${i.purpose ? ` — ${i.purpose}` : ''}. Access ends ${day(expires)}.`, data: { case_id: i.id } });
    await audit(null, user.id, 'share_verification_documents', 'verification_cases', i.id);
    return { case_id: i.id, shares: out };
  },
});

cap({
  name: 'revoke_verification_share', method: 'POST', path: '/verification/shares/:id/revoke', tag: TAG,
  summary: 'Owner: stop a person reading your documents. The share record is kept for the audit trail.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one('SELECT id, revoked_at FROM verification_shares WHERE id=$1 AND granted_by=$2', [i.id, user.id]);
    if (!row) throw notFound('Share');
    if (row.revoked_at) throw conflict('Already revoked');
    await one('UPDATE verification_shares SET revoked_at=now() WHERE id=$1 RETURNING id', [i.id]);
    await audit(null, user.id, 'revoke_verification_share', 'verification_shares', i.id);
    return { id: i.id, revoked: true };
  },
});

cap({
  name: 'list_verification_shares', method: 'GET', path: '/verification/cases/:id/shares', tag: TAG,
  summary: 'Owner: who can currently read the documents on this case (and who could before).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cs = await one('SELECT requested_by FROM verification_cases WHERE id=$1', [i.id]);
    if (!cs || cs.requested_by !== user.id) throw notFound('Verification case');
    return many(`SELECT s.id, s.evidence_id, s.grantee_id, g.display_name AS grantee, s.purpose, s.expires_at, s.revoked_at, s.created_at,
        (s.revoked_at IS NULL AND s.expires_at > now()) AS active
      FROM verification_shares s JOIN users g ON g.id=s.grantee_id WHERE s.case_id=$1 ORDER BY s.created_at DESC`, [i.id]);
  },
});

cap({
  name: 'list_verification_shared_with_me', method: 'GET', path: '/me/verification-shared', tag: TAG,
  summary: 'Verification documents other people have shared with you that you can still read (metadata only; open one with get_verification_document).',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT s.id AS share_id, c.id AS case_id, c.case_no, c.type, o.display_name AS owner, s.purpose, s.expires_at,
        (SELECT coalesce(json_agg(json_build_object('id', v.id, 'kind', v.kind, 'file_name', v.file_name, 'content_type', v.content_type, 'size_bytes', v.size_bytes) ORDER BY v.created_at), '[]'::json)
           FROM verification_evidence v WHERE v.case_id=c.id AND (s.evidence_id IS NULL OR v.id=s.evidence_id)) AS documents
      FROM verification_shares s JOIN verification_cases c ON c.id=s.case_id JOIN users o ON o.id=c.requested_by
     WHERE s.grantee_id=$1 AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'get_verification_document', method: 'GET', path: '/verification/cases/:id/documents/:evidence_id', tag: TAG,
  summary: 'Read one uploaded document (reference and, for files, the base64 contents). Allowed for the person who uploaded it and anyone they have an active share with; everyone else gets not found. Every read is audit-logged.',
  input: z.object({ id, evidence_id: id }),
  async handler({ user }, i) {
    const row = await one(`SELECT v.id, v.kind, v.label, v.reference_enc, v.file_name, v.content_type, v.size_bytes, v.sha256, v.file_enc, c.requested_by
      FROM verification_evidence v JOIN verification_cases c ON c.id=v.case_id WHERE v.id=$1 AND v.case_id=$2`, [i.evidence_id, i.id]);
    const allowed = row && (row.requested_by === user.id || await one(
      'SELECT 1 FROM verification_shares WHERE case_id=$1 AND grantee_id=$2 AND revoked_at IS NULL AND expires_at > now() AND (evidence_id IS NULL OR evidence_id=$3)', [i.id, user.id, i.evidence_id]));
    if (!allowed) throw notFound('Document');
    await audit(null, user.id, row.requested_by === user.id ? 'read_own_verification_document' : 'read_shared_verification_document', 'verification_cases', i.id);
    return {
      id: row.id, kind: row.kind, label: row.label, reference: row.reference_enc ? decrypt(row.reference_enc, 'verification_evidence.reference') : null,
      file_name: row.file_name, content_type: row.content_type, size_bytes: row.size_bytes, sha256: row.sha256,
      ...(row.file_enc ? { data: decrypt(row.file_enc, 'verification_evidence.file') } : {}),
    };
  },
});
