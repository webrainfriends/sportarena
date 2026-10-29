import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');
const { gate, resolveState, assertMayMessageYouth, mayAccessYouth } = await import('../src/compliance.js');
const { canSeeYouth } = await import('../src/youth.js');
const { remindCompliance } = await import('../src/compliance-sweeps.js');
const { evaluate, RULES } = await import('../src/registration.js');
const { blocker } = await import('../src/accreditation.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const person = async (roles = []) => {
  n++;
  const r = await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$2,$3,'x','x',$1) RETURNING id", [`cp_${n}`, `Person ${n}`, roles]);
  return { id: r.rows[0].id, token: await signToken({ id: r.rows[0].id, roles }) };
};
const join = (org, u, role) => pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [org, u.id, role]);
const day = (d = 0) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const sportId = async (slug = 'football') => (await pool.query('SELECT id FROM sports WHERE slug=$1', [slug])).rows[0].id;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('cp_root','cp_root','{admin}','x','x','cp_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function club() {
  const owner = await person();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Compliance Club ${++n}`, kind: 'club' } }), 201);
  return { owner, org };
}
const requirement = async (user, scope, body) => must(await api('POST', '/compliance/requirements', { token: user.token, body: { scope_kind: scope.kind, scope_id: scope.id, name: 'Coaching certificate', category: 'qualification', method: 'evidence', validity_days: 365, ...body } }), 201);
const obligation = async (user, req, body = {}) => must(await api('POST', `/compliance/requirements/${req.id}/obligations`, { token: user.token, body: { roles: ['coach'], ...body } }), 201);
const status = (user, query = {}) => api('GET', '/compliance/status', { token: user.token, query });
const codeOf = (r) => r.body.error?.details?.code;
const itemOf = (s, name) => s.items.find((i) => i.requirement.name === name);

test('a requirement for coaches: missing, submitted, reviewed, met, expiring, expired - each explained', async () => {
  const { owner, org } = await club();
  const coach = await person(), outsider = await person();
  await join(org.id, coach, 'coach');
  const scope = { kind: 'organisation', id: org.id };
  const req = await requirement(owner, scope, { name: 'First aid certificate', category: 'qualification' });
  assert.equal(req.version, 1);
  const ob = await obligation(owner, req, { consequences: [] });
  assert.equal(ob.mandatory, true);

  let s = must(await status(coach));
  let item = itemOf(s, 'First aid certificate');
  assert.equal(item.state, 'missing'); assert.equal(item.blocking, true); assert.equal(s.decision, 'blocked');
  assert.match(item.explanation, /has not been provided/); assert.equal(item.next_step.action, 'submit');
  assert.equal(item.scope.name.startsWith('Compliance Club'), true);

  // somebody who is not in the club has nothing to meet
  s = must(await status(outsider));
  assert.equal(s.items.length, 0); assert.equal(s.decision, 'clear');

  // evidence needs a reference; an expired certificate is refused
  assert.equal((await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id } })).status, 400);
  assert.equal((await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'FA-1', issued_on: day(-400), expires_on: day(-5) } })).status, 400);
  const rec = must(await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'FA-123456', provider: 'Red Cross', issued_on: day(-10) } }), 201);
  assert.equal(rec.status, 'submitted'); assert.equal(rec.has_reference, true); assert.equal(rec.expires_on, day(355));
  assert.equal(JSON.stringify(rec).includes('FA-123456'), false, 'the reference is never in a response');
  assert.equal((await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'FA-2' } })).status, 409, 'one open submission at a time');

  s = must(await status(coach));
  assert.equal(itemOf(s, 'First aid certificate').state, 'pending_review');
  assert.equal(s.decision, 'pending');

  // the reviewer is the owner; the holder cannot decide their own
  assert.equal((await api('POST', `/compliance/records/${rec.id}/decision`, { token: coach.token, body: { decision: 'approve' } })).status, 404, 'not a manager');
  assert.equal((await api('POST', `/compliance/records/${rec.id}/decision`, { token: outsider.token, body: { decision: 'approve' } })).status, 404);
  const queue = must(await api('GET', '/compliance/records', { token: owner.token, query: { scope_kind: 'organisation', scope_id: org.id, status: 'submitted' } }));
  assert.deepEqual(queue.items.map((r) => r.id), [rec.id]);
  assert.equal(queue.items[0].subject.name.startsWith('Person'), true);
  assert.equal((await api('GET', '/compliance/records', { token: outsider.token, query: { scope_kind: 'organisation', scope_id: org.id } })).status, 404);

  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: owner.token, body: { decision: 'approve' } })); // harmless repeat
  assert.equal((await api('POST', `/compliance/records/${rec.id}/decision`, { token: owner.token, body: { decision: 'reject', reason: 'changed my mind' } })).status, 409);
  s = must(await status(coach));
  assert.equal(itemOf(s, 'First aid certificate').state, 'met'); assert.equal(s.decision, 'clear');

  // time passes: 20 days left -> expiring, -2 days -> expired, grace keeps it counting
  await pool.query('UPDATE comp_records SET expires_on=$2 WHERE id=$1', [rec.id, day(20)]);
  item = itemOf(must(await status(coach)), 'First aid certificate');
  assert.equal(item.state, 'expiring'); assert.equal(item.blocking, false); assert.match(item.explanation, /20 days left/);
  await pool.query('UPDATE comp_records SET expires_on=$2 WHERE id=$1', [rec.id, day(-2)]);
  item = itemOf(must(await status(coach)), 'First aid certificate');
  assert.equal(item.state, 'expired'); assert.equal(item.blocking, true);
  await pool.query('UPDATE comp_requirements SET grace_days=5 WHERE id=$1', [req.id]);
  item = itemOf(must(await status(coach)), 'First aid certificate');
  assert.equal(item.state, 'grace'); assert.equal(item.blocking, false); assert.match(item.explanation, /3 more days/);
  await pool.query('UPDATE comp_requirements SET grace_days=0 WHERE id=$1', [req.id]);

  // renewal: the old record keeps counting only while valid; a renewal while expired reads as awaiting review
  const renewal = must(await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'FA-654321', issued_on: day(0) } }), 201);
  assert.ok(renewal.previous_id);
  assert.equal(itemOf(must(await status(coach)), 'First aid certificate').state, 'pending_review');
  must(await api('POST', `/compliance/records/${renewal.id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  const all = must(await api('GET', '/compliance/records', { token: coach.token }));
  assert.deepEqual(all.items.map((r) => r.status).sort(), ['superseded', 'valid']);
  assert.equal(itemOf(must(await status(coach)), 'First aid certificate').state, 'met');

  // the history shows who did what, never a reference
  const hist = must(await api('GET', '/compliance/history', { token: coach.token }));
  assert.ok(hist.items.some((h) => h.action === 'approved'));
  assert.equal(JSON.stringify(hist).includes('FA-'), false);
});

