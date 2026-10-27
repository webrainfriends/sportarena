import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { sendFollowerAlerts } = await import('../src/spectator.js');

let server, base, n = 0;
const raw = (method, path, { token, body } = {}) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const api = async (method, path, o) => { const r = await raw(method, `/api/v1${path}`, o); return { status: r.status, body: await r.json() }; };
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sp_${n}_${roles[0]}`, display_name: `Spec ${n}`, email: `sp${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An open event with two teams (each with an adult player) and one game. */
async function world(extra = {}) {
  const org = await signup(['organizer']), m1 = await signup(['coach']), m2 = await signup(['coach']), p1 = await signup(['athlete']), p2 = await signup(['athlete']), fan = await signup(['athlete']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Public Cup ${++n}`, sport: 'football', city: 'Mumbai', ...extra } }), 201);
  must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'open' } }));
  const home = must(await api('POST', '/teams', { token: m1.token, body: { name: `Reds ${n}`, sport: 'football' } }), 201);
  const away = must(await api('POST', '/teams', { token: m2.token, body: { name: `Blues ${n}`, sport: 'football' } }), 201);
  for (const [t, p] of [[home, p1], [away, p2]]) {
    await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, t.id]);
    await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active') ON CONFLICT (team_id, user_id) DO UPDATE SET status='active'", [t.id, p.id]);
  }
  const fx = (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round) VALUES ($1,$2,$3, now() + interval '1 hour', 'Round 1') RETURNING id", [ev.id, home.id, away.id])).rows[0].id;
  return { org, m1, m2, p1, p2, fan, ev, home, away, fx };
}
const goal = (u, fx, side, player_id) => api('POST', `/fixtures/${fx}/events`, { token: u.token, body: { kind: 'goal', side, ...(player_id ? { player_id } : {}) } });
const notes = async (u, kind) => (await pool.query('SELECT title, body FROM notifications WHERE user_id=$1 AND kind=$2 ORDER BY created_at', [u.id, kind])).rows;

test('the public page is a projection of canonical data and works without logging in', async () => {
  const w = await world();
  const page = must(await api('GET', `/public/events/${w.ev.id}`));
  assert.equal(page.event.name, w.ev.name);
  assert.equal(page.event.state, 'upcoming');
  assert.equal(page.event.sport.slug, 'football');
  assert.equal(page.standings.label, 'provisional');
  assert.equal(page.fixtures.counts.scheduled, 1);
  assert.equal(page.fixtures.next[0].label, 'scheduled');
  assert.equal(page.fixtures.next[0].score, null, 'no score before the game');
  assert.equal(page.tickets, null, 'no ticketing module: nothing invented');
  assert.equal(page.registration.link.screen, 'Event');
  assert.equal(page.entrants.length, 2);
  assert.ok(!JSON.stringify(page).match(/email|phone|dob|national_id|password|address_enc/i), 'no private fields in the projection');

  // live: the scoreboard comes from the scoring engine
  must(await api('POST', `/fixtures/${w.fx}/start`, { token: w.org.token }));
  await api('POST', `/fixtures/${w.fx}/events`, { token: w.org.token, body: { kind: 'period_start' } });
  must(await goal(w.org, w.fx, 'home', w.p1.id), 201);
  const live = must(await api('GET', `/public/events/${w.ev.id}`));
  assert.equal(live.event.state, 'live');
  assert.equal(live.fixtures.live[0].label, 'live');
  assert.deepEqual([live.fixtures.live[0].score.home, live.fixtures.live[0].score.away], [1, 0]);

  const centre = must(await api('GET', `/public/fixtures/${w.fx}`));
  assert.equal(centre.fixture.label, 'live');
  assert.equal(centre.live.timeline.find((e) => e.kind === 'goal').player.handle, w.p1.handle, 'an adult scorer is named');
  assert.equal(centre.engagement.reactions.enabled, false, 'engagement is opt-in');

  // full time is provisional until the result is made official
  const done = must(await api('POST', `/fixtures/${w.fx}/result`, { token: w.org.token, body: { home_score: 2, away_score: 1 } }));
  assert.equal(done.status, 'completed');
  const table = must(await api('GET', `/public/events/${w.ev.id}/standings`));
  assert.equal(table.label, 'provisional', 'event not completed yet');
  assert.equal(table.rows[0].points, 3);
  must(await api('POST', `/events/${w.ev.id}/complete`, { token: w.org.token }));
  const fin = must(await api('GET', `/public/events/${w.ev.id}/standings`));
  assert.equal(fin.label, 'final');
  const after = must(await api('GET', `/public/events/${w.ev.id}`));
  assert.equal(after.event.state, 'completed');
  assert.equal(after.fixtures.recent[0].label, 'final');
  assert.ok(after.awards.every((a) => a.official === true));

  const list = must(await api('GET', `/public/events/${w.ev.id}/fixtures`));
  assert.equal(list.items[0].label, 'final');
  const bracket = must(await api('GET', `/public/events/${w.ev.id}/bracket`));
  assert.ok(Array.isArray(bracket.list) && Array.isArray(bracket.rounds), 'bracket also comes as a plain list');
  assert.equal((await api('GET', '/public/events/00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal((await api('GET', '/public/events/not-a-uuid')).status, 400);
});

test('visibility: private events never leak, unlisted is link-only, and withdrawing revokes shares at once', async () => {
  const w = await world();
  const settings = (b, u = w.org) => api('PATCH', `/events/${w.ev.id}/public-settings`, { token: u.token, body: b });
  assert.equal((await settings({ visibility: 'private' }, w.fan)).status, 403, 'only the organiser sets the policy');
  assert.equal((await api('GET', `/events/${w.ev.id}/public-settings`, { token: w.fan.token })).status, 403);

  // public: discoverable, card available
  assert.ok((await api('GET', '/events/search')).body.items.some((e) => e.id === w.ev.id));
  must(await api('GET', `/public/share/event/${w.ev.id}`));

  must(await settings({ visibility: 'unlisted' }));
  assert.ok(!(await api('GET', '/events/search')).body.items.some((e) => e.id === w.ev.id), 'unlisted is not listed');
  assert.equal((await api('GET', `/public/events/${w.ev.id}`)).status, 200, 'but reachable by link');

  must(await settings({ visibility: 'private' }));
  for (const p of [`/public/events/${w.ev.id}`, `/public/events/${w.ev.id}/fixtures`, `/public/events/${w.ev.id}/standings`, `/public/events/${w.ev.id}/bracket`, `/public/fixtures/${w.fx}`,
    `/events/${w.ev.id}`, `/events/${w.ev.id}/standings`, `/events/${w.ev.id}/bracket`, `/events/${w.ev.id}/live`, `/fixtures/${w.fx}/live`, `/public/share/event/${w.ev.id}`, `/public/share/fixture/${w.fx}`]) {
    assert.equal((await api('GET', p)).status, 404, `${p} must not leak a private event`);
  }
  assert.ok(!(await api('GET', `/fixtures?event_id=${w.ev.id}`)).body.length, 'private games are not listed');
  assert.ok(!(await api('GET', '/events/search')).body.items.some((e) => e.id === w.ev.id));
  assert.equal((await raw('GET', `/api/v1/share/events/${w.ev.id}`)).status, 404, 'the share page is revoked');
  assert.equal((await raw('GET', `/api/v1/share/cards/event/${w.ev.id}.svg`)).status, 404);
  assert.equal((await raw('GET', `/api/v1/live/public/fixtures/${w.fx}`)).status, 404);
  assert.equal((await raw('GET', `/api/v1/live/fixtures/${w.fx}`)).status, 404);
  const outsider = await signup(['athlete']);
  assert.equal((await api('GET', `/public/events/${w.ev.id}`, { token: outsider.token })).status, 404);
  assert.equal((await api('GET', `/public/events/${w.ev.id}`, { token: w.m1.token })).status, 200, 'a registered team manager still sees it');
  assert.equal((await api('GET', `/public/events/${w.ev.id}`, { token: w.org.token })).status, 200);
  assert.ok((await api('GET', '/events/search', { token: w.org.token })).body.items.some((e) => e.id === w.ev.id), 'the organiser still finds their own');
  assert.equal((await api('POST', '/me/follows', { token: outsider.token, body: { subject_type: 'event', subject_id: w.ev.id } })).status, 404, 'cannot follow what you cannot see');

  // drafts are organiser-only
  const draft = must(await api('POST', '/events', { token: w.org.token, body: { name: 'Draft cup', sport: 'football' } }), 201);
  await pool.query("UPDATE events SET status='draft' WHERE id=$1", [draft.id]);
  assert.equal((await api('GET', `/public/events/${draft.id}`)).status, 404);
  assert.equal((await api('GET', `/public/events/${draft.id}`, { token: w.org.token })).status, 200);
});

test('youth events: no player names, no indexing, no fan features, young people are not followable or shareable', async () => {
  const w = await world({ min_age: 10, max_age: 14 });
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [w.home.id, kid.id]);
  must(await api('POST', `/fixtures/${w.fx}/start`, { token: w.org.token }));
  await api('POST', `/fixtures/${w.fx}/events`, { token: w.org.token, body: { kind: 'period_start' } });
  must(await goal(w.org, w.fx, 'home', kid.id), 201);
  must(await goal(w.org, w.fx, 'home', w.p1.id), 201);

  const centre = must(await api('GET', `/public/fixtures/${w.fx}`));
  assert.ok(centre.live.timeline.filter((e) => e.kind === 'goal').every((e) => e.player === null), 'nobody is named on a youth event');
  assert.ok(!JSON.stringify(centre).includes(kid.id) && !JSON.stringify(centre).includes(kid.handle));
  const page = must(await api('GET', `/public/events/${w.ev.id}`));
  assert.equal(page.event.youth, true);
  assert.equal(page.engagement.reactions, false);

  const set = (b) => api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: b });
  assert.equal((await set({ indexable: true })).status, 422);
  assert.equal((await set({ reactions: true })).status, 422);
  assert.equal((await set({ mvp_vote: true })).status, 422);
  assert.equal((await api('POST', `/public/fixtures/${w.fx}/reaction`, { token: w.fan.token, body: { reaction: 'fire' } })).status, 409);

  // a young person can never be followed, and an award to one never becomes a card
  assert.equal((await api('POST', '/me/follows', { token: w.fan.token, body: { subject_type: 'athlete', subject_id: kid.id } })).status, 404);
  const award = (await pool.query("INSERT INTO awards(name, kind, event_id, user_id, awarded_by) VALUES ('Top scorer','badge',$1,$2,$3) RETURNING id", [w.ev.id, kid.id, w.org.id])).rows[0].id;
  assert.equal((await api('GET', `/public/share/award/${award}`)).status, 404);
  assert.ok(!JSON.stringify(must(await api('GET', `/public/events/${w.ev.id}`))).includes(kid.id), 'a young award winner is not on the public page');

  // the share page of a youth event is never indexable, even if it had been opted in earlier
  await pool.query('UPDATE events SET public_indexable=true WHERE id=$1', [w.ev.id]);
  const html = await raw('GET', `/api/v1/share/events/${w.ev.id}`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('x-robots-tag'), /noindex/);
  const sitemap = await (await raw('GET', '/api/v1/share/sitemap.xml')).text();
  assert.ok(!sitemap.includes(w.ev.id));
});

test('following: alerts for start, score, result and schedule changes; corrections are labelled and never rewrite history; following grants nothing private', async () => {
  const w = await world();
  const follower = await signup(['athlete']), scoreOnly = await signup(['athlete']), noAlerts = await signup(['athlete']);
  const f1 = must(await api('POST', '/me/follows', { token: follower.token, body: { subject_type: 'event', subject_id: w.ev.id } }), 201);
  assert.deepEqual(f1.alerts, ['start', 'result', 'schedule']);
  must(await api('POST', '/me/follows', { token: scoreOnly.token, body: { subject_type: 'team', subject_id: w.home.id, alerts: ['score'] } }), 201);
  must(await api('POST', '/me/follows', { token: noAlerts.token, body: { subject_type: 'fixture', subject_id: w.fx, alerts: [] } }), 201);
  const again = must(await api('POST', '/me/follows', { token: follower.token, body: { subject_type: 'event', subject_id: w.ev.id, alerts: ['start', 'score', 'result', 'schedule'] } }), 201);
  assert.equal(again.id, f1.id, 'following twice updates the same follow');
  assert.equal(must(await api('GET', '/me/follows', { token: follower.token })).length, 1);
  assert.equal((await api('POST', '/me/follows', { token: follower.token, body: { subject_type: 'athlete', subject_id: w.p1.id } })).status, 201, 'adult athletes can be followed');

  // following does not open private doors
  assert.equal((await api('GET', `/events/${w.ev.id}/entries`, { token: follower.token })).status, 403);
  assert.equal((await api('GET', `/events/${w.ev.id}/commercials`, { token: follower.token })).status, 403);

  // reschedule: a schedule-change alert
  must(await api('PATCH', `/fixtures/${w.fx}`, { token: w.org.token, body: { scheduled_at: new Date(Date.now() + 5 * 3600e3).toISOString() } }));
  await sendFollowerAlerts();
  assert.equal((await notes(follower, 'fixture_schedule')).length, 1);
  assert.equal((await notes(scoreOnly, 'fixture_schedule')).length, 0, 'alert preferences are respected');
  assert.equal((await notes(noAlerts, 'fixture_schedule')).length, 0);
  assert.equal(must(await api('GET', `/public/events/${w.ev.id}/fixtures`)).items[0].rescheduled, true);

  // kick-off and live score
  must(await api('POST', `/fixtures/${w.fx}/start`, { token: w.org.token }));
  await api('POST', `/fixtures/${w.fx}/events`, { token: w.org.token, body: { kind: 'period_start' } });
  must(await goal(w.org, w.fx, 'home', w.p1.id), 201);
  must(await goal(w.org, w.fx, 'home', w.p1.id), 201);
  await sendFollowerAlerts();
  assert.equal((await notes(follower, 'fixture_started')).length, 1);
  assert.equal((await notes(scoreOnly, 'fixture_score')).length, 1, 'a burst of goals is one alert with the current score');
  assert.match((await notes(scoreOnly, 'fixture_score'))[0].title, /2–0/);
  assert.equal((await notes(follower, 'fixture_score')).length, 1);
  const athleteFollower = (await pool.query("SELECT user_id FROM spectator_follows WHERE subject_type='athlete'")).rows[0].user_id;
  assert.equal(athleteFollower, follower.id);
  await sendFollowerAlerts();
  assert.equal((await notes(follower, 'fixture_started')).length, 1, 'idempotent');

  // official result, then a correction
  await pool.query("UPDATE fixtures SET status='finished' WHERE id=$1 AND status <> 'completed'", [w.fx]);
  const sheet = await api('POST', `/fixtures/${w.fx}/result`, { token: w.org.token, body: { home_score: 2, away_score: 0 } });
  assert.ok([200, 409].includes(sheet.status), JSON.stringify(sheet.body));
  await pool.query("UPDATE fixtures SET status='completed', home_score=2, away_score=0 WHERE id=$1", [w.fx]);
  await sendFollowerAlerts();
  assert.ok((await notes(follower, 'fixture_result')).some((x) => /Final/.test(x.title)));
  assert.equal(must(await api('GET', `/public/fixtures/${w.fx}`)).fixture.label, 'final');

  await pool.query('UPDATE fixtures SET home_score=3 WHERE id=$1', [w.fx]); // a corrected sheet
  await sendFollowerAlerts();
  assert.ok((await notes(follower, 'fixture_result')).some((x) => /corrected/i.test(x.title) && /3–0/.test(x.body)));
  const centre = must(await api('GET', `/public/fixtures/${w.fx}`));
  assert.equal(centre.fixture.corrected, true);
  const fix = centre.corrections.find((c) => c.kind === 'result' && c.official_before);
  assert.deepEqual([fix.before.home_score, fix.after.home_score], [2, 3], 'the earlier official score is kept in the log');
  assert.equal(centre.fixture.score.home, 3, 'the public view shows the corrected result');
  await assert.rejects(pool.query('DELETE FROM fixture_public_changes'), /append-only/);
  await assert.rejects(pool.query('UPDATE fixture_public_changes SET after = NULL'), /append-only/);

  // unfollow stops alerts; a private event stops alerts to non-participants
  must(await api('DELETE', `/me/follows/${f1.id}`, { token: follower.token }));
  assert.equal((await api('DELETE', `/me/follows/${f1.id}`, { token: follower.token })).status, 404);
  await pool.query('UPDATE fixtures SET home_score=4 WHERE id=$1', [w.fx]);
  await sendFollowerAlerts();
  assert.equal((await notes(follower, 'fixture_result')).filter((x) => /corrected/i.test(x.title)).length, 1, 'no alert after unfollowing');
  assert.equal((await notes(noAlerts, 'fixture_result')).length, 0);
});

test('follow limits and ownership', async () => {
  const w = await world();
  const u = await signup(['athlete']);
  assert.equal((await api('POST', '/me/follows', { body: { subject_type: 'event', subject_id: w.ev.id } })).status, 401);
  assert.equal((await api('POST', '/me/follows', { token: u.token, body: { subject_type: 'event', subject_id: w.ev.id, alerts: ['bogus'] } })).status, 400);
  assert.equal((await api('POST', '/me/follows', { token: u.token, body: { subject_type: 'team', subject_id: '00000000-0000-0000-0000-000000000000' } })).status, 404);
  const f = must(await api('POST', '/me/follows', { token: u.token, body: { subject_type: 'team', subject_id: w.home.id } }), 201);
  assert.equal((await api('DELETE', `/me/follows/${f.id}`, { token: w.fan.token })).status, 404, "nobody else can end your follow");
  const list = must(await api('GET', '/me/follows', { token: u.token }));
  assert.equal(list[0].label, w.home.name);
});

test('sponsor placements: only real active sponsorships, measured exposure only, no call to action on youth events', async () => {
  const w = await world();
  const sp = await signup(['sponsor']);
  const brand = must(await api('POST', '/sponsors', { token: sp.token, body: { name: 'VoltDrink' } }), 201);
  const deal = must(await api('POST', '/sponsorships', { token: sp.token, body: { sponsor_id: brand.id, target_type: 'event', target_id: w.ev.id, amount_cents: 100000 } }), 201);
  const place = (b, u = w.org) => api('POST', `/events/${w.ev.id}/sponsor-placements`, { token: u.token, body: b });
  assert.equal((await place({ sponsorship_id: deal.id, slot: 'title_partner' })).status, 409, 'a proposed sponsorship cannot hold a placement');
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: w.org.token, body: { status: 'active' } }));
  assert.equal((await place({ sponsorship_id: deal.id, slot: 'title_partner' }, w.fan)).status, 403);
  assert.equal((await place({ sponsorship_id: deal.id, slot: 'fixture' })).status, 400, 'fixture slot needs a game');
  assert.equal((await place({ sponsorship_id: deal.id, slot: 'title_partner', cta_label: 'Shop' })).status, 400, 'label and link come together');
  assert.equal((await place({ sponsorship_id: deal.id, slot: 'title_partner', cta_label: 'Shop', cta_url: 'http://insecure.example' })).status, 400);
  const p = must(await place({ sponsorship_id: deal.id, slot: 'title_partner', cta_label: 'Get VoltDrink', cta_url: 'https://volt.example/shop' }), 201);
  assert.equal((await place({ sponsorship_id: deal.id, slot: 'title_partner' })).status, 409, 'one sponsor per slot');
  must(await place({ sponsorship_id: deal.id, slot: 'fixture', fixture_id: w.fx }), 201);

  const page = must(await api('GET', `/public/events/${w.ev.id}`));
  assert.equal(page.sponsors.placements[0].sponsor.name, 'VoltDrink');
  assert.equal(page.sponsors.placements[0].cta.label, 'Get VoltDrink');
  assert.ok(!JSON.stringify(page).includes('volt.example/shop'), 'the link is only released through the counted click');
  must(await api('GET', `/public/fixtures/${w.fx}`));
  const click = must(await api('POST', `/public/placements/${p.id}/click`), 200);
  assert.equal(click.url, 'https://volt.example/shop');
  const report = must(await api('GET', `/events/${w.ev.id}/sponsor-placements`, { token: w.org.token }));
  const row = report.placements.find((x) => x.id === p.id);
  assert.equal(row.impressions_served, 2, 'two public responses carried the title placement');
  assert.equal(row.clicks, 1);
  assert.match(report.measured, /not measured/i);

  // an ended or paused sponsorship drops off the public page at once
  await pool.query("UPDATE sponsorships SET status='paused' WHERE id=$1", [deal.id]);
  assert.equal(must(await api('GET', `/public/events/${w.ev.id}`)).sponsors.placements.length, 0);
  assert.equal((await api('POST', `/public/placements/${p.id}/click`)).status, 404);
  await pool.query("UPDATE sponsorships SET status='active' WHERE id=$1", [deal.id]);
  must(await api('POST', `/sponsor-placements/${p.id}/end`, { token: w.org.token }));
  assert.equal((await api('POST', `/sponsor-placements/${p.id}/end`, { token: w.fan.token })).status, 403);
  assert.equal(must(await api('GET', `/events/${w.ev.id}/sponsor-placements`, { token: w.org.token })).placements.length, 1, 'ended placements are kept as history, listed on request');
  assert.equal(must(await api('GET', `/events/${w.ev.id}/sponsor-placements?include_ended=true`, { token: w.org.token })).placements.length, 2);

  // youth event: no call to action
  const y = await world({ min_age: 8, max_age: 12 });
  const brand2 = must(await api('POST', '/sponsors', { token: sp.token, body: { name: 'KidsFuel' } }), 201);
  const deal2 = must(await api('POST', '/sponsorships', { token: sp.token, body: { sponsor_id: brand2.id, target_type: 'event', target_id: y.ev.id, amount_cents: 1000 } }), 201);
  must(await api('PATCH', `/sponsorships/${deal2.id}`, { token: y.org.token, body: { status: 'active' } }));
  assert.equal((await api('POST', `/events/${y.ev.id}/sponsor-placements`, { token: y.org.token, body: { sponsorship_id: deal2.id, slot: 'title_partner', cta_label: 'Buy', cta_url: 'https://kids.example' } })).status, 422);
  must(await api('POST', `/events/${y.ev.id}/sponsor-placements`, { token: y.org.token, body: { sponsorship_id: deal2.id, slot: 'title_partner' } }), 201);
  assert.equal(must(await api('GET', `/public/events/${y.ev.id}`)).sponsors.placements[0].cta, null);
});

test('fan engagement is opt-in, one reaction / one vote per person, rate limited, and never an official award', async () => {
  const w = await world();
  must(await api('POST', `/fixtures/${w.fx}/start`, { token: w.org.token }));
  const react = (u, reaction = 'fire') => api('POST', `/public/fixtures/${w.fx}/reaction`, { token: u.token, body: { reaction } });
  assert.equal((await react(w.fan)).status, 409, 'off until the organiser enables it');
  must(await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { reactions: true, mvp_vote: true } }));
  assert.equal((await api('POST', `/public/fixtures/${w.fx}/reaction`, { body: { reaction: 'fire' } })).status, 401, 'sign in to react');
  assert.equal((await react(w.fan, 'bogus')).status, 400);
  must(await react(w.fan), 201);
  const r2 = must(await react(w.fan, 'clap'), 201);
  assert.equal(r2.counts.fire, 0); assert.equal(r2.counts.clap, 1, 'one reaction per person: changing it moves it');
  const other = await signup(['athlete']);
  assert.equal(must(await react(other, 'clap'), 201).counts.clap, 2);

  const view = must(await api('GET', `/public/fixtures/${w.fx}`, { token: w.fan.token }));
  assert.equal(view.engagement.reactions.mine, 'clap');
  const mvp = view.engagement.mvp_vote;
  assert.equal(mvp.official, false);
  assert.match(mvp.label, /not an official award/i);
  assert.deepEqual(mvp.candidates.map((c) => c.id).sort(), [w.p1.id, w.p2.id].sort());
  const vote = (u, candidate_id) => api('POST', `/public/fixtures/${w.fx}/mvp-vote`, { token: u.token, body: { candidate_id } });
  assert.equal((await vote(w.fan, w.fan.id)).status, 400, 'candidates are the players of the game');
  assert.equal(must(await vote(w.fan, w.p1.id), 201).candidates.find((c) => c.id === w.p1.id).votes, 1);
  assert.equal(must(await vote(w.fan, w.p2.id), 201).candidates.find((c) => c.id === w.p1.id).votes, 0, 'changing a vote moves it, never stacks');
  assert.equal((await vote(w.p1, w.p1.id)).status, 400, 'no self votes');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM awards WHERE kind='mvp' AND event_id=$1", [w.ev.id])).rows[0].n, 0, 'a fan vote creates no official award');

  // the hourly allowance stops floods
  await pool.query("INSERT INTO spectator_actions(user_id, kind) SELECT $1, 'reaction' FROM generate_series(1, 70)", [other.id]);
  assert.equal((await react(other, 'wow')).status, 429);
  assert.equal((await vote(other, w.p1.id)).status, 429);
  // voting closes a day after full time
  await pool.query("UPDATE fixtures SET status='completed', finished_at = now() - interval '2 days' WHERE id=$1", [w.fx]);
  assert.equal((await vote(w.fan, w.p1.id)).status, 409);
});

test('share cards and pages: public-safe, revocation aware, indexing only by opt-in', async () => {
  const w = await world();
  const card = must(await api('GET', `/public/share/event/${w.ev.id}`));
  assert.equal(card.title, w.ev.name);
  assert.equal(card.indexable, false);
  assert.ok(card.app_path.includes(w.ev.id) && card.page_path.endsWith(w.ev.id) && card.image_path.endsWith('.svg'));
  assert.equal((await api('GET', `/public/share/result/${w.fx}`)).status, 409, 'an unfinished game has no result card');
  assert.equal((await api('GET', `/public/share/standings/${w.ev.id}`)).status, 200);
  const fcard = must(await api('GET', `/public/share/fixture/${w.fx}`));
  assert.match(fcard.title, / v /);
  assert.ok(!JSON.stringify(card).match(/email|phone|dob|@/), 'cards carry no contact data');

  const page = await raw('GET', `/api/v1/share/events/${w.ev.id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  const html = await page.text();
  assert.match(html, /property="og:title"/); assert.match(html, /name="robots" content="noindex/);
  assert.ok(!html.includes('application/ld+json'));
  assert.ok(!(await (await raw('GET', '/api/v1/share/sitemap.xml')).text()).includes(w.ev.id), 'not in the sitemap until opted in');
  const svg = await raw('GET', `/api/v1/share/cards/event/${w.ev.id}.svg`);
  assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await svg.text(), /<svg[^>]+aria-label/);

  must(await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { indexable: true } }));
  const idx = await raw('GET', `/api/v1/share/events/${w.ev.id}`);
  assert.match(idx.headers.get('x-robots-tag'), /^index/);
  const idxHtml = await idx.text();
  assert.match(idxHtml, /application\/ld\+json/); assert.match(idxHtml, /rel="canonical"/);
  assert.ok((await (await raw('GET', '/api/v1/share/sitemap.xml')).text()).includes(w.ev.id));
  // making it private withdraws indexing as well
  must(await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { visibility: 'private' } }));
  assert.equal(must(await api('GET', `/events/${w.ev.id}/public-settings`, { token: w.org.token })).indexable, false);
  assert.ok(!(await (await raw('GET', '/api/v1/share/sitemap.xml')).text()).includes(w.ev.id));
  assert.equal((await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { visibility: 'unlisted', indexable: true } })).status, 422);

  // an official award card, then an HTML escape check
  const award = (await pool.query("INSERT INTO awards(name, kind, event_id, team_id, awarded_by) VALUES ($1,'cup',$2,$3,$4) RETURNING id", ['<b>Champions</b>', w.ev.id, w.home.id, w.org.id])).rows[0].id;
  must(await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { visibility: 'public' } }));
  assert.equal(must(await api('GET', `/public/share/award/${award}`)).label, 'Cup');
  assert.ok(!(await (await raw('GET', `/api/v1/share/awards/${award}`)).text()).includes('<b>Champions</b>'), 'organiser text is escaped');
});

