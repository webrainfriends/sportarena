import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { decrypt } = await import('../src/crypto.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles, extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `user_${n}_${roles[0]}`, display_name: `User ${n}`, email: `u${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const inFuture = (days, hour = 10) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('personal identification data is encrypted at rest and decrypts for its owner only', async () => {
  const u = await signup(['athlete'], { full_name: 'Priya Sharma', phone: '+91 98765 43210', national_id: 'ABCDE1234F', dob: '2001-04-09', address: '12 MG Road, Pune' });
  const { rows: [raw] } = await pool.query('SELECT * FROM users WHERE id=$1', [u.id]);
  const blob = JSON.stringify(raw);
  for (const secret of ['Priya', '98765', 'ABCDE1234F', '2001-04-09', 'MG Road', 'u1@example.com']) assert.ok(!blob.includes(secret), `${secret} leaked into the DB row`);
  assert.match(raw.phone_enc, /^v1\./);
  assert.equal(decrypt(raw.phone_enc, 'users.phone'), '+91 98765 43210');
  assert.throws(() => decrypt(raw.phone_enc, 'users.national_id'), 'ciphertext is bound to its column');
  const me = await api('GET', '/me', { token: u.token });
  assert.equal(me.body.national_id, 'ABCDE1234F');
  assert.equal(me.body.email, 'u1@example.com');
  const pub = await api('GET', `/people/${u.id}`);
  assert.ok(!JSON.stringify(pub.body).match(/ABCDE|98765|example\.com/), 'public profile exposes no PII');
  const log = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND actor_id=$1", [u.id]);
  assert.equal(log.rows[0].n, 1);
});

test('auth, API tokens, role gating', async () => {
  assert.equal((await api('GET', '/me')).status, 401);
  const a = await signup(['athlete']);
  assert.equal((await api('POST', '/events', { token: a.token, body: { name: 'Nope Cup', sport: 'football' } })).status, 403);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'whatever-whatever' } })).status, 401);
  const login = await api('POST', '/auth/login', { body: { email: 'U2@example.com', password: 'correct-horse-battery' } });
  assert.equal(login.status, 200);
  const tok = await api('POST', '/me/tokens', { token: a.token, body: { name: 'agent' } });
  assert.match(tok.body.token, /^sa_/);
  assert.equal((await api('GET', '/me', { token: tok.body.token })).body.id, a.id);
  await api('DELETE', `/me/tokens/${tok.body.id}`, { token: a.token });
  assert.equal((await api('GET', '/me', { token: tok.body.token })).status, 401);
  assert.equal((await api('POST', '/auth/register', { body: { handle: 'x', display_name: 'x', email: 'bad', password: 'short' } })).status, 400);
  assert.equal((await api('POST', '/auth/register', { body: { handle: 'adminx', display_name: 'x', email: 'a@b.co', password: 'long-enough-pw', roles: ['admin'] } })).status, 400, 'cannot self-register as admin');
});

