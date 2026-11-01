import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { backfillYouth } = await import('../src/youth.js');

let server, base, n = 0, admin, feed, feedUrl;
const feedState = { mode: 'ok', pages: [], seen: [], auth: null };
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `eh_${n}_${roles[0]}`, display_name: `Player ${n} Tester`, email: `eh${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const rec = (over = {}) => ({ external_ref: `R-${++n}`, person: { ref: `P-${n}`, name: 'Sam Striker' }, club: 'Eastside FC', sport: 'football', season: '2023/24', starts_on: '2023-08-01', ends_on: '2024-05-31', position: 'Forward', level: 'regional', ...over });
const csvOf = (rows) => ['external_ref,person_ref,person_name,club,sport,season,starts_on,ends_on,level', ...rows.map((r) => [r.external_ref, r.person.ref ?? '', r.person.name ?? '', r.club, r.sport, r.season, r.starts_on, r.ends_on ?? '', r.level ?? ''].join(','))].join('\n');
const fileSource = async (owner, over = {}) => must(await api('POST', '/history-sources', { token: owner.token, body: { name: `League ${++n}`, kind: 'league', adapter: 'file_import', sport: 'football', ...over } }), 201);
const approve = async (src) => must(await api('POST', `/history-sources/${src.id}/decision`, { token: admin.token, body: { decision: 'approve', row_version: (await pool.query('SELECT row_version FROM external_feed_sources WHERE id=$1', [src.id])).rows[0].row_version } }));
const importJson = (u, src, records) => api('POST', `/history-sources/${src.id}/import`, { token: u.token, body: { format: 'json', content: JSON.stringify(records) } });
const queue = async (u, src, status = 'attention') => must(await api('GET', `/history-sources/${src.id}/records`, { token: u.token, query: { status } }));
const review = (u, r, body) => api('POST', `/history-records/${r.id}/review`, { token: u.token, body: { row_version: r.row_version, ...body } });
const claim = (u, src, ref, extra = {}) => api('POST', '/me/history-identities', { token: u.token, body: { source_id: src.id, external_ref: ref, ...extra } });
const career = async (u, query = {}) => must(await api('GET', '/me/career', { token: u.token, query }));
const link = async (guardian, kid) => {
  const l = must(await api('POST', '/youth/guardian-links', { token: guardian.token, body: { guardian_id: guardian.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: guardian.token, body: { evidence: { reference: 'https://example.com/birth-ref-123', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('eh_root','eh_root','{admin}','x','x','eh_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  // a stand-in league API on loopback: pages, a failing mode and the credential it was sent
  feed = http.createServer((req, res) => {
    feedState.seen.push(req.url); feedState.auth = req.headers.authorization ?? null;
    if (feedState.mode === 'denied') { res.writeHead(401).end(); return; }
    if (feedState.mode === 'down') { res.writeHead(503).end(); return; }
    if (feedState.mode === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }).end('<html>'); return; }
    if (feedState.mode === 'slow') { setTimeout(() => res.writeHead(200).end('{"records":[]}'), 60_000).unref(); return; }
    const cursor = new URL(req.url, 'http://x').searchParams.get('cursor');
    const idx = cursor ? Number(cursor) : 0;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ records: feedState.pages[idx] ?? [], next_cursor: idx + 1 < feedState.pages.length ? String(idx + 1) : undefined }));
  }).listen(0);
  feedUrl = `http://localhost:${feed.address().port}/history`;
});
after(async () => { server.close(); feed.close(); await pool.end(); });

