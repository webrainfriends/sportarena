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
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `gd_${n}_${roles[0]}`, display_name: `Guard ${n}`, email: `gd${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const kid = (age = 12) => signup(['athlete'], { dob: yearsAgo(age) });
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };

/** parent requests, child accepts, evidence, admin approves */
async function verifiedGuardian(parent, child, extra = {}) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  return must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match', ...extra } }));
}
const team = async (owner) => must(await api('POST', '/teams', { token: owner.token, body: { name: `Juniors ${++n}`, sport: 'football' } }), 201);
const allow = (parent, child, purpose, body = {}) => api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose, ...body } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('gd_root','gd_root','{admin}','x','x','gd_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('an unrelated adult cannot make themselves a guardian', async () => {
  const child = await kid();
  const stranger = await signup();
  const other = await signup();
  // cannot start a link that does not include you
  assert.equal((await api('POST', '/youth/guardian-links', { token: stranger.token, body: { guardian_id: other.id, child_id: child.id } })).status, 403);
  const l = must(await api('POST', '/youth/guardian-links', { token: stranger.token, body: { guardian_id: stranger.id, child_id: child.id } }), 201);
  assert.equal(l.status, 'invited');
  // before the child accepts: no evidence, no authority
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: stranger.token, body: { evidence } })).status, 409);
  // the requester cannot accept their own request, a bystander cannot even see it
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: stranger.token, body: { accept: true } })).status, 403);
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: other.token, body: { accept: true } })).status, 404);
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: stranger.token, body: { decision: 'approve', note: 'trust me' } })).status, 403);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: stranger.token, body: { evidence } }), 201);
  // accepted + evidence is still not authority: only the platform team verifies
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: stranger.token, body: { decision: 'approve', note: 'trust me' } })).status, 403);
  assert.equal((await allow(stranger, child, 'participation')).status, 403);
  assert.equal((await api('POST', `/youth/children/${child.id}/pickup-delegates`, { token: stranger.token, body: { delegate_user_id: other.id } })).status, 403);
  assert.equal((await api('GET', `/youth/children/${child.id}/consents`, { token: stranger.token })).status, 404);
  // adults are not youth: no link to an adult, and a youth cannot be a guardian
  const adult = await signup(['athlete'], { dob: yearsAgo(30) });
  assert.equal((await api('POST', '/youth/guardian-links', { token: stranger.token, body: { guardian_id: stranger.id, child_id: adult.id } })).status, 400);
  assert.equal((await api('POST', '/youth/guardian-links', { token: child.token, body: { guardian_id: child.id, child_id: (await kid()).id } })).status, 400);
  // admin sees it in the review queue and the evidence is encrypted at rest
  assert.ok(must(await api('GET', '/youth/reviews', { token: admin.token })).some((r) => r.id === l.id));
  assert.equal((await api('GET', '/youth/reviews', { token: stranger.token })).status, 403);
  const raw = (await pool.query('SELECT reference_enc FROM guardian_evidence WHERE link_id=$1', [l.id])).rows[0].reference_enc;
  assert.ok(!raw.includes('birth-certificate'));
  const ev = must(await api('GET', `/youth/guardian-links/${l.id}/evidence`, { token: admin.token }));
  assert.equal(ev[0].reference, evidence.reference);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_guardian_evidence' AND entity_id=$1", [l.id])).rowCount);
  // rejecting keeps the history and gives no authority
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'reject', note: 'Document unreadable' } }));
  assert.equal((await allow(stranger, child, 'participation')).status, 403);
  // duplicate open requests are refused
  must(await api('POST', '/youth/guardian-links', { token: stranger.token, body: { guardian_id: stranger.id, child_id: child.id } }), 201);
  assert.equal((await api('POST', '/youth/guardian-links', { token: child.token, body: { guardian_id: stranger.id, child_id: child.id } })).status, 409);
});

test('consent is per purpose, expires, and stops new actions when withdrawn or lapsed', async () => {
  const parent = await signup(); const child = await kid(); const coach = await signup(['coach']);
  const t = await team(coach);
  // before any guardian: a youth account cannot be put on a roster
  const blocked = await api('POST', `/teams/${t.id}/members`, { token: coach.token, body: { user_id: child.id } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error?.details?.code ?? blocked.body.details?.code, 'guardian_consent_required');
  await verifiedGuardian(parent, child);
  assert.equal((await api('POST', `/teams/${t.id}/members`, { token: coach.token, body: { user_id: child.id } })).status, 409); // verified, but nothing allowed yet
  const c = must(await allow(parent, child, 'participation', { expires_in_days: 30 }), 201);
  assert.equal(c.policy_version, 1);
  assert.equal(c.granted_by, parent.id);
  must(await api('POST', `/teams/${t.id}/members`, { token: coach.token, body: { user_id: child.id } }), 201);
  // other purposes are separate: medical sharing and team chat still blocked
  const prov = await signup(['doctor']);
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role) SELECT $1, id, 'doctor' FROM sports WHERE slug='football'", [prov.id]);
  assert.equal((await api('POST', '/medical/grants', { token: child.token, body: { provider_id: prov.id } })).status, 409);
  assert.equal((await api('POST', `/teams/${t.id}/messages`, { token: child.token, body: { body: 'hi coach' } })).status, 409);
  must(await allow(parent, child, 'contact'), 201);
  must(await api('POST', `/teams/${t.id}/messages`, { token: child.token, body: { body: 'hi coach' } }), 201);
  // withdrawing stops new actions at once
  must(await api('DELETE', `/youth/children/${child.id}/consents/contact`, { token: parent.token }));
  assert.equal((await api('POST', `/teams/${t.id}/messages`, { token: child.token, body: { body: 'again' } })).status, 409);
  // expiry (consent window can't exceed policy: asking for 700 days is capped at 365)
  const long = must(await allow(parent, child, 'media', { expires_in_days: 700 }), 201);
  assert.ok(new Date(long.expires_at) < new Date(Date.now() + 366 * 864e5));
  await pool.query("UPDATE youth_consents SET expires_at = now() - interval '1 minute' WHERE child_id=$1 AND purpose='participation'", [child.id]);
  const coach2 = await signup(['coach']); const t2 = await team(coach2);
  assert.equal((await api('POST', `/teams/${t2.id}/members`, { token: coach2.token, body: { user_id: child.id } })).status, 409);
  const st = must(await api('GET', `/youth/children/${child.id}/consents`, { token: child.token }));
  assert.equal(st.consents.find((x) => x.purpose === 'participation').state, 'expired');
  assert.equal(st.consents.find((x) => x.purpose === 'contact').state, 'revoked');
  assert.equal(st.consents.find((x) => x.purpose === 'medical').state, 'not_given');
  assert.ok(st.history.length >= 4 && st.history.every((h) => h.policy_version === 1 || h.policy_version === null));
  // the young person cannot grant their own consent; strangers cannot read the state
  assert.equal((await allow(child, child, 'participation')).status, 403);
  assert.equal((await api('GET', `/youth/children/${child.id}/consents`, { token: coach2.token })).status, 404);
  // renewing replaces the old consent and works again; revoking the guardian link makes every consent they gave lapse
  must(await allow(parent, child, 'participation'), 201);
  must(await api('POST', `/teams/${t2.id}/members`, { token: coach2.token, body: { user_id: child.id } }), 201);
  const links = must(await api('GET', '/youth/guardian-links', { token: parent.token, query: { status: 'active' } }));
  must(await api('POST', `/youth/guardian-links/${links[0].id}/revoke`, { token: parent.token, body: { reason: 'No longer responsible' } }));
  const coach3 = await signup(['coach']); const t3 = await team(coach3);
  assert.equal((await api('POST', `/teams/${t3.id}/members`, { token: coach3.token, body: { user_id: child.id } })).status, 409);
  assert.equal((await allow(parent, child, 'participation')).status, 403);
  // history is append-only
  await assert.rejects(pool.query('UPDATE youth_consent_events SET action=\'grant\''), /append-only/);
});

test('medical consent gates appointments, grants, records and fit-to-play status for a young person', async () => {
  const parent = await signup(); const child = await kid(15); const doc = await signup(['doctor']); const coach = await signup(['coach']);
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role) SELECT $1, id, 'doctor' FROM sports WHERE slug='football'", [doc.id]);
  await verifiedGuardian(parent, child);
  must(await allow(parent, child, 'participation'), 201);
  const t = await team(coach);
  must(await api('POST', `/teams/${t.id}/members`, { token: coach.token, body: { user_id: child.id } }), 201);
  assert.equal((await api('GET', `/people/${child.id}/clearance`, { token: coach.token })).status, 409); // manager needs medical consent to see status
  assert.equal((await api('GET', `/people/${child.id}/clearance`, { token: parent.token })).status, 200);
  must(await allow(parent, child, 'medical'), 201);
  assert.equal((await api('GET', `/people/${child.id}/clearance`, { token: coach.token })).status, 200);
  must(await api('POST', '/medical/grants', { token: child.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', '/medical/records', { token: doc.token, body: { athlete_id: child.id, kind: 'checkup', summary: 'ok' } }), 201);
  must(await api('DELETE', `/youth/children/${child.id}/consents/medical`, { token: parent.token }));
  // records can no longer be added by the provider and new bookings are refused
  assert.equal((await api('POST', '/medical/records', { token: doc.token, body: { athlete_id: child.id, kind: 'checkup', summary: 'again' } })).status, 403);
  assert.equal((await api('POST', '/appointments', { token: child.token, body: { provider_id: doc.id, starts_at: new Date(Date.now() + 864e5).toISOString() } })).status, 409);
});

test('additional guardians need an existing guardian, policy limits apply, and exceptional review is recorded', async () => {
  const mum = await signup(); const dad = await signup(); const aunt = await signup(); const child = await kid(9);
  await verifiedGuardian(mum, child);
  const l = must(await api('POST', '/youth/guardian-links', { token: dad.token, body: { guardian_id: dad.id, child_id: child.id, relationship: 'parent' } }), 201);
  assert.equal(l.needs_existing_guardian_approval, true);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: dad.token, body: { evidence } }), 201);
  // cannot approve yourself or be approved by an outsider; admin refuses without co-guardian approval
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/approve`, { token: dad.token })).status, 403);
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/approve`, { token: aunt.token })).status, 404);
  const refused = await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Looks fine' } });
  assert.equal(refused.status, 409);
  must(await api('POST', `/youth/guardian-links/${l.id}/approve`, { token: mum.token }));
  const ok = must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Looks fine' } }));
  assert.equal(ok.status, 'active');
  assert.ok(ok.expires_at);
  // maximum of two verified guardians under the default policy
  assert.equal((await api('POST', '/youth/guardian-links', { token: aunt.token, body: { guardian_id: aunt.id, child_id: child.id } })).status, 409);
  // one guardian cannot end the other's authority; the platform team can, with history kept
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/revoke`, { token: mum.token, body: { reason: 'dispute' } })).status, 404); // not her link: she can't even see it, and raises a concern with support
  assert.equal((await api('POST', `/youth/guardian-links/${l.id}/revoke`, { token: child.token, body: { reason: 'dispute' } })).status, 403);
  must(await api('POST', `/youth/guardian-links/${l.id}/revoke`, { token: admin.token, body: { reason: 'Guardians in dispute, reviewed manually' } }));
  const events = (await pool.query('SELECT action FROM guardian_link_events WHERE link_id=$1 ORDER BY created_at, id', [l.id])).rows.map((r) => r.action);
  assert.deepEqual(events, ['request', 'accept', 'evidence', 'co_guardian_approved', 'approve', 'revoke']);
  // exceptional review: another adult without co-guardian approval, with a written reason
  const l2 = must(await api('POST', '/youth/guardian-links', { token: aunt.token, body: { guardian_id: aunt.id, child_id: child.id, relationship: 'legal_guardian' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l2.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l2.id}/evidence`, { token: aunt.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l2.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Court order seen', exceptional: true } }));
  assert.ok((await pool.query("SELECT 1 FROM guardian_link_events WHERE link_id=$1 AND action='approve_exceptional'", [l2.id])).rowCount);
  // concurrent identical requests produce exactly one open link
  const other = await signup(); const kid2 = await kid(10);
  const rs = await Promise.all([1, 2, 3].map(() => api('POST', '/youth/guardian-links', { token: other.token, body: { guardian_id: other.id, child_id: kid2.id } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
  // invalid input
  assert.equal((await api('POST', '/youth/guardian-links', { token: other.token, body: { guardian_id: other.id, child_id: 'nope' } })).status, 400);
  assert.equal((await api('POST', '/youth/guardian-links', { token: other.token, body: { guardian_id: other.id, child_id: other.id } })).status, 400);
});

test('a young person has no public profile and is not discoverable through any alternate path', async () => {
  const parent = await signup(); const child = await kid(11); const coach = await signup(['coach']); const stranger = await signup(['coach']);
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role) SELECT $1, id, 'athlete' FROM sports WHERE slug='football'", [child.id]);
  await verifiedGuardian(parent, child); must(await allow(parent, child, 'participation'), 201);
  const t = await team(coach);
  must(await api('POST', `/teams/${t.id}/members`, { token: coach.token, body: { user_id: child.id } }), 201);
  const leaks = (v) => JSON.stringify(v).includes(child.id) || JSON.stringify(v).includes(child.handle);

  assert.ok(!leaks(must(await api('GET', '/people', { query: { q: child.handle } }))));
  assert.ok(!leaks(must(await api('GET', '/people', { query: { q: 'Guard' } }))));
  assert.equal((await api('GET', `/people/${child.id}`)).status, 404);
  assert.equal((await api('GET', `/people/${child.id}`, { token: stranger.token })).status, 404);
  assert.ok(!leaks(must(await api('GET', `/teams/${t.id}`))));
  assert.equal(must(await api('GET', `/teams/${t.id}`)).members_restricted, 1);
  assert.ok(leaks(must(await api('GET', `/teams/${t.id}`, { token: coach.token }))), 'team managers see their consented members');
  assert.ok(!leaks(must(await api('GET', `/teams/${t.id}`, { token: stranger.token }))));
  assert.ok(!leaks(must(await api('GET', '/associations', { query: { target_type: 'team', target_id: t.id } }))));
  assert.ok(!leaks(must(await api('GET', '/associations', { query: { user_id: child.id } }))));
  assert.ok(!leaks(must(await api('GET', '/leaderboard'))));
  assert.ok(!leaks(must(await api('GET', '/feed'))));
  assert.ok(!leaks(must(await api('GET', '/coaches'))));
  // the limited profile is shown to self, guardians and the team's managers only
  for (const who of [child, parent, coach]) {
    const p = must(await api('GET', `/people/${child.id}`, { token: who.token }));
    assert.equal(p.restricted, true);
    assert.ok(!('bio' in p) && !('teams' in p) && !('sport_profiles' in p) && !('created_at' in p));
  }
  // same rules over MCP
  const search = await rpc('tools/call', { name: 'search_people', arguments: { q: child.handle } });
  assert.ok(!leaks(search.structuredContent ?? search.content));
  const person = await rpc('tools/call', { name: 'get_person', arguments: { id: child.id } });
  assert.equal(person.isError, true);
  const teamMcp = await rpc('tools/call', { name: 'get_team', arguments: { id: t.id } });
  assert.ok(!leaks(teamMcp.structuredContent ?? teamMcp.content));
  // check-in history (the only place a child's whereabouts are kept) is closed to everyone else
  must(await api('POST', `/youth/teams/${t.id}/check-ins`, { token: parent.token, body: { child_id: child.id, kind: 'drop_off' } }), 201);
  assert.equal((await api('GET', '/youth/check-ins', { token: stranger.token, query: { child_id: child.id } })).status, 404);
  assert.equal((await api('GET', '/youth/check-ins', { token: stranger.token, query: { team_id: t.id } })).status, 404);
  assert.equal((await api('GET', '/youth/check-ins', { query: { child_id: child.id } })).status, 401);
  assert.equal((await api('GET', '/youth/check-ins', { token: coach.token, query: { team_id: t.id } })).body.length, 1);
  // personal details never come back in the guardian views either
  assert.ok(!/dob|national_id|phone|address|email/.test(JSON.stringify(must(await api('GET', '/youth/guardian-links', { token: parent.token })))));
  // the derived date is not in any public or other-user response, only the child's own status
  assert.ok(!/youth_until/.test(JSON.stringify(must(await api('GET', `/people/${child.id}`, { token: parent.token })))));
  const mine = must(await api('GET', '/me/youth', { token: child.token }));
  assert.equal(mine.is_youth, true); assert.equal(mine.active_guardians, 1); assert.equal(mine.consents.participation, true); assert.equal(mine.consents.media, false);
  // becoming independent restores normal adult behaviour and ends guardian authority, with no cron needed
  await pool.query("UPDATE users SET youth_until = current_date - 1 WHERE id=$1", [child.id]);
  assert.equal((await api('GET', `/people/${child.id}`)).status, 200);
  assert.equal((await allow(parent, child, 'media')).status, 403);
  assert.equal(must(await api('GET', '/me/youth', { token: child.token })).is_youth, false);
});

test('pickup delegation and check-in: only authorised adults, idempotent, consent-gated, guardians notified', async () => {
  const parent = await signup(); const grandma = await signup(); const stranger = await signup(); const child = await kid(8); const coach = await signup(['coach']);
  await verifiedGuardian(parent, child); must(await allow(parent, child, 'participation'), 201);
  const t = await team(coach);
  must(await api('POST', `/teams/${t.id}/members`, { token: coach.token, body: { user_id: child.id } }), 201);
  const ci = (who, body) => api('POST', `/youth/teams/${t.id}/check-ins`, { token: who.token, body: { child_id: child.id, ...body } });

  assert.equal((await ci(stranger, { kind: 'drop_off' })).status, 404);
  const drop = must(await ci(coach, { kind: 'drop_off', idempotency_key: 'drop-key-0001' }), 201);
  // retries are safe, even concurrent ones
  const again = must(await ci(coach, { kind: 'drop_off', idempotency_key: 'drop-key-0001' }), 201);
  assert.equal(again.id, drop.id); assert.equal(again.replayed, true);
  assert.equal((await ci(parent, { kind: 'drop_off' })).status, 409); // already checked in
  // a coach must release to a guardian or current delegate, never just anyone
  assert.equal((await ci(coach, { kind: 'pickup' })).status, 400);
  assert.equal((await ci(coach, { kind: 'pickup', released_to_user_id: stranger.id })).status, 403);
  assert.equal((await ci(grandma, { kind: 'pickup' })).status, 404); // not authorised yet
  const d = must(await api('POST', `/youth/children/${child.id}/pickup-delegates`, { token: parent.token, body: { delegate_user_id: grandma.id, valid_days: 7 } }), 201);
  assert.equal((await api('POST', `/youth/children/${child.id}/pickup-delegates`, { token: parent.token, body: { delegate_user_id: (await kid()).id } })).status, 400); // pickup must be an adult
  assert.equal((await api('POST', `/youth/children/${child.id}/pickup-delegates`, { token: parent.token, body: {} })).status, 400);
  assert.equal((await api('POST', `/youth/children/${child.id}/pickup-delegates`, { token: parent.token, body: { delegate_user_id: grandma.id, valid_days: 400 } })).status, 400);
  assert.equal((await ci(grandma, { kind: 'drop_off' })).status, 404); // delegates collect, they do not drop off
  // revoke -> blocked at once; re-add -> works
  must(await api('DELETE', `/youth/pickup-delegates/${d.id}`, { token: parent.token }));
  assert.equal((await ci(grandma, { kind: 'pickup' })).status, 404);
  assert.equal((await api('DELETE', `/youth/pickup-delegates/${d.id}`, { token: stranger.token })).status, 404);
  must(await api('POST', `/youth/children/${child.id}/pickup-delegates`, { token: parent.token, body: { delegate_user_id: grandma.id, delegate_name: 'Grandma Rose' } }), 201);
  const listed = must(await api('GET', `/youth/children/${child.id}/pickup-delegates`, { token: parent.token }));
  assert.equal(listed[0].delegate_name, 'Grandma Rose'); assert.equal(listed[0].active, true); assert.equal(listed[1].active, false);
  assert.ok(!(await pool.query('SELECT delegate_name_enc FROM pickup_delegates WHERE delegate_name_enc IS NOT NULL')).rows[0].delegate_name_enc.includes('Rose'));
  assert.equal((await api('GET', `/youth/children/${child.id}/pickup-delegates`, { token: coach.token })).status, 404);
  // consent withdrawn -> no new check-ins
  must(await api('DELETE', `/youth/children/${child.id}/consents/participation`, { token: parent.token }));
  assert.equal((await ci(grandma, { kind: 'pickup' })).status, 409);
  must(await allow(parent, child, 'participation'), 201);
  const pick = must(await ci(grandma, { kind: 'pickup' }), 201);
  assert.equal(pick.released_to_user_id, grandma.id); assert.ok(pick.delegate_id);
  assert.equal((await ci(grandma, { kind: 'pickup' })).status, 409); // not checked in any more
  // parent was notified of each; the delegate got their own notification
  const notes = (await pool.query("SELECT kind FROM notifications WHERE user_id=$1 AND kind='youth_checkin'", [parent.id])).rows;
  assert.equal(notes.length, 2);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='pickup_delegate'", [grandma.id])).rowCount);
  const hist = must(await api('GET', '/youth/check-ins', { token: parent.token, query: { child_id: child.id } }));
  assert.deepEqual(hist.map((h) => h.kind), ['pickup', 'drop_off']);
  // an expired delegation does nothing
  must(await ci(parent, { kind: 'drop_off' }), 201);
  await pool.query("UPDATE pickup_delegates SET valid_from = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE delegate_user_id=$1", [grandma.id]);
  assert.equal((await ci(grandma, { kind: 'pickup' })).status, 404);
  // check-in rows cannot be rewritten
  await assert.rejects(pool.query('DELETE FROM youth_checkins'), /append-only/);
});

test('age policy is versioned and jurisdiction-configurable; existing accounts are evaluated without losing data', async () => {
  const p = must(await api('GET', '/youth/policy'));
  assert.equal(p.independent_age, 18); assert.equal(p.version, 1);
  const normal = await signup();
  assert.equal((await api('POST', '/youth/policy', { token: normal.token, body: { jurisdiction: 'in', independent_age: 18 } })).status, 403);
  assert.equal((await api('POST', '/youth/policy', { token: admin.token, body: { jurisdiction: 'in', independent_age: 9 } })).status, 400);
  assert.equal((await api('POST', '/youth/policy', { token: admin.token, body: { jurisdiction: 'Bad Name', independent_age: 18 } })).status, 400);
  // a 17-year-old is youth under 18, adult under a policy with independence at 16
  const teen = await kid(17);
  assert.equal(must(await api('GET', '/me/youth', { token: teen.token })).is_youth, true);
  const v2 = must(await api('POST', '/youth/policy', { token: admin.token, body: { jurisdiction: 'lowage', independent_age: 16, notes: 'Example operator policy' } }), 201);
  assert.equal(v2.version, 1);
  must(await api('PATCH', `/youth/users/${teen.id}/jurisdiction`, { token: admin.token, body: { jurisdiction: 'lowage', reason: 'Resident of lowage, manual review' } }));
  assert.equal(must(await api('GET', '/me/youth', { token: teen.token })).is_youth, false);
  const v3 = must(await api('POST', '/youth/policy', { token: admin.token, body: { jurisdiction: 'default', independent_age: 18, max_guardians: 3 } }), 201);
  assert.equal(v3.version, 2); assert.equal(must(await api('GET', '/youth/policy')).max_guardians, 3);
  // the DOB itself stays encrypted, and the derivation of youth status is audit-logged
  const raw = (await pool.query('SELECT dob_enc FROM users WHERE id=$1', [teen.id])).rows[0].dob_enc;
  assert.ok(raw.startsWith('v1.') && !raw.includes(yearsAgo(17)));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='derive_youth_status' AND entity_id=$1", [teen.id])).rowCount);
  // backfill: an account created before this feature (DOB, never evaluated) is evaluated, nothing else changes
  const old = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx,dob_enc,bio) VALUES ('gd_old','Old account','{athlete}','x','x','gd_old',$1,'kept') RETURNING id", [encrypt(yearsAgo(10), 'users.dob')])).rows[0];
  assert.equal((await pool.query('SELECT youth_until FROM users WHERE id=$1', [old.id])).rows[0].youth_until, null);
  assert.ok(await backfillYouth() >= 1);
  const after = (await pool.query('SELECT youth_until, bio FROM users WHERE id=$1', [old.id])).rows[0];
  assert.ok(after.youth_until > new Date()); assert.equal(after.bio, 'kept');
  assert.equal(await backfillYouth(), 0, 'backfill is idempotent');
  // accounts without a date of birth are not blocked or changed
  const nodob = await signup();
  assert.equal(must(await api('GET', '/me/youth', { token: nodob.token })).is_youth, false);
});

test('family links can be started by exact handle from either side (young people are not searchable)', async () => {
  const parent = await signup(); const child = await kid(13); const parent2 = await signup();
  assert.equal((await api('POST', '/youth/guardian-links', { token: parent.token, body: { handle: child.handle } })).status, 400); // which side?
  assert.equal((await api('POST', '/youth/guardian-links', { token: parent.token, body: { handle: 'nobody_here', as: 'guardian' } })).status, 404);
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { handle: `@${child.handle}`, as: 'guardian' } }), 201);
  assert.equal(l.guardian_id, parent.id); assert.equal(l.child_id, child.id);
  const l2 = must(await api('POST', '/youth/guardian-links', { token: child.token, body: { handle: parent2.handle, as: 'child', relationship: 'foster_carer' } }), 201);
  assert.equal(l2.guardian_id, parent2.id); assert.equal(l2.relationship, 'foster_carer');
  const mine = must(await api('GET', '/youth/guardian-links', { token: child.token }));
  assert.equal(mine.length, 2); assert.ok(mine.every((x) => x.my_side === 'child'));
  // pickup delegate by handle
  const parent3 = await signup(); const kid3 = await kid(7);
  await verifiedGuardian(parent3, kid3);
  const d = must(await api('POST', `/youth/children/${kid3.id}/pickup-delegates`, { token: parent3.token, body: { delegate_handle: parent.handle } }), 201);
  assert.equal(d.delegate_user_id, parent.id);
});
