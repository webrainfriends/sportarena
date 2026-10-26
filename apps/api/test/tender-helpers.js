// Shared fixtures for the tender-zone suites. Every test creates its own people, organisation and tenders; nothing is seeded.
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
export const { pool } = await import('../src/db.js');
export const { migrate } = await import('../src/migrate.js');
export const { createApp } = await import('../src/http.js');

let server, base, n = 0;
export const start = async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; };
export const stop = async () => { server.close(); await pool.end(); };

export const call = async (method, path, { token, body, raw, headers } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const buf = Buffer.from(await r.arrayBuffer()); // binary-safe: PDFs and files must not pass through a text decoder
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: r.status, body: json, text, headers: r.headers, buf };
};
export const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body ?? r.text).slice(0, 600)); return r.body; };

export const signup = async (label, roles = ['athlete']) => {
  n++;
  const r = await call('POST', '/auth/register', { body: { handle: `${label}_${n}`, display_name: `${label} ${n}`, email: `${label}${n}@example.com`, password: 'correct-horse-battery', roles } });
  ok(r, 201);
  return { ...r.body.user, token: r.body.token };
};

export const inAt = (days, hours = 0) => new Date(Date.now() + days * 864e5 + hours * 36e5).toISOString();
export const dateOf = (days) => inAt(days).slice(0, 10);

/** An organisation with an owner, plus extra people as active members with the given org role. */
export async function orgWith(owner, members = []) {
  const org = ok(await call('POST', '/organisations', { token: owner.token, body: { name: `Org ${n++}`, kind: 'club' } }), 201);
  for (const m of members) await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at, invited_by) VALUES ($1,$2,$3,'active',now(),$4)", [org.id, m.user.id, m.role ?? 'finance', owner.id]);
  return org;
}

/** Organisation + mandated approver, ready to run tenders. */
export async function buyerSide() {
  const owner = await signup('buyer', ['organizer']), approver = await signup('approver', ['organizer']);
  const org = await orgWith(owner, [{ user: approver, role: 'finance' }]);
  ok(await call('POST', '/procurement/mandates', { token: owner.token, body: { organisation_id: org.id, handle: approver.handle, role: 'approver' } }), 201);
  return { owner, approver, org };
}

export const lots = [
  { code: 'L1', title: 'Pitch preparation', qty: 2, unit: 'site', estimate_minor: 500000 },
  { code: 'L2', title: 'Ground crew', qty: 36, unit: 'person-shift', estimate_minor: 900000 },
];
export const rubric = (over = {}) => ({ weights: { technical: 60, commercial: 40 }, technical_pass_mark: 50, min_reviewers: 1, commercial_method: 'lowest_ratio', na_policy: 'exclude_and_reweight', tie_break: ['commercial_score', 'technical_score', 'earlier_submission'],
  criteria: [{ key: 'scope', title: 'Scope compliance', weight: 60, scale_min: 0, scale_max: 10, evidence_required: false }, { key: 'safety', title: 'Safety and readiness', weight: 40, scale_min: 0, scale_max: 10, evidence_required: false, min_normalised: 30 }], ...over });
export const questions = [
  { key: 'approach', section: 'technical', prompt: 'Describe your approach', type: 'text', required: true },
  { key: 'safeguarding', section: 'qualification', prompt: 'Are all crew safeguarding trained?', type: 'yes_no', required: true, pass_fail: true, pass_value: true },
];

/** Run the whole authoring path for a tender and return it published. People: owner (org owner), approver (mandated org member). */
export async function publishedTender({ owner, approver, org, over = {}, extra = {} }) {
  const t = ok(await call('POST', '/rfps', { token: owner.token, body: { kind: 'rfp', title: 'Pitch and crew tender', category: 'Ground maintenance', organisation_id: org.id, timezone: 'Asia/Kolkata' } }), 201);
  ok(await call('POST', `/rfps/${t.id}/members`, { token: owner.token, body: { handle: approver.handle, role: 'approver' } }));
  const upd = ok(await call('PATCH', `/rfps/${t.id}`, { token: owner.token, body: { row_version: t.row_version, scope: 'Prepare two pitches and provide a crew.', objective: 'Match readiness', service_start: dateOf(40), service_end: dateOf(45), closes_at: inAt(10), clarification_deadline: inAt(5), budget_minor: 5000000, currency: 'INR', lots, questions, rubric: rubric(), quorum: 1, publication: 'public', ...over } }));
  const v = ok(await call('POST', `/rfps/${t.id}/validate`, { token: owner.token }));
  assert.ok(v.ok, JSON.stringify(v.issues));
  const ap = ok(await call('POST', `/rfps/${t.id}/request-approval`, { token: owner.token }));
  ok(await call('POST', `/approvals/${ap.id}/decide`, { token: approver.token, body: { decision: 'approve' } }));
  const pub = ok(await call('POST', `/rfps/${t.id}/publish`, { token: owner.token }));
  return { ...pub, row_version: upd.row_version };
}

export async function supplierEntity(user, name, extra = {}) {
  return ok(await call('POST', '/supplier-entities', { token: user.token, body: { kind: 'company', legal_name: name, categories: ['Ground maintenance'], currencies: ['INR'], ...extra } }), 201);
}
export const part = async (user, tender, entity) => {
  ok(await call('POST', `/tenders/${tender.id}/participation`, { token: user.token, body: { entity_id: entity.id, action: 'interest' } }));
  ok(await call('POST', `/tenders/${tender.id}/participation`, { token: user.token, body: { entity_id: entity.id, action: 'accept_terms' } }));
};
export const goodDraft = (price = 100000) => ({ technical: { answers: { approach: 'We prepare pitches with a trained crew and a method statement.', safeguarding: true }, evidence: {}, subcontractors: [], attachments: [] },
  commercial: { lines: [{ lot_code: 'L1', qty: '2', unit: 'site', rate_minor: price * 5, tax_bp: 1800, discount_bp: 0, tax_inclusive: false }, { lot_code: 'L2', qty: '36', unit: 'person-shift', rate_minor: price, tax_bp: 1800, discount_bp: 0, tax_inclusive: false }], answers: {}, validity_days: 60, attachments: [] } });