test('tournament lifecycle: entries → round robin → results → standings → podium awards', async () => {
  const org = await signup(['organizer']);
  const captains = await Promise.all([1, 2, 3].map(() => signup(['athlete'])));
  const teams = [];
  for (const [i, c] of captains.entries()) teams.push((await api('POST', '/teams', { token: c.token, body: { name: `Team ${i}`, sport: 'football' } })).body);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'Gen Z Cup', sport: 'football' } })).body;
  for (const [i, c] of captains.entries()) {
    const e = await api('POST', `/events/${ev.id}/entries`, { token: c.token, body: { team_id: teams[i].id } });
    assert.equal(e.status, 201);
    assert.equal((await api('PATCH', `/entries/${e.body.id}`, { token: c.token, body: { status: 'accepted' } })).status, 403, 'teams cannot self-accept');
    assert.equal((await api('PATCH', `/entries/${e.body.id}`, { token: org.token, body: { status: 'accepted' } })).status, 200);
  }
  assert.equal((await api('POST', `/events/${ev.id}/entries`, { token: captains[0].token, body: { team_id: teams[0].id } })).status, 409);
  const rr = await api('POST', `/events/${ev.id}/schedule/round-robin`, { token: org.token, body: { first_round_at: inFuture(3) } });
  assert.equal(rr.body.created, 3);
  const fx = (await api('GET', `/fixtures?event_id=${ev.id}`)).body;
  // team 0 wins both, team 1 beats team 2
  const win = (f, winner) => api('POST', `/fixtures/${f.id}/result`, { token: org.token, body: winner === f.home_team_id ? { home_score: 2, away_score: 0 } : { home_score: 0, away_score: 2 } });
  for (const f of fx) {
    const w = [f.home_team_id, f.away_team_id].includes(teams[0].id) ? teams[0].id : teams[1].id;
    assert.equal((await win(f, w)).status, 200);
  }
  assert.equal((await api('POST', `/fixtures/${fx[0].id}/result`, { token: captains[0].token, body: { home_score: 9, away_score: 9 } })).status, 403);
  const table = (await api('GET', `/events/${ev.id}/standings`)).body;
  assert.deepEqual(table.map((r) => [r.name, r.points]), [['Team 0', 6], ['Team 1', 3], ['Team 2', 0]]);
  const done = await api('POST', `/events/${ev.id}/complete`, { token: org.token });
  assert.deepEqual(done.body.awards.map((a) => a.kind), ['cup', 'medal_silver', 'medal_bronze']);
  const team0 = await api('GET', `/teams/${teams[0].id}`);
  assert.equal(team0.body.awards[0].kind, 'cup');
});

test('bookings never oversell: parallel requests for one court, pooled equipment', async () => {
  const mgr = await signup(['venue_manager']);
  const v = (await api('POST', '/venues', { token: mgr.token, body: { name: 'Arena One', city: 'Pune' } })).body;
  const court = (await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'basketball', hourly_rate_cents: 50000 } })).body;
  const balls = (await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'equipment', name: 'Ball pool', capacity: 5 } })).body;
  const users = await Promise.all(Array.from({ length: 8 }, () => signup(['athlete'])));
  const slot = { resource_id: court.id, starts_at: inFuture(2, 10), ends_at: inFuture(2, 12) };
  const results = await Promise.all(users.map((u) => api('POST', '/bookings', { token: u.token, body: slot })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
  assert.equal(results.find((r) => r.status === 201).body.price_cents, 100000);
  assert.equal((await api('POST', '/bookings', { token: users[0].token, body: { ...slot, starts_at: inFuture(2, 12), ends_at: inFuture(2, 13) } })).status, 201, 'back-to-back is fine');
  const eq = { resource_id: balls.id, starts_at: inFuture(2, 10), ends_at: inFuture(2, 11) };
  assert.equal((await api('POST', '/bookings', { token: users[1].token, body: { ...eq, quantity: 3 } })).status, 201);
  assert.equal((await api('POST', '/bookings', { token: users[2].token, body: { ...eq, quantity: 3 } })).status, 409);
  assert.equal((await api('POST', '/bookings', { token: users[2].token, body: { ...eq, quantity: 2 } })).status, 201);
  const av = await api('GET', `/resources/${balls.id}/availability?from=${eq.starts_at}&to=${eq.ends_at}`);
  assert.equal(av.body.free, 0);
  assert.equal((await api('POST', `/venues/${v.id}/resources`, { token: users[0].token, body: { kind: 'court', name: 'x' } })).status, 403);
});

