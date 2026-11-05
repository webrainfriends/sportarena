import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #808 Inclusive & adaptive academy programmes: access control, revocation, guardian authority, readiness and the catalogue.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { NEED_KEYS, SPORT_TEMPLATES, catalogue } = await import('../src/inclusion.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `wb_${n}_${roles[0]}`, display_name: `Wb ${n}`, email: `wb${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const inDays = (d, h = 10) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };

const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('inc_root','inc_root','{admin}','x','x','inc_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function guardianOf(child) {
  const parent = await signup(['athlete'], { dob: yearsAgo(40) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  ok(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  return { parent, link: l };
}
async function academy() {
  const owner = await signup(), coach = await signup(['coach']), other = await signup(['coach']);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Inclusion ${n}`, kind: 'academy' } }), 201);
  for (const u of [coach, other]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role: 'coach' } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U16 adaptive', coach_id: coach.id } }), 201);
  const kid = await signup(['athlete'], { dob: yearsAgo(13) }), { parent, link } = await guardianOf(kid);
  const adult = await signup(['athlete'], { dob: yearsAgo(22) }), outsider = await signup(['athlete'], { dob: yearsAgo(22) });
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kid.handle},yes\n${adult.handle},yes` } }), 201);
  const prog = (await pool.query("INSERT INTO academy_programmes(organisation_id, sport, title, status, public, created_by) VALUES ($1,'wheelchair-basketball','Wheelchair Basketball U16','published',true,$2) RETURNING *", [org.id, owner.id])).rows[0];
  const sess = (await pool.query("INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by) VALUES ($1,$2,$3,'Training', now() + interval '2 days', now() + interval '2 days 1 hour','published',$4) RETURNING *", [org.id, cohort.id, prog.id, owner.id])).rows[0];
  return { owner, coach, other, org, cohort, kid, parent, link, adult, outsider, prog, sess };
}
const share = (a, who, body) => api('POST', '/me/accommodations', { token: who.token, body: { organisation_id: a.org.id, need_keys: ['step_free_route'], audience_user_ids: [a.coach.id], expires_on: day(60), ...body } });

test('the capabilities are REST routes, OpenAPI operations and MCP tools from one definition', async () => {
  const names = ['get_inclusion_catalogue', 'save_programme_inclusion', 'get_programme_inclusion', 'get_programme_adjustments', 'set_venue_access_feature', 'list_venue_access_features', 'share_accommodation', 'list_my_accommodations',
    'revoke_accommodation', 'get_session_accommodations', 'get_session_readiness', 'get_inclusion_overview', 'get_athlete_inclusion', 'save_adapted_assessment', 'sign_off_adapted_assessment'];
  const have = new Set(capabilities.map((c) => c.name));
  for (const x of names) assert.ok(have.has(x), x);
  const spec = (await api('GET', '/openapi.json')).body;
  const ids = new Set(Object.values(spec.paths ?? {}).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const x of names) assert.ok(ids.has(x), `${x} in OpenAPI`);
});

test('catalogue: every sport template uses only known adjustments and features, and the fallback says so; no diagnosis vocabulary exists', () => {
  const c = catalogue();
  for (const t of Object.values(SPORT_TEMPLATES)) for (const k of t.needs) assert.ok(NEED_KEYS.includes(k), k);
  assert.ok(c.sport_templates.find((t) => t.key === 'generic').fallback);
  assert.ok(c.sport_templates.filter((t) => !t.fallback).length >= 9);
  assert.ok(!JSON.stringify(c).match(/diagnos|disorder|syndrome|impairment_type/i));
});

