import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, signup, start, stop, pool, buyerSide, publishedTender, supplierEntity, part, submitBid, inAt, dateOf, goodDraft, closeNow } from './tender-helpers.js';

before(start);
after(stop);

/** A two-envelope tender with a chair, a technical reviewer, an opener (quorum 2) and three suppliers (C fails a pass/fail requirement). */
async function world(over = {}) {
  const b = await buyerSide();
  const chair = await signup('chair', ['organizer']), tech = await signup('tech', ['organizer']), opener = await signup('opener', ['organizer']), auditor = await signup('auditor', ['organizer']);
  const t = await publishedTender({ owner: b.owner, approver: b.approver, org: b.org, over: { quorum: 2, envelope_mode: 'sealed_dual', ...over } });
  for (const [u, role] of [[chair, 'chair'], [tech, 'technical_evaluator'], [opener, 'opener'], [auditor, 'auditor']]) ok(await call('POST', `/rfps/${t.id}/members`, { token: b.owner.token, body: { handle: u.handle, role } }));
  const sup = {};
  for (const [k, price] of [['A', 100000], ['B', 90000], ['C', 50000]]) {
    const user = await signup(`sup${k}`, ['supplier']); const ent = await supplierEntity(user, `Supplier ${k} Ltd`);
    await part(user, t, ent); sup[k] = { user, ent, price };
  }
  return { ...b, chair, tech, opener, auditor, t, sup };
}
async function bids(w, { cBad = true } = {}) {
  for (const k of ['A', 'B', 'C']) {
    const s = w.sup[k];
    const pr = ok(await call('POST', `/tenders/${w.t.id}/proposals`, { token: s.user.token, body: { entity_id: s.ent.id, lots: ['L1', 'L2'] } }), 201);
    const d = goodDraft(s.price); if (k === 'C' && cBad) d.technical.answers.safeguarding = false;
    const sv = ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.user.token, body: { draft_version: pr.draft_version, ...d } }));
    s.pid = pr.id; s.receipt = ok(await call('POST', `/proposals/${pr.id}/submit`, { token: s.user.token, body: { idempotency_key: `bid-${k}-${pr.id}`, declaration: true } }));
  }
}