test('fixture scheduling books the court and rejects referee/team clashes', async () => {
  const org = await signup(['organizer']);
  const ref = await signup(['referee']);
  await api('POST', '/me/sport-profiles', { token: ref.token, body: { sport: 'basketball', role: 'referee', license_no: 'REF-0042' } });
  const { rows: [p] } = await pool.query('SELECT license_no_enc FROM sport_profiles WHERE user_id=$1', [ref.id]);
  assert.ok(!p.license_no_enc.includes('REF-0042'));
  const caps = await Promise.all([signup(['athlete']), signup(['athlete'])]);
  const teams = await Promise.all(caps.map(async (c, i) => (await api('POST', '/teams', { token: c.token, body: { name: `Hoopers ${i}`, sport: 'basketball' } })).body));
  const mgr = await signup(['venue_manager']);
  const v = (await api('POST', '/venues', { token: mgr.token, body: { name: 'Dome' } })).body;
  const court = (await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Centre', sport: 'basketball' } })).body;
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'Hoop Fest', sport: 'basketball' } })).body;
  for (const [i, c] of caps.entries()) {
    const e = await api('POST', `/events/${ev.id}/entries`, { token: c.token, body: { team_id: teams[i].id } });
    await api('PATCH', `/entries/${e.body.id}`, { token: org.token, body: { status: 'accepted' } });
  }
  const f = { home_team_id: teams[0].id, away_team_id: teams[1].id, scheduled_at: inFuture(5, 15), resource_id: court.id, referee_id: ref.id };
  assert.equal((await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: f })).status, 201);
  assert.equal((await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { ...f, referee_id: undefined } })).status, 409, 'court (and teams) are taken');
  const outsider = await signup(['organizer']);
  assert.equal((await api('POST', `/events/${ev.id}/fixtures`, { token: outsider.token, body: f })).status, 403);
  // assigned referee may record the result and individual scores
  const fx = (await api('GET', `/fixtures?event_id=${ev.id}`)).body[0];
  assert.equal((await api('POST', `/fixtures/${fx.id}/result`, { token: ref.token, body: { home_score: 80, away_score: 75 } })).status, 200);
  const perf = await api('POST', '/performances', { token: ref.token, body: { user_id: caps[0].id, sport: 'basketball', metric: 'points', value: 31, points: 5, fixture_id: fx.id } });
  assert.equal(perf.status, 201);
  assert.equal((await api('POST', '/performances', { token: caps[1].token, body: { user_id: caps[0].id, sport: 'basketball', metric: 'points', value: 99 } })).status, 403);
  assert.equal((await api('POST', '/performances', { token: caps[0].token, body: { sport: 'basketball', metric: 'points', value: 12, points: 1 } })).status, 201, 'self-logged practice');
  const lb = (await api('GET', '/leaderboard?sport=basketball')).body;
  assert.equal(lb[0].id, caps[0].id);
  assert.equal(lb[0].points, 6);
  assert.equal((await api('GET', `/people/${caps[0].id}/stats`)).body.by_metric[0].best, 31);
});

test('health data needs athlete consent, is encrypted, and consent is revocable', async () => {
  const athlete = await signup(['athlete']);
  const doc = await signup(['doctor']);
  const stranger = await signup(['doctor']);
  for (const d of [doc, stranger]) await api('POST', '/me/sport-profiles', { token: d.token, body: { sport: 'football', role: 'doctor' } });
  const rec = { athlete_id: athlete.id, kind: 'injury', clearance: 'restricted', summary: 'Grade 2 ankle sprain', details: 'Left ATFL, 3 weeks rehab' };
  assert.equal((await api('POST', '/medical/records', { token: doc.token, body: rec })).status, 403, 'no consent yet');
  await api('POST', '/medical/grants', { token: athlete.token, body: { provider_id: doc.id } });
  assert.equal((await api('POST', '/medical/records', { token: doc.token, body: rec })).status, 201);
  const { rows: [raw] } = await pool.query('SELECT * FROM medical_records WHERE athlete_id=$1', [athlete.id]);
  assert.ok(!JSON.stringify(raw).includes('ankle'));
  assert.equal((await api('GET', `/medical/records?athlete_id=${athlete.id}`, { token: stranger.token })).status, 403);
  assert.equal((await api('GET', `/medical/records?athlete_id=${athlete.id}`, { token: doc.token })).body[0].summary, 'Grade 2 ankle sprain');
  assert.equal((await api('GET', '/medical/records', { token: athlete.token })).body[0].details, 'Left ATFL, 3 weeks rehab');
  assert.equal((await api('GET', `/people/${athlete.id}/clearance`, { token: doc.token })).body.status, 'restricted');
  assert.equal((await api('GET', `/people/${athlete.id}/clearance`, { token: stranger.token })).status, 403);
  await api('DELETE', `/medical/grants/${doc.id}`, { token: athlete.token });
  assert.equal((await api('GET', `/medical/records?athlete_id=${athlete.id}`, { token: doc.token })).status, 403);
  const appt = await api('POST', '/appointments', { token: athlete.token, body: { provider_id: doc.id, starts_at: inFuture(4), reason: 'knee pain' } });
  assert.equal(appt.status, 201);
  assert.equal((await api('POST', '/appointments', { token: athlete.token, body: { provider_id: doc.id, starts_at: inFuture(4) } })).status, 409);
  assert.equal((await api('GET', '/appointments', { token: doc.token })).body[0].reason, 'knee pain');
});

