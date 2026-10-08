import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sp_${n}_${roles[0]}`, display_name: `Spons ${n}`, email: `sp${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const brand = async (u, name) => must(await api('POST', '/sponsors', { token: u.token, body: { name, contact_email: `${name}@brand.example` } }), 201);
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const offer = (u, b, athlete, extra = {}) => api('POST', '/sponsorships', { token: u.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: athlete.id, amount_cents: 500000, objectives: 'Raise brand awareness', deliverables: 'Wear the kit; 4 social posts', starts_on: day(1), ends_on: day(180), ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('athletes are invisible and un-approachable until they opt in; discovery shows public fields only', async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), other = await signup(['athlete']);
  const b = await brand(sponsor, 'VoltDrink');
  await api('POST', '/me/sport-profiles', { token: ath.token, body: { sport: 'tennis', role: 'athlete' } });
  assert.deepEqual(must(await api('GET', '/sponsorable-athletes', { token: sponsor.token })), [], 'nobody is listed by default');
  assert.equal((await offer(sponsor, b, ath)).status, 409, 'no offers to someone who did not opt in');
  assert.equal((await api('GET', '/sponsorable-athletes', { token: ath.token })).status, 403, 'discovery is for sponsors');
  assert.equal((await api('POST', '/me/sponsorship-profile', { token: (await signup(['coach'])).token, body: { open_to_sponsors: true } })).status, 403, 'needs the athlete role');
  assert.deepEqual(must(await api('GET', '/me/sponsorship-profile', { token: ath.token })).open_to_sponsors, false);

  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true, pitch: 'Junior circuit tennis player', looking_for: ['equipment', 'travel'] } }));
  const found = must(await api('GET', '/sponsorable-athletes', { token: sponsor.token }));
  assert.equal(found.length, 1); assert.equal(found[0].id, ath.id);
  assert.deepEqual(found[0].sports, ['tennis']); assert.equal(found[0].pitch, 'Junior circuit tennis player');
  const text = JSON.stringify(found);
  assert.ok(!/email|phone|dob|national|address|555/i.test(text), 'no private data in discovery');
  assert.deepEqual(must(await api('GET', '/sponsorable-athletes', { token: sponsor.token, query: { sport: 'football' } })), []);
  assert.equal(must(await api('GET', '/sponsorable-athletes', { token: sponsor.token, query: { looking_for: 'travel', q: 'spons' } })).length, 1);
  assert.deepEqual(must(await api('GET', '/sponsorable-athletes', { token: sponsor.token, query: { looking_for: 'cash' } })), []);
  assert.deepEqual(must(await api('GET', '/sponsorable-athletes', { token: sponsor.token, query: { verified: 'true' } })), [], 'not verified yet');

  // opting out hides immediately and blocks new offers
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: false } }));
  assert.deepEqual(must(await api('GET', '/sponsorable-athletes', { token: sponsor.token })), []);
  assert.equal((await offer(sponsor, b, ath)).status, 409);
  assert.equal(other.id !== ath.id, true);
});

test('proposal reuses sponsorships: value, period, objectives, deliverables, validation, eligibility, duplicate and cooldown rules', async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = await brand(sponsor, 'KitCo');
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true, verified_sponsors_only: true } }));
  assert.equal((await offer(sponsor, b, ath)).status, 403, 'athlete wants verified sponsors only');
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true, verified_sponsors_only: false } }));
  assert.equal(must(await api('GET', '/me/sponsorship-profile', { token: ath.token })).verified_sponsors_only, false);

  assert.equal((await offer(sponsor, b, ath, { amount_cents: 0 })).status, 400, 'money or in-kind');
  assert.equal((await offer(sponsor, b, ath, { deliverables: undefined })).status, 400, 'deliverables required');
  assert.equal((await offer(sponsor, b, ath, { starts_on: day(10), ends_on: day(5) })).status, 400, 'period must be ordered');
  assert.equal((await offer(await signup(['sponsor']), b, ath)).status, 403, 'not your brand');
  const d = must(await offer(sponsor, b, ath, { amount_cents: 0, in_kind: 'Full kit and racquets' , message: 'Love your game' }), 201);
  assert.equal(d.target_type, 'athlete'); assert.equal(d.status, 'proposed'); assert.equal(d.visibility, 'private'); assert.equal(d.deliverables, 'Wear the kit; 4 social posts');
  assert.equal((await offer(sponsor, b, ath)).status, 409, 'one open offer per sponsor and athlete');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorships WHERE target_type='athlete'")).rows[0].n, 1, 'no second table');

  // the athlete is told (generic text) and sees it with the sponsor name
  const note = (await pool.query("SELECT title, body FROM notifications WHERE user_id=$1 AND kind='sponsorship_offer'", [ath.id])).rows;
  assert.equal(note.length, 1); assert.ok(!/racquet|5000|Wear|social/i.test(note[0].body));
  const inbox = must(await api('GET', '/sponsorships', { token: ath.token, query: { as: 'target' } }));
  assert.equal(inbox.length, 1); assert.equal(inbox[0].sponsor_name, 'KitCo'); assert.equal(inbox[0].target_name, ath.display_name); assert.equal(inbox[0].i_am_sponsor, false);
  assert.deepEqual(must(await api('GET', '/sponsorships', { token: ath.token, query: { as: 'sponsor' } })), []);
  assert.equal(must(await api('GET', '/sponsorships', { token: sponsor.token, query: { as: 'sponsor' } })).length, 1);
  assert.deepEqual(must(await api('GET', '/sponsorships', { token: (await signup()).token })), [], 'strangers see nothing');

  // only the athlete decides
  assert.equal((await api('PATCH', `/sponsorships/${d.id}`, { token: sponsor.token, body: { status: 'active' } })).status, 403);
  assert.equal((await api('PATCH', `/sponsorships/${d.id}`, { token: (await signup()).token, body: { status: 'active' } })).status, 403);
  const no = must(await api('PATCH', `/sponsorships/${d.id}`, { token: ath.token, body: { status: 'declined', reason: 'Already have a kit deal' } }));
  assert.equal(no.status, 'declined'); assert.equal(no.decision_reason, 'Already have a kit deal'); assert.ok(no.decided_at);
  assert.equal((await pool.query("SELECT body FROM notifications WHERE user_id=$1 AND kind='sponsorship_update'", [sponsor.id])).rows[0].body, 'Already have a kit deal');
  assert.equal((await offer(sponsor, b, ath)).status, 409, 'cooldown after a decline');
  await pool.query("UPDATE sponsorships SET decided_at = now() - interval '31 days' WHERE id=$1", [d.id]);
  must(await offer(sponsor, b, ath), 201);
});

