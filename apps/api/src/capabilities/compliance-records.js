// Compliance, safeguarding & eligibility (#595), part 2: the evidence people provide and reviewers decide, declarations and acknowledgements, time-boxed
// waivers, and evidence packs for an authorised reviewer. References and free text are AES-256-GCM encrypted (`*_enc`); a reference is shown only to the
// holder or guardian (and, for ordinary documents, to the managers of the scope, audit-logged); a background check keeps only clear / not clear / pending.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { guardiansOf } from '../youth.js';
import {
  CATEGORIES, SCOPES, SUBJECTS, addDays, applicable, evaluateSubject, holderAccess, managerIds, manages, nameFor, reveal, scopeName, subjectsInScope,
  NEVER_WAIVABLE_CLASSES,
} from '../compliance.js';
import { tenderForcing } from '../compliance-gates.js';
import { TAG, log, loadRequirement } from './compliance.js';

const day = z.string().date();
const text = (n) => z.string().trim().max(n);
const today = async (c = pool) => (await c.query('SELECT current_date::text AS d')).rows[0].d;

const viewRecord = (r) => ({
  id: r.id, requirement_id: r.requirement_id, requirement_version: r.requirement_version, subject: { kind: r.subject_kind, id: r.subject_id }, status: r.status, outcome: r.outcome,
  issued_on: r.issued_on, expires_on: r.expires_on, provider: r.provider, has_reference: !!r.reference_enc || !!r.has_reference, has_detail: !!r.detail_enc || !!r.has_detail, statement_version: r.statement_version,
  submitted_at: r.submitted_at, decided_at: r.decided_at, previous_id: r.previous_id, row_version: r.row_version,
});
const COLS = "id, requirement_id, requirement_version, subject_kind, subject_id, status, outcome, issued_on::text AS issued_on, expires_on::text AS expires_on, provider, (reference_enc IS NOT NULL) AS has_reference, (detail_enc IS NOT NULL) AS has_detail, statement_version, submitted_by, submitted_at, decided_by, decided_at, decision_reason, previous_id, row_version";

const fresh = async (c, rid) => viewRecord((await c.query(`SELECT ${COLS} FROM comp_records WHERE id=$1`, [rid])).rows[0]);

/** Who hears about something on a subject: a person (and their guardians if young), or the managers of an organisation / event. */
async function holders(c, subjectKind, subjectId) {
  if (subjectKind === 'person') return [subjectId, ...await guardiansOf(subjectId, c)];
  if (subjectKind === 'organisation') return managerIds(c, 'organisation', subjectId);
  return managerIds(c, 'event', subjectId);
}

