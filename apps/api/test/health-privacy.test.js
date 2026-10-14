// Health-data governance across 11 countries: regimes, region + notice gate, access log, rights requests, export, incidents, posture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { REGIMES, COUNTRIES, retainUntil, requestDue, breachDue } = await import('../src/health-regimes.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `hp_${n}_${roles[0]}`, display_name: `Priv ${n}`, email: `hp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201);
  const u = { ...r.body.user, token: r.body.token };
  if (roles[0] !== 'athlete') must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: roles[0] } }), 201);
  return u;
};
const verify = (u, type, jurisdiction = null) => pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at, jurisdiction) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days', $3)", [type, u.id, jurisdiction]);
const region = (u, country) => api('POST', '/me/health/region', { token: u.token, body: { country, accept_notice: true } });
const days = (iso, from = Date.now()) => Math.round((Date.parse(iso) - from) / 864e5);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('hp_root','hp_root','{admin}','x','x','hp_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('the catalogue covers the 11 countries, is public, and every entry is complete', async () => {
  assert.deepEqual([...COUNTRIES].sort(), ['AE', 'AU', 'CA', 'CN', 'GB', 'IN', 'JP', 'MY', 'NZ', 'SG', 'US']);
  for (const r of Object.values(REGIMES)) {
    for (const k of ['laws', 'medical_bodies', 'physio_bodies']) assert.ok(r[k].length, `${r.code} ${k}`);
    assert.ok(r.regulator && r.consent.explicit && r.access_days.days > 0 && r.retention.adult_years > 0 && ['open', 'safeguards', 'restricted', 'localised'].includes(r.transfer.mode), r.code);
  }
  const all = must(await api('GET', '/health/regimes'));
  assert.equal(all.length, 11);
  assert.match(all[0].disclaimer, /not legal advice/i);
  assert.equal(must(await api('GET', '/health/regimes', { query: { country: 'ae' } }))[0].transfer.mode, 'localised');
  assert.equal((await api('GET', '/health/regimes', { query: { country: 'ZZ' } })).status, 404);
});

test('deadline maths: access, breach clocks and retention', () => {
  const t = new Date('2026-01-01T00:00:00Z');
  assert.equal(requestDue(REGIMES.MY, t).toISOString().slice(0, 10), '2026-01-22'); // 21 days
  assert.equal(requestDue(REGIMES.US, t).toISOString().slice(0, 10), '2026-01-31');
  assert.equal(breachDue(REGIMES.IN, t).toISOString(), '2026-01-04T00:00:00.000Z'); // 72h
  assert.equal(breachDue(REGIMES.CN, t), null); // "promptly", no fixed hours
  assert.equal(retainUntil(REGIMES.AE, t).getUTCFullYear(), 2051); // 25 years
  // a child's record is held until the later of last entry + adult years and their 25th birthday (GB)
  assert.equal(retainUntil(REGIMES.GB, t, '2015-06-01').toISOString().slice(0, 10), '2040-06-01');
  assert.equal(retainUntil(REGIMES.GB, t, '1990-06-01').toISOString().slice(0, 10), '2034-01-01');
});

test('choosing a country needs the notice; sharing records then requires the current notice', async () => {
  const ath = await signup(), doc = await signup(['doctor']);
  assert.equal((await api('POST', '/me/health/region', { token: ath.token, body: { country: 'GB' } })).status, 400, 'must accept');
  assert.equal((await api('POST', '/me/health/region', { token: ath.token, body: { country: 'XX', accept_notice: true } })).status, 400);
  assert.equal(must(await api('GET', '/me/health/region', { token: ath.token })).country, null);
  // no country chosen: existing behaviour is unchanged
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  // a country with no notice on file is refused until accepted
  await pool.query("UPDATE users SET health_country='GB' WHERE id=$1", [ath.id]);
  assert.equal(must(await api('GET', '/me/health/region', { token: ath.token })).needs_notice, true);
  const blocked = await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error?.code ?? blocked.body.code, 'health_notice_required');
  must(await region(ath, 'gb'), 200);
  const r = must(await api('GET', '/me/health/region', { token: ath.token }));
  assert.equal(r.needs_notice, false); assert.equal(r.regime.regulator.includes('Information Commissioner'), true);
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
});

test('remote care across countries needs a confirmation; same country or unknown does not', async () => {
  const ath = await signup(), doc = await signup(['doctor']);
  await verify(doc, 'doctor');
  const when = new Date(Date.now() + 3 * 864e5).toISOString();
  const book = (extra = {}) => api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: when, mode: 'remote', ...extra } });
  must(await region(ath, 'AU')); must(await region(doc, 'IN'));
  const x = await book();
  assert.equal(x.status, 409); assert.equal(x.body.error?.code ?? x.body.code, 'cross_border_care');
  must(await book({ acknowledge_cross_border: true }), 201);
  must(await region(doc, 'AU'));
  const when2 = new Date(Date.now() + 4 * 864e5).toISOString();
  must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: when2, mode: 'remote' } }), 201);
});

