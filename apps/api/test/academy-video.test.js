import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { saveEncrypted } = await import('../src/doc-store.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = r.headers.get('content-type') ?? '';
  return { status: r.status, body: t.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `av_${n}`, display_name: `Video ${n}`, email: `av${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const adult = () => signup({ dob: yearsAgo(30) });
const q = async (t, p) => (await pool.query(t, p)).rows;
const MP4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(40, ++n % 250)]);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function academy() {
  const owner = await adult();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Video Academy ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `U14 ${n}`, capacity: 10, admission_mode: 'direct', public: true } }), 201);
  const pub = must(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'free', currency: 'GBP' } }), 201);
  return { owner, org, programme: pub.programme };
}
async function enrol(a, person) {
  const enq = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: person.token, body: {} }), 201);
  const done = must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: person.token, body: { row_version: enq.row_version, answers: {} } }));
  assert.equal(done.stage, 'enrolled');
}
const member = async (a, role) => { const u = await adult(); await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [a.org.id, u.id, role]); return u; };
const video = async (owner, { visibility = 'shared', title = 'Serve routine' } = {}) => {
  const bytes = MP4();
  const { id: vid, file } = await saveEncrypted('passport', 'passport_videos.file', bytes);
  return (await q("INSERT INTO passport_videos(id, user_id, title, file_name, content_type, size_bytes, sha256, status, source, visibility) VALUES ($1,$2,$3,$4,'video/mp4',$5,$7,'approved','upload',$6) RETURNING *", [vid, owner.id, title, file, bytes.length, visibility, `sha${vid}`]))[0];
};
async function setup() {
  const a = await academy();
  const coach = await member(a, 'coach');
  const other = await member(a, 'coach');
  const ath = await adult();
  await enrol(a, ath);
  const cohort = (await q('SELECT id FROM org_cohorts WHERE programme_id=$1', [a.programme.id]))[0].id;
  await q('UPDATE org_cohorts SET coach_id=$2 WHERE id=$1', [cohort, coach.id]);
  const s = (await q(`INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by)
    VALUES ($1,$2,$3,'Technical', now() - interval '1 hour', now() + interval '1 hour', 'published', $4) RETURNING *`, [a.org.id, cohort, a.programme.id, a.owner.id]))[0];
  return { a, coach, other, ath, cohort, s };
}
const plan = async (c) => (await q(`INSERT INTO academy_dev_plans(organisation_id, athlete_id, sport, season_label, starts_on, ends_on, lead_id, status, created_by) VALUES ($1,$2,'football','2026/27', current_date - 10, current_date + 200, $3, 'active', $3) RETURNING *`, [c.a.org.id, c.ath.id, c.coach.id]))[0];

test('capabilities are registered once for REST, OpenAPI and MCP', () => {
  for (const nme of ['list_academy_linkable_clips', 'link_academy_clip', 'list_academy_clips', 'get_academy_clip', 'update_academy_clip', 'add_academy_clip_annotation', 'remove_academy_clip_annotation', 'revoke_academy_clip', 'respond_academy_clip_review', 'list_my_academy_clips'])
    assert.equal(capabilities.filter((c) => c.name === nme).length, 1, nme);
});

test('coach links a governed clip to a shared development action; athlete reviews it; play is gated live', async () => {
  const c = await setup();
  const p = await plan(c);
  const v = await video(c.ath);
  const lc = must(await api('GET', `/academy/sessions/${c.s.id}/linkable-clips`, { token: c.coach.token }));
  assert.equal(lc.length, 1);
  // not shared / not enrolled / not coaching staff are all refused
  const priv = await video(c.ath, { visibility: 'private' });
  assert.equal((await api('POST', `/academy/sessions/${c.s.id}/clips`, { token: c.coach.token, body: { video_id: priv.id } })).status, 409);
  const outsider = await adult(); const ov = await video(outsider);
  assert.equal((await api('POST', `/academy/sessions/${c.s.id}/clips`, { token: c.coach.token, body: { video_id: ov.id } })).status, 400);
  assert.equal((await api('POST', `/academy/sessions/${c.s.id}/clips`, { token: c.ath.token, body: { video_id: v.id } })).status, 404);
  const l = must(await api('POST', `/academy/sessions/${c.s.id}/clips`, { token: c.coach.token, body: { video_id: v.id, coach_note: 'Toss drifts right', new_action: { title: 'Serve toss block', due_on: '2030-01-01' }, assessment_ref: 'Mar skills test' } }), 201);
  assert.equal(l.access.ok, true);
  assert.equal(l.action.title, 'Serve toss block');
  const act = (await q("SELECT * FROM academy_dev_interventions WHERE id=$1", [l.action.id]))[0];
  assert.equal(act.kind, 'video_review'); assert.equal(act.plan_id, p.id); assert.equal(act.visibility, 'athlete');
  assert.equal((await api('POST', `/academy/sessions/${c.s.id}/clips`, { token: c.coach.token, body: { video_id: v.id } })).status, 409, 'once per session');
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='academy_clip'", [c.ath.id])).length);
  // annotation + athlete queue + response
  must(await api('POST', `/academy/clip-links/${l.id}/annotations`, { token: c.coach.token, body: { at_ms: 21000, kind: 'fix', note: 'Keep the tossing arm up' } }), 201);
  assert.equal((await api('POST', `/academy/clip-links/${l.id}/annotations`, { token: c.other.token, body: { at_ms: 1, note: 'nope' } })).status, 404, 'a coach with no relation cannot see it');
  const q1 = must(await api('GET', '/me/academy/clips', { token: c.ath.token }));
  assert.equal(q1.totals.to_review, 1);
  const got = must(await api('GET', `/academy/clip-links/${l.id}`, { token: c.ath.token }));
  assert.equal(got.annotations[0].note, 'Keep the tossing arm up');
  assert.ok(got.first_viewed_at === null || got.access.ok);
  const file = await api('GET', `/academy/clip-links/${l.id}/file`, { token: c.ath.token });
  assert.equal(file.status, 200);
  assert.equal((await api('GET', `/academy/clip-links/${l.id}/file`, { token: (await adult()).token })).status, 404);
  must(await api('POST', `/academy/clip-links/${l.id}/review`, { token: c.ath.token, body: { state: 'need_help', note: 'Not sure about the toss' } }));
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='academy_clip_reply'", [c.coach.id])).length);
  const list = must(await api('GET', `/organisations/${c.a.org.id}/academy/clips`, { token: c.coach.token, query: { session_id: c.s.id } }));
  assert.equal(list.totals.needs_reply, 1); assert.equal(list.totals.open_actions, 1);
  assert.equal(list.items[0].coach_note, 'Toss drifts right');
  // stored text is encrypted; audit written
  assert.ok(!JSON.stringify(await q('SELECT coach_note_enc FROM academy_clip_links WHERE id=$1', [l.id])).includes('Toss drifts'));
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='view_academy_clip'", [c.ath.id])).length);
  // revoke by the athlete stops it; nothing deleted
  must(await api('POST', `/academy/clip-links/${l.id}/revoke`, { token: c.ath.token, body: { reason: 'Changed my mind' } }));
  assert.equal((await api('GET', `/academy/clip-links/${l.id}/file`, { token: c.coach.token })).status, 404);
  const after = must(await api('GET', `/academy/clip-links/${l.id}`, { token: c.coach.token }));
  assert.equal(after.access.reason, 'revoked'); assert.equal(after.action.title, 'Serve toss block');
  assert.equal((await q('SELECT count(*)::int AS n FROM academy_clip_annotations'))[0].n, 1);
  assert.equal((await api('POST', `/academy/clip-links/${l.id}/annotations`, { token: c.coach.token, body: { at_ms: 5, note: 'late note' } })).status, 409);
});

test('revoking guardian media consent immediately stops academy viewing; expiry and unsharing too', async () => {
  const c = await setup();
  const kid = await adult(); await enrol(c.a, kid);
  const parent = await adult();
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const v = await video(kid);
  assert.equal((await api('GET', `/academy/sessions/${c.s.id}/linkable-clips`, { token: c.coach.token })).body.length, 0, 'no consent: not even offered');
  const no = await api('POST', `/academy/sessions/${c.s.id}/clips`, { token: c.coach.token, body: { video_id: v.id } });
  assert.equal(no.status, 409); assert.equal(no.body.error.details?.code ?? no.body.error.code, 'guardian_consent_required');
  await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'media',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  const l = must(await api('POST', `/academy/sessions/${c.s.id}/clips`, { token: c.coach.token, body: { video_id: v.id } }), 201);
  assert.equal((await api('GET', `/academy/clip-links/${l.id}/file`, { token: parent.token })).status, 200, 'guardian can watch');
  assert.equal(must(await api('GET', '/me/academy/clips', { token: parent.token, query: { athlete_id: kid.id } })).items.length, 1);
  assert.equal((await api('GET', '/me/academy/clips', { token: parent.token })).body.items.length, 0);
  await q("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1", [kid.id]);
  assert.equal((await api('GET', `/academy/clip-links/${l.id}/file`, { token: c.coach.token })).status, 404);
  assert.equal((await api('GET', `/academy/clip-links/${l.id}/file`, { token: kid.token })).status, 404);
  const g = must(await api('GET', `/academy/clip-links/${l.id}`, { token: kid.token }));
  assert.equal(g.access.reason, 'consent_withdrawn'); assert.equal(g.video.play_url, undefined); assert.equal(g.video.title, null);
  assert.equal((await api('POST', `/academy/clip-links/${l.id}/review`, { token: kid.token, body: { state: 'understood' } })).status, 409);
  // consent back: viewing resumes (link and notes were kept)
  await q("UPDATE youth_consents SET revoked_at=NULL WHERE child_id=$1", [kid.id]);
  assert.equal((await api('GET', `/academy/clip-links/${l.id}/file`, { token: kid.token })).status, 200);
  // expiry
  await q("UPDATE academy_clip_links SET expires_at=now() - interval '1 minute' WHERE id=$1", [l.id]);
  assert.equal(must(await api('GET', `/academy/clip-links/${l.id}`, { token: c.coach.token })).access.reason, 'expired');
  must(await api('PATCH', `/academy/clip-links/${l.id}`, { token: c.coach.token, body: { row_version: 1, expires_in_days: 7 } }));
  assert.equal((await api('GET', `/academy/clip-links/${l.id}/file`, { token: kid.token })).status, 200);
  // the athlete unshares in the library: academy viewing stops
  await q("UPDATE passport_videos SET visibility='private' WHERE id=$1", [v.id]);
  assert.equal(must(await api('GET', `/academy/clip-links/${l.id}`, { token: c.coach.token })).access.reason, 'unshared');
});

test('scoping: coaches see only their groups, athlete-hidden links stay staff-only, no existence leaks', async () => {
  const c = await setup();
  const v = await video(c.ath);
  const l = must(await api('POST', `/academy/sessions/${c.s.id}/clips`, { token: c.coach.token, body: { video_id: v.id, athlete_visible: false } }), 201);
  assert.equal((await api('GET', `/academy/clip-links/${l.id}`, { token: c.ath.token })).status, 404);
  assert.equal(must(await api('GET', '/me/academy/clips', { token: c.ath.token })).items.length, 0);
  assert.equal(must(await api('GET', `/organisations/${c.a.org.id}/academy/clips`, { token: c.other.token })).items.length, 0, 'unrelated coach sees none');
  assert.equal(must(await api('GET', `/organisations/${c.a.org.id}/academy/clips`, { token: c.a.owner.token })).items.length, 1);
  assert.equal((await api('GET', `/organisations/${c.a.org.id}/academy/clips`, { token: (await adult()).token })).status, 404);
  assert.equal((await api('PATCH', `/academy/clip-links/${l.id}`, { token: c.coach.token, body: { row_version: 9, coach_note: 'x1' } })).status, 409, 'stale version');
  must(await api('PATCH', `/academy/clip-links/${l.id}`, { token: c.coach.token, body: { row_version: 1, athlete_visible: true } }));
  assert.equal(must(await api('GET', '/me/academy/clips', { token: c.ath.token })).items.length, 1);
});
