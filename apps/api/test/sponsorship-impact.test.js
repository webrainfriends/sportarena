// Beneficiary performance and community impact (#303): consent-scoped reads/exports, team/event results, milestones and community outcomes with
// provenance, append-only corrections, pre-award evidence through the passport, isolation, stale versions and "a missed objective never blocks a due".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `im_${n}_${roles[0]}`, display_name: `Impact ${n}`, email: `im${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A team agreement: sponsor brand + a team owner, accepted by the owner. */
const teamWorld = async () => {
  const sponsor = await signup(['sponsor']), owner = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `ImpactBrand${n}` } }), 201);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0];
  const team = (await pool.query('INSERT INTO teams(name, sport_id, owner_id) VALUES ($1,$2,$3) RETURNING id', [`Impact FC ${n}`, sport.id, owner.id])).rows[0];
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'manager','active')", [team.id, owner.id]);
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'team', target_id: team.id, deliverables: 'Logo on kit', starts_on: day(-30), ends_on: day(150),
    lines: [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 10000, cadence: 'once', first_due_on: day(10) }] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: owner.token, body: { status: 'active', version: 1 } }));
  return { sponsor, owner, b, team, deal, sport };
};
const game = async (w, { outcome, official = false, on = day(-5), sportId = w.sport.id }) => {
  const g = (await pool.query("INSERT INTO games(sport_id, created_by, title, status, starts_at, competition_id) VALUES ($1,$2,'Match','post-event',$3::timestamptz, NULL) RETURNING id", [sportId, w.owner.id, on])).rows[0];
  if (official) await pool.query('UPDATE games SET fixture_id=(SELECT id FROM fixtures LIMIT 1) WHERE id=$1 AND EXISTS (SELECT 1 FROM fixtures)', [g.id]);
  await pool.query('INSERT INTO game_participants(game_id, team_id, outcome) VALUES ($1,$2,$3)', [g.id, w.team.id, outcome]);
  return g.id;
};
const share = (w, body = { enabled: true }) => api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.owner.token, body });
const rec = (w, body, token = w.owner.token) => api('POST', `/sponsorships/${w.deal.id}/impact`, { token, body: { kind: 'community', title: 'Holiday coaching clinic', metric: 'children_coached', value: 40, unit: 'children', sample_size: 40, source: 'organiser_record', occurred_on: day(-3), ...body } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('team results are read live, consent-gated, per sport and never one score; revoking blocks reads and exports', async () => {
  const w = await teamWorld();
  await game(w, { outcome: 'win' }); await game(w, { outcome: 'loss' }); await game(w, { outcome: 'win' });
  const bb = (await pool.query("SELECT id FROM sports WHERE slug='basketball'")).rows[0];
  await game(w, { outcome: 'win', sportId: bb.id });
  const read = (token) => api('GET', `/sponsorships/${w.deal.id}/performance`, { token });
  assert.equal((await read(w.sponsor.token)).status, 403, 'no consent, no read');
  assert.equal((await share(w, { enabled: true })).status, 200 , 'the team owner can now switch sharing on');
  assert.equal((await api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.sponsor.token, body: { enabled: true } })).status, 403, 'a sponsor cannot grant itself access');
  const p = must(await read(w.sponsor.token));
  assert.deepEqual(p.team_event.results.map((r) => [r.sport, r.sample_size, r.wins, r.losses]).sort(), [['basketball', 1, 1, 0], ['football', 3, 2, 1]].sort(), 'one row per sport, with the sample size');
  assert.ok(p.team_event.results.every((r) => r.source_label && r.unit === 'games' && r.first_on));
  assert.equal(p.score, undefined, 'no combined score');
  assert.deepEqual(p.metrics, [], "the owner's personal athlete results are never part of a team agreement");
  // a corrected game changes the view at once
  await pool.query("UPDATE game_participants SET outcome='loss' WHERE game_id=(SELECT id FROM games WHERE sport_id=$1 LIMIT 1)", [bb.id]);
  assert.equal(must(await read(w.sponsor.token)).team_event.results.find((r) => r.sport === 'basketball').losses, 1);
  const csv = must(await api('GET', `/sponsorships/${w.deal.id}/impact-export`, { token: w.sponsor.token }));
  assert.ok(csv.csv.includes('Platform game and entry records') && csv.rows >= 2);
  const other = await signup(['sponsor']);
  assert.equal((await read(other.token)).status, 403, 'another sponsor is denied');
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}/impact-export`, { token: other.token })).status, 403);
  must(await share(w, { enabled: false }));
  assert.equal((await read(w.sponsor.token)).status, 403, 'revocation blocks the next read');
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}/impact-export`, { token: w.sponsor.token })).status, 403, 'and the next export');
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}/impact`, { token: w.sponsor.token })).status, 403);
  assert.equal((await read(w.owner.token)).status, 200, 'the beneficiary still sees their own');
});

test('community outcomes and milestones carry source, date, unit and sample size; only the beneficiary writes; scope limits what the sponsor sees', async () => {
  const w = await teamWorld();
  const good = must(await rec(w, {}), 201);
  assert.equal(good.source_label, 'Organiser record'); assert.equal(good.sample_size, 40);
  must(await rec(w, { kind: 'milestone', title: 'U12 squad promoted', metric: undefined, value: undefined, unit: undefined, sample_size: undefined, source: 'self_reported' }), 201);
  must(await rec(w, { title: 'Survey', metric: 'satisfaction', value: 4.5, unit: 'of 5', sample_size: 60, source: 'third_party', source_ref: 'Local council survey 2030' }), 201);
  assert.equal((await rec(w, {}, w.sponsor.token)).status, 403, 'a sponsor cannot enter evidence');
  assert.equal((await rec(w, { sample_size: undefined })).status, 400, 'a community figure needs its sample size');
  assert.equal((await rec(w, { value: 5, unit: undefined })).status, 400, 'a value needs its unit');
  assert.equal((await rec(w, { source: 'third_party' })).status, 400, 'a third party must be named');
  assert.equal((await rec(w, { occurred_on: day(5) })).status, 400, 'no future outcomes');
  assert.equal((await rec(w, {}, (await signup(['athlete'])).token)).status, 403, 'a stranger is denied');
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}/impact`, { token: w.sponsor.token })).status, 403, 'not shared yet');
  must(await share(w, { enabled: true, scope: 'official' }));
  let l = must(await api('GET', `/sponsorships/${w.deal.id}/impact`, { token: w.sponsor.token }));
  assert.deepEqual(l.items.map((x) => x.source), ['organiser_record'], 'official scope shows organiser records only');
  must(await share(w, { enabled: true, scope: 'all_evidence' }));
  l = must(await api('GET', `/sponsorships/${w.deal.id}/impact`, { token: w.sponsor.token }));
  assert.equal(l.total, 3); assert.ok(l.items.every((x) => x.source_label));
  assert.equal(l.groups.length, 3, 'each kind, metric and unit stays its own group; nothing is combined');
  const page = must(await api('GET', `/sponsorships/${w.deal.id}/impact`, { token: w.owner.token, query: { limit: '2', offset: '2' } }));
  assert.equal(page.items.length, 1); assert.equal(page.total, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_sponsorship_impact' AND actor_id=$1", [w.sponsor.id])).rows[0].n, 2, 'sponsor reads are audit-logged');
  assert.ok((await pool.query('SELECT note_enc FROM sponsorship_impact_records LIMIT 1')).rows.length);
});

