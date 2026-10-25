import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { expandLine } = await import('../src/sponsor-schedule.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fx_${n}_${roles[0]}`, display_name: `Followup ${n}`, email: `fx${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `XBrand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  return { sponsor, ath, b };
};
const period = { starts_on: '2030-01-01', ends_on: '2030-12-31' };
const deal = async (w, line) => {
  const d = must(await api('POST', '/sponsorships', { token: w.sponsor.token, body: { sponsor_id: w.b.id, target_type: 'athlete', target_id: w.ath.id, deliverables: 'Support', ...period, lines: [line] } }), 201);
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: w.ath.token, body: { status: 'active', version: 1 } }));
  return d;
};
const goodsLine = { kind: 'goods', label: 'Kit', quantity: 10, unit: 'pcs', cadence: 'once', first_due_on: '2030-02-01', estimate_cents: 50000, currency: 'SGD' };
const svcLine = (service_type, quantity = 2) => ({ kind: 'service', service_type, label: `${service_type} support`, quantity, cadence: 'once', first_due_on: '2030-03-01', estimate_cents: 30000, currency: 'SGD' });
const due = async (w, d) => must(await api('GET', '/sponsorship-obligations', { token: w.ath.token, query: { sponsorship_id: d.id } })).obligations[0];
const view = async (token, d) => must(await api('GET', `/sponsorships/${d.id}`, { token }));
const send = (w, o, body) => api('POST', `/sponsorship-obligations/${o.id}/deliveries`, { token: w.sponsor.token, body });
const recv = (w, dl, body) => api('PATCH', `/sponsorship-deliveries/${dl.id}`, { token: w.ath.token, body: { status: 'received', ...body } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64');
const file = (name = 'damage.png') => ({ file_name: name, data: PNG });
const receivedGoods = async (w, quantity = 6) => {
  const d = await deal(w, goodsLine), o = await due(w, d);
  const dl = must(await send(w, o, { quantity }), 201);
  must(await recv(w, dl, {}));
  return { d, o, dl };
};
const ret = (w, dl, body, token = w.ath.token) => api('POST', `/sponsorship-deliveries/${dl.id}/returns`, { token, body });

test('a disputed return opens one case in the dispute system and both sides see its status', async () => {
  const w = await world(), { d, dl } = await receivedGoods(w);
  const r = must(await ret(w, dl, { quantity: 2, reason: 'damaged', evidence_url: 'https://x.example/dmg.jpg', files: [file()], consent: true }), 201);
  const out = must(await api('PATCH', `/sponsorship-delivery-returns/${r.id}`, { token: w.sponsor.token, body: { status: 'disputed', note: 'Packed as shipped', expected_version: 1 } }));
  assert.equal(out.status, 'disputed'); assert.ok(out.dispute.case_no, 'a case was opened');
  const link = (await pool.query('SELECT * FROM sponsorship_disputes WHERE return_id=$1', [r.id])).rows;
  assert.equal(link.length, 1); assert.equal(link[0].subject_type, 'goods'); assert.equal(link[0].delivery_id, dl.id);
  const ev = (await pool.query('SELECT file_name, reference_enc FROM case_evidence WHERE case_id=$1 ORDER BY created_at', [link[0].case_id])).rows;
  assert.equal(ev.length, 2, 'the uploaded file and the link travel with the case');
  assert.ok(ev.some((e) => e.file_name === 'damage.png'));
  for (const token of [w.sponsor.token, w.ath.token]) {
    const ret0 = (await view(token, d)).obligations[0].returns[0];
    assert.equal(ret0.dispute.case_no, out.dispute.case_no); assert.equal(ret0.dispute.status, 'open');
  }
  assert.equal((await api('PATCH', `/sponsorship-delivery-returns/${r.id}`, { token: w.sponsor.token, body: { status: 'disputed', note: 'again' } })).status, 409, 'decided once: no second case');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_disputes WHERE return_id=$1', [r.id])).rows[0].n, 1);
  assert.equal((await due(w, d)).returned_quantity, 0, 'a dispute never changes the quantities');
  // a general dispute on the same delivery stays possible: only one case per return is enforced
  const gen = await api('POST', `/sponsorships/${d.id}/disputes`, { token: w.ath.token, body: { subject_type: 'goods', subject_id: dl.id, title: 'Shipment problem', description: 'Whole shipment late' } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
});

test('return evidence files: validated, consented, encrypted, both sides read them, outsiders cannot', async () => {
  const w = await world(), { d, dl } = await receivedGoods(w);
  assert.equal((await ret(w, dl, { quantity: 1, reason: 'damaged', files: [file()] })).status, 400, 'consent is required');
  assert.equal((await ret(w, dl, { quantity: 1, reason: 'damaged', files: [{ file_name: 'x.exe', data: Buffer.alloc(64, 7).toString('base64') }], consent: true })).status, 400, 'only PDF/JPEG/PNG/WebP');
  const r = must(await ret(w, dl, { quantity: 1, reason: 'damaged', files: [file()], consent: true }), 201);
  const stored = (await pool.query('SELECT file_enc, added_by, consent_at FROM sponsorship_return_files WHERE return_id=$1', [r.id])).rows[0];
  assert.ok(stored.consent_at && stored.added_by === w.ath.id, 'provenance recorded');
  assert.ok(!stored.file_enc.includes(PNG.slice(0, 20)), 'file is encrypted at rest');
  const meta = (await view(w.sponsor.token, d)).obligations[0].returns[0].files;
  assert.equal(meta.length, 1); assert.equal(meta[0].file_name, 'damage.png'); assert.equal('data' in meta[0], false, 'the deal view carries no file bytes');
  const get = (token) => api('GET', `/sponsorship-delivery-returns/${r.id}/files/${meta[0].id}`, { token });
  assert.equal(must(await get(w.sponsor.token)).data, PNG);
  assert.equal(must(await get(w.ath.token)).data, PNG);
  const outsider = await signup(['athlete']);
  assert.equal((await get(outsider.token)).status, 403);
  assert.equal((await api('POST', `/sponsorship-delivery-returns/${r.id}/files`, { token: outsider.token, body: { files: [file()], consent: true } })).status, 403);
  // the sponsor may add a counter-photo; a decided return takes no more
  must(await api('POST', `/sponsorship-delivery-returns/${r.id}/files`, { token: w.sponsor.token, body: { files: [file('packing.png')], consent: true } }), 201);
  must(await api('PATCH', `/sponsorship-delivery-returns/${r.id}`, { token: w.sponsor.token, body: { status: 'accepted' } }));
  assert.equal((await api('POST', `/sponsorship-delivery-returns/${r.id}/files`, { token: w.ath.token, body: { files: [file()], consent: true } })).status, 409);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='sponsorship.return_file_read'")).rowCount >= 2, 'reads are audit-logged');
});

test('coaching vouchers link one own confirmed coaching session, once; other kinds refuse it', async () => {
  const w = await world();
  const dv = await deal(w, svcLine('coaching', 2)), ov = await due(w, dv);
  const { rows: [sp] } = await pool.query('SELECT id FROM sports LIMIT 1');
  const coach = await signup(['coach']);
  const hire = async (hirer, status) => (await pool.query("INSERT INTO coach_hires(hirer_id, coach_id, sport_id, starts_at, duration_min, rate_cents_hour, total_cents, status) VALUES ($1,$2,$3,'2031-01-01 10:00+00',60,0,0,$4) RETURNING id", [hirer, coach.id, sp.id, status])).rows[0].id;
  const mine = await hire(w.ath.id, 'confirmed'), pending = await hire(w.ath.id, 'requested'), notMine = await hire(coach.id, 'confirmed');
  const vs = must(await api('POST', `/sponsorship-obligations/${ov.id}/vouchers`, { token: w.sponsor.token, body: { count: 2 } }), 201).vouchers;
  const red = (v, body, token = w.ath.token) => api('POST', `/sponsorship-vouchers/${v.id}/redeem`, { token, body });
  assert.equal((await red(vs[0], { idempotency_key: 'h-aaaaaaaa', hire_id: notMine })).status, 400, "someone else's session");
  assert.equal((await red(vs[0], { idempotency_key: 'h-aaaaaaaa', hire_id: pending })).status, 400, 'not confirmed yet');
  must(await red(vs[0], { idempotency_key: 'h-aaaaaaaa', hire_id: mine }));
  assert.equal((await red(vs[1], { idempotency_key: 'h-bbbbbbbb', hire_id: mine })).status, 409, 'one session funds one voucher');
  const v = (await view(w.ath.token, dv)).obligations[0].vouchers.find((x) => x.id === vs[0].id);
  assert.equal(v.has_session, true);
  const sv = (await view(w.sponsor.token, dv)).obligations[0].vouchers.find((x) => x.id === vs[0].id);
  assert.equal(sv.has_session, false, 'the sponsor learns only that it was used'); assert.equal(sv.reference, null);
  const w2 = await world(), dm = await deal(w2, svcLine('medical', 1)), om = await due(w2, dm);
  const [mv] = must(await api('POST', `/sponsorship-obligations/${om.id}/vouchers`, { token: w2.sponsor.token, body: { count: 1 } }), 201).vouchers;
  assert.equal((await red(mv, { idempotency_key: 'h-cccccccc', hire_id: mine }, w2.ath.token)).status, 400, 'medical carries no detail');
  const w3 = await world(), dt = await deal(w3, svcLine('travel', 1)), ot = await due(w3, dt);
  const [tv] = must(await api('POST', `/sponsorship-obligations/${ot.id}/vouchers`, { token: w3.sponsor.token, body: { count: 1 } }), 201).vouchers;
  assert.equal((await red(tv, { idempotency_key: 'h-dddddddd', hire_id: mine }, w3.ath.token)).status, 400, 'a travel voucher is not a coaching session');
});

test('export: authorized sides only, tenant isolated, no evidence or detail, formula-safe', async () => {
  const w = await world(), { d, dl } = await receivedGoods(w);
  must(await ret(w, dl, { quantity: 1, reason: 'damaged', note: 'SECRET-NOTE', files: [file()], consent: true }), 201);
  const sv = await deal(w, svcLine('medical', 1)), os = await due(w, sv);
  const [mv] = must(await api('POST', `/sponsorship-obligations/${os.id}/vouchers`, { token: w.sponsor.token, body: { count: 1 } }), 201).vouchers;
  must(await api('POST', `/sponsorship-vouchers/${mv.id}/redeem`, { token: w.ath.token, body: { idempotency_key: 'e-aaaaaaaa' } }));
  const exp = (token, id = d.id) => api('GET', `/sponsorships/${id}/fulfilment/export`, { token });
  const mine = must(await exp(w.sponsor.token));
  assert.match(mine.csv, /^kind,label,status,quantity/); assert.match(mine.csv, /delivery,Kit,received,6/); assert.match(mine.csv, /return,Kit,requested,1/);
  assert.equal(/SECRET-NOTE|damage\.png/.test(mine.csv), false, 'no notes or evidence');
  assert.equal(must(await exp(w.ath.token)).rows, mine.rows, 'the recipient may export too');
  assert.match(must(await exp(w.ath.token, sv.id)).csv, /voucher,medical support,redeemed,1,1,medical/);
  const outsider = await signup(['athlete']), other = await signup(['sponsor']);
  assert.equal((await exp(outsider.token)).status, 403);
  assert.equal((await exp(other.token)).status, 403);
  const admin = { token: await signToken({ id: (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('fx_root','fx_root','{admin}','x','x','fx_root') RETURNING id")).rows[0].id, roles: ['admin'] }) };
  assert.ok([403, 404].includes((await exp(admin.token)).status), 'platform staff are not on either side');
});

test('migration 109 is additive: the earlier return, voucher and dispute shapes still work', async () => {
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='sponsorship_voucher_redemptions'")).rows.map((r) => r.column_name);
  for (const c of ['booking_id', 'reference', 'hire_id']) assert.ok(cols.includes(c));
  assert.ok((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='sponsorship_disputes' AND column_name='return_id'")).rowCount);
});
