// Country health-privacy compliance for the doctors module (docs/health-compliance.md): regime registry, region choice and notice,
// cross-border sharing and telehealth rules, patient rights requests, accounting of disclosures, complete export, breach register.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { config } = await import('../src/config.js');
const { REGIMES, REGIME_CODES, regimeOf, breachClocks, hostingRegimes } = await import('../src/health/regimes.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `hp_${n}_${roles[0]}`, display_name: `Priv ${n}`, email: `hp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const pro = async (country, role = 'doctor') => {
  const u = await signup([role]);
  must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role } }), 201);
  await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at, jurisdiction) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days', $3)", [role, u.id, country]);
  return u;
};
const patient = async (country = 'SG') => {
  const a = await signup(['athlete']);
  must(await api('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'football', role: 'athlete' } }), 201);
  if (country) must(await api('POST', '/medical/privacy', { token: a.token, body: { regime: country, accept_notice: true, hosting_transfer_ack: true } }));
  return a;
};
const futureAt = (d) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(10, 0, 0, 0); return x.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('hp_root');
});
after(async () => { server.close(); await pool.end(); });

test('the registry covers the eleven countries with the facts the product needs', () => {
  assert.deepEqual([...REGIME_CODES].sort(), ['AE', 'AU', 'CA', 'CN', 'GB', 'IN', 'JP', 'MY', 'NZ', 'SG', 'US']);
  for (const r of Object.values(REGIMES)) {
    for (const k of ['name', 'laws', 'regulators', 'medical_bodies', 'data_class', 'consent_basis', 'minors', 'retention', 'deadlines', 'respond_days', 'cross_border', 'telehealth', 'rights', 'localisation']) assert.ok(r[k] != null && r[k].length !== 0, `${r.code}.${k}`);
    assert.ok(r.deadlines.some((d) => d.audience === 'regulator') && r.deadlines.some((d) => d.audience === 'individuals'), `${r.code} has both clocks`);
    assert.ok(r.retention.years > 0 && r.respond_days > 0);
  }
  assert.equal(REGIMES.AE.localisation, 'strict'); assert.equal(REGIMES.CN.localisation, 'strict');
  assert.equal(regimeOf('uk'), 'GB'); assert.equal(regimeOf('India'), 'IN'); assert.equal(regimeOf('AU-NSW'), 'AU'); assert.equal(regimeOf('Atlantis'), null); assert.equal(regimeOf(null), null);
  assert.deepEqual(hostingRegimes({ env: {}, kmsRegion: 'ap-southeast-1' }), ['SG']);
  assert.deepEqual(hostingRegimes({ env: { HEALTH_HOSTING_REGIONS: 'uae, india' }, kmsRegion: 'ap-southeast-1' }), ['AE', 'IN']);
});

test('breach clocks use the legal hours where fixed and the platform target otherwise', () => {
  const t0 = '2026-01-01T00:00:00.000Z';
  const k = breachClocks(['GB', 'US', 'CA'], t0);
  const gb = k.find((x) => x.regime === 'GB' && x.audience === 'regulator');
  assert.equal(gb.due_at, '2026-01-04T00:00:00.000Z'); assert.equal(gb.legal, true);
  const ca = k.find((x) => x.regime === 'CA' && x.audience === 'regulator');
  assert.equal(ca.due_at, null); assert.equal(ca.legal, false); assert.equal(ca.target_at, '2026-01-04T00:00:00.000Z');
  assert.equal(k.find((x) => x.regime === 'US' && x.audience === 'individuals').due_at, '2026-03-02T00:00:00.000Z');
});

test('list_health_regimes is public and honest about where data is hosted', async () => {
  const r = must(await api('GET', '/health-regimes'));
  assert.equal(r.regimes.length, 11); assert.ok(r.disclaimer.includes('not legal advice')); assert.deepEqual(r.hosted_in, ['SG']);
  const one = must(await api('GET', '/health-regimes', { query: { code: 'jp' } }));
  assert.equal(one.regimes[0].name, 'Japan');
});

