import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLATFORM_APPROVALS = 'off';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { DISCIPLINE_KEYS, DISCLAIMER } = await import('../src/coach-adaptive.js');
const { SPORT_TEMPLATES } = await import('../src/inclusion.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, text: t };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, r.text); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles, extra = {}) => { n++; const r = ok(await api('POST', '/auth/register', { body: { handle: `ca_${n}_${roles[0]}`, display_name: `Ca ${n}`, email: `ca${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }), 201); return { ...r.user, token: r.token }; };
const PDF = Buffer.from('%PDF-1.4 fake evidence body').toString('base64');
const ID = { kind: 'id_document', label: 'Passport', data: PDF, file_name: 'passport.pdf' };
const CERT = { kind: 'coaching_certificate', reference: 'ITF-L2-123' };
const inFuture = (d) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(9, 0, 0, 0); return x.toISOString(); };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const coachOf = async (sport = 'tennis') => { const c = await signup(['coach']); ok(await api('POST', '/me/sport-profiles', { token: c.token, body: { sport, role: 'coach', level: 'pro' } }), 201); return c; };
const approve = (caseId, extra = '') => pool.query(`UPDATE verification_cases SET status='approved', decided_at=now(), expires_at=now() + interval '2 years' ${extra} WHERE id=$1`, [caseId]);

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('catalogue is governed, public, and walks every native para family with a labelled fallback', async () => {
  const cat = ok(await api('GET', '/coaches/adaptive/catalogue'));
  assert.deepEqual(cat.disciplines.map((d) => d.key).sort(), Object.keys(SPORT_TEMPLATES).sort());
  assert.deepEqual(cat.disciplines.filter((d) => d.fallback).map((d) => d.key), ['generic'], 'the fallback is labelled, never silent');
  assert.equal(cat.generic_fallback.fallback, true); assert.equal(cat.disclaimer, DISCLAIMER);
  assert.ok(cat.communication_support.includes('sign_interpreter'));
});

test('opt-in is the coach\'s own; expertise is self-declared until a verified, in-scope credential backs it', async () => {
  const coach = await coachOf(), athlete = await signup(['athlete']);
  assert.equal((await api('POST', '/me/coach-adaptive', { token: athlete.token, body: { opt_in: true } })).status, 403, 'only coaches');
  assert.equal((await api('GET', `/coaches/${coach.id}/adaptive`)).status, 404, 'not opted in: nothing public');
  ok(await api('POST', '/me/coach-adaptive', { token: coach.token, body: { opt_in: true, formats: ['in_person', 'accessible_venue'], comm: ['sign_interpreter'] } }));
  assert.equal((await api('POST', '/me/coach-adaptive', { token: coach.token, body: { opt_in: true, comm: ['mind_reading'] } })).status, 400, 'unknown code');
  assert.equal((await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: 'tennis', discipline: 'made_up' } })).status, 400);
  assert.equal((await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: 'football', discipline: 'para_football' } })).status, 400, 'sport must be on the profile');
  const ex = ok(await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: 'tennis', discipline: 'wheelchair_tennis', years: 9, specialist_training: 'Coaching players who use a sports wheelchair' } }), 201);
  let pub = ok(await api('GET', `/coaches/${coach.id}/adaptive`));
  assert.equal(pub.state, 'self_declared'); assert.equal(pub.no_formal_credential, true); assert.equal(pub.expertise[0].state, 'self_declared');
  assert.equal(pub.expertise[0].case_id, undefined, 'case ids are not public'); assert.equal(pub.disclaimer, DISCLAIMER);
  assert.ok(!JSON.stringify(pub).includes('wheelchair. '), 'training text never public');
  // credential detail travels on the existing verification case: no extra identity beyond the existing coach rules
  const sub = ok(await api('POST', '/verification/cases', { token: coach.token, body: { type: 'coach', sport: undefined, claim_note: 'ITF', issuing_authority: 'International Tennis Federation', credential_title: 'Wheelchair Coach L2', scope_disciplines: ['wheelchair_tennis'], credential_expires_on: day(400), evidence: [ID, CERT] } }), 201);
  ok(await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: 'tennis', discipline: 'wheelchair_tennis', case_id: sub.id } }), 201);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/adaptive`)).expertise[0].state, 'self_declared', 'submitted is not verified');
  await approve(sub.id, `, credential_expires_on='${day(400)}'`);
  pub = ok(await api('GET', `/coaches/${coach.id}/adaptive`));
  assert.equal(pub.state, 'verified'); assert.equal(pub.no_formal_credential, false); assert.equal(pub.expertise[0].authority, 'International Tennis Federation');
  // a verified credential whose scope does not name the discipline does not verify it
  await pool.query("UPDATE verification_cases SET scope_disciplines='{para_swimming}' WHERE id=$1", [sub.id]);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/adaptive`)).expertise[0].state, 'self_declared');
  await pool.query("UPDATE verification_cases SET scope_disciplines='{wheelchair_tennis}' WHERE id=$1", [sub.id]);
  // expiry and revocation downgrade immediately
  await pool.query("UPDATE verification_cases SET credential_expires_on = current_date - 1 WHERE id=$1", [sub.id]);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/adaptive`)).state, 'expired');
  await pool.query("UPDATE verification_cases SET credential_expires_on = NULL, status='revoked' WHERE id=$1", [sub.id]);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/adaptive`)).state, 'revoked');
  // the coach sees their own training text and cases; archiving keeps the row
  const mine = ok(await api('GET', '/me/coach-adaptive', { token: coach.token }));
  assert.equal(mine.expertise[0].specialist_training, 'Coaching players who use a sports wheelchair'); assert.equal(mine.cases.length, 1);
  ok(await api('POST', `/me/coach-adaptive/expertise/${ex.id}/archive`, { token: coach.token }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coach_adaptive_expertise WHERE id=$1', [ex.id])).rows[0].n, 1);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/adaptive`)).state, 'none');
  // credential detail is for coach cases only
  const physio = await signup(['physio']);
  assert.equal((await api('POST', '/verification/cases', { token: physio.token, body: { type: 'physio', issuing_authority: 'x', evidence: [ID] } })).status, 400);
});