// ---------------------------------------------------------------- submit
cap({
  name: 'submit_compliance_record', method: 'POST', path: '/compliance/records', tag: TAG, status: 201,
  summary: 'Provide what a requirement asks for. Evidence (a certificate, a background-check status reference, training, a permit, insurance, a licence) is submitted with an issue date, an expiry (or validity from the requirement) and a reference, and waits for a reviewer. A declaration, conflict-of-interest declaration, safeguarding acknowledgement or attestation is made with confirm=true against the exact statement of the current version and is recorded straight away. Renewing while a current record exists keeps the old one valid until the renewal is approved. Requirements checked from an existing verification, licence or credential cannot be submitted here. The holder, a verified guardian of a young person, an organisation\'s owner/admin or an event\'s organiser can submit.',
  input: z.object({
    requirement_id: id, subject_kind: z.enum(SUBJECTS).default('person'), subject_id: id.optional(), issued_on: day.optional(), expires_on: day.optional(),
    provider: text(120).optional(), reference: text(200).optional(), detail: text(2000).optional(), confirm: z.boolean().optional(), statement_version: z.number().int().min(1).optional(),
    tender_id: id.optional(),   // a supplier answering the buyer's rule inside a tender it takes part in
  }),
  async handler({ user }, i) {
    const sid = i.subject_id ?? (i.subject_kind === 'person' ? user.id : null);
    if (!sid) throw badRequest('Say which organisation or event this is for');
    const access = await holderAccess(user, i.subject_kind, sid);
    if (!access) throw notFound(i.subject_kind === 'person' ? 'Person' : i.subject_kind === 'organisation' ? 'Organisation' : 'Event');
    const req = await loadRequirement(i.requirement_id);
    if (req.subject_kind !== i.subject_kind) throw badRequest(`This requirement is for ${req.subject_kind === 'person' ? 'people' : `${req.subject_kind}s`}`);
    if (req.method === 'linked') throw conflict('This is checked from an existing record, so there is nothing to submit here. Update that record and it counts automatically.', { code: 'linked_requirement', source: req.source });
    const subject = { kind: i.subject_kind, id: sid };
    const tf = i.tender_id ? await tenderForcing(pool, i.tender_id, subject) : null;
    if (i.tender_id && !tf) throw notFound('Tender');
    if (!(await applicable(pool, subject, { scope: { kind: req.scope_kind, id: req.scope_id }, ...(tf ? { context: tf.ctx, forced: tf.forced, forcedRoles: tf.forcedRoles } : {}) })).some((o) => o.id === req.id)) throw conflict('This requirement does not apply to them', { code: 'not_required' });

    const t = await today();
    let issued = i.issued_on ?? t, expires = i.expires_on ?? null, reference = null, detail = null, stmt = null, status = 'submitted', outcome = null;
    if (req.method === 'declaration') {
      if (i.confirm !== true) throw badRequest('Confirm that you have read and agree to the statement');
      if (i.statement_version && i.statement_version !== req.version) throw conflict('The statement has changed since you opened it. Read the current version and confirm again.', { code: 'statement_changed' });
      stmt = req.version; issued = t; status = 'valid';
      if (req.category === 'conflict_of_interest') detail = i.detail ?? null;
      expires = req.validity_days ? addDays(t, req.validity_days) : null;
    } else {
      if (!i.reference) throw badRequest('Add the certificate, check, permit or policy reference');
      if (issued > t) throw badRequest('The issue date cannot be in the future');
      if (!expires && req.validity_days) expires = addDays(issued, req.validity_days);
      if (expires && expires < t) throw badRequest('That has already expired. Submit a current one.');
      if (expires && expires <= issued) throw badRequest('The expiry must be after the issue date');
      reference = i.reference;
      detail = i.detail ?? null;
      if (req.category === 'background_check') outcome = 'pending';
      if (!req.requires_review) { status = 'valid'; if (req.category === 'background_check') outcome = null; }
    }
    return tx(async (c) => {
      const prior = (await c.query("SELECT id, status FROM comp_records WHERE requirement_id=$1 AND subject_kind=$2 AND subject_id=$3 AND status IN ('submitted','valid') ORDER BY (status='submitted') DESC, expires_on DESC NULLS FIRST LIMIT 1 FOR UPDATE", [req.id, subject.kind, subject.id])).rows[0];
      if (prior?.status === 'submitted') throw conflict('There is already a submission waiting for review', { code: 'already_submitted', record_id: prior.id });
      const row = (await c.query(
        `INSERT INTO comp_records(requirement_id, requirement_version, subject_kind, subject_id, status, outcome, issued_on, expires_on, provider, reference_enc, detail_enc, statement_version, submitted_by, previous_id, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $5='valid' THEN now() END) RETURNING *`,
        [req.id, req.version, subject.kind, subject.id, status, outcome, issued, expires, i.provider ?? null, encrypt(reference, 'comp_records.reference'), encrypt(detail, 'comp_records.detail'), stmt, user.id, prior?.id ?? null])).rows[0];
      if (status === 'valid' && prior) await c.query("UPDATE comp_records SET status='superseded', updated_at=now() WHERE id=$1 AND status='valid'", [prior.id]);
      await log(c, { requirement_id: req.id, record_id: row.id, subject_kind: subject.kind, subject_id: subject.id, actor_id: user.id, action: status === 'valid' ? (req.method === 'declaration' ? 'declared' : 'recorded') : 'submitted', detail: { version: req.version, renewal: !!prior } });
      if (status === 'submitted') {
        for (const m of await managerIds(c, req.scope_kind, req.scope_id)) {
          if (m === user.id) continue;
          await notify(c, m, { kind: 'compliance_review', title: 'Compliance evidence to review', body: `${req.name} has been submitted. Open Compliance to review it.`, data: { record_id: row.id, requirement_id: req.id }, dedupe_key: `comp-review:${row.id}:${m}` });
        }
      }
      return fresh(c, row.id);
    });
  },
});

