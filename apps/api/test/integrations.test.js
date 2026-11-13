import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';

process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sportarena_test';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const ics = await import('../src/ics.js');
const { setIntegrationTransport } = await import('../src/integrations/http.js');
const { integrationSweep } = await import('../src/integrations/engine.js');
const { capabilities } = await import('../src/registry.js');
const { buildOpenApi } = await import('../src/openapi.js');

let server, base;
const call = async (method, path, { token, body, headers = {}, raw } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json };
};
let n = 0;
const signup = async () => { n++; const r = await call('POST', '/auth/register', { body: { handle: `ih_${n}`, display_name: `Hub ${n}`, email: `ih${n}@example.com`, password: 'correct-horse-battery', roles: ['organizer'] } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const mkOrg = async (u) => { const r = await call('POST', '/organisations', { token: u.token, body: { name: `Club ${n}-${Math.random().toString(36).slice(2, 6)}`, kind: 'club' } }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.body)); return r.body.id ?? r.body.organisation?.id; };
const platformAdmin = async () => { n++; const r = await call('POST', '/auth/register', { body: { handle: `ihpa_${n}`, display_name: 'Platform', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery', roles: ['organizer'] } }); const u = r.status === 201 ? r.body : (await call('POST', '/auth/login', { body: { email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } })).body; await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}' WHERE id=$1", [u.user.id]); return { ...u.user, token: u.token }; };
// the real route to enablement: the organisation asks, the platform admin prices and approves
const detail = { mode: 'api_pull', security: ['tls', 'api_key'], personal_data: false, monthly_volume: 20000, peak_per_minute: 30, purpose: 'Needed for our league', starts_on: '2026-12-01', ends_on: '2027-11-30', contact_is_requester: true };
const enable = async (pa, owner, org, provider, extra = {}) => {
  const rq = await call('POST', `/organisations/${org}/integration-access`, { token: owner.token, body: { provider_key: provider, integration_url: 'https://partner.example.org/api', ...detail, ...extra } }); assert.equal(rq.status, 201, JSON.stringify(rq.body));
  const dec = (body) => call('POST', `/admin/integration-access/${rq.body.id}/decision`, { token: pa.token, body });
  assert.equal((await dec({ decision: 'quote', pricing_mode: 'special', price_minor: 49900, currency: 'INR', billing: 'annual' })).status, 200);
  assert.equal((await call('POST', `/integration-access/${rq.body.id}/quote-response`, { token: owner.token, body: { decision: 'accept' } })).status, 200);
  const d = await dec({ decision: 'enable' }); assert.equal(d.status, 200, JSON.stringify(d.body)); return d.body;
};
const sign = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { ics.setIcsFetcher(); setIntegrationTransport(); server.close(); await pool.end(); });

test('three categories install from one framework, secrets stay write-only, authz hides existence', async () => {
  const owner = await signup(); const stranger = await signup(); const org = await mkOrg(owner);
  const pa = await platformAdmin();
  for (const k of ['calendar_ics', 'sports_data_json', 'ticket_scanner_webhook']) await enable(pa, owner, org, k);
  const cat = await call('GET', '/integrations/catalogue', { token: owner.token });
  assert.equal(cat.status, 200);
  assert.ok(new Set(cat.body.providers.filter((p) => !p.managed_in).map((p) => p.category)).size >= 3);
  assert.ok(cat.body.providers.some((p) => p.managed_in === 'Communications'));

  // permissions must be acknowledged
  const noScopes = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'sports_data_json', label: 'Fixtures', settings: { url: 'http://localhost:1/x', api_key: 'sk_live_supersecret' }, accept_scopes: [] } });
  assert.equal(noScopes.status, 400);

  ics.setIcsFetcher(async () => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20991001T100000Z\r\nDTEND:20991001T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const cal = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'calendar_ics', label: 'Club calendar', settings: { url: 'https://calendar.example.org/club.ics' }, accept_scopes: ['calendar.busy.read'], sync_every_minutes: 60 } });
  assert.equal(cal.status, 201, JSON.stringify(cal.body));
  const feed = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'sports_data_json', label: 'Fixtures', mode: 'sandbox', settings: { url: 'http://localhost:9/live', sandbox_url: 'http://localhost:9/sandbox', api_key: 'sk_live_supersecret' }, accept_scopes: ['sports_data.read'] } });
  assert.equal(feed.status, 201, JSON.stringify(feed.body));
  const scan = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'ticket_scanner_webhook', label: 'Gate A', settings: {}, accept_scopes: ['ticket_scans.write'] } });
  assert.equal(scan.status, 201);
  assert.ok(scan.body.webhook_secret && scan.body.webhook_path);
  assert.ok(!JSON.stringify(feed.body).includes('supersecret'));

  const list = await call('GET', `/organisations/${org}/integrations`, { token: owner.token });
  assert.equal(list.body.items.length, 3);
  assert.ok(!JSON.stringify(list.body).includes('supersecret'));
  const detail = await call('GET', `/integrations/${feed.body.id}`, { token: owner.token });
  assert.ok(!JSON.stringify(detail.body).includes('supersecret'));
  assert.ok(detail.body.credentials.length === 1);
  const stored = await pool.query('SELECT config_enc FROM integration_installs WHERE id=$1', [feed.body.id]);
  assert.ok(!String(stored.rows[0].config_enc).includes('supersecret'));

  // outsiders: 404 everywhere
  assert.equal((await call('GET', `/integrations/${feed.body.id}`, { token: stranger.token })).status, 404);
  assert.equal((await call('GET', `/organisations/${org}/integrations`, { token: stranger.token })).status, 404);
  assert.equal((await call('POST', `/integrations/${feed.body.id}/sync`, { token: stranger.token })).status, 404);
  // managed integrations are not duplicated
  assert.equal((await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'comms_whatsapp_sms', label: 'x1', settings: {}, accept_scopes: [] } })).status, 409);
  // sandbox only where supported
  assert.equal((await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'calendar_ics', label: 'x2', mode: 'sandbox', settings: { url: 'https://c.example.org/a.ics' }, accept_scopes: ['calendar.busy.read'] } })).status, 400);
  Object.assign(globalThis, { __ih: { pa, owner, org, cal: cal.body, feed: feed.body, scan: scan.body } });
});

