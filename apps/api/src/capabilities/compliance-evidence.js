// Compliance engine, part 2 (#568): evidence and exceptions. Evidence the engine owns (permits, declarations, training, background-check status,
// approvals) is filed against a holder and reviewed by a person; licences, supplier credentials and guardian consent stay in their own modules and
// are read live. An uploaded document is only ever "submitted" until a human verifies it; the engine never promotes it by itself.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { orgRole } from '../org-access.js';
import { EVIDENCE_KINDS, HOLDERS } from '../compliance/engine.js';
import { manages, mayReview, mayView } from '../compliance/service.js';
import { isOrganiser } from './event-departments.js';

const TAG = 'Compliance';
const text = (min, max) => z.string().trim().min(min).max(max);
const date = z.string().date();
const REF = 'cmp_evidence.reference', NOTE = 'cmp_evidence.note', REASON = 'cmp_exceptions.reason';
const COLS = `e.id, e.holder_type, e.holder_id, e.context_event_id, e.kind, e.requirement_key, e.title, e.issuer, e.document_ref, e.issued_on::text AS issued_on, e.valid_from::text AS valid_from, e.valid_to::text AS valid_to,
  e.status, e.submitted_by, e.submitted_at, e.reviewed_by, e.reviewed_at, e.verified_what, e.supersedes_id, e.reference_enc`;

async function eventRow(c, eventId) {
  const e = (await (c ?? pool).query('SELECT id, name, organizer_id, organisation_id FROM events WHERE id=$1', [eventId])).rows[0];
  if (!e) throw notFound('Event');
  return e;
}
/** The reference number is shown only to the holder's side and to reviewers, and every reveal is logged. */
async function shape(c, user, rows) {
  const out = [];
  let revealed = 0;
  for (const { reference_enc, ...r } of rows) {
    const reveal = reference_enc && (await manages(c, user, r.holder_type, r.holder_id) || await mayReview(c, user, { ...r }));
    if (reveal) revealed += 1;
    out.push({ ...r, reference: reveal ? decrypt(reference_enc, REF) : null, has_reference: !!reference_enc });
  }
  if (revealed) await audit(c, user.id, 'read_compliance_reference', 'cmp_evidence', null);
  return out;
}

cap({
  name: 'submit_compliance_evidence', method: 'POST', path: '/compliance/evidence', tag: TAG, status: 201,
  summary: 'File evidence for a person, organisation, event, venue, tender or supplier: a licence, permit, declaration, certificate, training record, insurance, background-check status, signed document or approval. Give event_id to file it for one event (its organiser reviews it and it counts only there); leave it out for evidence the platform team reviews and that counts everywhere. The number is encrypted. A declaration is the holder\'s own statement and counts as declared; everything else waits for a reviewer, because an uploaded document alone is never proof of compliance.',
  input: z.object({
    holder_type: z.enum(HOLDERS), holder_id: id, event_id: id.optional(), kind: z.enum(EVIDENCE_KINDS), requirement_key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,59}$/).optional(),
    title: text(3, 140), issuer: text(1, 140).optional(), reference: text(2, 80).optional(), document_ref: text(2, 300).optional(),
    issued_on: date.optional(), valid_from: date.optional(), valid_to: date.optional(), replaces_id: id.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    if (!(await manages(c, user, i.holder_type, i.holder_id))) throw notFound('Holder');
    if (i.valid_from && i.valid_to && i.valid_to < i.valid_from) throw badRequest('valid_to is before valid_from');
    const ev = i.event_id ? await eventRow(c, i.event_id) : null;
    if (i.replaces_id && !(await c.query('SELECT 1 FROM cmp_evidence WHERE id=$1 AND holder_type=$2 AND holder_id=$3', [i.replaces_id, i.holder_type, i.holder_id])).rowCount) throw badRequest('That evidence belongs to a different holder');
    const declared = i.kind === 'declaration';
    const row = (await c.query(
      `INSERT INTO cmp_evidence(holder_type, holder_id, context_event_id, kind, requirement_key, title, issuer, reference_enc, document_ref, issued_on, valid_from, valid_to, supersedes_id, submitted_by, status, reviewed_at, verified_what)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, status, kind, title, holder_type, holder_id, context_event_id`,
      [i.holder_type, i.holder_id, i.event_id ?? null, i.kind, i.requirement_key ?? null, i.title, i.issuer ?? null, i.reference ? encrypt(i.reference, REF) : null, i.document_ref ?? null, i.issued_on ?? null, i.valid_from ?? null, i.valid_to ?? null,
        i.replaces_id ?? null, user.id, declared ? 'verified' : 'submitted', declared ? new Date() : null, declared ? 'Declared by the holder; not independently checked' : null])).rows[0];
    await audit(c, user.id, 'compliance_evidence_submitted', 'cmp_evidence', row.id);
    if (ev && !declared && ev.organizer_id !== user.id) await notify(c, ev.organizer_id, { kind: 'compliance', title: 'Evidence waiting for your review', body: `${i.title} for ${ev.name}`, data: { event_id: ev.id, compliance: true } });
    return row;
  }),
});

