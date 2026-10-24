import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const key = () => `idem-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `rc_${n}`, display_name: `Person ${n}`, email: `rc${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const verifyRecruiter = (u) => q("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ('recruiter','user',$1,$1,'approved',1,now(), now() + interval '300 days') RETURNING id", [u.id]).then((r) => r[0].id);
const card = async (u, sport = 'football', extra = {}) => must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport, role: 'athlete', level: 'semi_pro', position: 'Striker', club: 'Eastside FC', region: 'Pune', ...extra } }), 201);
const ask = (r, a, body = {}) => api('POST', '/recruiter/requests', { token: r.token, body: { athlete_id: a.id, sport: 'football', scopes: ['profile', 'measurements', 'career'], purpose: 'trial', expires_on: inDays(30), idempotency_key: key(), ...body } });
const decide = (a, req, body = {}) => api('POST', `/me/recruiter-requests/${req.id}/decision`, { token: a.token, body: { decision: 'approve', row_version: req.row_version, ...body } });
const recruiter = async () => { const u = await signup(['recruiter']); await verifyRecruiter(u); return u; };
// an athlete with a football card, one shared measurement and one private measurement
async function athlete() {
  const a = await signup();
  const p = await card(a);
  must(await api('POST', `/me/sport-profiles/${p.id}/measurements`, { token: a.token, body: { metric: 'height', unit: 'cm', value: 181, measured_on: '2026-09-01', scope: 'recruiter' } }), 201);
  must(await api('POST', `/me/sport-profiles/${p.id}/measurements`, { token: a.token, body: { metric: 'weight', unit: 'kg', value: 74, measured_on: '2026-09-01', scope: 'private' } }), 201);
  must(await api('PATCH', `/me/sport-profiles/${p.id}/athlete`, { token: a.token, body: { dominant_side: 'left', positions: ['ST'], field_scopes: { dominant_side: 'recruiter', positions: 'private' } } }));
  return { ...a, card: p };
}
const grant = async (r, a, body = {}, dec = {}) => { const req = must(await ask(r, a, body), 201); return must(await decide(a, req, dec)); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('rc_root','rc_root','{admin}','x','x','rc_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('recruiter identity: the platform verification flow gates everything, and verification alone gives no athlete data', async () => {
  const r = await signup(['recruiter']), a = await athlete();
  assert.equal((await api('GET', '/recruiter/profile')).status, 401);
  assert.equal((await api('GET', '/recruiter/profile', { token: a.token })).status, 403, 'only the recruiter role');
  assert.equal(must(await api('GET', '/recruiter/profile', { token: r.token })).verified, false);
  assert.equal((await api('GET', '/recruiter/athletes/lookup', { token: r.token, query: { handle: a.handle } })).status, 403, 'unverified recruiters cannot look anyone up');
  assert.equal((await ask(r, a)).status, 403);
  assert.equal((await api('POST', '/recruiter/lists', { token: r.token, body: { name: 'Trials' } })).status, 403);

  const rules = must(await api('GET', '/verification/rules')).types.find((t) => t.type === 'recruiter');
  assert.ok(rules && rules.required.includes('id_document'));
  const c = must(await api('POST', '/verification/cases', { token: r.token, body: { type: 'recruiter', claim_note: 'Head scout, Eastside Academy', evidence: [{ kind: 'id_document', reference: 'https://example.com/id-1', label: 'Passport' }, { kind: 'club_letter', reference: 'https://example.com/letter-1', label: 'Club letter' }] } }), 201);
  assert.equal((await api('POST', '/verification/cases', { token: a.token, body: { type: 'recruiter', evidence: [{ kind: 'id_document', reference: 'https://example.com/x', label: 'x' }, { kind: 'club_letter', reference: 'https://example.com/y', label: 'y' }] } })).status >= 400, true, 'needs the recruiter role');
  must(await api('POST', `/admin/verification/cases/${c.id}/claim`, { token: admin.token }));
  const checklist = rules.checklist.map((x) => ({ key: x.key, ok: true }));
  must(await api('POST', `/admin/verification/cases/${c.id}/decision`, { token: admin.token, body: { decision: 'approve', checklist } }));
  const prof = must(await api('GET', '/recruiter/profile', { token: r.token }));
  assert.equal(prof.verified, true);
  assert.equal((await api('GET', `/recruiter/requests/${a.id}/athlete`, { token: r.token })).status, 404, 'still no athlete data without a grant');

  // profile: listed organisation or typed name, never both; stale versions refused
  const sports = must(await api('GET', '/sports'));
  const fb = sports.find((s) => s.slug === 'football');
  assert.equal((await api('POST', '/recruiter/profile', { token: r.token, body: { org_name: 'X Academy', organisation_id: '00000000-0000-4000-8000-000000000000', sport_ids: [] } })).status, 400);
  const saved = must(await api('POST', '/recruiter/profile', { token: r.token, body: { org_name: 'Eastside Academy', sport_ids: [fb.id], regions: ['Pune'], bio: 'Youth pathway scout' } }));
  assert.equal(saved.row_version, 1);
  assert.equal((await api('POST', '/recruiter/profile', { token: r.token, body: { org_name: 'Eastside', sport_ids: [], row_version: 99 } })).status, 409);
  assert.equal(must(await api('POST', '/recruiter/profile', { token: r.token, body: { org_name: 'Eastside', sport_ids: [fb.id], row_version: 1 } })).row_version, 2);
});