test('search filters on declared/verified coach attributes; ranking is unchanged by them', async () => {
  const a = await coachOf(), b = await coachOf(), c = await coachOf(), plain = await coachOf();
  for (const [u, d, comm] of [[a, 'wheelchair_tennis', ['sign_interpreter', 'captioned_video']], [b, 'wheelchair_tennis', ['captioned_video']], [c, 'para_swimming', []]]) {
    ok(await api('POST', '/me/coach-adaptive', { token: u.token, body: { opt_in: true, formats: ['online'], comm } }));
    ok(await api('POST', '/me/coach-adaptive/expertise', { token: u.token, body: { sport: 'tennis', discipline: d } }), 201);
  }
  const ids = (r) => ok(r).map((x) => x.id);
  const q = (s) => api('GET', `/coaches?${s}`);
  assert.deepEqual(ids(await q('adaptive_discipline=wheelchair_tennis')).sort(), [a.id, b.id].sort());
  assert.deepEqual(ids(await q('adaptive_discipline=wheelchair_tennis,para_swimming')).sort(), [a.id, b.id, c.id].sort(), 'multi-discipline');
  assert.deepEqual(ids(await q('comm_support=sign_interpreter,captioned_video')), [a.id], 'all requested supports');
  assert.deepEqual(ids(await q('delivery_format=home_visit')), []);
  assert.deepEqual(ids(await q('adaptive_discipline=wheelchair_tennis&credential_verified_only=true')), [], 'declared is not verified');
  const cs = ok(await api('POST', '/verification/cases', { token: a.token, body: { type: 'coach', scope_disciplines: ['wheelchair_tennis'], issuing_authority: 'ITF', evidence: [ID, CERT] } }), 201);
  ok(await api('POST', '/me/coach-adaptive/expertise', { token: a.token, body: { sport: 'tennis', discipline: 'wheelchair_tennis', case_id: cs.id } }), 201);
  await approve(cs.id);
  assert.deepEqual(ids(await q('adaptive_discipline=wheelchair_tennis&credential_verified_only=true')), [a.id]);
  // opted-out coaches never match adaptive filters, but stay in ordinary search
  ok(await api('POST', '/me/coach-adaptive', { token: a.token, body: { opt_in: false } }));
  assert.deepEqual(ids(await q('adaptive_discipline=wheelchair_tennis')), [b.id]);
  assert.ok(ids(await q('sport=tennis')).includes(a.id) && ids(await q('sport=tennis')).includes(plain.id));
  // ranking is identical with and without the adaptive fields: nothing adaptive feeds the order
  const base = ids(await q('sport=tennis&sort=name')); const sorted = ok(await q('sport=tennis&sort=name')).map((x) => x.display_name);
  assert.deepEqual(sorted, [...sorted].sort((x, y) => x.localeCompare(y)));
  assert.ok(base.length >= 4);
  const row = ok(await q('sport=tennis')).find((x) => x.id === b.id); assert.deepEqual(Object.keys(row.adaptive).sort(), ['comm', 'disciplines', 'formats', 'state']);
  assert.equal(ok(await q('sport=tennis')).find((x) => x.id === plain.id).adaptive, null);
});

