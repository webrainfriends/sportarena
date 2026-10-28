// India omnichannel communications (issue #499): provider stubs + signed webhooks, templates, consent / STOP, quotas, idempotency, privacy,
// and the academy-fee / venue / team / event journeys through the one notification queue. Every test builds its own data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

// ---- stand-ins for the WhatsApp Business Cloud API and the SMS gateway bridge ----
let seq = 0;
const wa = { calls: [], mode: 'ok' };
const sms = { calls: [], mode: 'ok' };
const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; };
const waServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer wa-token-123456') return json(401, { error: { code: 190, message: 'bad token' } });
  if (wa.mode === 'down') return json(503, { error: { code: 2, message: 'down' } });
  if (wa.mode === 'not_on_whatsapp') return json(400, { error: { code: 131026, message: 'Message undeliverable' } });
  wa.calls.push(body);
  json(200, { messages: [{ id: `wamid.${++seq}` }] });
});
const smsServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer sms-key-123456') return json(401, { error: 'bad key' });
  if (sms.mode === 'down') return json(503, { error: 'down' });
  if (sms.mode === 'leak') return json(400, { error: `invalid destination ${body.to} (+91 98100 00099)`, code: 'E_DEST' });
  sms.calls.push({ ...body, idem: req.headers['idempotency-key'] });
  json(200, { id: `sms-${++seq}` });
});
await new Promise((r) => waServer.listen(0, '127.0.0.1', r));
await new Promise((r) => smsServer.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
  WHATSAPP_CLOUD_BASE: `http://127.0.0.1:${waServer.address().port}`, APP_URL: 'https://app.example.test', PLATFORM_APPROVALS: 'off',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { notify } = await import('../src/notify.js');
const { dispatchComms } = await import('../src/comms-dispatch.js');
const { runCollections } = await import('../src/collections.js');
const { addDays } = await import('../src/sponsor-schedule.js');
const { USE_CASES, placeholdersOf, useCaseForKind } = await import('../src/comms-catalogue.js');
const { capabilities } = await import('../src/registry.js');
const { fromLocal } = await import('../src/booking/time.js');
const { decrypt, blindIndex } = await import('../src/crypto.js');
const varsOf = (row) => JSON.parse(decrypt(row.vars_enc, 'notification_deliveries.vars'));

const WA_SECRET = 'wa-app-secret-1', SMS_HOOK = 'sms-hook-secret-1';
let server, base, n = 0, admin, waProvider, smsProvider;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const today = new Date().toISOString().slice(0, 10);
const T = (d) => addDays(today, d);
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cm_${n}`, display_name: `Aarav${n} Rao`, email: `cm${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const phone = () => `+9198${String(10000000 + Math.floor(Math.random() * 89999999))}`;

/** Create a template and (as the platform admin) activate it. */
async function template(over) {
  const uc = USE_CASES[over.use_case];
  const body = over.body;
  const t = ok(await api('POST', '/communications/templates', { token: over.token ?? admin.token, body: {
    organisation_id: over.organisation_id, use_case: over.use_case, channel: over.channel, locale: over.locale ?? 'en-IN', body,
    variables: placeholdersOf(body).map((name) => ({ name, type: uc.vars[name] })), provider_template_id: over.ptid ?? `${over.use_case}_${over.channel}`, fallback_channel: over.fallback ?? null } }), 201);
  if (over.activate !== false) ok(await api('PATCH', `/communications/templates/${t.id}`, { token: admin.token, body: { state: 'active' } }));
  return t;
}
const code = (channel) => (channel === 'sms' ? sms.calls.at(-1).text : wa.calls.at(-1).template.components[0].parameters[0].text).match(/(\d{6})/)[1];
async function optIn(user, channel, number = phone()) {
  ok(await api('POST', `/me/${channel === 'sms' ? 'sms' : 'whatsapp'}/verify`, { token: user.token, body: { phone: number } }));
  ok(await api('POST', `/me/${channel === 'sms' ? 'sms' : 'whatsapp'}/confirm`, { token: user.token, body: { code: code(channel) } }));
  return number;
}
const deliveries = (userId, kind) => pool.query("SELECT d.*, n.kind FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$1 AND d.provider IS NOT NULL AND ($2::text IS NULL OR n.kind=$2) ORDER BY d.created_at, d.channel", [userId, kind ?? null]).then((r) => r.rows);
const cycle = () => dispatchComms({ limit: 100 });
const sign = (secret, raw) => createHmac('sha256', secret).update(raw).digest('hex');
const hook = async (provider, payload, { secret, header = 'x-signature', prefix = '' } = {}) => {
  const raw = JSON.stringify(payload);
  const r = await fetch(`${base}/api/v1/webhooks/comms/${provider.kind}/${provider.id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { [header]: prefix + sign(secret, raw) } : {}) }, body: raw });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const waStatus = (ref, status, extra = {}) => ({ entry: [{ changes: [{ value: { statuses: [{ id: ref, status, timestamp: String(Date.now()), ...extra }] } }] }] });
const waHook = (payload, secret = WA_SECRET) => hook(waProvider, payload, { secret, header: 'x-hub-signature-256', prefix: 'sha256=' });
const smsHook = (events, secret = SMS_HOOK) => hook(smsProvider, { events }, { secret });
const fee = (k) => (id, extra = {}) => ({ kind: 'collections_reminder', title: 't', body: 'b', data: { organisation_id: k.org.id, ...extra }, comm: { use_case: 'fee_due' } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await signup(['athlete']);
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}', email_idx=$2 WHERE id=$1", [admin.id, (await import('../src/crypto.js')).blindIndex('rraja.edge@gmail.com')]);
  // providers, linked the way the platform admin would
  waProvider = ok(await api('POST', '/admin/communications/providers', { token: admin.token, body: { kind: 'whatsapp_cloud', label: 'Gotmygame WhatsApp', sender_label: '+91 98••• ••210', config: { phone_number_id: '1001', access_token: 'wa-token-123456', app_secret: WA_SECRET, verify_token: 'verify-token-1' } } }), 201);
  smsProvider = ok(await api('POST', '/admin/communications/providers', { token: admin.token, body: { kind: 'sms_http', label: 'SMS bridge', sender_label: 'SPTARN', config: { url: `http://127.0.0.1:${smsServer.address().port}/sms`, api_key: 'sms-key-123456', sender_id: 'SPTARN', webhook_secret: SMS_HOOK, entity_id: 'E1' } } }), 201);
  for (const channel of ['sms', 'whatsapp']) {
    await template({ use_case: 'phone_verification', channel, body: 'Your Gotmygame code is {{code}}. It works for 10 minutes.' });
  }
  await template({ use_case: 'fee_due', channel: 'sms', body: 'Hi {{first_name}}, {{amount}} for {{org_name}} is due on {{due_date}}. Pay or view: {{link}}' });
  await template({ use_case: 'fee_due', channel: 'whatsapp', body: 'Hi {{first_name}}, {{amount}} for {{org_name}} is due on {{due_date}}. Pay or view: {{link}}', fallback: 'sms' });
});
after(async () => { server.close(); waServer.close(); smsServer.close(); await pool.end(); });
const reset = () => { wa.calls.length = 0; sms.calls.length = 0; wa.mode = 'ok'; sms.mode = 'ok'; };

// ------------------------------------------------------------------------------------------------------------------ catalogue, templates, providers
test('templates are strictly typed: free text, undeclared or wrongly typed variables, and web addresses are refused', async () => {
  const mk = (body, variables, uc = 'fee_due') => api('POST', '/communications/templates', { token: admin.token, body: { use_case: uc, channel: 'sms', locale: 'en-IN', body, variables } });
  assert.equal((await mk('Hi {{first_name}}, note: {{notes}}', [{ name: 'first_name', type: 'name' }, { name: 'notes', type: 'label' }])).status, 400, 'a private note can never be a variable');
  assert.equal((await mk('Hi {{first_name}}', [])).status, 400, 'used but not declared');
  assert.equal((await mk('Hi', [{ name: 'first_name', type: 'name' }])).status, 400, 'declared but unused');
  assert.equal((await mk('Pay {{amount}}', [{ name: 'amount', type: 'label' }])).status, 400, 'amount must be a currency');
  assert.equal((await mk('Pay at https://evil.example now {{first_name}}', [{ name: 'first_name', type: 'name' }])).status, 400, 'links only through {{link}}');
  assert.equal((await mk('Hi {{first_name}}', [{ name: 'first_name', type: 'name' }], 'nonsense')).status, 400);
  const cat = ok(await api('GET', '/communications/catalogue', { token: admin.token }));
  assert.ok(cat.use_cases.length >= 15 && !cat.use_cases.some((u) => u.key === 'phone_verification'));
  assert.ok(cat.use_cases.flatMap((u) => u.variables).every((v) => ['name', 'label', 'currency', 'date', 'datetime', 'link'].includes(v.type)), 'no free-text variable type exists');
});

test('only the platform admin links providers and activates templates; credentials are write-only; a rotation keeps the history', async () => {
  const user = await signup();
  assert.equal((await api('POST', '/admin/communications/providers', { token: user.token, body: { kind: 'sms_http', label: 'x', config: {} } })).status, 403);
  assert.equal((await api('POST', '/admin/communications/providers', { token: admin.token, body: { kind: 'sms_http', label: 'bad', config: { url: 'https://x.example' } } })).status, 400, 'incomplete settings');
  const settings = ok(await api('GET', '/communications/settings', { token: admin.token }));
  assert.ok(!JSON.stringify(settings).includes('sms-key-123456') && !JSON.stringify(settings).includes(WA_SECRET), 'secrets are never returned');
  assert.ok((await pool.query('SELECT config_enc FROM comm_providers WHERE id=$1', [smsProvider.id])).rows[0].config_enc !== undefined);
  assert.ok(!(await pool.query('SELECT config_enc FROM comm_providers')).rows.some((r) => r.config_enc.includes('sms-key')), 'credentials are encrypted at rest');
  assert.ok((await pool.query('SELECT 1 FROM notification_deliveries WHERE vars_enc LIKE $1', ['%Sunrise%'])).rowCount === 0, 'template variables are encrypted at rest');
  const t = ok(await api('POST', '/communications/templates', { token: admin.token, body: { use_case: 'fee_overdue', channel: 'sms', locale: 'en-IN', body: 'Hi {{first_name}}, {{amount}} is overdue. {{link}}', variables: [{ name: 'first_name', type: 'name' }, { name: 'amount', type: 'currency' }, { name: 'link', type: 'link' }] } }), 201);
  assert.equal((await api('PATCH', `/communications/templates/${t.id}`, { token: admin.token, body: { state: 'active' } })).status, 422, 'a provider template id is required before activation');
  // rotate the SMS account: the old row is closed, not deleted
  const before = (await pool.query("SELECT count(*)::int AS n FROM comm_providers WHERE kind='sms_http'")).rows[0].n;
  const next = ok(await api('POST', '/admin/communications/providers', { token: admin.token, body: { kind: 'sms_http', label: 'SMS bridge v2', sender_label: 'SPTARN', config: { url: `http://127.0.0.1:${smsServer.address().port}/sms`, api_key: 'sms-key-123456', sender_id: 'SPTARN', webhook_secret: SMS_HOOK, entity_id: 'E1' } } }), 201);
  const rows = (await pool.query("SELECT id, effective_to FROM comm_providers WHERE kind='sms_http' ORDER BY created_at")).rows;
  assert.equal(rows.length, before + 1);
  assert.ok(rows.find((r) => r.id === smsProvider.id).effective_to, 'the previous account is closed, kept as history');
  assert.equal(rows.filter((r) => !r.effective_to).length, 1);
  smsProvider = next; // webhooks for the old account would still verify against its own secret (same here)
});

// ------------------------------------------------------------------------------------------------------------------ consent
test('SMS number: verified by a code sent over the provider; consent evidence is logged; limits stop SMS pumping', async () => {
  reset();
  const u = await signup();
  assert.equal((await api('POST', '/me/sms/verify', { token: u.token, body: { phone: '9876543210' } })).status, 400, 'a country code is required');
  const number = phone();
  ok(await api('POST', '/me/sms/verify', { token: u.token, body: { phone: number } }));
  assert.equal(sms.calls.length, 1);
  assert.equal(sms.calls[0].template_id, 'phone_verification_sms');
  assert.equal(sms.calls[0].sender, 'SPTARN');
  assert.equal((await api('POST', '/me/sms/verify', { token: u.token, body: { phone: number } })).status, 429, 'one code a minute');
  assert.equal((await api('POST', '/me/sms/confirm', { token: u.token, body: { code: '000000' } })).status, 400);
  ok(await api('POST', '/me/sms/confirm', { token: u.token, body: { code: code('sms') } }));
  const st = ok(await api('GET', '/me/sms', { token: u.token }));
  assert.equal(st.state, 'verified'); assert.ok(st.number.startsWith('+91') && !st.number.includes(number.slice(4, 9)), 'masked');
  const consents = ok(await api('GET', '/me/communication-consents', { token: u.token }));
  assert.deepEqual(consents.map((c) => [c.channel, c.action, c.source, c.basis]), [['sms', 'opt_in', 'app_verification', 'consent']]);
  assert.ok(!(await pool.query('SELECT phone_enc FROM sms_contacts WHERE user_id=$1', [u.id])).rows[0].phone_enc.includes(number.slice(3)), 'number encrypted at rest');
  // switching it off and on again through the preference screen is consent evidence too
  ok(await api('PATCH', '/me/notification-preferences', { token: u.token, body: { sms: false } }));
  ok(await api('PATCH', '/me/notification-preferences', { token: u.token, body: { sms: true } }));
  assert.deepEqual((await api('GET', '/me/communication-consents', { token: u.token })).body.map((c) => c.action).reverse(), ['opt_in', 'opt_out', 'opt_in']);
  // a person without a verified number cannot switch SMS on
  const v = await signup();
  assert.equal((await api('PATCH', '/me/notification-preferences', { token: v.token, body: { sms: true } })).status, 400);
});

test('under-18 accounts are never sent a code or a message; the guardian is messaged as themselves', async () => {
  reset();
  const kid = await signup(['athlete'], { dob: yearsAgo(11) });
  assert.equal((await api('POST', '/me/sms/verify', { token: kid.token, body: { phone: phone() } })).status, 422);
  assert.equal(sms.calls.length, 0);
  // even with a number already on file (e.g. it was verified before the date of birth was known)
  const u = await signup(); await optIn(u, 'sms'); sms.calls.length = 0;
  await pool.query("UPDATE users SET youth_until = current_date + 400 WHERE id=$1", [u.id]);
  await notify(null, u.id, { kind: 'collections_reminder', title: 't', body: 'b', data: {}, comm: { use_case: 'fee_due' } });
  assert.equal((await deliveries(u.id)).length, 0, 'no templated delivery for a minor');
});

// ------------------------------------------------------------------------------------------------------------------ the academy-fee journey through the real queue
async function club() {
  const owner = await signup(), athlete = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: 'Sunrise Academy', kind: 'academy' } }), 201);
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U14' } }), 201);
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${athlete.handle},yes` } }), 201);
  const enr = (await pool.query('SELECT * FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2', [cohort.id, athlete.id])).rows[0];
  const sched = ok(await api('POST', '/billing-schedules', { token: owner.token, body: { organisation_id: org.id, enrolment_id: enr.id, kind: 'custom', label: 'Term fee', currency: 'INR', amount_minor: 450000, due_dates: [T(2)], idempotency_key: `k-${Math.random()}` } }), 201);
  return { owner, athlete, org, cohort, sched };
}

test('academy fee reminder goes out as an approved template on WhatsApp, exactly once, with typed variables and a secure link', async () => {
  reset();
  const k = await club();
  await optIn(k.athlete, 'whatsapp'); await optIn(k.athlete, 'sms'); reset();
  await runCollections({ today: today, ownerId: k.org.id });
  const rows = await deliveries(k.athlete.id, 'collections_reminder');
  assert.equal(rows.length, 1, 'one primary channel, SMS is only the fallback');
  assert.equal(rows[0].channel, 'whatsapp'); assert.equal(rows[0].use_case, 'fee_due'); assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].organisation_id, k.org.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$1 AND d.channel='whatsapp' AND d.provider IS NULL", [k.athlete.id])).rows[0].n, 0, 'no second, free-text WhatsApp copy');
  assert.deepEqual(varsOf(rows[0]), { first_name: `Aarav${k.athlete.handle.split('_')[1]}`, amount: '₹4,500', org_name: 'Sunrise Academy', due_date: new Date(`${T(2)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }), link: varsOf(rows[0]).link });
  assert.match(varsOf(rows[0]).link, /^https:\/\/app\.example\.test\/\?open=organisation%3A/);
  // a second sweep and a second dispatch do not duplicate anything
  await runCollections({ today: today, ownerId: k.org.id });
  assert.equal((await deliveries(k.athlete.id, 'collections_reminder')).length, 1);
  await cycle(); await cycle();
  assert.equal(wa.calls.length, 1, 'the provider is called once');
  const c = wa.calls[0];
  assert.equal(c.template.name, 'fee_due_whatsapp'); assert.equal(c.template.language.code, 'en_IN');
  assert.deepEqual(c.template.components[0].parameters.map((p) => p.text).slice(0, 3), [`Aarav${k.athlete.handle.split('_')[1]}`, '₹4,500', 'Sunrise Academy']);
  assert.equal(sms.calls.length, 0);
  const d = (await deliveries(k.athlete.id, 'collections_reminder'))[0];
  assert.equal(d.status, 'sent'); assert.match(d.provider_ref, /^wamid\./);
  assert.equal(d.delivered_at, null, 'sent is not delivered');
});