test('a disabled athlete is enrolled and shares needs without any diagnosis; clinical wording in the note is refused', async () => {
  const a = await academy();
  const r = ok(await share(a, a.adult, { need_keys: ['sport_wheelchair', 'lift_access'], note: 'Wide door please' }), 201);
  assert.equal(r.status, 'active'); assert.equal(r.granted_as, 'self');
  const bad = await share(a, a.adult, { note: 'diagnosed with a condition' });
  assert.equal(bad.status, 422);
  assert.equal((await share(a, a.adult, { need_keys: ['diagnosis'] })).status, 400);        // not in the vocabulary
  assert.equal((await share(a, a.outsider, {})).status, 404);                               // not known to this academy
  const raw = (await pool.query('SELECT note_enc FROM academy_accommodation_shares WHERE id=$1', [r.id])).rows[0].note_enc;
  assert.ok(!raw.includes('Wide door'), 'the note is encrypted at rest');
});

test('authority: a young person cannot share alone, a guardian can, a stranger and staff cannot decide for anyone', async () => {
  const a = await academy();
  assert.equal((await share(a, a.kid, { athlete_id: a.kid.id })).status, 403);
  assert.equal((await share(a, a.coach, { athlete_id: a.kid.id })).status, 404);
  const g = ok(await share(a, a.parent, { athlete_id: a.kid.id }), 201);
  assert.equal(g.granted_as, 'guardian');
  assert.equal((await api('POST', `/accommodations/${g.id}/revoke`, { token: a.coach.token })).status, 404);
  ok(await api('POST', `/accommodations/${g.id}/revoke`, { token: a.parent.token }));
});

test('only the audience sees the flags: the named coach does, another coach and the owner do not; every read is logged and shown to the athlete', async () => {
  const a = await academy();
  ok(await share(a, a.adult, { need_keys: ['sport_wheelchair', 'support_person'], audience_user_ids: [a.coach.id] }), 201);
  const seen = ok(await api('GET', `/academy/sessions/${a.sess.id}/accommodations`, { token: a.coach.token }));
  assert.equal(seen.athletes.length, 1); assert.equal(seen.athletes[0].athlete_id, a.adult.id);
  assert.deepEqual(seen.athletes[0].needs.map((x) => x.key).sort(), ['sport_wheelchair', 'support_person']);
  assert.ok(!JSON.stringify(seen).match(/diagnos|medical/i));
  assert.equal(ok(await api('GET', `/academy/sessions/${a.sess.id}/accommodations`, { token: a.owner.token })).athletes.length, 0, 'a director is not in the audience');
  assert.equal((await api('GET', `/academy/sessions/${a.sess.id}/accommodations`, { token: a.other.token })).status, 403);
  const mine = ok(await api('GET', '/me/accommodations', { token: a.adult.token, query: { organisation_id: a.org.id } }));
  assert.equal(mine.shares[0].viewed_count, 1); assert.ok(mine.log.some((e) => e.kind === 'share_viewed'));
});

test('revocation is immediate; so is a lapsed guardian authority', async () => {
  const a = await academy();
  const s = ok(await share(a, a.adult, {}), 201);
  const g = ok(await share(a, a.parent, { athlete_id: a.kid.id }), 201);
  const count = async () => ok(await api('GET', `/academy/sessions/${a.sess.id}/accommodations`, { token: a.coach.token })).athletes.length;
  assert.equal(await count(), 2);
  ok(await api('POST', `/accommodations/${s.id}/revoke`, { token: a.adult.token }));
  assert.equal(await count(), 1);
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE id=$1", [a.link.id]);
  assert.equal(await count(), 0, 'a share granted by a guardian lapses with the guardian link');
  const mine = ok(await api('GET', '/me/accommodations', { token: a.adult.token, query: { organisation_id: a.org.id } }));
  assert.equal(mine.shares[0].status, 'revoked'); assert.ok(g.id);
});

test('expiry window is enforced and audience roles resolve to the session coach', async () => {
  const a = await academy();
  assert.equal((await share(a, a.adult, { expires_on: day(-1) })).status, 400);
  assert.equal((await share(a, a.adult, { expires_on: day(900) })).status, 400);
  assert.equal((await share(a, a.adult, { audience_user_ids: [], audience_roles: [] })).status, 400);
  assert.equal((await share(a, a.adult, { audience_user_ids: [a.outsider.id] })).status, 400, 'named people must be academy members');
  ok(await share(a, a.adult, { audience_user_ids: [], audience_roles: ['coach'] }), 201);
  await pool.query("UPDATE academy_sessions SET status='published' WHERE id=$1", [a.sess.id]);
  assert.equal(ok(await api('GET', `/academy/sessions/${a.sess.id}/accommodations`, { token: a.coach.token })).athletes.length, 1);
});