cap({
  name: 'withdraw_compliance_record', method: 'POST', path: '/compliance/records/:id/withdraw', tag: TAG,
  summary: 'Withdraw a submission that is still waiting for review (the holder, a guardian, or the organisation / event manager who submitted it). Nothing is deleted; it stays in the history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT * FROM comp_records WHERE id=$1', [i.id]);
    if (!r || !(await holderAccess(user, r.subject_kind, r.subject_id))) throw notFound('Record');
    if (r.status !== 'submitted') throw conflict('Only a submission that is waiting for review can be withdrawn');
    return tx(async (c) => {
      const row = (await c.query("UPDATE comp_records SET status='withdrawn', updated_at=now(), row_version=row_version+1 WHERE id=$1 AND status='submitted' RETURNING *", [i.id])).rows[0];
      if (!row) throw conflict('That submission has just been decided');
      await log(c, { requirement_id: r.requirement_id, record_id: r.id, subject_kind: r.subject_kind, subject_id: r.subject_id, actor_id: user.id, action: 'withdrawn' });
      return fresh(c, row.id);
    });
  },
});

// ---------------------------------------------------------------- review
cap({
  name: 'list_compliance_records', method: 'GET', path: '/compliance/records', tag: TAG,
  summary: 'Records, without references. Give a subject (yours, one you are guardian of, or your organisation / event) to see everything provided for it, or a scope you run with status=submitted to get its review queue (oldest first). Each record names its requirement, validity and status; a background check shows only its outcome.',
  input: z.object({ subject_kind: z.enum(SUBJECTS).optional(), subject_id: id.optional(), scope_kind: z.enum(SCOPES).optional(), scope_id: id.optional(), status: z.enum(['submitted', 'valid', 'rejected', 'revoked', 'withdrawn', 'superseded']).optional(), ...page }),
  async handler({ user }, i) {
    let where = [], p = [];
    const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (i.scope_kind) {
      if (!(await manages(user, i.scope_kind, i.scope_id ?? null))) throw notFound('Scope');
      add('r.scope_kind = ?', i.scope_kind); add('r.scope_id IS NOT DISTINCT FROM ?', i.scope_id ?? null);
    } else {
      const sk = i.subject_kind ?? 'person', sid = i.subject_id ?? (sk === 'person' ? user.id : null);
      if (!sid || !(await holderAccess(user, sk, sid))) throw notFound('Records');
      add('k.subject_kind = ?', sk); add('k.subject_id = ?', sid);
    }
    if (i.subject_kind && i.scope_kind) add('k.subject_kind = ?', i.subject_kind);
    if (i.status) add('k.status = ?', i.status);
    const rows = await many(
      `SELECT k.id, k.requirement_id, k.requirement_version, k.subject_kind, k.subject_id, k.status, k.outcome, k.issued_on::text AS issued_on, k.expires_on::text AS expires_on, k.provider, (k.reference_enc IS NOT NULL) AS has_reference,
              (k.detail_enc IS NOT NULL) AS has_detail, k.statement_version, k.submitted_at, k.decided_at, k.previous_id, k.row_version, r.name AS requirement_name, r.category, r.sensitive, r.scope_kind, r.scope_id
         FROM comp_records k JOIN comp_requirements r ON r.id=k.requirement_id WHERE ${where.join(' AND ')}
        ORDER BY ${i.status === 'submitted' ? 'k.submitted_at ASC' : 'k.submitted_at DESC'} LIMIT $${p.length + 1} OFFSET $${p.length + 2}`, [...p, i.limit + 1, i.offset]);
    const page_ = rows.slice(0, i.limit);
    const files = page_.length ? await many('SELECT id, record_id, original_name, content_type, size_bytes FROM comp_files WHERE record_id = ANY($1) AND removed_at IS NULL ORDER BY created_at', [page_.map((r) => r.id)]) : [];
    const items = [];
    for (const r of page_) {
      items.push({ ...viewRecord(r), files: files.filter((f) => f.record_id === r.id).map((f) => ({ id: f.id, name: f.original_name, type: f.content_type, size: f.size_bytes })), requirement: { name: r.requirement_name, category: r.category, category_label: CATEGORIES[r.category], sensitive: r.sensitive, scope: { kind: r.scope_kind, id: r.scope_id } },
        subject: { kind: r.subject_kind, id: r.subject_id, name: await nameFor(pool, user, r.subject_kind, r.subject_id) } });
    }
    return { items, has_more: rows.length > i.limit };
  },
});