test('delivery receipts are signed, replay-safe and never move a message backwards; the UI states stay honest', async () => {
  reset();
  const k = await club();
  await optIn(k.athlete, 'whatsapp'); reset();
  await runCollections({ today: today, ownerId: k.org.id }); await cycle();
  const d = (await deliveries(k.athlete.id, 'collections_reminder'))[0];
  assert.equal(d.status, 'sent');
  const listed = () => api('GET', '/communications/deliveries', { token: k.owner.token, query: { organisation_id: k.org.id } }).then((r) => ok(r));
  assert.equal((await listed())[0].state, 'sent', 'sent, not delivered');
  assert.equal((await waHook(waStatus(d.provider_ref, 'delivered'), 'wrong-secret')).status, 401, 'bad signature');
  assert.equal((await hook(waProvider, waStatus(d.provider_ref, 'delivered'))).status, 401, 'no signature');
  const first = await waHook(waStatus(d.provider_ref, 'delivered', { timestamp: '1000' }));
  assert.equal(first.status, 200); assert.equal(first.body.applied, 1);
  assert.equal((await listed())[0].state, 'delivered');
  const replay = await waHook(waStatus(d.provider_ref, 'delivered', { timestamp: '1000' }));
  assert.equal(replay.body.duplicate, 1); assert.equal(replay.body.applied, 0);
  await waHook(waStatus(d.provider_ref, 'read', { timestamp: '1001' }));
  assert.equal((await listed())[0].state, 'read');
  await waHook(waStatus(d.provider_ref, 'sent', { timestamp: '1002' }));         // late and out of order
  await waHook(waStatus(d.provider_ref, 'failed', { timestamp: '1003' }));       // cannot un-deliver
  const row = (await deliveries(k.athlete.id, 'collections_reminder'))[0];
  assert.equal(row.status, 'read'); assert.ok(row.delivered_at && row.read_at);
  // an event for a message we do not know is not recorded, so the provider's retry can still match it later
  const unknown = await waHook(waStatus('wamid.unknown', 'delivered', { timestamp: '5' }));
  assert.equal(unknown.body.unmatched, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_events WHERE event_id LIKE 'wamid.unknown%'")).rows[0].n, 0);
  // the handshake only answers for the right verify token
  const hs = (t) => fetch(`${base}/api/v1/webhooks/comms/whatsapp_cloud/${waProvider.id}?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=abc123`);
  assert.equal((await hs('nope')).status, 403); const good = await hs('verify-token-1'); assert.equal(good.status, 200); assert.equal(await good.text(), 'abc123');
  // org members who are not admins/finance, and outsiders, cannot read the activity (404, no existence leak)
  const outsider = await signup();
  assert.equal((await api('GET', '/communications/deliveries', { token: outsider.token, query: { organisation_id: k.org.id } })).status, 404);
  assert.equal((await api('GET', '/communications/deliveries', { token: k.athlete.token, query: { organisation_id: k.org.id } })).status, 404);
  const text = JSON.stringify(await listed());
  assert.ok(!/\+91\d{6}|vars|₹4,500/.test(text), 'activity never shows the phone number or message variables');
});

test('a number that is not on WhatsApp fails honestly, is suppressed for WhatsApp, and the template falls back to SMS once', async () => {
  reset();
  const k = await club();
  await optIn(k.athlete, 'whatsapp'); await optIn(k.athlete, 'sms'); reset();
  wa.mode = 'not_on_whatsapp';
  await runCollections({ today: today, ownerId: k.org.id }); await cycle();
  let rows = await deliveries(k.athlete.id, 'collections_reminder');
  assert.deepEqual(rows.map((r) => [r.channel, r.status]).sort(), [['sms', 'pending'], ['whatsapp', 'failed']]);
  assert.equal(rows.find((r) => r.channel === 'whatsapp').error_code, '131026');
  assert.equal(rows.find((r) => r.channel === 'sms').fallback_of, rows.find((r) => r.channel === 'whatsapp').id);
  await cycle(); await cycle();
  assert.equal(sms.calls.length, 1); assert.match(sms.calls[0].text, /^Hi Aarav\d+, ₹4,500 for Sunrise Academy is due on /);
  assert.equal(sms.calls[0].template_id, 'fee_due_sms'); assert.equal(sms.calls[0].entity_id, 'E1');
  assert.equal(sms.calls[0].to.startsWith('+91'), true);
  assert.equal(sms.calls[0].idem, rows.find((r) => r.channel === 'sms').id, 'the delivery id is the idempotency key');
  rows = await deliveries(k.athlete.id, 'collections_reminder');
  assert.equal(rows.find((r) => r.channel === 'sms').status, 'sent');
  assert.equal((await pool.query("SELECT reason FROM comm_suppressions WHERE channel='whatsapp' AND lifted_at IS NULL ORDER BY created_at DESC LIMIT 1")).rows[0].reason, 'invalid_number');
});

test('a provider outage or a planning fault never touches the business transaction; the delivery backs off, then succeeds', async () => {
  reset();
  const k = await club();
  await optIn(k.athlete, 'sms'); reset();
  await template({ use_case: 'sponsor_milestone', channel: 'sms', body: 'Hi {{first_name}}, there is an update on your sponsorship. {{link}}', locale: 'en-IN' }).catch(() => null); // already active from another test is fine
  const { tx } = await import('../src/db.js');
  const business = (tag) => tx(async (c) => {
    await c.query("INSERT INTO audit_log(actor_id, action, entity) VALUES ($1,$2,'test')", [k.athlete.id, tag]);
    await notify(c, k.athlete.id, { kind: 'sponsorship_update', title: 't', body: 'b', data: { organisation_id: k.org.id }, dedupe_key: tag });
  });
  // 1. the provider is down when the worker runs
  await business('outage-1');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='outage-1'")).rows[0].n, 1, 'the business change committed');
  sms.mode = 'down'; await cycle();
  let d = (await deliveries(k.athlete.id, 'sponsorship_update'))[0];
  assert.equal(d.status, 'pending'); assert.equal(d.attempts, 1); assert.match(d.last_error, /503/); assert.ok(d.next_attempt_at > new Date(), 'backs off');
  await cycle(); assert.equal((await deliveries(k.athlete.id, 'sponsorship_update'))[0].attempts, 1, 'not retried before its time');
  sms.mode = 'ok'; await pool.query('UPDATE notification_deliveries SET next_attempt_at = now() WHERE id=$1', [d.id]);
  await cycle(); await cycle();
  d = (await deliveries(k.athlete.id, 'sponsorship_update'))[0];
  assert.equal(d.status, 'sent'); assert.equal(sms.calls.filter((c) => c.reference === d.id).length, 1, 'sent once after the recovery');
  // 2. a fault inside communication planning (here: the template table is unreachable) costs the caller nothing
  await pool.query('ALTER TABLE comm_templates RENAME TO comm_templates_off');
  try { await business('outage-2'); } finally { await pool.query('ALTER TABLE comm_templates_off RENAME TO comm_templates'); }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='outage-2'")).rows[0].n, 1, 'business change committed');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND dedupe_key='outage-2'", [k.athlete.id])).rows[0].n, 1, 'the in-app notification exists');
  // 3. attempts run out: the delivery fails, is dead-lettered for an admin, and can be retried by the organisation
  await business('outage-3'); sms.mode = 'down';
  const dead = (await deliveries(k.athlete.id, 'sponsorship_update')).find((x) => x.status === 'pending');
  for (let i = 0; i < 5; i++) { await pool.query('UPDATE notification_deliveries SET next_attempt_at = now(), claimed_at = NULL WHERE id=$1', [dead.id]); await cycle(); }
  assert.equal((await pool.query('SELECT status FROM notification_deliveries WHERE id=$1', [dead.id])).rows[0].status, 'failed');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind='sms.delivery' AND status='dead'")).rows[0].n, 1);
  sms.mode = 'ok';
  assert.equal((await api('POST', `/communications/deliveries/${dead.id}/retry`, { token: k.athlete.token })).status, 404, 'someone outside the organisation cannot retry');
  ok(await api('POST', `/communications/deliveries/${dead.id}/retry`, { token: k.owner.token }));
  await cycle();
  assert.equal((await pool.query('SELECT status FROM notification_deliveries WHERE id=$1', [dead.id])).rows[0].status, 'sent');
});

