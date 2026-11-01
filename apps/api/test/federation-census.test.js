// Federation extras (#703) 3/3: census analytics through the governed KPI layer. Numbers reconcile to the licence register, definitions are published,
// person counts under 5 are hidden (with the next smallest figure, so nothing can be recovered by subtraction), gender is opt-in and withdrawable,
// access is read live, and nothing is ever listed person by person.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');
const { refreshYouth } = await import('../src/youth.js');

let server, base, n = 0, sport, admin, owner, auditor, limited, outsider, N, R1, R2, R3;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined))}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const person = async (roles = ['athlete'], over = {}) => {
  n++;
  const r = (await q("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx,birth_year) VALUES ($1,$2,$3,'x','x',$1,$4) RETURNING id", [`cen_${n}`, `Census Person ${n}`, roles, over.birth_year ?? null]))[0];
  return { id: r.id, token: await signToken({ id: r.id, roles }) };
};
const YEAR = new Date().getFullYear();
const day = (d = 0) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const AS_OF = day(0);
const P = { preset: 'custom', from: AS_OF, to: AS_OF };
const value = (u, key, scopeId, extra = {}) => api('GET', `/analytics/metrics/${key}/value`, { token: u.token, query: { scope_type: 'federation', scope_id: scopeId, ...P, ...extra } });
const typeOf = {};
let lic = 0;
const licence = async (holder, body, over = {}) => {
  typeOf[body.id] ??= (await q("INSERT INTO fed_licence_types(body_id, name, holder_role, sport_id, created_by) VALUES ($1,'Player','athlete',$2,$3) RETURNING id", [body.id, sport.id, owner.id]))[0].id;
  lic++;
  return (await q(
    `INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, status, licence_no, public_code, issued_on, expires_on, previous_id, decided_at, decided_by)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9, $10::date, $11) RETURNING id`,
    [body.id, typeOf[body.id], holder.id, over.status ?? 'active', `L-${lic}`, `C${String(lic).padStart(11, '0')}`, over.issued_on ?? day(-100), over.expires_on ?? day(200), over.previous_id ?? null, over.issued_on ?? day(-100), owner.id]))[0].id;
};
const makeBody = async (name, level, region, sportId = sport.id) => {
  const b = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name, level, abbreviation: `C${region.slice(0, 3).toUpperCase()}`, country: 'SG', sports: [{ sport_id: sportId }] } }), 201);
  await q('UPDATE governing_bodies SET region=$2 WHERE id=$1', [b.id, region]);
  return b;
};
const under = async (parent, child) => {
  const link = must(await api('POST', '/federation/links', { token: owner.token, body: { parent_id: parent.id, child_id: child.id } }), 201);
  if (link.status !== 'recognised') must(await api('POST', `/federation/links/${link.id}/respond`, { token: owner.token, body: { decision: 'recognise' } }));
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0); base = `http://localhost:${server.address().port}`;
  sport = (await q("SELECT id FROM sports WHERE slug='badminton'"))[0];
  const a = (await q("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('cen_admin','Admin',ARRAY['admin'],'x','x','cen_admin') RETURNING id"))[0];
  admin = { id: a.id, token: await signToken({ id: a.id, roles: ['admin'] }) };
  owner = await person(['organizer']); auditor = await person(); limited = await person(); outsider = await person();
  N = await makeBody('Census National', 'national', 'Nation');
  R1 = await makeBody('Census North', 'regional', 'North'); R2 = await makeBody('Census West', 'regional', 'West'); R3 = await makeBody('Census East', 'regional', 'East');
  for (const r of [R1, R2, R3]) await under(N, r);
  must(await api('POST', `/federation/bodies/${N.id}/roles`, { token: owner.token, body: { user_id: auditor.id, role: 'auditor' } }), 201);
  must(await api('POST', `/federation/bodies/${N.id}/roles`, { token: owner.token, body: { user_id: limited.id, role: 'auditor', sport_id: sport.id } }), 201);
  // North 12 people, West 6, East 3
  for (const [b, count] of [[R1, 12], [R2, 6], [R3, 3]]) for (let i = 0; i < count; i++) {
    const birth = i < 3 ? YEAR - 15 : i < 9 ? YEAR - 30 : null;      // 3 young, 6 adults aged ~30, the rest unknown
    await licence(await person(['athlete'], { birth_year: birth }), b);
  }
});
after(async () => { server.close(); await pool.end(); });