test('a manager sees only their own scope\'s requirements; the holder sees all; outsiders get a 404', async () => {
  const a = await club(), b = await club();
  const coach = await person();
  await join(a.org.id, coach, 'coach'); await join(b.org.id, coach, 'coach');
  const ra = await requirement(a.owner, { kind: 'organisation', id: a.org.id }, { name: 'A club check' });
  const rb = await requirement(b.owner, { kind: 'organisation', id: b.org.id }, { name: 'B club check' });
  await obligation(a.owner, ra); await obligation(b.owner, rb);
  const mine = must(await status(coach));
  assert.deepEqual(mine.items.map((i) => i.requirement.name).sort(), ['A club check', 'B club check']);
  const seen = must(await status(a.owner, { subject_id: coach.id }));
  assert.deepEqual(seen.items.map((i) => i.requirement.name), ['A club check'], 'a manager never sees another club\'s rules');
  assert.equal(seen.relation, 'manager');
  assert.equal((await status(await person(), { subject_id: coach.id })).status, 404);
  assert.equal((await api('GET', '/compliance/requirements', { token: coach.token, query: { scope_kind: 'organisation', scope_id: a.org.id } })).status, 404);
  assert.equal((await api('POST', '/compliance/requirements', { token: coach.token, body: { scope_kind: 'organisation', scope_id: a.org.id, name: 'Sneaky', category: 'other', method: 'evidence' } })).status, 404);
  assert.equal((await api('POST', '/compliance/requirements', { token: a.owner.token, body: { scope_kind: 'platform', name: 'Platform', category: 'other', method: 'evidence' } })).status, 404, 'platform rules are the platform team\'s');
  const listed = must(await api('GET', '/compliance/requirements', { token: a.owner.token, query: { scope_kind: 'organisation', scope_id: a.org.id } }));
  assert.equal(listed.requirements.length, 1); assert.equal(listed.requirements[0].obligations.length, 1);
  const cat = must(await api('GET', '/compliance/catalogue', { token: a.owner.token }));
  assert.ok(cat.scopes.some((s) => s.kind === 'organisation' && s.id === a.org.id));
  assert.ok(!cat.scopes.some((s) => s.kind === 'platform'));
  assert.ok(must(await api('GET', '/compliance/catalogue', { token: admin.token })).scopes.some((s) => s.kind === 'platform'));
});

