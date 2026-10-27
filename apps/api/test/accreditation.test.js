import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { parseToken, tokenFor } = await import('../src/accreditation.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ac_${n}_${roles[0]}`, display_name: `Acc ${n}`, email: `ac${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ac_root','ac_root','{admin}','x','x','ac_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const newEvent = async (org, extra = {}) => must(await api('POST', '/events', { token: org.token, body: { name: `Accred Cup ${++n}`, sport: 'football', starts_on: day(-1), ends_on: day(2), ...extra } }), 201);
const zone = async (org, ev, name, kind = 'custom') => must(await api('POST', `/events/${ev.id}/accreditation/zones`, { token: org.token, body: { name, kind } }), 201);
const category = async (org, ev, body) => must(await api('POST', `/events/${ev.id}/accreditation/categories`, { token: org.token, body }), 201);
const soloEntry = async (org, ev, u) => { const e = must(await api('POST', `/events/${ev.id}/entries`, { token: u.token }), 201); must(await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } })); return e; };
const team = async (owner) => must(await api('POST', '/teams', { token: owner.token, body: { name: `Squad ${++n}`, sport: 'football' } }), 201);
const teamEntry = async (org, ev, mgr, tm) => { const e = must(await api('POST', `/events/${ev.id}/entries`, { token: mgr.token, body: { team_id: tm.id } }), 201); must(await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } })); return e; };
const staff = async (org, ev, u, role) => {
  const r = must(await api('POST', `/events/${ev.id}/staff-roles`, { token: org.token, body: { role } }), 201);
  const a = must(await api('POST', `/staff-roles/${r.id}/invite`, { token: org.token, body: { user_id: u.id } }), 201);
  must(await api('POST', `/staff-assignments/${a.id}/respond`, { token: u.token, body: { accept: true } }));
};
const scan = (op, ev, token, extra = {}) => api('POST', `/events/${ev.id}/accreditation/scan`, { token: op.token, body: { token, ...extra } });
const myBadge = async (u, accId) => (must(await api('GET', '/me/accreditations', { token: u.token })).find((a) => a.id === accId));

test('the scheme is the organiser\'s alone; names are unique and zones must belong to the event', async () => {
  const org = await signup(['organizer']), other = await signup(['organizer']);
  const ev = await newEvent(org), ev2 = await newEvent(other);
  assert.equal((await api('POST', `/events/${ev.id}/accreditation/zones`, { token: other.token, body: { name: 'Pitch', kind: 'field_of_play' } })).status, 403);
  const z = await zone(org, ev, 'Field of play', 'field_of_play');
  assert.equal((await api('POST', `/events/${ev.id}/accreditation/zones`, { token: org.token, body: { name: 'field of play' } })).status, 409, 'case-insensitive unique');
  const foreign = await zone(other, ev2, 'Hospitality', 'hospitality');
  assert.equal((await api('POST', `/events/${ev.id}/accreditation/categories`, { token: org.token, body: { name: 'Bad', eligible: ['athlete'], zone_ids: [foreign.id] } })).status, 400, 'zone of another event');
  assert.equal((await api('POST', `/events/${ev.id}/accreditation/categories`, { token: org.token, body: { name: 'Bad', eligible: ['athlete'], daily_from: '08:00' } })).status, 400, 'half a daily window');
  assert.equal((await api('POST', `/events/${ev.id}/accreditation/categories`, { token: org.token, body: { name: 'Bad', eligible: ['athlete'], timezone: 'Mars/Base' } })).status, 400);
  const cat = await category(org, ev, { name: 'Athlete', eligible: ['athlete'], zone_ids: [z.id], self_apply: true });
  assert.deepEqual(cat.zone_ids, [z.id]);
  assert.equal((await api('POST', `/events/${ev.id}/accreditation/categories`, { token: org.token, body: { name: 'ATHLETE', eligible: ['athlete'] } })).status, 409);
  const upd = must(await api('PATCH', `/accreditation/categories/${cat.id}`, { token: org.token, body: { zone_ids: [], escort_required: true } }));
  assert.deepEqual(upd.zone_ids, []);
  assert.equal(upd.escort_required, true);
  assert.equal((await api('PATCH', `/accreditation/categories/${cat.id}`, { token: other.token, body: { name: 'Hijack' } })).status, 403);
  const kept = await pool.query('SELECT removed_at FROM accreditation_category_zones WHERE category_id=$1', [cat.id]);
  assert.equal(kept.rowCount, 1, 'a removed zone is kept, not deleted');
  assert.ok(kept.rows[0].removed_at);
});