// ------------------------------------------------------------------------------------------------------------------ STOP / opt-out / revocation
test('STOP by SMS reply is an immediate opt-out: queued messages are suppressed, essential ones do not override it, a fresh verification re-enables', async () => {
  reset();
  const k = await club();
  const number = await optIn(k.athlete, 'sms'); reset();
  await runCollections({ today: today, ownerId: k.org.id });
  assert.equal((await deliveries(k.athlete.id, 'collections_reminder'))[0].status, 'pending', 'queued, not yet sent');
  const digits = number.replace(/\D/g, '');
  assert.equal((await smsHook([{ id: 's1', type: 'inbound', from: `+${digits}`, text: 'hello' }], 'bad')).status, 401);
  assert.equal((await smsHook([{ id: 's1', type: 'inbound', from: `+${digits}`, text: 'hello' }])).body.optouts, 0, 'a normal reply is not an opt-out');
  const stop = await smsHook([{ id: 's2', type: 'inbound', from: `+${digits}`, text: ' stop ' }]);
  assert.equal(stop.body.optouts, 1);
  assert.equal((await smsHook([{ id: 's2', type: 'inbound', from: `+${digits}`, text: ' stop ' }])).body.duplicate, 1, 'replay-safe');
  assert.equal((await deliveries(k.athlete.id, 'collections_reminder'))[0].status, 'suppressed', 'the queued message was withdrawn');
  await cycle(); assert.equal(sms.calls.length, 0, 'nothing is sent after STOP');
  assert.equal((await api('GET', '/me/sms', { token: k.athlete.token })).body.state, 'opted_out');
  assert.equal((await api('GET', '/me/notification-preferences', { token: k.athlete.token })).body.sms, false);
  assert.deepEqual((await api('GET', '/me/communication-consents', { token: k.athlete.token })).body.map((c) => c.source).reverse(), ['app_verification', 'inbound_stop']);
  // later messages, essential or not, create nothing for that channel
  await notify(null, k.athlete.id, { kind: 'event_cancelled', title: 't', body: 'b', data: { organisation_id: k.org.id } });
  await notify(null, k.athlete.id, { kind: 'collections_reminder', title: 't', body: 'b', data: { organisation_id: k.org.id }, comm: { use_case: 'fee_due' } });
  assert.equal((await deliveries(k.athlete.id)).filter((d) => d.status === 'pending').length, 0);
  // the person proving control of the number again is a new opt-in and lifts the STOP suppression
  await pool.query("UPDATE sms_contacts SET code_sent_at = now() - interval '2 minutes' WHERE user_id=$1", [k.athlete.id]);
  ok(await api('POST', '/me/sms/verify', { token: k.athlete.token, body: { phone: number } }));
  ok(await api('POST', '/me/sms/confirm', { token: k.athlete.token, body: { code: code('sms') } }));
  assert.equal((await api('GET', '/me/sms', { token: k.athlete.token })).body.state, 'verified');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM comm_suppressions WHERE channel='sms' AND lifted_at IS NULL")).rows[0].n, 0);
});