test('choosing a country: notice is mandatory, a transfer must be agreed, in-country regimes are refused when not hosted there', async () => {
  const a = await signup(['athlete']);
  assert.equal(must(await api('GET', '/medical/privacy', { token: a.token })).profile, null);
  assert.equal((await api('POST', '/medical/privacy', { token: a.token, body: { regime: 'SG', accept_notice: false } })).status, 400);
  assert.equal((await api('POST', '/medical/privacy', { token: a.token, body: { regime: 'XX', accept_notice: true } })).status, 400);
  const need = await api('POST', '/medical/privacy', { token: a.token, body: { regime: 'JP', accept_notice: true } });
  assert.equal(need.status, 409); assert.equal(need.body.error.details.reason, 'transfer_ack_required');
  const ae = await api('POST', '/medical/privacy', { token: a.token, body: { regime: 'AE', accept_notice: true, hosting_transfer_ack: true } });
  assert.equal(ae.status, 409); assert.equal(ae.body.error.details.reason, 'localisation_unmet');
  must(await api('POST', '/medical/privacy', { token: a.token, body: { regime: 'JP', accept_notice: true, hosting_transfer_ack: true } }));
  const home = must(await api('POST', '/medical/privacy', { token: a.token, body: { regime: 'SG', accept_notice: true } }));
  assert.equal(home.hosted_in_my_country, true);
  const me = must(await api('GET', '/medical/privacy', { token: a.token }));
  assert.equal(me.profile.regime, 'SG'); assert.equal(me.profile.hosting_transfer_ack_at, null); assert.equal(me.available.find((x) => x.code === 'AE').selectable, false); assert.equal(me.available.find((x) => x.code === 'JP').needs_transfer_ack, true);
  const hist = (await pool.query("SELECT action, regime FROM health_privacy_events WHERE user_id=$1 ORDER BY id", [a.id])).rows.map((r) => `${r.action}:${r.regime}`);
  assert.deepEqual(hist.filter((h) => h.startsWith('set_region')), ['set_region:JP', 'set_region:SG']);
  await assert.rejects(pool.query('DELETE FROM health_privacy_events WHERE user_id=$1', [a.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM health_privacy_profiles WHERE user_id=$1', [a.id]), /never deleted/);
});

test('sharing records across a border needs the patient\'s acknowledgement and is recorded on the grant', async () => {
  const ath = await patient('SG');
  const local = await pro('SG'), foreign = await pro('IN'), unknown = await pro(null);
  const g1 = must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: local.id } }), 201);
  assert.equal(g1.cross_border, false);
  const stop = await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: foreign.id } });
  assert.equal(stop.status, 409); assert.equal(stop.body.error.details.reason, 'cross_border_ack_required'); assert.equal(stop.body.error.details.provider_regime, 'IN');
  const g2 = must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: foreign.id, cross_border_ack: true } }), 201);
  assert.equal(g2.cross_border, true);
  assert.equal((await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: unknown.id } })).status, 409);
  const row = (await pool.query('SELECT patient_regime, provider_regime, cross_border_ack_at FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2', [ath.id, foreign.id])).rows[0];
  assert.equal(row.patient_regime, 'SG'); assert.equal(row.provider_regime, 'IN'); assert.ok(row.cross_border_ack_at);
  const me = must(await api('GET', '/medical/privacy', { token: ath.token }));
  assert.deepEqual(me.cross_border_shares.map((s) => s.provider_id), [foreign.id]);
});

test('a patient with no country behaves exactly as before', async () => {
  const ath = await patient(null), doc = await pro('IN');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
});

test('an in-country regime (UAE) shares only with a provider registered there, and remote visits need a local provider', async () => {
  config.clinical.hostingRegions.push('AE', 'SG');
  try {
    const ath = await patient('AE');
    const local = await pro('UAE'), foreign = await pro('GB');
    const blocked = await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: foreign.id, cross_border_ack: true } });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error.details.reason, 'cross_border_blocked');
    must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: local.id } }), 201);
    const remote = await api('POST', '/appointments', { token: ath.token, body: { provider_id: foreign.id, starts_at: futureAt(3), mode: 'remote' } });
    assert.equal(remote.status, 400); assert.match(remote.body.error.message, /registered in United Arab Emirates/);
    must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: local.id, starts_at: futureAt(3), mode: 'remote' } }), 201);
    must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: foreign.id, starts_at: futureAt(4), mode: 'in_person' } }), 201);
  } finally { config.clinical.hostingRegions.length = 0; }
});

