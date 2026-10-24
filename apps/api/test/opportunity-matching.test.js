import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { evaluate, compareMatches } = await import('../src/opportunity-match.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `om_${n}_${roles[0]}`, display_name: `Match ${n}`, email: `om${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const linkGuardian = async (mum, kid) => {
  const l = must(await api('POST', '/youth/guardian-links', { token: mum.token, body: { guardian_id: mum.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: mum.token, body: { evidence: { reference: 'https://example.com/birth-ref-123', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
};
const card = (u, sport, extra = {}) => api('POST', '/me/sport-profiles', { token: u.token, body: { sport, role: 'athlete', ...extra } });
const matches = (u, query = {}) => api('GET', '/me/opportunity-matches', { token: u.token, query });
const rule = (m, r) => m.rules.find((x) => x.rule === r);
const prefs = (u, body) => api('POST', '/me/recruitment-preferences', { token: u.token, body: { version: 0, sport_slugs: [], levels: [], regions: [], open_to: [], open_to_contact: false, ...body } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('om_root','om_root','{admin}','x','x','om_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ───── the scorer on its own ─────
const subject = (over = {}) => ({ age: 20, youth: false, verified: false, profile: { level: 'amateur', position: 'Striker', positions: ['Striker'], region: 'Kerala' }, prefs: { sport_slugs: [], regions: [], open_to: [], budget_cents: null, budget_currency: null }, windows: [], ...over });
const opening = (over = {}) => ({ kind: 'team_opening', id: 'a', title: 't', sport_slug: 'football', positions: [], levels: [], region: null, regions: [], min_age: null, max_age: null, starts_on: null, deadline_at: null, cost: null, window_kinds: null, date: null, ...over });

test('scorer: unknown is never a match, a mismatch is explained, missing data names who can fix it', () => {
  const r = evaluate(subject(), opening(), new Date());
  assert.equal(r.fit, 'strong', 'only the sport is known: nothing to count against');
  assert.deepEqual(r.missing.map((m) => [m.dimension, m.who]).sort(), [['availability', 'organiser'], ['level', 'organiser'], ['position', 'organiser'], ['region', 'organiser']]);
  const bare = evaluate(subject({ profile: { level: null, position: null, positions: [], region: null } }), opening({ positions: ['Goalkeeper'], levels: ['pro'], region: 'Kochi, Kerala', starts_on: '2030-01-01', date: '2030-01-01' }), new Date());
  assert.ok(bare.missing.every((m) => m.who === 'player'));
  assert.deepEqual(bare.missing.map((m) => m.dimension).sort(), ['availability', 'level', 'position', 'region']);
  assert.equal(bare.score, 100, 'the sport is the only known rule');
  const bad = evaluate(subject(), opening({ positions: ['Goalkeeper'], levels: ['pro'], region: 'Delhi' }), new Date());
  assert.equal(rule(bad, 'position').status, 'mismatch'); assert.equal(rule(bad, 'level').status, 'mismatch'); assert.equal(rule(bad, 'region').status, 'mismatch');
  assert.equal(bad.eligible, true, 'position, level and region are soft'); assert.equal(bad.fit, 'weak');
  const good = evaluate(subject(), opening({ positions: ['striker'], levels: ['amateur', 'semi_pro'], region: 'Kochi, Kerala' }), new Date());
  assert.equal(good.fit, 'strong'); assert.equal(rule(good, 'region').status, 'match');
  assert.equal(evaluate(subject({ prefs: { sport_slugs: [], regions: [], open_to: ['relocation'], budget_cents: null, budget_currency: null } }), opening({ region: 'Delhi' }), new Date()).rules.find((x) => x.rule === 'region').status, 'match', 'open to relocation');
});

test('scorer: availability windows, weekdays and the budget never convert currencies', () => {
  const win = { kind: 'trial', from_date: '2030-03-01', to_date: '2030-03-31', weekdays: [] };
  const inside = evaluate(subject({ windows: [win] }), opening({ starts_on: '2030-03-10', date: '2030-03-10' }), new Date('2030-01-01'));
  assert.equal(rule(inside, 'availability').status, 'match');
  assert.equal(rule(evaluate(subject({ windows: [win] }), opening({ starts_on: '2030-05-10', date: '2030-05-10' }), new Date('2030-01-01')), 'availability').status, 'mismatch');
  const sat = '2030-03-09'; // a Saturday
  assert.equal(rule(evaluate(subject({ windows: [{ ...win, weekdays: [0] }] }), opening({ starts_on: sat, date: sat }), new Date('2030-01-01')), 'availability').status, 'mismatch', 'window is Sundays only');
  assert.equal(rule(evaluate(subject({ windows: [{ ...win, kind: 'visit' }] }), opening({ starts_on: '2030-03-10', window_kinds: ['trial'] }), new Date('2030-01-01')), 'availability').status, 'unknown', 'only a visit window: no trial window');

  const ev = (cost) => opening({ kind: 'competition', cost });
  const p = (b, c) => subject({ prefs: { sport_slugs: [], regions: [], open_to: [], budget_cents: b, budget_currency: c } });
  assert.equal(rule(evaluate(p(5000, 'INR'), ev({ cents: 3000, currency: 'INR' })), 'cost').status, 'match');
  assert.equal(rule(evaluate(p(5000, 'INR'), ev({ cents: 9000, currency: 'INR' })), 'cost').status, 'mismatch');
  assert.equal(rule(evaluate(p(5000, 'INR'), ev({ cents: 1, currency: 'USD' })), 'cost').status, 'unknown', 'USD vs INR is never converted');
  assert.equal(rule(evaluate(p(null, null), ev({ cents: 100, currency: 'INR' })), 'cost').status, 'unknown');
  assert.equal(rule(evaluate(p(null, null), ev({ cents: 0, currency: 'INR' })), 'cost').status, 'match', 'free is free');
  assert.equal(rule(evaluate(p(null, null), opening({ kind: 'study', cost: null, cost_unstated: true })), 'cost').status, 'unknown', 'an unstated fee is not "free"');
});

test('scorer: eligibility (age band, closed deadline, sponsor rules) makes an opportunity ineligible; ordering is deterministic', () => {
  const now = new Date('2030-01-01');
  assert.equal(evaluate(subject({ age: 30 }), opening({ min_age: 10, max_age: 18 }), now).eligible, false);
  assert.equal(evaluate(subject({ age: null }), opening({ min_age: 10, max_age: 18 }), now).missing.find((m) => m.rule === 'age').who, 'player');
  assert.equal(evaluate(subject(), opening({ kind: 'competition', deadline_at: '2029-12-01T00:00:00Z' }), now).eligible, false);
  const sp = (over) => opening({ kind: 'sponsor', target_types: ['athlete'], verified_only: false, regions: [], ...over });
  assert.equal(evaluate(subject({ youth: true }), sp(), now).eligible, false, 'minor athletes are not accepted');
  assert.equal(evaluate(subject(), sp({ verified_only: true }), now).eligible, false);
  assert.equal(evaluate(subject({ verified: true }), sp({ verified_only: true }), now).eligible, true);
  assert.equal(evaluate(subject(), sp({ target_types: ['team'] }), now).eligible, false);
  assert.equal(evaluate(subject(), sp({ regions: ['Goa'] }), now).eligible, false, 'a sponsor region is a hard rule');
  assert.equal(evaluate(subject({ profile: { level: 'amateur', position: null, positions: [], region: null } }), sp({ regions: ['Goa'] }), now).eligible, true, 'unknown region is not a failure');
  const a = { fit: 'strong', score: 90, opportunity: { id: 'b', date: null } }, b = { fit: 'strong', score: 90, opportunity: { id: 'a', date: null } }, c = { fit: 'possible', score: 99, opportunity: { id: 'c', date: null } };
  assert.deepEqual([a, c, b].sort(compareMatches).map((x) => x.opportunity.id), ['a', 'b', 'c']);
});

// ───── the capability, end to end ─────
test('journey: every kind is matched from real records, explained, filtered by sport, and exported', async () => {
  const p = await signup(['athlete'], { dob: yearsAgo(22) });
  const mgr = await signup(['coach']);
  assert.equal((await api('GET', '/me/opportunity-matches')).status, 401);

  // no card and no preferences: honest empty state with what to do
  const empty = must(await matches(p));
  assert.equal(empty.items.length, 0); assert.equal(empty.profile_gaps[0].where, 'SportProfile');

  must(await card(p, 'football', { level: 'amateur', position: 'Striker', region: 'Kerala' }), 201);
  must(await prefs(p, { budget_cents: 50000, budget_currency: 'INR' }));
  must(await api('POST', '/me/recruitment-availability', { token: p.token, body: { kind: 'trial', from_date: day(5), to_date: day(40) } }), 201);

  const t = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Rovers ${++n}`, sport: 'football' } }), 201);
  const post = must(await api('POST', '/billboard', { token: mgr.token, body: { kind: 'team_recruiting', title: 'Striker wanted', sport: 'football', team_id: t.id, starts_at: new Date(Date.now() + 10 * 86400000).toISOString(), positions: ['Striker'], levels: ['amateur', 'semi_pro'], region: 'Kerala', min_age: 16, max_age: 30 } }), 201);
  const other = must(await api('POST', '/billboard', { token: mgr.token, body: { kind: 'team_recruiting', title: 'Keeper wanted', sport: 'football', team_id: t.id, positions: ['Goalkeeper'] } }), 201);
  const tennis = must(await api('POST', '/billboard', { token: mgr.token, body: { kind: 'match_players', title: 'Tennis doubles', sport: 'tennis' } }), 201);
  const ev = must(await api('POST', '/events', { token: mgr.token, body: { name: 'Kerala Cup', sport: 'football', kind: 'trial', starts_on: day(12), city: 'Kochi', region: 'Kerala', entry_fee_cents: 20000, currency: 'INR', levels: ['amateur'], min_age: 18, max_age: 35, registration_deadline: new Date(Date.now() + 6 * 86400000).toISOString() } }), 201);
  const closed = must(await api('POST', '/events', { token: mgr.token, body: { name: 'Old Cup', sport: 'football', city: 'Kochi', registration_deadline: new Date(Date.now() + 86400000).toISOString() } }), 201);
  await pool.query("UPDATE events SET registration_deadline = now() - interval '1 day' WHERE id=$1", [closed.id]);

  const sw = await signup(['sponsor']);
  const brand = must(await api('POST', '/sponsors', { token: sw.token, body: { name: `Brand ${++n}` } }), 201);
  const prog = must(await api('POST', '/sponsorship-programs', { token: sw.token, body: { sponsor_id: brand.id, name: 'Kerala fund', objective: 'Grow', currency: 'INR', budget_cents: 100000, max_award_cents: 50000, sports: ['football'], regions: ['Kerala'] } }), 201);
  must(await api('POST', `/sponsorship-programs/${prog.id}/rounds`, { token: sw.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201);
  must(await api('POST', `/sponsorship-programs/${prog.id}/status`, { token: sw.token, body: { status: 'published', version: prog.row_version } }));

  const all = must(await matches(p));
  const by = (kind) => all.items.filter((m) => m.opportunity.kind === kind);
  assert.deepEqual(by('team_opening').map((m) => m.opportunity.id).sort(), [post.id, other.id].sort(), 'tennis post is for a sport the player does not play');
  const mine = by('team_opening').find((m) => m.opportunity.id === post.id);
  assert.equal(mine.fit, 'strong'); assert.equal(mine.eligible, true);
  for (const r of ['position', 'level', 'region', 'availability', 'eligibility']) assert.ok(mine.rules.some((x) => x.dimension === r && x.status === 'match'), `${r} matched`);
  const keeper = by('team_opening').find((m) => m.opportunity.id === other.id);
  assert.equal(rule(keeper, 'position').status, 'mismatch');
  assert.ok(all.items.indexOf(mine) < all.items.indexOf(keeper), 'better fit first');

  const comp = by('competition');
  assert.deepEqual(comp.map((m) => m.opportunity.id), [ev.id], 'closed registration is hidden');
  assert.equal(rule(comp[0], 'cost').status, 'match'); assert.equal(rule(comp[0], 'availability').status, 'match');
  assert.equal(by('sponsor').length, 1); assert.equal(by('sponsor')[0].eligible, true);

  // detail + hidden-but-available ineligible results
  const one = must(await api('GET', `/me/opportunity-matches/competition/${ev.id}`, { token: p.token }));
  assert.equal(one.opportunity.title, 'Kerala Cup'); assert.ok(one.rules.length >= 5);
  assert.equal((await api('GET', `/me/opportunity-matches/competition/${closed.id}`, { token: p.token })).status, 200);
  const withClosed = must(await matches(p, { include_ineligible: 'true', kinds: 'competition' }));
  assert.ok(withClosed.items.some((m) => m.opportunity.id === closed.id && !m.eligible));
  assert.equal((await api('GET', `/me/opportunity-matches/study/${post.id}`, { token: p.token })).status, 404);
  assert.equal((await api('GET', '/me/opportunity-matches/bogus/' + post.id, { token: p.token })).status, 400);

  // pagination is deterministic
  const p1 = must(await matches(p, { limit: '2', offset: '0' })), p2 = must(await matches(p, { limit: '2', offset: '2' }));
  assert.deepEqual([...p1.items, ...p2.items].map((m) => m.opportunity.id), all.items.slice(0, 4).map((m) => m.opportunity.id));

  // a second player with a bare card sees what is missing, and who must add it
  const q = await signup(['athlete']);
  must(await card(q, 'football'), 201);
  const bare = must(await matches(q, { kinds: 'team_opening' })).items.find((m) => m.opportunity.id === post.id);
  assert.ok(bare.missing.some((m) => m.dimension === 'position' && m.who === 'player' && m.where === 'SportProfile'));
  assert.equal(rule(bare, 'position').status, 'unknown');
  assert.ok(must(await matches(q)).gaps.some((g) => g.who === 'player'), 'gaps are summarised');

  // sport scoping: a card id that is not yours
  assert.equal((await matches(q, { sport_profile_id: (await api('GET', '/me/sport-profiles', { token: p.token })).body[0].id })).status, 404);

  // export: CSV, audited
  const csv = must(await api('GET', '/me/opportunity-matches/export', { token: p.token }));
  assert.ok(csv.csv.startsWith('kind,title,sport,fit,score')); assert.ok(csv.csv.includes('Striker wanted'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='export_opportunity_matches'", [p.id])).rows[0].n, 1);

  // matching stores nothing about the player and the passport never carries it
  const pass = JSON.stringify((await api('GET', '/me/passport', { token: p.token })).body ?? '');
  assert.ok(!pass.includes('Striker wanted'));
});

test('budget is a versioned preference: kept when left out, cleared with null, needs its currency', async () => {
  const p = await signup();
  let r = must(await prefs(p, { budget_cents: 1000, budget_currency: 'INR' }));
  assert.equal(r.budget_cents, 1000); assert.equal(r.budget_currency, 'INR');
  assert.equal((await prefs(p, { budget_cents: 5 })).status, 400, 'amount without currency');
  r = must(await api('POST', '/me/recruitment-preferences', { token: p.token, body: { version: r.version, sport_slugs: ['football'], levels: [], regions: [], open_to: [], open_to_contact: false } }));
  assert.equal(r.budget_cents, 1000, 'left out = kept');
  const stale = await api('POST', '/me/recruitment-preferences', { token: p.token, body: { version: 1, sport_slugs: [], levels: [], regions: [], open_to: [], open_to_contact: false } });
  assert.equal(stale.status, 409);
  r = must(await api('POST', '/me/recruitment-preferences', { token: p.token, body: { version: r.version, sport_slugs: [], levels: [], regions: [], open_to: [], open_to_contact: false, budget_cents: null, budget_currency: null } }));
  assert.equal(r.budget_cents, null);
});

test('programmes: matched by sport, level, region and fee; an unstated fee is missing data, not free', async () => {
  const p = await signup(['athlete'], { dob: yearsAgo(20) });
  must(await card(p, 'tennis', { level: 'semi_pro' }), 201);
  must(await prefs(p, { budget_cents: 100000, budget_currency: 'INR', regions: ['Pune'] }));
  const sports = Object.fromEntries((await api('GET', '/sports')).body.map((s) => [s.slug, s]));
  const owner = await signup(['athlete']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Hilltop ${++n}`, kind: 'college', city: 'Pune' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/institution`, { token: owner.token, body: { about: 'Sports degrees', website: 'https://hilltop.example', country: 'India', contact_email: 'a@hilltop.example', listed: true } }));
  const dear = must(await api('POST', `/organisations/${org.id}/programmes`, { token: owner.token, body: { title: 'BSc Sport', kind: 'degree', mode: 'on_campus', sport_ids: [sports.tennis.id], fee_minor: 250000, currency: 'INR', next_intake_on: day(60), levels: ['semi_pro', 'pro'], min_age: 17 } }), 201);
  const nofee = must(await api('POST', `/organisations/${org.id}/programmes`, { token: owner.token, body: { title: 'Diploma', kind: 'diploma', mode: 'online', sport_ids: [sports.tennis.id] } }), 201);
  const m = must(await matches(p, { kinds: 'study' })).items;
  const a = m.find((x) => x.opportunity.id === dear.id), b = m.find((x) => x.opportunity.id === nofee.id);
  assert.equal(rule(a, 'cost').status, 'mismatch'); assert.equal(rule(a, 'level').status, 'match'); assert.equal(rule(a, 'region').status, 'match'); assert.equal(rule(a, 'age').status, 'match');
  assert.equal(rule(b, 'cost').status, 'unknown'); assert.equal(rule(b, 'cost').fix.who, 'organiser');
  assert.equal((await api('PATCH', `/programmes/${nofee.id}`, { token: owner.token, body: { min_age: 30, max_age: 20 } })).status, 400, 'inverted age band');
});

// ───── youth: guardian, consent, live revocation ─────
test('a young player is matched only through a guardian with current consent, re-checked on every call and the export', async () => {
  const mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) }), stranger = await signup();
  must(await card(kid, 'football', { level: 'beginner' }), 201);
  await linkGuardian(mum, kid);

  // no consent yet: refused, with the reason
  const none = await api('GET', '/me/opportunity-matches', { token: mum.token, query: { on_behalf_of: kid.id } });
  assert.equal(none.status, 409); assert.equal(code(none), 'guardian_consent_required');
  assert.equal(code(await matches(kid)), 'guardian_consent_required', 'the young player alone is refused too');
  assert.equal((await api('GET', '/me/opportunity-matches', { token: stranger.token, query: { on_behalf_of: kid.id } })).status, 403);

  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'recruitment_sharing' } }), 201);
  must(await api('GET', '/me/opportunity-matches', { token: mum.token, query: { on_behalf_of: kid.id } }));
  must(await api('GET', '/me/opportunity-matches/export', { token: mum.token, query: { on_behalf_of: kid.id } }));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='export_opportunity_matches'", [mum.id])).rowCount >= 1);

  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='recruitment_sharing'", [kid.id]);
  assert.equal(code(await api('GET', '/me/opportunity-matches', { token: mum.token, query: { on_behalf_of: kid.id } })), 'guardian_consent_required', 'revocation is live');
  assert.equal(code(await api('GET', '/me/opportunity-matches/export', { token: mum.token, query: { on_behalf_of: kid.id } })), 'guardian_consent_required');
  assert.equal(code(await api('GET', `/me/opportunity-matches/team_opening/${kid.id}`, { token: mum.token, query: { on_behalf_of: kid.id } })), 'guardian_consent_required');
});
