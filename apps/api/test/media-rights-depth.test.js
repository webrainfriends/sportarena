// Media rights depth (#590): the auditable rights check before publishing / exporting / handing over content, its append-only trail, the fan feed and follower alerts,
// and crew badges read from the real event accreditation (#481).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { runMediaRightsSweeps } = await import('../src/media-rights-sweeps.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query, raw } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)))}` : ''}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed, headers: r.headers };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const iso = (days = 0, hours = 0) => new Date(Date.now() + days * 864e5 + hours * 36e5).toISOString();
const signup = async (roles = ['organizer']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `mr_${n}_${roles[0]}`, display_name: `Media ${n}`, email: `mr${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

const mkEvent = async (u) => {
  const ev = must(await api('POST', '/events', { token: u.token, body: { name: `Media Cup ${++n}`, sport: 'football', kind: 'tournament', starts_on: iso(10).slice(0, 10), ends_on: iso(12).slice(0, 10) } }), 201);
  must(await api('PATCH', `/events/${ev.id}`, { token: u.token, body: { status: 'open' } }));
  return ev;
};
const mkTeam = async (u, name) => must(await api('POST', '/teams', { token: u.token, body: { name: `${name} ${++n}`, sport: 'football' } }), 201);
const mkFixture = async (ev, h, a, at = iso(10)) => (await q('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ev.id, h.id, a.id, at, 'Round 1']))[0];
const partnerOrg = async (u, kind = 'broadcaster') => {
  const org = must(await api('POST', '/organisations', { token: u.token, body: { name: `Broadcast ${++n}`, kind: 'company' } }), 201);
  const mp = must(await api('POST', '/media/partners', { token: u.token, body: { organisation_id: org.id, kind } }), 201);
  return { org, ...mp, partner_id: mp.id };
};
const pkg = async (u, ev, over = {}) => must(await api('POST', `/events/${ev.id}/media/packages`, { token: u.token, body: { name: `Package ${++n}`, rights: ['live_video', 'highlights', 'data_feed'], valid_from: iso(-1), valid_to: iso(60), ...over } }), 201);
const terms = (over = {}) => ({ approved_rights: ['live_video', 'highlights', 'data_feed'], effective_from: iso(-1), effective_to: iso(30), fee_minor: 500000, currency: 'USD', ...over });
const offer = async (u, p, partner, over = {}) => must(await api('POST', `/media/packages/${p.id}/licences`, { token: u.token, body: { partner_id: partner.partner_id, ...terms(over) } }), 201);
const decide = (u, l, action, extra = {}) => api('POST', `/media/licences/${l.id}/decision`, { token: u.token, body: { action, row_version: extra.row_version ?? l.row_version, ...extra } });
const activeLicence = async (org, partnerUser, ev, partner, pOver = {}, tOver = {}) => {
  const p = await pkg(org, ev, pOver);
  const l = await offer(org, p, partner, tOver);
  return { p, l: must(await decide(partnerUser, l, 'accept')) };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });


const setup = async () => {
  const org = await signup(), pu = await signup(), other = await signup();
  const ev = await mkEvent(org), a = await mkTeam(org, 'A'), b = await mkTeam(org, 'B'), f = await mkFixture(ev, a, b);
  return { org, pu, other, ev, a, b, f, partner: await partnerOrg(pu) };
};
const reg = (s, u, over = {}) => api('POST', `/events/${s.ev.id}/media/assets`, { token: u.token, body: { kind: 'clip', right_kind: 'highlights', title: `Clip ${++n}`, owner_kind: 'organiser', external_url: 'https://cdn.example/clip.mp4', fixture_id: s.f.id, audience: 'licensed', ...over } });
const publish = async (u, asset) => must(await api('POST', `/media/assets/${asset.id}/status`, { token: u.token, body: { action: 'publish', row_version: asset.row_version } }));
const notes = (uid, kind) => q('SELECT * FROM notifications WHERE user_id=$1 AND kind=$2', [uid, kind]);

test('rights check: every rule is answered, licence limits are judged per platform and country, and each check is written down', async () => {
  const s = await setup();
  await activeLicence(s.org, s.pu, s.ev, s.partner, { rights: ['highlights'], embargo_minutes: 0 }, { approved_rights: ['highlights'], territory_mode: 'include', countries: ['SG'], approved_platforms: ['ott'] });
  const asset = must(await reg(s, s.org, { title: 'Final highlights', credit: 'Official', platforms: ['ott', 'web'] }), 201);
  // a draft is not exportable; the organiser sees the answer and the reason
  const draft = must(await api('POST', `/media/assets/${asset.id}/rights-check`, { token: s.org.token, body: { purpose: 'export' } }), 201);
  assert.equal(draft.outcome, 'blocked');
  assert.deepEqual(draft.rules.filter((r) => !r.ok).map((r) => r.rule), ['status']);
  await publish(s.org, asset);
  // the licensed partner: inside its licence → allowed; outside its territory or platform → blocked with the reason
  const ok = must(await api('POST', `/media/assets/${asset.id}/rights-check`, { token: s.pu.token, body: { purpose: 'export', platform: 'ott', country: 'SG' } }), 201);
  assert.equal(ok.outcome, 'allowed');
  const us = must(await api('POST', `/media/assets/${asset.id}/rights-check`, { token: s.pu.token, body: { purpose: 'export', platform: 'ott', country: 'US' } }), 201);
  assert.equal(us.outcome, 'blocked'); assert.match(us.rules.find((r) => r.rule === 'licence').detail, /US/);
  const web = must(await api('POST', `/media/assets/${asset.id}/rights-check`, { token: s.pu.token, body: { purpose: 'export', platform: 'web', country: 'SG' } }), 201);
  assert.equal(web.outcome, 'blocked'); assert.match(web.rules.find((r) => r.rule === 'licence').detail, /web/);
  // a partner sees owner and credit, never the internal chain
  assert.equal(ok.provenance.cut_from, undefined);
  // organiser hands it over under a named licence; a hand-over needs one
  assert.equal(code(await api('POST', `/media/assets/${asset.id}/rights-check`, { token: s.org.token, body: { purpose: 'distribute' } })), 'licence_required');
  const lic = (await q("SELECT id FROM mr_licences WHERE stage='active'"))[0];
  const hand = must(await api('POST', `/media/assets/${asset.id}/rights-check`, { token: s.org.token, body: { purpose: 'distribute', licence_id: lic.id, country: 'SG', platform: 'ott' } }), 201);
  assert.equal(hand.outcome, 'allowed'); assert.equal(hand.licence_id, lic.id); assert.equal(hand.provenance.owner_kind, 'organiser');
  // an unlicensed partner and an outsider cannot even see the asset
  assert.equal((await api('POST', `/media/assets/${asset.id}/rights-check`, { token: s.other.token, body: { purpose: 'export' } })).status, 404);
  // the trail: organiser only, with the failed rules; append-only
  const trail = must(await api('GET', `/events/${s.ev.id}/media/rights-checks`, { token: s.org.token, query: { asset_id: asset.id } }));
  assert.equal(trail.total, 6);
  assert.deepEqual(trail.items.filter((t) => t.outcome === 'blocked').flatMap((t) => t.failed).sort(), ['licence', 'licence', 'status']);
  assert.equal(must(await api('GET', `/events/${s.ev.id}/media/rights-checks`, { token: s.org.token, query: { outcome: 'blocked' } })).total, 3);
  assert.equal((await api('GET', `/events/${s.ev.id}/media/rights-checks`, { token: s.pu.token })).status, 404);
  await assert.rejects(pool.query("UPDATE mr_rights_checks SET outcome='allowed'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM mr_rights_checks'), /append-only/);
});

test('publishing runs the same check: a blocked publish is refused with its reason and still recorded; a good one is recorded as allowed', async () => {
  const s = await setup();
  const up = must(await api('POST', `/events/${s.ev.id}/media/assets`, { token: s.org.token, body: { kind: 'photo', right_kind: 'photography', title: 'Podium', owner_kind: 'organiser' } }), 201);
  const r = await api('POST', `/media/assets/${up.id}/status`, { token: s.org.token, body: { action: 'publish', row_version: up.row_version } });
  assert.equal(r.status, 400); assert.equal(code(r), 'file_required');
  const blocked = must(await api('GET', `/events/${s.ev.id}/media/rights-checks`, { token: s.org.token, query: { purpose: 'publish' } }));
  assert.equal(blocked.items[0].outcome, 'blocked'); assert.deepEqual(blocked.items[0].failed, ['file']);
  const clip = must(await reg(s, s.org), 201);
  await publish(s.org, clip);
  const after = must(await api('GET', `/events/${s.ev.id}/media/rights-checks`, { token: s.org.token, query: { asset_id: clip.id } }));
  assert.deepEqual(after.items.map((t) => [t.purpose, t.outcome]), [['publish', 'allowed']]);
  assert.ok((await q("SELECT 1 FROM mr_log WHERE subject_id=$1 AND action='rights_check_allowed'", [clip.id])).length);
});

test('fans: follow with the media alert, hear once when public media goes live (also after an embargo lifts), and see only live public media', async () => {
  const s = await setup();
  const fan = await signup(['athlete']), quiet = await signup(['athlete']), stranger = await signup(['athlete']);
  must(await api('POST', '/me/follows', { token: fan.token, body: { subject_type: 'team', subject_id: s.a.id, alerts: ['media'] } }), 201);
  must(await api('POST', '/me/follows', { token: quiet.token, body: { subject_type: 'event', subject_id: s.ev.id } }), 201);   // default alerts: no media
  const pub = must(await reg(s, s.org, { audience: 'public', title: 'Goal of the day' }), 201);
  assert.deepEqual(must(await api('GET', '/me/media-feed', { token: fan.token })).items, [], 'a draft is not in the feed');
  await publish(s.org, pub);
  assert.equal((await notes(fan.id, 'media_published')).length, 1);
  assert.equal((await notes(quiet.id, 'media_published')).length, 0, 'the alert is opt-in');
  assert.equal((await notes(stranger.id, 'media_published')).length, 0);
  assert.deepEqual(must(await api('GET', '/me/media-feed', { token: fan.token })).items.map((x) => x.id), [pub.id]);
  assert.equal(must(await api('GET', '/me/media-feed', { token: quiet.token })).items.length, 1, 'following the event shows its media even without the alert');
  assert.deepEqual(must(await api('GET', '/me/media-feed', { token: stranger.token })).items, []);
  // licensed media never reaches fans
  await publish(s.org, must(await reg(s, s.org, { audience: 'licensed' }), 201));
  assert.equal(must(await api('GET', '/me/media-feed', { token: fan.token })).items.length, 1);
  // an embargoed clip waits; once the embargo lifts the sweep tells followers exactly once
  const emb = must(await reg(s, s.org, { audience: 'public', title: 'Embargoed', embargo_until: iso(0, 2) }), 201);
  await publish(s.org, emb);
  assert.equal((await notes(fan.id, 'media_published')).length, 1);
  await q("UPDATE mr_assets SET embargo_until=now() - interval '1 minute' WHERE id=$1", [emb.id]);
  await runMediaRightsSweeps(); await runMediaRightsSweeps();
  assert.equal((await notes(fan.id, 'media_published')).length, 2);
  // taken down: gone from the feed at once
  const cur = must(await api('GET', `/media/assets/${pub.id}`, { token: s.org.token }));
  must(await api('POST', `/media/assets/${pub.id}/status`, { token: s.org.token, body: { action: 'take_down', reason: 'Wrong game', row_version: cur.row_version } }));
  assert.deepEqual(must(await api('GET', '/me/media-feed', { token: fan.token })).items.map((x) => x.id), [emb.id]);
  // youth events never alert fans
  const yev = must(await api('POST', '/events', { token: s.org.token, body: { name: `Youth ${++n}`, sport: 'football', kind: 'tournament', starts_on: iso(10).slice(0, 10), ends_on: iso(12).slice(0, 10), max_age: 14 } }), 201);
  must(await api('PATCH', `/events/${yev.id}`, { token: s.org.token, body: { status: 'open' } }));
  must(await api('POST', '/me/follows', { token: fan.token, body: { subject_type: 'event', subject_id: yev.id, alerts: ['media'] } }), 201);
  const ya = must(await api('POST', `/events/${yev.id}/media/assets`, { token: s.org.token, body: { kind: 'clip', right_kind: 'highlights', title: 'Youth clip', owner_kind: 'organiser', external_url: 'https://cdn.example/y.mp4', audience: 'public' } }), 201);
  await publish(s.org, ya);
  assert.equal((await notes(fan.id, 'media_published')).length, 2);
  assert.equal(must(await api('GET', '/me/media-feed', { token: fan.token })).items.some((x) => x.id === ya.id), false);
  assert.equal((await api('GET', '/me/media-feed')).status, 401);
});

test('crew badge is the real event accreditation (#481), read live, with zone gaps; the old department flag still counts when there is none', async () => {
  const s = await setup();
  const cam = await signup(['athlete']);
  const { l } = await activeLicence(s.org, s.pu, s.ev, s.partner);
  const row = must(await api('POST', `/events/${s.ev.id}/media/crew`, { token: s.pu.token, body: { user_id: cam.id, role: 'camera_operator', licence_id: l.id, fixture_id: s.f.id, zones: ['media_centre', 'mixed_zone'] } }), 201);
  must(await api('POST', `/media/crew/${row.id}/respond`, { token: cam.token, body: { accept: true } }));
  const crew = async () => must(await api('GET', `/events/${s.ev.id}/media/crew`, { token: s.pu.token })).find((x) => x.id === row.id);
  assert.equal((await crew()).accreditation, 'none');
  const cat = (await q("INSERT INTO accreditation_categories(event_id, name, eligible, created_by) VALUES ($1,'Press','{media}',$2) RETURNING id", [s.ev.id, s.org.id]))[0];
  const zone = (await q("INSERT INTO accreditation_zones(event_id, name, kind, created_by) VALUES ($1,'Media centre','media_centre',$2) RETURNING id", [s.ev.id, s.org.id]))[0];
  await q('INSERT INTO accreditation_category_zones(category_id, zone_id) VALUES ($1,$2)', [cat.id, zone.id]);
  const acc = (await q("INSERT INTO accreditations(event_id, category_id, holder_id, origin, status, serial, issued_at, issued_by) VALUES ($1,$2,$3,'nomination','submitted',NULL,NULL,NULL) RETURNING id", [s.ev.id, cat.id, cam.id]))[0];
  assert.equal((await crew()).accreditation, 'pending');
  await q("UPDATE accreditations SET status='approved', serial='ACC-T1', issued_at=now(), issued_by=$2 WHERE id=$1", [acc.id, s.org.id]);
  let c = await crew();
  assert.equal(c.accreditation, 'issued'); assert.equal(c.accreditation_id, acc.id);
  assert.deepEqual(c.zone_gaps, ['mixed_zone'], 'the credential does not open the mixed zone');
  assert.equal(c.ready, false);
  await q("UPDATE mr_crew SET zones='{media_centre}' WHERE id=$1", [row.id]);
  assert.equal((await crew()).ready, true);
  await q("UPDATE accreditations SET access='suspended' WHERE id=$1", [acc.id]);
  c = await crew();
  assert.equal(c.accreditation, 'suspended'); assert.equal(c.ready, false);
  const mine = must(await api('GET', '/me/media-assignments', { token: cam.token }));
  assert.equal(mine[0].accreditation, 'suspended');
});

test('parity and safety: the new capabilities are on REST, OpenAPI and MCP; the migration only adds', async () => {
  const spec = (await api('GET', '/openapi.json')).body;
  const tools = (await rpc('tools/list', {}, (await signup()).token)).tools.map((t) => t.name);
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p));
  for (const name of ['check_media_rights', 'list_rights_checks', 'list_my_media_feed']) {
    assert.ok(tools.includes(name), `MCP tool ${name}`);
    assert.ok(ops.some((o) => o.operationId === name), `OpenAPI operation ${name}`);
  }
  const sql = (await import('node:fs')).readFileSync(new URL('../migrations/128_media_rights_audit_fans.sql', import.meta.url), 'utf8');
  assert.ok(!/\bDROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|ON\s+DELETE\s+CASCADE/i.test(sql), 'no destructive statements');
});