cap({
  name: 'list_compliance_evidence', method: 'GET', path: '/compliance/evidence', tag: TAG,
  summary: 'Evidence filed for a holder, with its status and validity. Use expiring_in_days to see what lapses soon. Reference numbers are shown only to the holder\'s side and to reviewers (logged).',
  input: z.object({ holder_type: z.enum(HOLDERS), holder_id: id, event_id: id.optional(), status: z.enum(['submitted', 'verified', 'rejected', 'revoked']).optional(), expiring_in_days: z.coerce.number().int().min(1).max(365).optional(), ...page }),
  async handler({ user }, i) {
    if (!(await mayView(null, user, i.holder_type, i.holder_id, { event_id: i.event_id, tender_id: undefined }))) throw notFound('Holder');
    const rows = await many(
      `SELECT ${COLS} FROM cmp_evidence e WHERE e.holder_type=$1 AND e.holder_id=$2 AND ($3::uuid IS NULL OR e.context_event_id IS NULL OR e.context_event_id=$3)
          AND ($4::text IS NULL OR e.status=$4) AND ($5::int IS NULL OR (e.status='verified' AND e.valid_to IS NOT NULL AND e.valid_to <= current_date + $5::int))
        ORDER BY e.submitted_at DESC, e.id LIMIT $6 OFFSET $7`, [i.holder_type, i.holder_id, i.event_id ?? null, i.status ?? null, i.expiring_in_days ?? null, i.limit, i.offset]);
    return shape(null, user, rows);
  },
});