test('members reconcile to the licence register, definitions are published, and the same sports/bodies drive both', async () => {
  const v = must(await value(auditor, 'members', N.id));
  assert.equal(v.value, 21); assert.equal(v.definition.key, 'members'); assert.equal(v.metric.version, 1); assert.match(v.metric.definition_hash, /^[0-9a-f]{64}$/);
  const reg = must(await api('GET', `/federation/bodies/${N.id}/reports/licences`, { token: auditor.token, query: { as_of: AS_OF, limit: 100 } }));
  assert.equal(reg.total, v.value, 'the census equals the number of licences in force in the register on the same date');
  // a body sees only its own subtree
  assert.equal(must(await value(owner, 'members', R2.id)).value, 6);
  // one person with two licences counts once
  const p = (await q('SELECT holder_id FROM fed_licences WHERE body_id=$1 LIMIT 1', [R2.id]))[0];
  const t2 = (await q("INSERT INTO fed_licence_types(body_id, name, holder_role, sport_id, created_by) VALUES ($1,'Coach','coach',$2,$3) RETURNING id", [R2.id, sport.id, owner.id]))[0].id;
  await q("INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, status, licence_no, public_code, issued_on, expires_on, decided_at, decided_by) VALUES ($1,$2,$3,$3,'active','L-X1','CXXXXXXXXXX1',$4::date,$5::date,$4::date,$6)", [R2.id, t2, p.holder_id, day(-50), day(100), owner.id]);
  assert.equal(must(await value(owner, 'members', R2.id)).value, 6, 'a person is counted once however many licences they hold');
  assert.equal(must(await api('GET', `/federation/bodies/${R2.id}/reports/licences`, { token: owner.token, query: { as_of: AS_OF } })).total, 7, 'the register lists licences, the census counts people');
  // revoked, rejected and withdrawn are never members
  const rev = await person(); await licence(rev, R2, { status: 'revoked' });
  assert.equal(must(await value(owner, 'members', R2.id)).value, 6);
  // definitions are public and say where they come from
  const defs = must(await api('GET', '/federation/metric-definitions'));
  for (const k of ['members', 'new_members', 'licence_renewals', 'renewal_rate']) {
    const d = defs.find((x) => x.key === k);
    assert.ok(d, k); assert.equal(d.source, 'kpi_layer'); assert.ok(d.definition.length > 60); assert.match(d.definition_hash, /^[0-9a-f]{64}$/);
  }
});

test('small cells: counts under 5 are hidden and the next smallest figure goes with them', async () => {
  const byRegion = must(await value(auditor, 'members', N.id, { group_by: 'region' }));
  const g = Object.fromEntries(byRegion.groups.map((x) => [x.label, x]));
  assert.equal(g.North.value, 12); assert.equal(g.North.suppressed, undefined);
  assert.equal(g.East.value, null); assert.equal(g.East.suppressed, true, 'East has 3 people');
  assert.equal(g.West.value, null); assert.equal(g.West.suppressed, true, 'West (6) is the next smallest, hidden with it so East cannot be found by subtraction');
  assert.equal(byRegion.value, 21);
  assert.ok(byRegion.warnings.some((w) => w.code === 'suppressed'));
  // a body with fewer than 5 people has no figure at all, and its source counts are hidden too
  const east = must(await value(owner, 'members', R3.id));
  assert.equal(east.value, null); assert.equal(east.suppressed, true); assert.equal(east.records, null);
  assert.ok(east.sources.every((s) => s.records === null));
  // by age band: nine young people and nine adults are visible; the three with no birth year are a small cell, hidden with the next smallest (9)
  const age = must(await value(auditor, 'members', N.id, { group_by: 'age_band' }));
  const a = Object.fromEntries(age.groups.map((x) => [x.label, x]));
  assert.equal(a['Not stated'].suppressed, true, 'three people with no birth year');
  assert.equal(Object.values(a).filter((x) => x.suppressed).length, 2, 'the hidden figure and the next smallest');
  assert.equal(Object.values(a).filter((x) => !x.suppressed).length, 1);
});