test('removing the number in the app takes effect immediately for queued and future messages', async () => {
  reset();
  const k = await club(); await optIn(k.athlete, 'sms'); reset();
  await runCollections({ today: today, ownerId: k.org.id });
  assert.equal((await deliveries(k.athlete.id))[0].status, 'pending');
  ok(await api('DELETE', '/me/sms', { token: k.athlete.token }));
  assert.equal((await deliveries(k.athlete.id))[0].status, 'suppressed');
  await cycle(); assert.equal(sms.calls.length, 0);
});

test('category switches and language: non-essential messages are silenced, essential ones still go, and the template language falls back', async () => {
  reset();
  const k = await club();
  await optIn(k.athlete, 'whatsapp'); reset();
  ok(await api('PATCH', '/me/notification-preferences', { token: k.athlete.token, body: { comm_categories_off: ['fees'], comm_locale: 'hi-IN' } }));
  await runCollections({ today: today, ownerId: k.org.id });
  assert.equal((await deliveries(k.athlete.id, 'collections_reminder')).length, 0, 'fees category is off');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$1 AND d.channel='whatsapp' AND d.provider IS NULL", [k.athlete.id])).rows[0].n, 0, 'the legacy free-text WhatsApp path honours the category switch too');
  await template({ use_case: 'emergency_announcement', channel: 'whatsapp', body: 'Hi {{first_name}}, {{event_name}} is cancelled. Details: {{link}}' });
  const ev = ok(await api('POST', '/events', { token: k.owner.token, body: { name: 'City Cup', sport: 'tennis', capacity: 8 } }), 201);
  await notify(null, k.athlete.id, { kind: 'event_cancelled', title: 't', body: 'b', data: { event_id: ev.id } });
  const rows = await deliveries(k.athlete.id, 'event_cancelled');
  assert.equal(rows.length, 1, 'essential ignores the category switch'); assert.equal(rows[0].essential, true);
  await cycle(); assert.equal(wa.calls.length, 1);
  assert.deepEqual(wa.calls[0].template.components[0].parameters.map((p) => p.text).slice(1, 2), ['City Cup']);
  assert.equal(wa.calls[0].template.language.code, 'en_IN', 'no Hindi template exists, so it falls back to English');
});