test('insurance: buy, mask policy numbers, claim limits; sponsors; supply chain; testimonials', async () => {
  const admin = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('root','Root','{admin}','x','x','adminidx') RETURNING id")).rows[0];
  const { signToken } = await import('../src/auth.js');
  const adminTok = await signToken({ id: admin.id, roles: ['admin'] });
  const plan = (await api('POST', '/insurance/plans', { token: adminTok, body: { name: 'Player Shield', insurer: 'SafeSport', cover_for: 'individual', premium_cents: 49900, coverage_cents: 500000 } })).body;
  const u = await signup(['athlete']);
  assert.equal((await api('POST', '/insurance/plans', { token: u.token, body: {} })).status, 403);
  const pol = (await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: plan.id, beneficiary: 'Mum Sharma' } })).body;
  assert.match(pol.policy_no, /^••••/);
  const { rows: [raw] } = await pool.query('SELECT * FROM insurance_policies WHERE id=$1', [pol.id]);
  assert.ok(!JSON.stringify(raw).includes('Mum') && !JSON.stringify(raw).includes('SA-'));
  const full = (await api('GET', `/insurance/policies/${pol.id}`, { token: u.token })).body;
  assert.match(full.policy_no, /^SA-[0-9A-F]{10}$/);
  assert.equal(full.beneficiary, 'Mum Sharma');
  assert.equal((await api('GET', `/insurance/policies/${pol.id}`, { token: (await signup(['athlete'])).token })).status, 403);
  assert.equal((await api('POST', `/insurance/policies/${pol.id}/claims`, { token: u.token, body: { description: 'Broken wrist', amount_cents: 600000 } })).status, 400);
  const claim = await api('POST', `/insurance/policies/${pol.id}/claims`, { token: u.token, body: { description: 'Broken wrist', amount_cents: 120000 } });
  assert.equal(claim.status, 201);
  assert.equal((await api('PATCH', `/insurance/claims/${claim.body.id}`, { token: adminTok, body: { status: 'approved' } })).body.status, 'approved');
  // team cover requires managing the team
  const teamPlan = (await api('POST', '/insurance/plans', { token: adminTok, body: { name: 'Squad Cover', insurer: 'SafeSport', cover_for: 'team', premium_cents: 99900, coverage_cents: 2000000 } })).body;
  const team = (await api('POST', '/teams', { token: u.token, body: { name: 'Insured FC', sport: 'football' } })).body;
  assert.equal((await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: teamPlan.id, subject_id: team.id } })).status, 201);
  assert.equal((await api('POST', '/insurance/policies', { token: (await signup(['athlete'])).token, body: { plan_id: teamPlan.id, subject_id: team.id } })).status, 403);

  // sponsors
  const sp = await signup(['sponsor']);
  const org = await signup(['organizer']);
  const brand = (await api('POST', '/sponsors', { token: sp.token, body: { name: 'VoltDrink', contact_email: 'deals@volt.example', contact_phone: '+1 555 0100' } })).body;
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'Volt Open', sport: 'tennis' } })).body;
  const deal = (await api('POST', '/sponsorships', { token: sp.token, body: { sponsor_id: brand.id, target_type: 'event', target_id: ev.id, amount_cents: 5000000 } })).body;
  assert.equal((await api('PATCH', `/sponsorships/${deal.id}`, { token: sp.token, body: { status: 'active' } })).status, 403, 'sponsor cannot accept own offer');
  assert.equal((await api('PATCH', `/sponsorships/${deal.id}`, { token: org.token, body: { status: 'active' } })).status, 200);
  assert.equal((await api('GET', `/events/${ev.id}`)).body.sponsors[0].name, 'VoltDrink');
  assert.equal((await api('GET', `/sponsors/${brand.id}`)).body.contact_email, undefined, 'contacts hidden from public');
  assert.equal((await api('GET', `/sponsors/${brand.id}`, { token: sp.token })).body.contact_email, 'deals@volt.example');

  // supply chain
  const item = (await api('POST', '/inventory', { token: org.token, body: { name: 'Match balls', quantity: 2, reorder_level: 5 } })).body;
  assert.equal((await api('GET', '/inventory?low_stock=true', { token: org.token })).body.length, 1);
  assert.equal((await api('POST', `/inventory/${item.id}/adjust`, { token: org.token, body: { delta: -3 } })).status, 409);
  const order = (await api('POST', '/supply-orders', { token: org.token, body: { item_id: item.id, supplier: 'Nivia', quantity: 20 } })).body;
  await api('PATCH', `/supply-orders/${order.id}`, { token: org.token, body: { status: 'received' } });
  assert.equal((await api('GET', '/inventory', { token: org.token })).body[0].quantity, 22);
  assert.equal((await api('PATCH', `/supply-orders/${order.id}`, { token: org.token, body: { status: 'received' } })).status, 409, 'cannot receive twice');

  // testimonials
  const fan = await signup(['athlete']);
  assert.equal((await api('POST', '/testimonials', { token: fan.token, body: { subject_type: 'event', subject_id: ev.id, rating: 5, body: 'Unreal vibes!' } })).status, 201);
  await api('POST', '/testimonials', { token: fan.token, body: { subject_type: 'event', subject_id: ev.id, rating: 4, body: 'Still great' } });
  const t = (await api('GET', `/testimonials?subject_type=event&subject_id=${ev.id}`)).body;
  assert.equal(t.n, 1); assert.equal(t.avg, 4);
  assert.equal((await api('POST', '/testimonials', { token: fan.token, body: { subject_type: 'user', subject_id: fan.id, rating: 5, body: 'I am great' } })).status, 400);
  const dash = (await api('GET', '/dashboard', { token: u.token })).body;
  assert.equal(dash.active_policies, 2);
});