test('gender is opt-in, encrypted, counted only when given, and gone from the census on withdrawal', async () => {
  const North = await q('SELECT holder_id FROM fed_licences WHERE body_id=$1 ORDER BY id', [R1.id]);
  const people = [];
  for (const row of North) people.push({ id: row.holder_id, token: await signToken({ id: row.holder_id, roles: ['athlete'] }) });
  // nobody has given a gender yet: everyone is "not stated"
  const none = must(await value(auditor, 'members', R1.id, { group_by: 'gender' }));
  assert.deepEqual(none.groups.map((x) => [x.label, x.value]), [['Not stated', 12]]);
  // seven give female, five give male
  for (const [i, p] of people.entries()) must(await api('POST', '/demographics', { token: p.token, body: { gender: i < 7 ? 'female' : 'male', consent: true } }));
  assert.equal((await api('POST', '/demographics', { token: people[0].token, body: { gender: 'female' } })).status, 400, 'consent must be given');
  const stored = (await q('SELECT gender_enc, gender_idx FROM person_demographics LIMIT 1'))[0];
  assert.ok(!/female|male/.test(stored.gender_enc), 'the value is encrypted'); assert.match(stored.gender_idx, /^[0-9a-f]{64}$/);
  const withG = must(await value(auditor, 'members', R1.id, { group_by: 'gender' }));
  const gm = Object.fromEntries(withG.groups.map((x) => [x.label, x.value]));
  assert.equal(gm.Female, 7); assert.equal(gm.Male, 5);
  // reads are audited, and only the person (or a guardian) can read it
  assert.equal(must(await api('GET', '/demographics', { token: people[0].token })).gender, 'female');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='read_demographics' AND actor_id=$1", [people[0].id])).length);
  assert.equal((await api('GET', '/demographics', { token: outsider.token, query: { user_id: people[0].id } })).status, 404);
  // one withdraws: the census forgets it at once, and the row is kept as history
  must(await api('DELETE', '/demographics', { token: people[0].token }));
  assert.equal(must(await api('GET', '/demographics', { token: people[0].token })).held, false);
  const after = must(await value(auditor, 'members', R1.id, { group_by: 'gender' }));
  const am = Object.fromEntries(after.groups.map((x) => [x.label, x]));
  assert.equal(am.Female.value, 6);
  assert.equal(am['Not stated'].suppressed, true, 'one person who withdrew is a small cell');
  assert.equal(am.Male.suppressed, true, 'and the next smallest figure (5) goes with it, so the one cannot be found by subtraction');
  assert.equal((await q('SELECT count(*)::int AS n FROM person_demographics WHERE user_id=$1 AND withdrawn_at IS NOT NULL', [people[0].id]))[0].n, 1);
  // a young person's gender is given by their guardian, never alone
  const kid = await person(['athlete']), guardian = await person(['parent']);
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, kid.id]);
  assert.equal((await api('POST', '/demographics', { token: kid.token, body: { gender: 'female', consent: true } })).status, 403);
  assert.equal(must(await api('POST', '/demographics', { token: guardian.token, body: { user_id: kid.id, gender: 'female', consent: true } })).by, 'guardian');
});

test('growth and renewals: new members by month, renewals, and the renewal rate', async () => {
  const from = day(-60), to = day(0);
  // 6 licences ran out in the window; 5 of them were renewed
  const olds = [];
  for (let i = 0; i < 6; i++) { const h = await person(); olds.push({ h, id: await licence(h, R1, { issued_on: day(-400), expires_on: day(-10 - i) }) }); }
  for (const o of olds.slice(0, 5)) await licence(o.h, R1, { issued_on: day(-5), expires_on: day(360), previous_id: o.id });
  const rate = must(await value(auditor, 'renewal_rate', R1.id, { preset: 'custom', from, to }));
  assert.equal(rate.denominator, 6); assert.equal(rate.numerator, 5); assert.equal(rate.value, 83.3);
  const ren = must(await value(auditor, 'licence_renewals', R1.id, { preset: 'custom', from, to }));
  assert.equal(ren.value, 5);
  // a renewal is not a new member; a first-ever licence is
  const fresh = must(await value(auditor, 'new_members', R1.id, { preset: 'custom', from: day(-3), to }));
  assert.equal(fresh.value, 0, 'no first-ever licences in the last three days: renewals do not count');
  for (let i = 0; i < 6; i++) await licence(await person(), R1, { issued_on: day(-2), expires_on: day(300) });
  const now = must(await value(auditor, 'new_members', R1.id, { preset: 'custom', from: day(-3), to, group_by: 'month' }));
  assert.equal(now.value, 6);
  assert.ok(now.groups.length >= 1 && now.groups.reduce((a, x) => a + (x.value ?? 0), 0) <= 6);
  // revoked licences are not a lapse
  const rv = await person(); await licence(rv, R1, { status: 'revoked', issued_on: day(-400), expires_on: day(-20) });
  assert.equal(must(await value(auditor, 'renewal_rate', R1.id, { preset: 'custom', from, to })).denominator, 6);
});