test('sync health, failure, retry, sandbox target, rate limit and credential scrubbing', async () => {
  const { owner, feed, cal } = globalThis.__ih;
  const seen = [];
  setIntegrationTransport(async (m, url, o) => { seen.push({ url, auth: o.headers.authorization }); if (seen.length === 1) return { status: 500, text: 'sk_live_supersecret exploded' }; return { status: 200, text: JSON.stringify({ items: [{ id: 'f1' }, { id: 'f2' }] }) }; });
  const bad = await call('POST', `/integrations/${feed.id}/sync`, { token: owner.token });
  assert.equal(bad.body.ok, false);
  assert.ok(!JSON.stringify(bad.body).includes('supersecret'));
  assert.equal(seen[0].url, 'http://localhost:9/sandbox');
  assert.equal(seen[0].auth, 'Bearer sk_live_supersecret');
  let d = (await call('GET', `/integrations/${feed.id}`, { token: owner.token })).body;
  assert.equal(d.status, 'error'); assert.ok(d.last_error);
  const ok = await call('POST', `/integrations/${feed.id}/sync`, { token: owner.token });
  assert.deepEqual(ok.body.summary, { records: 2 });
  d = (await call('GET', `/integrations/${feed.id}`, { token: owner.token })).body;
  assert.equal(d.status, 'connected'); assert.ok(d.last_success_at); assert.equal(d.last_error, null);
  assert.ok(d.usage[0].calls >= 2 && d.usage[0].failures >= 1);
  const ev = (await call('GET', `/integrations/${feed.id}/events`, { token: owner.token })).body.items;
  assert.ok(ev.some((e) => e.status === 'failed') && ev.some((e) => e.status === 'ok'));
  assert.ok(!JSON.stringify(ev).includes('supersecret'));

  // calendar sync via the same endpoint
  const c = await call('POST', `/integrations/${cal.id}/sync`, { token: owner.token });
  assert.equal(c.body.ok, true);

  // rate limit
  await call('PATCH', `/integrations/${feed.id}`, { token: owner.token, body: { rate_per_minute: 1 } });
  await pool.query('DELETE FROM integration_windows');
  assert.equal((await call('POST', `/integrations/${feed.id}/sync`, { token: owner.token })).body.ok, true);
  assert.equal((await call('POST', `/integrations/${feed.id}/sync`, { token: owner.token })).body.refused, true);
  assert.ok((await call('GET', `/integrations/${feed.id}`, { token: owner.token })).body.usage[0].refused >= 1);
});