test('access log shows who used your records, never the content; rights requests, restriction and export', async () => {
  const ath = await signup(), doc = await signup(['doctor']);
  await verify(doc, 'doctor');
  must(await region(ath, 'NZ'));
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', '/medical/records', { token: doc.token, body: { athlete_id: ath.id, kind: 'checkup', summary: 'Knee stable', details: 'Secret detail' } }), 201);
  must(await api('GET', '/medical/records', { token: doc.token, query: { athlete_id: ath.id } }));
  const log = must(await api('GET', '/me/health/access-log', { token: ath.token }));
  assert.ok(log.some((l) => l.what === 'Wrote a clinical record' && l.role === 'doctor' && l.outcome === 'allowed'));
  assert.ok(log.some((l) => l.what === 'Read your health records'));
  assert.ok(!JSON.stringify(log).includes('Secret detail') && !JSON.stringify(log).includes('Knee'));
  assert.equal(must(await api('GET', '/me/health/access-log', { token: doc.token })).length, 0, 'the doctor sees only their own (none)');

  // request with the NZ deadline (20 working days -> 28 days)
  const req = must(await api('POST', '/me/health/requests', { token: ath.token, body: { kind: 'restriction', detail: 'Stop sharing my records' } }), 201);
  assert.equal(days(req.due_at), 28); assert.equal(req.country, 'NZ'); assert.equal(req.status, 'open'); assert.equal(req.detail, 'Stop sharing my records');
  assert.equal((await api('POST', '/me/health/requests', { token: ath.token, body: { kind: 'restriction' } })).status, 409, 'one open request per kind');
  assert.equal((await api('POST', '/me/health/requests', { token: ath.token, body: { kind: 'correction' } })).status, 400, 'a correction needs details');
  assert.equal((await api('GET', '/admin/health/requests', { token: ath.token })).status, 403);
  const queue = must(await api('GET', '/admin/health/requests', { token: admin.token }));
  assert.ok(queue.some((r) => r.id === req.id && r.subject_name));
  assert.equal((await api('POST', `/admin/health/requests/${req.id}/resolve`, { token: admin.token, body: { id: req.id, status: 'fulfilled' } })).status, 400, 'needs a note');
  const done = must(await api('POST', `/admin/health/requests/${req.id}/resolve`, { token: admin.token, body: { status: 'fulfilled', response: 'Sharing ended; records are held for 10 years.' } }));
  assert.equal(done.status, 'fulfilled'); assert.ok(done.retain_until.startsWith(String(new Date().getUTCFullYear() + 10)));
  // sharing ended at once, nothing deleted
  assert.equal((await api('GET', '/medical/records', { token: doc.token, query: { athlete_id: ath.id } })).status, 403);
  assert.equal(must(await api('GET', '/medical/records', { token: ath.token })).length, 1, 'the patient still has the record');
  assert.equal((await api('POST', `/admin/health/requests/${req.id}/resolve`, { token: admin.token, body: { status: 'declined', response: 'Too late now' } })).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM medical_grant_events WHERE athlete_id=$1 AND action=$2', [ath.id, 'revoke'])).rows[0].n, 1);
  assert.equal(must(await api('GET', '/me/health/requests', { token: ath.token }))[0].response, 'Sharing ended; records are held for 10 years.');

  // withdraw
  const w = must(await api('POST', '/me/health/requests', { token: ath.token, body: { kind: 'access' } }), 201);
  assert.equal(must(await api('POST', `/me/health/requests/${w.id}/withdraw`, { token: ath.token })).status, 'withdrawn');
  assert.equal((await api('POST', `/me/health/requests/${w.id}/withdraw`, { token: ath.token })).status, 409);

  // export: decrypted for the owner, recorded as a fulfilled request, and audited
  const ex = must(await api('GET', '/me/health/export', { token: ath.token }));
  assert.equal(ex.records[0].details, 'Secret detail'); assert.equal(ex.country, 'NZ');
  assert.ok(ex.sharing.history.some((h) => h.action === 'revoke'));
  assert.equal(must(await api('GET', '/me/health/requests', { token: ath.token })).filter((r) => r.kind === 'export' && r.status === 'fulfilled').length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='export_health_data'", [ath.id])).rows[0].n, 1);
  // history is append-only
  await assert.rejects(pool.query('DELETE FROM health_data_request_events'), /append-only|never deleted/);
  await assert.rejects(pool.query('DELETE FROM health_data_requests'), /never deleted/);
});

test('incident register: regulator clock per country, role limits, lifecycle and overdue flag', async () => {
  const doc = await signup(['physio']), ath = await signup();
  const body = { kind: 'misdirected_disclosure', severity: 'high', country: 'MY', affected_people: 3, occurred_at: new Date(Date.now() - 36e5).toISOString(), description: 'Plan emailed to the wrong person' };
  assert.equal((await api('POST', '/health/incidents', { token: ath.token, body })).status, 403, 'only clinicians report');
  assert.equal((await api('POST', '/health/incidents', { token: doc.token, body: { ...body, occurred_at: new Date(Date.now() + 36e5).toISOString() } })).status, 400);
  const mine = must(await api('POST', '/health/incidents', { token: doc.token, body }), 201);
  assert.ok(Math.abs(days(mine.regulator_due_at) * 24 - 72) <= 24); assert.equal(mine.description, body.description); assert.equal(mine.obligations.first_hours, 72);
  const cn = must(await api('POST', '/health/incidents', { token: doc.token, body: { ...body, country: 'CN' } }), 201);
  assert.equal(cn.regulator_due_at, null);
  const other = await signup(['doctor']);
  assert.equal(must(await api('GET', '/health/incidents', { token: other.token })).length, 0, 'clinicians see only their own');
  assert.equal(must(await api('GET', '/health/incidents', { token: admin.token })).length, 2);
  const up = (id, b) => api('POST', `/admin/health/incidents/${id}/update`, { token: admin.token, body: b });
  assert.equal((await api('POST', `/admin/health/incidents/${mine.id}/update`, { token: doc.token, body: { status: 'assessed' } })).status, 403);
  assert.equal((await up(mine.id, { status: 'notified' })).status, 400, 'say when');
  assert.equal(must(await up(mine.id, { status: 'assessed' })).status, 'assessed');
  assert.equal(must(await up(mine.id, { status: 'notified', regulator_notified_at: new Date().toISOString() })).status, 'notified');
  assert.equal(must(await up(mine.id, { status: 'closed' })).status, 'closed');
  assert.equal((await up(mine.id, { status: 'assessed' })).status, 409);
  assert.equal((await up(cn.id, { status: 'closed' })).status, 400, 'closing unnotified needs a reason');
  assert.equal(must(await up(cn.id, { status: 'closed', note: 'Assessed as not notifiable: no health data left the practice' })).status, 'closed');
  // an overdue clock is flagged
  const late = must(await api('POST', '/health/incidents', { token: doc.token, body: { ...body, country: 'IN' } }), 201);
  await pool.query("UPDATE privacy_incidents SET regulator_due_at = now() - interval '1 hour' WHERE id=$1", [late.id]);
  assert.equal(must(await api('GET', '/health/incidents', { token: doc.token, query: { status: 'open' } }))[0].regulator_overdue, true);
  assert.ok((await pool.query('SELECT count(*)::int AS n FROM privacy_incident_events WHERE incident_id=$1', [mine.id])).rows[0].n >= 4);
  await assert.rejects(pool.query('DELETE FROM privacy_incidents'), /never deleted/);
});

test('posture flags data-localisation, overdue work and missing controls; practice checklist reflects the clinician', async () => {
  const ath = await signup(), doc = await signup(['doctor']);
  must(await region(ath, 'AE'));
  const p = must(await api('GET', '/admin/health/posture', { token: admin.token }));
  const byId = Object.fromEntries(p.checks.map((c) => [c.id, c]));
  assert.equal(byId.transfer_AE.status, 'fail', 'UAE data must stay in the UAE and no hosting country is declared');
  assert.equal(byId.hosting.status, 'warn');
  assert.ok(p.people_by_country.some((x) => x.country === 'AE'));
  assert.equal((await api('GET', '/admin/health/posture', { token: ath.token })).status, 403);

  const before = must(await api('GET', '/me/health/practice-compliance', { token: doc.token }));
  assert.equal(before.ready, false); assert.equal(before.checks.find((c) => c.id === 'region').status, 'fail');
  await verify(doc, 'doctor', 'IN'); must(await region(doc, 'IN'));
  const after = must(await api('GET', '/me/health/practice-compliance', { token: doc.token }));
  const st = Object.fromEntries(after.checks.map((c) => [c.id, c.status]));
  assert.equal(st.region, 'ok'); assert.equal(st.notice, 'ok'); assert.equal(st.credential, 'ok'); assert.equal(st.licence_country, 'ok');
  assert.equal(after.regime.regulator.includes('Data Protection Board'), true);
  assert.equal((await api('GET', '/me/health/practice-compliance', { token: ath.token })).status, 403);
});