test('MCP: same capabilities as REST, same auth rules', async () => {
  const rpc = async (method, params, token) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()).result;
  };
  const tools = (await rpc('tools/list', {})).tools;
  assert.equal(tools.length, capabilities.length);
  assert.ok(tools.find((t) => t.name === 'create_booking').inputSchema.properties.resource_id);
  const pub = await rpc('tools/call', { name: 'list_sports', arguments: {} });
  assert.ok(pub.structuredContent.result.length >= 100 && pub.structuredContent.result.some((s) => s.slug === 'basketball'));
  const slugs = new Set(pub.structuredContent.result.map((s) => s.slug));
  for (const slug of ['judo', 'curling', 'sepak-takraw', 'diving', 'weightlifting', 'biathlon', 'kabaddi', 'table-tennis']) assert.ok(slugs.has(slug), `${slug} missing from the catalogue`);
  const winter = await rpc('tools/call', { name: 'list_sports', arguments: { programme: 'olympic_winter' } });
  assert.ok(winter.structuredContent.result.some((s) => s.slug === 'curling') && !winter.structuredContent.result.some((s) => s.slug === 'judo'));
  const anon = await rpc('tools/call', { name: 'get_me', arguments: {} });
  assert.equal(anon.isError, true);
  assert.equal(JSON.parse(anon.content[0].text).code, 'unauthorized');
  const u = await signup(['athlete']);
  const me = await rpc('tools/call', { name: 'get_me', arguments: {} }, u.token);
  assert.equal(me.structuredContent.result.id, u.id);
  const bad = await rpc('tools/call', { name: 'create_team', arguments: { name: 'x' } }, u.token);
  assert.equal(bad.isError, true);
  const openapi = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.equal(Object.values(openapi.paths).flatMap(Object.values).length, capabilities.length);
});