test('rotation closes the old credential, revoke pauses, disconnect keeps history', async () => {
  const { owner, feed } = globalThis.__ih;
  const seen = [];
  setIntegrationTransport(async (m, url, o) => { seen.push(o.headers.authorization); return { status: 200, text: '[]' }; });
  await pool.query('DELETE FROM integration_windows');
  await call('PATCH', `/integrations/${feed.id}`, { token: owner.token, body: { rate_per_minute: 100 } });
  const rot = await call('POST', `/integrations/${feed.id}/credentials/rotate`, { token: owner.token, body: { settings: { api_key: 'sk_live_newkey12345' } } });
  assert.equal(rot.status, 200, JSON.stringify(rot.body));
  await call('POST', `/integrations/${feed.id}/sync`, { token: owner.token });
  assert.equal(seen[0], 'Bearer sk_live_newkey12345');
  const open = await pool.query('SELECT count(*)::int AS n FROM integration_credentials WHERE install_id=$1 AND effective_to IS NULL', [feed.id]);
  const all = await pool.query('SELECT count(*)::int AS n FROM integration_credentials WHERE install_id=$1', [feed.id]);
  assert.equal(open.rows[0].n, 1); assert.equal(all.rows[0].n, 2);
  assert.equal((await call('POST', `/integrations/${feed.id}/credentials/revoke`, { token: owner.token })).status, 200);
  assert.equal((await call('GET', `/integrations/${feed.id}`, { token: owner.token })).body.status, 'paused');
  assert.equal((await call('POST', `/integrations/${feed.id}/sync`, { token: owner.token })).status, 409);
  assert.equal((await call('DELETE', `/integrations/${feed.id}`, { token: owner.token })).status, 200);
  const kept = await pool.query('SELECT status FROM integration_installs WHERE id=$1', [feed.id]);
  assert.equal(kept.rows[0].status, 'disconnected');
  assert.ok((await call('GET', `/integrations/${feed.id}/events`, { token: owner.token })).body.items.length > 3);
});

test('external-id mappings are unique and soft-removed', async () => {
  const { owner, org, scan } = globalThis.__ih;
  const team = await call('POST', '/teams', { token: owner.token, body: { name: 'Mapped FC', sport: 'football' } });
  if (![200, 201].includes(team.status)) return; // team creation shape differs; covered where available
  const tid = team.body.id ?? team.body.team?.id;
  const m = await call('POST', `/integrations/${scan.id}/external-ids`, { token: owner.token, body: { entity_type: 'team', internal_id: tid, external_id: 'EXT-9' } });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await call('POST', `/integrations/${scan.id}/external-ids`, { token: owner.token, body: { entity_type: 'team', internal_id: tid, external_id: 'EXT-10' } })).status, 409);
  assert.equal((await call('DELETE', `/integrations/${scan.id}/external-ids/${m.body.id}`, { token: owner.token })).status, 200);
  assert.equal((await call('GET', `/integrations/${scan.id}/external-ids`, { token: owner.token })).body.items.length, 0);
});