test('apply, approve, scan: the QR holds no personal data and role + zone are enforced by the server', async () => {
  const org = await signup(['organizer']), athlete = await signup(['athlete']), stranger = await signup(['athlete']), guard = await signup(['coach']);
  const ev = await newEvent(org), other = await newEvent(org);
  const field = await zone(org, ev, 'Field of play', 'field_of_play'), media = await zone(org, ev, 'Media centre', 'media_centre');
  const cat = await category(org, ev, { name: 'Athlete', eligible: ['athlete'], zone_ids: [field.id], self_apply: true, requires_photo: true });
  const closed = await category(org, ev, { name: 'VIP', eligible: ['guest'], zone_ids: [media.id] });
  assert.equal((await api('POST', `/accreditation/categories/${cat.id}/apply`, { token: stranger.token })).status, 409, 'no athlete role at this event');
  assert.equal((await api('POST', `/accreditation/categories/${closed.id}/apply`, { token: athlete.token })).status, 403, 'organiser-invited category');
  await soloEntry(org, ev, athlete);
  const app = must(await api('POST', `/accreditation/categories/${cat.id}/apply`, { token: athlete.token }), 201);
  assert.equal(app.status, 'submitted');
  assert.equal(must(await api('POST', `/accreditation/categories/${cat.id}/apply`, { token: athlete.token }), 201).id, app.id, 'applying twice is the same application');
  assert.equal((await scan(org, ev, 'GA1.nonsense')).body.result, 'invalid');
  assert.equal((await api('POST', `/accreditations/${app.id}/decision`, { token: athlete.token, body: { decision: 'approve' } })).status, 403, 'nobody approves themselves');
  const ok = must(await api('POST', `/accreditations/${app.id}/decision`, { token: org.token, body: { decision: 'approve' } }));
  assert.equal(ok.status, 'approved');
  assert.equal(must(await api('POST', `/accreditations/${app.id}/decision`, { token: org.token, body: { decision: 'approve' } })).credential_version, 1, 'repeat approval does not reissue');
  const mine = await myBadge(athlete, app.id);
  assert.match(mine.credential.token, /^GA1\.ACR-[A-Z0-9]{10}\.1\.[0-9a-f]{20}$/);
  for (const secret of [athlete.id, athlete.handle, athlete.display_name, ev.id]) assert.ok(!mine.credential.token.includes(secret), 'the QR carries nothing personal');
  assert.deepEqual(mine.zones.map((z) => z.name), ['Field of play']);
  const T = mine.credential.token;

  // only gate staff scan
  assert.equal((await scan(athlete, ev, T)).status, 403);
  assert.equal((await scan(guard, ev, T)).status, 403);
  await staff(org, ev, guard, 'security');
  const hit = must(await scan(guard, ev, T, { zone_id: field.id, idempotency_key: 'gate-1-scan-1' }));
  assert.equal(hit.result, 'valid');
  assert.equal(hit.holder.display_name, athlete.display_name);
  assert.equal(hit.category.name, 'Athlete');
  assert.ok(!('email' in hit.holder) && !('id' in hit.holder), 'minimum operational identity');
  const replay = must(await scan(guard, ev, T, { zone_id: field.id, idempotency_key: 'gate-1-scan-1' }));
  assert.equal(replay.replayed, true);
  assert.equal((await pool.query('SELECT 1 FROM accreditation_scans WHERE operator_id=$1', [guard.id])).rowCount, 1, 'a replay is not recorded twice');
  assert.equal(must(await scan(guard, ev, T)).result, 'valid', 'event gate without a zone');
  assert.equal(must(await scan(guard, ev, T, { zone_id: media.id })).result, 'wrong_zone');
  assert.equal(must(await scan(org, other, T)).result, 'wrong_event', 'a badge of another event');
  assert.equal(must(await scan(org, ev, T.replace(/.$/, (ch) => (ch === '0' ? '1' : '0')))).result, 'invalid', 'a forged mac');
  assert.equal(parseToken(tokenFor('ACR-AAAAAAAAAA', 1))?.version, 1);
  assert.equal(must(await scan(org, ev, T, { zone_id: media.id, direction: 'out' })).result, 'wrong_zone');

  // the guard cannot see the scan log, the organiser can; the log names the operator and zone
  assert.equal((await api('GET', `/events/${ev.id}/accreditation/scans`, { token: guard.token })).status, 403);
  const log = must(await api('GET', `/events/${ev.id}/accreditation/scans`, { token: org.token, query: { result: 'wrong_zone' } }));
  assert.ok(log.length >= 1 && log[0].zone === 'Media centre' && log[0].operator);
});

