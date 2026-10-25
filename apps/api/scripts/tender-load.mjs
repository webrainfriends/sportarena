// Tender zone load profile (docs/tender-zone.md, "Performance"). Builds a large tender on a throwaway database through the real API and prints
// p50/p95/max per operation next to the budget. Run:  TEST_DATABASE_URL=postgres://.../throwaway node --import ./test/setup.js scripts/tender-load.mjs
// Profile: 300 published tenders for discovery; one tender with 40 lots, 12 questions, 60 suppliers each submitting a fully priced 40-lot proposal
// with an attachment, 8 reviewers scoring 6 criteria for every eligible bid, then ranking, scenarios and an award across all 40 lots.
import { performance } from 'node:perf_hooks';
import { call, ok, signup, start, stop, pool, buyerSide, publishedTender, supplierEntity, part, inAt, dateOf, closeNow, rubric as mkRubric } from '../test/tender-helpers.js';

const BUDGET = { list_tenders: 400, get_tender: 400, submit_proposal: 1500, open_envelope: 8000, get_ranking: 1500, build_scenario: 2500, issue_award: 3000 };
const stats = {};
const time = async (name, fn) => { const t = performance.now(); const r = await fn(); (stats[name] ??= []).push(performance.now() - t); return r; };
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
const pool_ = async (n, fns) => { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < fns.length) { const k = i++; out[k] = await fns[k](); } })); return out; };

await start();
const b = await buyerSide();
const LOTS = Array.from({ length: 40 }, (_, i) => ({ code: `L${i + 1}`, title: `Service lot ${i + 1}`, qty: 10, unit: 'shift', estimate_minor: 100000 }));
const CRIT = Array.from({ length: 6 }, (_, i) => ({ key: `c${i + 1}`, title: `Criterion ${i + 1}`, weight: i < 4 ? 17 : 16, scale_min: 0, scale_max: 10, evidence_required: false }));
const QS = Array.from({ length: 12 }, (_, i) => ({ key: `q${i + 1}`, section: 'technical', prompt: `Question ${i + 1}`, type: 'text', required: true }));

// 300 tenders for discovery (cloned rows: this measures list/search, not authoring)
const seed = await publishedTender({ owner: b.owner, approver: b.approver, org: b.org });
await pool.query(`INSERT INTO proc_projects(ref, kind, organisation_id, owner_user_id, title, category, scope, currency, status, publication, published_at, closes_at, timezone, rubric, rubric_version)
  SELECT 'TND-LOAD-' || g, 'rfp', organisation_id, owner_user_id, 'Load tender ' || g, (ARRAY['Ground maintenance','Pool maintenance','Crew','Wi-Fi'])[1 + g % 4], 'Scope text for load', 'INR', 'published', 'public', now(), now() + interval '10 days', 'UTC', rubric, 1 FROM proc_projects, generate_series(1, 300) g WHERE id=$1`, [seed.id]);
const viewer = await signup('viewer', ['supplier']); await supplierEntity(viewer, 'Viewer Ltd');
await pool.query('ANALYZE');
await pool_(20, Array.from({ length: 200 }, (_, i) => () => time('list_tenders', async () => ok(await call('GET', `/tenders?limit=25&offset=${(i % 8) * 25}${i % 3 ? '&category=Pool%20maintenance' : ''}`, { token: viewer.token })))));
await pool_(20, Array.from({ length: 100 }, () => () => time('get_tender', async () => ok(await call('GET', `/tenders/${seed.id}`, { token: viewer.token })))));