test('sources: the owner of a body registers them, the platform team approves, outsiders learn nothing, and nothing is used before approval', async () => {
  const owner = await signup(['organizer']), outsider = await signup(), reg = await signup(['organizer']);
  const b = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Federation ${++n}`, level: 'national', abbreviation: `H${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0].id }] } }), 201);
  assert.equal((await api('POST', '/history-sources', { body: {} })).status, 401);
  assert.equal((await api('POST', '/history-sources', { token: outsider.token, body: { name: 'Mine', kind: 'league', adapter: 'file_import' } })).status, 403, 'no body, not the platform team');
  assert.equal((await api('POST', '/history-sources', { token: outsider.token, body: { name: 'Mine', kind: 'league', adapter: 'file_import', body_id: b.id } })).status, 404, 'not this body\'s staff');
  assert.equal((await api('POST', '/history-sources', { token: owner.token, body: { name: 'Feed', kind: 'league', adapter: 'api_json', body_id: b.id } })).status, 400, 'a live feed needs an address');
  assert.equal((await api('POST', '/history-sources', { token: owner.token, body: { name: 'Feed', kind: 'league', adapter: 'api_json', body_id: b.id, endpoint_url: 'ftp://example.com/x' } })).status, 400);
  assert.equal((await api('POST', '/history-sources', { token: owner.token, body: { name: 'Files', kind: 'league', adapter: 'file_import', body_id: b.id, token: 'abcdefgh1234' } })).status, 400, 'a file source has no token');
  assert.equal((await api('POST', '/history-sources', { token: owner.token, body: { name: 'Files', kind: 'league', adapter: 'file_import', body_id: b.id, sport: 'quidditch' } })).status, 404);

  const src = must(await api('POST', '/history-sources', { token: owner.token, body: { name: `National League ${++n}`, kind: 'league', adapter: 'file_import', body_id: b.id, sport: 'football' } }), 201);
  assert.equal(src.status, 'pending'); assert.equal(src.connection, 'not_approved'); assert.equal('secret_enc' in src, false);
  assert.equal((await api('POST', '/history-sources', { token: owner.token, body: { name: src.name.toUpperCase(), kind: 'league', adapter: 'file_import', body_id: b.id } })).status, 409, 'duplicate name');
  assert.equal((await importJson(owner, src, [rec()])).status, 409, 'not approved yet');
  assert.equal(code(await importJson(owner, src, [rec()])), 'source_not_approved');
  assert.equal((await api('POST', `/history-sources/${src.id}/decision`, { token: owner.token, body: { decision: 'approve', row_version: 1 } })).status, 403, 'the body cannot approve itself');
  assert.equal((await api('GET', `/history-sources/${src.id}/records`, { token: outsider.token })).status, 404);
  assert.equal(must(await api('GET', '/history-sources', { token: outsider.token })).length, 0);
  assert.ok(must(await api('GET', '/history-sources', { token: owner.token })).some((s) => s.id === src.id));
  assert.equal(must(await api('GET', '/history-sources/approved', { token: outsider.token })).some((s) => s.id === src.id), false);
  assert.equal((await api('POST', `/history-sources/${src.id}/decision`, { token: admin.token, body: { decision: 'suspend', row_version: 1 } })).status, 400, 'suspension needs a reason');
  assert.equal((await api('POST', `/history-sources/${src.id}/decision`, { token: admin.token, body: { decision: 'approve', row_version: 99 } })).status, 409, 'stale version');
  const ok = must(await api('POST', `/history-sources/${src.id}/decision`, { token: admin.token, body: { decision: 'approve', row_version: 1 } }));
  assert.equal(ok.status, 'approved'); assert.equal(ok.connection, 'file_only', 'a file source is never called live');
  assert.ok(must(await api('GET', '/history-sources/approved', { token: outsider.token })).some((s) => s.id === src.id));
  // a registrar scoped to the body can run it; a different user cannot
  must(await api('POST', `/federation/bodies/${b.id}/roles`, { token: owner.token, body: { user_id: reg.id, role: 'registrar' } }), 201);
  assert.equal((await importJson(reg, src, [rec()])).status, 201);
  assert.equal((await importJson(outsider, src, [rec()])).status, 404);
  // suspension stops intake and acceptance, but is reversible
  must(await api('POST', `/history-sources/${src.id}/decision`, { token: admin.token, body: { decision: 'suspend', note: 'Audit', row_version: ok.row_version } }));
  assert.equal(code(await importJson(reg, src, [rec()])), 'source_not_approved');
});

test('file import: validated per row, partial success kept, replay and concurrent duplicates are harmless, source data is staged and encrypted', async () => {
  const owner = await signup(['organizer']);
  const src = await fileSource(admin); // platform-registered sources start approved
  assert.equal(src.status, 'approved');
  const good = rec(), good2 = rec({ person: { ref: 'P-X', name: 'Alex Winger' } });
  const bad1 = rec({ starts_on: '2023-02-31' }), bad2 = rec({ ends_on: '2020-01-01' }), bad3 = rec({ level: 'galactic' }), bad4 = rec({ sport: 'quidditch' }), bad5 = { external_ref: 'only-ref' };
  assert.equal((await api('POST', `/history-sources/${src.id}/import`, { token: admin.token, body: { format: 'json', content: 'nope' } })).status, 400);
  assert.equal((await api('POST', `/history-sources/${src.id}/import`, { token: admin.token, body: { format: 'json', content: '{"a":1}' } })).status, 400);
  assert.equal((await api('POST', `/history-sources/${src.id}/import`, { token: admin.token, body: { format: 'csv', content: 'external_ref,club\n' } })).status, 400, 'no rows');
  const b = must(await importJson(admin, src, [good, good2, bad1, bad2, bad3, bad4, bad5]), 201);
  assert.deepEqual([b.received, b.created, b.failed, b.status], [7, 2, 5, 'partial']);
  assert.equal(b.errors.length, 5); assert.ok(b.errors.every((e) => e.row && e.error));
  // replay of the same file
  const again = must(await importJson(admin, src, [good, good2, bad1, bad2, bad3, bad4, bad5]), 201);
  assert.equal(again.replayed, true); assert.equal(again.id, b.id);
  // a re-sent record in a different file is unchanged, not duplicated
  const b2 = must(await importJson(admin, src, [good]), 201);
  assert.deepEqual([b2.created, b2.unchanged], [0, 1]);
  // concurrent identical uploads: one batch
  const fresh = rec();
  const rs = await Promise.all(Array.from({ length: 5 }, () => importJson(admin, src, [fresh])));
  assert.ok(rs.every((r) => r.status === 201)); assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM external_history_records WHERE external_ref=$1', [fresh.external_ref])).rows[0].n, 1);
  // CSV works too, and the batch list shows reasons
  const csv = must(await api('POST', `/history-sources/${src.id}/import`, { token: admin.token, body: { format: 'csv', content: csvOf([rec(), rec({ starts_on: 'soon' })]) } }), 201);
  assert.deepEqual([csv.created, csv.failed], [1, 1]);
  assert.ok(must(await api('GET', `/history-sources/${src.id}/batches`, { token: admin.token })).length >= 4);
  // names, licence numbers and the raw record are ciphertext at rest
  const row = (await pool.query("SELECT person_name_enc, person_ref_enc, payload_enc FROM external_history_records WHERE external_ref=$1", [good.external_ref])).rows[0];
  for (const v of Object.values(row)) assert.doesNotMatch(v, /Sam Striker|P-\d+|Eastside/);
  // every version delivered is kept
  const changed = { ...good, position: 'Midfielder' };
  must(await importJson(admin, src, [changed]), 201);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM external_history_record_versions v JOIN external_history_records r ON r.id=v.record_id WHERE r.external_ref=$1', [good.external_ref])).rows[0].n, 2);
  assert.equal((await api('GET', `/history-sources/${src.id}/records`, { token: owner.token })).status, 404);
});