test('revoke, suspend, restore and reissue take effect on the next scan; a stale reissue changes nothing', async () => {
  const org = await signup(['organizer']), a = await signup(['athlete']);
  const ev = await newEvent(org);
  const cat = await category(org, ev, { name: 'Athlete', eligible: ['athlete'], approval: 'auto', self_apply: true });
  await soloEntry(org, ev, a);
  const acc = must(await api('POST', `/accreditation/categories/${cat.id}/apply`, { token: a.token }), 201);
  assert.equal(acc.status, 'approved', 'auto approval');
  const t1 = (await myBadge(a, acc.id)).credential.token;
  assert.equal(must(await scan(org, ev, t1)).result, 'valid');

  assert.equal((await api('POST', `/accreditations/${acc.id}/access`, { token: a.token, body: { action: 'suspend', reason: 'x1' } })).status, 403, 'holders cannot lift or change their own standing');
  assert.equal((await api('POST', `/accreditations/${acc.id}/access`, { token: org.token, body: { action: 'suspend' } })).status, 400, 'a reason is required');
  must(await api('POST', `/accreditations/${acc.id}/access`, { token: org.token, body: { action: 'suspend', reason: 'Under review' } }));
  assert.equal(must(await scan(org, ev, t1)).result, 'suspended');
  must(await api('POST', `/accreditations/${acc.id}/access`, { token: org.token, body: { action: 'restore' } }));
  assert.equal(must(await scan(org, ev, t1)).result, 'valid');

  // lost badge: the holder replaces it; the old code dies at once, a retry does not issue twice
  const re = must(await api('POST', `/accreditations/${acc.id}/reissue`, { token: a.token, body: { credential_version: 1, reason: 'lost' } }));
  assert.equal(re.credential_version, 2);
  const again = must(await api('POST', `/accreditations/${acc.id}/reissue`, { token: a.token, body: { credential_version: 1, reason: 'lost' } }));
  assert.equal(again.credential_version, 2, 'stale retry is a no-op');
  assert.equal(must(await scan(org, ev, t1)).result, 'replaced');
  const t2 = (await myBadge(a, acc.id)).credential.token;
  assert.notEqual(t1, t2);
  assert.equal(must(await scan(org, ev, t2)).result, 'valid');
  assert.equal((await api('POST', `/accreditations/${acc.id}/reissue`, { token: a.token, body: { credential_version: 2, reason: 'details_changed' } })).status, 403, 'only lost, stolen or damaged by the holder');

  const feed = must(await api('GET', `/events/${ev.id}/accreditation/revocations`, { token: org.token }));
  assert.equal(feed.credentials.find((c) => c.serial === parseToken(t2).serial).credential_version, 2);

  must(await api('POST', `/accreditations/${acc.id}/access`, { token: org.token, body: { action: 'revoke', reason: 'Conduct' } }));
  must(await api('POST', `/accreditations/${acc.id}/access`, { token: org.token, body: { action: 'revoke', reason: 'Conduct' } }));
  assert.equal(must(await scan(org, ev, t2)).result, 'revoked');
  assert.equal(must(await scan(org, ev, t1)).result, 'replaced');
  assert.equal((await api('POST', `/accreditations/${acc.id}/reissue`, { token: org.token, body: { credential_version: 2, reason: 'lost' } })).status, 409, 'no new code for a revoked badge');
  const detail = must(await api('GET', `/accreditations/${acc.id}`, { token: org.token }));
  assert.deepEqual(detail.history.map((h) => h.kind), ['submitted', 'approved', 'issued', 'suspended', 'restored', 'reissued', 'revoked']);
  await assert.rejects(pool.query('UPDATE accreditation_history SET kind=$1', ['x']), /append-only/);
  await assert.rejects(pool.query('DELETE FROM accreditation_scans'), /append-only/);
});