test('rights requests: due date from the country, no duplicates, self-serve answers, platform team resolves and restriction stops sharing', async () => {
  const ath = await signup(['athlete']);
  assert.equal((await api('POST', '/medical/privacy/requests', { token: ath.token, body: { kind: 'access' } })).status, 409);   // choose a country first
  must(await api('POST', '/medical/privacy', { token: ath.token, body: { regime: 'MY', accept_notice: true, hosting_transfer_ack: true } }));
  const doc = await pro('MY');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  const req = must(await api('POST', '/medical/privacy/requests', { token: ath.token, body: { kind: 'restriction', detail: 'Please stop all sharing' } }), 201);
  assert.equal(req.status, 'open'); assert.equal(req.statutory, false === REGIMES.MY.rights.includes('restriction') ? false : true);
  const days = Math.round((Date.parse(req.due_at) - Date.now()) / 864e5);
  assert.equal(days, 21);                                         // Malaysia: 21 days
  assert.equal((await api('POST', '/medical/privacy/requests', { token: ath.token, body: { kind: 'restriction' } })).status, 409);
  // only the platform team answers
  assert.equal((await api('POST', `/admin/health/privacy-requests/${req.id}/resolve`, { token: ath.token, body: { status: 'fulfilled', note: 'done by me' } })).status, 403);
  assert.equal((await api('POST', `/admin/health/privacy-requests/${req.id}/resolve`, { token: admin.token, body: { status: 'refused' } })).status, 400);   // a refusal needs a reason
  const queue = must(await api('GET', '/admin/health/privacy-requests', { token: admin.token }));
  assert.ok(queue.some((q) => q.id === req.id && q.person));
  must(await api('POST', `/admin/health/privacy-requests/${req.id}/resolve`, { token: admin.token, body: { status: 'in_review', note: 'Looking into it' } }));
  const done = must(await api('POST', `/admin/health/privacy-requests/${req.id}/resolve`, { token: admin.token, body: { status: 'fulfilled', note: 'All sharing stopped. Records are kept for 7 years as the law requires.' } }));
  assert.equal(done.status, 'fulfilled'); assert.equal(done.grants_revoked, 1);
  assert.equal((await api('GET', '/medical/records', { token: doc.token, query: { athlete_id: ath.id } })).status, 403);   // access really ended
  const mine = must(await api('GET', '/medical/privacy/requests', { token: ath.token }));
  assert.equal(mine[0].status, 'fulfilled'); assert.match(mine[0].resolution, /kept for 7 years/); assert.equal(mine[0].detail, 'Please stop all sharing');
  assert.equal((await api('POST', `/admin/health/privacy-requests/${req.id}/resolve`, { token: admin.token, body: { status: 'refused', note: 'too late now' } })).status, 409);
  // the person can withdraw their own open request, history stays
  const r2 = must(await api('POST', '/medical/privacy/requests', { token: ath.token, body: { kind: 'complaint', detail: 'A concern' } }), 201);
  assert.equal(must(await api('POST', `/medical/privacy/requests/${r2.id}/withdraw`, { token: ath.token })).status, 'withdrawn');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM health_privacy_request_events WHERE request_id=$1', [r2.id])).rows[0].n, 2);
  // the stored request text is encrypted
  const raw = (await pool.query('SELECT detail_enc FROM health_privacy_requests WHERE id=$1', [req.id])).rows[0].detail_enc;
  assert.ok(!raw.includes('stop all sharing'));
});

test('accounting of disclosures lists who opened or wrote to my data, never clinical content, and answers the request', async () => {
  const ath = await patient('SG'), doc = await pro('SG');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', '/medical/records', { token: doc.token, body: { athlete_id: ath.id, kind: 'checkup', summary: 'Secret knee finding', details: 'Very private details' } }), 201);
  must(await api('GET', '/medical/records', { token: doc.token, query: { athlete_id: ath.id } }));
  must(await api('GET', '/medical/records', { token: ath.token }));                      // my own read is not a disclosure
  must(await api('POST', '/medical/privacy/requests', { token: ath.token, body: { kind: 'accounting' } }), 201);
  const d = must(await api('GET', '/medical/disclosures', { token: ath.token }));
  const rec = d.entries.filter((e) => e.area === 'Medical records');
  assert.deepEqual(rec.map((e) => e.what).sort(), ['Added or changed', 'Opened']);
  assert.ok(rec.every((e) => e.who === doc.display_name && e.roles.includes('doctor')));
  assert.ok(!JSON.stringify(d).includes('Secret knee finding'));
  assert.ok(d.sharing.some((s) => s.action === 'grant' && s.provider_name === doc.display_name));
  assert.equal(must(await api('GET', '/medical/privacy/requests', { token: ath.token }))[0].status, 'fulfilled');
});