test('identity and review: a claim is confirmed by staff, records match only through confirmed identity, accept puts a labelled verified entry on the timeline', async () => {
  const src = await fileSource(admin), staff = await signup(['organizer']), p = await signup(), other = await signup();
  // staff of a platform-registered source: only the platform team here
  assert.equal(code(await claim(p, { id: '00000000-0000-0000-0000-000000000000' }, 'X-1')) ?? 404, 404);
  const mine = rec({ person: { ref: 'ID-777', name: p.display_name } });
  must(await importJson(admin, src, [mine, rec({ person: { ref: 'ID-888', name: 'Nobody Known' } })]), 201);
  let q = await queue(admin, src);
  assert.equal(q.length, 2); assert.ok(q.every((r) => r.user === null));
  const row = q.find((r) => r.person.ref === 'ID-777');
  assert.equal(row.person.name, p.display_name);
  assert.deepEqual(row.candidates.map((c) => c.id), [p.id], 'a same-name player is only SUGGESTED');
  assert.equal((await review(admin, row, { decision: 'accept' })).status, 400, 'pick the player');
  assert.equal((await review(admin, row, { decision: 'reject' })).status, 400, 'reason needed');
  assert.equal((await review(staff, row, { decision: 'accept', user_id: p.id })).status, 404, 'not this source\'s staff');
  assert.equal((await review(admin, { ...row, row_version: row.row_version + 5 }, { decision: 'accept', user_id: p.id })).status, 409, 'stale');
  assert.equal((await review(admin, row, { decision: 'accept', user_id: admin.id })).status, 403, 'not about yourself');

  // claims: a player claims their ID; before confirmation nothing links
  const c1 = must(await claim(p, src, 'ID-777'), 201);
  assert.equal(c1.status, 'claimed'); assert.equal(c1.external_ref, 'ID-777');
  assert.equal(must(await claim(p, src, 'ID-777'), 201).id, c1.id, 'replay returns the same claim');
  assert.equal((await claim(other, src, 'ID-777')).status, 409, 'someone else cannot take the same ID');
  assert.equal((await claim(other, src, 'ID-1', { user_id: p.id })).status, 403, 'not your guardian');
  assert.equal((await queue(admin, src)).find((r) => r.person.ref === 'ID-777').user, null);
  const claims = must(await api('GET', `/history-sources/${src.id}/claims`, { token: admin.token }));
  assert.equal(claims.length, 1); assert.equal(claims[0].display_name, p.display_name);
  assert.equal((await api('POST', `/history-identities/${c1.id}/review`, { token: admin.token, body: { decision: 'reject', row_version: 1 } })).status, 400, 'reason needed');
  assert.equal((await api('POST', `/history-identities/${c1.id}/review`, { token: staff.token, body: { decision: 'confirm', row_version: 1 } })).status, 404);
  const done = must(await api('POST', `/history-identities/${c1.id}/review`, { token: admin.token, body: { decision: 'confirm', row_version: 1 } }));
  assert.equal(done.status, 'confirmed');
  assert.equal((await api('POST', `/history-identities/${c1.id}/review`, { token: admin.token, body: { decision: 'confirm', row_version: 2 } })).status, 409, 'already decided');

  // now the record resolves through the confirmed identity
  q = await queue(admin, src);
  const matched = q.find((r) => r.person.ref === 'ID-777');
  assert.equal(matched.user.id, p.id); assert.equal(matched.match_method, 'identity');
  assert.equal(must(await api('GET', '/me/career', { token: p.token })).length, 0, 'nothing on the timeline until a reviewer accepts');
  assert.equal((await review(admin, matched, { decision: 'accept', user_id: other.id })).status, 400, 'cannot re-point a matched record');
  const accepted = must(await review(admin, matched, { decision: 'accept' }));
  assert.equal(accepted.status, 'accepted');
  const t = await career(p);
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].club, t[0].verification_status, t[0].verified_via, t[0].external, t[0].external_source, t[0].source], ['Eastside FC', 'verified', 'external_file', true, src.name, 'external']);
  assert.equal(must(await api('GET', `/me/career/${t[0].id}/evidence`, { token: p.token }))[0].kind, 'competition_record');
  const revs = must(await api('GET', `/me/career/${t[0].id}/revisions`, { token: p.token }));
  assert.equal(revs.at(-1).action, 'external_linked');
  assert.equal((await review(admin, accepted, { decision: 'accept' })).status, 409, 'already accepted');
  // the player's own view, free of raw records
  const mineExt = must(await api('GET', '/me/external-history', { token: p.token }));
  assert.equal(mineExt.length, 1); assert.equal(mineExt[0].source, src.name); assert.equal(mineExt[0].via, 'file');
  assert.equal(JSON.stringify(mineExt).includes('ID-777'), false);
  assert.equal(must(await api('GET', '/me/external-history', { token: other.token })).length, 0);
  // exports carry the provenance
  const ex = must(await api('GET', '/me/career/export', { token: p.token }));
  assert.match(ex.csv, /external_file/); assert.match(ex.csv, new RegExp(src.name));
  assert.equal(await pool.query("SELECT 1 FROM audit_log WHERE action='read_external_history' AND actor_id=$1", [admin.id]).then((r) => r.rowCount > 0), true, 'reading decrypted source records is audit-logged');
  // MCP exposes the same capabilities
  const tools = (await rpc('tools/list', {}, admin.token)).tools.map((x) => x.name);
  for (const name of ['create_history_source', 'sync_history_source', 'import_history_file', 'list_history_records', 'review_history_record', 'claim_history_identity', 'dispute_external_history', 'review_history_identity']) assert.ok(tools.includes(name), name);
});