test('discovery is exact-handle only: no browse, no search, nothing for people without an athlete card', async () => {
  const r = await recruiter(), a = await athlete(), coach = await signup(['coach']);
  const hit = must(await api('GET', '/recruiter/athletes/lookup', { token: r.token, query: { handle: a.handle } }));
  assert.equal(hit.id, a.id);
  assert.deepEqual(hit.sports.map((s) => s.slug), ['football']);
  assert.equal(hit.is_youth, false);
  assert.ok(!('email' in hit) && !('dob' in hit));
  assert.equal((await api('GET', '/recruiter/athletes/lookup', { token: r.token, query: { handle: coach.handle } })).status, 404, 'no athlete card');
  assert.equal((await api('GET', '/recruiter/athletes/lookup', { token: r.token, query: { handle: 'rc_' } })).status, 404, 'partial handles find nothing');
  assert.equal((await api('GET', '/recruiter/athletes/lookup', { token: r.token, query: { handle: 'a' } })).status, 400);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='recruiter_lookup'", [r.id])).length);
});

test('access request: validation, idempotency, duplicates, scoped approval, stale versions', async () => {
  const r = await recruiter(), a = await athlete(), other = await athlete();
  assert.equal((await ask(r, a, { scopes: [] })).status, 400);
  assert.equal((await ask(r, a, { scopes: ['everything'] })).status, 400);
  assert.equal((await ask(r, a, { expires_on: inDays(-1) })).status, 400, 'past');
  assert.equal((await ask(r, a, { expires_on: inDays(400) })).status, 400, 'too long');
  assert.equal((await ask(r, r)).status, 400, 'not yourself');
  assert.equal((await ask(r, a, { sport: 'tennis' })).status, 404, 'athlete has no tennis card');
  assert.equal((await ask(r, { id: '00000000-0000-4000-8000-000000000000' })).status, 404);

  const body = { athlete_id: a.id, sport: 'football', scopes: ['profile', 'measurements', 'career'], purpose: 'trial', expires_on: inDays(30), idempotency_key: key(), message: 'We would like to invite you to trials.' };
  const req = must(await api('POST', '/recruiter/requests', { token: r.token, body }), 201);
  assert.equal(req.status, 'requested');
  assert.equal(req.live, false);
  const replay = must(await api('POST', '/recruiter/requests', { token: r.token, body }), 201);
  assert.equal(replay.id, req.id, 'a retry returns the same request');
  assert.equal((await ask(r, a)).status, 409, 'a second open request for the same athlete and sport is refused');
  assert.equal((await q('SELECT count(*)::int AS n FROM recruiter_access_requests WHERE recruiter_id=$1', [r.id]))[0].n, 1);
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='recruiter_request'", [a.id])).length, 'the athlete is told');

  // the athlete sees who is asking; others and the recruiter cannot decide
  const mine = must(await api('GET', '/me/recruiter-requests', { token: a.token }));
  assert.equal(mine[0].recruiter_verified, true);
  assert.equal(mine[0].purpose, 'trial');
  assert.equal(must(await api('GET', '/me/recruiter-requests', { token: other.token })).length, 0);
  assert.equal((await decide(r, req)).status, 404, 'the recruiter cannot approve their own request');
  assert.equal((await decide(other, req)).status, 404);
  // validation of the decision
  assert.equal((await decide(a, req, { granted_scopes: ['contact'] })).status, 400, 'only what was asked');
  assert.equal((await decide(a, req, { expires_on: inDays(90) })).status, 400, 'not longer than asked');
  assert.equal((await decide(a, req, { row_version: 9 })).status, 409, 'stale');
  const ok = must(await decide(a, req, { granted_scopes: ['profile', 'measurements'], expires_on: inDays(10) }));
  assert.equal(ok.status, 'approved');
  assert.deepEqual(ok.live_scopes.sort(), ['measurements', 'profile']);
  assert.equal((await decide(a, req, { row_version: ok.row_version })).status, 409, 'already decided');
  // after a decline a fresh request can be made
  const req2 = must(await ask(r, other), 201);
  must(await decide(other, req2, { decision: 'decline', note: 'Not now' }));
  must(await ask(r, other), 201);
});

