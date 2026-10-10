import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEDIA_DIR = process.env.MEDIA_DIR ?? `${process.env.TMPDIR ?? '/tmp'}/sa-insurance-market-test-media`;
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `mk_${n}_${roles[0]}`, display_name: `Market ${n}`, email: `mk${n}@example.com`, password: 'correct-horse-battery', roles } }); return { id: r.body.user.id, token: r.body.token }; };
const insurer = async (name, extra = {}) => { const u = await signup(['insurer']); const ins = must(await api('POST', '/insurance/my-insurer', { token: u.token, body: { name, ...extra } }), 201); return { ...u, insurer: ins }; };
const plan = (who, body) => api('POST', '/insurance/plans', { token: who.token, body: { name: 'Plan', cover_for: 'individual', premium_cents: 50000, coverage_cents: 500000, ...body } });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const putDoc = (token, qs, body = PDF) => fetch(`${base}/api/v1/documents?${new URLSearchParams(qs)}`, { method: 'PUT', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/pdf' }, body });
const getFile = (token, docId) => fetch(`${base}/api/v1/documents/${docId}/file`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('open requests reach the marketplace and notify insurers; one login cannot answer its own; paused insurers are told why', async () => {
  const a = await insurer('Market Alpha'), b = await insurer('Market Beta');
  const paused = await insurer('Market Paused', { accepting_requests: false });
  const tp = must(await plan(a, { name: 'Squad', cover_for: 'team' }), 201);
  const asker = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: asker.token, body: { name: 'Market FC', sport: 'football', city: 'Pune' } }), 201);
  const req = must(await api('POST', '/insurance/quote-requests', { token: asker.token, body: { cover_for: 'team', subject_id: team.id, participants: 16, sport: 'football', message: 'private note' } }), 201);
  assert.equal(req.city, 'Pune', 'defaults to the team city');

  for (const who of [a, b]) {
    const nts = must(await api('GET', '/notifications', { token: who.token })).items;
    assert.ok(nts.some((x) => x.kind === 'quote_request'), 'every accepting insurer is told');
  }
  assert.ok(!must(await api('GET', '/notifications', { token: paused.token })).items.some((x) => x.kind === 'quote_request'), 'paused insurers are not');

  const market = must(await api('GET', '/insurance/market', { token: a.token }));
  assert.equal(market.length, 1);
  assert.equal(market[0].subject_name, 'Market FC');
  assert.equal(market[0].my_quote_id, null);
  assert.ok(!JSON.stringify(market).includes('private note'), 'the note is not on the Billboard');
  assert.equal(must(await api('GET', '/insurance/market', { token: a.token, query: { cover_for: 'event' } })).length, 0);
  assert.equal((await api('GET', '/insurance/market', { token: asker.token })).status, 403, 'insurers only');
  assert.deepEqual(must(await api('GET', '/insurance/market', { token: paused.token })), []);

  const hint = must(await api('GET', '/insurance/insurer/summary', { token: paused.token }));
  assert.equal(hint.inbox.accepting_requests, false);
  assert.equal(hint.inbox.market_open, 1);
  assert.equal(must(await api('GET', '/insurance/insurer/summary', { token: a.token })).requests_waiting, 1);

  must(await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: req.id, plan_id: tp.id, premium_cents: 90000 } }), 201);
  must(await api('POST', '/insurance/quotes', { token: b.token, body: { request_id: req.id, plan_id: must(await plan(b, { name: 'Squad B', cover_for: 'team' }), 201).id, premium_cents: 80000 } }), 201);
  assert.equal(must(await api('GET', '/insurance/market', { token: a.token }))[0].my_quote_status, 'offered');
  assert.equal(must(await api('GET', '/insurance/market', { token: a.token }))[0].quotes, 2);

  // an insurer who also asks: the request is theirs, not in their own inbox, and the desk says so
  const team2 = must(await api('POST', '/teams', { token: a.token, body: { name: 'Alpha FC', sport: 'football' } }), 201);
  must(await api('POST', '/insurance/quote-requests', { token: a.token, body: { cover_for: 'team', subject_id: team2.id } }), 201);
  const own = must(await api('GET', '/insurance/insurer/summary', { token: a.token }));
  assert.equal(own.inbox.own_requests_hidden, 1);
  assert.equal(must(await api('GET', '/insurance/market', { token: a.token })).length, 1, 'only the other login\'s request');
});

test('players ask, managers compare and accept; venues and strangers', async () => {
  const a = await insurer('Roster Alpha');
  const tp = must(await plan(a, { name: 'Roster Plan', cover_for: 'team' }), 201);
  const manager = await signup(['athlete']), player = await signup(['athlete']), outsider = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: manager.token, body: { name: 'Roster FC', sport: 'football' } }), 201);
  must(await api('POST', `/teams/${team.id}/members`, { token: manager.token, body: { user_id: player.id } }), 201);

  assert.equal((await api('POST', '/insurance/quote-requests', { token: outsider.token, body: { cover_for: 'team', subject_id: team.id } })).status, 403);
  const req = must(await api('POST', '/insurance/quote-requests', { token: player.token, body: { cover_for: 'team', subject_id: team.id } }), 201);
  assert.equal(must(await api('GET', '/insurance/quote-requests', { token: manager.token })).length, 1, 'the manager sees the player\'s request');
  assert.equal(must(await api('GET', '/insurance/quote-requests', { token: outsider.token })).length, 0);
  assert.equal((await api('GET', `/insurance/quote-requests/${req.id}`, { token: outsider.token })).status, 404);

  const q = must(await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: req.id, plan_id: tp.id, premium_cents: 100000 } }), 201);
  assert.equal(must(await api('GET', '/insurance/quotes', { token: manager.token })).length, 1, 'quotes follow the team to its managers');
  assert.equal((await api('POST', `/insurance/quotes/${q.id}/accept`, { token: player.token, body: {} })).status, 403, 'a player cannot buy cover for the team');
  assert.equal((await api('POST', `/insurance/quotes/${q.id}/accept`, { token: outsider.token, body: {} })).status, 404);
  const pol = must(await api('POST', `/insurance/quotes/${q.id}/accept`, { token: manager.token, body: {} }), 201);
  assert.equal(pol.subject_type, 'team');
  assert.equal(must(await api('GET', '/insurance/policies', { token: manager.token })).length, 1);
});

