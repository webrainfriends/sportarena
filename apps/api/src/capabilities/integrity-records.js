// Sport Integrity & Anti-Doping Administration (#489) 2/2: testing and exemption references, custody handoffs, decisions and the sanction handoff,
// appeals, education acknowledgements and declarations. Every reference is stored exactly as the authoritative source supplied it: there is no field for
// an analytical value, a diagnosis, a medication or a score, and unknown fields are rejected rather than ignored.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt, blindIndex, sha256 } from '../crypto.js';
import { audit } from '../helpers.js';
import { bodyById, mustBeActive, isGuardianOf, LIC_STATUS } from '../federation.js';
import { REFERENCE_ONLY, today, addDays, officerOf, needOfficer, log, caseFor, mayDecide, needDecide, tell } from '../integrity.js';

const TAG = 'Sport integrity';
const SCOPE = 'admin';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const moment = z.string().datetime({ offset: true });
const OUTCOMES = ['no_finding', 'finding_recorded', 'no_further_action', 'withdrawn_by_authority', 'other'];

async function sourceOf(c, bodyId, sourceId) {
  const s = (await c.query("SELECT * FROM int_sources WHERE id=$1 AND body_id=$2 AND status='active'", [sourceId, bodyId])).rows[0];
  if (!s) throw notFound('Source');
  return s;
}
/** Idempotent revision handling: the same source record with the same content is the same record; changed content is a new revision that supersedes, never an overwrite. */
async function revise(c, table, sourceId, ref, hash, make) {
  const idx = blindIndex(`${sourceId}:${ref}`);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${table}:${idx}`]);
  const last = (await c.query(`SELECT * FROM ${table} WHERE source_id=$1 AND external_ref_idx=$2 ORDER BY revision DESC LIMIT 1`, [sourceId, idx])).rows[0];
  if (last && last.payload_hash === hash && !last.tombstoned_at) return { row: last, replayed: true };
  const row = await make(idx, (last?.revision ?? 0) + 1);
  if (last) await c.query(`UPDATE ${table} SET superseded_at=now() WHERE id=$1`, [last.id]);
  return { row, replayed: false, previous: last ?? null };
}
const hashOf = (o) => sha256(JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k] ?? null])));

// ------------------------------------------------------------------ testing references
const testRefIn = z.object({
  id, subject_id: id, case_id: id.optional(), source_id: id,
  external_ref: text(120).min(2).describe('the test or sample reference code / external ID exactly as the authority supplied it'),
  testing_authority: text(120).optional(), collected_at: moment.optional(),
  context: z.enum(['in_competition', 'out_of_competition', 'unspecified']).default('unspecified'),
  sample_type: text(60).optional().describe('only where operationally necessary'),
  external_status: text(120).min(1).describe('the current status exactly as the source supplied it'),
  result_category: text(120).optional().describe('the result category exactly as the source supplied it, never your reading of it'),
  source_sent_at: moment.optional(),
}).strict();

const TEST_COLS = `t.id, t.case_id, t.subject_id, su.display_name AS subject_name, t.source_id, s.name AS source_name, s.designation AS source_designation, t.external_ref_enc, t.revision, t.testing_authority, t.collected_at, t.context, t.sample_type,
  t.external_status, t.result_category, t.verification, t.reviewed_at, t.received_at, t.source_sent_at, t.superseded_at, t.tombstoned_at, t.tombstone_reason`;
const shapeTest = (r) => { const { external_ref_enc, ...x } = r; return { ...x, external_ref: decrypt(external_ref_enc, 'int_test_refs.ref'), reference_only: REFERENCE_ONLY, current: !r.superseded_at && !r.tombstoned_at }; };

cap({
  name: 'record_test_reference', method: 'POST', path: '/integrity/bodies/:id/test-references', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Record the testing reference an authorised anti-doping organisation supplied (integrity officers): reference code, authority, collection time, context, status and result category, each exactly as supplied. Never an analytical value or a conclusion; unknown fields are rejected. Entered by hand it stays UNVERIFIED until a second officer reviews it. Sending the same source record again changes nothing (replay-safe); changed content becomes a new revision and the earlier one is kept.',
  input: testRefIn,
  handler: ({ user }, i) => tx(async (c) => {
    await needOfficer(user, i.id, { c });
    mustBeActive(await bodyById(i.id, c));
    const src = await sourceOf(c, i.id, i.source_id);
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.subject_id])).rowCount) throw notFound('Person');
    if (i.case_id) {
      const k = (await c.query('SELECT subject_id FROM int_cases WHERE id=$1 AND body_id=$2', [i.case_id, i.id])).rows[0];
      if (!k) throw notFound('Case');
      if (k.subject_id !== i.subject_id) throw badRequest('That case is about someone else');
    }
    const { id: _b, ...f } = i;
    const hash = hashOf({ ...f, case_id: undefined });
    const r = await revise(c, 'int_test_refs', i.source_id, i.external_ref, hash, async (idx, revision) => (await c.query(
      `INSERT INTO int_test_refs(body_id, case_id, subject_id, source_id, external_ref_enc, external_ref_idx, revision, testing_authority, collected_at, context, sample_type, external_status, result_category, verification, payload_hash, source_sent_at, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'unverified',$14,$15,$16) RETURNING id`,
      [i.id, i.case_id ?? null, i.subject_id, i.source_id, encrypt(i.external_ref, 'int_test_refs.ref'), idx, revision, i.testing_authority ?? null, i.collected_at ?? null, i.context, i.sample_type ?? null, i.external_status, i.result_category ?? null, hash, i.source_sent_at ?? null, user.id])).rows[0]);
    if (!r.replayed) await log(c, i.id, i.case_id ?? null, 'test_reference', r.row.id, r.previous ? 'revised' : 'recorded', { actor: user.id, detail: { revision: r.previous ? r.previous.revision + 1 : 1, source: src.name, designation: src.designation } });
    await audit(c, user.id, 'integrity_test_reference_recorded', 'int_test_refs', r.row.id);
    return { ...shapeTest((await c.query(`SELECT ${TEST_COLS} FROM int_test_refs t JOIN int_sources s ON s.id=t.source_id JOIN users su ON su.id=t.subject_id WHERE t.id=$1`, [r.row.id])).rows[0]), replayed: r.replayed };
  }),
});

cap({
  name: 'list_test_references', method: 'GET', path: '/integrity/bodies/:id/test-references', tag: TAG, scope: SCOPE,
  summary: 'Testing references with their custody handoffs and revision history (integrity officers; every read is audit-logged). Filter by person or case. Superseded revisions are listed only with `history`.',
  input: z.object({ id, subject_id: id.optional(), case_id: id.optional(), history: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    await needOfficer(user, i.id);
    const rows = await many(
      `SELECT ${TEST_COLS} FROM int_test_refs t JOIN int_sources s ON s.id=t.source_id JOIN users su ON su.id=t.subject_id
        WHERE t.body_id=$1 AND ($2::uuid IS NULL OR t.subject_id=$2) AND ($3::uuid IS NULL OR t.case_id=$3) AND ($4::boolean OR t.superseded_at IS NULL) ORDER BY t.received_at DESC, t.id LIMIT $5 OFFSET $6`,
      [i.id, i.subject_id ?? null, i.case_id ?? null, i.history, i.limit, i.offset]);
    const custody = rows.length ? await many('SELECT test_ref_id, step, actor_label, occurred_at, external_id, recorded_at FROM int_custody_events WHERE test_ref_id = ANY($1) ORDER BY occurred_at, recorded_at', [rows.map((r) => r.id)]) : [];
    if (rows.length) await audit(null, user.id, 'integrity_test_references_read', 'governing_bodies', i.id);
    return { reference_only: REFERENCE_ONLY, items: rows.map((r) => ({ ...shapeTest(r), custody: custody.filter((x) => x.test_ref_id === r.id) })) };
  },
});

cap({
  name: 'add_custody_event', method: 'POST', path: '/integrity/test-references/:id/custody', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Append one administrative handoff or status step the source reported for a test reference (integrity officers): the step, who or what reported it, when, and the source\'s own identifier. Append-only. SportArena is not the laboratory chain-of-custody authority and does not claim to be.',
  input: z.object({ id, step: text(120).min(2), actor_label: text(120).min(2), occurred_at: moment, external_id: text(120).optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const t = (await c.query('SELECT * FROM int_test_refs WHERE id=$1', [i.id])).rows[0];
    if (!t) throw notFound('Test reference');
    await needOfficer(user, t.body_id, { c });
    if (t.superseded_at || t.tombstoned_at) throw conflict('Add handoffs to the current revision');
    if (i.external_id) {
      const same = (await c.query('SELECT id, step, actor_label, occurred_at, external_id FROM int_custody_events WHERE test_ref_id=$1 AND external_id=$2', [t.id, i.external_id])).rows[0];
      if (same) return { ...same, replayed: true };
    }
    let row;
    try { row = (await c.query('INSERT INTO int_custody_events(test_ref_id, body_id, step, actor_label, occurred_at, external_id, source_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, step, actor_label, occurred_at, external_id', [t.id, t.body_id, i.step, i.actor_label, i.occurred_at, i.external_id ?? null, t.source_id, user.id])).rows[0]; }
    catch (e) { if (e.code === '23505') throw conflict('That handoff was recorded at the same moment; reload'); throw e; }
    await log(c, t.body_id, t.case_id, 'custody', row.id, 'handoff_recorded', { actor: user.id, detail: { test_reference: t.id } });
    return row;
  }),
});

// ------------------------------------------------------------------ exemptions: the minimum operational projection
const EX_COLS = `x.id, x.subject_id, su.display_name AS subject_name, x.source_id, s.name AS source_name, x.external_ref_enc, x.revision, x.issuing_authority, x.external_status, x.valid_from::text AS valid_from, x.valid_until::text AS valid_until, x.scope_note,
  x.last_verified_at, x.verification, x.superseded_at, x.tombstoned_at, x.created_at`;
const shapeEx = (r) => { const { external_ref_enc, ...x } = r; return { ...x, external_ref: decrypt(external_ref_enc, 'int_exemptions.ref'), current: !r.superseded_at && !r.tombstoned_at, in_force: !r.superseded_at && !r.tombstoned_at && (!r.valid_until || r.valid_until >= today()) && (!r.valid_from || r.valid_from <= today()) }; };

cap({
  name: 'record_exemption_reference', method: 'POST', path: '/integrity/bodies/:id/exemptions', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Record a therapeutic-use exemption as the minimum operational projection (integrity officers): the authority\'s reference, the issuing authority, the status as supplied, validity dates, permitted scope and when it was last verified. There is no field for a diagnosis, medication or rationale: those stay with the authority or in Health, and unknown fields are rejected. Replay-safe and revisioned like a testing reference.',
  input: z.object({ id, subject_id: id, source_id: id, external_ref: text(120).min(2), issuing_authority: text(120).min(2), external_status: text(120).min(1), valid_from: day.optional(), valid_until: day.optional(), scope_note: text(200).optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    await needOfficer(user, i.id, { c });
    mustBeActive(await bodyById(i.id, c));
    await sourceOf(c, i.id, i.source_id);
    if (i.valid_from && i.valid_until && i.valid_until < i.valid_from) throw badRequest('The end date is before the start date');
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.subject_id])).rowCount) throw notFound('Person');
    const { id: _b, ...f } = i;
    const hash = hashOf(f);
    const r = await revise(c, 'int_exemptions', i.source_id, i.external_ref, hash, async (idx, revision) => (await c.query(
      `INSERT INTO int_exemptions(body_id, subject_id, source_id, external_ref_enc, external_ref_idx, revision, issuing_authority, external_status, valid_from, valid_until, scope_note, verification, payload_hash, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unverified',$12,$13) RETURNING id`,
      [i.id, i.subject_id, i.source_id, encrypt(i.external_ref, 'int_exemptions.ref'), idx, revision, i.issuing_authority, i.external_status, i.valid_from ?? null, i.valid_until ?? null, i.scope_note ?? null, hash, user.id])).rows[0]);
    if (!r.replayed) await log(c, i.id, null, 'exemption', r.row.id, r.previous ? 'revised' : 'recorded', { actor: user.id, detail: { revision: r.previous ? r.previous.revision + 1 : 1 } });
    else await c.query('UPDATE int_exemptions SET last_verified_at=now() WHERE id=$1', [r.row.id]); // the source confirmed the same content again
    await audit(c, user.id, 'integrity_exemption_recorded', 'int_exemptions', r.row.id);
    return { ...shapeEx((await c.query(`SELECT ${EX_COLS} FROM int_exemptions x JOIN int_sources s ON s.id=x.source_id JOIN users su ON su.id=x.subject_id WHERE x.id=$1`, [r.row.id])).rows[0]), replayed: r.replayed };
  }),
});
cap({
  name: 'list_exemption_references', method: 'GET', path: '/integrity/bodies/:id/exemptions', tag: TAG, scope: SCOPE,
  summary: 'Exemption references with source, revision and last-verified time (integrity officers; audit-logged).',
  input: z.object({ id, subject_id: id.optional(), history: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    await needOfficer(user, i.id);
    const rows = await many(`SELECT ${EX_COLS} FROM int_exemptions x JOIN int_sources s ON s.id=x.source_id JOIN users su ON su.id=x.subject_id WHERE x.body_id=$1 AND ($2::uuid IS NULL OR x.subject_id=$2) AND ($3::boolean OR x.superseded_at IS NULL) ORDER BY x.created_at DESC, x.id LIMIT $4 OFFSET $5`, [i.id, i.subject_id ?? null, i.history, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'integrity_exemptions_read', 'governing_bodies', i.id);
    return { items: rows.map(shapeEx) };
  },
});

// ------------------------------------------------------------------ second-officer review and tombstones (shared by both reference kinds)
const REF = { test_reference: ['int_test_refs', 'test_reference'], exemption: ['int_exemptions', 'exemption'] };
cap({
  name: 'review_integrity_reference', method: 'POST', path: '/integrity/references/:id/review', tag: TAG, scope: SCOPE,
  summary: 'A second integrity officer confirms a hand-entered testing or exemption reference against the authoritative source, which turns it from unverified to reviewed. The officer who entered it cannot review it.',
  input: z.object({ id, type: z.enum(['test_reference', 'exemption']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const [table, kind] = REF[i.type];
    const r = (await c.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!r) throw notFound('Reference');
    await needOfficer(user, r.body_id, { c });
    if (r.recorded_by === user.id) throw forbidden('A second officer must review what you entered');
    if (r.superseded_at || r.tombstoned_at) throw conflict('Only the current revision can be reviewed');
    if (r.verification !== 'unverified') throw conflict('Already reviewed');
    await c.query(`UPDATE ${table} SET verification='reviewed'${i.type === 'test_reference' ? ', reviewed_by=$2, reviewed_at=now()' : ', last_verified_at=now()'} WHERE id=$1`, i.type === 'test_reference' ? [i.id, user.id] : [i.id]);
    await log(c, r.body_id, r.case_id ?? null, kind, r.id, 'reviewed', { actor: user.id, from: 'unverified', to: 'reviewed' });
    return { ok: true, verification: 'reviewed' };
  }),
});
cap({
  name: 'tombstone_integrity_reference', method: 'POST', path: '/integrity/references/:id/tombstone', tag: TAG, scope: SCOPE,
  summary: 'Mark a testing or exemption reference withdrawn or deleted at the source (integrity officers). The record and its history stay; it stops counting as current.',
  input: z.object({ id, type: z.enum(['test_reference', 'exemption']), reason: text(300).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    const [table, kind] = REF[i.type];
    const r = (await c.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!r) throw notFound('Reference');
    await needOfficer(user, r.body_id, { c });
    if (r.tombstoned_at) throw conflict('Already withdrawn');
    await c.query(`UPDATE ${table} SET tombstoned_at=now()${i.type === 'test_reference' ? ', tombstone_reason=$2' : ''} WHERE id=$1`, i.type === 'test_reference' ? [i.id, i.reason] : [i.id]);
    await log(c, r.body_id, r.case_id ?? null, kind, r.id, 'tombstoned', { actor: user.id, reason: i.reason });
    return { ok: true };
  }),
});

// ------------------------------------------------------------------ decisions and the sporting-sanction handoff
/** Appends a decision; supersedes the current one. Competition eligibility reads the active sanction live (integrity.js), so nothing is copied and nothing goes stale. */
async function appendDecision(c, user, k, d, kind) {
  const cur = (await c.query('SELECT * FROM int_decisions WHERE case_id=$1 AND superseded_at IS NULL FOR UPDATE', [k.id])).rows[0] ?? null;
  if (kind === 'initial' && cur) throw conflict('A decision is already recorded; record an amendment, an appeal outcome or a reversal');
  if (kind !== 'initial' && !cur) throw conflict('There is no decision to change');
  if (d.sporting_sanction && d.outcome !== 'finding_recorded') throw badRequest('Only a recorded finding can carry a sporting sanction');
  if (d.sporting_sanction && !d.effective_from) throw badRequest('A sporting sanction needs its effective date');
  if (d.effective_from && d.effective_to && d.effective_to < d.effective_from) throw badRequest('The end date is before the start date');
  const seq = ((await c.query('SELECT coalesce(max(seq),0)+1 AS n FROM int_decisions WHERE case_id=$1', [k.id])).rows[0]).n;
  const row = (await c.query(
    `INSERT INTO int_decisions(case_id, body_id, seq, kind, made_by, authority_label, decision_ref_enc, outcome, outcome_text_enc, effective_from, effective_to, scope_note, sporting_sanction, handoff_status, supersedes_id, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [k.id, k.body_id, seq, kind, d.made_by, d.authority_label, encrypt(d.decision_ref, 'int_decisions.ref'), d.outcome, d.outcome_text ? encrypt(d.outcome_text, 'int_decisions.outcome') : null, d.effective_from ?? null, d.effective_to ?? null, d.scope_note ?? null,
      !!d.sporting_sanction, d.sporting_sanction ? 'delivered_to_eligibility' : 'not_applicable', cur?.id ?? null, user.id])).rows[0];
  if (cur) await c.query("UPDATE int_decisions SET superseded_at=now(), handoff_status=CASE WHEN handoff_status='delivered_to_eligibility' THEN 'lifted' ELSE handoff_status END WHERE id=$1", [cur.id]);
  await log(c, k.body_id, k.id, 'decision', row.id, kind, { actor: user.id, detail: { seq, outcome: d.outcome, made_by: d.made_by, sporting_sanction: !!d.sporting_sanction, supersedes: cur?.id ?? null } });
  return row;
}

const decisionIn = {
  made_by: z.enum(['external_body', 'internal_panel']), authority_label: text(160).min(2).describe('the body or panel that decided'),
  decision_ref: text(200).min(2).describe('the decision reference exactly as issued'), outcome: z.enum(OUTCOMES), outcome_text: text(1000).optional(),
  effective_from: day.nullish(), effective_to: day.nullish(), scope_note: text(300).optional(),
  sporting_sanction: z.boolean().default(false).describe('hands a sporting sanction to competition eligibility; the suspension rules are not duplicated here'),
};
cap({
  name: 'record_integrity_decision', method: 'POST', path: '/integrity/cases/:id/decisions', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Record the exact decision, reference and source (an integrity officer or case panel member; always a person, never automatic). `initial` records the first decision and marks the case decided; `amendment` and `reversal` supersede the current one without erasing it. A sporting sanction is handed to competition eligibility, which reads it live and shows only that the person is suspended until the date; a later amendment or reversal lifts it automatically.',
  input: z.object({ id, kind: z.enum(['initial', 'amendment', 'reversal']).default('initial'), ...decisionIn, version: z.number().int().min(1).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await caseFor(user, i.id, { c, lock: true });
    needDecide(s);
    const k = s.row;
    if (i.version && i.version !== k.row_version) throw conflict('This case changed since you opened it; reload and try again', { code: 'stale_version' });
    if (i.kind === 'initial' && !['under_review', 'response_due', 'decision_pending'].includes(k.status)) throw conflict(`Open the case for decision first; it is ${k.status.replace(/_/g, ' ')}`);
    if (i.kind !== 'initial' && !['decided', 'closed'].includes(k.status)) throw conflict('Only a decided case can be amended or reversed');
    if (i.kind === 'reversal' && (i.sporting_sanction || i.outcome === 'finding_recorded')) throw badRequest('A reversal cannot record a finding or a sanction');
    const row = await appendDecision(c, user, k, i, i.kind);
    if (i.kind === 'initial') await c.query("UPDATE int_cases SET status='decided', row_version=row_version+1, updated_at=now() WHERE id=$1", [k.id]);
    else await c.query('UPDATE int_cases SET row_version=row_version+1, updated_at=now() WHERE id=$1', [k.id]);
    await tell(c, k.subject_id, { ...k, row_version: k.row_version + 1 });
    await audit(c, user.id, `integrity_decision_${i.kind}`, 'int_cases', k.id);
    return { id: row.id, seq: row.seq, kind: row.kind, outcome: row.outcome, handoff_status: row.handoff_status };
  }),
});

// ------------------------------------------------------------------ appeals
cap({
  name: 'lodge_integrity_appeal', method: 'POST', path: '/integrity/cases/:id/appeals', tag: TAG, scope: SCOPE, status: 201,
  summary: 'The person concerned (or a youth\'s verified guardian) appeals the current decision, with their grounds. One open appeal per decision. The grounds are encrypted and visible only to the officers and panel.',
  input: z.object({ id, grounds: text(4000).min(10) }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await caseFor(user, i.id, { c, lock: true });
    if (s.as !== 'subject') throw forbidden('Only the person concerned, or their guardian, can appeal');
    const d = (await c.query("SELECT * FROM int_decisions WHERE case_id=$1 AND superseded_at IS NULL AND outcome='finding_recorded'", [s.row.id])).rows[0];
    if (!d) throw conflict('There is no recorded finding to appeal');
    let a;
    try { a = (await c.query('INSERT INTO int_appeals(case_id, decision_id, body_id, lodged_by, grounds_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id, status, created_at', [s.row.id, d.id, s.row.body_id, user.id, encrypt(i.grounds, 'int_appeals.grounds')])).rows[0]; }
    catch (e) { if (e.code === '23505') throw conflict('An appeal against this decision is already open'); throw e; }
    await log(c, s.row.body_id, s.row.id, 'appeal', a.id, 'lodged', { actor: user.id, detail: { decision_id: d.id } });
    await audit(c, user.id, 'integrity_appeal_lodged', 'int_cases', s.row.id);
    return a;
  }),
});
cap({
  name: 'rule_on_integrity_appeal', method: 'POST', path: '/integrity/appeals/:id/ruling', tag: TAG, scope: SCOPE,
  summary: 'Review and decide an appeal (an integrity officer or case panel member who did not record the original decision; always a person). `start_review` opens it; `upheld` and `dismissed` leave the decision standing; `reduced` and `overturned` record a new decision that supersedes it (an overturn lifts any sporting sanction); `remitted` sends the case back for review. History is never erased.',
  input: z.object({ id, action: z.enum(['start_review', 'upheld', 'dismissed', 'reduced', 'overturned', 'remitted']), panel_label: text(160).optional(), reason: text(500).optional(), decision: z.object(decisionIn).partial({ sporting_sanction: true }).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM int_appeals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!a) throw notFound('Appeal');
    const s = await caseFor(user, a.case_id, { c, lock: true });
    needDecide(s);
    const orig = (await c.query('SELECT recorded_by FROM int_decisions WHERE id=$1', [a.decision_id])).rows[0];
    if (orig.recorded_by === user.id) throw forbidden('The appeal must be reviewed by someone who did not make the original decision');
    if (!['lodged', 'under_review'].includes(a.status)) throw conflict(`This appeal is already ${a.status}`);
    if (i.action === 'start_review') {
      if (a.status !== 'lodged') throw conflict('Already under review');
      await c.query("UPDATE int_appeals SET status='under_review', panel_label=$2 WHERE id=$1", [a.id, i.panel_label ?? null]);
      await log(c, a.body_id, a.case_id, 'appeal', a.id, 'review_started', { actor: user.id, from: 'lodged', to: 'under_review' });
      return { id: a.id, status: 'under_review' };
    }
    let outcomeId = null;
    if (['reduced', 'overturned'].includes(i.action)) {
      const d = i.decision;
      if (!d?.authority_label || !d?.decision_ref || !d?.made_by) throw badRequest('Give the authority, the made-by and the decision reference for the new decision');
      const next = i.action === 'overturned' ? { ...d, outcome: d.outcome ?? 'no_finding', sporting_sanction: false } : { ...d, outcome: d.outcome ?? 'finding_recorded' };
      if (i.action === 'overturned' && next.outcome === 'finding_recorded') throw badRequest('An overturned decision cannot record a finding');
      outcomeId = (await appendDecision(c, user, s.row, next, 'appeal_outcome')).id;
    }
    if (i.action === 'remitted') await c.query("UPDATE int_cases SET status='under_review', closed_at=NULL WHERE id=$1", [a.case_id]);
    await c.query('UPDATE int_appeals SET status=$2, decided_at=now(), outcome_decision_id=$3, panel_label=coalesce($4, panel_label) WHERE id=$1', [a.id, i.action, outcomeId, i.panel_label ?? null]);
    await c.query('UPDATE int_cases SET row_version=row_version+1, updated_at=now() WHERE id=$1', [a.case_id]);
    await log(c, a.body_id, a.case_id, 'appeal', a.id, i.action, { actor: user.id, from: a.status, to: i.action, reason: i.reason, detail: { outcome_decision_id: outcomeId } });
    await tell(c, s.row.subject_id, { ...s.row, row_version: s.row.row_version + 1 });
    await audit(c, user.id, `integrity_appeal_${i.action}`, 'int_cases', a.case_id);
    return { id: a.id, status: i.action, outcome_decision_id: outcomeId };
  }),
});

// ------------------------------------------------------------------ education and acknowledgements (never a score)
cap({
  name: 'save_education_requirement', method: 'POST', path: '/integrity/bodies/:id/education', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Define an integrity education requirement (integrity officers): title, the governed course it links to (an existing programme), who it applies to, and how long a completion stays valid. Passing `requirement_id` publishes a new version; completions keep the version they were made under.',
  input: z.object({ id, requirement_id: id.optional(), title: text(120).min(2), programme_id: id.optional(), sport_id: id.optional(), valid_months: z.number().int().min(1).max(120).optional(), retire: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    await needOfficer(user, i.id, { c });
    mustBeActive(await bodyById(i.id, c));
    if (i.programme_id && !(await c.query("SELECT 1 FROM programmes WHERE id=$1 AND status='active'", [i.programme_id])).rowCount) throw notFound('Programme');
    let row;
    if (i.requirement_id) {
      row = (await c.query("UPDATE int_education_requirements SET title=$3, programme_id=$4, sport_id=$5, valid_months=$6, version=version+1, status=CASE WHEN $7 THEN 'retired' ELSE 'active' END WHERE id=$1 AND body_id=$2 RETURNING *",
        [i.requirement_id, i.id, i.title, i.programme_id ?? null, i.sport_id ?? null, i.valid_months ?? null, i.retire])).rows[0];
      if (!row) throw notFound('Requirement');
    } else row = (await c.query('INSERT INTO int_education_requirements(body_id, title, programme_id, sport_id, valid_months, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, i.title, i.programme_id ?? null, i.sport_id ?? null, i.valid_months ?? null, user.id])).rows[0];
    await log(c, i.id, null, 'education', row.id, i.requirement_id ? 'versioned' : 'created', { actor: user.id, detail: { version: row.version, title: row.title } });
    return row;
  }),
});
cap({
  name: 'assign_education_requirement', method: 'POST', path: '/integrity/education/:id/assign', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Assign a requirement (integrity officers) to named people, or to every current licence holder of the body (optionally one sport). Idempotent per person and version. The people are told there is something to open, nothing more.',
  input: z.object({ id, user_ids: z.array(id).max(200).default([]), all_licence_holders: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query("SELECT * FROM int_education_requirements WHERE id=$1 AND status='active' FOR UPDATE", [i.id])).rows[0];
    if (!r) throw notFound('Requirement');
    await needOfficer(user, r.body_id, { c });
    let ids = [...i.user_ids];
    if (i.all_licence_holders) ids = ids.concat((await c.query(`SELECT DISTINCT l.holder_id FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.body_id=$1 AND (${LIC_STATUS('l')})='active' AND ($2::uuid IS NULL OR t.sport_id=$2)`, [r.body_id, r.sport_id])).rows.map((x) => x.holder_id));
    ids = [...new Set(ids)];
    if (!ids.length) throw badRequest('Name at least one person, or assign to the licence holders');
    let added = 0;
    for (const uid of ids) {
      const ins = await c.query('INSERT INTO int_education_records(requirement_id, body_id, user_id, version, assigned_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id', [r.id, r.body_id, uid, r.version, user.id]);
      if (ins.rowCount) { added++; await tell(c, uid, { id: r.id, subject_id: uid, row_version: `edu${r.version}` }, { guardians: true }); }
    }
    await log(c, r.body_id, null, 'education', r.id, 'assigned', { actor: user.id, detail: { people: ids.length, added } });
    return { assigned: added, already_assigned: ids.length - added };
  }),
});
cap({
  name: 'complete_education_requirement', method: 'POST', path: '/integrity/education-records/:id/complete', tag: TAG, scope: SCOPE,
  summary: 'Record a completion or acknowledgement with its date and a certificate or evidence reference: the person themself (or their guardian), or an integrity officer on their behalf. The expiry is set from the requirement. Completion is a record, not proof of broader compliance.',
  input: z.object({ id, completed_on: day.optional(), evidence_ref: text(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query('SELECT r.*, e.valid_months FROM int_education_records r JOIN int_education_requirements e ON e.id=r.requirement_id WHERE r.id=$1 FOR UPDATE OF r', [i.id])).rows[0];
    if (!r) throw notFound('Record');
    const self = r.user_id === user.id || await isGuardianOf(user.id, r.user_id, c);
    if (!self && !(await officerOf(user, r.body_id, { c }))) throw notFound('Record');
    const on = i.completed_on ?? today();
    if (on > today()) throw badRequest('The completion date is in the future');
    const exp = r.valid_months ? (() => { const d = new Date(`${on}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + r.valid_months); return d.toISOString().slice(0, 10); })() : null;
    await c.query("UPDATE int_education_records SET status='completed', completed_on=$2, evidence_ref=$3, expires_on=$4 WHERE id=$1", [r.id, on, i.evidence_ref ?? null, exp]);
    await log(c, r.body_id, null, 'education', r.id, 'completed', { actor: user.id, detail: { by: self ? 'self' : 'officer', version: r.version } });
    return { ok: true, completed_on: on, expires_on: exp };
  }),
});
cap({
  name: 'list_education_requirements', method: 'GET', path: '/integrity/bodies/:id/education', tag: TAG, scope: SCOPE,
  summary: 'Education requirements with plain counts (assigned, completed, expired) and, per requirement, who still has to complete it (integrity officers). Counts of work only: no per-person score or ranking.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await needOfficer(user, i.id);
    const reqs = await many(
      `SELECT e.id, e.title, e.version, e.programme_id, p.title AS programme_title, e.sport_id, e.valid_months, e.status,
              count(r.id) FILTER (WHERE r.version=e.version)::int AS assigned, count(r.id) FILTER (WHERE r.version=e.version AND r.status='completed' AND (r.expires_on IS NULL OR r.expires_on >= current_date))::int AS completed,
              count(r.id) FILTER (WHERE r.status='completed' AND r.expires_on < current_date)::int AS expired
         FROM int_education_requirements e LEFT JOIN programmes p ON p.id=e.programme_id LEFT JOIN int_education_records r ON r.requirement_id=e.id WHERE e.body_id=$1 GROUP BY e.id, p.title ORDER BY e.status, e.title`, [i.id]);
    const outstanding = await many(
      `SELECT r.id, r.requirement_id, r.user_id, u.display_name, r.version, r.status, r.expires_on::text AS expires_on FROM int_education_records r JOIN users u ON u.id=r.user_id JOIN int_education_requirements e ON e.id=r.requirement_id
        WHERE r.body_id=$1 AND e.status='active' AND (r.status='assigned' OR r.expires_on < current_date) ORDER BY u.display_name LIMIT 200`, [i.id]);
    return { items: reqs, outstanding };
  },
});