test('deadline: before / at / after close, delayed revision, withdrawal, extension, suspension and an approved late window', async () => {
  const w = await world();
  const s = w.sup.A;
  const pr = ok(await call('POST', `/tenders/${w.t.id}/proposals`, { token: s.user.token, body: { entity_id: s.ent.id, lots: ['L1', 'L2'] } }), 201);
  const d = ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.user.token, body: { draft_version: pr.draft_version, ...goodDraft(1000) } }));
  const submit = (key) => call('POST', `/proposals/${pr.id}/submit`, { token: s.user.token, body: { idempotency_key: key, declaration: true } });
  const r1 = ok(await submit('before-close-1'));
  assert.equal(r1.late, false);
  // at the deadline instant the tender is already closed
  await pool.query('UPDATE proc_projects SET closes_at = now() WHERE id=$1', [w.t.id]);
  const at = await submit('at-close-1'); assert.equal(at.status, 409); assert.match(at.body.error.message, /deadline has passed/);
  assert.equal((await call('POST', `/proposals/${pr.id}/withdraw`, { token: s.user.token, body: {} })).status, 409, 'cannot withdraw after close');
  assert.equal((await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.user.token, body: { draft_version: 3, ...goodDraft(900) } })).status, 409, 'delayed revision is refused');
  // before close: withdraw, then resubmit (revisions allowed)
  await pool.query("UPDATE proc_projects SET closes_at = now() + interval '1 hour' WHERE id=$1", [w.t.id]);
  ok(await call('POST', `/proposals/${pr.id}/withdraw`, { token: s.user.token, body: {} }));
  assert.equal((await pool.query('SELECT eligibility FROM proc_proposals WHERE id=$1', [pr.id])).rows[0].eligibility, 'withdrawn');
  const r2 = ok(await submit('after-withdraw-1')); assert.equal(r2.version, 2);
  // extension before close is immediate and audited; extension after close needs approval
  ok(await call('POST', `/rfps/${w.t.id}/schedule`, { token: w.owner.token, body: { action: 'extend', reason: 'More time for site visits', new_closes_at: inAt(20) } }));
  assert.equal((await call('POST', `/rfps/${w.t.id}/schedule`, { token: w.owner.token, body: { action: 'extend', reason: 'hm', new_closes_at: inAt(21) } })).status, 400, 'a reason is required');
  // suspension blocks submissions; resume extends by the time suspended
  ok(await call('POST', `/rfps/${w.t.id}/schedule`, { token: w.owner.token, body: { action: 'suspend', reason: 'Platform outage drill' } }));
  const susp = await submit('during-suspension'); assert.equal(susp.status, 409, JSON.stringify(susp.body));
  const before = (await pool.query('SELECT closes_at FROM proc_projects WHERE id=$1', [w.t.id])).rows[0].closes_at;
  await new Promise((r) => setTimeout(r, 300));
  ok(await call('POST', `/rfps/${w.t.id}/schedule`, { token: w.owner.token, body: { action: 'resume', reason: 'Outage resolved' } }));
  const after = (await pool.query('SELECT closes_at FROM proc_projects WHERE id=$1', [w.t.id])).rows[0].closes_at;
  assert.ok(new Date(after) > new Date(before), 'resume gives back the suspended time');
  // closed, then an approved one-supplier late window allows a flagged late submission
  await pool.query("UPDATE proc_projects SET closes_at = now() - interval '1 minute' WHERE id=$1", [w.t.id]);
  assert.equal((await submit('late-submit-1')).status, 409);
  const lw = ok(await call('POST', `/rfps/${w.t.id}/schedule`, { token: w.owner.token, body: { action: 'late_window', reason: 'Documented connectivity failure', entity_id: s.ent.id, until: inAt(1) } }));
  ok(await call('POST', `/approvals/${lw.id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  const late = ok(await submit('late-submit-2')); assert.equal(late.late, true);
  const audit = ok(await call('GET', `/rfps/${w.t.id}/audit?limit=100`, { token: w.owner.token }));
  assert.equal(audit.chain_broken_at, null);
  assert.ok(audit.entries.some((e) => e.action === 'deadline_extended') && audit.entries.some((e) => e.action === 'late_window_granted'));
  await assert.rejects(pool.query("UPDATE proc_audit SET action='x' WHERE project_id=$1", [w.t.id]), /append-only/);
});

test('sealing: nothing readable before the deadline or the quorum opening, by any path, and technical reviewers never see prices', async () => {
  const w = await world();
  await bids(w);
  const A = w.sup.A;
  // before the deadline
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${A.pid}/content?envelope=technical`, { token: w.chair.token })).status, 403);
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${A.pid}/content?envelope=commercial`, { token: w.owner.token })).status, 403);
  const early = ok(await call('GET', `/rfps/${w.t.id}/submissions`, { token: w.tech.token })); assert.deepEqual(early.items, []);
  assert.equal((await call('POST', `/rfps/${w.t.id}/open`, { token: w.opener.token, body: { envelope: 'technical' } })).status, 403, 'opening before the deadline is refused');
  const rank0 = ok(await call('GET', `/rfps/${w.t.id}/ranking`, { token: w.chair.token })); assert.equal(rank0.opened, false);
  // direct file URL: upload a technical PDF, buyers cannot fetch it before opening, the owning supplier can
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const up = ok(await call('PUT', `/proposals/${A.pid}/files?envelope=technical&name=method.pdf`, { token: A.user.token, raw: pdf }), 201);
  assert.equal((await call('GET', up.url.replace('/api/v1', ''), { token: w.chair.token })).status, 403);
  assert.equal((await call('GET', up.url.replace('/api/v1', ''), { token: A.user.token })).status, 200);
  assert.equal((await call('GET', up.url.replace('/api/v1', ''), { token: w.sup.B.user.token })).status, 404, 'a competitor cannot fetch it');
  const sheet = Buffer.from('PK\x03\x04[Content_Types].xml xl/workbook.xml');
  assert.equal((await call('PUT', `/proposals/${A.pid}/files?envelope=technical&name=prices.xlsx`, { token: A.user.token, raw: sheet })).status, 400, 'spreadsheets cannot sit in the technical envelope');
  assert.equal((await call('PUT', `/proposals/${A.pid}/files?envelope=technical&name=macro.docx`, { token: A.user.token, raw: Buffer.from('PK\x03\x04[Content_Types].xml word/vbaProject.bin') })).status, 400, 'macros are refused');
  // after the deadline but before opening
  await closeNow(w.t.id);
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${A.pid}/content?envelope=technical`, { token: w.chair.token })).status, 403);
  // quorum of 2: one vote is not enough, the same person voting twice does not count
  assert.equal(ok(await call('POST', `/rfps/${w.t.id}/open`, { token: w.opener.token, body: { envelope: 'technical' } })).opened, false);
  assert.equal(ok(await call('POST', `/rfps/${w.t.id}/open`, { token: w.opener.token, body: { envelope: 'technical' } })).opened, false);
  const done = ok(await call('POST', `/rfps/${w.t.id}/open`, { token: w.owner.token, body: { envelope: 'technical' } }));
  assert.equal(done.opened, true);
  assert.equal((await call('POST', `/rfps/${w.t.id}/open`, { token: w.owner.token, body: { envelope: 'technical' } })).status, 409, 'already open');
  await assert.rejects(pool.query("DELETE FROM proc_openings WHERE project_id=$1", [w.t.id]), /append-only/);
  const reg = ok(await call('GET', `/rfps/${w.t.id}/openings`, { token: w.auditor.token }));
  assert.equal(reg.openings[0].submissions.length, 3); assert.match(reg.openings[0].hash, /^[0-9a-f]{64}$/);
  // reviewers need a conflict declaration and an assignment; once allowed, technical is readable but commercial never to a technical reviewer
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${A.pid}/content?envelope=technical`, { token: w.tech.token })).status, 403, 'conflict declaration first');
  ok(await call('POST', `/rfps/${w.t.id}/conflicts`, { token: w.tech.token, body: { has_conflict: false } }));
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${A.pid}/content?envelope=technical`, { token: w.tech.token })).status, 403, 'assignment next');
  ok(await call('POST', `/rfps/${w.t.id}/assignments`, { token: w.owner.token, body: { assignments: [{ handle: w.tech.handle, section: 'technical', blind: true }] } }));
  const c1 = ok(await call('GET', `/rfps/${w.t.id}/proposals/${A.pid}/content?envelope=technical`, { token: w.tech.token }));
  assert.ok(/Bidder \d/.test(c1.supplier), 'blind reviewers do not see the supplier name');
  assert.equal(c1.content.answers.safeguarding, true);
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${A.pid}/content?envelope=commercial`, { token: w.tech.token })).status, 403);
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${A.pid}/content?envelope=commercial`, { token: w.chair.token })).status, 403, 'commercial stays sealed until sign-off and its own opening');
  assert.equal((await call('GET', up.url.replace('/api/v1', ''), { token: w.tech.token })).status, 200, 'technical file readable after opening');
  // suppliers never see competitors or ranking
  assert.equal((await call('GET', `/rfps/${w.t.id}/ranking`, { token: w.sup.B.user.token })).status, 404);
  assert.equal((await call('GET', `/rfps/${w.t.id}/submissions`, { token: w.sup.B.user.token })).status, 404);
  // every read is in the audit trail
  const audit = ok(await call('GET', `/rfps/${w.t.id}/audit?limit=100`, { token: w.auditor.token }));
  assert.ok(audit.entries.filter((e) => e.action === 'envelope_read').length >= 1);
  // supplier cannot see Q&A identities etc.: notifications carry no content
  const notes = await pool.query("SELECT body FROM notifications WHERE kind LIKE 'tender_%'");
  for (const n of notes.rows) assert.ok(!/rate_minor|price|₹/i.test(n.body), `notification leaks: ${n.body}`);
});

