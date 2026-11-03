// Sponsorship eligibility screening and application validation (#287): versioned rules, reasons, missing data, duplicate flags,
// authorised exceptions, award gate, history preserved, isolation and concurrency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { evaluateEligibility } = await import('../src/sponsorship-screening.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `el_${n}_${roles[0]}`, display_name: `Elig ${n}`, email: `el${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const setup = async ({ rounds = 1 } = {}) => {
  const owner = await signup(['sponsor']);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Brand ${n}` } }), 201);
  let p = must(await api('POST', '/sponsorship-programs', { token: owner.token, body: { sponsor_id: b.id, name: 'Fund', objective: 'Grow the game', currency: 'USD', budget_cents: 1000000, max_award_cents: 500000 } }), 201);
  const rs = [];
  for (let k = 0; k < rounds; k++) rs.push(must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: owner.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201));
  p = must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: owner.token, body: { status: 'published', version: p.row_version } }));
  return { owner, b, p, rs };
};
const rules = (p, extra = {}) => ({ version: p.row_version, target_types: ['athlete', 'team', 'event'], sports: [], regions: [], verified_only: false, max_award_cents: 500000, duplicate_check: true, required_documents: [], ...extra });
const apply = async (round, token, userId, cents = 100000) => api('POST', `/program-rounds/${round.id}/applications`, { token, body: { target_type: 'athlete', target_id: userId, requested_cents: cents, pitch: 'Please fund me' } });
const program = async (w) => (await pool.query('SELECT * FROM sponsorship_programs WHERE id=$1', [w.p.id])).rows[0];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('engine: reasons in plain language; unknown facts are missing, never guessed', () => {
  const r = { target_types: ['athlete'], sports: ['tennis'], regions: ['Chennai'], verified_only: true, max_award_cents: 100000, required_documents: [{ key: 'id_proof', label: 'Proof of ID' }] };
  const none = evaluateEligibility(r, { target_type: 'athlete', requested_cents: 50000, verified: false, sports: [], regions: null, documents: new Set() });
  assert.equal(none.outcome, 'ineligible'); // verified_only is unmet
  assert.ok(none.reasons.every((x) => x.message.length > 10));
  assert.deepEqual(none.missing.map((m) => m.key).sort(), ['id_proof', 'region', 'sport', 'verification']);
  const ok = evaluateEligibility(r, { target_type: 'athlete', requested_cents: 50000, verified: true, sports: ['tennis'], regions: ['chennai'], documents: new Set(['id_proof']) });
  assert.equal(ok.outcome, 'eligible');
  const unk = evaluateEligibility({ sports: ['tennis'] }, { target_type: 'team', requested_cents: null, verified: false, sports: null, regions: [], documents: null });
  assert.equal(unk.outcome, 'needs_info');
  assert.equal(evaluateEligibility({ max_award_cents: 10 }, { target_type: 'team', requested_cents: 11, sports: [], regions: [], documents: new Set() }).outcome, 'ineligible');
  assert.equal(evaluateEligibility({ regions: ['Chennai'] }, { target_type: 'event', requested_cents: 1, sports: [], regions: [], documents: new Set() }).outcome, 'eligible', 'events carry no region, the rule does not apply');
});

test('migration backfilled version 1 for programs and invented no screening', async () => {
  const w = await setup();
  const v = (await pool.query('SELECT version, rules FROM sponsorship_eligibility_versions WHERE program_id=$1', [w.p.id])).rows;
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].rules.target_types.sort(), ['athlete', 'event', 'team']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_screenings WHERE program_id=$1', [w.p.id])).rows[0].n, 0);
});

test('rules are versioned: a new version applies to new screenings, earlier ones keep theirs; stale version is 409', async () => {
  const w = await setup();
  const a = await signup();
  const app = must(await apply(w.rs[0], a.token, a.id), 201);
  let s = must(await api('GET', `/program-applications/${app.id}/screening`, { token: a.token }));
  assert.equal(s.latest.rules_version, 1);
  assert.equal(s.outcome, 'eligible');
  const p1 = await program(w);
  const pub = must(await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token, body: rules(p1, { max_award_cents: 50000, required_documents: [{ key: 'id_proof', label: 'Proof of ID' }] }) }), 201);
  assert.equal(pub.eligibility_version, 2);
  assert.equal(pub.changed, true);
  const stale = await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token, body: rules(p1) });
  assert.equal(stale.status, 409);
  // the earlier screening is untouched
  s = must(await api('GET', `/program-applications/${app.id}/screening`, { token: a.token }));
  assert.equal(s.latest.rules_version, 1);
  assert.equal(s.outcome, 'eligible');
  // an explicit re-screen adds a run under v2 and keeps the old one
  const re = must(await api('POST', `/program-applications/${app.id}/screen`, { token: w.owner.token, body: { version: s.version } }));
  assert.equal(re.latest.rules_version, 2);
  assert.equal(re.outcome, 'ineligible', 'over the new maximum award; the missing document is still listed');
  assert.equal(re.history.length, 1);
  assert.equal(re.history[0].rules_version, 1);
  assert.ok(re.latest.missing.some((m) => m.key === 'id_proof'));
  const list = must(await api('GET', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token }));
  assert.deepEqual(list.items.map((x) => x.version), [2, 1]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_eligibility_versions WHERE program_id=$1', [w.p.id])).rows[0].n, 2);
  // publishing identical rules adds nothing
  const same = must(await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token, body: rules(await program(w), { max_award_cents: 50000, required_documents: [{ key: 'id_proof', label: 'Proof of ID' }] }) }), 201);
  assert.equal(same.changed, false);
  // a stale screening version cannot re-screen
  assert.equal((await api('POST', `/program-applications/${app.id}/screen`, { token: w.owner.token, body: { version: s.version } })).status, 409);
});

test('editing the program through update_sponsorship_program also versions the rules', async () => {
  const w = await setup();
  const p = await program(w);
  must(await api('PATCH', `/sponsorship-programs/${w.p.id}`, { token: w.owner.token, body: { version: p.row_version, verified_only: true } }));
  const v = (await pool.query('SELECT version, rules FROM sponsorship_eligibility_versions WHERE program_id=$1 ORDER BY version', [w.p.id])).rows;
  assert.equal(v.length, 2);
  assert.equal(v[0].rules.verified_only, false);
  assert.equal(v[1].rules.verified_only, true);
});

test('preview tells an applicant what is met, not met or missing - without filing anything', async () => {
  const w = await setup();
  must(await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token, body: rules(await program(w), { required_documents: [{ key: 'id_proof', label: 'Proof of ID' }] }) }), 201);
  const a = await signup();
  const before = (await pool.query('SELECT count(*)::int AS n FROM sponsorship_applications')).rows[0].n;
  const pv = must(await api('POST', `/program-rounds/${w.rs[0].id}/eligibility-check`, { token: a.token, body: { target_type: 'athlete', target_id: a.id, requested_cents: 100000 } }));
  assert.equal(pv.outcome, 'needs_info');
  assert.deepEqual(pv.missing.map((m) => m.key), ['id_proof']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_applications')).rows[0].n, before);
  const big = must(await api('POST', `/program-rounds/${w.rs[0].id}/eligibility-check`, { token: a.token, body: { target_type: 'athlete', target_id: a.id, requested_cents: 900000 } }));
  assert.equal(big.outcome, 'ineligible');
  // someone who does not own the target cannot probe it; brand staff are refused
  const other = await signup();
  assert.equal((await api('POST', `/program-rounds/${w.rs[0].id}/eligibility-check`, { token: other.token, body: { target_type: 'athlete', target_id: a.id } })).status, 404);
  assert.equal((await api('POST', `/program-rounds/${w.rs[0].id}/eligibility-check`, { token: w.owner.token, body: { target_type: 'athlete', target_id: w.owner.id } })).status, 403);
  assert.equal((await api('POST', `/program-rounds/${w.rs[0].id}/eligibility-check`, {})).status, 401);
});

test('duplicates are flagged for a human, never rejected; the applicant sees a note, not who', async () => {
  const w = await setup({ rounds: 2 });
  const a = await signup();
  const first = must(await apply(w.rs[0], a.token, a.id), 201);
  const second = must(await apply(w.rs[1], a.token, a.id), 201);
  const s = must(await api('GET', `/program-applications/${second.id}/screening`, { token: a.token }));
  assert.equal(s.outcome, 'review');
  assert.equal(s.latest.duplicate_flags[0].kind, 'same_target');
  assert.equal(s.latest.duplicate_flags[0].application_id, undefined, 'applicant never sees other application ids');
  const staff = must(await api('GET', `/program-applications/${second.id}/screening`, { token: w.owner.token }));
  assert.equal(staff.latest.duplicate_flags[0].application_id, first.id);
});

test('an award needs an eligible screening or an authorised exception; exceptions are audited and revocable', async () => {
  const w = await setup();
  must(await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token, body: rules(await program(w), { required_documents: [{ key: 'id_proof', label: 'Proof of ID' }] }) }), 201);
  const a = await signup();
  const app = must(await apply(w.rs[0], a.token, a.id), 201);
  let s = must(await api('GET', `/program-applications/${app.id}/screening`, { token: w.owner.token }));
  assert.equal(s.outcome, 'needs_info');
  const award = () => api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: undefined } });
  const withVersion = async () => api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: (await program(w)).row_version } });
  const blocked = await withVersion();
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.code, 'screening_blocks_award');
  void award;
  // no authority: the applicant, a stranger, a viewer-level brand member
  assert.equal((await api('POST', `/program-applications/${app.id}/screening-exception`, { token: a.token, body: { version: s.version, reason: 'Please let me through this time' } })).status, 404);
  const stranger = await signup(['sponsor']);
  assert.equal((await api('POST', `/program-applications/${app.id}/screening-exception`, { token: stranger.token, body: { version: s.version, reason: 'I would like to override this check' } })).status, 404);
  // a reason is mandatory and a stale version is refused
  assert.equal((await api('POST', `/program-applications/${app.id}/screening-exception`, { token: w.owner.token, body: { version: s.version, reason: 'short' } })).status, 400);
  assert.equal((await api('POST', `/program-applications/${app.id}/screening-exception`, { token: w.owner.token, body: { version: s.version + 5, reason: 'Documents were seen in person at the clinic' } })).status, 409);
  const granted = must(await api('POST', `/program-applications/${app.id}/screening-exception`, { token: w.owner.token, body: { version: s.version, reason: 'Documents were seen in person at the clinic' } }), 201);
  assert.equal(granted.exception.reason, 'Documents were seen in person at the clinic');
  assert.equal(granted.outcome, 'needs_info', 'the screening result itself is not rewritten');
  // the reason is encrypted at rest, the applicant sees that an exception exists but not why
  const raw = (await pool.query('SELECT reason_enc FROM sponsorship_screening_exceptions WHERE application_id=$1', [app.id])).rows[0].reason_enc;
  assert.ok(!raw.includes('clinic'));
  const mine = must(await api('GET', `/program-applications/${app.id}/screening`, { token: a.token }));
  assert.ok(mine.exception);
  assert.equal(mine.exception.reason, undefined);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='grant_exception' AND entity_id=$1", [app.id])).rowCount);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pii' AND entity='sponsorship_screening_exceptions'")).rowCount);
  // a second live exception is refused
  s = must(await api('GET', `/program-applications/${app.id}/screening`, { token: w.owner.token }));
  assert.equal((await api('POST', `/program-applications/${app.id}/screening-exception`, { token: w.owner.token, body: { version: s.version, reason: 'Documents were seen in person at the clinic' } })).status, 409);
  // revoke blocks again, history stays
  must(await api('POST', `/program-applications/${app.id}/screening-exception/revoke`, { token: w.owner.token, body: { version: s.version } }));
  assert.equal((await withVersion()).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_screening_exceptions WHERE application_id=$1', [app.id])).rows[0].n, 1, 'revoked, not deleted');
  // grant again and the award goes through
  s = must(await api('GET', `/program-applications/${app.id}/screening`, { token: w.owner.token }));
  must(await api('POST', `/program-applications/${app.id}/screening-exception`, { token: w.owner.token, body: { version: s.version, reason: 'Documents were seen in person at the clinic' } }), 201);
  const done = await withVersion();
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual((await pool.query("SELECT kind FROM sponsorship_screening_events WHERE application_id=$1 ORDER BY created_at, id", [app.id])).rows.map((r) => r.kind), ['screened', 'exception_granted', 'exception_revoked', 'exception_granted']);
});

test('declining is never blocked; non-members cannot read, screen or export screening', async () => {
  const w = await setup();
  must(await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token, body: rules(await program(w), { required_documents: [{ key: 'id_proof', label: 'Proof of ID' }] }) }), 201);
  const a = await signup();
  const app = must(await apply(w.rs[0], a.token, a.id), 201);
  const stranger = await signup(['sponsor']);
  for (const [m, p, body] of [['GET', `/program-applications/${app.id}/screening`], ['POST', `/program-applications/${app.id}/screen`, { version: 1 }], ['POST', `/program-applications/${app.id}/request-information`, { version: 1, message: 'x' }]]) {
    assert.equal((await api(m, p, { token: stranger.token, body })).status, 404, `${m} ${p}`);
  }
  assert.equal((await api('GET', `/sponsorship-programs/${w.p.id}/eligibility`, { token: stranger.token })).status, 403);
  assert.equal((await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: stranger.token, body: rules(await program(w)) })).status, 403);
  assert.equal((await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: a.token, body: rules(await program(w)) })).status, 403);
  assert.equal((await api('GET', `/program-applications/${app.id}/screening`, {})).status, 401);
  const dec = await api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'decline', reason: 'Not a fit' } });
  assert.equal(dec.status, 200);
});

test('missing information: not-a-form items notify the applicant, nothing is assumed supplied', async () => {
  const w = await setup();
  must(await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token, body: rules(await program(w), { required_documents: [{ key: 'id_proof', label: 'Proof of ID' }] }) }), 201);
  const a = await signup();
  const app = must(await apply(w.rs[0], a.token, a.id), 201);
  const s = must(await api('GET', `/program-applications/${app.id}/screening`, { token: w.owner.token }));
  const asked = must(await api('POST', `/program-applications/${app.id}/request-information`, { token: w.owner.token, body: { version: s.version, message: 'Please add your ID' } }));
  assert.equal(asked.outcome, 'needs_info');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND title='More information needed'", [a.id])).rowCount);
  assert.equal((await api('POST', `/program-applications/${app.id}/request-information`, { token: w.owner.token, body: { version: s.version, message: 'again' } })).status, 409, 'stale');
});

test('concurrent exceptions: exactly one live exception wins', async () => {
  const w = await setup();
  must(await api('POST', `/sponsorship-programs/${w.p.id}/eligibility`, { token: w.owner.token, body: rules(await program(w), { required_documents: [{ key: 'id_proof', label: 'Proof of ID' }] }) }), 201);
  const a = await signup();
  const app = must(await apply(w.rs[0], a.token, a.id), 201);
  const s = must(await api('GET', `/program-applications/${app.id}/screening`, { token: w.owner.token }));
  const go = () => api('POST', `/program-applications/${app.id}/screening-exception`, { token: w.owner.token, body: { version: s.version, reason: 'Documents were seen in person at the clinic' } });
  const res = await Promise.all([go(), go(), go()]);
  assert.equal(res.filter((r) => r.status === 201).length, 1, JSON.stringify(res.map((r) => r.status)));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_screening_exceptions WHERE application_id=$1 AND revoked_at IS NULL', [app.id])).rows[0].n, 1);
});

test('existing applications filed before screening stay awardable and show screened:false', async () => {
  const w = await setup();
  const a = await signup();
  const app = must(await apply(w.rs[0], a.token, a.id), 201);
  await pool.query('DELETE FROM sponsorship_screening_events WHERE application_id=$1', [app.id]); // simulate a pre-feature row (test database only)
  await pool.query('UPDATE sponsorship_applications SET screening_id=NULL, screening_outcome=NULL WHERE id=$1', [app.id]);
  await pool.query('DELETE FROM sponsorship_screenings WHERE application_id=$1', [app.id]);
  const s = must(await api('GET', `/program-applications/${app.id}/screening`, { token: a.token }));
  assert.equal(s.screened, false);
  assert.equal(s.latest, null);
  const r = await api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: (await program(w)).row_version } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
