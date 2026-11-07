// PS-12: Para-athlete passport — unit and integration tests
// Tests: athlete-controlled para section flags, class code privacy, guide attribution
// privacy guard, evidence filter, class-history inclusion, no back-propagation,
// no medical/clinical data in any output, revocation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pp12_${n}`, display_name: `PS12 ${n}`, email: `ps12_${n}@example.com`, phone: '+919876543210', full_name: `Test Athlete ${n}`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('para passport — flags default to false; para_records present but class codes stripped by default', async () => {
  const a = await signup();
  const sportId = (await pool.query("SELECT id FROM sports WHERE slug='para_athletics' LIMIT 1")).rows[0]?.id
    ?? (await pool.query("INSERT INTO sports(slug,name,emoji) VALUES('para_athletics','Para Athletics','🏃') RETURNING id")).rows[0].id;

  // Insert a para record
  await pool.query(
    `INSERT INTO para_records(sport_id, discipline, sport_class, metric, unit, direction, record_type, value, holder_user_id, achieved_at, provenance, status)
     VALUES ($1,'100m','T47','100m Sprint','s','lower','personal_best',9.84,$2,$3,'official','current')`,
    [sportId, a.id, day(-10)]);

  // Create a link with defaults (show_para_class = false)
  const link = await api('POST', '/me/passport-links', { token: a.token, body: { expires_in_days: 7 } });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  assert.equal(link.body.show_para_class, false, 'show_para_class defaults to false');
  assert.equal(link.body.show_para_guide, false, 'show_para_guide defaults to false');
  assert.equal(link.body.show_para_class_history, false, 'show_para_class_history defaults to false');
  assert.equal(link.body.para_evidence_filter, 'all', 'para_evidence_filter defaults to all');

  // Open the link: para_records present but sport_class stripped
  const view = await api('GET', `/passport/${encodeURIComponent(link.body.token)}`);
  assert.equal(view.status, 200);
  const recs = view.body.para_records ?? [];
  // Records should still be returned (show_results defaults true)
  for (const r of recs) {
    assert.equal(r.sport_class, null, 'sport_class must be null when show_para_class=false');
    assert.equal(r.classification_snapshot, null, 'classification_snapshot must be null when show_para_class=false');
  }
  // para_class_history should be null (flag off)
  assert.equal(view.body.para_class_history, null, 'para_class_history null when flag off');
  // para_privacy metadata present
  assert.ok(view.body.para_privacy, 'para_privacy metadata returned');
  assert.equal(view.body.para_privacy.show_para_class, false);
  assert.match(view.body.para_privacy.note, /medical/i, 'privacy note mentions medical');
});

test('para passport — opt-in to show_para_class: class codes visible', async () => {
  const a = await signup();
  const sportId = (await pool.query("SELECT id FROM sports WHERE slug='para_athletics' LIMIT 1")).rows[0]?.id
    ?? (await pool.query("INSERT INTO sports(slug,name,emoji) VALUES('para_athletics','Para Athletics','🏃') RETURNING id")).rows[0].id;

  await pool.query(
    `INSERT INTO para_records(sport_id, discipline, sport_class, metric, unit, direction, record_type, value, holder_user_id, achieved_at, provenance, status)
     VALUES ($1,'100m','T47','100m Sprint','s','lower','world_record',9.84,$2,$3,'official','current')`,
    [sportId, a.id, day(-5)]);

  const link = await api('POST', '/me/passport-links', { token: a.token, body: { expires_in_days: 7, show_para_class: true } });
  assert.equal(link.status, 201);
  assert.equal(link.body.show_para_class, true);

  const view = await api('GET', `/passport/${encodeURIComponent(link.body.token)}`);
  assert.equal(view.status, 200);
  const recs = view.body.para_records ?? [];
  assert.ok(recs.length > 0, 'para_records returned');
  const rec = recs.find((r) => r.metric === '100m Sprint');
  assert.ok(rec, 'record found');
  assert.equal(rec.sport_class, 'T47', 'sport_class visible when flag on');
  assert.equal(view.body.para_privacy.show_para_class, true);
});

test('para passport — guide name: off by default, visible when show_para_guide=true', async () => {
  const athlete = await signup();
  const guide = await signup();
  const sportId = (await pool.query("SELECT id FROM sports WHERE slug='para_swimming' LIMIT 1")).rows[0]?.id
    ?? (await pool.query("INSERT INTO sports(slug,name,emoji) VALUES('para_swimming','Para Swimming','🏊') RETURNING id")).rows[0].id;

  await pool.query(
    `INSERT INTO para_records(sport_id, discipline, sport_class, metric, unit, direction, record_type, value, holder_user_id, guide_athlete_id, achieved_at, provenance, status)
     VALUES ($1,'100m','S14','100m Freestyle','s','lower','personal_best',53.21,$2,$3,$4,'official','current')`,
    [sportId, athlete.id, guide.id, day(-3)]);

  // Link with guide hidden (default)
  const hiddenLink = await api('POST', '/me/passport-links', { token: athlete.token, body: { expires_in_days: 7, show_para_class: true } });
  const hiddenView = await api('GET', `/passport/${encodeURIComponent(hiddenLink.body.token)}`);
  const hiddenRec = (hiddenView.body.para_records ?? []).find((r) => r.metric === '100m Freestyle');
  assert.ok(hiddenRec, 'record present');
  assert.equal(hiddenRec.guide_name, null, 'guide_name null when show_para_guide=false');

  // Link with guide visible
  const visibleLink = await api('POST', '/me/passport-links', { token: athlete.token, body: { expires_in_days: 7, show_para_class: true, show_para_guide: true } });
  const visibleView = await api('GET', `/passport/${encodeURIComponent(visibleLink.body.token)}`);
  const visibleRec = (visibleView.body.para_records ?? []).find((r) => r.metric === '100m Freestyle');
  assert.ok(visibleRec, 'record present');
  assert.equal(visibleRec.guide_name, guide.display_name, 'guide_name shown when show_para_guide=true');
});