test('the export is complete for the patient and never leaks a doctor\'s patients into the doctor\'s own export', async () => {
  const ath = await patient('SG'), doc = await pro('SG');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', '/medical/records', { token: doc.token, body: { athlete_id: ath.id, kind: 'injury', summary: 'Sprained ankle grade 2' } }), 201);
  must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: futureAt(5), reason: 'Ankle pain when running' } }), 201);
  const req = must(await api('POST', '/medical/privacy/requests', { token: ath.token, body: { kind: 'access' } }), 201);
  assert.equal(req.self_serve, 'export_my_health_data');
  const x = must(await api('GET', '/medical/export', { token: ath.token }));
  assert.equal(x.privacy.country, 'SG');
  assert.ok(x.records.some((r) => r.summary === 'Sprained ankle grade 2'));
  assert.ok(x.appointments.some((a) => a.reason === 'Ankle pain when running'));
  assert.ok(x.sharing.grants.some((g) => g.provider_id === doc.id));
  assert.ok(x.disclosures.entries.length >= 1);
  for (const k of ['consultation_summaries', 'care_plans', 'tests_and_results', 'allergies_problems_medicines', 'referrals', 'fit_to_play', 'follow_ups', 'exercise_plans', 'event_medical_log', 'privacy_requests']) assert.ok(k in x, k);
  assert.equal(must(await api('GET', '/medical/privacy/requests', { token: ath.token }))[0].status, 'fulfilled');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='export_health_data'", [ath.id])).rows[0].n, 1);
  // the doctor's own export holds none of the patient's data
  const dx = must(await api('GET', '/medical/export', { token: doc.token }));
  const text = JSON.stringify(dx);
  assert.ok(!text.includes('Sprained ankle') && !text.includes('Ankle pain'), 'no patient data in a provider\'s own export');
  assert.deepEqual(dx.appointments, []);
});

test('event coverage: a participant sees who opened the event medical log and gets their own incident in the export', async () => {
  const ath = await patient('SG'), org = await signup(['organizer']), medic = await pro('SG', 'physio');
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Privacy Cup', sport: 'football', starts_on: '2026-12-01', ends_on: '2026-12-02' } }), 201);
  const part = (await pool.query("INSERT INTO event_participants(event_id, user_id, full_name) VALUES ($1,$2,'Priv Athlete') RETURNING id", [ev.id, ath.id])).rows[0];
  const inc = (await pool.query("INSERT INTO event_medical_incidents(event_id, participant_id, reporter_id, severity, outcome, summary_enc, details_enc) VALUES ($1,$2,$3,'minor','treated_on_site',$4,$5) RETURNING id", [ev.id, part.id, medic.id, (await import('../src/crypto.js')).encrypt('Cut above the eye', 'event_medical_incidents.summary'), (await import('../src/crypto.js')).encrypt('Steri-strips applied', 'event_medical_incidents.details')])).rows[0];
  await pool.query("INSERT INTO audit_log(actor_id, action, entity, entity_id) VALUES ($1,'write_clinical','event_medical_incidents',$2), ($1,'read_clinical','event_medical_incidents',$3)", [medic.id, inc.id, ev.id]);
  const d = must(await api('GET', '/medical/disclosures', { token: ath.token }));
  const log = d.entries.filter((e) => e.area === 'Event medical log');
  assert.deepEqual(log.map((e) => e.what).sort(), ['Added or changed', 'Opened']);
  assert.ok(log.every((e) => e.who === medic.display_name));
  const x = must(await api('GET', '/medical/export', { token: ath.token }));
  assert.equal(x.event_medical_log.length, 1); assert.equal(x.event_medical_log[0].summary, 'Cut above the eye'); assert.equal(x.event_medical_log[0].event, 'Privacy Cup');
  // someone else's export never carries it
  const other = await patient('SG');
  assert.equal(must(await api('GET', '/medical/export', { token: other.token })).event_medical_log.length, 0);
});