test('corrections are append-only, update current views and exports at once, reject stale versions and keep the history', async () => {
  const w = await teamWorld();
  must(await share(w, { enabled: true, scope: 'all_evidence' }));
  const a = must(await rec(w, { note: 'Run with the school' }), 201);
  assert.equal((await api('POST', `/sponsorship-impact/${a.id}/correction`, { token: w.sponsor.token, body: { row_version: 1, reason: 'oops', value: 1 } })).status, 403);
  const fixed = must(await api('POST', `/sponsorship-impact/${a.id}/correction`, { token: w.owner.token, body: { row_version: 1, reason: 'Counted twice', value: 32, sample_size: 32 } }), 201);
  assert.equal(fixed.value, 32); assert.equal(fixed.corrected, true); assert.equal(fixed.note, 'Run with the school', 'unchanged fields and the note carry over');
  const stale = await api('POST', `/sponsorship-impact/${a.id}/correction`, { token: w.owner.token, body: { row_version: 1, reason: 'again', value: 30 } });
  assert.equal(stale.status, 409, 'the old figure is superseded, so a second correction of it is refused');
  const cur = must(await api('GET', `/sponsorships/${w.deal.id}/impact`, { token: w.sponsor.token }));
  assert.deepEqual(cur.items.map((x) => x.value), [32], 'the corrected figure replaces the old one in the current view');
  assert.ok(must(await api('GET', `/sponsorships/${w.deal.id}/impact-export`, { token: w.sponsor.token })).csv.includes(',32,'));
  const hist = must(await api('GET', `/sponsorships/${w.deal.id}/impact`, { token: w.owner.token, query: { history: 'true' } }));
  assert.deepEqual(hist.items.map((x) => [x.status, x.value]).sort(), [['current', 32], ['superseded', 40]].sort(), 'nothing is deleted');
  assert.equal(hist.items.find((x) => x.status === 'current').correction_reason, 'Counted twice');
  const w2 = must(await api('POST', `/sponsorship-impact/${fixed.id}/withdraw`, { token: w.owner.token, body: { row_version: fixed.row_version, reason: 'Entered on the wrong agreement' } }));
  assert.equal(w2.status, 'withdrawn');
  assert.equal(must(await api('GET', `/sponsorships/${w.deal.id}/impact`, { token: w.sponsor.token })).total, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_impact_records WHERE sponsorship_id=$1', [w.deal.id])).rows[0].n, 2, 'both rows are still stored');
  // two simultaneous corrections: exactly one wins
  const b = must(await rec(w, {}), 201);
  const rs = await Promise.all([30, 31].map((value) => api('POST', `/sponsorship-impact/${b.id}/correction`, { token: w.owner.token, body: { row_version: 1, reason: 'race', value } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
});

test('a missed or unmet impact figure never touches a due, a payment or the agreement', async () => {
  const w = await teamWorld();
  must(await share(w));
  must(await rec(w, { value: 1, sample_size: 1, title: 'Tiny clinic' }), 201);
  await game(w, { outcome: 'loss' });
  const dues = must(await api('GET', '/sponsorship-obligations', { token: w.owner.token, query: { sponsorship_id: w.deal.id } })).obligations;
  assert.ok(dues.length && dues.every((d) => d.status === 'scheduled'));
  assert.equal(must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.owner.token })).status, 'active');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorship_payments p JOIN sponsorship_obligations o ON o.id=p.obligation_id WHERE o.sponsorship_id=$1", [w.deal.id])).rows[0].n, 0, 'nothing is released or withheld by evidence');
});

test('pre-award evidence: the applicant shares through a passport link; revocation, expiry, wrong brand and a stranger are all handled', async () => {
  const brand = await signup(['sponsor']);
  const b = must(await api('POST', '/sponsors', { token: brand.token, body: { name: `PreAward${n}` } }), 201);
  const prog = must(await api('POST', '/sponsorship-programs', { token: brand.token, body: { sponsor_id: b.id, name: 'Rising fund', objective: 'Back talent', currency: 'USD', budget_cents: 100000, max_award_cents: 50000 } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${prog.id}/rounds`, { token: brand.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201);
  must(await api('POST', `/sponsorship-programs/${prog.id}/status`, { token: brand.token, body: { status: 'published', version: prog.row_version } }));
  const ath = await signup(['athlete']);
  const app = must(await api('POST', `/program-rounds/${r.id}/applications`, { token: ath.token, body: { target_type: 'athlete', target_id: ath.id, requested_cents: 20000, pitch: 'Support me' } }), 201);
  const read = (token) => api('GET', `/program-applications/${app.id}/evidence`, { token });
  assert.equal(must(await read(brand.token)).state, 'not_shared');
  assert.equal((await api('POST', `/program-applications/${app.id}/evidence-share`, { token: brand.token, body: { enabled: true, show_results: true } })).status, 404, 'only the applicant shares');
  assert.equal((await api('POST', `/program-applications/${app.id}/evidence-share`, { token: ath.token, body: { enabled: true } })).status, 400, 'choose a section');
  const sh = must(await api('POST', `/program-applications/${app.id}/evidence-share`, { token: ath.token, body: { enabled: true, show_results: true, show_awards: true } }));
  assert.equal(sh.shared, true); assert.equal(sh.sections.show_matches, false);
  const ev = must(await read(brand.token));
  assert.equal(ev.state, 'shared'); assert.ok('verified_results' in ev.passport && ev.passport.seasons === null, 'only the chosen sections');
  assert.equal(ev.passport.athlete.email, undefined, 'no contact data');
  const rival = await signup(['sponsor']);
  await api('POST', '/sponsors', { token: rival.token, body: { name: `Rival${n}` } });
  assert.equal((await read(rival.token)).status, 403, 'another brand is denied');
  assert.equal((await read(ath.token)).status, 403, 'the applicant is not brand staff');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_application_evidence'")).rows[0].n, 1);
  // the same link is visible to the athlete among their passport links and revoking it there ends the reads too
  const links = must(await api('GET', '/me/passport-links', { token: ath.token }));
  assert.equal(links.filter((l) => l.label === 'Funding application' && l.status === 'active').length, 1);
  must(await api('POST', `/program-applications/${app.id}/evidence-share`, { token: ath.token, body: { enabled: false } }));
  assert.equal(must(await read(brand.token)).state, 'revoked');
  assert.equal(must(await read(brand.token)).passport, undefined, 'no figures after revocation');
  must(await api('POST', `/program-applications/${app.id}/evidence-share`, { token: ath.token, body: { enabled: true, show_results: true } }));
  assert.equal(must(await read(brand.token)).state, 'shared');
  await pool.query("UPDATE passport_links SET expires_at = now() - interval '1 minute' WHERE user_id=$1", [ath.id]);
  assert.equal(must(await read(brand.token)).state, 'revoked', 'an expired link stops the read');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM passport_links WHERE user_id=$1", [ath.id])).rows[0].n, 2, 'links are kept, never deleted');
});