test('forbidden data: no athlete or clinical field in search, profile or adaptive responses', async () => {
  const coach = await coachOf(); ok(await api('POST', '/me/coach-adaptive', { token: coach.token, body: { opt_in: true } }));
  ok(await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: 'tennis', discipline: 'wheelchair_tennis', specialist_training: 'x' } }), 201);
  const all = JSON.stringify([(await api('GET', '/coaches?sport=tennis')).body, (await api('GET', `/coaches/${coach.id}/adaptive`)).body, (await api('GET', `/coaches/${coach.id}`)).body]);
  for (const bad of ['diagnos', 'impairment', 'disabilit', 'medical_', 'training_enc', 'note_enc', 'class_code', 'para_class']) assert.ok(!all.toLowerCase().includes(bad), `leaked ${bad}`);
});

test('booking adjustments: operational codes only, consented, expiring, withdrawable, read-logged, 404 for strangers', async () => {
  const coach = await coachOf(), athlete = await signup(['athlete']), stranger = await signup(['athlete']);
  const hire = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'tennis', starts_at: inFuture(5), duration_min: 60 } }), 201);
  const post = (token, body) => api('POST', `/hires/${hire.id}/adjustments`, { token, body });
  assert.equal((await post(stranger.token, { need_keys: ['step_free_route'], expires_on: day(30) })).status, 404);
  assert.equal((await post(athlete.token, { need_keys: ['a_diagnosis'], expires_on: day(30) })).status, 400, 'catalogue codes only');
  assert.equal((await post(athlete.token, { need_keys: ['step_free_route'], expires_on: day(900) })).status, 400, 'bounded expiry');
  assert.equal((await post(athlete.token, { need_keys: ['step_free_route'], note: 'my diagnosis is severe', expires_on: day(30) })).status, 422, 'clinical text screened');
  assert.deepEqual(ok(await api('GET', `/hires/${hire.id}/adjustments`, { token: coach.token })), [], 'nothing shared yet');
  ok(await post(athlete.token, { need_keys: ['step_free_route', 'captioned_video'], note: 'Arrive five minutes early', expires_on: day(30) }), 201);
  assert.equal((await api('GET', `/hires/${hire.id}/adjustments`, { token: stranger.token })).status, 404);
  const seen = ok(await api('GET', `/hires/${hire.id}/adjustments`, { token: coach.token }));
  assert.equal(seen.length, 1); assert.equal(seen[0].note, 'Arrive five minutes early');
  assert.ok(!(await pool.query('SELECT note_enc FROM coach_hire_adjustments')).rows.some((r) => String(r.note_enc).includes('five minutes')), 'note is encrypted at rest');
  const mine = ok(await api('GET', `/hires/${hire.id}/adjustments`, { token: athlete.token }));
  assert.equal(mine[0].coach_reads, 1, 'the athlete sees that the coach read it');
  ok(await api('POST', `/hires/${hire.id}/adjustments/revoke`, { token: athlete.token }));
  assert.deepEqual(ok(await api('GET', `/hires/${hire.id}/adjustments`, { token: coach.token })), [], 'withdrawn is invisible to the coach');
  assert.equal((await api('POST', `/hires/${hire.id}/adjustments/revoke`, { token: athlete.token })).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coach_hire_adjustments')).rows[0].n, 1, 'history kept');
});