test('accept, privacy of the deal on the sponsor page, withdraw and end', async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = await brand(sponsor, 'PrivacyCo');
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const d1 = must(await offer(sponsor, b, ath), 201);
  const d2 = must(await offer(sponsor, b, ath).then((r) => (r.status === 409 ? api('POST', `/sponsorships/${d1.id}/withdraw`, { token: sponsor.token }).then(() => offer(sponsor, b, ath)) : r)), 201);
  assert.equal((await pool.query('SELECT status FROM sponsorships WHERE id=$1', [d1.id])).rows[0].status, 'withdrawn', 'withdrawn, not deleted');
  assert.equal((await api('POST', `/sponsorships/${d1.id}/withdraw`, { token: sponsor.token })).status, 409);
  assert.equal((await api('POST', `/sponsorships/${d2.id}/withdraw`, { token: ath.token })).status, 403, 'only the sponsor withdraws');
  assert.equal((await api('PATCH', `/sponsorships/${d1.id}`, { token: ath.token, body: { status: 'active' } })).status, 409, 'cannot accept a withdrawn offer');

  must(await api('PATCH', `/sponsorships/${d2.id}`, { token: ath.token, body: { status: 'active' } }));
  const hidden = must(await api('GET', `/sponsors/${b.id}`)).active_sponsorships;
  assert.deepEqual(hidden, [], 'an athlete deal is not public unless the athlete chooses');
  assert.equal((await api('PATCH', `/sponsorships/${d2.id}`, { token: ath.token, body: { status: 'active' } })).status, 409, 'already answered');
  must(await api('PATCH', `/sponsorships/${d2.id}`, { token: sponsor.token, body: { status: 'ended' } }));

  // an athlete who chooses to show the deal
  const ath2 = await signup(['athlete']);
  must(await api('POST', '/me/sponsorship-profile', { token: ath2.token, body: { open_to_sponsors: true } }));
  const d3 = must(await offer(sponsor, b, ath2), 201);
  must(await api('PATCH', `/sponsorships/${d3.id}`, { token: ath2.token, body: { status: 'active', show_publicly: true } }));
  const shown = must(await api('GET', `/sponsors/${b.id}`)).active_sponsorships;
  assert.equal(shown.length, 1); assert.equal(shown[0].target_id, ath2.id);
  assert.ok(!JSON.stringify(shown).includes('Wear the kit'), 'deliverables and messages stay private');
  assert.ok(!JSON.stringify(must(await api('GET', `/sponsors/${b.id}`))).includes('@brand.example'), 'sponsor contact stays private too');
});

test('existing team and event sponsorships keep working and stay public', async () => {
  const sponsor = await signup(['sponsor']), org = await signup(['organizer']);
  const b = await brand(sponsor, 'EventCo');
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Sponsored Cup', sport: 'football' } }), 201);
  const d = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'event', target_id: ev.id, amount_cents: 100000 } }), 201);
  assert.equal(d.visibility, 'public');
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: org.token, body: { status: 'active' } }));
  assert.equal(must(await api('GET', `/sponsors/${b.id}`)).active_sponsorships.length, 1);
});

test('migration makes existing athlete deals private and keeps every row', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '018_sponsor_athletes.sql').sort()) { await pool.query(readFileSync(new URL(f, dir), 'utf8')); await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); }
  const u = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('mig','Mig','{sponsor,athlete}','x','x','migidx') RETURNING id")).rows[0].id;
  const sp = (await pool.query("INSERT INTO sponsors(owner_id, name) VALUES ($1,'OldBrand') RETURNING id", [u])).rows[0].id;
  await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, status, proposed_by) VALUES ($1,'athlete',$2,100,'active',$2),($1,'event',gen_random_uuid(),200,'active',$2)", [sp, u]);
  await migrate();
  const rows = (await pool.query('SELECT target_type, visibility, status, amount_cents FROM sponsorships ORDER BY target_type')).rows;
  assert.deepEqual(rows.map((r) => [r.target_type, r.visibility, r.status]), [['athlete', 'private', 'active'], ['event', 'public', 'active']]);
});