test('breach register: a clock per country and audience, closing needs every notice handled, affected people read only the notice text', async () => {
  const ath = await patient('SG'), other = await patient('JP');
  const body = { discovered_at: new Date(Date.now() - 80 * 36e5).toISOString(), scope: 'records', regimes: ['SG', 'IN'], affected_count: 12, severity: 'high', summary: 'A staff laptop with a cached export was lost in transit.', containment: 'Sessions revoked and keys rotated.' };
  assert.equal((await api('POST', '/admin/health/breaches', { token: ath.token, body })).status, 403);
  assert.equal((await api('POST', '/admin/health/breaches', { token: admin.token, body: { ...body, regimes: ['SG', 'ZZ'] } })).status, 400);
  assert.equal((await api('POST', '/admin/health/breaches', { token: admin.token, body: { ...body, scope: 'event_coverage' } })).status, 400);   // needs the event
  const b = must(await api('POST', '/admin/health/breaches', { token: admin.token, body }), 201);
  assert.equal(b.notices.length, 4);
  const sgReg = b.notices.find((x) => x.regime === 'SG' && x.audience === 'regulator');
  assert.equal(sgReg.state, 'overdue_legal');                                   // 72h clock, discovered 80h ago
  assert.equal(b.worst, 'overdue_legal');
  assert.equal(b.summary, body.summary);
  const raw = (await pool.query('SELECT summary_enc FROM health_breaches WHERE id=$1', [b.id])).rows[0].summary_enc;
  assert.ok(!raw.includes('laptop'));
  const upd = (notice, extra = {}) => api('POST', `/admin/health/breaches/${b.id}`, { token: admin.token, body: { ...(notice ? { notice } : {}), ...extra } });
  assert.equal((await upd({ regime: 'SG', audience: 'regulator', outcome: 'not_required' })).status, 400);               // reason needed
  assert.equal((await upd({ regime: 'SG', audience: 'individuals', outcome: 'sent', reference: 'short' })).status, 400);   // the text people read
  must(await upd({ regime: 'SG', audience: 'regulator', outcome: 'sent', reference: 'PDPC-2026-001' }));
  assert.equal((await upd({ regime: 'SG', audience: 'regulator', outcome: 'sent', reference: 'again' })).status, 409);
  const closed = await upd(null, { status: 'closed' });
  assert.equal(closed.status, 409); assert.equal(closed.body.error.details.open_notices, 3);
  assert.deepEqual(must(await api('GET', '/medical/privacy/notices', { token: ath.token })), []);   // not told yet
  must(await upd({ regime: 'SG', audience: 'individuals', outcome: 'sent', reference: 'A lost laptop held a copy of some records. Change your password and contact us with questions.' }));
  const sgNotices = must(await api('GET', '/medical/privacy/notices', { token: ath.token }));
  assert.equal(sgNotices.length, 1); assert.match(sgNotices[0].notice, /lost laptop/); assert.ok(!('what_happened' in sgNotices[0])); assert.ok(!JSON.stringify(sgNotices).includes('staff laptop'));
  assert.deepEqual(must(await api('GET', '/medical/privacy/notices', { token: other.token })), []);   // Japan was not affected
  must(await upd({ regime: 'IN', audience: 'regulator', outcome: 'not_required', reason: 'No Indian residents were in the affected set.' }));
  must(await upd({ regime: 'IN', audience: 'individuals', outcome: 'not_required', reason: 'No Indian residents were in the affected set.' }));
  const fin = must(await upd(null, { status: 'closed' }));
  assert.equal(fin.status, 'closed'); assert.equal(fin.open_notices, 0);
  assert.equal(must(await api('GET', '/admin/health/breaches', { token: admin.token })).some((x) => x.id === b.id), false);          // closed leaves the open list…
  assert.equal(must(await api('GET', '/admin/health/breaches', { token: admin.token, query: { status: 'closed' } })).some((x) => x.id === b.id), true);   // …but is kept
  await assert.rejects(pool.query('DELETE FROM health_breaches WHERE id=$1', [b.id]), /never deleted/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='health_breach'", [ath.id])).rows[0].n, 1);
});

test('MCP and OpenAPI expose the new capabilities with the right scopes', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const doc = buildOpenApi();
  const ops = Object.fromEntries(Object.values(doc.paths).flatMap((p) => Object.values(p)).map((o) => [o.operationId, o]));
  for (const name of ['list_health_regimes', 'get_my_health_privacy', 'set_my_health_region', 'create_health_privacy_request', 'list_health_disclosures', 'export_my_health_data', 'report_health_breach', 'list_health_breaches', 'update_health_breach', 'list_my_health_notices', 'resolve_health_privacy_request']) assert.ok(ops[name], name);
  assert.equal(ops.export_my_health_data['x-required-scope'], 'clinical');
  assert.equal(ops.report_health_breach['x-required-scope'], 'admin');
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_health_regimes', arguments: { code: 'NZ' } } }) });
  assert.match(JSON.stringify(await r.json()), /New Zealand/);
});