test('a provider "user opted out" failure on a message in flight is treated as STOP', async () => {
  reset();
  const k = await club(); await optIn(k.athlete, 'whatsapp'); reset();
  await notify(null, k.athlete.id, { kind: 'event_cancelled', title: 't', body: 'b', data: { event_id: ok(await api('POST', '/events', { token: k.owner.token, body: { name: 'Stop Cup', sport: 'tennis', capacity: 8 } }), 201).id } });
  const d0 = (await deliveries(k.athlete.id, 'event_cancelled'))[0];
  wa.mode = 'ok'; await cycle();
  const d = (await deliveries(k.athlete.id, 'event_cancelled'))[0];
  assert.equal(d.id, d0.id); assert.equal(d.status, 'sent');
  // Meta reports a failure for a message that was only "sent" so far
  assert.equal((await waHook(waStatus(d.provider_ref, 'failed', { errors: [{ code: 131050 }], timestamp: '8' }))).status, 200);
  assert.equal((await deliveries(k.athlete.id, 'event_cancelled'))[0].status, 'failed');
  assert.equal((await api('GET', '/me/whatsapp', { token: k.athlete.token })).body.state, 'opted_out');
  assert.deepEqual((await api('GET', '/me/communication-consents', { token: k.athlete.token })).body.map((c) => c.source).reverse(), ['app_verification', 'provider_suppression']);
});

