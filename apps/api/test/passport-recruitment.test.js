import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const call = async (method, path, { token, body, raw } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await call('POST', '/auth/register', { body: { handle: `pr_${n}`, display_name: `Pr ${n}`, email: `pr${n}@example.com`, phone: '+911234567890', full_name: `Secret Name ${n}`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => call('POST', p, { token: t, body });
const get = (t, p) => call('GET', p, { token: t });
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
// a tiny but real MP4 header ('ftyp') and PDF so the byte sniffing accepts them
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(40, 1)]);
const PDF = Buffer.from('%PDF-1.4\nacademic transcript SECRET-GRADES\n%%EOF');

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const coachedAthlete = async () => {
  const coach = await signup(['coach']), a = await signup();
  const team = ok(await post(coach.token, '/teams', { name: `Rec FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, a.id]);
  return { coach, a };
};

test('video and coach references reach a recipient only after the right person approved them; revoke, expiry and removal are live', async () => {
  const { coach, a } = await coachedAthlete();
  const stranger = await signup(['coach']);

  const link = ok(await post(a.token, '/me/passport-videos', { title: 'Match highlights', link_url: 'https://video.example.com/h1', sport_slug: 'football' }), 201);
  assert.equal((await post(a.token, '/me/passport-videos', { title: 'x', link_url: 'http://insecure.example.com/v' })).status, 400, 'https only');
  assert.equal((await post(a.token, '/me/passport-videos', { title: 'Match highlights', link_url: 'https://video.example.com/h1' })).status, 409, 'the same link twice is one video');
  const up = ok(await call('PUT', '/me/passport-videos/upload?title=Clip&sport_slug=football', { token: a.token, raw: MP4 }), 201);
  assert.equal((await call('PUT', '/me/passport-videos/upload?title=Bad', { token: a.token, raw: PDF })).status, 400, 'bytes decide the type, a PDF is not a video');

  const ref = ok(await post(coach.token, `/athletes/${a.id}/passport-references`, { body: 'Hard working striker with great attitude and leadership qualities.', sport_slug: 'football' }), 201);
  assert.equal((await post(stranger.token, `/athletes/${a.id}/passport-references`, { body: 'Never coached this athlete at all, honestly.' })).status, 403);

  const mk = (extra = {}) => post(a.token, '/me/passport-links', { show_video: true, show_references: true, ...extra }).then((r) => ok(r, 201));
  const l1 = await mk();
  const open = async (l, t) => ok(await get(t, `/passport/${encodeURIComponent(l.token)}`));
  let p = await open(l1);
  assert.deepEqual(p.videos, [], 'a pending video is never shown'); assert.deepEqual(p.references, [], 'a reference the athlete has not approved is never shown');

  // only a coach of the athlete may approve; versions guard double decisions
  assert.equal((await post(stranger.token, `/passport-videos/${link.id}/review`, { version: 1, decision: 'approved' })).status, 404);
  const queue = ok(await get(coach.token, '/coach/passport-videos'));
  assert.equal(queue.length, 2);
  ok(await post(coach.token, `/passport-videos/${link.id}/review`, { version: 1, decision: 'approved' }));
  assert.equal((await post(coach.token, `/passport-videos/${link.id}/review`, { version: 1, decision: 'rejected' })).status, 409, 'stale decision refused');
  ok(await post(coach.token, `/passport-videos/${up.id}/review`, { version: 1, decision: 'approved' }));
  ok(await post(a.token, `/me/passport-references/${ref.id}/decision`, { version: 1, decision: 'approved' }));
  assert.equal((await post(a.token, `/me/passport-references/${ref.id}/decision`, { version: 1, decision: 'declined' })).status, 409);

  p = await open(l1);
  assert.equal(p.videos.length, 2); assert.equal(p.references.length, 1); assert.equal(p.references[0].coach_name, coach.display_name);
  assert.equal(p.preferences, null, 'sections that are off are null');
  assert.ok(!JSON.stringify(p).includes('Secret Name') && !JSON.stringify(p).includes('pr1@example.com'));

  // the uploaded clip streams through the link; the link gate applies to files too
  const vf = p.videos.find((v) => v.has_file);
  const file = await call('GET', vf.file_url.replace('/api/v1', ''));
  assert.equal(file.status, 200); assert.ok(file.body.equals(MP4));

  // a link without the video section shows nothing and serves no file
  const l2 = await mk({ show_video: false });
  assert.equal((await open(l2)).videos, null);
  assert.equal((await call('GET', `/passport/${encodeURIComponent(l2.token)}/video/${up.id}`)).status, 404);

  // live: update (version-checked), revoke, expiry, removal
  const upd = ok(await call('PATCH', `/me/passport-links/${l1.id}`, { token: a.token, body: { version: 1, show_video: false } }));
  assert.equal(upd.version, 2);
  assert.equal((await call('PATCH', `/me/passport-links/${l1.id}`, { token: a.token, body: { version: 1, show_video: true } })).status, 409, 'stale link version');
  assert.equal((await open(l1)).videos, null, 'turning a section off applies to the same link at once');
  assert.equal((await call('GET', vf.file_url.replace('/api/v1', ''))).status, 404);
  ok(await call('PATCH', `/me/passport-links/${l1.id}`, { token: a.token, body: { version: 2, show_video: true } }));
  ok(await call('DELETE', `/me/passport-videos/${link.id}`, { token: a.token }));
  assert.equal((await open(l1)).videos.length, 1, 'a removed video leaves every link');
  ok(await call('DELETE', `/passport-references/${ref.id}`, { token: coach.token }));
  assert.equal((await open(l1)).references.length, 0, 'the coach can withdraw a reference');
  ok(await post(a.token, `/me/passport-links/${l1.id}/revoke`));
  assert.equal((await get(null, `/passport/${encodeURIComponent(l1.token)}`)).status, 404);
  assert.equal((await call('GET', `/passport/${encodeURIComponent(l1.token)}/export`)).status, 404);
  await pool.query("UPDATE passport_links SET expires_at=now()-interval '1 minute' WHERE id=$1", [l2.id]);
  assert.equal((await call('GET', `/passport/${encodeURIComponent(l2.token)}`)).status, 404);
  assert.equal((await call('PATCH', `/me/passport-links/${l2.id}`, { token: a.token, body: { version: 1, label: 'x' } })).status, 409, 'an expired link cannot be edited back to life');
  // nothing was deleted
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM passport_videos WHERE user_id=$1', [a.id])).rows[0].n, 3 - 1);
});

test('a link addressed to one person opens only for that signed-in person', async () => {
  const a = await signup(), scout = await signup(['coach']), other = await signup(['coach']);
  assert.equal((await post(a.token, '/me/passport-links', { recipient_id: a.id })).status, 409, 'not the athlete themselves');
  const l = ok(await post(a.token, '/me/passport-links', { recipient_id: scout.id, label: 'For scout' }), 201);
  const url = `/passport/${encodeURIComponent(l.token)}`;
  assert.equal((await call('GET', url)).status, 404, 'anonymous holder of the link');
  assert.equal((await get(other.token, url)).status, 404, 'a different signed-in person');
  const p = ok(await get(scout.token, url));
  assert.equal(p.addressed_to_you, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM passport_link_views WHERE link_id=$1 AND viewer_id=$2", [l.id, scout.id])).rows[0].n, 1, 'the recipient\'s open is recorded');
  assert.equal(ok(await get(scout.token, `${url}/export`)).format, 'sportarena.passport.v1');
});

test('preferences, availability and academic evidence: validated, versioned, deduplicated, encrypted and audited', async () => {
  const a = await signup(), scout = await signup(['coach']);
  // preferences
  assert.equal(ok(await get(a.token, '/me/recruitment-preferences')).version, 0);
  const pref = { version: 0, sport_slugs: ['football'], levels: ['semi_pro'], regions: ['Mumbai'], open_to: ['scholarship', 'trial'], open_to_contact: true, notes: 'Open to relocate' };
  assert.equal(ok(await post(a.token, '/me/recruitment-preferences', pref)).version, 1);
  assert.equal((await post(a.token, '/me/recruitment-preferences', pref)).status, 409, 'a retry with the old version cannot overwrite');
  assert.equal((await post(a.token, '/me/recruitment-preferences', { ...pref, version: 1, open_to: ['bogus'] })).status, 400);
  assert.equal(ok(await post(a.token, '/me/recruitment-preferences', { ...pref, version: 1, notes: 'Changed' })).version, 2);
  // availability
  const w = { kind: 'trial', from_date: day(5), to_date: day(10), weekdays: [6, 0], from_time: '09:00', to_time: '12:00' };
  assert.equal((await post(a.token, '/me/recruitment-availability', { ...w, to_date: day(1) })).status, 400, 'end before start');
  assert.equal((await post(a.token, '/me/recruitment-availability', { ...w, to_time: '08:00' })).status, 400);
  const win = ok(await post(a.token, '/me/recruitment-availability', w), 201);
  assert.equal((await post(a.token, '/me/recruitment-availability', w)).status, 409, 'duplicate');
  await pool.query("INSERT INTO recruitment_availability(user_id, kind, from_date, to_date) VALUES ($1,'visit', current_date-10, current_date-5)", [a.id]);
  assert.equal(ok(await get(a.token, '/me/recruitment-availability')).length, 1, 'past windows are not listed');
  // academic evidence
  const ev = ok(await post(a.token, '/me/academic-evidence', { kind: 'transcript', institution: 'City High School', period_from: '2024-06-01', summary: 'Top 5% in maths' }), 201);
  assert.equal(ev.provenance, 'self_reported');
  assert.equal((await post(a.token, '/me/academic-evidence', { kind: 'transcript', institution: 'City High School', period_from: '2024-06-01' })).status, 409);
  const stored = (await pool.query('SELECT summary_enc FROM academic_evidence WHERE id=$1', [ev.id])).rows[0].summary_enc;
  assert.ok(stored && !stored.includes('maths'), 'the summary is encrypted at rest');
  assert.equal((await call('PUT', `/me/academic-evidence/${ev.id}/file`, { token: a.token, raw: Buffer.from('not a document') })).status, 400);
  ok(await call('PUT', `/me/academic-evidence/${ev.id}/file`, { token: a.token, raw: PDF }));
  const stranger = await call('PUT', `/me/academic-evidence/${ev.id}/file`, { token: scout.token, raw: PDF });
  assert.equal(stranger.status, 404);

  const l = ok(await post(a.token, '/me/passport-links', { show_preferences: true, show_availability: true, show_academic: true, show_matches: false }), 201);
  const view = ok(await call('GET', `/passport/${encodeURIComponent(l.token)}`));
  assert.deepEqual(view.preferences.open_to, ['scholarship', 'trial']); assert.equal(view.availability.length, 1); assert.equal(view.availability[0].from_time, '09:00');
  assert.equal(view.academic[0].summary, 'Top 5% in maths'); assert.equal(view.academic[0].provenance, 'self_reported');
  const f = await call('GET', view.academic[0].file_url.replace('/api/v1', ''));
  assert.equal(f.status, 200); assert.ok(f.body.equals(PDF));
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('read_passport_academic') AND entity_id=$1", [ev.id])).rows[0].n >= 2, 'reads of academic evidence by others are audit-logged');
  // owner preview does not audit self-reads
  const before2 = (await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_passport_academic'")).rows[0].n;
  ok(await get(a.token, '/me/passport'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_passport_academic'")).rows[0].n, before2);
  // hidden at once on removal
  ok(await call('DELETE', `/me/academic-evidence/${ev.id}`, { token: a.token }));
  assert.deepEqual(ok(await call('GET', `/passport/${encodeURIComponent(l.token)}`)).academic, []);
  ok(await call('DELETE', `/me/recruitment-availability/${win.id}`, { token: a.token }));
  assert.equal(ok(await get(a.token, '/me/recruitment-availability')).length, 0);
});

test('a young athlete\'s passport is arranged by a verified guardian and stops the moment consent is withdrawn', async () => {
  const kid = await signup(), parent = await signup(), stranger = await signup(), scout = await signup(['coach']);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  assert.equal((await post(kid.token, '/me/passport-links', {})).status, 403, 'a young person cannot arrange sharing alone');
  assert.equal((await post(stranger.token, '/me/passport-links', { athlete_id: kid.id })).status, 403, 'not a guardian');
  assert.equal((await post(parent.token, '/me/passport-links', { athlete_id: kid.id })).status, 409, 'needs recruitment_sharing consent first');
  ok(await post(parent.token, `/youth/children/${kid.id}/consents`, { child_id: kid.id, purpose: 'recruitment_sharing' }), 201);
  const l = ok(await post(parent.token, '/me/passport-links', { athlete_id: kid.id, recipient_id: scout.id, show_preferences: true }), 201);
  assert.equal((await pool.query('SELECT created_by, user_id FROM passport_links WHERE id=$1', [l.id])).rows[0].created_by, parent.id);
  const url = `/passport/${encodeURIComponent(l.token)}`;
  ok(await get(scout.token, url));
  assert.equal(ok(await get(parent.token, `/me/passport-links?athlete_id=${kid.id}`)).length, 1);
  assert.equal((await get(stranger.token, `/me/passport-links?athlete_id=${kid.id}`)).status, 403);
  // withdraw consent: the same link stops, with no change to the link itself
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='recruitment_sharing'", [kid.id]);
  assert.equal((await get(scout.token, url)).status, 404);
  assert.equal((await get(scout.token, `${url}/export`)).status, 404);
  // a guardian can still turn the link off
  ok(await post(parent.token, `/me/passport-links/${l.id}/revoke`));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM passport_links WHERE user_id=$1', [kid.id])).rows[0].n, 1, 'the record is kept');
});