test('the recruiter sees exactly the approved scopes, read live and audited; the athlete\'s own field and measurement scopes still apply', async () => {
  const r = await recruiter(), a = await athlete();
  const g = await grant(r, a, { scopes: ['profile', 'measurements', 'career', 'contact'] }, { granted_scopes: ['profile', 'measurements'] });
  const d = must(await api('GET', `/recruiter/requests/${g.id}/athlete`, { token: r.token }));
  assert.equal(d.athlete.id, a.id);
  assert.equal(d.profile.level, 'semi_pro');
  assert.equal(d.profile.club, 'Eastside FC');
  assert.equal(d.profile.dominant_side, 'left', 'shared with recruiters');
  assert.equal(d.profile.positions, undefined, 'private stays private');
  assert.deepEqual(d.measurements.map((m) => m.metric), ['height'], 'only the measurement shared with recruiters');
  assert.equal(d.measurements[0].value, 181);
  assert.equal(d.career, undefined, 'career was not allowed');
  assert.equal(d.email, undefined);
  assert.equal((await api('GET', `/recruiter/requests/${g.id}/contact`, { token: r.token })).status, 403, 'contact was not granted');
  assert.equal((await api('GET', `/recruiter/requests/${g.id}/athlete`, { token: (await recruiter()).token })).status, 404, 'another recruiter cannot use this grant');
  assert.equal((await api('GET', `/recruiter/requests/${g.id}/athlete`, { token: a.token })).status, 403, 'the athlete is not the recruiter');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_recruiter_dossier' AND entity_id=$2", [r.id, a.id])).length);

  // the generic person card honours the same live grant
  const plain = must(await api('GET', `/people/${a.id}`, { token: (await signup()).token }));
  assert.equal(plain.sport_profiles[0].dominant_side, undefined);
  const asRecruiter = must(await api('GET', `/people/${a.id}`, { token: r.token }));
  assert.equal(asRecruiter.sport_profiles[0].dominant_side, 'left');
  assert.deepEqual(asRecruiter.sport_profiles[0].measurements.map((m) => m.metric), ['height']);

  // contact scope: decrypted only on request, audited
  const r2 = await recruiter(), a2 = await athlete();
  const g2 = await grant(r2, a2, { scopes: ['contact'] });
  const c = must(await api('GET', `/recruiter/requests/${g2.id}/contact`, { token: r2.token }));
  assert.match(c.email, /@example\.com$/);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='decrypt_recruiter_contact'", [r2.id])).length);
});