// ------------------------------------------------------------------------------------------------------------------ quotas and usage
test('quotas: usage is counted from the one queue, non-essential messages stop at the limit with a visible reason, essential ones do not', async () => {
  reset();
  const k = await club(); await optIn(k.athlete, 'sms'); reset();
  assert.equal((await api('POST', '/admin/communications/quotas', { token: k.owner.token, body: { organisation_id: k.org.id, channel: 'sms', monthly_limit: 1 } })).status, 403);
  ok(await api('POST', '/admin/communications/quotas', { token: admin.token, body: { organisation_id: k.org.id, channel: 'sms', monthly_limit: 1, addon_key: 'sms_pack_s' } }));
  const msg = (key) => ({ kind: 'collections_reminder', title: 't', body: 'b', data: { organisation_id: k.org.id }, dedupe_key: key, comm: { use_case: 'fee_due' } });
  // the SMS fee_due template needs amount / due date, so use the use case that only needs a link
  await template({ use_case: 'sponsor_milestone', channel: 'sms', body: 'Hi {{first_name}}, there is an update on your sponsorship. {{link}}' });
  const sp = (key) => ({ kind: 'sponsorship_update', title: 't', body: 'b', data: { organisation_id: k.org.id }, dedupe_key: key });
  await notify(null, k.athlete.id, sp('q1')); await notify(null, k.athlete.id, sp('q2'));
  const rows = (await deliveries(k.athlete.id)).filter((d) => d.use_case === 'sponsor_milestone');
  assert.deepEqual(rows.map((r) => [r.status, r.last_error]), [['pending', null], ['suppressed', 'quota_exceeded']]);
  // essential bypasses the allowance
  await template({ use_case: 'emergency_announcement', channel: 'sms', body: 'Hi {{first_name}}, {{event_name}} is cancelled. {{link}}' });
  const ev = ok(await api('POST', '/events', { token: k.owner.token, body: { name: 'Quota Cup', sport: 'tennis', capacity: 8 } }), 201);
  await notify(null, k.athlete.id, { kind: 'event_cancelled', title: 't', body: 'b', data: { event_id: ev.id, organisation_id: k.org.id } });
  assert.equal((await deliveries(k.athlete.id, 'event_cancelled'))[0].status, 'pending');
  // essential is not unbounded: it stops at twice the allowance (limit 1, two already counted)
  await notify(null, k.athlete.id, { kind: 'event_cancelled', title: 't', body: 'b', data: { event_id: ev.id, organisation_id: k.org.id }, dedupe_key: 'q-ess-2' });
  assert.deepEqual((await deliveries(k.athlete.id, 'event_cancelled')).map((r) => [r.status, r.last_error]), [['pending', null], ['suppressed', 'quota_exceeded']]);
  const usage = ok(await api('GET', '/communications/usage', { token: k.owner.token, query: { organisation_id: k.org.id } }));
  const smsUse = usage.channels.find((c) => c.channel === 'sms');
  assert.deepEqual([smsUse.used, smsUse.limit, smsUse.addon_key], [2, 1, 'sms_pack_s']);
  assert.ok(usage.by_state.some((s) => s.state === 'suppressed') && usage.by_use_case.length >= 2);
  const settings = ok(await api('GET', '/communications/settings', { token: k.owner.token, query: { organisation_id: k.org.id } }));
  assert.equal(settings.channels.find((c) => c.channel === 'sms').status, 'active');
  assert.ok(settings.recent_failures.some((f) => f.last_error === 'quota_exceeded'));
  assert.equal((await api('GET', '/communications/settings', { token: k.owner.token })).status, 400, 'organisation admins must say which organisation');
  void msg;
});

// ------------------------------------------------------------------------------------------------------------------ privacy
test('only mapped business kinds can leave as a template; private payloads never reach a message; venue staff do not get customer-style booking texts', async () => {
  reset();
  const u = await signup(); await optIn(u, 'sms'); reset();
  for (const kind of ['security_password_changed', 'appointment_reminder', 'care_plan', 'legal_matter', 'player_payout_paid', 'unmapped_new_kind']) {
    assert.equal(useCaseForKind(kind), null, `${kind} is not mapped`);
    await notify(null, u.id, { kind, title: 'Diagnosis: knee ligament', body: 'Bank account 123456789 and proposal price ₹9,99,999', data: { notes: 'private note' }, dedupe_key: `p:${kind}` });
  }
  assert.equal((await deliveries(u.id)).length, 0);
  // a caller cannot smuggle a system use case or free-text variables through `comm`
  await notify(null, u.id, { kind: 'unmapped_x', title: 't', body: 'secret body', data: { notes: 'private note' }, comm: { use_case: 'phone_verification', vars: { code: '123456' } } });
  assert.equal((await deliveries(u.id)).length, 0);
  await cycle(); // other suites' queued messages may go out now, but nothing for this person
  // sent texts only ever contain the declared, formatted variables
  const everything = JSON.stringify([...sms.calls, ...wa.calls]);
  assert.ok(!/Diagnosis|123456789|private note|secret body/.test(everything));
});

test('venue booking journey: confirmation, venue-initiated change and cancellation reach the customer by SMS; the venue team is not texted as a customer', async () => {
  reset();
  const mgr = await signup(['venue_manager']), user = await signup();
  await optIn(user, 'sms'); await optIn(mgr, 'sms'); reset();
  for (const uc of ['venue_booking', 'venue_change', 'venue_cancellation']) await template({ use_case: uc, channel: 'sms', body: `Hi {{first_name}}, ${uc.replace('_', ' ')} at {{venue_name}} on {{starts_at}}. {{link}}` });
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: 'Pune Arena', city: 'Pune', address: '1 MG Road', latitude: 18.52, longitude: 73.85, timezone: 'Asia/Kolkata', currency: 'INR' } }), 201);
  ok(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const res = ok(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'basketball', hourly_rate_cents: 100000, max_players: 10 } }), 201);
  const at = (d, h) => fromLocal(T(d), h * 60, 'Asia/Kolkata').toISOString();
  const r = ok(await api('POST', '/reservations', { token: user.token, body: { items: [{ resource_id: res.id, starts_at: at(3, 8), ends_at: at(3, 9) }] } }), 201);
  assert.equal((await deliveries(user.id, 'reservation_confirmed')).length, 1);
  ok(await api('PATCH', `/bookings/${r.bookings[0].id}`, { token: mgr.token, body: { starts_at: at(3, 18), ends_at: at(3, 19) } }));
  const changed = await deliveries(user.id, 'booking_modified');
  assert.equal(changed.length, 1); assert.equal(changed[0].use_case, 'venue_change'); assert.equal(changed[0].essential, true, 'a venue-initiated change is operational');
  await cycle();
  const texts = sms.calls.map((c) => c.text);
  assert.ok(texts.some((t) => /venue booking at Pune Arena on /.test(t)) && texts.some((t) => /venue change at Pune Arena on /.test(t)), JSON.stringify(texts));
  assert.equal((await deliveries(mgr.id)).length, 0, 'staff notifications about the same booking are not customer messages');
});