test('access is read live: staff need a body-wide reports role, outsiders get a 404, and there is no person-level drill-down', async () => {
  assert.equal((await value(outsider, 'members', N.id)).status, 404);
  const lim = await value(limited, 'members', N.id);
  assert.equal(lim.status, 403, 'a reports role limited to one sport cannot read figures across every sport');
  assert.equal((await api('GET', '/analytics/metrics/members/value', { token: auditor.token, query: { scope_type: 'organisation', scope_id: N.id, ...P } })).status, 422, 'a federation metric is not available in an organisation scope');
  assert.equal((await api('GET', '/analytics/metrics/revenue/value', { token: auditor.token, query: { scope_type: 'federation', scope_id: N.id, ...P } })).status, 422, 'and other metrics cannot be read in a federation scope');
  const drill = await api('GET', '/analytics/metrics/members/records', { token: auditor.token, query: { scope_type: 'federation', scope_id: N.id, ...P } });
  assert.equal(drill.status, 403); assert.match(JSON.stringify(drill.body), /aggregate/);
  // the scope picker offers the body to those who can read it, and not to others
  assert.ok(must(await api('GET', '/analytics/scopes', { token: auditor.token })).some((s) => s.type === 'federation' && s.id === N.id));
  assert.ok(!must(await api('GET', '/analytics/scopes', { token: limited.token })).some((s) => s.type === 'federation'));
  assert.ok(!must(await api('GET', '/analytics/scopes', { token: outsider.token })).some((s) => s.type === 'federation'));
  // losing the role ends access at once
  await q("UPDATE governing_body_roles SET status='revoked' WHERE body_id=$1 AND user_id=$2", [N.id, auditor.id]);
  assert.equal((await value(auditor, 'members', N.id)).status, 404);
  await q("UPDATE governing_body_roles SET status='active' WHERE body_id=$1 AND user_id=$2", [N.id, auditor.id]);
});

test('export pack: CSV, XLSX and PDF carry the same suppressed figures and no person', async () => {
  const csv = await api('GET', '/analytics/export', { token: auditor.token, query: { key: 'members', scope_type: 'federation', scope_id: N.id, ...P, group_by: 'region', format: 'csv' } });
  assert.equal(csv.status, 200, JSON.stringify(csv.body));
  assert.match(csv.body.content_type, /csv/); assert.ok(csv.body.content.includes('North'));
  assert.ok(!/Census Person/.test(csv.body.content), 'no person is named in a census export');
  assert.ok(!/\b3\b.*East|East.*\b3\b/.test(csv.body.content), 'the hidden East figure is not in the file');
  for (const format of ['xlsx', 'pdf']) assert.equal((await api('GET', '/analytics/export', { token: auditor.token, query: { key: 'members', scope_type: 'federation', scope_id: N.id, ...P, format } })).status, 200, format);
  assert.equal((await api('GET', '/analytics/export', { token: outsider.token, query: { key: 'members', scope_type: 'federation', scope_id: N.id, ...P, format: 'csv' } })).status, 404);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='export' AND actor_id=$1", [auditor.id])).length);
});

test('every sport in the catalogue can be counted: the census is sport-neutral and each sport filters on its own licences', async () => {
  const sports = await q('SELECT id, slug FROM sports ORDER BY slug');
  assert.ok(sports.length > 100);
  for (const s of sports) {
    const r = await api('GET', '/analytics/metrics/members/value', { token: admin.token, query: { scope_type: 'platform', ...P, sport_ids: s.id } });
    assert.equal(r.status, 200, `${s.slug}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.value === null || typeof r.body.value === 'number', s.slug);
  }
  const bad = must(await api('GET', '/analytics/metrics/members/value', { token: admin.token, query: { scope_type: 'platform', ...P, sport_ids: sport.id } }));
  const truth = (await q("SELECT count(DISTINCT holder_id)::int AS n FROM fed_licences WHERE status IN ('active','suspended','expired') AND issued_on <= current_date AND expires_on >= current_date"))[0].n;
  assert.equal(bad.value, truth, 'the platform census equals an independent count of people holding a licence in force today');
});

test('birth year is derived from the date of birth (never decrypted at query time) and the capabilities are on REST, OpenAPI and MCP', async () => {
  const { encrypt } = await import('../src/crypto.js');
  const u = await person(['athlete']);
  await q('UPDATE users SET dob_enc=$2 WHERE id=$1', [u.id, encrypt('1990-06-15', 'users.dob')]);
  await refreshYouth(u.id, null);
  assert.equal((await q('SELECT birth_year FROM users WHERE id=$1', [u.id]))[0].birth_year, 1990);
  const names = ['get_demographics', 'set_demographics', 'withdraw_demographics'];
  for (const nme of names) assert.ok(capabilities.find((c) => c.name === nme), nme);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nme of names) assert.ok(ops.has(nme), `openapi ${nme}`);
});