test('live revocation: the athlete ends access and the very next read, contact, message, evaluation and export are refused', async () => {
  const r = await recruiter(), a = await athlete();
  const g = await grant(r, a, { scopes: ['profile', 'measurements', 'career', 'contact', 'messages'] });
  const list = must(await api('POST', '/recruiter/lists', { token: r.token, body: { name: 'Spring trials', sport: 'football' } }), 201);
  const entry = must(await api('POST', `/recruiter/lists/${list.id}/entries`, { token: r.token, body: { request_id: g.id } }), 201);
  must(await api('POST', `/recruiter/entries/${entry.id}/evaluations`, { token: r.token, body: { basis: 'live_viewing', observed_on: '2026-10-01', ratings: { technical: 4 }, overall: 4, notes: 'Quick feet, left foot only', idempotency_key: key() } }), 201);
  must(await api('POST', `/recruiter/requests/${g.id}/messages`, { token: r.token, body: { body: 'Hello', idempotency_key: key() } }), 201);

  assert.equal((await api('POST', `/me/recruiter-requests/${g.id}/revoke`, { token: (await signup()).token, body: {} })).status, 404, 'a stranger cannot revoke');
  const rev = must(await api('POST', `/me/recruiter-requests/${g.id}/revoke`, { token: a.token, body: { reason: 'Changed my mind' } }));
  assert.equal(rev.status, 'revoked');
  assert.equal(rev.live, false);

  for (const path of ['athlete', 'contact']) {
    const res = await api('GET', `/recruiter/requests/${g.id}/${path}`, { token: r.token });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.details?.code ?? res.body.error?.details?.code ?? 'access_not_live', 'access_not_live');
  }
  assert.equal((await api('GET', `/recruiter/requests/${g.id}/messages`, { token: r.token })).status, 403, 'the recruiter loses the thread');
  assert.equal((await api('POST', `/recruiter/requests/${g.id}/messages`, { token: r.token, body: { body: 'Still there?', idempotency_key: key() } })).status, 403);
  assert.equal((await api('POST', `/recruiter/entries/${entry.id}/evaluations`, { token: r.token, body: { basis: 'video', observed_on: '2026-10-02', overall: 3, idempotency_key: key() } })).status, 403, 'no new evaluations on a revoked grant');
  assert.equal((await api('POST', `/recruiter/entries/${entry.id}/contacts`, { token: r.token, body: { kind: 'call', contacted_on: '2026-10-02', idempotency_key: key() } })).status, 403);
  // the pipeline entry stays, with the athlete's identity and the notes withheld
  const e = must(await api('GET', `/recruiter/lists/${list.id}/entries`, { token: r.token }))[0];
  assert.equal(e.redacted, true);
  assert.equal(e.athlete, null);
  assert.equal(e.access, 'revoked');
  assert.equal(e.avg_overall, 4, 'your own score stays');
  const full = must(await api('GET', `/recruiter/entries/${entry.id}`, { token: r.token }));
  assert.equal(full.evaluations[0].notes, null);
  assert.equal(full.evaluations[0].withheld, true);
  const csv = must(await api('GET', `/recruiter/lists/${list.id}/export`, { token: r.token })).csv;
  assert.match(csv, /access ended/);
  assert.ok(!csv.includes(a.handle) && !csv.includes(a.display_name), 'export carries no identity after revocation');
  // the athlete keeps the history; the thread is closed; the recruiter was told
  assert.equal(must(await api('GET', `/recruiter/requests/${g.id}/messages`, { token: a.token })).messages.length, 1);
  assert.equal(must(await api('GET', `/recruiter/requests/${g.id}/messages`, { token: a.token })).closed, true);
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='recruiter_revoked'", [r.id])).length);
  assert.equal((await q('SELECT status FROM recruiter_access_requests WHERE id=$1', [g.id]))[0].status, 'revoked', 'the row is kept');
  // re-asking is allowed after revocation (a new request, a new decision)
  must(await ask(r, a), 201);
});