test('team, event and sponsor use cases share the same delivery service; links open authorised in-app detail', async () => {
  reset();
  const owner = await signup(), p = await signup(); await optIn(p, 'sms'); reset();
  await template({ use_case: 'match_selection', channel: 'sms', body: 'Hi {{first_name}}, you are selected for {{team_name}}. {{link}}' });
  const team = ok(await api('POST', '/teams', { token: owner.token, body: { name: 'Pune Panthers', sport: 'football' } }), 201);
  await notify(null, p.id, { kind: 'team_selection', title: 'x', body: 'y', data: { team_id: team.id } });
  await cycle();
  assert.match(sms.calls.at(-1).text, /^Hi Aarav\d+, you are selected for Pune Panthers\. https:\/\/app\.example\.test\/\?open=notifications$/);
});

// ------------------------------------------------------------------------------------------------------------------ platform surface
test('every communications capability is on REST, OpenAPI and MCP with a token scope; the webhooks are signature-gated routes, not tools', async () => {
  const comm = capabilities.filter((c) => c.tag === 'Communications');
  assert.ok(comm.length >= 16);
  const spec = ok(await api('GET', '/openapi.json'));
  for (const c of comm) assert.ok(spec.paths[c.path.replace(/:(\w+)/g, '{$1}')]?.[c.method.toLowerCase()], `${c.name} missing from OpenAPI`);
  assert.ok(comm.every((c) => ['read', 'write', 'admin'].includes(c.scope)));
  assert.equal(comm.filter((c) => c.path.startsWith('/admin')).every((c) => c.scope === 'admin'), true);
  assert.ok(!capabilities.some((c) => c.path.includes('/webhooks/comms')));
});

test('legacy OpenWA WhatsApp is untouched: kinds without a template still use the free-text allow-list path', async () => {
  const { whatsappKind } = await import('../src/whatsapp.js');
  assert.equal(whatsappKind('booking_reminder'), true); assert.equal(whatsappKind('security_password_changed'), false);
  assert.equal(Object.keys(USE_CASES).every((k) => !/^security/.test(k)), true, 'no security use case: one-time secrets never ride on WhatsApp or SMS');
});

// ------------------------------------------------------------------------------------------------------------------ regressions from the independent review
test('a name that carries a web address is never sent: the message is held with a visible reason', async () => {
  reset();
  const k = await club(); await optIn(k.athlete, 'sms'); reset();
  await template({ use_case: 'emergency_announcement', channel: 'sms', body: 'Hi {{first_name}}, {{event_name}} is cancelled. {{link}}', activate: true }).catch(() => null);
  const ev = ok(await api('POST', '/events', { token: k.owner.token, body: { name: 'Win now bit.ly/x', sport: 'tennis', capacity: 8 } }), 201);
  await notify(null, k.athlete.id, { kind: 'event_cancelled', title: 't', body: 'b', data: { event_id: ev.id, organisation_id: k.org.id } });
  const rows = await deliveries(k.athlete.id, 'event_cancelled');
  assert.deepEqual(rows.map((r) => [r.status, r.last_error]), [['suppressed', 'invalid_variable: event_name']]);
  assert.equal((await api('POST', '/communications/templates', { token: admin.token, body: { use_case: 'fee_due', channel: 'sms', locale: 'hi-IN', body: 'Hi {{first_name}} pay at bit.ly/pay {{link}}', variables: [{ name: 'first_name', type: 'name' }, { name: 'link', type: 'link' }] } })).status, 400, 'a bare domain in a template body is refused');
});

test('events and teams owned by an organisation are attributed to it (its quota, its activity list)', async () => {
  reset();
  const k = await club(); await optIn(k.athlete, 'sms'); reset();
  const ev = ok(await api('POST', '/events', { token: k.owner.token, body: { name: 'Sunrise Cup', sport: 'tennis', capacity: 8 } }), 201);
  await pool.query('UPDATE events SET organisation_id=$2 WHERE id=$1', [ev.id, k.org.id]);
  await template({ use_case: 'emergency_announcement', channel: 'sms', body: 'Hi {{first_name}}, {{event_name}} is cancelled. {{link}}', activate: true }).catch(() => null);
  await notify(null, k.athlete.id, { kind: 'event_cancelled', title: 't', body: 'b', data: { event_id: ev.id } });
  const d = (await deliveries(k.athlete.id, 'event_cancelled'))[0];
  assert.equal(d.organisation_id, k.org.id);
  assert.equal(ok(await api('GET', '/communications/deliveries', { token: k.owner.token, query: { organisation_id: k.org.id } })).some((x) => x.id === d.id), true, 'visible to the organisation');
});

test('venue staff never get a customer-style booking text, whichever variables the template declares', async () => {
  reset();
  const mgr = await signup(['venue_manager']), user = await signup();
  await optIn(mgr, 'sms'); await optIn(user, 'sms'); reset();
  await template({ use_case: 'venue_cancellation', channel: 'sms', locale: 'hi-IN', body: 'Hi {{first_name}}, your booking was cancelled. {{link}}' });
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: 'Staff Arena', city: 'Pune', address: '1 MG Road', latitude: 18.52, longitude: 73.85, timezone: 'Asia/Kolkata', currency: 'INR' } }), 201);
  ok(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const res = ok(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'basketball', hourly_rate_cents: 100000, max_players: 10 } }), 201);
  const at = (d, h) => fromLocal(T(d), h * 60, 'Asia/Kolkata').toISOString();
  const r = ok(await api('POST', '/reservations', { token: user.token, body: { items: [{ resource_id: res.id, starts_at: at(4, 8), ends_at: at(4, 9) }] } }), 201);
  const data = { booking_id: r.bookings[0].id, reservation_id: r.id, venue_id: v.id };
  await notify(null, mgr.id, { kind: 'booking_cancelled', title: 'A booking was cancelled', body: 'b', data });
  assert.equal((await deliveries(mgr.id)).length, 0, 'the venue manager is not the customer');
  await pool.query("UPDATE notification_prefs SET comm_locale='hi-IN' WHERE user_id=$1", [user.id]).catch(() => null);
  await pool.query("INSERT INTO notification_prefs(user_id, sms, comm_locale) VALUES ($1,true,'hi-IN') ON CONFLICT (user_id) DO UPDATE SET comm_locale='hi-IN'", [user.id]);
  await notify(null, user.id, { kind: 'booking_cancelled', title: 'Your booking was cancelled', body: 'b', data });
  assert.equal((await deliveries(user.id, 'booking_cancelled')).length, 1, 'the customer is');
});