test('venues can be insured: managers, staff and strangers', async () => {
  const a = await insurer('Venue Alpha');
  const vp = must(await plan(a, { name: 'Ground Cover', cover_for: 'venue' }), 201);
  assert.equal(vp.cover_for, 'venue');
  const owner = await signup(['venue_manager']), stranger = await signup(['athlete']);
  const venue = must(await api('POST', '/venues', { token: owner.token, body: { name: 'Insured Arena', city: 'Goa', timezone: 'UTC' } }), 201);
  assert.equal((await api('POST', '/insurance/quote-requests', { token: stranger.token, body: { cover_for: 'venue', subject_id: venue.id } })).status, 403);
  const req = must(await api('POST', '/insurance/quote-requests', { token: owner.token, body: { cover_for: 'venue', subject_id: venue.id, months: 6 } }), 201);
  assert.equal(req.city, 'Goa');
  const q = must(await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: req.id, plan_id: vp.id, premium_cents: 70000 } }), 201);
  assert.equal(q.subject_name, 'Insured Arena');
  const pol = must(await api('POST', `/insurance/quotes/${q.id}/accept`, { token: owner.token, body: {} }), 201);
  assert.equal(pol.subject_type, 'venue');
});

test('team documents: managers upload and hide, members read, outsiders see nothing; insurer papers can be linked', async () => {
  const a = await insurer('Docs Alpha');
  const tp = must(await plan(a, { name: 'Docs Plan', cover_for: 'team' }), 201);
  const manager = await signup(['athlete']), player = await signup(['athlete']), outsider = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: manager.token, body: { name: 'Docs FC', sport: 'football' } }), 201);
  must(await api('POST', `/teams/${team.id}/members`, { token: manager.token, body: { user_id: player.id } }), 201);
  const q = { subject_type: 'team', subject_id: team.id };

  assert.equal((await putDoc(player.token, { ...q, kind: 'certificate' })).status, 403, 'members read, they do not add');
  assert.equal((await putDoc(outsider.token, { ...q, kind: 'certificate' })).status, 404);
  assert.equal((await putDoc(undefined, { ...q })).status, 401);
  assert.equal((await putDoc(manager.token, { ...q }, Buffer.from('not a pdf at all'))).status, 400);
  const up = await putDoc(manager.token, { ...q, kind: 'certificate', title: 'Certificate 2026' });
  assert.equal(up.status, 201);
  const doc = await up.json();
  assert.ok(!(await pool.query('SELECT file_name FROM subject_documents WHERE id=$1', [doc.id])).rows[0].file_name.endsWith('.pdf'), 'stored as an opaque encrypted file');

  assert.equal(must(await api('GET', '/documents', { token: player.token, query: q })).length, 1, 'members can list');
  assert.equal((await api('GET', '/documents', { token: outsider.token, query: q })).status, 404);
  const file = await getFile(player.token, doc.id);
  assert.equal(file.status, 200);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString('latin1').slice(0, 5), '%PDF-');
  assert.equal((await getFile(outsider.token, doc.id)).status, 404);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pii' AND entity='subject_documents' AND entity_id=$1", [doc.id])).rowCount, 'downloads are audited');

  // an accepted policy's certificate (stored by the insurer) is linked into the team folder without copying the file
  const req = must(await api('POST', '/insurance/quote-requests', { token: manager.token, body: { cover_for: 'team', subject_id: team.id } }), 201);
  const quote = must(await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: req.id, plan_id: tp.id, premium_cents: 100000 } }), 201);
  const pol = must(await api('POST', `/insurance/quotes/${quote.id}/accept`, { token: manager.token, body: {} }), 201);
  const idoc = await (await fetch(`${base}/api/v1/insurance/documents?${new URLSearchParams({ policy_id: pol.id, kind: 'certificate', title: 'Certificate of insurance' })}`, { method: 'PUT', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/pdf' }, body: PDF })).json();
  assert.equal((await api('POST', '/documents/link', { token: player.token, body: { insurance_document_id: idoc.id } })).status, 404, 'players cannot see the policy documents');
  const link = must(await api('POST', '/documents/link', { token: manager.token, body: { insurance_document_id: idoc.id } }), 201);
  assert.equal(must(await api('POST', '/documents/link', { token: manager.token, body: { insurance_document_id: idoc.id } }), 201).already_linked, true);
  const linked = must(await api('GET', '/documents', { token: player.token, query: q })).find((d) => d.id === link.id);
  assert.equal(linked.from_insurance, true);
  assert.equal((await getFile(player.token, link.id)).status, 200, 'members can read what the insurer filed');

  assert.equal((await api('DELETE', `/documents/${doc.id}`, { token: player.token })).status, 403);
  must(await api('DELETE', `/documents/${doc.id}`, { token: manager.token }));
  assert.equal(must(await api('GET', '/documents', { token: manager.token, query: q })).length, 1, 'hidden from the list');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM subject_documents WHERE id=$1', [doc.id])).rows[0].n, 1, 'but never deleted');
});