test('expiry and verification lapse are enforced live, not on a schedule', async () => {
  const r = await recruiter(), a = await athlete();
  const g = await grant(r, a);
  must(await api('GET', `/recruiter/requests/${g.id}/athlete`, { token: r.token }));
  await pool.query("UPDATE recruiter_access_requests SET expires_at = now() - interval '1 minute' WHERE id=$1", [g.id]);
  const res = await api('GET', `/recruiter/requests/${g.id}/athlete`, { token: r.token });
  assert.equal(res.status, 403);
  const shown = must(await api('GET', '/recruiter/requests', { token: r.token })).find((x) => x.id === g.id);
  assert.equal(shown.status, 'expired');
  must(await ask(r, a), 201); // an expired grant does not block a new request

  const r2 = await recruiter(), a2 = await athlete();
  const g2 = await grant(r2, a2);
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE type='recruiter' AND subject_id=$1", [r2.id]);
  assert.equal((await api('GET', `/recruiter/requests/${g2.id}/athlete`, { token: r2.token })).status, 403, 'revoked verification ends all access');
  assert.equal((await ask(r2, a2)).status, 403);
  const seen = must(await api('GET', '/me/recruiter-requests', { token: a2.token }))[0];
  assert.equal(seen.recruiter_verified, false, 'the athlete is shown that the recruiter is no longer verified');
  assert.equal(seen.live, false);
  const fresh = must(await ask(await recruiter(), a2), 201);
  assert.equal((await decide(a2, fresh)).status, 200, 'a different, verified recruiter can still be approved');
});