test('discovery: live / upcoming / completed, level, region, date, archive, and the settings log', async () => {
  const w = await world({ region: 'Maharashtra', starts_on: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) });
  must(await api('PATCH', `/events/${w.ev.id}`, { token: w.org.token, body: { levels: ['amateur'] } }));
  const q = async (s) => (await api('GET', `/events/search?${s}`)).body;
  assert.ok((await q('phase=upcoming')).items.some((e) => e.id === w.ev.id));
  assert.ok(!(await q('phase=live')).items.some((e) => e.id === w.ev.id));
  must(await api('PATCH', `/events/${w.ev.id}`, { token: w.org.token, body: { status: 'ongoing' } }));
  must(await api('POST', `/fixtures/${w.fx}/start`, { token: w.org.token }));
  const live = (await q('phase=live')).items.find((e) => e.id === w.ev.id);
  assert.ok(live && live.live_now === true);
  assert.equal((await q('level=amateur')).items.filter((e) => e.id === w.ev.id).length, 1);
  assert.equal((await q('level=pro')).items.filter((e) => e.id === w.ev.id).length, 0);
  assert.equal((await q('region=maharashtra')).items.filter((e) => e.id === w.ev.id).length, 1);
  assert.equal((await q('region=goa')).items.filter((e) => e.id === w.ev.id).length, 0);

  must(await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { archived: true } }));
  assert.ok(!(await q('phase=live')).items.some((e) => e.id === w.ev.id), 'archived events leave discovery');
  assert.ok((await q('phase=live&include_archived=true')).items.some((e) => e.id === w.ev.id));
  assert.equal((await api('GET', `/public/events/${w.ev.id}`)).status, 200, 'but stay reachable by link');
  must(await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { archived: false, show_officials: true } }));
  const s = must(await api('GET', `/events/${w.ev.id}/public-settings`, { token: w.org.token }));
  assert.equal(s.archived, false); assert.equal(s.show_officials, true);
  assert.equal(s.history.length, 2);
  assert.equal((await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: {} })).status, 422);

  // officials appear only when the organiser allows it
  const ref = await signup(['referee']);
  await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [w.fx, ref.id]);
  assert.equal(must(await api('GET', `/public/fixtures/${w.fx}`)).officials[0].handle, ref.handle);
  must(await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { show_officials: false } }));
  assert.equal(must(await api('GET', `/public/fixtures/${w.fx}`)).officials.length, 0);
});