cap({
  name: 'decide_compliance_record', method: 'POST', path: '/compliance/records/:id/decision', tag: TAG,
  summary: 'Decide a submission as a manager of the requirement\'s scope: approve (it becomes valid, and a renewed record is superseded), reject (a reason the holder sees is required; a background check records only "not clear" and no reason is shared), or revoke a record that is already valid (a reason is required). Nobody decides their own or a record they submitted. Repeating a decision is harmless; deciding something already decided is refused with the current state.',
  input: z.object({ id, decision: z.enum(['approve', 'reject', 'revoke']), reason: text(500).optional(), row_version: z.number().int().optional() }),
  async handler({ user }, i) {
    const r = await one('SELECT k.*, q.scope_kind, q.scope_id, q.name AS requirement_name, q.category, q.sensitive FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.id=$1', [i.id]);
    if (!r || !(await manages(user, r.scope_kind, r.scope_id, { write: true }))) throw notFound('Record');
    if (r.submitted_by === user.id || (r.subject_kind === 'person' && r.subject_id === user.id)) throw forbidden('You cannot decide your own submission. Another reviewer has to.');
    const target = { approve: 'valid', reject: 'rejected', revoke: 'revoked' }[i.decision];
    if (r.status === target) return fresh(pool, r.id);
    const backgrounds = r.category === 'background_check';
    if ((i.decision === 'reject' && !backgrounds || i.decision === 'revoke') && (i.reason ?? '').length < 5) throw badRequest('Give a reason of at least 5 characters');
    if (i.decision === 'revoke' ? r.status !== 'valid' : r.status !== 'submitted') throw conflict(`This record is ${r.status}, so it cannot be ${i.decision === 'approve' ? 'approved' : i.decision === 'reject' ? 'rejected' : 'revoked'}`, { code: 'wrong_state', status: r.status });
    if (i.row_version && i.row_version !== r.row_version) throw conflict('This record changed while you were looking at it. Reload it.', { code: 'stale' });
    return tx(async (c) => {
      const outcome = backgrounds ? (i.decision === 'approve' ? 'clear' : i.decision === 'reject' ? 'not_clear' : r.outcome) : r.outcome;
      const row = (await c.query(
        `UPDATE comp_records SET status=$2, outcome=$3, decided_by=$4, decided_at=now(), decision_reason=$5, updated_at=now(), row_version=row_version+1
          WHERE id=$1 AND status=$6 RETURNING *`, [r.id, target, outcome, user.id, backgrounds && i.decision === 'reject' ? null : (i.reason ?? null), i.decision === 'revoke' ? 'valid' : 'submitted'])).rows[0];
      if (!row) throw conflict('Someone else has just decided this record', { code: 'stale' });
      if (i.decision === 'approve' && r.previous_id) await c.query("UPDATE comp_records SET status='superseded', updated_at=now() WHERE id=$1 AND status='valid'", [r.previous_id]);
      await log(c, { requirement_id: r.requirement_id, record_id: r.id, subject_kind: r.subject_kind, subject_id: r.subject_id, actor_id: user.id, action: i.decision === 'approve' ? 'approved' : i.decision === 'reject' ? 'rejected' : 'revoked', detail: { outcome } });
      for (const h of await holders(c, r.subject_kind, r.subject_id)) {
        if (h === user.id) continue;
        await notify(c, h, {
          kind: 'compliance_decision', title: i.decision === 'approve' ? `${r.requirement_name} approved` : i.decision === 'reject' ? `${r.requirement_name} was not accepted` : `${r.requirement_name} was withdrawn`,
          body: i.decision === 'approve' ? 'It now counts towards what is required of you.' : 'Open Compliance for what to do next.', data: { record_id: r.id, requirement_id: r.requirement_id }, dedupe_key: `comp-decision:${r.id}:${i.decision}:${h}`,
        });
      }
      return fresh(c, row.id);
    });
  },
});