test('windows: expired, not yet valid and daily hours fail deterministically; the role behind a badge is checked live', async () => {
  const org = await signup(['organizer']), a = await signup(['athlete']), b = await signup(['athlete']), c = await signup(['athlete']);
  const ev = await newEvent(org);
  for (const u of [a, b, c]) await soloEntry(org, ev, u);
  const mk = async (name, extra) => category(org, ev, { name, eligible: ['athlete'], approval: 'auto', self_apply: true, ...extra });
  const old = await mk('Past', { valid_from: new Date(Date.now() - 5 * 86400000).toISOString(), valid_to: new Date(Date.now() - 86400000).toISOString() });
  const future = await mk('Future', { valid_from: new Date(Date.now() + 86400000).toISOString(), valid_to: new Date(Date.now() + 2 * 86400000).toISOString() });
  const nowHour = new Date().getUTCHours();
  const night = await mk('Night', { daily_from: `${String((nowHour + 3) % 24).padStart(2, '0')}:00`, daily_to: `${String((nowHour + 4) % 24).padStart(2, '0')}:00` });
  const usual = await mk('Event days', {});
  const tok = async (u, cat) => { const r = must(await api('POST', `/accreditation/categories/${cat.id}/apply`, { token: u.token }), 201); return { id: r.id, token: (await myBadge(u, r.id)).credential.token }; };
  assert.equal(must(await scan(org, ev, (await tok(a, old)).token)).result, 'expired');
  assert.equal(must(await scan(org, ev, (await tok(a, future)).token)).result, 'not_yet_valid');
  assert.equal(must(await scan(org, ev, (await tok(a, night)).token)).result, 'outside_hours');
  const ok = await tok(b, usual);
  assert.equal(must(await scan(org, ev, ok.token)).result, 'valid', 'defaults to the event days');
  assert.equal((await myBadge(b, ok.id)).effective_status, 'approved');
  assert.equal((await myBadge(a, (await tok(a, old)).id)).effective_status, 'expired');

  // the entry is withdrawn: the badge no longer stands
  const entry = (await pool.query("SELECT id FROM event_entries WHERE event_id=$1 AND user_id=$2", [ev.id, b.id])).rows[0];
  must(await api('POST', `/entries/${entry.id}/withdraw`, { token: b.token }));
  assert.equal(must(await scan(org, ev, ok.token)).result, 'not_eligible');
});