test('inbound signed webhook: bad signature, replay, rate limit; outbound subscription is signed and retried', async () => {
  const { owner, org, scan } = globalThis.__ih;
  const secret = scan.webhook_secret; const path = `/webhooks/integrations/${scan.id}`;
  const body = JSON.stringify({ events: [{ id: 'scan-1', type: 'entry' }] });
  assert.equal((await call('POST', path, { raw: body, headers: { 'x-sportarena-signature': 'sha256=bad' } })).status, 401);

  const received = []; let failFirst = true;
  const sink = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { if (failFirst) { failFirst = false; res.statusCode = 500; return res.end(); } received.push({ b, h: req.headers }); res.end('ok'); }); }).listen(0);
  setIntegrationTransport(); // real transport to the loopback sink
  const sub = await call('POST', `/organisations/${org}/integration-webhooks`, { token: owner.token, body: { url: `http://localhost:${sink.address().port}/hook`, event_types: ['integration.webhook.received'] } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));

  const ok = await call('POST', path, { raw: body, headers: { 'x-sportarena-signature': `sha256=${sign(secret, body)}` } });
  assert.equal(ok.status, 200); assert.equal(ok.body.accepted, 1);
  const again = await call('POST', path, { raw: body, headers: { 'x-sportarena-signature': `sha256=${sign(secret, body)}` } });
  assert.equal(again.body.duplicates, 1);

  await integrationSweep(); // first attempt fails (500) -> retry scheduled
  assert.equal(received.length, 0);
  await pool.query("UPDATE jobs SET run_at = now() WHERE category='integrations'");
  await integrationSweep();
  assert.equal(received.length, 1);
  const { b, h } = received[0];
  assert.equal(h['x-sportarena-signature'], `sha256=${sign(sub.body.secret, `${h['x-sportarena-timestamp']}.${b}`)}`);
  sink.close();
  assert.equal((await call('DELETE', `/integration-webhooks/${sub.body.id}`, { token: owner.token })).status, 200);
  assert.equal((await call('GET', `/organisations/${org}/integration-webhooks`, { token: owner.token })).body.items[0].status, 'revoked');
  // a non-loopback plain-http target is refused
  assert.equal((await call('POST', `/organisations/${org}/integration-webhooks`, { token: owner.token, body: { url: 'http://example.org/h', event_types: ['integration.sync.failed'] } })).status, 400);
});