// the big tender
const t0 = ok(await call('POST', '/rfps', { token: b.owner.token, body: { kind: 'rfp', title: 'Large multi-lot tender', category: 'Ground maintenance', organisation_id: b.org.id } }), 201);
ok(await call('POST', `/rfps/${t0.id}/members`, { token: b.owner.token, body: { handle: b.approver.handle, role: 'approver' } }));
ok(await call('PATCH', `/rfps/${t0.id}`, { token: b.owner.token, body: { row_version: t0.row_version, scope: 'Large scope', service_start: dateOf(40), service_end: dateOf(60), closes_at: inAt(10), clarification_deadline: inAt(5), lots: LOTS, questions: QS, rubric: mkRubric({ weights: { technical: 60, commercial: 40 }, criteria: CRIT }), quorum: 1, envelope_mode: 'sealed_dual', budget_minor: 100000000 } }));
const ap = ok(await call('POST', `/rfps/${t0.id}/request-approval`, { token: b.owner.token }));
ok(await call('POST', `/approvals/${ap.id}/decide`, { token: b.approver.token, body: { decision: 'approve' } }));
ok(await call('POST', `/rfps/${t0.id}/publish`, { token: b.owner.token }));
const chair = await signup('chair', ['organizer']), opener = await signup('opener', ['organizer']);
const reviewers = []; for (let i = 0; i < 8; i++) reviewers.push(await signup('rev', ['organizer']));
for (const [u, role] of [[chair, 'chair'], [opener, 'opener'], ...reviewers.map((u) => [u, 'technical_evaluator'])]) ok(await call('POST', `/rfps/${t0.id}/members`, { token: b.owner.token, body: { handle: u.handle, role } }));
const sups = []; for (let i = 0; i < 60; i++) { const u = await signup('s', ['supplier']); const e = await supplierEntity(u, `Load Supplier ${i + 1}`); await part(u, { id: t0.id }, e); sups.push({ u, e, price: 1000 + i * 7 }); }
const answers = Object.fromEntries(QS.map((q) => [q.key, 'A complete and specific answer to the question.']));
await pool_(20, sups.map((s) => async () => {
  const pr = ok(await call('POST', `/tenders/${t0.id}/proposals`, { token: s.u.token, body: { entity_id: s.e.id, lots: LOTS.map((l) => l.code) } }), 201);
  await call('PUT', `/proposals/${pr.id}/files?envelope=technical&name=method.pdf`, { token: s.u.token, raw: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF') });
  ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.u.token, body: { draft_version: pr.draft_version, technical: { answers, evidence: {}, subcontractors: [], attachments: [] }, commercial: { lines: LOTS.map((l) => ({ lot_code: l.code, qty: '10', unit: 'shift', rate_minor: s.price, tax_bp: 1800, discount_bp: 0, tax_inclusive: false })), answers: {}, validity_days: 60, attachments: [] } } }));
  s.pid = pr.id;
  await time('submit_proposal', async () => ok(await call('POST', `/proposals/${pr.id}/submit`, { token: s.u.token, body: { idempotency_key: `load-${pr.id}`, declaration: true } })));
}));
await closeNow(t0.id);
await time('open_envelope', async () => ok(await call('POST', `/rfps/${t0.id}/open`, { token: opener.token, body: { envelope: 'technical' } })));
for (const r of reviewers) ok(await call('POST', `/rfps/${t0.id}/conflicts`, { token: r.token, body: { has_conflict: false } }));
ok(await call('POST', `/rfps/${t0.id}/assignments`, { token: b.owner.token, body: { assignments: reviewers.map((r) => ({ handle: r.handle, section: 'technical' })) } }));
await pool_(16, sups.flatMap((s) => reviewers.slice(0, 2).flatMap((r) => CRIT.map((c) => () => call('POST', `/rfps/${t0.id}/scores`, { token: r.token, body: { proposal_id: s.pid, criterion_key: c.key, score: 6 + (s.price % 4), rationale: 'Scored against the evidence provided.', lock: true } })))));
for (const r of reviewers.slice(2)) await call('POST', `/rfps/${t0.id}/recuse`, { token: r.token, body: { reason: 'Not needed for this load profile' } });
await pool_(16, sups.map((s) => () => call('POST', `/rfps/${t0.id}/proposals/${s.pid}/technical-signoff`, { token: chair.token, body: { result: 'pass' } })));
ok(await call('POST', `/rfps/${t0.id}/open`, { token: opener.token, body: { envelope: 'commercial' } }));
for (let i = 0; i < 20; i++) await time('get_ranking', async () => ok(await call('GET', `/rfps/${t0.id}/ranking`, { token: chair.token })));
ok(await call('POST', `/rfps/${t0.id}/ranking/commit`, { token: chair.token, body: {} }), 201);
const sc = await time('build_scenario', async () => ok(await call('POST', `/rfps/${t0.id}/scenarios`, { token: chair.token, body: { kind: 'split_by_lot' } }), 201));
const rec = ok(await call('POST', `/rfps/${t0.id}/awards`, { token: chair.token, body: { scenario_id: sc.id, rationale: 'Highest scoring supplier for each lot within budget.', allow_partial: true } }), 201);
ok(await call('POST', `/approvals/${rec.approval_id}/decide`, { token: b.approver.token, body: { decision: 'approve' } }));
await time('issue_award', async () => ok(await call('POST', `/awards/${rec.id}/notify`, { token: chair.token, body: {} })));

console.log(`\nprofile: 300 tenders, 40 lots, 12 questions, 60 suppliers x 40 priced lots + attachment, 8 reviewers (2 scoring), solver: ${sc.solver}`);
console.log('operation'.padEnd(18), 'n'.padStart(4), 'p50'.padStart(8), 'p95'.padStart(8), 'max'.padStart(8), 'budget p95'.padStart(11), ' result');
let bad = 0;
for (const [k, a] of Object.entries(stats)) { const p95 = pct(a, 95); const pass = p95 <= BUDGET[k]; if (!pass) bad++; console.log(k.padEnd(18), String(a.length).padStart(4), `${pct(a, 50).toFixed(0)}ms`.padStart(8), `${p95.toFixed(0)}ms`.padStart(8), `${Math.max(...a).toFixed(0)}ms`.padStart(8), `${BUDGET[k]}ms`.padStart(11), pass ? ' within budget' : ' OVER BUDGET'); }
await stop();
process.exit(bad ? 1 : 0);