test('nominations respect real authority: team managers, department leads and the organiser; drafts, bulk results and guests', async () => {
  const org = await signup(['organizer']), mgr = await signup(['coach']), mgr2 = await signup(['coach']), lead = await signup(['coach']);
  const p1 = await signup(['athlete']), p2 = await signup(['athlete']), out = await signup(['athlete']), vip = await signup(['sponsor']);
  const ev = await newEvent(org);
  const tm = await team(mgr), tm2 = await team(mgr2);
  for (const p of [p1, p2]) must(await api('POST', `/teams/${tm.id}/members`, { token: mgr.token, body: { user_id: p.id } }), 201);
  await teamEntry(org, ev, mgr, tm); await teamEntry(org, ev, mgr2, tm2);
  const cat = await category(org, ev, { name: 'Team', eligible: ['athlete', 'team_staff'] });
  const guestCat = await category(org, ev, { name: 'VIP', eligible: ['guest'] });
  const nominate = (who, body) => api('POST', `/events/${ev.id}/accreditation/nominations`, { token: who.token, body: { category_id: cat.id, ...body } });

  assert.equal((await nominate(mgr, { user_ids: [p1.id] })).status, 403, 'say which team');
  assert.equal((await nominate(mgr2, { user_ids: [p1.id], team_id: tm.id })).status, 403, 'not their team');
  assert.equal((await nominate(p1, { user_ids: [p2.id], team_id: tm.id })).status, 403, 'a player does not manage the team');
  const draft = must(await nominate(mgr, { user_ids: [p1.id, p2.id, out.id], team_id: tm.id, draft: true }), 201);
  assert.equal(draft.added.length, 2);
  assert.equal(draft.skipped[0].user_id, out.id, 'not on that team');
  assert.equal((await api('GET', '/me/accreditations', { token: p1.token })).body.length, 0, 'a draft is invisible to the holder');
  const submitted = must(await api('POST', `/accreditations/${draft.added[0].accreditation_id}/submit`, { token: mgr.token }));
  assert.equal(submitted.status, 'submitted');
  assert.equal((await api('POST', `/accreditations/${draft.added[1].accreditation_id}/submit`, { token: mgr2.token })).status, 404, 'only the nominator submits');
  assert.equal((await api('POST', `/accreditations/${submitted.id}/decision`, { token: mgr.token, body: { decision: 'approve' } })).status, 403, 'a team manager nominates but does not approve');
  assert.equal(must(await nominate(mgr, { user_ids: [p1.id], team_id: tm.id }), 201).existing.length, 1, 'nominating twice is harmless');
  const mine = must(await api('GET', `/events/${ev.id}/accreditations`, { token: mgr.token }));
  assert.equal(mine.length, 2, 'a manager sees their own nominations');
  assert.equal((await api('GET', `/events/${ev.id}/accreditations`, { token: mgr2.token })).body.length, 0);
  assert.equal((await api('GET', `/events/${ev.id}/accreditations`, { token: out.token })).status, 403);

  // the picker's data: only the groups the caller has authority over, with eligibility shown up front
  const cand = must(await api('GET', `/events/${ev.id}/accreditation/candidates`, { token: mgr.token, query: { category_id: cat.id } }));
  assert.deepEqual(cand.groups.map((g) => g.team_id), [tm.id], 'a manager sees only their own team');
  assert.equal(cand.groups[0].people.find((p) => p.user_id === p2.id).has_application, true);
  assert.equal(must(await api('GET', `/events/${ev.id}/accreditation/candidates`, { token: org.token, query: { category_id: cat.id } })).groups.filter((g) => g.kind === 'team').length, 2);
  assert.equal((await api('GET', `/events/${ev.id}/accreditation/candidates`, { token: out.token, query: { category_id: cat.id } })).body.groups.length, 0);

  // organiser invitations are approved at once; a guest needs a category that allows guests
  const inv = must(await api('POST', `/events/${ev.id}/accreditation/nominations`, { token: org.token, body: { category_id: guestCat.id, user_ids: [vip.id] } }), 201);
  assert.equal(inv.added[0].status, 'approved');
  const noGuest = must(await api('POST', `/events/${ev.id}/accreditation/nominations`, { token: org.token, body: { category_id: cat.id, user_ids: [vip.id] } }), 201);
  assert.match(noGuest.skipped[0].reason, /Not eligible/);
  const t = (await myBadge(vip, inv.added[0].accreditation_id)).credential.token;
  assert.equal(must(await scan(org, ev, t)).result, 'valid', 'an invited guest stands without another role');

  // department lead: approves only where the category says so
  const dept = must(await api('POST', `/events/${ev.id}/departments`, { token: org.token, body: { name: 'Media', kind: 'media', lead_user_id: lead.id } }), 201);
  const li = (await api('GET', '/me/department-invites', { token: lead.token })).body[0];
  must(await api('POST', `/department-members/${li.id}/respond`, { token: lead.token, body: { accept: true } }));
  const press = await signup(['athlete']);
  const pi = must(await api('POST', `/departments/${dept.id}/members`, { token: lead.token, body: { user_id: press.id } }), 201);
  must(await api('POST', `/department-members/${pi.id}/respond`, { token: press.token, body: { accept: true } }));
  const mediaCat = await category(org, ev, { name: 'Media', eligible: ['media'], approval: 'department_lead' });
  const orgOnly = await category(org, ev, { name: 'Media (organiser)', eligible: ['media'], approval: 'organiser' });
  const n1 = must(await api('POST', `/events/${ev.id}/accreditation/nominations`, { token: lead.token, body: { category_id: mediaCat.id, user_ids: [press.id], department_id: dept.id } }), 201);
  const n2 = must(await api('POST', `/events/${ev.id}/accreditation/nominations`, { token: lead.token, body: { category_id: orgOnly.id, user_ids: [press.id], department_id: dept.id } }), 201);
  assert.equal((await api('POST', `/accreditations/${n2.added[0].accreditation_id}/decision`, { token: lead.token, body: { decision: 'approve' } })).status, 403, 'the organiser keeps this category');
  assert.equal(must(await api('POST', `/accreditations/${n1.added[0].accreditation_id}/decision`, { token: lead.token, body: { decision: 'approve' } })).status, 'approved');
  assert.equal((await api('POST', `/accreditations/${n1.added[0].accreditation_id}/access`, { token: lead.token, body: { action: 'revoke', reason: 'Left the team' } })).status, 200, 'and may withdraw what they approved');
  const rej = must(await api('POST', `/accreditations/${n2.added[0].accreditation_id}/decision`, { token: org.token, body: { decision: 'reject', reason: 'Not needed', note: 'private note' } }));
  assert.equal(rej.status, 'rejected');
  assert.equal((await api('POST', `/accreditations/${rej.id}/decision`, { token: org.token, body: { decision: 'reject' } })).status, 200, 'repeat is harmless');
  const note = must(await api('GET', `/accreditations/${rej.id}`, { token: org.token }));
  assert.equal(note.note, 'private note');
  const enc = (await pool.query('SELECT note_enc FROM accreditations WHERE id=$1', [rej.id])).rows[0].note_enc;
  assert.ok(enc && !enc.includes('private'), 'free text is stored encrypted');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_accreditation_note' AND entity_id=$1", [rej.id])).rowCount, 'reading it is audit-logged');
});