test('a background check keeps only its outcome: the reference is the holder\'s, a rejection shares no reason, nobody decides their own', async () => {
  const { owner, org } = await club();
  const coach = await person(), reviewer = await person();
  await join(org.id, coach, 'coach'); await join(org.id, reviewer, 'admin');
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Background check', category: 'background_check', validity_days: 1095 });
  assert.equal(req.sensitive, true);
  assert.equal((await api('POST', '/compliance/requirements', { token: owner.token, body: { scope_kind: 'organisation', scope_id: org.id, name: 'Bad check', category: 'background_check', method: 'declaration', statement: 'I am fine' } })).status, 400, 'cannot be self-declared');
  await obligation(owner, req, { roles: ['coach', 'admin'] });
  const rec = must(await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'CHK-9988', provider: 'Checker Ltd' } }), 201);
  assert.equal(rec.outcome, 'pending');
  assert.equal((await api('GET', `/compliance/records/${rec.id}/reference`, { token: reviewer.token })).status, 404, 'a reviewer never gets a background reference');
  assert.equal((await api('GET', `/compliance/records/${rec.id}/reference`, { token: owner.token })).status, 404);
  const own = must(await api('GET', `/compliance/records/${rec.id}/reference`, { token: coach.token }));
  assert.equal(own.reference, 'CHK-9988');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_compliance_reference' AND entity_id=$1 AND actor_id=$2", [rec.id, coach.id])).rowCount);
  assert.equal((await pool.query('SELECT reference_enc FROM comp_records WHERE id=$1', [rec.id])).rows[0].reference_enc.includes('CHK-9988'), false, 'stored encrypted');

  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: reviewer.token, body: { decision: 'reject' } }));
  const s = must(await status(coach));
  const item = itemOf(s, 'Background check');
  assert.equal(item.state, 'rejected'); assert.equal(item.record.outcome, 'not_clear');
  assert.doesNotMatch(item.explanation, /:/, 'no reviewer reason is exposed for a background check');
  assert.equal((await pool.query('SELECT decision_reason FROM comp_records WHERE id=$1', [rec.id])).rows[0].decision_reason, null);

  // a reviewer cannot approve a record they submitted themselves; another reviewer has to
  const mine = must(await api('POST', '/compliance/records', { token: reviewer.token, body: { requirement_id: req.id, reference: 'OWN-1' } }), 201).id;
  assert.equal((await api('POST', `/compliance/records/${mine}/decision`, { token: reviewer.token, body: { decision: 'approve' } })).status, 403);
  must(await api('POST', `/compliance/records/${mine}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  assert.equal(itemOf(must(await status(reviewer)), 'Background check').record.outcome, 'clear');
  // a background check can never be waived
  const w = await api('POST', '/compliance/waivers', { token: reviewer.token, body: { requirement_id: req.id, subject_id: coach.id, reason: 'urgent', effective_to: day(10) } });
  assert.equal(w.status, 409); assert.equal(codeOf(w), 'not_waivable');
});

test('declarations and acknowledgements are made against the exact current wording', async () => {
  const { owner, org } = await club();
  const staff = await person();
  await join(org.id, staff, 'coach');
  assert.equal((await api('POST', '/compliance/requirements', { token: owner.token, body: { scope_kind: 'organisation', scope_id: org.id, name: 'No wording', category: 'safeguarding_acknowledgement', method: 'declaration' } })).status, 400);
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Safeguarding policy acknowledgement', category: 'safeguarding_acknowledgement', method: 'declaration', statement: 'I have read the safeguarding policy and will follow it.', validity_days: 365 });
  await obligation(owner, req, { roles: [] });
  assert.equal(itemOf(must(await status(staff)), 'Safeguarding policy acknowledgement').next_step.action, 'declare');
  assert.equal((await api('POST', '/compliance/records', { token: staff.token, body: { requirement_id: req.id } })).status, 400, 'must confirm');
  const rec = must(await api('POST', '/compliance/records', { token: staff.token, body: { requirement_id: req.id, confirm: true, statement_version: 1 } }), 201);
  assert.equal(rec.status, 'valid'); assert.equal(rec.statement_version, 1);
  assert.equal(itemOf(must(await status(staff)), 'Safeguarding policy acknowledgement').state, 'met');

  // changing the wording starts version 2; an acknowledgement made against version 1 keeps saying so
  const v2 = must(await api('POST', '/compliance/requirements', { token: owner.token, body: { requirement_id: req.id, scope_kind: 'organisation', scope_id: org.id, name: req.name, category: 'safeguarding_acknowledgement', method: 'declaration', statement: 'Updated policy: report concerns within 24 hours.', validity_days: 365 } }), 201);
  assert.equal(v2.version, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM comp_requirement_versions WHERE requirement_id=$1', [req.id])).rows[0].n, 2);
  assert.equal((await api('POST', '/compliance/records', { token: staff.token, body: { requirement_id: req.id, confirm: true, statement_version: 1 } })).status, 409, 'the person read an old version');

  // a conflict of interest keeps its description encrypted; managers can read it, audit-logged
  const coi = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Conflict of interest', category: 'conflict_of_interest', method: 'declaration', statement: 'I declare any conflict of interest below, or none.', validity_days: 365 });
  await obligation(owner, coi, { roles: [] });
  const decl = must(await api('POST', '/compliance/records', { token: staff.token, body: { requirement_id: coi.id, confirm: true, detail: 'My sister runs the kit supplier.' } }), 201);
  assert.equal(decl.has_detail, true);
  assert.equal(must(await api('GET', `/compliance/records/${decl.id}/reference`, { token: owner.token })).detail, 'My sister runs the kit supplier.');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_compliance_reference' AND entity_id=$1 AND actor_id=$2", [decl.id, owner.id])).rowCount);
  assert.equal((await api('GET', `/compliance/records/${decl.id}/reference`, { token: (await person()).token })).status, 404);
});

test('an unmet safeguarding obligation blocks contact with young people in the team chat, and cannot be waived', async () => {
  const { owner, org } = await club();
  const coach = await person(), kid = await person(), sport = await sportId();
  await join(org.id, coach, 'coach');
  const team = (await pool.query('INSERT INTO teams(name, sport_id, owner_id, organisation_id) VALUES ($1,$2,$3,$4) RETURNING id', [`U12 ${n}`, sport, coach.id, org.id])).rows[0].id;
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team, kid.id]);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const post = () => api('POST', `/teams/${team}/messages`, { token: coach.token, body: { body: 'Training moved to 5pm' } });
  assert.equal((await post()).status, 201, 'no obligation configured = no restriction');

  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Safeguarding training', category: 'safeguarding_training', validity_days: 730 });
  await obligation(owner, req, { roles: ['coach'], youth_work: true, consequences: ['youth_contact'] });
  const blocked = await post();
  assert.equal(blocked.status, 409); assert.equal(codeOf(blocked), 'compliance_required');
  assert.match(JSON.stringify(blocked.body), /Safeguarding training/);
  const first = must(await status(coach)).items[0];
  assert.equal(first.consequences[0], 'youth_contact'); assert.equal(first.waivable, false, 'the app is told this cannot be waived');

  // the young person is never restricted by this; an adult who does not work with young people is not asked
  assert.notEqual(codeOf(await api('POST', `/teams/${team}/messages`, { token: kid.token, body: { body: 'See you there' } })), 'compliance_required');

  // a safeguarding obligation that protects young people cannot be waived
  const w = await api('POST', '/compliance/waivers', { token: owner.token, body: { requirement_id: req.id, subject_id: coach.id, reason: 'start of season rush', effective_to: day(14) } });
  assert.equal(w.status, 409);

  const rec = must(await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'SG-1', issued_on: day(-1) } }), 201);
  assert.equal((await post()).status, 409, 'pending is not enough for youth contact');
  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  assert.equal((await post()).status, 201);
  await pool.query('UPDATE comp_records SET expires_on=$2 WHERE id=$1', [rec.id, day(-1)]);
  assert.equal((await post()).status, 409, 'expiry applies on the very next message');
});

test('the platform can require an acknowledgement before an adult messages or sees young people outside a team chat', async () => {
  const recruiter = await person(['recruiter']), kid = await person(), sport = await sportId(), owner = await person();
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await assertMayMessageYouth(pool, recruiter.id, kid.id); // nothing configured, nothing asked
  const req = must(await api('POST', '/compliance/requirements', { token: admin.token, body: { scope_kind: 'platform', name: 'Recruiter safeguarding acknowledgement', category: 'safeguarding_acknowledgement', method: 'declaration', statement: 'I will only contact young people through their guardians.', validity_days: 365 } }), 201);
  must(await api('POST', `/compliance/requirements/${req.id}/obligations`, { token: admin.token, body: { roles: ['recruiter'], consequences: ['youth_contact', 'youth_access'] } }), 201);
  await assert.rejects(() => assertMayMessageYouth(pool, recruiter.id, kid.id), (e) => e.status === 409 && e.details.code === 'compliance_required' && /Recruiter safeguarding/.test(e.details.reasons[0]));
  await assertMayMessageYouth(pool, kid.id, kid.id); // a young person is never restricted by this
  await assertMayMessageYouth(pool, owner.id, kid.id); // a person the obligation does not apply to is not asked
  assert.equal(await mayAccessYouth(pool, recruiter.id, kid.id), false);
  must(await api('POST', '/compliance/records', { token: recruiter.token, body: { requirement_id: req.id, confirm: true } }), 201);
  await assertMayMessageYouth(pool, recruiter.id, kid.id);
  assert.equal(await mayAccessYouth(pool, recruiter.id, kid.id), true);
  // the platform's own rulebook belongs to the platform team alone
  assert.equal((await api('POST', `/compliance/waivers`, { token: admin.token, body: { requirement_id: req.id, subject_id: owner.id, reason: 'trying it', effective_to: day(5) } })).status, 409);
  assert.equal(sport !== undefined, true);
});

test('a coach or manager sees a young person\'s record only while their access obligations are met', async () => {
  const { owner, org } = await club();
  const coach = await person(), kid = await person(), guardian = await person(), sport = await sportId();
  await join(org.id, coach, 'coach');
  const team = (await pool.query('INSERT INTO teams(name, sport_id, owner_id, organisation_id) VALUES ($1,$2,$3,$4) RETURNING id', [`U10 ${n}`, sport, coach.id, org.id])).rows[0].id;
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team, kid.id]);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, kid.id]);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '1 year')", [kid.id, guardian.id]);
  assert.equal(await canSeeYouth(coach, kid.id), true, 'no obligation: the team coach sees the player, as before');
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Safeguarding lead sign-off', category: 'attestation', method: 'declaration', statement: 'I have been briefed by the safeguarding lead.' });
  await obligation(owner, req, { roles: ['coach'], consequences: ['youth_access'] });
  assert.equal(await canSeeYouth(coach, kid.id), false, 'unmet: the coach no longer sees the young person');
  assert.equal(await canSeeYouth({ id: guardian.id, roles: [] }, kid.id), true, 'a guardian is never restricted');
  assert.equal(await canSeeYouth({ id: kid.id, roles: [] }, kid.id), true);
  must(await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, confirm: true } }), 201);
  assert.equal(await canSeeYouth(coach, kid.id), true);
});

test('a coach who does not work with young people is not held to youth-work obligations', async () => {
  const { owner, org } = await club();
  const adultsOnly = await person(), sport = await sportId();
  await join(org.id, adultsOnly, 'coach');
  await pool.query('INSERT INTO teams(name, sport_id, owner_id, organisation_id) VALUES ($1,$2,$3,$4)', [`Seniors ${n}`, sport, adultsOnly.id, org.id]);
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Youth safeguarding' });
  await obligation(owner, req, { youth_work: true, consequences: ['youth_contact'] });
  assert.equal(must(await status(adultsOnly)).items.length, 0);
});

test('waivers are documented, time-boxed and never rewrite the record', async () => {
  const { owner, org } = await club();
  const coach = await person(), admin2 = await person();
  await join(org.id, coach, 'coach'); await join(org.id, admin2, 'admin');
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Level 2 award', category: 'qualification' });
  await obligation(owner, req);
  const body = { requirement_id: req.id, subject_id: coach.id, reason: 'Course starts next month', effective_to: day(30) };
  assert.equal((await api('POST', '/compliance/waivers', { token: coach.token, body })).status, 404);
  assert.equal((await api('POST', '/compliance/waivers', { token: owner.token, body: { ...body, effective_to: day(400) } })).status, 400, 'at most 180 days');
  assert.equal((await api('POST', '/compliance/waivers', { token: owner.token, body: { ...body, reason: 'no' } })).status, 400);
  const ownWaiver = await api('POST', '/compliance/waivers', { token: owner.token, body: { ...body, subject_id: owner.id } });
  assert.equal(ownWaiver.status === 403 || ownWaiver.status === 409, true, 'nobody waives their own');
  const w = must(await api('POST', '/compliance/waivers', { token: owner.token, body }), 201);
  const item = itemOf(must(await status(coach)), 'Level 2 award');
  assert.equal(item.state, 'waived'); assert.equal(item.blocking, false); assert.equal(item.waiver.effective_to, day(30)); assert.match(item.explanation, /waived until/);
  assert.equal(must(await api('GET', '/compliance/waivers', { token: admin2.token, query: { scope_kind: 'organisation', scope_id: org.id } })).items.length, 1);
  must(await api('POST', `/compliance/waivers/${w.id}/revoke`, { token: owner.token }));
  assert.equal(itemOf(must(await status(coach)), 'Level 2 award').state, 'missing');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM comp_records WHERE subject_id=$1', [coach.id])).rows[0].n, 0, 'the waiver created no record');
});

test('a requirement can be checked from an existing platform verification instead of a copy', async () => {
  const { owner, org } = await club();
  const coach = await person();
  await join(org.id, coach, 'coach');
  assert.equal((await api('POST', '/compliance/requirements', { token: owner.token, body: { scope_kind: 'organisation', scope_id: org.id, name: 'Verified coach', category: 'qualification', method: 'linked', source: { kind: 'verification', type: 'nonsense' } } })).status, 400);
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Verified coach', method: 'linked', source: { kind: 'verification', type: 'coach' }, validity_days: null });
  await obligation(owner, req);
  let item = itemOf(must(await status(coach)), 'Verified coach');
  assert.equal(item.state, 'missing'); assert.equal(item.next_step.action, 'open_source');
  const sub = await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'x' } });
  assert.equal(sub.status, 409, 'nothing to submit: it is read from the verification');
  const sport = await sportId();
  const c = (await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, sport_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ('coach','user',$1,$2,$1,'approved',1,now(), now() + interval '200 days') RETURNING id", [coach.id, sport])).rows[0].id;
  item = itemOf(must(await status(coach)), 'Verified coach');
  assert.equal(item.state, 'met'); assert.deepEqual(item.linked, { kind: 'verification', id: c });
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [c]);
  assert.equal(itemOf(must(await status(coach)), 'Verified coach').state, 'revoked', 'revocation there applies here immediately');
});

test('the roll-up names who is short in a scope, worst first, and hides protected young people', async () => {
  const { owner, org } = await club();
  const a = await person(), b = await person(), kid = await person();
  await join(org.id, a, 'coach'); await join(org.id, b, 'coach'); await join(org.id, kid, 'coach');
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Coaching licence' });
  await obligation(owner, req);
  const rec = must(await api('POST', '/compliance/records', { token: b.token, body: { requirement_id: req.id, reference: 'L-1' } }), 201);
  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  await pool.query('UPDATE comp_records SET expires_on=$2 WHERE id=$1', [rec.id, day(10)]);
  const gaps = must(await api('GET', '/compliance/gaps', { token: owner.token, query: { scope_kind: 'organisation', scope_id: org.id } }));
  const byId = new Map(gaps.subjects.map((s) => [s.subject.id, s]));
  assert.equal(byId.get(a.id).decision, 'blocked'); assert.equal(byId.get(b.id).decision, 'clear');
  assert.equal(byId.get(b.id).counts.expiring, 1);
  assert.equal(byId.get(kid.id).subject.name, 'Protected participant');
  assert.equal(gaps.subjects[0].decision, 'blocked', 'worst first');
  assert.equal((await api('GET', '/compliance/gaps', { token: a.token, query: { scope_kind: 'organisation', scope_id: org.id } })).status, 404);
  const tile = must(await api('GET', `/organisations/${org.id}/command-centre`, { token: owner.token })).tiles.find((t) => t.key === 'compliance');
  assert.match(tile.summary, /expiring within 30 days/);
  // evidence waiting for a decision shows in the organisation's decision queue and is decided through the same capability
  const pending = must(await api('POST', '/compliance/records', { token: a.token, body: { requirement_id: req.id, reference: 'L-2' } }), 201);
  const queue = must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: owner.token, query: { domain: 'compliance' } }));
  const entry = queue.items.find((x) => x.key === `compliance:record:${pending.id}`);
  assert.ok(entry); assert.equal(entry.actions[0].path, `/compliance/records/${pending.id}/decision`); assert.equal(entry.can_act, true);
});

test('registration (#477) and accreditation (#481) read the same rulebook, live', async () => {
  const org = await person(['organizer']), player = await person(), sport = await sportId();
  const ev = (await pool.query("INSERT INTO events(name, sport_id, organizer_id, starts_on, ends_on, status) VALUES ('Cup',$1,$2,current_date,current_date + 2,'open') RETURNING *", [sport, org.id])).rows[0];
  const team = (await pool.query('INSERT INTO teams(name, sport_id, owner_id) VALUES ($1,$2,$3) RETURNING id', ['Reds', sport, org.id])).rows[0].id;
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team, player.id]);
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, team]);
  const policy = { id: null, version: 1, enforcement: 'blocking', rules: RULES.parse({ check_division_age: false }) };
  const before = await evaluate(pool, { event: ev, policy }, team, player.id);
  assert.equal(before.checks.some((c) => c.rule === 'compliance'), false, 'nothing configured, nothing checked');

  const req = await requirement(org, { kind: 'event', id: ev.id }, { name: 'Medical declaration', category: 'declaration', method: 'declaration', statement: 'I am fit to take part.', validity_days: 90 });
  await obligation(org, req, { roles: [], consequences: ['registration', 'accreditation'] });
  const after = await evaluate(pool, { event: ev, policy }, team, player.id);
  const check = after.checks.find((c) => c.rule === 'compliance');
  assert.equal(check.status, 'fail'); assert.match(check.reason, /Medical declaration/); assert.equal(check.source.kind, 'compliance');
  assert.equal(after.decision, 'ineligible');

  // accreditation: the organiser is an event engagement, so the same obligation blocks a badge until it is met
  const cat = { status: 'active', eligible: ['operations'], requires_verification: null };
  assert.match(await blocker(pool, ev, cat, org.id), /^Compliance: /);
  must(await api('POST', '/compliance/records', { token: org.token, body: { requirement_id: req.id, confirm: true } }), 201);
  assert.equal(await blocker(pool, ev, cat, org.id), null);
  assert.equal((await gate(pool, org.id, 'accreditation', { event_id: ev.id })).decision, 'clear');
  // the player meets it too, and the check turns into a pass in the next decision (snapshots keep what was decided at the time)
  await pool.query("INSERT INTO comp_records(requirement_id, requirement_version, subject_kind, subject_id, status, issued_on, expires_on, submitted_by, statement_version) VALUES ($1,1,'person',$2,'valid',current_date,current_date + 30,$2,1)", [req.id, player.id]);
  const done = await evaluate(pool, { event: ev, policy }, team, player.id);
  assert.equal(done.checks.find((c) => c.rule === 'compliance').status, 'pass');
  assert.equal(done.decision === 'ineligible', done.checks.some((c) => c.status === 'fail' && c.rule !== 'compliance'));
  // switching it off on the policy ignores the rulebook
  const off = await evaluate(pool, { event: ev, policy: { ...policy, rules: { ...policy.rules, require_compliance: false } } }, team, org.id);
  assert.equal(off.checks.some((c) => c.rule === 'compliance'), false);
});

test('evidence packs carry states and dates only, are read-audited, expire and can be revoked', async () => {
  const { owner, org } = await club();
  const coach = await person(), auditor = await person(), stranger = await person();
  await join(org.id, coach, 'coach');
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Insurance cover', category: 'insurance' });
  await obligation(owner, req);
  const rec = must(await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'POLICY-SECRET-77', provider: 'Insurer Co' } }), 201);
  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  assert.equal((await api('POST', '/compliance/packs', { token: stranger.token, body: { scope_kind: 'organisation', scope_id: org.id, purpose: 'audit', recipient_id: auditor.id } })).status, 404);
  const pack = must(await api('POST', '/compliance/packs', { token: owner.token, body: { scope_kind: 'organisation', scope_id: org.id, purpose: 'Annual federation audit', recipient_id: auditor.id, expires_in_days: 3 } }), 201);
  assert.match(pack.sha256, /^[0-9a-f]{64}$/);
  const read = must(await api('GET', `/compliance/packs/${pack.id}`, { token: auditor.token }));
  assert.equal(read.content.totals.clear, 1);
  assert.equal(JSON.stringify(read).includes('POLICY-SECRET-77'), false, 'no reference in a pack');
  assert.equal(JSON.stringify(read).includes('Insurer Co'), false);
  assert.equal(read.content.subjects[0].items[0].requirement, 'Insurance cover');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_compliance_pack' AND entity_id=$1 AND actor_id=$2", [pack.id, auditor.id])).rowCount);
  assert.equal((await api('GET', `/compliance/packs/${pack.id}`, { token: stranger.token })).status, 404);
  assert.equal(must(await api('GET', '/compliance/packs', { token: auditor.token })).items.length, 1);
  must(await api('POST', `/compliance/packs/${pack.id}/revoke`, { token: owner.token }));
  assert.equal((await api('GET', `/compliance/packs/${pack.id}`, { token: auditor.token })).status, 403);
  assert.equal((await api('GET', `/compliance/packs/${pack.id}`, { token: owner.token })).status, 200, 'the maker keeps their own record');
});

test('reminders go out once per stage and escalate to the managers when a record stays expired', async () => {
  const { owner, org } = await club();
  const coach = await person();
  await join(org.id, coach, 'coach');
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'CPR certificate', escalate_after_days: 3 });
  await obligation(owner, req);
  const rec = must(await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'CPR-1' } }), 201);
  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  const count = async (uid, kind) => (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind=$2', [uid, kind])).rows[0].n;
  await pool.query('UPDATE comp_records SET expires_on=$2 WHERE id=$1', [rec.id, day(6)]);
  await remindCompliance(); await remindCompliance();
  assert.equal(await count(coach.id, 'compliance_expiring'), 1, 'one reminder per stage');
  await pool.query('UPDATE comp_records SET expires_on=$2 WHERE id=$1', [rec.id, day(-1)]);
  await remindCompliance();
  assert.equal(await count(coach.id, 'compliance_expiring'), 2);
  assert.equal(await count(owner.id, 'compliance_escalated'), 0, 'not yet escalated');
  await pool.query('UPDATE comp_records SET expires_on=$2 WHERE id=$1', [rec.id, day(-10)]);
  await remindCompliance(); await remindCompliance();
  assert.equal(await count(owner.id, 'compliance_escalated'), 1);
  assert.equal(await count(coach.id, 'compliance_escalated'), 0, 'escalation goes to managers, not the holder');
});

test('every sport in the catalogue can be targeted; nothing is sport-specific', async () => {
  const { owner, org } = await club();
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'Sport specific licence' });
  const sports = (await pool.query('SELECT id, slug FROM sports')).rows;
  assert.ok(sports.length > 10);
  for (const s of sports) must(await api('POST', `/compliance/requirements/${req.id}/obligations`, { token: owner.token, body: { sport_id: s.id, roles: ['coach'] } }), 201);
  assert.equal((await pool.query('SELECT count(DISTINCT sport_id)::int AS n FROM comp_obligations WHERE requirement_id=$1', [req.id])).rows[0].n, sports.length);
});

test('archiving keeps every record; the pure state rules are deterministic', async () => {
  const { owner, org } = await club();
  const coach = await person();
  await join(org.id, coach, 'coach');
  const req = await requirement(owner, { kind: 'organisation', id: org.id }, { name: 'To archive' });
  await obligation(owner, req);
  must(await api('POST', '/compliance/records', { token: coach.token, body: { requirement_id: req.id, reference: 'A-1' } }), 201);
  must(await api('POST', `/compliance/requirements/${req.id}/archive`, { token: owner.token }));
  assert.equal(must(await status(coach)).items.length, 0, 'an archived requirement applies to nobody');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM comp_records WHERE requirement_id=$1', [req.id])).rows[0].n, 1, 'records are kept');
  assert.equal((await api('POST', '/compliance/requirements', { token: owner.token, body: { requirement_id: req.id, scope_kind: 'organisation', scope_id: org.id, name: 'To archive', category: 'qualification', method: 'evidence' } })).status, 409);
  must(await api('POST', `/compliance/requirements/${req.id}/archive`, { token: owner.token, body: { archived: false } }));
  assert.equal(must(await status(coach)).items.length, 1);
  const base = { reminder_days: [30, 7], grace_days: 2 };
  assert.equal(resolveState(base, { mandatory: true }, { status: 'valid', expires_on: '2030-01-31' }, '2030-01-01', null).state, 'expiring');
  assert.equal(resolveState(base, { mandatory: true }, { status: 'valid', expires_on: '2030-03-01' }, '2030-01-01', null).state, 'met');
  assert.equal(resolveState(base, { mandatory: true }, { status: 'valid', expires_on: '2029-12-31' }, '2030-01-01', null).state, 'grace');
  assert.equal(resolveState(base, { mandatory: false }, null, '2030-01-01', null).blocking, false, 'optional never blocks');
  assert.equal(resolveState(base, { mandatory: true }, null, '2030-01-01', { reason: 'x', effective_to: '2030-02-01' }).state, 'waived');
});

test('every compliance capability is registered for REST, OpenAPI and MCP', () => {
  const names = capabilities.filter((c) => c.tag === 'Compliance').map((c) => c.name).sort();
  for (const want of ['archive_compliance_requirement', 'create_compliance_pack', 'decide_compliance_record', 'get_compliance_catalogue', 'get_compliance_pack', 'get_compliance_status', 'grant_compliance_waiver', 'list_compliance_gaps', 'list_compliance_history', 'list_compliance_packs', 'list_compliance_records', 'list_compliance_requirements', 'list_compliance_waivers', 'read_compliance_reference', 'revoke_compliance_pack', 'revoke_compliance_waiver', 'save_compliance_obligation', 'save_compliance_requirement', 'submit_compliance_record', 'withdraw_compliance_record']) assert.ok(names.includes(want), want);
  assert.ok(capabilities.filter((c) => c.tag === 'Compliance').every((c) => c.summary.length > 40));
});