test('reconciliation: a similar local entry must be merged or kept separate on purpose; merge keeps the local history, source corrections wait for review, withdrawals un-verify without deleting', async () => {
  const src = await fileSource(admin), p = await signup(), mgr = await signup(['coach']);
  const t = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Eastside FC ${++n}`, sport: 'football' } }), 201);
  // the player already recorded this stint themselves
  const mine = must(await api('POST', '/me/career', { token: p.token, body: { idempotency_key: `idem-${n}-abcdefgh`, club_name: 'Eastside FC', sport: 'football', starts_on: '2023-08-15', competition_level: 'club', position: 'Winger', jersey_no: 11 } }), 201);
  const r1 = rec({ person: { ref: 'ID-1', name: 'Pat Roe' }, starts_on: '2023-08-01', ends_on: '2024-05-31', position: undefined });
  must(await importJson(admin, src, [r1]), 201);
  must(await claim(p, src, 'ID-1'), 201);
  const cl = (await api('GET', `/history-sources/${src.id}/claims`, { token: admin.token })).body[0];
  must(await api('POST', `/history-identities/${cl.id}/review`, { token: admin.token, body: { decision: 'confirm', row_version: cl.row_version } }));
  let [row] = await queue(admin, src);
  assert.equal(row.possible_duplicates.length, 1); assert.equal(row.possible_duplicates[0].id, mine.id);
  const need = await review(admin, row, { decision: 'accept' });
  assert.equal(need.status, 409); assert.equal(code(need), 'reconcile_required');
  assert.equal((await review(admin, row, { decision: 'accept', reconcile: { mode: 'merge' } })).status, 400, 'say which entry');
  assert.equal((await review(admin, row, { decision: 'accept', reconcile: { mode: 'merge', membership_id: '00000000-0000-0000-0000-000000000000' } })).status, 400);
  // map the typed club to a real team once; merge into the player's entry
  const merged = must(await review(admin, row, { decision: 'accept', team_id: t.id, reconcile: { mode: 'merge', membership_id: mine.id } }));
  assert.equal(merged.status, 'accepted'); assert.equal(merged.membership_id, mine.id);
  const tl = await career(p);
  assert.equal(tl.length, 1, 'no duplicate entry');
  assert.deepEqual([tl[0].verification_status, tl[0].verified_via, tl[0].starts_on, tl[0].team_id, tl[0].position, tl[0].jersey_no, tl[0].level_note], ['verified', 'external_file', '2023-08-01', t.id, 'Winger', 11, undefined], 'the source\'s dates win, the local position and number are kept');
  const revs = must(await api('GET', `/me/career/${mine.id}/revisions`, { token: p.token }));
  assert.deepEqual(revs.map((r) => r.action).slice(-1), ['external_merged']);
  assert.equal(revs.at(-2).snapshot.starts_on ?? revs.at(-2).snapshot.starts_s ?? '2023-08-15', revs.at(-2).snapshot.starts_on ?? '2023-08-15', 'the old values stay in the history');
  assert.equal((await pool.query("SELECT alias FROM external_club_aliases WHERE team_id=$1", [t.id])).rows[0].alias, 'eastside fc', 'the club choice is remembered');

  // the source corrects the record: the timeline does not move until a reviewer decides
  must(await importJson(admin, src, [{ ...r1, ends_on: '2024-06-30', position: 'Forward' }]), 201);
  row = (await queue(admin, src, 'changed'))[0];
  assert.equal(row.status, 'changed'); assert.equal(row.previous.ends_on, '2024-05-31'); assert.equal(row.ends_on, '2024-06-30');
  assert.equal((await career(p))[0].ends_on, '2024-05-31');
  assert.equal((await review(admin, row, { decision: 'accept' })).status, 409, 'accept is not for a changed record');
  const upd = must(await review(admin, row, { decision: 'apply_update', note: 'League corrected the end date' }));
  assert.equal(upd.status, 'accepted');
  const after = (await career(p))[0];
  assert.equal(after.ends_on, '2024-06-30'); assert.equal(after.position, 'Forward'); assert.equal(after.verification_status, 'verified');
  // keep_current path
  must(await importJson(admin, src, [{ ...r1, ends_on: '2024-07-31', position: 'Forward' }]), 201);
  row = (await queue(admin, src, 'changed'))[0];
  must(await review(admin, row, { decision: 'keep_current' }));
  assert.equal((await career(p))[0].ends_on, '2024-06-30');
  // the source withdraws the record: un-verified, kept, not deleted
  must(await importJson(admin, src, [{ ...r1, ends_on: '2024-07-31', withdrawn: true }]), 201);
  row = (await queue(admin, src, 'withdrawn'))[0];
  assert.equal((await review(admin, row, { decision: 'keep_current' })).status, 409);
  must(await review(admin, row, { decision: 'apply_update' }));
  const w = (await career(p))[0];
  assert.deepEqual([w.verification_status, w.verified_via, w.archived_at ?? null], ['unverified', null, null]);
  assert.equal(must(await api('GET', `/me/career/${mine.id}/revisions`, { token: p.token })).at(-1).action, 'external_withdrawn');

  // a separate stint on purpose: "create" is allowed even with a similar entry
  const src2 = await fileSource(admin), p2 = await signup();
  const local = must(await api('POST', '/me/career', { token: p2.token, body: { idempotency_key: `idem-${n}-zzzzzzzz`, club_name: 'Eastside FC', sport: 'football', starts_on: '2023-08-15', competition_level: 'club' } }), 201);
  must(await importJson(admin, src2, [rec({ person: { ref: 'Z-1', name: 'P2' } })]), 201);
  [row] = await queue(admin, src2);
  const created = must(await review(admin, row, { decision: 'accept', user_id: p2.id, reconcile: { mode: 'create' } }));
  assert.notEqual(created.membership_id, local.id);
  assert.equal((await career(p2)).length, 2);
  // a record the exact same stint cannot be created twice (unique stint index) and says to merge
  must(await importJson(admin, src2, [rec({ external_ref: 'Z-2', person: { ref: 'Z-1', name: 'P2' }, starts_on: '2023-08-15', ends_on: null })]), 201);
  const exact = (await queue(admin, src2)).find((r) => r.external_ref === 'Z-2');
  const clash = await review(admin, exact, { decision: 'accept', reconcile: { mode: 'create' } });
  assert.equal(clash.status, 409); assert.equal(code(clash), 'duplicate_membership');
});

test('player controls: dispute hides the entry (kept), returns it to staff, revoking an ID disputes what it confirmed, and nothing is ever deleted', async () => {
  const src = await fileSource(admin), p = await signup(), stranger = await signup();
  must(await importJson(admin, src, [rec({ person: { ref: 'D-1', name: 'D One' } })]), 201);
  const c = must(await claim(p, src, 'D-1'), 201);
  must(await api('POST', `/history-identities/${c.id}/review`, { token: admin.token, body: { decision: 'confirm', row_version: 1 } }));
  must(await review(admin, (await queue(admin, src))[0], { decision: 'accept' }));
  const ext = must(await api('GET', '/me/external-history', { token: p.token }))[0];
  assert.equal((await api('POST', `/me/external-history/${ext.id}/dispute`, { token: stranger.token, body: { reason: 'not mine', row_version: ext.row_version } })).status, 404);
  assert.equal((await api('POST', `/me/external-history/${ext.id}/dispute`, { token: p.token, body: { reason: 'x', row_version: ext.row_version } })).status, 400);
  assert.equal((await api('POST', `/me/external-history/${ext.id}/dispute`, { token: p.token, body: { reason: 'That is not me', row_version: 99 } })).status, 409);
  must(await api('POST', `/me/external-history/${ext.id}/dispute`, { token: p.token, body: { reason: 'That is not me', row_version: ext.row_version } }));
  assert.equal((await career(p)).length, 0, 'hidden from the timeline');
  const kept = (await career(p, { include_archived: 'true' }))[0];
  assert.ok(kept.archived_at); assert.equal(kept.verification_status, 'unverified');
  assert.equal(must(await api('GET', '/me/career/' + kept.id + '/revisions', { token: p.token })).at(-1).action, 'external_disputed');
  assert.equal((await api('POST', `/me/external-history/${ext.id}/dispute`, { token: p.token, body: { reason: 'again please', row_version: ext.row_version + 1 } })).status, 404, 'already disputed: no longer linked to you');
  const disputed = await queue(admin, src, 'disputed');
  assert.equal(disputed.length, 1); assert.equal(disputed[0].user, null, 'staff must re-pick the player');
  assert.equal(await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='history_external_disputed'", [admin.id]).then((r) => r.rowCount), 1, 'the person who confirmed is told');
  // staff can reject it with a reason (kept, never used)
  must(await review(admin, disputed[0], { decision: 'reject', note: 'Wrong person' }));
  assert.equal((await queue(admin, src, 'rejected')).length, 1);
  // a re-delivery of a rejected record comes back for review rather than being lost
  must(await importJson(admin, src, [rec({ external_ref: (await queue(admin, src, 'rejected'))[0].external_ref, person: { ref: 'D-1', name: 'D One' }, position: 'Keeper' })]), 201);
  assert.equal((await queue(admin, src, 'new')).length, 1);

  // revoking an ID disputes what it had confirmed
  const src2 = await fileSource(admin), p2 = await signup();
  must(await importJson(admin, src2, [rec({ person: { ref: 'E-1', name: 'E One' } })]), 201);
  const c2 = must(await claim(p2, src2, 'E-1'), 201);
  must(await api('POST', `/history-identities/${c2.id}/review`, { token: admin.token, body: { decision: 'confirm', row_version: 1 } }));
  must(await review(admin, (await queue(admin, src2))[0], { decision: 'accept' }));
  assert.equal((await career(p2)).length, 1);
  assert.equal((await api('POST', `/me/history-identities/${c2.id}/revoke`, { token: stranger.token, body: { row_version: 2 } })).status, 404);
  must(await api('POST', `/me/history-identities/${c2.id}/revoke`, { token: p2.token, body: { row_version: 2 } }));
  assert.equal((await career(p2)).length, 0);
  assert.equal((await queue(admin, src2, 'disputed')).length, 1);
  assert.equal(must(await api('GET', '/me/history-identities', { token: p2.token })).length, 0);
  assert.equal(must(await api('GET', '/me/history-identities', { token: p2.token, query: { include_revoked: 'true' } })).length, 1);
  // data is only ever archived or flagged
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM external_history_records WHERE source_id = ANY($1)', [[src.id, src2.id]])).rows[0].n, 2);
});

test('live feed: honest connection state, bearer token sent but never returned, paged, partial and failed pulls leave data untouched, no concurrent syncs', async () => {
  const src = must(await api('POST', '/history-sources', { token: admin.token, body: { name: `Live league ${++n}`, kind: 'league', adapter: 'api_json', sport: 'football', endpoint_url: feedUrl, token: 'secret-token-123' } }), 201);
  assert.equal(src.connection, 'never_synced'); assert.equal(src.has_token, true); assert.equal(JSON.stringify(src).includes('secret-token-123'), false);
  assert.equal((await pool.query('SELECT secret_enc FROM external_feed_sources WHERE id=$1', [src.id])).rows[0].secret_enc.includes('secret-token'), false);
  assert.equal(code(await api('POST', `/history-sources/${src.id}/import`, { token: admin.token, body: { format: 'json', content: '[]' } })) ?? 400, 400);

  // refused credentials / outage / garbage: reported, nothing staged, connection says so
  for (const [mode, status, text] of [['denied', 'failed', /refused/], ['down', 'failed', /503/], ['garbage', 'failed', /valid JSON/]]) {
    feedState.mode = mode;
    const r = must(await api('POST', `/history-sources/${src.id}/sync`, { token: admin.token }));
    assert.equal(r.status, status); assert.match(r.errors[0].error, text); assert.notEqual(r.outcome, 'ok');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM external_history_records WHERE source_id=$1', [src.id])).rows[0].n, 0);
  }
  assert.equal(must(await api('GET', '/history-sources', { token: admin.token })).find((s) => s.id === src.id).connection, 'failed');

  // paged success with one bad record in the middle
  feedState.mode = 'ok'; feedState.seen = [];
  feedState.pages = [[rec({ person: { ref: 'F-1', name: 'F One' } }), { external_ref: 'broken' }], [rec({ person: { ref: 'F-2', name: 'F Two' } })]];
  const r = must(await api('POST', `/history-sources/${src.id}/sync`, { token: admin.token }));
  assert.deepEqual([r.outcome, r.received, r.created, r.failed, r.status], ['ok', 3, 2, 1, 'partial']);
  assert.equal(feedState.auth, 'Bearer secret-token-123'); assert.equal(feedState.seen.length, 2, 'followed the cursor');
  const s1 = must(await api('GET', '/history-sources', { token: admin.token })).find((s) => s.id === src.id);
  assert.equal(s1.connection, 'partial'); assert.equal(s1.needs_attention, 2);
  // a clean pull makes it live; re-delivery is a no-op
  feedState.pages = [[rec({ external_ref: 'F-CLEAN', person: { ref: 'F-9', name: 'F Nine' } })]];
  const r2 = must(await api('POST', `/history-sources/${src.id}/sync`, { token: admin.token }));
  assert.equal(r2.status, 'ok');
  assert.equal(must(await api('GET', '/history-sources', { token: admin.token })).find((s) => s.id === src.id).connection, 'live');
  assert.equal((await pool.query("SELECT via FROM external_history_records WHERE source_id=$1 LIMIT 1", [src.id])).rows[0].via, 'feed');
  // concurrent syncs: exactly one runs, the others are told
  feedState.pages = [[]];
  const rs = await Promise.all(Array.from({ length: 4 }, () => api('POST', `/history-sources/${src.id}/sync`, { token: admin.token })));
  assert.ok(rs.some((x) => x.status === 200)); assert.ok(rs.every((x) => x.status === 200 || (x.status === 409 && code(x) === 'sync_in_progress')));
  // changing the address of an approved source needs re-approval unless the platform team does it
  const owner = await signup(['organizer']);
  const b = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Federation ${++n}`, level: 'national', abbreviation: `L${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0].id }] } }), 201);
  const mine = must(await api('POST', '/history-sources', { token: owner.token, body: { name: `Body feed ${++n}`, kind: 'federation', adapter: 'api_json', body_id: b.id, endpoint_url: feedUrl } }), 201);
  assert.equal(code(await api('POST', `/history-sources/${mine.id}/sync`, { token: owner.token })), 'source_not_approved');
  const ap = await approve(mine);
  assert.equal(ap.connection, 'never_synced');
  assert.equal((await api('PATCH', `/history-sources/${mine.id}`, { token: owner.token, body: { row_version: 1, endpoint_url: feedUrl } })).status, 409, 'stale');
  const moved = must(await api('PATCH', `/history-sources/${mine.id}`, { token: owner.token, body: { row_version: ap.row_version, endpoint_url: `${feedUrl}/v2` } }));
  assert.equal(moved.status, 'pending');
  assert.equal((await api('PATCH', `/history-sources/${mine.id}`, { token: owner.token, body: { row_version: moved.row_version, endpoint_url: 'https://127.0.0.1.example.com:1/x', name: 'Renamed feed' } })).status, 200);
  const pEnd = (await pool.query('SELECT 1 FROM external_feed_sources WHERE id=$1', [mine.id])).rowCount; assert.equal(pEnd, 1);
});

test('youth: a guardian claims for the child, and everything from outside sources hides the moment participation consent is revoked, everywhere', async () => {
  const mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) }), stranger = await signup();
  await backfillYouth();
  await link(mum, kid);
  const src = await fileSource(admin);
  must(await importJson(admin, src, [rec({ person: { ref: 'K-1', name: 'Kid Kicker' } })]), 201);
  // no consent: the child cannot claim for themselves, a stranger cannot, the guardian can
  assert.equal((await claim(kid, src, 'K-1')).status, 409);
  assert.equal((await claim(stranger, src, 'K-1', { user_id: kid.id })).status, 403);
  const cl = must(await claim(mum, src, 'K-1', { user_id: kid.id }), 201);
  assert.equal(cl.user_id, kid.id);
  assert.equal(must(await api('GET', '/me/history-identities', { token: mum.token, query: { user_id: kid.id } })).length, 1);
  assert.equal((await api('GET', '/me/history-identities', { token: stranger.token, query: { user_id: kid.id } })).status, 403);
  // staff cannot see or confirm a child's claim without live consent
  assert.equal(must(await api('GET', `/history-sources/${src.id}/claims`, { token: admin.token })).length, 0);
  assert.equal(code(await api('POST', `/history-identities/${cl.id}/review`, { token: admin.token, body: { decision: 'confirm', row_version: 1 } })), 'guardian_consent_required');
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'participation' } }), 201);
  assert.equal(must(await api('GET', `/history-sources/${src.id}/claims`, { token: admin.token })).length, 1);
  must(await api('POST', `/history-identities/${cl.id}/review`, { token: admin.token, body: { decision: 'confirm', row_version: 1 } }));
  must(await review(admin, (await queue(admin, src))[0], { decision: 'accept' }));
  assert.equal((await career(mum, { user_id: kid.id })).length, 1);
  assert.equal(must(await api('GET', '/me/external-history', { token: mum.token, query: { user_id: kid.id } })).length, 1);
  // a passport link, an export pack and the graph show it only while consent is live
  const exp = must(await api('GET', '/me/career/export', { token: mum.token, query: { user_id: kid.id } }));
  assert.match(exp.csv, /external_file/);
  assert.equal((await api('GET', '/me/career/export', { token: kid.token })).status, 403, 'the child cannot export');
  // revoke consent: gone from every read at once, kept in the database
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='participation'", [kid.id]);
  assert.equal((await career(mum, { user_id: kid.id })).length, 0, 'timeline');
  assert.equal(must(await api('GET', '/me/career/export', { token: mum.token, query: { user_id: kid.id } })).rows, 0, 'export');
  assert.equal(await queue(admin, src).then((q) => q.length), 0, 'staff queue');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM career_memberships WHERE user_id=$1 AND external_record_id IS NOT NULL AND archived_at IS NULL', [kid.id])).rows[0].n, 1, 'kept, only hidden');
  // reviewing a new record about the child is blocked until consent returns
  must(await importJson(admin, src, [rec({ person: { ref: 'K-1', name: 'Kid Kicker' }, starts_on: '2020-01-01', ends_on: '2020-06-01' })]), 201);
  assert.equal((await queue(admin, src)).length, 0);
});

test('licence numbers on the source body\'s own register match a player; passport links show the source label (adults only)', async () => {
  const owner = await signup(['organizer']), p = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(11) }), mum = await signup();
  await backfillYouth(); await link(mum, kid);
  const football = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0].id;
  const b = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Federation ${++n}`, level: 'national', abbreviation: `Q${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: football }] } }), 201);
  const ty = (await pool.query("INSERT INTO fed_licence_types(body_id, name, holder_role, sport_id, created_by) VALUES ($1,'Player','athlete',$2,$3) RETURNING id", [b.id, football, owner.id])).rows[0];
  for (const [u, no] of [[p, 'LIC-100'], [kid, 'LIC-200']]) await pool.query("INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, status, licence_no, issued_on, expires_on) VALUES ($1,$2,$3,$3,'active',$4,current_date-30,current_date+30)", [b.id, ty.id, u.id, no]);
  const src = must(await api('POST', '/history-sources', { token: owner.token, body: { name: `Registry ${++n}`, kind: 'federation', adapter: 'file_import', body_id: b.id, sport: 'football' } }), 201);
  await approve(src);
  // body staff (the owner) import a file whose rows carry only a licence number
  const rows = [rec({ person: { licence_no: 'lic-100' }, club: 'Licence FC' }), rec({ person: { licence_no: 'LIC-200' }, club: 'Junior Licence FC' }), rec({ person: { licence_no: 'LIC-404' }, club: 'Nobody FC' })];
  must(await importJson(owner, src, rows), 201);
  const q = await queue(owner, src);
  assert.equal(q.length, 2, 'the child\'s row is hidden without consent');
  const mine = q.find((r) => r.club_name === 'Licence FC');
  assert.deepEqual([mine.user.id, mine.match_method, mine.person.licence_no], [p.id, 'licence', 'lic-100']);
  assert.equal(q.find((r) => r.club_name === 'Nobody FC').user, null);
  must(await review(owner, mine, { decision: 'accept' }));
  // the child's row: consent first
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'participation' } }), 201);
  const kidRow = (await queue(owner, src)).find((r) => r.club_name === 'Junior Licence FC');
  assert.equal(kidRow.user.id, kid.id);
  must(await review(owner, kidRow, { decision: 'accept' }));

  const link1 = must(await api('POST', '/me/passport-links', { token: p.token, body: { show_career: true } }), 201);
  const pub = must(await api('GET', `/passport/${link1.token}`));
  assert.equal(pub.memberships[0].club, 'Licence FC'); assert.equal(pub.memberships[0].external_source, src.name); assert.equal(pub.memberships[0].verified_via, 'external_file');
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'recruitment_sharing' } }), 201);
  const klink = must(await api('POST', '/me/passport-links', { token: mum.token, body: { show_career: true, athlete_id: kid.id } }), 201);
  assert.equal(must(await api('GET', `/passport/${klink.token}`)).memberships.length, 0, 'a young person\'s career is never on a share link (existing rule), so outside-source entries are not either');
});