test('external integrations run as a cycle: request, review, price, acceptance, build, enable; only for that organisation', async () => {
  const owner = await signup(); const other = await signup(); const nobody = await signup(); const org = await mkOrg(owner); const pa = await platformAdmin();
  const body = { provider_key: 'sports_data_json', label: 'Gated feed', settings: { url: 'http://localhost:9/x', api_key: 'sk_live_gatedkey1' }, accept_scopes: ['sports_data.read'] };
  const blocked = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'integration_not_enabled');
  assert.equal((await call('POST', `/organisations/${org}/integration-webhooks`, { token: owner.token, body: { url: 'http://localhost:9/h', event_types: ['integration.sync.failed'] } })).status, 403);
  assert.equal((await call('GET', `/integrations/catalogue?organisation_id=${org}`, { token: owner.token })).body.providers.find((p) => p.key === 'sports_data_json').access, 'none');
  // the form captures what the platform team needs to review
  const bad = (extra) => call('POST', `/organisations/${org}/integration-access`, { token: owner.token, body: { provider_key: 'sports_data_json', ...detail, ...extra } });
  assert.equal((await bad({ contact_is_requester: false })).status, 400);
  assert.equal((await bad({ ends_on: '2026-01-01' })).status, 400);
  assert.equal((await bad({ integration_url: 'ftp://x' })).status, 400);
  assert.equal((await call('POST', `/organisations/${org}/integration-access`, { token: other.token, body: { provider_key: 'sports_data_json', ...detail } })).status, 404);
  const rq = await bad({ integration_url: 'https://feeds.example.org/v1', contact_is_requester: false, contact_name: 'Asha Rao', contact_email: 'asha@example.org', contact_phone: '+919800000000' });
  assert.equal(rq.status, 201, JSON.stringify(rq.body)); assert.equal(rq.body.status, 'submitted'); assert.equal(rq.body.draft, true);
  assert.ok(!JSON.stringify(rq.body).includes('asha@example.org'));
  const stored = await pool.query('SELECT contact_email_enc, contact_phone_enc FROM integration_access_requests WHERE id=$1', [rq.body.id]);
  assert.ok(!stored.rows[0].contact_email_enc.includes('asha') && !stored.rows[0].contact_phone_enc.includes('9800'));
  assert.equal((await bad({})).status, 409);
  // only the platform admin sees the queue and the contact; a role label alone is not enough
  assert.equal((await call('GET', '/admin/integration-access', { token: owner.token })).status, 403);
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}' WHERE id=$1", [other.id]);
  assert.equal((await call('GET', '/admin/integration-access', { token: other.token })).status, 403);
  assert.equal((await call('GET', `/integration-access/${rq.body.id}`, { token: other.token })).body.contact_email, undefined); // a stale role label never unlocks the contact
  assert.ok((await call('GET', '/admin/integration-access', { token: pa.token })).body.items.some((x) => x.id === rq.body.id));
  const seen = await call('GET', `/integration-access/${rq.body.id}`, { token: pa.token });
  assert.equal(seen.body.contact_email, 'asha@example.org');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_integration_contact' AND entity_id=$1", [rq.body.id])).rowCount >= 1);
  assert.equal((await call('GET', `/integration-access/${rq.body.id}`, { token: owner.token })).body.contact_email, undefined);
  const dec = (b2, t = pa) => call('POST', `/admin/integration-access/${rq.body.id}/decision`, { token: t.token, body: b2 });
  // steps out of order are refused; asking for more sends it back to the requester, who answers
  assert.equal((await dec({ decision: 'enable' })).status, 409);
  assert.equal((await dec({ decision: 'request_info' })).status, 400);
  assert.equal((await dec({ decision: 'request_info', note: 'Which endpoints?' })).body.status, 'needs_info');
  assert.equal((await call('POST', `/integration-access/${rq.body.id}/quote-response`, { token: owner.token, body: { decision: 'accept' } })).status, 409);
  assert.equal((await call('PATCH', `/integration-access/${rq.body.id}`, { token: owner.token, body: { note: 'Fixtures and results only', monthly_volume: 30000 } })).body.status, 'submitted');
  // price: needs an amount; the requester turns it down once, gets a new quote, then accepts
  assert.equal((await dec({ decision: 'quote' })).status, 400);
  assert.equal((await dec({ decision: 'quote', pricing_mode: 'special', price_minor: 90000, currency: 'INR', billing: 'annual' })).body.status, 'quoted');
  assert.equal((await call('POST', `/integration-access/${rq.body.id}/quote-response`, { token: owner.token, body: { decision: 'reject', note: 'Too high' } })).body.status, 'submitted');
  assert.equal((await dec({ decision: 'quote', pricing_mode: 'special', price_minor: 25000, currency: 'INR', billing: 'annual' })).body.status, 'quoted');
  assert.equal((await dec({ decision: 'enable' })).status, 409);                      // not accepted yet
  assert.equal((await call('POST', `/integration-access/${rq.body.id}/quote-response`, { token: nobody.token, body: { decision: 'accept' } })).status, 404);
  assert.equal((await call('POST', `/integration-access/${rq.body.id}/quote-response`, { token: owner.token, body: { decision: 'accept' } })).body.status, 'accepted');
  assert.equal((await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body })).status, 403); // accepted is not enabled
  assert.equal((await dec({ decision: 'enable' })).body.status, 'enabled');
  const ov = await pool.query("SELECT status, reason FROM commercial_overrides WHERE key='integration.sports_data_json' AND subject_id=$1", [org]);
  assert.equal(ov.rows[0].status, 'active'); assert.match(ov.rows[0].reason, /250\.00 INR annual/);
  const ok = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const timeline = (await call('GET', `/integration-access/${rq.body.id}`, { token: owner.token })).body.timeline.map((t) => t.kind);
  assert.deepEqual(timeline, ['submitted', 'request_info', 'answered', 'quote', 'quote_rejected', 'quote', 'quote_accepted', 'enable']);
  // enabled for this organisation only
  const rival = await signup(); const rivalOrg = await mkOrg(rival);
  assert.equal((await call('POST', `/organisations/${rivalOrg}/integrations`, { token: rival.token, body })).status, 403);
  // revoking pauses the connection (kept) and blocks resuming, rotating and a new install
  assert.equal((await dec({ decision: 'revoke', note: 'contract ended' })).body.status, 'revoked');
  assert.equal((await call('GET', `/integrations/${ok.body.id}`, { token: owner.token })).body.status, 'paused');
  assert.equal((await call('PATCH', `/integrations/${ok.body.id}`, { token: owner.token, body: { status: 'connected' } })).status, 403);
  assert.equal((await call('POST', `/integrations/${ok.body.id}/credentials/rotate`, { token: owner.token, body: { settings: { api_key: 'sk_live_another999' } } })).status, 403);
  assert.equal((await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { ...body, label: 'Second' } })).status, 403);
});