test('programme inclusion: owner sets it, a coach cannot, stale versions conflict, a required class needs a scheme; applicants see offers only', async () => {
  const a = await academy();
  const body = { eligibility_mode: 'class_optional', class_schemes: ['wheelchair_basketball_1_4_5'], sport_templates: ['wheelchair_basketball'], offered_needs: ['sport_wheelchair', 'lift_access'], requirements: { venue_features: ['lift'], support_ratio: 4 }, pathway_variants: ['standard', 'adapted'] };
  assert.equal((await api('PATCH', `/academy/programmes/${a.prog.id}/inclusion`, { token: a.coach.token, body })).status, 403);
  const r = ok(await api('PATCH', `/academy/programmes/${a.prog.id}/inclusion`, { token: a.owner.token, body }));
  assert.equal(r.version, 1);
  assert.equal((await api('PATCH', `/academy/programmes/${a.prog.id}/inclusion`, { token: a.owner.token, body })).status, 409);
  ok(await api('PATCH', `/academy/programmes/${a.prog.id}/inclusion`, { token: a.owner.token, body: { ...body, row_version: 1 } }));
  assert.equal((await api('PATCH', `/academy/programmes/${a.prog.id}/inclusion`, { token: a.owner.token, body: { ...body, row_version: 2, eligibility_mode: 'class_required', class_schemes: [] } })).status, 400);
  assert.equal((await api('PATCH', `/academy/programmes/${a.prog.id}/inclusion`, { token: a.owner.token, body: { ...body, row_version: 2, offered_needs: ['nope'] } })).status, 400);
  const pub = ok(await api('GET', `/academy/programmes/${a.prog.id}/adjustments`));
  assert.deepEqual(pub.offered.map((x) => x.key).sort(), ['lift_access', 'sport_wheelchair']);
  assert.ok(!JSON.stringify(pub).match(/requirements|organisation_id/));
  const g = ok(await api('PATCH', `/academy/programmes/${a.prog.id}/inclusion`, { token: a.owner.token, body: { ...body, row_version: 2, sport_templates: ['generic'] } }));
  assert.deepEqual(g.fallback_templates, ['generic'], 'a generic fallback is labelled');
});

test('session readiness: venue features, support persons and equipment are checked from canonical sources; counts only', async () => {
  const a = await academy();
  await api('PATCH', `/academy/programmes/${a.prog.id}/inclusion`, { token: a.owner.token, body: { eligibility_mode: 'open', offered_needs: ['lift_access'], requirements: { venue_features: ['lift', 'accessible_changing'] } } });
  ok(await share(a, a.adult, { need_keys: ['support_person', 'sport_wheelchair'] }), 201);
  let r = ok(await api('GET', `/academy/sessions/${a.sess.id}/readiness`, { token: a.owner.token }));
  assert.equal(r.level, 'gap'); assert.equal(r.athletes_with_needs, 1);
  assert.ok(r.requirements.find((x) => x.code === 'venue_lift').state === 'gap' && r.requirements.find((x) => x.code === 'venue_lift').venue_booked === false);
  assert.equal(r.requirements.find((x) => x.code === 'support_persons').state, 'short');
  assert.equal(r.requirements.find((x) => x.code === 'equipment').state, 'manual');
  assert.ok(!JSON.stringify(r).includes(a.adult.id), 'no athlete is identifiable in readiness');
  assert.equal((await api('GET', `/academy/sessions/${a.sess.id}/readiness`, { token: a.outsider.token })).status, 404);
});

