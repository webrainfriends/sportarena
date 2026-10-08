// Verification service: users, sponsors and events can ask the platform team for a verified badge. Each request is a case with
// evidence, a reviewer checklist, a decision and an expiry. The badge is public; evidence never is.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { EVIDENCE_KINDS, OPEN, RULES, RULES_VERSION, TYPES, badgesFor, missingEvidence } from '../verification.js';

const TAG = 'Verification';
const MAX_FILE = 5 * 2 ** 20, MAX_EVIDENCE = 12, RENEW_WINDOW_DAYS = 30;
const kind = z.enum(Object.keys(EVIDENCE_KINDS));
const evidenceIn = z.object({
  kind, label: z.string().max(120).optional(),
  reference: z.string().min(2).max(500).optional().describe('licence / registration number or https link'),
  file_name: z.string().max(120).optional(), data: z.string().max(7_200_000).optional().describe('base64 file: PDF, JPEG, PNG or WebP, up to 5 MB'),
}).refine((e) => e.reference || e.data, 'Give a reference (number or link) or attach a file');

const stateSql = "CASE WHEN c.status='approved' AND c.expires_at <= now() THEN 'expired' ELSE c.status END";
const CASE_COLS = `c.id, c.case_no, c.type, c.subject_type, c.subject_id, c.sport_id, c.requested_by, ${stateSql} AS status, c.claim_note, c.rules_version,
  c.reviewer_id, c.decision_reason, c.decided_at, c.expires_at, c.previous_case_id, c.submitted_at, c.updated_at`;

function sniffDoc(b) {
  const hex = b.subarray(0, 8).toString('hex'), txt = b.subarray(0, 12).toString('latin1');
  if (txt.startsWith('%PDF-')) return { type: 'application/pdf' };
  if (hex.startsWith('ffd8ff')) return { type: 'image/jpeg' };
  if (hex === '89504e470d0a1a0a') return { type: 'image/png' };
  if (txt.startsWith('RIFF') && txt.slice(8) === 'WEBP') return { type: 'image/webp' };
  return null;
}

/** Validate one evidence item and turn it into encrypted columns. */
function prepEvidence(e) {
  const out = { kind: e.kind, label: e.label ?? null, reference_enc: encrypt(e.reference, 'verification_evidence.reference'), file_name: null, content_type: null, size_bytes: null, sha256: null, file_enc: null };
  if (e.reference && /^[a-z]+:\/\//i.test(e.reference) && !/^https:\/\//i.test(e.reference)) throw badRequest('Links must use https');
  if (e.data) {
    const b64 = e.data.replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 16) throw badRequest('That file is empty');
    if (buf.length > MAX_FILE) throw badRequest(`Files can be up to ${MAX_FILE / 2 ** 20} MB`);
    const t = sniffDoc(buf);
    if (!t) throw badRequest('Unsupported file. Use PDF, JPEG, PNG or WebP.');
    Object.assign(out, { file_name: (e.file_name ?? 'document').replace(/[^\w. -]/g, '_').slice(0, 120), content_type: t.type, size_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), file_enc: encrypt(b64, 'verification_evidence.file') });
  }
  return out;
}
const insertEvidence = (c, caseId, userId, p) => c.query(
  'INSERT INTO verification_evidence(case_id, kind, label, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
  [caseId, p.kind, p.label, p.reference_enc, p.file_name, p.content_type, p.size_bytes, p.sha256, p.file_enc, userId]);