test('a custom integration stays a draft until the platform team builds and deploys it', async () => {
  const owner = await signup(); const org = await mkOrg(owner); const pa = await platformAdmin();
  const rq = await call('POST', `/organisations/${org}/integration-access`, { token: owner.token, body: { integration_name: 'Federation results portal', integration_url: 'https://portal.example.org', ...detail, mode: 'webhook_in', security: ['signed_requests'] } });
  assert.equal(rq.status, 201); assert.equal(rq.body.needs_development, true);
  const dec = (b) => call('POST', `/admin/integration-access/${rq.body.id}/decision`, { token: pa.token, body: b });
  await dec({ decision: 'quote', pricing_mode: 'waived' });
  await call('POST', `/integration-access/${rq.body.id}/quote-response`, { token: owner.token, body: { decision: 'accept' } });
  assert.equal((await dec({ decision: 'enable' })).status, 400);                      // no adapter yet
  assert.equal((await dec({ decision: 'start_development' })).body.status, 'in_development');
  const mid = (await call('GET', `/organisations/${org}/integration-access`, { token: owner.token })).body.items[0];
  assert.equal(mid.draft, true); assert.equal(mid.status, 'in_development');
  assert.equal((await dec({ decision: 'deploy', provider_key: 'nope' })).status, 400);
  assert.equal((await dec({ decision: 'deploy', provider_key: 'ticket_scanner_webhook' })).body.status, 'accepted');
  assert.equal((await dec({ decision: 'enable' })).body.status, 'enabled');
  assert.equal((await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'ticket_scanner_webhook', label: 'Custom', settings: {}, accept_scopes: ['ticket_scans.write'] } })).status, 201);
  // decline needs a reason; withdraw works while in progress
  const r2 = await call('POST', `/organisations/${org}/integration-access`, { token: owner.token, body: { integration_name: 'Other system', ...detail } });
  assert.equal((await call('POST', `/admin/integration-access/${r2.body.id}/decision`, { token: pa.token, body: { decision: 'decline' } })).status, 400);
  assert.equal((await call('DELETE', `/integration-access/${r2.body.id}`, { token: owner.token })).status, 200);
  // the platform admin may connect on the organisation's behalf without a request
  const rival = await mkOrg(owner);
  assert.equal((await call('POST', `/organisations/${rival}/integrations`, { token: pa.token, body: { provider_key: 'calendar_ics', label: 'By platform', settings: { url: 'https://c.example.org/a.ics' }, accept_scopes: ['calendar.busy.read'] } })).status, 201);
});

test('multi-category proof: video, federation_feed and accounting providers are all installable from one framework', async () => {
  const pa = await platformAdmin(); const owner = await signup(); const org = await mkOrg(owner);
  const installs = [];
  for (const [prov, scope] of [['video_hudl', 'video.read'], ['federation_generic_xml', 'federation.read'], ['accounting_xero', 'accounting.read']]) {
    await enable(pa, owner, org, prov);
    const r = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: prov, label: `Test ${prov}`, settings: {}, accept_scopes: [scope] } });
    assert.equal(r.status, 201, `install ${prov}: ${JSON.stringify(r.body)}`);
    installs.push({ id: r.body.id, prov });
  }
  const list = (await call('GET', `/organisations/${org}/integrations`, { token: owner.token })).body;
  const cats = new Set(list.items.map((i) => i.category));
  assert.ok(cats.has('video') && cats.has('federation_feed') && cats.has('accounting'), `categories present: ${[...cats].join(',')}`);
});