cap({
  name: 'list_compliance_review_queue', method: 'GET', path: '/compliance/review-queue', tag: TAG,
  summary: 'Evidence waiting for a reviewer. With event_id: the organiser\'s queue for that event. Without: the platform team\'s queue of evidence that counts everywhere.',
  input: z.object({ event_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (i.event_id) { const e = await eventRow(null, i.event_id); if (!(await isOrganiser(user, e, pool))) throw notFound('Event'); }
    else if (!isAdmin(user)) throw notFound('Queue');
    const rows = await many(
      `SELECT ${COLS}, u.display_name AS submitted_by_name FROM cmp_evidence e JOIN users u ON u.id=e.submitted_by
        WHERE e.status='submitted' AND ${i.event_id ? 'e.context_event_id=$1' : '$1::uuid IS NULL AND e.context_event_id IS NULL'} ORDER BY e.submitted_at, e.id LIMIT $2 OFFSET $3`, [i.event_id ?? null, i.limit, i.offset]);
    return shape(null, user, rows);
  },
});

cap({
  name: 'review_compliance_evidence', method: 'POST', path: '/compliance/evidence/:id/review', tag: TAG,
  summary: 'Verify, reject or revoke evidence. Verifying needs a statement of what you actually checked. The reviewer is the event\'s organiser (for evidence filed for that event) or the platform team (for evidence that counts everywhere), and is never the person who filed it. Reviewed evidence is never edited: a correction is a new submission.',
  input: z.object({ id, decision: z.enum(['verify', 'reject', 'revoke']), verified_what: text(5, 300).optional(), note: text(1, 500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const e = (await c.query('SELECT * FROM cmp_evidence WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!e) throw notFound('Evidence');
    if (!(await mayReview(c, user, e))) throw notFound('Evidence');
    if (i.decision === 'verify' && !i.verified_what) throw badRequest('Say what you checked (for example "original permit seen, number matches the municipal register")');
    if (i.decision === 'reject' && !i.note) throw badRequest('Say why it is rejected');
    const from = { verify: 'submitted', reject: 'submitted', revoke: 'verified' }[i.decision];
    if (e.status !== from) throw conflict(`This evidence is ${e.status}`);
    const to = { verify: 'verified', reject: 'rejected', revoke: 'revoked' }[i.decision];
    const r = (await c.query('UPDATE cmp_evidence SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note_enc=$4, verified_what=coalesce($5, verified_what) WHERE id=$1 RETURNING id, status, reviewed_at',
      [i.id, to, user.id, i.note ? encrypt(i.note, NOTE) : null, i.verified_what ?? null])).rows[0];
    await audit(c, user.id, `compliance_evidence_${to}`, 'cmp_evidence', i.id);
    if (e.holder_type === 'person' && e.holder_id !== user.id) await notify(c, e.holder_id, { kind: 'compliance', title: `Your ${e.kind.replace(/_/g, ' ')} was ${to}`, body: e.title, data: { evidence_id: e.id } });
    return r;
  }),
});

// ------------------------------------------------------------------ exceptions (the human override)
/** Who may waive a rule: for an organisation's rule an owner/admin of it; for a platform rule (only ever a recommended standard) the organiser of the event concerned. Nobody waives their own. */
async function mayWaive(c, user, rule, holder_type, holder_id, event_id) {
  if (holder_type === 'person' && holder_id === user.id) return false;
  if (rule.scope_kind === 'organisation') return ['owner', 'admin'].includes(await orgRole(user, rule.organisation_id, c ?? pool));
  if (event_id) return isOrganiser(user, await eventRow(c, event_id), c ?? pool);
  return isAdmin(user);
}

cap({
  name: 'grant_compliance_exception', method: 'POST', path: '/compliance/exceptions', tag: TAG, status: 201,
  summary: 'Waive one waivable rule for one holder for a limited time (at most a year), with a reason. Laws and regulations can never be waived. The exception sits beside the rule and the evidence, changes neither, shows in every decision that relies on it, and can be revoked. You cannot waive a rule for yourself.',
  input: z.object({ rule_id: id, holder_type: z.enum(HOLDERS), holder_id: id, event_id: id.optional(), reason: text(10, 1000), valid_to: z.string().datetime({ offset: true }) }),
  handler: ({ user }, i) => tx(async (c) => {
    const rule = (await c.query('SELECT * FROM cmp_rules WHERE id=$1', [i.rule_id])).rows[0];
    if (!rule) throw notFound('Rule');
    const v = (await c.query("SELECT waivable FROM cmp_rule_versions WHERE rule_id=$1 AND status='approved' AND effective_from <= current_date ORDER BY version DESC LIMIT 1", [i.rule_id])).rows[0];
    if (!v?.waivable) throw conflict('This rule cannot be waived', { code: 'not_waivable' });
    if (!(await mayWaive(c, user, rule, i.holder_type, i.holder_id, i.event_id))) throw forbidden('You cannot waive this rule for this holder');
    const to = new Date(i.valid_to), now = new Date();
    if (!(to > now)) throw badRequest('The exception ends in the past');
    if (to.getTime() - now.getTime() > 366 * 864e5) throw badRequest('An exception lasts at most a year; renew it if it is still needed');
    const row = (await c.query(
      `INSERT INTO cmp_exceptions(rule_id, holder_type, holder_id, context_event_id, reason_enc, granted_by, valid_to) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, rule_id, holder_type, holder_id, valid_from, valid_to`,
      [i.rule_id, i.holder_type, i.holder_id, i.event_id ?? null, encrypt(i.reason, REASON), user.id, to])).rows[0];
    await audit(c, user.id, 'compliance_exception_granted', 'cmp_exceptions', row.id);
    if (i.holder_type === 'person') await notify(c, i.holder_id, { kind: 'compliance', title: 'An exception was recorded for you', body: 'A rule was waived for a limited time.', data: { exception_id: row.id } });
    return row;
  }),
});

cap({
  name: 'revoke_compliance_exception', method: 'POST', path: '/compliance/exceptions/:id/revoke', tag: TAG,
  summary: 'Revoke an exception with a reason. Decisions already recorded keep the exception they relied on; later checks no longer see the waiver.',
  input: z.object({ id, reason: text(5, 500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const x = (await c.query('SELECT x.*, r.scope_kind, r.organisation_id FROM cmp_exceptions x JOIN cmp_rules r ON r.id=x.rule_id WHERE x.id=$1 FOR UPDATE OF x', [i.id])).rows[0];
    if (!x || !(await mayWaive(c, user, x, x.holder_type, x.holder_id, x.context_event_id))) throw notFound('Exception');
    if (x.revoked_at) throw conflict('Already revoked');
    const r = (await c.query('UPDATE cmp_exceptions SET revoked_at=now(), revoked_by=$2, revoke_reason_enc=$3 WHERE id=$1 RETURNING id, revoked_at', [i.id, user.id, encrypt(i.reason, REASON)])).rows[0];
    await audit(c, user.id, 'compliance_exception_revoked', 'cmp_exceptions', i.id);
    return r;
  }),
});

cap({
  name: 'list_compliance_exceptions', method: 'GET', path: '/compliance/exceptions', tag: TAG,
  summary: 'Exceptions recorded for a holder, newest first, with who granted them and the period. The reason is shown to those who can grant or revoke (logged).',
  input: z.object({ holder_type: z.enum(HOLDERS), holder_id: id, event_id: id.optional(), active: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    if (!(await mayView(null, user, i.holder_type, i.holder_id, { event_id: i.event_id }))) throw notFound('Holder');
    const rows = await many(
      `SELECT x.id, x.rule_id, r.key AS rule_key, x.holder_type, x.holder_id, x.context_event_id, x.reason_enc, x.granted_by, g.display_name AS granted_by_name, x.valid_from, x.valid_to, x.revoked_at,
              r.scope_kind, r.organisation_id, (x.revoked_at IS NULL AND x.valid_from <= now() AND x.valid_to > now()) AS in_force
         FROM cmp_exceptions x JOIN cmp_rules r ON r.id=x.rule_id JOIN users g ON g.id=x.granted_by
        WHERE x.holder_type=$1 AND x.holder_id=$2 ${i.active ? 'AND x.revoked_at IS NULL AND x.valid_from <= now() AND x.valid_to > now()' : ''} ORDER BY x.created_at DESC LIMIT $3 OFFSET $4`, [i.holder_type, i.holder_id, i.limit, i.offset]);
    const out = [];
    let shown = 0;
    for (const { reason_enc, scope_kind, organisation_id, ...x } of rows) {
      const may = await mayWaive(null, user, { scope_kind, organisation_id }, x.holder_type, x.holder_id, x.context_event_id).catch(() => false);
      if (may) shown += 1;
      out.push({ ...x, reason: may ? decrypt(reason_enc, REASON) : null });
    }
    if (shown) await audit(null, user.id, 'read_compliance_exception_reason', 'cmp_exceptions', null);
    return out;
  },
});