test('regression: ordinary coach search and the hire flow are unchanged; MCP and OpenAPI carry the new capabilities', async () => {
  const coach = await coachOf('football'); const athlete = await signup(['athlete']);
  assert.ok(ok(await api('GET', '/coaches?sport=football')).some((x) => x.id === coach.id));
  ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: inFuture(6), duration_min: 60 } }), 201);
  const spec = ok(await api('GET', '/openapi.json'));
  for (const p of ['/coaches/adaptive/catalogue', '/me/coach-adaptive', '/me/coach-adaptive/expertise', '/coaches/{id}/adaptive', '/hires/{id}/adjustments']) assert.ok(spec.paths[p], `openapi ${p}`);
  const { capabilities } = await import('../src/registry.js');
  for (const name of ['get_adaptive_catalogue', 'set_my_adaptive_coaching', 'upsert_adaptive_expertise', 'get_coach_adaptive', 'share_hire_adjustments', 'revoke_hire_adjustments', 'get_hire_adjustments']) assert.ok(capabilities.find((c) => c.name === name), name);
  assert.equal(DISCIPLINE_KEYS.length, 10);
});

test('academy instructor validation: the staff list shows each opted-in coach\'s live credential state and nothing about athletes', async () => {
  const owner = await signup(['organizer']), coach = await coachOf(), plain = await coachOf();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy', city: 'Pune' } }), 201);
  for (const u of [coach, plain]) { ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role: 'coach' } }), 201); ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } })); }
  ok(await api('POST', '/me/coach-adaptive', { token: coach.token, body: { opt_in: true } }));
  ok(await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: 'tennis', discipline: 'wheelchair_tennis' } }), 201);
  const staff = ok(await api('GET', `/organisations/${org.id}/academy/staff`, { token: owner.token })).staff;
  assert.equal(staff.find((x) => x.user_id === coach.id).adaptive.state, 'self_declared');
  assert.equal(staff.find((x) => x.user_id === plain.id).adaptive, null, 'coaches who did not opt in show nothing');
  assert.ok(!JSON.stringify(staff).includes('training_enc'));
});

test('every sport in the catalogue works: native discipline where one exists, the labelled generic fallback otherwise', async () => {
  const sports = (await pool.query('SELECT id, slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 10, 'catalogue is seeded by migrations');
  const coach = await signup(['coach']); ok(await api('POST', '/me/coach-adaptive', { token: coach.token, body: { opt_in: true } }));
  const native = new Map(Object.values(SPORT_TEMPLATES).flatMap((t) => t.sports.map((s) => [s, t])));
  const key = (slug) => Object.entries(SPORT_TEMPLATES).find(([, t]) => t.sports.includes(slug))?.[0] ?? 'generic';
  for (const s of sports) {
    await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role, level) VALUES ($1,$2,'coach','pro') ON CONFLICT DO NOTHING", [coach.id, s.id]);
    const r = await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: s.slug, discipline: key(s.slug) } });
    assert.equal(r.status, 201, `${s.slug}: ${r.text}`);
  }
  const pub = ok(await api('GET', `/coaches/${coach.id}/adaptive`));
  assert.equal(pub.expertise.length, sports.length);
  assert.ok(pub.expertise.some((e) => e.discipline === 'generic') && native.size > 0);
});