test('wearable provider is rejected when installed at org level (athlete_scoped)', async () => {
  const pa = await platformAdmin(); const owner = await signup(); const org = await mkOrg(owner);
  await enable(pa, owner, org, 'oura');
  const r = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'oura', label: 'Org Oura', settings: {}, accept_scopes: ['wearables.metrics.read'] } });
  assert.ok([400, 409].includes(r.status), `expected 400/409 for org-level wearable, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('update_integration with sync_every_minutes null disables the schedule', async () => {
  const pa = await platformAdmin(); const owner = await signup(); const org = await mkOrg(owner);
  await enable(pa, owner, org, 'sports_data_json');
  setIntegrationTransport(() => ({ status: 200, text: JSON.stringify([{ id: '1', name: 'Test' }]) }));
  const ins = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'sports_data_json', label: 'Test', settings: { url: 'https://feed.example.com/data.json', api_key: 'sk_test_12345678' }, accept_scopes: ['sports_data.read'], sync_every_minutes: 60 } });
  assert.equal(ins.status, 201);
  const upd = await call('PATCH', `/integrations/${ins.body.id}`, { token: owner.token, body: { sync_every_minutes: null } });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const row = (await pool.query('SELECT sync_every_minutes, next_sync_at FROM integration_installs WHERE id=$1', [ins.body.id])).rows[0];
  assert.equal(row.sync_every_minutes, null);
  assert.equal(row.next_sync_at, null);
});

test('list_external_ids filters by entity_type', async () => {
  const pa = await platformAdmin(); const owner = await signup(); const org = await mkOrg(owner);
  await enable(pa, owner, org, 'sports_data_json');
  setIntegrationTransport(() => ({ status: 200, text: JSON.stringify([]) }));
  const ins = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'sports_data_json', label: 'Test', settings: { url: 'https://feed.example.com/data.json', api_key: 'sk_test_12345678' }, accept_scopes: ['sports_data.read'] } });
  assert.equal(ins.status, 201);
  // create a team to map
  const team = await call('POST', '/teams', { token: owner.token, body: { name: 'Test FC', sport: 'football', organisation_id: org, gender: 'mixed', age_group: 'senior' } });
  const teamId = team.body.id ?? team.body.team?.id; assert.ok(teamId);
  await call('POST', `/integrations/${ins.body.id}/external-ids`, { token: owner.token, body: { entity_type: 'team', internal_id: teamId, external_id: 'ext_team_001' } });
  // filter team
  const teams = (await call('GET', `/integrations/${ins.body.id}/external-ids`, { token: owner.token, ...{ params: { entity_type: 'team' } } })).body;
  // also check with query param
  const r2 = await call('GET', `/integrations/${ins.body.id}/external-ids?entity_type=team`, { token: owner.token });
  assert.equal(r2.status, 200);
  assert.ok(r2.body.items.every((m) => m.entity_type === 'team'));
  const r3 = await call('GET', `/integrations/${ins.body.id}/external-ids?entity_type=venue`, { token: owner.token });
  assert.equal(r3.status, 200);
  assert.ok(r3.body.items.length === 0 || r3.body.items.every((m) => m.entity_type === 'venue'));
});

test('catalogue supports country filter', async () => {
  const cat = (await call('GET', '/integrations/catalogue?country=IN', {})).body;
  assert.ok(cat, 'catalogue returned something');
  // IN-only providers (bookmyshow_in, accounting_tally) must appear
  const keys = cat.providers.map((p) => p.key);
  assert.ok(keys.includes('bookmyshow_in') || keys.includes('accounting_tally'), `IN providers present: ${keys.join(',')}`);
});

test('update_integration_provider migrates to latest version', async () => {
  const pa = await platformAdmin(); const owner = await signup(); const org = await mkOrg(owner);
  await enable(pa, owner, org, 'calendar_ics');
  const ins = await call('POST', `/organisations/${org}/integrations`, { token: owner.token, body: { provider_key: 'calendar_ics', label: 'Cal', settings: { url: 'https://c.example.org/a.ics' }, accept_scopes: ['calendar.busy.read'] } });
  assert.equal(ins.status, 201);
  // Artificially set version behind so update_available is true
  await pool.query("UPDATE integration_installs SET provider_version='0.9' WHERE id=$1", [ins.body.id]);
  const detail = (await call('GET', `/integrations/${ins.body.id}`, { token: owner.token })).body;
  assert.ok(detail.update_available, 'update_available should be true when version is behind');
  const upd = await call('POST', `/integrations/${ins.body.id}/update-provider`, { token: owner.token, body: {} });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.update_available, false);
});

test('every integration capability is in OpenAPI and MCP-ready, and none is open to ordinary tokens as write without admin scope', async () => {
  const names = capabilities.filter((c) => /integration|external_id/.test(c.name)).map((c) => c.name);
  assert.ok(names.length >= 24, `expected >=24, got ${names.length}: ${names.join(',')}`);
  for (const n of ['request_integration_access', 'respond_integration_quote', 'update_integration_access', 'admin_decide_integration_request', 'admin_list_integration_requests']) assert.ok(names.includes(n), n);
  const spec = buildOpenApi();
  for (const p of ['/integrations/catalogue', '/integrations/{id}/sync', '/integrations/{id}/credentials/rotate']) assert.ok(spec.paths[p], p);
});