test('a receipt is matched to the provider account that sent the message, and a long-retired account stops being believed', async () => {
  reset();
  const k = await club(); await optIn(k.athlete, 'whatsapp'); reset();
  await runCollections({ today, ownerId: k.org.id }); await cycle();
  const d = (await deliveries(k.athlete.id, 'collections_reminder'))[0];
  assert.equal(d.provider_account_id, waProvider.id);
  // an organisation's own, separately signed account cannot touch a message sent through the platform account
  const mine = ok(await api('POST', '/admin/communications/providers', { token: admin.token, body: { kind: 'whatsapp_cloud', organisation_id: k.org.id, label: 'Own WA', config: { phone_number_id: '2002', access_token: 'wa-token-123456', app_secret: 'other-app-secret-9', verify_token: 'other-verify-9' } } }), 201);
  const res = await hook(mine, waStatus(d.provider_ref, 'delivered', { timestamp: '99' }), { secret: 'other-app-secret-9', header: 'x-hub-signature-256', prefix: 'sha256=' });
  assert.equal(res.status, 200); assert.equal(res.body.unmatched, 1); assert.equal(res.body.applied, 0);
  assert.equal((await deliveries(k.athlete.id, 'collections_reminder'))[0].status, 'sent');
  // retire it long ago: its secret is no longer accepted at all
  await pool.query("UPDATE comm_providers SET effective_to = now() - interval '20 days' WHERE id=$1", [mine.id]);
  assert.equal((await hook(mine, waStatus(d.provider_ref, 'delivered', { timestamp: '100' }), { secret: 'other-app-secret-9', header: 'x-hub-signature-256', prefix: 'sha256=' })).status, 401);
  await pool.query("UPDATE comm_providers SET effective_to = now() WHERE id=$1 AND effective_to IS NULL", [mine.id]);
});

test('retry only re-sends what the provider never accepted and whose fallback has not been sent; provider error text never shows a phone number', async () => {
  reset();
  const k = await club(); await optIn(k.athlete, 'sms'); reset();
  await template({ use_case: 'sponsor_milestone', channel: 'sms', body: 'Hi {{first_name}}, there is an update on your sponsorship. {{link}}', activate: true }).catch(() => null);
  sms.mode = 'leak';
  await notify(null, k.athlete.id, { kind: 'sponsorship_update', title: 't', body: 'b', data: { organisation_id: k.org.id }, dedupe_key: 'leak-1' });
  await cycle();
  const d = (await deliveries(k.athlete.id, 'sponsorship_update'))[0];
  assert.equal(d.status, 'failed'); assert.equal(d.error_code, 'E_DEST');
  assert.ok(!/\d{6}/.test(d.last_error) && /\[number\]/.test(d.last_error), `the number is scrubbed: ${d.last_error}`);
  const listed = ok(await api('GET', '/communications/deliveries', { token: k.owner.token, query: { organisation_id: k.org.id, state: 'failed' } }));
  assert.ok(listed.length >= 1 && !/\d{6}/.test(JSON.stringify(listed)));
  sms.mode = 'ok';
  ok(await api('POST', `/communications/deliveries/${d.id}/retry`, { token: k.owner.token }));
  await cycle();
  assert.equal((await deliveries(k.athlete.id, 'sponsorship_update'))[0].status, 'sent');
  // a message the provider accepted (it has a reference) cannot be retried
  assert.equal((await api('POST', `/communications/deliveries/${d.id}/retry`, { token: k.owner.token })).status, 404);
  // platform-level deliveries (no organisation) are invisible to everyone but the platform admin
  const plain = await signup(); await optIn(plain, 'sms'); reset(); sms.mode = 'leak';
  await notify(null, plain.id, { kind: 'sponsorship_update', title: 't', body: 'b', data: {}, dedupe_key: 'leak-2' }); await cycle(); sms.mode = 'ok';
  const orphan = (await deliveries(plain.id, 'sponsorship_update'))[0];
  assert.equal(orphan.status, 'failed'); assert.equal(orphan.organisation_id, null);
  assert.equal((await api('POST', `/communications/deliveries/${orphan.id}/retry`, { token: k.owner.token })).status, 404, 'no existence leak');
  ok(await api('POST', `/communications/deliveries/${orphan.id}/retry`, { token: admin.token }));
});

test('verification codes: no number is texted more than three times a day across accounts, and a blocked number is never texted', async () => {
  reset();
  const number = phone();
  const users = [await signup(), await signup(), await signup(), await signup()];
  const statuses = [];
  for (const u of users) statuses.push((await api('POST', '/me/sms/verify', { token: u.token, body: { phone: number } })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(sms.calls.length, 3);
  const blocked = phone(); const u2 = await signup();
  await pool.query("INSERT INTO comm_suppressions(phone_idx, channel, reason, source) VALUES ($1,'sms','invalid_number','provider')", [blindIndex(blocked.replace(/\D/g, ''))]);
  assert.equal((await api('POST', '/me/sms/verify', { token: u2.token, body: { phone: blocked } })).status, 422);
});

test('the legacy free-text WhatsApp path also stays quiet for a suppressed number', async () => {
  reset();
  const u = await signup(); await optIn(u, 'whatsapp');
  await pool.query("INSERT INTO comm_suppressions(phone_idx, channel, reason, source) SELECT phone_idx, 'whatsapp', 'provider_blocked', 'test' FROM whatsapp_contacts WHERE user_id=$1", [u.id]);
  await notify(null, u.id, { kind: 'booking_reminder', title: 't', body: 'b', data: {} });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$1 AND d.channel='whatsapp'", [u.id])).rows[0].n, 0);
});