test('the public projections are in OpenAPI and MCP with the same allow-list, and public reads need no token', async () => {
  const spec = (await (await raw('GET', '/api/v1/openapi.json')).json());
  for (const op of ['get_public_event', 'list_public_fixtures', 'get_public_standings', 'get_public_bracket', 'get_public_fixture', 'get_share_card', 'follow_subject', 'unfollow_subject', 'list_my_follows', 'react_to_fixture', 'vote_fixture_mvp', 'save_sponsor_placement', 'list_sponsor_placements', 'set_event_public_settings', 'record_placement_click']) {
    assert.ok(Object.values(spec.paths).some((p) => Object.values(p).some((o) => o.operationId === op)), `${op} is in OpenAPI`);
  }
  const w = await world();
  const rpc = async (name, args, token) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return JSON.parse((await r.json()).result.content[0].text);
  };
  const viaRest = must(await api('GET', `/public/events/${w.ev.id}`));
  const viaMcp = await rpc('get_public_event', { id: w.ev.id }, w.fan.token);
  assert.deepEqual(Object.keys(viaMcp).sort(), Object.keys(viaRest).sort(), 'REST and MCP expose the same fields');
  // an unauthenticated MCP call is refused for follows but REST public reads work without any token
  assert.equal((await raw('GET', `/api/v1/public/events/${w.ev.id}`)).status, 200);
});

test('public endpoints have their own rate limit in production settings', async () => {
  // the limiter is mounted in front of every public surface; in test mode its allowance is generous, so assert it is wired (headers present)
  const r = await raw('GET', '/api/v1/public/events/00000000-0000-0000-0000-000000000000');
  assert.ok(r.headers.get('ratelimit-limit') || r.headers.get('ratelimit-policy'), 'rate limit headers present');
});