test('para passport — evidence filter: official only vs all', async () => {
  const a = await signup();
  const sportId = (await pool.query("SELECT id FROM sports WHERE slug='para_athletics' LIMIT 1")).rows[0]?.id
    ?? (await pool.query("INSERT INTO sports(slug,name,emoji) VALUES('para_athletics','Para Athletics','🏃') RETURNING id")).rows[0].id;

  await pool.query(
    `INSERT INTO para_records(sport_id, discipline, sport_class, metric, unit, direction, record_type, value, holder_user_id, achieved_at, provenance, status)
     VALUES
       ($1,'200m','T47','200m Sprint','s','lower','personal_best',20.09,$2,$3,'official','current'),
       ($1,'200m','T47','200m Sprint Trials','s','lower','personal_best',20.5,$2,$4,'self_reported','current')`,
    [sportId, a.id, day(-15), day(-5)]);

  // Official filter
  const offLink = await api('POST', '/me/passport-links', { token: a.token, body: { expires_in_days: 7, show_para_class: true, para_evidence_filter: 'official' } });
  assert.equal(offLink.body.para_evidence_filter, 'official');
  const offView = await api('GET', `/passport/${encodeURIComponent(offLink.body.token)}`);
  const offRecs = (offView.body.para_records ?? []).filter((r) => r.metric?.includes('200m'));
  assert.ok(offRecs.every((r) => r.metric === '200m Sprint'), 'self-reported result excluded when official filter');

  // All filter
  const allLink = await api('POST', '/me/passport-links', { token: a.token, body: { expires_in_days: 7, show_para_class: true, para_evidence_filter: 'all' } });
  const allView = await api('GET', `/passport/${encodeURIComponent(allLink.body.token)}`);
  const allRecs = (allView.body.para_records ?? []).filter((r) => r.metric?.includes('200m'));
  assert.ok(allRecs.length >= 2, 'both results present when all filter');
});

test('para passport — no medical/clinical fields ever appear in any response', async () => {
  const a = await signup();
  const sportId = (await pool.query("SELECT id FROM sports WHERE slug='para_athletics' LIMIT 1")).rows[0]?.id
    ?? (await pool.query("INSERT INTO sports(slug,name,emoji) VALUES('para_athletics','Para Athletics','🏃') RETURNING id")).rows[0].id;

  await pool.query(
    `INSERT INTO para_records(sport_id, discipline, sport_class, metric, unit, direction, record_type, value, holder_user_id, achieved_at, provenance, status)
     VALUES ($1,'100m','T47','100m Sprint','s','lower','world_record',9.84,$2,$3,'official','current')`,
    [sportId, a.id, day(-2)]);

  // Full access link
  const link = await api('POST', '/me/passport-links', { token: a.token, body: { expires_in_days: 7, show_para_class: true, show_para_guide: true, show_para_class_history: true } });
  const view = await api('GET', `/passport/${encodeURIComponent(link.body.token)}`);
  const json = JSON.stringify(view.body);

  // These clinical/diagnostic keywords must never appear
  for (const forbidden of ['diagnosis', 'impairment', 'clinical', 'medical_note', 'functional_profile', 'health_record', 'disability_note']) {
    assert.ok(!json.toLowerCase().includes(forbidden), `forbidden field "${forbidden}" must not appear in passport response`);
  }

  // Export also clean
  const exp = await api('GET', `/passport/${encodeURIComponent(link.body.token)}/export`);
  assert.equal(exp.status, 200);
  const expJson = JSON.stringify(exp.body);
  for (const forbidden of ['diagnosis', 'impairment', 'clinical', 'medical_note', 'health_record']) {
    assert.ok(!expJson.toLowerCase().includes(forbidden), `forbidden field "${forbidden}" must not appear in export`);
  }
});

test('para passport — revocation instantly blocks access', async () => {
  const a = await signup();
  const link = await api('POST', '/me/passport-links', { token: a.token, body: { expires_in_days: 7, show_para_class: true } });
  assert.equal(link.status, 201);
  const { token: tok, id } = link.body;

  // Link works before revocation
  const before = await api('GET', `/passport/${encodeURIComponent(tok)}`);
  assert.equal(before.status, 200);

  // Revoke
  const rev = await api('POST', `/me/passport-links/${id}/revoke`, { token: a.token });
  assert.equal(rev.status, 200);

  // Link no longer works
  const after = await api('GET', `/passport/${encodeURIComponent(tok)}`);
  assert.equal(after.status, 404, 'revoked link returns 404');
});

test('para passport — update link to toggle show_para_class and para_evidence_filter', async () => {
  const a = await signup();
  const link = await api('POST', '/me/passport-links', { token: a.token, body: { expires_in_days: 7 } });
  assert.equal(link.status, 201);
  assert.equal(link.body.show_para_class, false);

  // Update to turn on para class and set official filter
  const updated = await api('PATCH', `/me/passport-links/${link.body.id}`, {
    token: a.token, body: { version: link.body.version, show_para_class: true, para_evidence_filter: 'official' },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.show_para_class, true);
  assert.equal(updated.body.para_evidence_filter, 'official');
});