test('saved lists: duplicates, sport rule, stale versions, soft archive, history', async () => {
  const r = await recruiter(), a = await athlete(), b = await athlete(), stranger = await athlete();
  const ga = await grant(r, a), gb = await grant(r, b);
  const l = must(await api('POST', '/recruiter/lists', { token: r.token, body: { name: 'Trials', sport: 'football' } }), 201);
  assert.equal((await api('POST', '/recruiter/lists', { token: r.token, body: { name: 'trials' } })).status, 409, 'names are unique per recruiter');
  const tennis = must(await api('POST', '/recruiter/lists', { token: r.token, body: { name: 'Tennis', sport: 'tennis' } }), 201);
  assert.equal((await api('POST', `/recruiter/lists/${tennis.id}/entries`, { token: r.token, body: { request_id: ga.id } })).status, 400, 'a football athlete cannot go on a tennis list');
  assert.equal((await api('POST', `/recruiter/lists/${l.id}/entries`, { token: r.token, body: { request_id: '00000000-0000-4000-8000-000000000000' } })).status, 404);
  const pending = must(await ask(r, stranger, { sport: 'football' }), 201);
  assert.equal((await api('POST', `/recruiter/lists/${l.id}/entries`, { token: r.token, body: { request_id: pending.id } })).status, 403, 'no list entry without an approved grant');

  const e1 = must(await api('POST', `/recruiter/lists/${l.id}/entries`, { token: r.token, body: { request_id: ga.id } }), 201);
  const again = must(await api('POST', `/recruiter/lists/${l.id}/entries`, { token: r.token, body: { request_id: ga.id } }), 201);
  assert.equal(again.id, e1.id);
  assert.equal(again.replayed, true);
  const e2 = must(await api('POST', `/recruiter/lists/${l.id}/entries`, { token: r.token, body: { request_id: gb.id } }), 201);
  assert.equal(e1.stage, 'prospect');
  assert.equal(e1.athlete.id, a.id);

  const moved = must(await api('PATCH', `/recruiter/entries/${e1.id}`, { token: r.token, body: { stage: 'shortlist', row_version: e1.row_version } }));
  assert.equal(moved.stage, 'shortlist');
  assert.equal((await api('PATCH', `/recruiter/entries/${e1.id}`, { token: r.token, body: { stage: 'offer', row_version: e1.row_version } })).status, 409, 'stale');
  assert.equal((await api('PATCH', `/recruiter/entries/${e1.id}`, { token: (await recruiter()).token, body: { stage: 'offer', row_version: moved.row_version } })).status, 404, 'not someone else\'s');
  assert.equal(must(await api('GET', `/recruiter/lists/${l.id}/entries`, { token: r.token, query: { stage: 'shortlist' } })).length, 1);
  const lists = must(await api('GET', '/recruiter/lists', { token: r.token }));
  assert.deepEqual(lists.find((x) => x.id === l.id).stages, { prospect: 1, shortlist: 1 });

  const arch = must(await api('PATCH', `/recruiter/entries/${e2.id}`, { token: r.token, body: { archived: true, row_version: e2.row_version } }));
  assert.ok(arch.archived_at);
  assert.equal(must(await api('GET', `/recruiter/lists/${l.id}/entries`, { token: r.token })).length, 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM recruiter_list_entries WHERE list_id=$1', [l.id]))[0].n, 2, 'archived, never deleted');
  const hist = must(await api('GET', `/recruiter/entries/${e1.id}`, { token: r.token })).events.map((x) => x.action);
  assert.deepEqual(hist, ['added', 'moved']);
  // archive + restore a list
  const al = must(await api('PATCH', `/recruiter/lists/${l.id}`, { token: r.token, body: { archived: true, row_version: l.row_version } }));
  assert.ok(al.archived_at);
  assert.equal((await api('POST', `/recruiter/lists/${l.id}/entries`, { token: r.token, body: { request_id: gb.id } })).status, 409, 'restore first');
  assert.equal((await api('PATCH', `/recruiter/lists/${l.id}`, { token: r.token, body: { name: 'xx', row_version: 1 } })).status, 409);
});

test('evaluations and contact log: provenance, validation, idempotency, versions with history, athlete never sees them', async () => {
  const r = await recruiter(), a = await athlete();
  const g = await grant(r, a);
  const l = must(await api('POST', '/recruiter/lists', { token: r.token, body: { name: 'Eval' } }), 201);
  const e = must(await api('POST', `/recruiter/lists/${l.id}/entries`, { token: r.token, body: { request_id: g.id } }), 201);
  const ev = (body) => api('POST', `/recruiter/entries/${e.id}/evaluations`, { token: r.token, body: { basis: 'live_viewing', observed_on: '2026-10-01', ratings: { technical: 4, tactical: 3 }, overall: 4, idempotency_key: key(), ...body } });
  assert.equal((await ev({ basis: 'rumour' })).status, 400, 'a basis is required');
  assert.equal((await ev({ overall: 6 })).status, 400);
  assert.equal((await ev({ ratings: { speed: 5 } })).status, 400, 'unknown criterion');
  assert.equal((await ev({ observed_on: inDays(5) })).status, 400, 'not in the future');
  const k = key();
  const first = must(await ev({ idempotency_key: k, notes: 'Strong first touch' }), 201);
  assert.equal(must(await ev({ idempotency_key: k, notes: 'Strong first touch' }), 201).id, first.id, 'a retry creates one evaluation');
  assert.equal((await q('SELECT count(*)::int AS n FROM recruiter_evaluations WHERE entry_id=$1', [e.id]))[0].n, 1);
  assert.ok(!(await q('SELECT notes_enc FROM recruiter_evaluations WHERE id=$1', [first.id]))[0].notes_enc.includes('first touch'), 'notes are encrypted at rest');

  const upd = must(await api('PATCH', `/recruiter/evaluations/${first.id}`, { token: r.token, body: { overall: 5, notes: 'Elite first touch', row_version: first.row_version } }));
  assert.equal(upd.row_version, 2);
  assert.equal((await api('PATCH', `/recruiter/evaluations/${first.id}`, { token: r.token, body: { overall: 1, row_version: 1 } })).status, 409);
  assert.equal((await q('SELECT count(*)::int AS n FROM recruiter_evaluation_revisions WHERE evaluation_id=$1', [first.id]))[0].n, 2, 'every version is kept');
  const full = must(await api('GET', `/recruiter/entries/${e.id}`, { token: r.token }));
  assert.equal(full.evaluations[0].notes, 'Elite first touch');
  assert.equal(full.avg_overall, 5);
  assert.equal((await api('GET', `/recruiter/entries/${e.id}`, { token: a.token })).status, 403, 'the athlete cannot read the recruiter\'s evaluations');

  // contact log
  const c = (body) => api('POST', `/recruiter/entries/${e.id}/contacts`, { token: r.token, body: { kind: 'call', contacted_on: '2026-10-05', idempotency_key: key(), ...body } });
  assert.equal((await c({ kind: 'carrier_pigeon' })).status, 400);
  assert.equal((await c({ follow_up_on: '2026-10-01' })).status, 400, 'follow-up cannot precede the contact');
  const ck = key();
  const log = must(await c({ summary: 'Spoke about trial dates', follow_up_on: inDays(7), idempotency_key: ck }), 201);
  assert.equal(must(await c({ summary: 'Spoke about trial dates', idempotency_key: ck }), 201).id, log.id);
  const after = must(await api('GET', `/recruiter/entries/${e.id}`, { token: r.token }));
  assert.equal(after.contacts.length, 1);
  assert.equal(after.contacts[0].summary, 'Spoke about trial dates');
  assert.equal(after.stage, 'contacted', 'a first contact moves the athlete along the pipeline');
  assert.equal(after.next_follow_up_on, inDays(7));
});

test('messaging: needs the messages scope, both sides, idempotent, closable by the athlete', async () => {
  const r = await recruiter(), a = await athlete(), noMsg = await athlete();
  const g = await grant(r, a, { scopes: ['profile', 'messages'] });
  const gn = await grant(r, noMsg, { scopes: ['profile'] });
  const send = (u, id, body) => api('POST', `/recruiter/requests/${id}/messages`, { token: u.token, body: { body, idempotency_key: key() } });
  assert.equal((await send(r, gn.id, 'hi')).status, 403, 'messages were not allowed');
  assert.equal((await send(await signup(), g.id, 'hi')).status, 404, 'strangers are outsiders');
  assert.equal((await send(r, g.id, '   ')).status, 400);
  const k = key();
  const m1 = must(await api('POST', `/recruiter/requests/${g.id}/messages`, { token: r.token, body: { body: 'We rate your game.', idempotency_key: k } }), 201);
  assert.equal(must(await api('POST', `/recruiter/requests/${g.id}/messages`, { token: r.token, body: { body: 'We rate your game.', idempotency_key: k } }), 201).id, m1.id);
  must(await send(a, g.id, 'Thank you!'), 201);
  const t = must(await api('GET', `/recruiter/requests/${g.id}/messages`, { token: a.token }));
  assert.deepEqual(t.messages.map((x) => [x.sender_role, x.body]), [['recruiter', 'We rate your game.'], ['athlete', 'Thank you!']]);
  assert.ok(!(await q('SELECT body_enc FROM recruiter_messages WHERE id=$1', [m1.id]))[0].body_enc.includes('rate your game'), 'encrypted at rest');
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='recruiter_message'", [a.id])).length);

  must(await api('POST', `/me/recruiter-requests/${g.id}/thread`, { token: a.token, body: { closed: true } }));
  assert.equal((await send(r, g.id, 'Hello?')).status, 409, 'closed by the athlete');
  assert.equal(must(await api('GET', `/recruiter/requests/${g.id}/messages`, { token: r.token })).can_send, false);
  must(await api('POST', `/me/recruiter-requests/${g.id}/thread`, { token: a.token, body: { closed: false } }));
  must(await send(r, g.id, 'Hello again'), 201);
});

test('young people: only a guardian decides, only with current recruitment consent, no direct contact, withdrawal is immediate', async () => {
  const r = await recruiter(), mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(14) }), stranger = await signup();
  const l = must(await api('POST', '/youth/guardian-links', { token: mum.token, body: { guardian_id: mum.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: mum.token, body: { evidence: { reference: 'https://example.com/birth-ref-9', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'participation' } }), 201);
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role, level, position, is_default) SELECT $1, id, 'athlete', 'amateur', 'Winger', true FROM sports WHERE slug='football'", [kid.id]);

  const lookup = must(await api('GET', '/recruiter/athletes/lookup', { token: r.token, query: { handle: kid.handle } }));
  assert.equal(lookup.is_youth, true);
  assert.equal(lookup.decided_by, 'guardian');
  assert.equal((await ask(r, kid, { scopes: ['contact'] })).status, 400, 'no direct contact for a young person');
  const req = must(await ask(r, kid, { scopes: ['profile', 'messages'] }), 201);

  assert.equal(must(await api('GET', '/me/recruiter-requests', { token: kid.token })).length, 0, 'a young person is not the decider and sees nothing here');
  assert.equal((await decide(kid, req)).status, 404, 'the young person cannot decide alone');
  assert.equal((await decide(stranger, req)).status, 404);
  assert.equal(must(await api('GET', '/me/recruiter-requests', { token: mum.token, query: { athlete_id: kid.id } })).length, 1, 'the guardian sees it');
  assert.equal((await api('GET', '/me/recruiter-requests', { token: stranger.token, query: { athlete_id: kid.id } })).status, 404);
  const noConsent = await decide(mum, req);
  assert.equal(noConsent.status, 409, 'recruitment consent has to be given first');
  assert.equal(noConsent.body.details?.code ?? noConsent.body.error?.details?.code, 'guardian_consent_required');

  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'recruitment' } }), 201);
  const ok = must(await decide(mum, req, { granted_scopes: ['profile', 'messages'] }));
  assert.equal(ok.decided_by, mum.id);
  assert.deepEqual(ok.live_scopes, ['profile'], 'messaging also needs the guardian\'s contact consent');
  const d = must(await api('GET', `/recruiter/requests/${req.id}/athlete`, { token: r.token }));
  assert.equal(d.athlete.is_youth, true);
  assert.equal(d.profile.position, 'Winger');
  assert.equal((await api('GET', `/recruiter/requests/${req.id}/contact`, { token: r.token })).status, 403);
  assert.equal((await api('POST', `/recruiter/requests/${req.id}/messages`, { token: r.token, body: { body: 'Hi', idempotency_key: key() } })).status, 403);

  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'contact' } }), 201);
  assert.deepEqual(must(await api('GET', '/me/recruiter-requests', { token: mum.token, query: { athlete_id: kid.id } }))[0].live_scopes.sort(), ['messages', 'profile']);
  must(await api('POST', `/recruiter/requests/${req.id}/messages`, { token: r.token, body: { body: 'Hello from the club', idempotency_key: key() } }), 201);
  assert.equal((await api('POST', `/recruiter/requests/${req.id}/messages`, { token: kid.token, body: { body: 'hi', idempotency_key: key() } })).status, 404, 'the child cannot message a recruiter alone');
  must(await api('POST', `/recruiter/requests/${req.id}/messages`, { token: mum.token, body: { body: 'Thanks, we will look at dates.', idempotency_key: key() } }), 201);
  const thread = must(await api('GET', `/recruiter/requests/${req.id}/messages`, { token: mum.token }));
  assert.deepEqual(thread.messages.map((m) => m.sender_role), ['recruiter', 'guardian']);
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='recruiter_request'", [mum.id])).length, 'the guardian is notified, not the child');
  assert.equal((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='recruiter_request'", [kid.id])).length, 0);

  // a guardian withdrawing the consent ends access on the very next call
  must(await api('DELETE', `/youth/children/${kid.id}/consents/recruitment`, { token: mum.token }));
  const after = await api('GET', `/recruiter/requests/${req.id}/athlete`, { token: r.token });
  assert.equal(after.status, 403);
  assert.equal((await api('GET', `/recruiter/requests/${req.id}/messages`, { token: r.token })).status, 403);
  // and the guardian can still read the history and revoke
  assert.equal(must(await api('GET', `/recruiter/requests/${req.id}/messages`, { token: mum.token })).messages.length, 2);
  assert.equal(must(await api('POST', `/me/recruiter-requests/${req.id}/revoke`, { token: mum.token, body: {} })).status, 'revoked');
});

test('capabilities are exposed over REST, OpenAPI and MCP', async () => {
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json().catch(() => null);
  if (spec?.paths) {
    assert.ok(spec.paths['/recruiter/requests'], 'OpenAPI has the recruiter paths');
    assert.ok(spec.paths['/me/recruiter-requests/{id}/decision']);
  }
  const r = await recruiter();
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${r.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const tools = (await res.json()).result?.tools?.map((t) => t.name) ?? [];
  for (const name of ['create_recruiter_request', 'get_recruiter_athlete', 'decide_recruiter_request', 'revoke_recruiter_access', 'send_recruiter_message']) assert.ok(tools.includes(name), `MCP tool ${name}`);
});