cap({
  name: 'read_compliance_reference', method: 'GET', path: '/compliance/records/:id/reference', tag: TAG,
  summary: 'Reveal the reference (and any declared detail) of a record. Only the holder and a verified guardian can see a background check\'s reference; for other requirements the managers of the scope can too. Every reveal is written to the audit log and the record history. Anyone else gets a 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT k.*, q.scope_kind, q.scope_id, q.sensitive FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.id=$1', [i.id]);
    const own = r ? await holderAccess(user, r.subject_kind, r.subject_id) : null;
    const holder = own === 'self' || own === 'guardian' || (own === 'manager' && !r?.sensitive && r?.subject_kind !== 'person');
    const mgr = r && !r.sensitive && (await manages(user, r.scope_kind, r.scope_id));
    if (!r || !(holder || mgr)) throw notFound('Record');
    await audit(null, user.id, 'read_compliance_reference', 'comp_records', r.id);
    await log(pool, { requirement_id: r.requirement_id, record_id: r.id, subject_kind: r.subject_kind, subject_id: r.subject_id, actor_id: user.id, action: 'reference_read' });
    return { id: r.id, reference: reveal(r.reference_enc, 'comp_records.reference'), detail: reveal(r.detail_enc, 'comp_records.detail'), provider: r.provider };
  },
});