// ------------------------------------------------------------------ conflict / betting declarations
cap({
  name: 'submit_integrity_declaration', method: 'POST', path: '/integrity/bodies/:id/declarations', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Declare a conflict or a betting interest to a governing body that has switched declarations on (it defines a betting/conflict category). You give the purpose and how long it may be kept; only you and the body\'s integrity officers can read it. Declared interests only: no betting history is gathered or inferred.',
  input: z.object({ id, kind: z.enum(['conflict', 'betting_interest']), purpose: text(300).min(5), detail: text(2000).min(3), retain_until: day }),
  handler: ({ user }, i) => tx(async (c) => {
    mustBeActive(await bodyById(i.id, c));
    if (!(await c.query("SELECT 1 FROM int_categories WHERE body_id=$1 AND kind='betting_conflict' AND status='active'", [i.id])).rowCount) throw notFound('Governing body');
    if (i.retain_until < today() || i.retain_until > addDays(today(), 3660)) throw badRequest('Choose a retention date within the next ten years');
    const row = (await c.query('INSERT INTO int_declarations(body_id, user_id, kind, purpose, detail_enc, retain_until) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, purpose, retain_until::text AS retain_until, status, created_at', [i.id, user.id, i.kind, i.purpose, encrypt(i.detail, 'int_declarations.detail'), i.retain_until])).rows[0];
    await log(c, i.id, null, 'declaration', row.id, 'submitted', { actor: user.id, detail: { kind: i.kind } });
    return row;
  }),
});
cap({
  name: 'withdraw_integrity_declaration', method: 'POST', path: '/integrity/declarations/:id/withdraw', tag: TAG, scope: SCOPE,
  summary: 'Withdraw your declaration. It stays in the history but is no longer shown as current.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const d = (await c.query("UPDATE int_declarations SET status='withdrawn', withdrawn_at=now() WHERE id=$1 AND user_id=$2 AND status='active' RETURNING body_id, id", [i.id, user.id])).rows[0];
    if (!d) throw notFound('Declaration');
    await log(c, d.body_id, null, 'declaration', d.id, 'withdrawn', { actor: user.id });
    return { ok: true };
  }),
});
cap({
  name: 'list_integrity_declarations', method: 'GET', path: '/integrity/bodies/:id/declarations', tag: TAG, scope: SCOPE,
  summary: 'Declarations made to the body (integrity officers; audit-logged). Past their retention date a declaration is listed without its content.',
  input: z.object({ id, kind: z.enum(['conflict', 'betting_interest']).optional(), ...page }),
  async handler({ user }, i) {
    await needOfficer(user, i.id);
    const rows = await many("SELECT d.id, d.user_id, u.display_name, d.kind, d.purpose, d.detail_enc, d.retain_until::text AS retain_until, d.status, d.created_at, (d.retain_until < current_date) AS retention_ended FROM int_declarations d JOIN users u ON u.id=d.user_id WHERE d.body_id=$1 AND ($2::text IS NULL OR d.kind=$2) ORDER BY d.created_at DESC LIMIT $3 OFFSET $4", [i.id, i.kind ?? null, i.limit, i.offset]);
    if (rows.some((r) => !r.retention_ended && r.status === 'active')) await audit(null, user.id, 'integrity_declarations_read', 'governing_bodies', i.id);
    return { items: rows.map(({ detail_enc, ...r }) => ({ ...r, detail: r.retention_ended || r.status !== 'active' ? null : decrypt(detail_enc, 'int_declarations.detail') })) };
  },
});