test('evaluation: eligibility gates, independent scoring, two-envelope unlock, reproducible ranking, ineligible bids never win', async () => {
  const w = await world();
  await bids(w);
  await closeNow(w.t.id);
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'technical' } }));
  const subs = ok(await call('GET', `/rfps/${w.t.id}/submissions`, { token: w.owner.token }));
  const byName = Object.fromEntries(subs.items.map((i) => [i.legal_name, i]));
  assert.equal(byName['Supplier C Ltd'].eligibility, 'ineligible'); assert.match(byName['Supplier C Ltd'].eligibility_reason, /requirements/);
  assert.equal(byName['Supplier A Ltd'].eligibility, 'eligible');
  ok(await call('POST', `/rfps/${w.t.id}/conflicts`, { token: w.tech.token, body: { has_conflict: false } }));
  ok(await call('POST', `/rfps/${w.t.id}/assignments`, { token: w.owner.token, body: { assignments: [{ handle: w.tech.handle, section: 'technical' }] } }));
  const score = (pid, criterion, s, lock = true) => call('POST', `/rfps/${w.t.id}/scores`, { token: w.tech.token, body: { proposal_id: pid, criterion_key: criterion, score: s, rationale: `Reviewed ${criterion} against the method statement`, lock } });
  assert.equal((await score(w.sup.C.pid, 'scope', 9)).status, 409, 'ineligible bids are not scored');
  assert.equal((await score(w.sup.A.pid, 'scope', 11)).status, 400, 'bounds enforced');
  ok(await score(w.sup.A.pid, 'scope', 9), 201); ok(await score(w.sup.A.pid, 'safety', 8, false), 201);
  assert.equal((await score(w.sup.A.pid, 'scope', 3)).status, 409, 'a locked score cannot be edited');
  // incomplete scores block the final ranking and the sign-off; missing is never zero
  let rk = ok(await call('GET', `/rfps/${w.t.id}/ranking`, { token: w.chair.token }));
  assert.equal(rk.final, false); assert.ok(rk.blockers.length >= 1);
  assert.equal((await call('POST', `/rfps/${w.t.id}/proposals/${w.sup.A.pid}/technical-signoff`, { token: w.chair.token, body: { result: 'pass' } })).status, 409);
  ok(await score(w.sup.A.pid, 'safety', 8), 201);
  ok(await score(w.sup.B.pid, 'scope', 6), 201); ok(await score(w.sup.B.pid, 'safety', 6), 201);
  // the commercial envelope cannot open until someone has passed the technical sign-off
  assert.equal((await call('POST', `/rfps/${w.t.id}/open`, { token: w.owner.token, body: { envelope: 'commercial' } })).status, 409);
  for (const k of ['A', 'B']) ok(await call('POST', `/rfps/${w.t.id}/proposals/${w.sup[k].pid}/technical-signoff`, { token: w.chair.token, body: { result: 'pass' } }));
  assert.equal((await call('POST', `/rfps/${w.t.id}/proposals/${w.sup.C.pid}/technical-signoff`, { token: w.chair.token, body: { result: 'pass' } })).status, 409, 'an ineligible bid cannot be signed off');
  // before the commercial opening, no costs and no final ranking
  rk = ok(await call('GET', `/rfps/${w.t.id}/ranking`, { token: w.chair.token }));
  assert.equal(rk.final, false); assert.ok(rk.rows.every((r) => !r.evaluated_cost));
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'commercial' } }));
  rk = ok(await call('GET', `/rfps/${w.t.id}/ranking`, { token: w.chair.token }));
  assert.equal(rk.final, true, JSON.stringify(rk.blockers));
  const row = (n) => rk.rows.find((r) => r.supplier === n);
  assert.equal(row('Supplier A Ltd').technical, 86); assert.equal(row('Supplier B Ltd').technical, 60);
  assert.equal(row('Supplier A Ltd').evaluated_cost.total_minor, 4600000); assert.equal(row('Supplier B Ltd').evaluated_cost.total_minor, 4140000);
  assert.equal(row('Supplier B Ltd').commercial, 100); assert.equal(row('Supplier A Ltd').commercial, 90);
  assert.equal(row('Supplier A Ltd').total, 87.6); assert.equal(row('Supplier B Ltd').total, 76);
  assert.equal(row('Supplier A Ltd').rank, 1); assert.equal(row('Supplier B Ltd').rank, 2);
  assert.equal(row('Supplier C Ltd').rank, null, 'the cheapest bid is ineligible and never ranks'); assert.equal(row('Supplier C Ltd').total, null);
  // a technical reviewer sees technical columns only
  const trk = ok(await call('GET', `/rfps/${w.t.id}/ranking`, { token: w.tech.token }));
  assert.ok(trk.rows.every((r) => r.total === undefined && r.evaluated_cost === undefined));
  // sensitivity is analysis only
  const sens = ok(await call('POST', `/rfps/${w.t.id}/ranking/sensitivity`, { token: w.chair.token, body: { alternatives: [{ technical: 10, commercial: 90 }] } }));
  assert.equal(sens.scenarios[0].changed, true); assert.equal(sens.official[0], w.sup.A.pid);
  // other reviewers' scores stay hidden until locked; chair consensus preserves originals
  const sc = ok(await call('GET', `/rfps/${w.t.id}/scores?proposal_id=${w.sup.A.pid}`, { token: w.chair.token }));
  assert.ok(sc.scores.length >= 2);
  ok(await call('POST', `/rfps/${w.t.id}/consensus`, { token: w.chair.token, body: { proposal_id: w.sup.A.pid, criterion_key: 'scope', score: 7, rationale: 'Panel agreed a lower figure after discussion' } }));
  const rk2 = ok(await call('GET', `/rfps/${w.t.id}/ranking`, { token: w.chair.token }));
  assert.equal(rk2.rows.find((r) => r.supplier === 'Supplier A Ltd').technical, (60 * 70 + 40 * 80) / 100);
  assert.equal((await pool.query("SELECT score::float AS s FROM proc_scores WHERE reviewer_id=$1 AND criterion_key='scope' AND submission_id=(SELECT current_submission_id FROM proc_proposals WHERE id=$2)", [w.tech.id, w.sup.A.pid])).rows[0].s, 9, 'the reviewer original is preserved');
  // a committed ranking is an immutable snapshot
  const snap = ok(await call('POST', `/rfps/${w.t.id}/ranking/commit`, { token: w.chair.token, body: {} }), 201);
  await assert.rejects(pool.query('UPDATE proc_rankings SET rubric_version=9 WHERE id=$1', [snap.id]), /append-only/);
  // disqualification needs a second person
  const dq = ok(await call('POST', `/rfps/${w.t.id}/proposals/${w.sup.B.pid}/status`, { token: w.chair.token, body: { action: 'disqualify', reason: 'Misrepresented crew qualifications in the method statement' } }));
  assert.equal((await call('POST', `/approvals/${dq.id}/decide`, { token: w.chair.token, body: { decision: 'approve' } })).status, 403);
  ok(await call('POST', `/approvals/${dq.id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  assert.equal((await pool.query('SELECT eligibility FROM proc_proposals WHERE id=$1', [w.sup.B.pid])).rows[0].eligibility, 'ineligible');
});

test('award: scenarios, human approval, atomic acceptance creates exactly one order and commitment, framework ceiling, debrief and appeal', async () => {
  const w = await world();
  await bids(w, { cBad: false });
  await closeNow(w.t.id);
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'technical' } }));
  ok(await call('POST', `/rfps/${w.t.id}/conflicts`, { token: w.tech.token, body: { has_conflict: false } }));
  ok(await call('POST', `/rfps/${w.t.id}/assignments`, { token: w.owner.token, body: { assignments: [{ handle: w.tech.handle, section: 'technical' }] } }));
  const mark = { A: [9, 8], B: [6, 6], C: [5, 5] };
  for (const k of ['A', 'B', 'C']) { for (const [i, c] of ['scope', 'safety'].entries()) ok(await call('POST', `/rfps/${w.t.id}/scores`, { token: w.tech.token, body: { proposal_id: w.sup[k].pid, criterion_key: c, score: mark[k][i], rationale: `Scored ${c} from the submitted evidence`, lock: true } }), 201); ok(await call('POST', `/rfps/${w.t.id}/proposals/${w.sup[k].pid}/technical-signoff`, { token: w.chair.token, body: { result: 'pass' } })); }
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'commercial' } }));
  // no scenario or award before a committed ranking
  assert.equal((await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'highest_score' } })).status, 409);
  ok(await call('POST', `/rfps/${w.t.id}/ranking/commit`, { token: w.chair.token, body: {} }), 201);
  const hs = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'highest_score' } }), 201);
  assert.equal(hs.solver, 'exhaustive'); assert.equal(hs.optimal, true); assert.equal(hs.coverage.filled, 2);
  assert.ok(hs.allocation.every((a) => a.entity === w.sup.A.ent.id));
  const lc = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'lowest_cost' } }), 201);
  assert.ok(lc.allocation.every((a) => a.entity === w.sup.C.ent.id), 'lowest compliant cost is C when C is eligible');
  const tight = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'highest_score', budget_minor: 1000 } }), 201);
  assert.equal(tight.feasible, false); assert.ok(tight.unfilled.length >= 1 || tight.violations.length >= 1);
  // recommendation needs approval by someone else; nothing exists until issued
  assert.equal((await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: tight.id, rationale: 'This should not be recommendable at all.' } })).status, 409);
  const rec = ok(await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: hs.id, rationale: 'Highest scoring bidder covering every lot within budget.' } }), 201);
  assert.equal((await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} })).status, 409, 'not approved yet');
  assert.equal((await call('POST', `/approvals/${rec.approval_id}/decide`, { token: w.chair.token, body: { decision: 'approve' } })).status, 403, 'requester cannot approve');
  ok(await call('POST', `/approvals/${rec.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  const notice = ok(await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: { accept_within_days: 7 } }));
  assert.equal(notice.status, 'notified');
  assert.equal((await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} })).status, 409, 'cannot issue twice');
  const award = ok(await call('GET', `/awards/${rec.id}`, { token: w.chair.token }));
  assert.equal(award.lines.length, 2); assert.ok(award.lines.every((l) => l.status === 'provisional' && l.supplier === 'Supplier A Ltd'));
  // provisional is not an order and not a commitment
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_orders WHERE project_id=$1', [w.t.id])).rows[0].n, 0);
  // only the winning entity's owner/signatory can respond; losers cannot
  assert.equal((await call('POST', `/award-lines/${award.lines[0].id}/respond`, { token: w.sup.B.user.token, body: { action: 'accept' } })).status, 404);
  // concurrent and repeated acceptance: exactly one order per line, one commitment per order
  const lineIds = award.lines.map((l) => l.id);
  const results = await Promise.all([lineIds[0], lineIds[0], lineIds[0], lineIds[1], lineIds[1]].map((id) => call('POST', `/award-lines/${id}/respond`, { token: w.sup.A.user.token, body: { action: 'accept' } })));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_orders WHERE project_id=$1', [w.t.id])).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_commitments c JOIN proc_orders o ON o.id=c.order_id WHERE o.project_id=$1', [w.t.id])).rows[0].n, 2);
  const done = ok(await call('GET', `/awards/${rec.id}`, { token: w.chair.token }));
  assert.equal(done.status, 'accepted');
  assert.equal((await pool.query('SELECT status FROM proc_projects WHERE id=$1', [w.t.id])).rows[0].status, 'awarded');
  // states stay separate: order confirmed, contract pending; completion needs the buyer and does not imply payment
  const orders = ok(await call('GET', `/procurement-orders?project_id=${w.t.id}`, { token: w.owner.token }));
  const ord = ok(await call('GET', `/procurement-orders/${orders[0].id}`, { token: w.owner.token }));
  assert.equal(ord.status, 'confirmed'); assert.equal(ord.contract_status, 'pending'); assert.equal(ord.award_line_status, 'accepted');
  assert.equal(ord.scope.supplier.legal_name, 'Supplier A Ltd'); assert.ok(ord.scope.submission.content_hash && ord.scope.award.approval_id);
  assert.equal((await call('POST', `/procurement-orders/${ord.id}/update`, { token: w.sup.A.user.token, body: { action: 'complete' } })).status, 403, 'a supplier cannot sign off its own work');
  // delivery is run on the linked service order (#520), so the contract record no longer starts or completes by hand
  assert.ok(ord.service_order?.id, 'acceptance creates the one service order');
  for (const [tok, action] of [[w.sup.A.user.token, 'start'], [w.owner.token, 'complete']]) assert.equal((await call('POST', `/procurement-orders/${ord.id}/update`, { token: tok, body: { action } })).status, 409);
  // debrief: a loser sees only their own result; no rank or bidder count unless disclosed
  const out = ok(await call('GET', `/proposals/${w.sup.B.pid}/outcome`, { token: w.sup.B.user.token }));
  assert.equal(out.technical.score, 60); assert.ok(!('rank' in out) && !('bidder_count' in out)); assert.ok(out.your_evaluated_cost);
  assert.ok(!JSON.stringify(out).includes('Supplier A') && !JSON.stringify(out).includes('4600000'), 'no competitor data');
  assert.equal((await call('GET', `/proposals/${w.sup.B.pid}/outcome`, { token: w.sup.A.user.token })).status, 404);
  const ap = ok(await call('POST', `/proposals/${w.sup.B.pid}/appeal`, { token: w.sup.B.user.token, body: { reason: 'Our safety evidence was not considered in scoring.' } }), 201);
  assert.equal((await call('POST', `/proposals/${w.sup.B.pid}/appeal`, { token: w.sup.B.user.token, body: { reason: 'Our safety evidence was not considered in scoring.' } })).status, 409);
  ok(await call('POST', `/appeals/${ap.id}/decide`, { token: w.chair.token, body: { outcome: 'dismissed', decision: 'Scores were based on the evidence provided.' } }));
});