// ---------------------------------------------------------------- waivers
cap({
  name: 'grant_compliance_waiver', method: 'POST', path: '/compliance/waivers', tag: TAG, status: 201,
  summary: 'Grant a documented, time-boxed exception for one person, organisation or event against one requirement of a scope you run (a reason is required, at most 180 days). The record and the rule are untouched; the status shows "Waived until …". Safeguarding that blocks contact with young people and background checks can never be waived, and nobody waives their own.',
  input: z.object({ requirement_id: id, subject_kind: z.enum(SUBJECTS).default('person'), subject_id: id, reason: text(500).min(5), effective_from: day.optional(), effective_to: day }),
  async handler({ user }, i) {
    const req = await loadRequirement(i.requirement_id);
    if (!(await manages(user, req.scope_kind, req.scope_id, { write: true }))) throw notFound('Requirement');
    if (i.subject_kind === 'person' && i.subject_id === user.id) throw forbidden('You cannot waive a requirement for yourself');
    if (req.category === 'background_check') throw conflict('A background check status cannot be waived', { code: 'not_waivable' });
    if (NEVER_WAIVABLE_CLASSES.includes(req.classification) || req.waivable === false) throw conflict('This rule cannot be waived', { code: 'not_waivable' });
    const blocksYouth = await one("SELECT 1 FROM comp_obligations WHERE requirement_id=$1 AND archived_at IS NULL AND consequences && ARRAY['youth_contact','youth_access']", [req.id]);
    if (blocksYouth) throw conflict('Safeguarding that protects young people cannot be waived', { code: 'not_waivable' });
    const t = await today(), from = i.effective_from ?? t;
    if (i.effective_to < from) throw badRequest('The waiver cannot end before it starts');
    if (i.effective_to > addDays(from, 180)) throw badRequest('A waiver can last at most 180 days. Renew it if it is still needed.');
    if (!(await applicable(pool, { kind: i.subject_kind, id: i.subject_id }, { scope: { kind: req.scope_kind, id: req.scope_id } })).some((o) => o.id === req.id)) throw conflict('This requirement does not apply to them', { code: 'not_required' });
    return tx(async (c) => {
      const w = (await c.query('INSERT INTO comp_waivers(requirement_id, subject_kind, subject_id, reason, effective_from, effective_to, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.id, i.subject_kind, i.subject_id, i.reason, from, i.effective_to, user.id])).rows[0];
      await log(c, { requirement_id: req.id, subject_kind: i.subject_kind, subject_id: i.subject_id, actor_id: user.id, action: 'waiver_granted', detail: { waiver_id: w.id, until: i.effective_to } });
      return { id: w.id, requirement_id: req.id, subject: { kind: i.subject_kind, id: i.subject_id }, reason: w.reason, effective_from: from, effective_to: i.effective_to };
    });
  },
});

cap({
  name: 'revoke_compliance_waiver', method: 'POST', path: '/compliance/waivers/:id/revoke', tag: TAG,
  summary: 'End a waiver now. The requirement applies again from that moment; the waiver stays in the history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const w = await one('SELECT w.*, q.scope_kind, q.scope_id FROM comp_waivers w JOIN comp_requirements q ON q.id=w.requirement_id WHERE w.id=$1', [i.id]);
    if (!w || !(await manages(user, w.scope_kind, w.scope_id, { write: true }))) throw notFound('Waiver');
    if (w.revoked_at) return { id: w.id, revoked: true };
    return tx(async (c) => {
      await c.query('UPDATE comp_waivers SET revoked_at=now(), revoked_by=$2 WHERE id=$1 AND revoked_at IS NULL', [w.id, user.id]);
      await log(c, { requirement_id: w.requirement_id, subject_kind: w.subject_kind, subject_id: w.subject_id, actor_id: user.id, action: 'waiver_revoked', detail: { waiver_id: w.id } });
      return { id: w.id, revoked: true };
    });
  },
});

cap({
  name: 'list_compliance_waivers', method: 'GET', path: '/compliance/waivers', tag: TAG,
  summary: 'Waivers in force (or all, with include_ended) for a scope you run, with who granted them, why, and until when.',
  input: z.object({ scope_kind: z.enum(SCOPES), scope_id: id.optional(), include_ended: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    if (!(await manages(user, i.scope_kind, i.scope_id ?? null))) throw notFound('Scope');
    const rows = await many(
      `SELECT w.id, w.requirement_id, q.name AS requirement_name, w.subject_kind, w.subject_id, w.reason, w.effective_from::text AS effective_from, w.effective_to::text AS effective_to, w.revoked_at, g.display_name AS granted_by_name, w.created_at
         FROM comp_waivers w JOIN comp_requirements q ON q.id=w.requirement_id JOIN users g ON g.id=w.granted_by
        WHERE q.scope_kind=$1 AND q.scope_id IS NOT DISTINCT FROM $2 ${i.include_ended ? '' : 'AND w.revoked_at IS NULL AND w.effective_to >= current_date'} ORDER BY w.created_at DESC LIMIT $3 OFFSET $4`, [i.scope_kind, i.scope_id ?? null, i.limit + 1, i.offset]);
    const items = [];
    for (const w of rows.slice(0, i.limit)) items.push({ ...w, subject: { kind: w.subject_kind, id: w.subject_id, name: await nameFor(pool, user, w.subject_kind, w.subject_id) } });
    return { items, has_more: rows.length > i.limit };
  },
});

// ---------------------------------------------------------------- evidence packs
const PACK_LIMIT = 500;

/** A frozen summary of a scope for an audit or review: states and validity only. Never a reference, a number, a decision note or declared text. */
export async function buildPack(c, viewer, scope, subjectKind) {
  const ids = [];
  for (let off = 0; ids.length < PACK_LIMIT; off += 100) {
    const r = await subjectsInScope(c, scope.kind, scope.id ?? null, subjectKind, { limit: 100, offset: off });
    if (!r.ids.length) break;
    ids.push(...r.ids);
  }
  const subjects = [];
  const totals = { subjects: 0, clear: 0, pending: 0, blocked: 0 };
  for (const sid of ids.slice(0, PACK_LIMIT)) {
    const ev = await evaluateSubject(c, { kind: subjectKind, id: sid }, { scope: { kind: scope.kind, id: scope.id ?? null } });
    if (!ev.items.length) continue;
    totals.subjects++; totals[ev.decision]++;
    subjects.push({
      kind: subjectKind, id: sid, name: await nameFor(c, viewer, subjectKind, sid), decision: ev.decision,
      items: ev.items.map((x) => ({ requirement: x.requirement.name, category: x.requirement.category_label, version: x.requirement.version, mandatory: x.mandatory, state: x.state_label, issued_on: x.issued_on, expires_on: x.expires_on, waived_until: x.waiver?.effective_to ?? null })),
    });
  }
  const reqs = await c.query('SELECT name, category, version, method, validity_days FROM comp_requirements WHERE scope_kind=$1 AND scope_id IS NOT DISTINCT FROM $2 AND archived_at IS NULL ORDER BY name', [scope.kind, scope.id ?? null]);
  return { generated_at: new Date().toISOString(), scope: { kind: scope.kind, id: scope.id ?? null, name: await scopeName(c, scope.kind, scope.id ?? null) }, subject_kind: subjectKind,
    requirements: reqs.rows.map((r) => ({ name: r.name, category: CATEGORIES[r.category], version: r.version, method: r.method, validity_days: r.validity_days })), totals, subjects, truncated: ids.length > PACK_LIMIT };
}

cap({
  name: 'create_compliance_pack', method: 'POST', path: '/compliance/packs', tag: TAG, status: 201,
  summary: 'Create an evidence pack for an authorised reviewer: a frozen, hashed summary of every requirement and the state of each person (or organisation, or event) in a scope you run, with validity dates and waivers. It never contains references, numbers, reviewer notes or declared text. Name the purpose and the person who may read it; it expires (default 7 days, at most 30) and can be revoked. Reading it is audit-logged.',
  input: z.object({ scope_kind: z.enum(SCOPES), scope_id: id.optional(), subject_kind: z.enum(SUBJECTS).default('person'), purpose: text(300).min(5), recipient_id: id, expires_in_days: z.number().int().min(1).max(30).default(7) })
    .refine((x) => (x.scope_kind === 'platform') === !x.scope_id, { message: 'scope_id is required for every scope except platform', path: ['scope_id'] }),
  async handler({ user }, i) {
    if (!(await manages(user, i.scope_kind, i.scope_id ?? null))) throw notFound('Scope');
    if (!(await one('SELECT 1 FROM users WHERE id=$1', [i.recipient_id]))) throw notFound('Reviewer');
    const content = await buildPack(pool, user, { kind: i.scope_kind, id: i.scope_id ?? null }, i.subject_kind);
    const sha = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return tx(async (c) => {
      const p = (await c.query(
        `INSERT INTO comp_packs(scope_kind, scope_id, purpose, recipient_id, content, sha256, generated_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' days')::interval) RETURNING id, expires_at, created_at`,
        [i.scope_kind, i.scope_id ?? null, i.purpose, i.recipient_id, JSON.stringify(content), sha, user.id, String(i.expires_in_days)])).rows[0];
      await log(c, { subject_kind: i.scope_kind === 'platform' ? null : i.scope_kind, subject_id: i.scope_id ?? null, actor_id: user.id, action: 'pack_created', detail: { pack_id: p.id, recipient: i.recipient_id } });
      if (i.recipient_id !== user.id) await notify(c, i.recipient_id, { kind: 'compliance_pack', title: 'A compliance evidence pack is ready for you', body: `Purpose: ${i.purpose}. It is available until ${p.expires_at.toISOString().slice(0, 10)}.`, data: { pack_id: p.id }, dedupe_key: `comp-pack:${p.id}` });
      return { id: p.id, sha256: sha, expires_at: p.expires_at, created_at: p.created_at, totals: content.totals, truncated: content.truncated };
    });
  },
});

cap({
  name: 'list_compliance_packs', method: 'GET', path: '/compliance/packs', tag: TAG,
  summary: 'Evidence packs you created or that were addressed to you, newest first, with their purpose, hash, expiry and whether they are still readable. The content is read with get_compliance_pack.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT p.id, p.scope_kind, p.scope_id, p.purpose, p.sha256, p.created_at, p.expires_at, p.revoked_at, p.recipient_id, p.generated_by, r.display_name AS recipient_name, g.display_name AS generated_by_name
         FROM comp_packs p JOIN users r ON r.id=p.recipient_id JOIN users g ON g.id=p.generated_by WHERE p.recipient_id=$1 OR p.generated_by=$1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit + 1, i.offset]);
    const items = [];
    for (const p of rows.slice(0, i.limit)) items.push({ ...p, scope_name: await scopeName(pool, p.scope_kind, p.scope_id), readable: !p.revoked_at && p.expires_at > new Date(), mine: p.recipient_id === user.id });
    return { items, has_more: rows.length > i.limit };
  },
});