test('player module: default sport profile lists first; matches log + bulk import', async () => {
  const p = await signup(['athlete']);
  const other = await signup(['athlete']);
  const prof = (sport, extra = {}) => api('POST', '/me/sport-profiles', { token: p.token, body: { sport, role: 'athlete', ...extra } });

  const a = await prof('football', { position: 'Striker', jersey_no: 9, club: 'Neon FC', experience_years: 4 });
  assert.equal(a.status, 201);
  assert.equal(a.body.is_default, true, 'first profile becomes the default');
  const b = await prof('cricket');
  assert.equal(b.body.is_default, false);

  let cards = (await api('GET', '/me/sport-profiles', { token: p.token })).body;
  assert.deepEqual(cards.map((x) => x.sport_slug), ['football', 'cricket']);
  assert.equal(cards[0].jersey_no, 9);
  assert.equal(cards[0].summary.matches, 0);

  // make cricket the default -> it jumps to the front, exactly one default
  assert.equal((await api('POST', `/me/sport-profiles/${b.body.id}/default`, { token: p.token })).status, 200);
  cards = (await api('GET', '/me/sport-profiles', { token: p.token })).body;
  assert.deepEqual(cards.map((x) => [x.sport_slug, x.is_default]), [['cricket', true], ['football', false]]);
  assert.equal((await api('POST', `/me/sport-profiles/${a.body.id}/default`, { token: other.token })).status, 404, "cannot touch someone else's profile");
  assert.equal((await api('PATCH', `/me/sport-profiles/${a.body.id}`, { token: p.token, body: { club: 'Pixel FC', level: 'semi_pro' } })).status, 200);

  // manual match
  const m = await api('POST', '/me/matches', { token: p.token, body: { sport_profile_id: a.body.id, played_on: '2026-09-01', opponent: 'Rivals', score_for: 3, score_against: 1, rating: 8.5, minutes: 90, stats: { goals: 2, assists: 1 } } });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await api('POST', '/me/matches', { token: p.token, body: { sport_profile_id: a.body.id, played_on: '2026-09-01' } })).status, 201);
  assert.equal((await api('POST', '/me/matches', { token: other.token, body: { sport_profile_id: a.body.id, played_on: '2026-09-01' } })).status, 404);

  // bulk import: dry run, then real, then idempotent re-import
  const csv = 'Played On,Opponent,Competition,Result,Score For,Score Against,Minutes,Rating,Goals,Assists\n'
    + '2026-09-08,"Blue, Stars",League,W,2,0,90,7.5,1,1\n'
    + '2026-09-15,Red Hawks,League,,1,1,75,6,0,0\n'
    + '2026-09-22,Green Gulls,Cup,loss,0,2,90,5,0,0\n';
  const imp = (body) => api('POST', '/me/matches/import', { token: p.token, body: { sport_profile_id: a.body.id, ...body } });
  const dry = await imp({ csv, dry_run: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.importable, 3);
  assert.equal(dry.body.preview[0].opponent, 'Blue, Stars');
  assert.equal(dry.body.preview[1].result, 'draw', 'result inferred from score');
  assert.equal((await api('GET', '/me/matches', { token: p.token })).body.length, 2, 'dry run writes nothing');

  const bad = await imp({ csv: 'played_on,rating,goals\n2026-09-30,11,x\nnot-a-date,5,1\n' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.details.length, 2, 'row-level errors reported');
  assert.equal((await api('GET', '/me/matches', { token: p.token })).body.length, 2, 'all-or-nothing');

  const done = await imp({ csv });
  assert.equal(done.body.imported, 3);
  const again = await imp({ csv });
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.skipped, 3);
  assert.equal((await imp({ rows: [{ played_on: '2026-10-01', opponent: 'JSON FC', goals: 4 }] })).body.imported, 1);
  assert.equal((await api('POST', '/me/matches/import', { token: other.token, body: { sport_profile_id: a.body.id, csv } })).status, 404);

  cards = (await api('GET', '/me/sport-profiles', { token: p.token })).body;
  const foot = cards.find((x) => x.sport_slug === 'football');
  assert.equal(foot.summary.matches, 6);
  assert.equal(foot.summary.wins, 2);
  assert.equal(foot.summary.draws, 1);
  assert.equal(foot.summary.losses, 1);
  assert.equal(foot.metrics.find((x) => x.metric === 'goals').total, 7);
  assert.equal(foot.metrics.find((x) => x.metric === 'goals').best, 4);
  assert.equal(foot.form[0], null, 'newest match (no result) first');

  // deleting the default promotes the next profile; matches go with the profile
  const list = (await api('GET', '/me/matches', { token: p.token, })).body;
  assert.equal((await api('DELETE', `/me/matches/${list[0].id}`, { token: p.token })).status, 200);
  assert.equal((await api('DELETE', `/me/sport-profiles/${b.body.id}`, { token: p.token })).status, 200);
  cards = (await api('GET', '/me/sport-profiles', { token: p.token })).body;
  assert.deepEqual(cards.map((x) => [x.sport_slug, x.is_default]), [['football', true]]);

  const pub = await api('GET', `/people/${p.id}`);
  assert.ok(!JSON.stringify(pub.body).includes('Rivals'), 'match log is private to the player');
});