test('prerequisites and capacity are enforced for everyone', async () => {
  const org = await signup(['organizer']), a = await signup(['athlete']), b = await signup(['athlete']);
  const ev = await newEvent(org);
  await soloEntry(org, ev, a); await soloEntry(org, ev, b);
  const coach = await category(org, ev, { name: 'Verified', eligible: ['athlete'], requires_verification: 'gamer', self_apply: true });
  assert.equal((await api('POST', `/accreditation/categories/${coach.id}/apply`, { token: a.token })).status, 409, 'needs a current verification');
  const small = await category(org, ev, { name: 'Small', eligible: ['athlete'], capacity: 1, self_apply: true });
  const x = must(await api('POST', `/accreditation/categories/${small.id}/apply`, { token: a.token }), 201);
  const y = must(await api('POST', `/accreditation/categories/${small.id}/apply`, { token: b.token }), 201);
  must(await api('POST', `/accreditations/${x.id}/decision`, { token: org.token, body: { decision: 'approve' } }));
  assert.equal((await api('POST', `/accreditations/${y.id}/decision`, { token: org.token, body: { decision: 'approve' } })).status, 409, 'category full');
  must(await api('POST', `/accreditations/${x.id}/withdraw`, { token: a.token }));
  assert.equal(must(await api('POST', `/accreditations/${y.id}/decision`, { token: org.token, body: { decision: 'approve' } })).status, 'approved', 'a place frees up');
  assert.equal((await api('POST', `/accreditations/${y.id}/withdraw`, { token: a.token })).status, 404, 'not yours');
});