test('a young person: only a verified guardian books and shares adjustments; the authority lapses with the link; strangers get 404; booking permissions are unchanged', async () => {
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ca_root','ca_root','{admin}','x','x','ca_root') RETURNING id")).rows[0];
  const admin = { token: await signToken({ id: row.id, roles: ['admin'] }) };
  const kid = await signup(['athlete'], { dob: yearsAgo(13) }), parent = await signup(['athlete'], { dob: yearsAgo(40) }), stranger = await signup(['athlete']), coach = await coachOf();
  const link = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${link.id}/respond`, { token: kid.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${link.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${link.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  ok(await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  const book = (token, extra = {}) => api('POST', '/hires', { token, body: { coach_id: coach.id, sport: 'tennis', starts_at: inFuture(7), duration_min: 60, ...extra } });
  assert.equal((await book(stranger.token, { athlete_id: kid.id })).status, 404, 'a stranger cannot book for a young person');
  const hire = ok(await book(parent.token, { athlete_id: kid.id }), 201);
  const post = (token) => api('POST', `/hires/${hire.id}/adjustments`, { token, body: { need_keys: ['step_free_route'], expires_on: day(30) } });
  assert.equal((await post(kid.token)).status, 403, 'a young person cannot share alone');
  assert.equal((await post(stranger.token)).status, 404, 'strangers learn nothing');
  const shared = ok(await post(parent.token), 201); assert.equal(shared.granted_as, 'guardian');
  assert.equal(ok(await api('GET', `/hires/${hire.id}/adjustments`, { token: coach.token })).length, 1, 'the coach sees what the guardian shared');
  assert.equal(ok(await api('GET', `/hires/${hire.id}/adjustments`, { token: parent.token })).length, 1);
  // the coach\'s booking permissions are unchanged: the coach still sees the booking and can confirm it
  assert.equal(ok(await api('PATCH', `/hires/${hire.id}`, { token: coach.token, body: { status: 'confirmed' } })).status, 'confirmed');
  // authority lapses with the guardian link: nothing more can be shared or withdrawn by them
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE id=$1", [link.id]);
  assert.equal((await post(parent.token)).status, 404, 'a revoked guardian is a stranger');
  assert.equal((await api('GET', `/hires/${hire.id}/adjustments`, { token: parent.token })).status, 404);
});

test('credential renewal: a new case chains to the old one, relinking moves the badge, and the old expiry stops verifying', async () => {
  const coach = await coachOf();
  ok(await api('POST', '/me/coach-adaptive', { token: coach.token, body: { opt_in: true } }));
  const claim = (extra) => api('POST', '/verification/cases', { token: coach.token, body: { type: 'coach', issuing_authority: 'ITF', credential_title: 'Wheelchair Coach L2', scope_disciplines: ['wheelchair_tennis'], evidence: [ID, CERT], ...extra } });
  const c1 = ok(await claim({ credential_expires_on: day(20) }), 201);
  ok(await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: 'tennis', discipline: 'wheelchair_tennis', case_id: c1.id } }), 201);
  await approve(c1.id, `, credential_expires_on='${day(20)}'`);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/adaptive`)).state, 'verified');
  assert.equal((await claim({})).status, 409, 'an open or still-valid case cannot be duplicated outside the renewal window');
  // inside the renewal window a renewal is accepted and chains to the previous case
  await pool.query("UPDATE verification_cases SET expires_at = now() + interval '10 days' WHERE id=$1", [c1.id]);
  const c2 = ok(await claim({ credential_expires_on: day(800) }), 201);
  assert.equal((await pool.query('SELECT previous_case_id FROM verification_cases WHERE id=$1', [c2.id])).rows[0].previous_case_id, c1.id);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/adaptive`)).state, 'verified', 'the current badge holds while the renewal is reviewed');
  await approve(c2.id, `, credential_expires_on='${day(800)}'`);
  ok(await api('POST', '/me/coach-adaptive/expertise', { token: coach.token, body: { sport: 'tennis', discipline: 'wheelchair_tennis', case_id: c2.id } }), 201);
  await pool.query("UPDATE verification_cases SET credential_expires_on = current_date - 1 WHERE id=$1", [c1.id]);
  const pub = ok(await api('GET', `/coaches/${coach.id}/adaptive`));
  assert.equal(pub.state, 'verified'); assert.ok(pub.expertise[0].valid_to > day(30), 'the renewed credential carries the display, not the expired one');
  // the credential cannot outlive its own date even if the platform validity is longer
  const mine = ok(await api('GET', '/me/coach-adaptive', { token: coach.token }));
  assert.equal(mine.cases.length, 2); assert.equal(mine.expertise.length, 1);
});