test('venue access features: only the venue manager records them; retired features are kept', async () => {
  const mgr = await signup(['venue_manager']), stranger = await signup(['venue_manager']);
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: `Arena ${n}`, city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
  assert.ok([403, 404].includes((await api('POST', `/venues/${v.id}/access-features`, { token: stranger.token, body: { feature: 'lift', present: true } })).status));
  assert.deepEqual(ok(await api('POST', `/venues/${v.id}/access-features`, { token: mgr.token, body: { feature: 'lift', present: true } })).features, ['lift']);
  assert.deepEqual(ok(await api('POST', `/venues/${v.id}/access-features`, { token: mgr.token, body: { feature: 'lift', present: false } })).features, []);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_venue_access_features WHERE venue_id=$1', [v.id])).rows[0].n, 1, 'retired, not deleted');
});

test('overview: directors get counts, small groups are withheld, a coach is refused', async () => {
  const a = await academy();
  ok(await share(a, a.adult, {}), 201);
  const o = ok(await api('GET', `/organisations/${a.org.id}/academy/inclusion`, { token: a.owner.token }));
  assert.equal(o.athletes_with_shares, null, 'one athlete is below the minimum group');
  assert.ok(!JSON.stringify(o).includes(a.adult.id));
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/inclusion`, { token: a.coach.token })).status, 403);
});

test('athlete strip is only for staff named by the athlete; others get 404', async () => {
  const a = await academy();
  ok(await share(a, a.adult, { audience_user_ids: [a.coach.id] }), 201);
  const ok1 = ok(await api('GET', `/organisations/${a.org.id}/academy/inclusion/athletes/${a.adult.id}`, { token: a.coach.token }));
  assert.equal(ok1.shared_with_you.length, 1);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/inclusion/athletes/${a.adult.id}`, { token: a.owner.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/inclusion/athletes/${a.adult.id}`, { token: a.other.token })).status, 404);
});

test('adapted assessment: descriptor levels only, no score; a second assessor signs off, never the author; a signed-off record is frozen', async () => {
  const a = await academy();
  const pw = (await pool.query("INSERT INTO academy_pathways(organisation_id, title, status, current_version, created_by) VALUES ($1,'Dev','active',1,$2) RETURNING id", [a.org.id, a.owner.id])).rows[0];
  const ver = (await pool.query("INSERT INTO academy_pathway_versions(pathway_id, version, levels, created_by) VALUES ($1,1,'[]',$2) RETURNING id", [pw.id, a.owner.id])).rows[0];
  const as = (await pool.query("INSERT INTO academy_assessments(organisation_id, athlete_id, pathway_id, version_id, level_key, period_from, period_to, assessor_id) VALUES ($1,$2,$3,$4,'l1',current_date-30,current_date,$5) RETURNING id", [a.org.id, a.adult.id, pw.id, ver.id, a.coach.id])).rows[0];
  const body = { pathway_variant: 'adapted', descriptors: [{ dimension_key: 'ball_control', label: 'Ball control while pushing', level: 'secure' }] };
  assert.equal((await api('POST', `/academy/assessments/${as.id}/adaptation`, { token: a.other.token, body })).status, 404, 'only the assessor or an admin');
  assert.equal((await api('POST', `/academy/assessments/${as.id}/adaptation`, { token: a.coach.token, body: { ...body, descriptors: [{ ...body.descriptors[0], level: 9 }] } })).status, 400, 'no numeric score');
  ok(await api('POST', `/academy/assessments/${as.id}/adaptation`, { token: a.coach.token, body }), 201);
  assert.equal((await api('POST', `/academy/assessments/${as.id}/adaptation/sign-off`, { token: a.coach.token })).status, 403, 'the author cannot sign off');
  ok(await api('POST', `/academy/assessments/${as.id}/adaptation/sign-off`, { token: a.owner.token }));
  assert.equal((await api('POST', `/academy/assessments/${as.id}/adaptation`, { token: a.coach.token, body })).status, 409);
});

test('non-regression: the migration added tables only and seeded nothing', async () => {
  for (const t of ['academy_programme_inclusion', 'academy_accommodation_shares', 'academy_inclusion_events']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE organisation_id IS NULL`)).rows[0].n, 0);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_venue_access_features')).rows[0].n, 1, 'only what the venue-manager test created');
});