test('player marketplace: billboard, shop, coach hire', async () => {
  const org = await signup(['athlete']);
  const joiner = await signup(['athlete']);
  const sponsor = await signup(['sponsor']);
  const supplier = await signup(['supplier']);
  const coach = await signup(['coach']);
  const t = (u) => ({ token: u.token });

  // billboard: team recruiting adds the accepted player to the roster; post fills up
  const team = (await api('POST', '/teams', { ...t(org), body: { name: 'Board FC', sport: 'football' } })).body;
  const post = await api('POST', '/billboard', { ...t(org), body: { kind: 'team_recruiting', title: 'Need a keeper', sport: 'football', team_id: team.id, positions_needed: 1 } });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.equal((await api('POST', '/billboard', { ...t(joiner), body: { kind: 'sponsor_call', title: 'Sponsor wanted athletes' } })).status, 403, 'only sponsors post sponsor calls');
  assert.equal((await api('POST', '/billboard', { ...t(joiner), body: { kind: 'team_recruiting', title: 'Not my team', team_id: team.id } })).status, 403);
  const listed = (await api('GET', '/billboard?kind=team_recruiting', { ...t(joiner) })).body;
  assert.equal(listed[0].id, post.body.id);
  assert.equal(listed[0].my_response, null);
  assert.equal((await api('POST', `/billboard/${post.body.id}/responses`, { ...t(org), body: {} })).status, 400, 'no self-response');
  const resp = await api('POST', `/billboard/${post.body.id}/responses`, { ...t(joiner), body: { message: 'I play in goal' } });
  assert.equal(resp.status, 201);
  assert.equal((await api('POST', `/billboard/${post.body.id}/responses`, { ...t(joiner), body: {} })).status, 409);
  assert.equal((await api('GET', `/billboard/${post.body.id}/responses`, { ...t(joiner) })).status, 403);
  const rs = (await api('GET', `/billboard/${post.body.id}/responses`, { ...t(org) })).body;
  assert.equal(rs[0].response_id, resp.body.id);
  assert.equal((await api('PATCH', `/billboard/responses/${resp.body.id}`, { ...t(joiner), body: { status: 'accepted' } })).status, 403);
  assert.equal((await api('PATCH', `/billboard/responses/${resp.body.id}`, { ...t(org), body: { status: 'accepted' } })).status, 200);
  const roster = (await api('GET', `/teams/${team.id}`)).body;
  assert.ok(JSON.stringify(roster).includes(joiner.id), 'accepted player joined the roster');
  assert.equal((await api('GET', '/billboard?kind=team_recruiting')).body.length, 0, 'filled posts leave the board');
  assert.equal((await api('GET', '/me/billboard-responses', { ...t(joiner) })).body[0].response_status, 'accepted');
  const sp = await api('POST', '/billboard', { ...t(org), body: { kind: 'sponsorship_wanted', title: 'Seeking kit sponsor' } });
  assert.equal((await api('POST', `/billboard/${sp.body.id}/responses`, { ...t(joiner), body: {} })).status, 403, 'only sponsors answer sponsorship requests');
  assert.equal((await api('POST', `/billboard/${sp.body.id}/responses`, { ...t(sponsor), body: {} })).status, 201);

  // shop
  assert.equal((await api('POST', '/shop/products', { ...t(joiner), body: { name: 'Ball', price_cents: 1000 } })).status, 403);
  const prod = (await api('POST', '/shop/products', { ...t(supplier), body: { name: 'Match ball', category: 'equipment', sport: 'football', price_cents: 150000, stock: 3 } })).body;
  assert.equal((await api('GET', '/shop/products?sport=football&q=ball')).body[0].id, prod.id);
  const buy = (q) => api('POST', '/shop/orders', { ...t(joiner), body: { product_id: prod.id, quantity: q, ship_to: '12 MG Road, Pune' } });
  assert.equal((await buy(5)).status, 409, 'cannot oversell');
  const order = await buy(2);
  assert.equal(order.status, 201);
  assert.equal(order.body.total_cents, 300000);
  assert.equal((await buy(2)).status, 409);
  const { rows: [raw] } = await pool.query('SELECT * FROM shop_orders WHERE id=$1', [order.body.id]);
  assert.ok(!JSON.stringify(raw).includes('MG Road'), 'delivery address encrypted at rest');
  assert.equal((await api('GET', '/shop/orders', { ...t(joiner) })).body[0].ship_to, '12 MG Road, Pune');
  assert.equal((await api('GET', '/shop/sales', { ...t(supplier) })).body.length, 1);
  assert.equal((await api('PATCH', `/shop/orders/${order.body.id}`, { ...t(joiner), body: { status: 'shipped' } })).status, 403);
  assert.equal((await api('PATCH', `/shop/orders/${order.body.id}`, { ...t(joiner), body: { status: 'cancelled' } })).status, 200);
  assert.equal((await api('GET', '/shop/products')).body.find((p) => p.id === prod.id).stock, 3, 'cancel restocks');
  assert.equal((await api('PATCH', `/shop/orders/${order.body.id}`, { ...t(supplier), body: { status: 'shipped' } })).status, 409);

  // hire a coach
  assert.equal((await api('POST', '/me/sport-profiles', { ...t(coach), body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 80000 } })).status, 201);
  const found = (await api('GET', '/coaches?sport=football')).body.find((x) => x.id === coach.id);
  assert.equal(found.hourly_rate_cents, 80000);
  const at = inFuture(4, 9);
  const hire = await api('POST', '/hires', { ...t(joiner), body: { coach_id: coach.id, sport: 'football', starts_at: at, duration_min: 90 } });
  assert.equal(hire.status, 201, JSON.stringify(hire.body));
  assert.equal(hire.body.total_cents, 120000);
  assert.equal((await api('POST', '/hires', { ...t(org), body: { coach_id: coach.id, sport: 'football', starts_at: at } })).status, 409, 'double booking refused');
  assert.equal((await api('POST', '/hires', { ...t(org), body: { coach_id: coach.id, sport: 'cricket', starts_at: inFuture(5) } })).status, 400);
  assert.equal((await api('PATCH', `/hires/${hire.body.id}`, { ...t(joiner), body: { status: 'confirmed' } })).status, 403);
  assert.equal((await api('PATCH', `/hires/${hire.body.id}`, { ...t(coach), body: { status: 'confirmed' } })).status, 200);
  assert.equal((await api('GET', '/hires', { ...t(coach) })).body[0].i_am_coach, true);
});

test('every persona can add a profile for any catalogue sport, including newly seeded ones', async () => {
  for (const [role, slug] of [['athlete', 'judo'], ['coach', 'curling'], ['referee', 'sepak-takraw'], ['physio', 'diving'], ['doctor', 'weightlifting']]) {
    const u = await signup([role]);
    const r = await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: slug, role, level: 'amateur' } });
    assert.equal(r.status, 201, `${role}/${slug}: ${JSON.stringify(r.body)}`);
  }
});