test('framework: call-offs can never exceed the ceiling, are idempotent, and stay inside the service period', async () => {
  const w = await world({ contract_type: 'framework', ceiling_minor: 1000000 });
  for (const k of ['A']) { const s = w.sup[k]; const pr = ok(await call('POST', `/tenders/${w.t.id}/proposals`, { token: s.user.token, body: { entity_id: s.ent.id, lots: ['L1', 'L2'] } }), 201); ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.user.token, body: { draft_version: pr.draft_version, ...goodDraft(s.price) } })); s.pid = pr.id; ok(await call('POST', `/proposals/${pr.id}/submit`, { token: s.user.token, body: { idempotency_key: `fw-${pr.id}`, declaration: true } })); }
  await closeNow(w.t.id);
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'technical' } }));
  ok(await call('POST', `/rfps/${w.t.id}/conflicts`, { token: w.tech.token, body: { has_conflict: false } }));
  ok(await call('POST', `/rfps/${w.t.id}/assignments`, { token: w.owner.token, body: { assignments: [{ handle: w.tech.handle, section: 'technical' }] } }));
  for (const c of ['scope', 'safety']) ok(await call('POST', `/rfps/${w.t.id}/scores`, { token: w.tech.token, body: { proposal_id: w.sup.A.pid, criterion_key: c, score: 8, rationale: `Scored ${c} from the evidence`, lock: true } }), 201);
  ok(await call('POST', `/rfps/${w.t.id}/proposals/${w.sup.A.pid}/technical-signoff`, { token: w.chair.token, body: { result: 'pass' } }));
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'commercial' } }));
  ok(await call('POST', `/rfps/${w.t.id}/ranking/commit`, { token: w.chair.token, body: {} }), 201);
  const sc = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'single_supplier' } }), 201);
  const rec = ok(await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'Only eligible bidder covering every lot.' } }), 201);
  ok(await call('POST', `/approvals/${rec.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  ok(await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} }));
  const award = ok(await call('GET', `/awards/${rec.id}`, { token: w.chair.token }));
  for (const l of award.lines) ok(await call('POST', `/award-lines/${l.id}/respond`, { token: w.sup.A.user.token, body: { action: 'accept' } }));
  const orders = ok(await call('GET', `/procurement-orders?project_id=${w.t.id}`, { token: w.owner.token }));
  const total = orders.reduce((a, o) => a + Number(o.ceiling_minor), 0);
  assert.ok(Math.abs(total - 1000000) <= 2, 'the ceiling is shared across the awarded lots');
  const o = orders[0]; const ceiling = Number(o.ceiling_minor);
  const co = (amount, key) => call('POST', `/procurement-orders/${o.id}/call-offs`, { token: w.owner.token, body: { amount_minor: amount, description: 'Weekend maintenance visit', idempotency_key: key } });
  const c1 = ok(await co(Math.floor(ceiling / 2), 'call-off-key-1'), 201);
  const c1b = ok(await co(Math.floor(ceiling / 2), 'call-off-key-1'), 201); assert.equal(c1b.id, c1.id);
  assert.equal((await co(ceiling, 'call-off-key-2')).status, 409, 'over the ceiling');
  const det = ok(await call('GET', `/procurement-orders/${o.id}`, { token: w.owner.token }));
  assert.equal(det.framework.committed_call_offs_minor, Math.floor(ceiling / 2)); assert.match(det.framework.note, /not guaranteed spend/);
  assert.equal((await call('POST', `/procurement-orders/${o.id}/call-offs`, { token: w.sup.A.user.token, body: { amount_minor: 100, description: 'Supplier raising its own call-off' } })).status, 403);
  assert.equal((await call('POST', `/procurement-orders/${o.id}/call-offs`, { token: w.owner.token, body: { amount_minor: 100, description: 'Outside the period', service_date: dateOf(400) } })).status, 400);
});