const logEvent = (c, caseId, actor, action, from, to, reason) => c.query('INSERT INTO verification_events(case_id, actor_id, action, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6)', [caseId, actor, action, from, to, reason ?? null]);
const lockCase = async (c, caseId) => {
  const row = (await c.query('SELECT * FROM verification_cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
  if (!row) throw notFound('Verification case');
  return row;
};
const evidenceKinds = async (c, caseId) => (await c.query('SELECT kind FROM verification_evidence WHERE case_id=$1', [caseId])).rows.map((r) => r.kind);
const canSee = (user, row) => isAdmin(user) || row.requested_by === user.id;
const adminIds = async (c) => (await c.query("SELECT id FROM users WHERE 'admin' = ANY(roles)")).rows.map((r) => r.id);

/** The subject a requester may ask to have verified, or an error. */
async function resolveSubject(user, type, subjectId) {
  const rule = RULES[type];
  if (rule.subject === 'user') {
    if (subjectId && subjectId !== user.id) throw forbidden('You can only ask to verify your own profile');
    if (!user.roles.includes(rule.needs_role)) throw badRequest(`Add the ${rule.needs_role} role to your account first, then request verification`);
    return { id: user.id, name: user.display_name };
  }
  if (!subjectId) throw badRequest(`subject_id is required to verify a ${type}`);
  const row = rule.subject === 'sponsor'
    ? await one('SELECT id, name, owner_id AS owner FROM sponsors WHERE id=$1', [subjectId])
    : await one('SELECT id, name, organizer_id AS owner FROM events WHERE id=$1', [subjectId]);
  if (!row) throw notFound(rule.subject === 'sponsor' ? 'Sponsor' : 'Event');
  if (row.owner !== user.id) throw forbidden(`Only the ${rule.subject === 'sponsor' ? 'sponsor owner' : 'event organiser'} can request this verification`);
  return row;
}

// ------------------------------------------------------------------ rules
cap({
  name: 'list_verification_rules', method: 'GET', path: '/verification/rules', tag: TAG, auth: 'public',
  summary: 'What each verification type needs: eligibility, evidence to attach, the reviewer checklist and how long a badge lasts. Read this before submitting.',
  handler: async () => ({
    version: RULES_VERSION,
    process: ['Submit a case with evidence', 'A platform reviewer claims it and works the checklist', 'They approve, reject with a reason, or ask you for more information', 'Approved badges are public until they expire (then renew) or are revoked'],
    evidence_kinds: EVIDENCE_KINDS,
    types: TYPES.map((t) => ({ type: t, ...RULES[t] })),
  }),
});

// ------------------------------------------------------------------ requester side
cap({
  name: 'submit_verification', method: 'POST', path: '/verification/cases', tag: TAG, status: 201,
  summary: 'Raise a verification case with the platform team for yourself (gamer / coach / physio / doctor), or for a sponsor or event you own. Attach the evidence the rules require; files and references are encrypted and only the review team can read them. A badge that is about to expire (30 days) or has expired can be renewed the same way.',
  input: z.object({ type: z.enum(TYPES), subject_id: id.optional().describe('sponsor or event id; omit for yourself'), sport: id.optional().describe('sport id the claim is about'), claim_note: z.string().max(1000).optional(), evidence: z.array(evidenceIn).min(1).max(MAX_EVIDENCE) }),
  async handler({ user }, i) {
    const subject = await resolveSubject(user, i.type, i.subject_id);
    const missing = missingEvidence(i.type, i.evidence.map((e) => e.kind));
    if (missing.length) throw badRequest(`Evidence still needed: ${missing.join('; ')}`, { missing });
    const prepared = i.evidence.map(prepEvidence);
    return tx(async (c) => {
      const prev = (await c.query(`SELECT id, status, expires_at FROM verification_cases WHERE type=$1 AND subject_id=$2 ORDER BY submitted_at DESC LIMIT 1`, [i.type, subject.id])).rows[0];
      if (prev && OPEN.includes(prev.status)) throw conflict('There is already an open verification case for this. Add evidence to it or withdraw it first.');
      if (prev?.status === 'approved' && prev.expires_at > new Date(Date.now() + RENEW_WINDOW_DAYS * 864e5)) throw conflict('This is already verified. You can renew within 30 days of expiry.');
      const row = (await c.query(
        `INSERT INTO verification_cases(type, subject_type, subject_id, sport_id, requested_by, claim_note, rules_version, previous_case_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, case_no, type, subject_type, subject_id, status, submitted_at`,
        [i.type, RULES[i.type].subject, subject.id, i.sport ?? null, user.id, i.claim_note ?? null, RULES_VERSION, prev?.id ?? null])).rows[0];
      for (const p of prepared) await insertEvidence(c, row.id, user.id, p);
      await logEvent(c, row.id, user.id, 'submit', null, 'submitted', i.claim_note);
      for (const a of await adminIds(c)) await notify(c, a, { kind: 'verification_submitted', title: `Verification case #${row.case_no}`, body: `${user.display_name} asked for ${RULES[i.type].label} (${subject.name}).`, data: { case_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'add_verification_evidence', method: 'POST', path: '/verification/cases/:id/evidence', tag: TAG, status: 201,
  summary: 'Add more evidence to your open case (for example after the reviewer asked for more information).',
  input: z.object({ id, evidence: z.array(evidenceIn).min(1).max(MAX_EVIDENCE) }),
  async handler({ user }, i) {
    const prepared = i.evidence.map(prepEvidence);
    return tx(async (c) => {
      const row = await lockCase(c, i.id);
      if (row.requested_by !== user.id) throw notFound('Verification case');
      if (!['submitted', 'needs_info'].includes(row.status)) throw conflict('Evidence can only be added while the case is waiting for you or for a reviewer');
      const n = (await c.query('SELECT count(*)::int AS n FROM verification_evidence WHERE case_id=$1', [row.id])).rows[0].n;
      if (n + prepared.length > 25) throw conflict('Too much evidence on one case');
      for (const p of prepared) await insertEvidence(c, row.id, user.id, p);
      await logEvent(c, row.id, user.id, 'add_evidence', row.status, row.status, `${prepared.length} item(s)`);
      return { ok: true, added: prepared.length };
    });
  },
});

cap({
  name: 'resubmit_verification', method: 'POST', path: '/verification/cases/:id/resubmit', tag: TAG,
  summary: 'Send a case back to the review queue after supplying what the reviewer asked for.',
  input: z.object({ id, note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await lockCase(c, i.id);
      if (row.requested_by !== user.id) throw notFound('Verification case');
      if (row.status !== 'needs_info') throw conflict('Only a case waiting for more information can be resubmitted');
      const missing = missingEvidence(row.type, await evidenceKinds(c, row.id));
      if (missing.length) throw badRequest(`Evidence still needed: ${missing.join('; ')}`, { missing });
      await c.query("UPDATE verification_cases SET status='submitted', updated_at=now() WHERE id=$1", [row.id]);
      await logEvent(c, row.id, user.id, 'resubmit', 'needs_info', 'submitted', i.note);
      return { id: row.id, status: 'submitted' };
    });
  },
});

cap({
  name: 'withdraw_verification', method: 'POST', path: '/verification/cases/:id/withdraw', tag: TAG,
  summary: 'Withdraw your open verification case. The case and its history are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await lockCase(c, i.id);
      if (row.requested_by !== user.id) throw notFound('Verification case');
      if (!OPEN.includes(row.status)) throw conflict('Only an open case can be withdrawn');
      await c.query("UPDATE verification_cases SET status='withdrawn', updated_at=now() WHERE id=$1", [row.id]);
      await logEvent(c, row.id, user.id, 'withdraw', row.status, 'withdrawn');
      return { id: row.id, status: 'withdrawn' };
    });
  },
});

cap({
  name: 'list_my_verifications', method: 'GET', path: '/me/verifications', tag: TAG,
  summary: 'Your verification cases (newest first) with their current state; approved ones past their expiry show as `expired`.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(`SELECT ${CASE_COLS}, coalesce(s.name, e.name, u.display_name) AS subject_name FROM verification_cases c
      LEFT JOIN sponsors s ON c.subject_type='sponsor' AND s.id=c.subject_id LEFT JOIN events e ON c.subject_type='event' AND e.id=c.subject_id LEFT JOIN users u ON c.subject_type='user' AND u.id=c.subject_id
     WHERE c.requested_by=$1 ORDER BY c.submitted_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'get_verification', method: 'GET', path: '/verification/cases/:id', tag: TAG,
  summary: 'One case: state, reviewer checklist, history and evidence metadata (never the evidence itself). Requester or platform team.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one(`SELECT ${CASE_COLS}, c.checklist FROM verification_cases c WHERE c.id=$1`, [i.id]);
    if (!row || !canSee(user, row)) throw notFound('Verification case');
    const [evidence, history] = await Promise.all([
      many('SELECT id, kind, label, file_name, content_type, size_bytes, created_at, (reference_enc IS NOT NULL) AS has_reference FROM verification_evidence WHERE case_id=$1 ORDER BY created_at', [i.id]),
      many('SELECT e.action, e.from_status, e.to_status, e.reason, e.created_at, u.display_name AS actor FROM verification_events e JOIN users u ON u.id=e.actor_id WHERE e.case_id=$1 ORDER BY e.created_at, e.id', [i.id]),
    ]);
    return { ...row, label: RULES[row.type].label, checklist_template: RULES[row.type].checklist, evidence, history };
  },
});

// ------------------------------------------------------------------ public badge
cap({
  name: 'get_verification_badge', method: 'GET', path: '/verification/badge', tag: TAG, auth: 'public',
  summary: 'Public verification badge for a person, sponsor or event: just the verified types and expiry — never evidence or case details.',
  input: z.object({ subject_type: z.enum(['user', 'sponsor', 'event']), subject_id: id }),
  async handler(_, i) {
    const badges = (await badgesFor(i.subject_type, [i.subject_id])).get(i.subject_id) ?? [];
    return { subject_type: i.subject_type, subject_id: i.subject_id, verified: badges.length > 0, badges };
  },
});

// ------------------------------------------------------------------ platform team
cap({
  name: 'list_verification_queue', method: 'GET', path: '/admin/verification/cases', tag: TAG, auth: ['admin'],
  summary: 'Platform team: verification cases, oldest first. Filter by status (`expired` = approved but past expiry) and type.',
  input: z.object({ status: z.enum(['submitted', 'in_review', 'needs_info', 'approved', 'rejected', 'revoked', 'withdrawn', 'expired', 'open']).default('open'), type: z.enum(TYPES).optional(), mine: z.coerce.boolean().optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT * FROM (SELECT ${CASE_COLS}, coalesce(s.name, e.name, u.display_name) AS subject_name, r.display_name AS requester, (SELECT count(*)::int FROM verification_evidence v WHERE v.case_id=c.id) AS evidence_count
        FROM verification_cases c JOIN users r ON r.id=c.requested_by
        LEFT JOIN sponsors s ON c.subject_type='sponsor' AND s.id=c.subject_id LEFT JOIN events e ON c.subject_type='event' AND e.id=c.subject_id LEFT JOIN users u ON c.subject_type='user' AND u.id=c.subject_id
       WHERE ($2::text IS NULL OR c.type=$2) AND (NOT $3 OR c.reviewer_id=$4)) q
      WHERE ($1 = 'open' AND q.status IN ('submitted','in_review','needs_info')) OR q.status = $1 ORDER BY submitted_at LIMIT $5 OFFSET $6`,
    [i.status, i.type ?? null, !!i.mine, user.id, i.limit, i.offset]),
});

cap({
  name: 'claim_verification', method: 'POST', path: '/admin/verification/cases/:id/claim', tag: TAG, auth: ['admin'],
  summary: 'Platform team: take a submitted case for review. You cannot review your own request.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await lockCase(c, i.id);
      if (row.requested_by === user.id) throw forbidden('Another platform team member must review your own request');
      if (row.status !== 'submitted') throw conflict(`Case is ${row.status}; only submitted cases can be claimed`);
      await c.query("UPDATE verification_cases SET status='in_review', reviewer_id=$2, updated_at=now() WHERE id=$1", [row.id, user.id]);
      await logEvent(c, row.id, user.id, 'claim', 'submitted', 'in_review');
      return { id: row.id, status: 'in_review', reviewer_id: user.id };
    });
  },
});

cap({
  name: 'get_verification_evidence', method: 'GET', path: '/admin/verification/cases/:id/evidence', tag: TAG, auth: ['admin'],
  summary: 'Platform team: decrypted evidence references and files for a case. Every read is audit-logged. You cannot read evidence on your own request.',
  input: z.object({ id, evidence_id: id.optional().describe('include the file contents of this item (base64)') }),
  async handler({ user }, i) {
    const cs = await one('SELECT id, requested_by FROM verification_cases WHERE id=$1', [i.id]);
    if (!cs) throw notFound('Verification case');
    if (cs.requested_by === user.id) throw forbidden('Another platform team member must review your own request');
    const rows = await many('SELECT id, kind, label, reference_enc, file_name, content_type, size_bytes, sha256, created_at, file_enc FROM verification_evidence WHERE case_id=$1 ORDER BY created_at', [i.id]);
    await audit(null, user.id, 'read_verification_evidence', 'verification_cases', i.id);
    return rows.map((r) => ({
      id: r.id, kind: r.kind, label: r.label, reference: decrypt(r.reference_enc, 'verification_evidence.reference'),
      file_name: r.file_name, content_type: r.content_type, size_bytes: r.size_bytes, sha256: r.sha256, created_at: r.created_at,
      ...(i.evidence_id === r.id && r.file_enc ? { data: decrypt(r.file_enc, 'verification_evidence.file') } : {}),
    }));
  },
});

cap({
  name: 'decide_verification', method: 'POST', path: '/admin/verification/cases/:id/decision', tag: TAG, auth: ['admin'],
  summary: 'Platform team: decide a case you claimed. `approve` needs every checklist item ticked and the required evidence on file, and starts the badge validity; `reject` and `needs_info` need a reason the requester will see.',
  input: z.object({
    id, decision: z.enum(['approve', 'reject', 'needs_info']),
    checklist: z.array(z.object({ key: z.string(), ok: z.boolean(), note: z.string().max(300).optional() })).default([]),
    reason: z.string().min(5).max(1000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await lockCase(c, i.id);
      if (row.requested_by === user.id) throw forbidden('Another platform team member must review your own request');
      if (row.status !== 'in_review') throw conflict(`Case is ${row.status}; claim it first`);
      if (row.reviewer_id !== user.id) throw forbidden('This case is being reviewed by someone else');
      const rule = RULES[row.type];
      const answers = new Map(i.checklist.map((x) => [x.key, x]));
      const unknown = i.checklist.filter((x) => !rule.checklist.some((t) => t.key === x.key));
      if (unknown.length) throw badRequest(`Unknown checklist item: ${unknown[0].key}`);
      if (i.decision !== 'approve' && !i.reason) throw badRequest('A reason is required');
      let to, expires = null;
      if (i.decision === 'approve') {
        const open = rule.checklist.filter((t) => !answers.get(t.key)?.ok);
        if (open.length) throw badRequest(`Checklist not complete: ${open.map((t) => t.label).join('; ')}`);
        const missing = missingEvidence(row.type, await evidenceKinds(c, row.id));
        if (missing.length) throw badRequest(`Required evidence is missing: ${missing.join('; ')}`);
        to = 'approved';
        expires = new Date(Date.now() + rule.validity_months * 30.44 * 864e5);
      } else to = i.decision === 'reject' ? 'rejected' : 'needs_info';
      await c.query('UPDATE verification_cases SET status=$2, checklist=$3, decision_reason=$4, decided_at=now(), expires_at=$5, updated_at=now() WHERE id=$1', [row.id, to, JSON.stringify(i.checklist), i.reason ?? null, expires]);
      await logEvent(c, row.id, user.id, i.decision, 'in_review', to, i.reason);
      const label = rule.label;
      await notify(c, row.requested_by, {
        kind: 'verification_decision', data: { case_id: row.id },
        title: to === 'approved' ? `${label} badge approved` : to === 'rejected' ? `${label} request declined` : `More information needed for ${label}`,
        body: to === 'approved' ? `Your badge is valid until ${expires.toISOString().slice(0, 10)}.` : i.reason,
      });
      return { id: row.id, status: to, expires_at: expires };
    });
  },
});

cap({
  name: 'revoke_verification', method: 'POST', path: '/admin/verification/cases/:id/revoke', tag: TAG, auth: ['admin'],
  summary: 'Platform team: withdraw an approved badge immediately (for example fraud or a lapsed licence). A reason is required; history is kept and the owner can submit a new case.',
  input: z.object({ id, reason: z.string().min(5).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await lockCase(c, i.id);
      if (row.status !== 'approved') throw conflict('Only an approved badge can be revoked');
      await c.query("UPDATE verification_cases SET status='revoked', decision_reason=$2, updated_at=now() WHERE id=$1", [row.id, i.reason]);
      await logEvent(c, row.id, user.id, 'revoke', 'approved', 'revoked', i.reason);
      await notify(c, row.requested_by, { kind: 'verification_decision', title: `${RULES[row.type].label} badge revoked`, body: i.reason, data: { case_id: row.id } });
      return { id: row.id, status: 'revoked' };
    });
  },
});