test('young people need current guardian consent to be accredited and to pass the gate; photos are never shown', async () => {
  const org = await signup(['organizer']), mgr = await signup(['coach']), parent = await signup(['athlete']);
  const child = await signup(['athlete'], { dob: yearsAgo(12) });
  const ev = await newEvent(org), tm = await team(mgr);
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  must(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  must(await api('POST', `/teams/${tm.id}/members`, { token: mgr.token, body: { user_id: child.id } }), 201);
  await teamEntry(org, ev, mgr, tm);
  const cat = await category(org, ev, { name: 'Junior', eligible: ['athlete'], approval: 'auto', requires_photo: true });
  const go = () => api('POST', `/events/${ev.id}/accreditation/nominations`, { token: mgr.token, body: { category_id: cat.id, user_ids: [child.id], team_id: tm.id } });
  must(await api('DELETE', `/youth/children/${child.id}/consents/participation`, { token: parent.token }));
  assert.match(must(await go(), 201).skipped[0].reason, /guardian/i, 'consent withdrawn: nobody can accredit them');
  must(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  const r = must(await go(), 201);
  assert.equal(r.added[0].status, 'approved');
  const badge = await myBadge(child, r.added[0].accreditation_id);
  const hit = must(await scan(org, ev, badge.credential.token));
  assert.equal(hit.result, 'valid');
  assert.equal(hit.holder.avatar_url, null, 'no photo for a young person');
  must(await api('DELETE', `/youth/children/${child.id}/consents/participation`, { token: parent.token }));
  assert.equal(must(await scan(org, ev, badge.credential.token)).result, 'not_eligible', 'withdrawn consent stops the badge at once');
});

test('the report separates waiting, approved, live and actually checked-in, and shows who is inside', async () => {
  const org = await signup(['organizer']), a = await signup(['athlete']), b = await signup(['athlete']), c = await signup(['athlete']), guard = await signup(['coach']);
  const ev = await newEvent(org);
  const field = await zone(org, ev, 'Field of play', 'field_of_play');
  const cat = await category(org, ev, { name: 'Athlete', eligible: ['athlete'], zone_ids: [field.id], self_apply: true });
  for (const u of [a, b, c]) await soloEntry(org, ev, u);
  const ids = [];
  for (const u of [a, b, c]) ids.push(must(await api('POST', `/accreditation/categories/${cat.id}/apply`, { token: u.token }), 201).id);
  assert.equal((await api('GET', `/events/${ev.id}/accreditation/report`, { token: a.token })).status, 403);
  assert.equal(must(await api('GET', `/events/${ev.id}/accreditation/report`, { token: org.token })).totals.outstanding_approvals, 3);
  must(await api('POST', `/accreditations/${ids[0]}/decision`, { token: org.token, body: { decision: 'approve' } }));
  must(await api('POST', `/accreditations/${ids[1]}/decision`, { token: org.token, body: { decision: 'approve' } }));
  await staff(org, ev, guard, 'security');
  const t0 = (await myBadge(a, ids[0])).credential.token;
  must(await scan(guard, ev, t0, { zone_id: field.id }));
  must(await scan(guard, ev, (await myBadge(b, ids[1])).credential.token, { zone_id: field.id }));
  must(await scan(guard, ev, (await myBadge(b, ids[1])).credential.token, { zone_id: field.id, direction: 'out' }));
  must(await scan(guard, ev, 'GA1.bad.token'));
  const rep = must(await api('GET', `/events/${ev.id}/accreditation/report`, { token: guard.token }));
  assert.equal(rep.totals.outstanding_approvals, 1);
  assert.equal(rep.totals.approved, 2);
  assert.equal(rep.totals.checked_in, 2);
  const z = rep.zones.find((x) => x.zone_id === field.id);
  assert.equal(z.admitted, 2);
  assert.equal(z.inside, 1, 'one left');
  assert.equal(z.permitted, 2);
  must(await api('POST', `/accreditations/${ids[1]}/access`, { token: org.token, body: { action: 'revoke', reason: 'Withdrawn by team' } }));
  const after = must(await api('GET', `/events/${ev.id}/accreditation/report`, { token: org.token }));
  assert.equal(after.totals.revoked, 1);
  assert.equal(after.totals.live, 1);
  assert.equal(after.totals.never_used, 0);
  assert.ok(after.totals.refused_last_24h >= 1);
});

test('capabilities are exposed over REST, OpenAPI and MCP', async () => {
  const { capabilities } = await import('../src/registry.js');
  const names = capabilities.filter((c) => c.tag === 'Accreditation').map((c) => c.name);
  for (const n of ['create_accreditation_zone', 'create_accreditation_category', 'apply_for_accreditation', 'nominate_for_accreditation', 'decide_accreditation', 'scan_accreditation', 'change_accreditation_access', 'reissue_accreditation', 'accreditation_report', 'list_my_accreditations']) assert.ok(names.includes(n), n);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(spec.paths['/events/{id}/accreditation/scan']?.post, 'OpenAPI');
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.ok(r.ok);
  assert.ok(JSON.stringify(await r.json()).includes('scan_accreditation'), 'MCP');
});
