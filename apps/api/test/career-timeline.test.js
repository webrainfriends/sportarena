import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { backfillYouth } = await import('../src/youth.js');
const { encrypt } = await import('../src/crypto.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ct_${n}_${roles[0]}`, display_name: `Career ${n}`, email: `ct${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const team = async (owner, name) => must(await api('POST', '/teams', { token: owner.token, body: { name: name ?? `Rovers ${++n}`, sport: 'football' } }), 201);
const key = () => `idem-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const add = (u, body) => api('POST', '/me/career', { token: u.token, body: { idempotency_key: key(), starts_on: '2022-08-01', ...body } });
const csvRows = (csv) => csv.trim().split('\n').length - 1;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ct_root','ct_root','{admin}','x','x','ct_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('membership periods: validated, canonical club authoritative, idempotent, duplicate-safe, stale-safe, soft-archived with full history', async () => {
  const p = await signup(), mgr = await signup(['coach']), other = await signup();
  const t = await team(mgr, 'Eastside FC');
  assert.equal((await api('GET', '/me/career')).status, 401);

  // invalid input
  assert.equal((await add(p, { sport: 'football' })).status, 400, 'a club, team or name is needed');
  assert.equal((await add(p, { team_id: t.id, club_name: 'Typed FC' })).status, 400, 'listed OR typed, not both');
  assert.equal((await add(p, { club_name: 'Typed FC' })).status, 400, 'sport needed for an unlisted club');
  assert.equal((await add(p, { team_id: t.id, sport: 'cricket' })).status, 400, 'team sport mismatch');
  assert.equal((await add(p, { team_id: t.id, ends_on: '2021-01-01' })).status, 400, 'ends before it starts');
  assert.equal((await add(p, { team_id: t.id, competition_level: 'galactic' })).status, 400);
  assert.equal((await add(p, { team_id: '00000000-0000-0000-0000-000000000000' })).status, 404);

  // create + idempotent replay
  const k = key();
  const body = { team_id: t.id, season_label: '2022/23', position: 'Midfielder', competition_level: 'academy', jersey_no: 8, idempotency_key: k, starts_on: '2022-08-01', ends_on: '2023-05-31' };
  const a = must(await api('POST', '/me/career', { token: p.token, body }), 201);
  assert.equal(a.club, 'Eastside FC'); assert.equal(a.unlisted, false); assert.equal(a.starts_on, '2022-08-01'); assert.equal(a.verification_status, 'unverified'); assert.equal(a.row_version, 1);
  const again = must(await api('POST', '/me/career', { token: p.token, body }), 201);
  assert.equal(again.id, a.id); assert.equal(again.replayed, true);
  // concurrent identical retries create exactly one
  const kk = key();
  const racers = await Promise.all([1, 2, 3, 4].map(() => api('POST', '/me/career', { token: p.token, body: { club_name: 'Racing FC', sport: 'football', idempotency_key: kk, starts_on: '2020-01-01' } })));
  assert.ok(racers.every((r) => [200, 201, 409].includes(r.status)), JSON.stringify(racers.map((r) => r.status)));
  assert.equal((await pool.query("SELECT count(*)::int n FROM career_memberships WHERE user_id=$1 AND club_name='Racing FC'", [p.id])).rows[0].n, 1);
  // a re-typed duplicate with a new key is refused
  const dup = await add(p, { team_id: t.id, starts_on: '2022-08-01' });
  assert.equal(dup.status, 409); assert.equal(dup.body.error?.details?.code ?? dup.body.details?.code ?? 'duplicate_membership', 'duplicate_membership');

  // correction: stale version refused, correct one applied, history kept
  const fix = must(await api('PATCH', `/me/career/${a.id}`, { token: p.token, body: { row_version: 1, position: 'Striker', reason: 'wrong position' } }));
  assert.equal(fix.position, 'Striker'); assert.equal(fix.row_version, 2);
  assert.equal(fix.competition_level, 'academy', 'a correction never resets fields it did not touch'); assert.equal(fix.jersey_no, 8); assert.equal(fix.season_label, '2022/23'); assert.equal(fix.corrections, 1);
  const st = await api('PATCH', `/me/career/${a.id}`, { token: p.token, body: { row_version: 1, position: 'Winger' } });
  assert.equal(st.status, 409);
  assert.equal((await api('PATCH', `/me/career/${a.id}`, { token: other.token, body: { row_version: 2, position: 'x' } })).status, 404, 'someone else cannot even see it');
  const revs = must(await api('GET', `/me/career/${a.id}/revisions`, { token: p.token }));
  assert.deepEqual(revs.map((r) => r.action), ['created', 'corrected']);
  assert.equal(revs[0].snapshot.position, 'Midfielder'); assert.equal(revs[0].snapshot.starts_on, '2022-08-01'); assert.ok(!('idempotency_key' in revs[0].snapshot)); assert.equal(revs[1].reason, 'wrong position');

  // unlisted club stays flagged; ending a stint is an edit
  const open = must(await add(p, { club_name: 'Village Lions', sport: 'football', starts_on: '2024-01-01' }), 201);
  assert.equal(open.unlisted, true); assert.equal(open.current, true);
  const ended = must(await api('PATCH', `/me/career/${open.id}`, { token: p.token, body: { row_version: 1, ends_on: '2024-06-30' } }));
  assert.equal(ended.current, false);
  assert.equal((await api('PATCH', `/me/career/${open.id}`, { token: p.token, body: { row_version: 2, ends_on: '2023-01-01' } })).status, 400);

  // soft archive keeps the row + history; restore works; list order is deterministic
  const arch = must(await api('POST', `/me/career/${open.id}/archive`, { token: p.token, body: { row_version: 2 } }));
  assert.ok(arch.archived_at);
  assert.ok(!must(await api('GET', '/me/career', { token: p.token })).some((x) => x.id === open.id));
  assert.ok(must(await api('GET', '/me/career', { token: p.token, query: { include_archived: 'true' } })).some((x) => x.id === open.id));
  assert.equal((await api('PATCH', `/me/career/${open.id}`, { token: p.token, body: { row_version: 3, position: 'x' } })).status, 409, 'restore first');
  must(await api('POST', `/me/career/${open.id}/archive`, { token: p.token, body: { row_version: 3, archived: false } }));
  const list = must(await api('GET', '/me/career', { token: p.token }));
  assert.deepEqual(list.map((x) => x.starts_on), [...list.map((x) => x.starts_on)].sort().reverse());
  assert.equal((await pool.query('SELECT count(*)::int n FROM career_membership_revisions WHERE membership_id=$1', [open.id])).rows[0].n, 4);
  assert.equal(must(await api('GET', '/me/career', { token: other.token })).length, 0, 'private to its owner');
});

test('roster hook keeps every stint (re-joins included); backfill is idempotent and non-destructive', async () => {
  const p = await signup(), mgr = await signup(['coach']);
  const t = await team(mgr, 'Hook United');
  must(await api('POST', `/teams/${t.id}/members`, { token: mgr.token, body: { user_id: p.id, role: 'player', jersey_no: 10 } }), 201);
  let l = must(await api('GET', '/me/career', { token: p.token }));
  assert.equal(l.length, 1); assert.equal(l[0].source, 'roster'); assert.equal(l[0].current, true); assert.equal(l[0].club, 'Hook United');
  // adding twice does not duplicate
  must(await api('POST', `/teams/${t.id}/members`, { token: mgr.token, body: { user_id: p.id, role: 'player' } }), 201);
  assert.equal(must(await api('GET', '/me/career', { token: p.token })).length, 1);
  must(await api('DELETE', `/teams/${t.id}/members/${p.id}`, { token: p.token }));
  l = must(await api('GET', '/me/career', { token: p.token }));
  assert.equal(l.length, 1); assert.equal(l[0].current, false, 'former membership is kept');
  // coaches/managers are not player stints
  assert.equal(must(await api('GET', '/me/career', { token: mgr.token })).length, 0);
  // re-join the same day re-opens that stint instead of colliding
  must(await api('POST', `/teams/${t.id}/members`, { token: mgr.token, body: { user_id: p.id, role: 'player' } }), 201);
  l = must(await api('GET', '/me/career', { token: p.token }));
  assert.equal(l.length, 1); assert.equal(l[0].current, true);
  // legacy club text + roster rows are backfilled once, without changing the source rows
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role, club) SELECT $1, id, 'athlete', 'Legacy Club' FROM sports WHERE slug='football'", [p.id]);
  await pool.query("DELETE FROM career_membership_revisions WHERE membership_id IN (SELECT id FROM career_memberships WHERE user_id=$1)", [p.id]);
  await pool.query("DELETE FROM career_memberships WHERE user_id=$1", [p.id]);
  const sql = (await import('node:fs')).readFileSync(new URL('../migrations/103_career_timeline.sql', import.meta.url), 'utf8');
  await pool.query(sql); await pool.query(sql);
  const after1 = (await pool.query('SELECT count(*)::int n FROM career_memberships WHERE user_id=$1', [p.id])).rows[0].n;
  assert.ok(after1 >= 1);
  await pool.query(sql);
  assert.equal((await pool.query('SELECT count(*)::int n FROM career_memberships WHERE user_id=$1', [p.id])).rows[0].n, after1);
  assert.equal((await pool.query("SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2", [t.id, p.id])).rows[0].status, 'active');
});

test('evidence is encrypted and audited; club staff verify or reject; edits to a verified entry reset it; staff scope is enforced', async () => {
  const p = await signup(), mgr = await signup(['coach']), rival = await signup(['coach']), stranger = await signup();
  const t = await team(mgr, 'Verify FC'); await team(rival, 'Other FC');
  const e = must(await add(p, { team_id: t.id }), 201);
  const unl = must(await add(p, { club_name: 'Ghost FC', sport: 'football', starts_on: '2019-01-01' }), 201);

  assert.equal((await api('POST', `/me/career/${e.id}/request-verification`, { token: p.token, body: { row_version: 1 } })).status, 400, 'evidence first');
  const ev = must(await api('POST', `/me/career/${e.id}/evidence`, { token: p.token, body: { kind: 'club_letter', label: 'Letter', reference: 'LTR-2022-0042' } }), 201);
  assert.equal((await pool.query('SELECT reference_enc FROM career_membership_evidence WHERE id=$1', [ev.id])).rows[0].reference_enc.startsWith('v1.'), true);
  assert.ok(!JSON.stringify(must(await api('GET', '/me/career', { token: p.token }))).includes('LTR-2022-0042'), 'list never carries references');
  assert.equal((await api('POST', `/me/career/${e.id}/evidence`, { token: stranger.token, body: { kind: 'other', reference: 'abc-def' } })).status, 404);
  must(await api('POST', `/me/career/${unl.id}/evidence`, { token: p.token, body: { kind: 'other', reference: 'friend said so' } }), 201);

  const pend = must(await api('POST', `/me/career/${e.id}/request-verification`, { token: p.token, body: { row_version: 1 } }));
  assert.equal(pend.verification_status, 'pending');
  assert.equal((await api('POST', `/me/career/${e.id}/request-verification`, { token: p.token, body: { row_version: 1 } })).status, 409, 'stale');

  // queue + scope
  assert.equal(must(await api('GET', '/career/review-queue', { token: rival.token })).length, 0);
  assert.equal(must(await api('GET', '/career/review-queue', { token: p.token })).length, 0);
  assert.deepEqual(must(await api('GET', '/career/review-queue', { token: mgr.token })).map((x) => x.id), [e.id]);
  assert.equal((await api('POST', `/career/${e.id}/review`, { token: rival.token, body: { decision: 'verify', row_version: 2 } })).status, 404);
  assert.equal((await api('POST', `/career/${e.id}/review`, { token: p.token, body: { decision: 'verify', row_version: 2 } })).status, 404, 'no self review');
  assert.equal((await api('GET', `/me/career/${e.id}/evidence`, { token: rival.token })).status, 404);
  const before = (await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='read_career_evidence'")).rows[0].n;
  const seen = must(await api('GET', `/me/career/${e.id}/evidence`, { token: mgr.token }));
  assert.equal(seen[0].reference, 'LTR-2022-0042');
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='read_career_evidence'")).rows[0].n, before + 1);

  assert.equal((await api('POST', `/career/${e.id}/review`, { token: mgr.token, body: { decision: 'reject', row_version: 2 } })).status, 400, 'reason needed');
  assert.equal((await api('POST', `/career/${e.id}/review`, { token: mgr.token, body: { decision: 'verify', row_version: 1 } })).status, 409, 'stale');
  const ver = must(await api('POST', `/career/${e.id}/review`, { token: mgr.token, body: { decision: 'verify', note: 'Confirmed', row_version: 2 } }));
  assert.equal(ver.verification_status, 'verified'); assert.ok(ver.verified_at);
  assert.equal((await api('POST', `/career/${e.id}/review`, { token: mgr.token, body: { decision: 'verify', row_version: 3 } })).status, 409, 'not pending any more');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='career_verified'", [p.id])).rowCount >= 1);

  // changing the claim after verification sends it back to unverified (history keeps who verified)
  const ed = must(await api('PATCH', `/me/career/${e.id}`, { token: p.token, body: { row_version: 3, starts_on: '2022-09-01' } }));
  assert.equal(ed.verification_status, 'unverified');
  // changing only the position keeps it
  must(await api('POST', `/me/career/${e.id}/request-verification`, { token: p.token, body: { row_version: 4 } }));
  must(await api('POST', `/career/${e.id}/review`, { token: mgr.token, body: { decision: 'verify', row_version: 5 } }));
  assert.equal(must(await api('PATCH', `/me/career/${e.id}`, { token: p.token, body: { row_version: 6, position: 'Keeper' } })).verification_status, 'verified');

  // an unlisted club can only be verified by the platform team
  must(await api('POST', `/me/career/${unl.id}/request-verification`, { token: p.token, body: { row_version: 1 } }));
  assert.equal(must(await api('GET', '/career/review-queue', { token: mgr.token })).length, 0);
  assert.equal((await api('POST', `/career/${unl.id}/review`, { token: mgr.token, body: { decision: 'verify', row_version: 2 } })).status, 404);
  assert.deepEqual(must(await api('GET', '/career/review-queue', { token: admin.token })).map((x) => x.id), [unl.id]);
  must(await api('POST', `/career/${unl.id}/review`, { token: admin.token, body: { decision: 'reject', note: 'Cannot confirm', row_version: 2 } }));
  assert.equal(must(await api('GET', '/me/career', { token: p.token })).find((x) => x.id === unl.id).verification_status, 'rejected');
  const hist = must(await api('GET', `/me/career/${e.id}/revisions`, { token: p.token })).map((r) => r.action);
  assert.ok(hist.includes('verified') && hist.includes('verification_requested') && hist.includes('corrected'));
});

test('youth: guardian acts for the child, self-service needs consent, no exports or shares by the child, consent revocation is immediate', async () => {
  const mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) }), stranger = await signup(), mgr = await signup(['coach']);
  const t = await team(mgr, 'Juniors FC');
  const l = must(await api('POST', '/youth/guardian-links', { token: mum.token, body: { guardian_id: mum.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: mum.token, body: { evidence: { reference: 'https://example.com/birth-ref-123', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));

  // no consent yet: the child cannot write; the guardian can (acting for them), a stranger cannot
  assert.equal((await add(kid, { team_id: t.id })).status, 409);
  assert.equal((await add(stranger, { team_id: t.id, user_id: kid.id })).status, 403);
  const g = must(await add(mum, { team_id: t.id, user_id: kid.id }), 201);
  assert.equal(g.user_id, kid.id);
  assert.equal(must(await api('GET', '/me/career', { token: mum.token, query: { user_id: kid.id } })).length, 1);
  assert.equal((await api('GET', '/me/career', { token: stranger.token, query: { user_id: kid.id } })).status, 403);
  assert.equal(must(await api('GET', '/me/career', { token: mum.token })).length, 0, 'not mixed into the guardian\'s own');

  // exports: guardian only
  assert.equal((await api('GET', '/me/career/export', { token: kid.token })).status, 403);
  assert.equal(csvRows(must(await api('GET', '/me/career/export', { token: mum.token, query: { user_id: kid.id } })).csv), 1);

  // consent lets the child write; a request for verification only reaches staff while consent is live
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'participation' } }), 201);
  const own = must(await add(kid, { club_name: 'School XI', sport: 'football', starts_on: '2023-01-01' }), 201);
  must(await api('POST', `/me/career/${g.id}/evidence`, { token: mum.token, body: { kind: 'registration_card', reference: 'REG-123456' } }), 201);
  must(await api('POST', `/me/career/${g.id}/request-verification`, { token: mum.token, body: { row_version: 1 } }));
  assert.equal(must(await api('GET', '/career/review-queue', { token: mgr.token })).length, 1);
  const c = must(await api('GET', `/youth/children/${kid.id}/consents`, { token: mum.token }).catch(() => ({ status: 200, body: [] })));
  const consentId = (Array.isArray(c) ? c : c.items ?? []).find?.((x) => x.purpose === 'participation')?.id;
  if (consentId) must(await api('POST', `/youth/consents/${consentId}/revoke`, { token: mum.token, body: {} }));
  else await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='participation'", [kid.id]);
  assert.equal((await add(kid, { club_name: 'Other XI', sport: 'football' })).status, 409, 'revocation applies at once');
  assert.equal(must(await api('GET', '/career/review-queue', { token: mgr.token })).length, 0, 'queue hides entries without live consent');
  assert.equal((await api('POST', `/career/${g.id}/review`, { token: mgr.token, body: { decision: 'verify', row_version: 2 } })).status, 409);
  assert.equal(must(await api('GET', '/me/career', { token: kid.token })).length, 2, 'existing records are kept and still readable');
  void own;
});

test('passport: career only on links that include it, labelled by verification, never shows evidence, gone when the link is revoked', async () => {
  const p = await signup(), mgr = await signup(['coach']);
  const t = await team(mgr, 'Pass FC');
  const e = must(await add(p, { team_id: t.id, season_label: '2022/23' }), 201);
  must(await api('POST', `/me/career/${e.id}/evidence`, { token: p.token, body: { kind: 'club_letter', reference: 'SECRET-REF-9' } }), 201);
  must(await add(p, { club_name: 'Rejected FC', sport: 'football', starts_on: '2018-01-01' }), 201);
  await pool.query("UPDATE career_memberships SET verification_status='rejected' WHERE user_id=$1 AND club_name='Rejected FC'", [p.id]);

  const off = must(await api('POST', '/me/passport-links', { token: p.token, body: {} }), 201);
  assert.equal(off.show_career, false);
  assert.equal(must(await api('GET', `/passport/${off.token}`)).memberships, null);
  const on = must(await api('POST', '/me/passport-links', { token: p.token, body: { show_career: true } }), 201);
  const pub = must(await api('GET', `/passport/${on.token}`));
  assert.equal(pub.memberships.length, 1); assert.equal(pub.memberships[0].club, 'Pass FC'); assert.equal(pub.memberships[0].verification_status, 'unverified');
  assert.ok(!JSON.stringify(pub).includes('SECRET-REF-9'));
  assert.equal(must(await api('GET', '/me/passport', { token: p.token })).memberships.length, 1);
  must(await api('POST', `/me/passport-links/${on.id}/revoke`, { token: p.token }));
  assert.equal((await api('GET', `/passport/${on.token}`)).status, 404);
  assert.equal(csvRows(must(await api('GET', '/me/career/export', { token: p.token })).csv), 2);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export_career' AND actor_id=$1", [p.id])).rowCount);
});