cap({
  name: 'get_compliance_pack', method: 'GET', path: '/compliance/packs/:id', tag: TAG,
  summary: 'Read an evidence pack. Only the named reviewer (while it is unexpired and not revoked) and the person who created it can read it; everyone else gets a 404. Each read is audit-logged. The content matches the SHA-256 shown when it was created.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM comp_packs WHERE id=$1', [i.id]);
    const isRecipient = p?.recipient_id === user.id, isMaker = p?.generated_by === user.id;
    if (!p || !(isRecipient || isMaker)) throw notFound('Evidence pack');
    if (isRecipient && !isMaker && (p.revoked_at || p.expires_at <= new Date())) throw forbidden(p.revoked_at ? 'This evidence pack was revoked' : 'This evidence pack has expired');
    await audit(null, user.id, 'read_compliance_pack', 'comp_packs', p.id);
    await log(pool, { actor_id: user.id, action: 'pack_read', detail: { pack_id: p.id } });
    return { id: p.id, purpose: p.purpose, sha256: p.sha256, created_at: p.created_at, expires_at: p.expires_at, revoked: !!p.revoked_at, content: p.content };
  },
});

cap({
  name: 'revoke_compliance_pack', method: 'POST', path: '/compliance/packs/:id/revoke', tag: TAG,
  summary: 'Stop a reviewer reading an evidence pack. Allowed for the person who created it and for the managers of its scope; the pack and its history are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM comp_packs WHERE id=$1', [i.id]);
    if (!p || !(p.generated_by === user.id || await manages(user, p.scope_kind, p.scope_id))) throw notFound('Evidence pack');
    if (!p.revoked_at) {
      await one('UPDATE comp_packs SET revoked_at=now(), revoked_by=$2 WHERE id=$1 RETURNING id', [p.id, user.id]);
      await log(pool, { actor_id: user.id, action: 'pack_revoked', detail: { pack_id: p.id } });
    }
    return { id: p.id, revoked: true };
  },
});