export async function submitBid(user, tender, entity, price, key) {
  const pr = ok(await call('POST', `/tenders/${tender.id}/proposals`, { token: user.token, body: { entity_id: entity.id, lots: ['L1', 'L2'] } }), 201);
  const d = ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: user.token, body: { draft_version: pr.draft_version, ...goodDraft(price) } }));
  const r = ok(await call('POST', `/proposals/${pr.id}/submit`, { token: user.token, body: { idempotency_key: key ?? `key-${pr.id}-1`, declaration: true } }));
  return { proposal: pr, receipt: r };
}
export const closeNow = (tenderId) => pool.query("UPDATE proc_projects SET closes_at = now() - interval '1 minute', clarification_deadline = now() - interval '1 day', opens_at = NULL WHERE id=$1", [tenderId]);

/** A two-envelope tender with a chair, a technical reviewer, an opener (quorum 2), an auditor and suppliers A, B and C. */
export async function world(over = {}, suppliers = [['A', 100000], ['B', 90000], ['C', 50000]], entExtra = {}) {
  const b = await buyerSide();
  const chair = await signup('chair', ['organizer']), tech = await signup('tech', ['organizer']), opener = await signup('opener', ['organizer']), auditor = await signup('auditor', ['organizer']);
  const t = await publishedTender({ owner: b.owner, approver: b.approver, org: b.org, over: { quorum: 2, envelope_mode: 'sealed_dual', ...over } });
  for (const [u, role] of [[chair, 'chair'], [tech, 'technical_evaluator'], [opener, 'opener'], [auditor, 'auditor']]) ok(await call('POST', `/rfps/${t.id}/members`, { token: b.owner.token, body: { handle: u.handle, role } }));
  const sup = {};
  for (const [k, price] of suppliers) {
    const user = await signup(`sup${k}`, ['supplier']); const ent = await supplierEntity(user, `Supplier ${k} Ltd`, entExtra);
    await part(user, t, ent); sup[k] = { user, ent, price };
  }
  return { ...b, chair, tech, opener, auditor, t, sup };
}
export async function bids(w, { cBad = true, keys = Object.keys(w.sup) } = {}) {
  for (const k of keys) {
    const s = w.sup[k];
    const pr = ok(await call('POST', `/tenders/${w.t.id}/proposals`, { token: s.user.token, body: { entity_id: s.ent.id, lots: ['L1', 'L2'] } }), 201);
    const d = goodDraft(s.price); if (k === 'C' && cBad) d.technical.answers.safeguarding = false;
    ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.user.token, body: { draft_version: pr.draft_version, ...d } }));
    s.pid = pr.id; s.receipt = ok(await call('POST', `/proposals/${pr.id}/submit`, { token: s.user.token, body: { idempotency_key: `bid-${k}-${pr.id}`, declaration: true } }));
  }
}
/** Close, open both envelopes with quorum, score, sign off and commit the ranking. Returns nothing; use the world for the next steps. */
export async function evaluate(w, { marks = { A: [9, 8], B: [6, 6], C: [5, 5] }, keys = Object.keys(w.sup), commit = true } = {}) {
  await closeNow(w.t.id);
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'technical' } }));
  ok(await call('POST', `/rfps/${w.t.id}/conflicts`, { token: w.tech.token, body: { has_conflict: false } }));
  ok(await call('POST', `/rfps/${w.t.id}/assignments`, { token: w.owner.token, body: { assignments: [{ handle: w.tech.handle, section: 'technical' }] } }));
  for (const k of keys) {
    const el = (await pool.query('SELECT eligibility FROM proc_proposals WHERE id=$1', [w.sup[k].pid])).rows[0].eligibility;
    if (el !== 'eligible') continue;
    for (const [i, c] of ['scope', 'safety'].entries()) ok(await call('POST', `/rfps/${w.t.id}/scores`, { token: w.tech.token, body: { proposal_id: w.sup[k].pid, criterion_key: c, score: marks[k][i], rationale: `Scored ${c} from the submitted evidence`, lock: true } }), 201);
    ok(await call('POST', `/rfps/${w.t.id}/proposals/${w.sup[k].pid}/technical-signoff`, { token: w.chair.token, body: { result: 'pass' } }));
  }
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'commercial' } }));
  if (commit) ok(await call('POST', `/rfps/${w.t.id}/ranking/commit`, { token: w.chair.token, body: {} }), 201);
}
/** Recommend, approve, issue and accept an award for everything in a scenario. Returns the award id and orders. */
export async function awardAll(w, kind = 'highest_score', acceptBy) {
  const sc = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind } }), 201);
  const rec = ok(await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'Best scoring compliant bidder covering every lot.' } }), 201);
  ok(await call('POST', `/approvals/${rec.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  ok(await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} }));
  const award = ok(await call('GET', `/awards/${rec.id}`, { token: w.chair.token }));
  if (acceptBy) for (const l of award.lines) ok(await call('POST', `/award-lines/${l.id}/respond`, { token: acceptBy.token, body: { action: 'accept' } }));
  return { rec, award };
}
