// Organisation profile, the agreements wizard (template → draft → submit → approve → signed copy) and per-scope jersey numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, raw, type, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { ...(raw ? { 'content-type': type ?? 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `oa_${n}_${roles[0]}`, display_name: `Org Agr ${n}`, email: `oa${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('an organisation is created with legal identity, contact details, a full address and linked teams; contact details stay with staff', async () => {
  const owner = await signup(), other = await signup();
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: 'Existing FC', sport: 'football' } }), 201);
  const o = must(await api('POST', '/organisations', { token: owner.token, body: {
    name: 'Sportstars', kind: 'academy', legal_name: 'Sportstars Academy Pvt Ltd', registration_no: 'U12345', tax_id: 'GST-1', website: 'https://sportstars.example', contact_email: 'hello@sportstars.example', contact_phone: '+91 44 0000 0000',
    founded_on: '2015-06-01', address: { line1: '1 Marina Road', locality: 'Chennai', region: 'Tamil Nadu', postal_code: '600001', country: 'IN' }, team_ids: [team.id] } }), 201);
  assert.equal(o.city, 'Chennai', 'city follows the address locality');
  const addrs = must(await api('GET', '/addresses', { token: owner.token, query: { owner_kind: 'organisation', owner_id: o.id } }));
  assert.equal(addrs.length, 1); assert.equal(addrs[0].is_default, true); assert.equal(addrs[0].line1, '1 Marina Road');
  assert.equal((await pool.query('SELECT organisation_id FROM teams WHERE id=$1', [team.id])).rows[0].organisation_id, o.id);
  assert.equal(must(await api('GET', `/organisations/${o.id}`, { token: owner.token })).legal_name, 'Sportstars Academy Pvt Ltd');
  const seen = must(await api('GET', `/organisations/${o.id}`, { token: other.token }));
  assert.equal(seen.contact_email, undefined); assert.equal(seen.tax_id, undefined);
  // someone else's team cannot be pulled in
  assert.equal((await api('POST', '/organisations', { token: other.token, body: { name: 'Thieves', team_ids: [team.id] } })).status, 403);
  // create a team straight into the organisation
  const t2 = must(await api('POST', '/teams', { token: owner.token, body: { name: 'Under 14', sport: 'football', organisation_id: o.id } }), 201);
  assert.equal(t2.organisation_id, o.id);
  assert.equal((await api('POST', '/teams', { token: other.token, body: { name: 'Nope', sport: 'football', organisation_id: o.id } })).status, 404);
});

test('agreement wizard: template, draft text, submit, approve by an owner, publish as policy, signed copy upload and exports', async () => {
  const owner = await signup(), admin = await signup(), outsider = await signup();
  const o = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Riverside', kind: 'academy', address: { locality: 'Bristol', country: 'GB' } } }), 201);
  must(await api('POST', `/organisations/${o.id}/members`, { token: owner.token, body: { person: admin.handle, role: 'admin' } }), 201);
  must(await api('POST', `/organisations/${o.id}/invite/respond`, { token: admin.token, body: { accept: true } }));

  const tpls = must(await api('GET', '/agreement-templates', { token: admin.token }));
  assert.ok(tpls.length >= 10 && tpls.some((t) => t.key === 'participation'));
  const draft = must(await api('POST', `/organisations/${o.id}/agreements/draft-text`, { token: admin.token, body: { id: o.id, template_key: 'participation', counterparty: 'Asha Kumar', effective_from: '2030-01-01', effective_to: '2030-12-31', auto_renew: true, governing_country: 'GB', fee_minor: 15000, currency: 'GBP' } }));
  assert.equal(draft.ai, false);
  assert.match(draft.body, /Riverside/); assert.match(draft.body, /Asha Kumar/); assert.match(draft.body, /GBP 150/); assert.match(draft.body, /United Kingdom/);
  assert.equal((await api('POST', `/organisations/${o.id}/agreements/draft-text`, { token: outsider.token, body: { id: o.id, template_key: 'participation' } })).status, 404);

  const a = must(await api('POST', `/organisations/${o.id}/agreements`, { token: admin.token, body: { id: o.id, kind: 'participation', template_key: 'participation', title: 'Participation terms 2030', body: draft.body, counterparty: 'Asha Kumar', parties: [{ role: 'Participant', name: 'Asha Kumar' }], effective_from: '2030-01-01', effective_to: '2030-12-31', auto_renew: true, governing_country: 'GB' } }), 201);
  assert.equal(a.status, 'draft');
  assert.equal((await api('POST', `/organisations/${o.id}/agreements`, { token: admin.token, body: { id: o.id, kind: 'other', title: 'Bad dates', effective_from: '2030-02-01', effective_to: '2030-01-01' } })).status, 400);
  assert.equal((await api('GET', `/org-agreements/${a.id}`, { token: outsider.token })).status, 404);

  // exports work on a draft
  const pdf = await api('GET', `/org-agreements/${a.id}/export`, { token: admin.token, query: { format: 'pdf' } });
  assert.equal(pdf.status, 200); assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  const doc = await api('GET', `/org-agreements/${a.id}/export`, { token: admin.token, query: { format: 'doc' } });
  assert.equal(doc.status, 200); assert.match(doc.body.toString(), /Participation terms 2030/);
  assert.equal((await api('GET', `/org-agreements/${a.id}/export`, { token: outsider.token })).status, 404);

  must(await api('PATCH', `/org-agreements/${a.id}`, { token: admin.token, body: { title: 'Participation terms 2030 v2', parties: [{ role: 'Participant', name: 'Asha Kumar' }, { role: 'Guardian', name: 'R Kumar' }] } }));
  assert.equal((await api('PUT', `/org-agreements/${a.id}/files`, { token: admin.token, raw: Buffer.from('%PDF-1.4 signed'), query: { kind: 'signed' } })).status, 409, 'nothing to sign before approval');
  const sub = must(await api('POST', `/org-agreements/${a.id}/submit`, { token: admin.token }));
  assert.equal(sub.status, 'submitted');
  assert.equal((await api('PATCH', `/org-agreements/${a.id}`, { token: admin.token, body: { title: 'sneaky' } })).status, 409, 'fixed once submitted');
  assert.equal((await api('POST', `/org-agreements/${a.id}/decision`, { token: admin.token, body: { decision: 'approve' } })).status, 403, 'an admin cannot approve');

  const back = must(await api('POST', `/org-agreements/${a.id}/decision`, { token: owner.token, body: { decision: 'request_changes', note: 'Add the refund link' } }));
  assert.equal(back.status, 'changes_requested');
  must(await api('PATCH', `/org-agreements/${a.id}`, { token: admin.token, body: { body: `${draft.body}\n\nSee the refund policy.` } }));
  must(await api('POST', `/org-agreements/${a.id}/submit`, { token: admin.token }));
  assert.equal((await api('POST', `/org-agreements/${a.id}/decision`, { token: owner.token, body: { decision: 'reject' } })).status, 400, 'a reason is needed');
  const ok = must(await api('POST', `/org-agreements/${a.id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  assert.equal(ok.status, 'approved'); assert.ok(ok.policy_id, 'published as a versioned policy');
  const policies = must(await api('GET', `/organisations/${o.id}/policies`, { token: owner.token }));
  assert.equal(policies.length, 1); assert.equal(policies[0].title, 'Participation terms 2030 v2'); assert.match(policies[0].body, /refund policy/);

  assert.equal((await api('PUT', `/org-agreements/${a.id}/files`, { token: admin.token, raw: Buffer.from('not a pdf at all'), query: { kind: 'signed' } })).status, 400);
  assert.equal((await api('PUT', `/org-agreements/${a.id}/files`, { token: outsider.token, raw: Buffer.from('%PDF-1.4 x'), query: { kind: 'signed' } })).status, 404);
  const file = must(await api('PUT', `/org-agreements/${a.id}/files`, { token: admin.token, raw: Buffer.from('%PDF-1.4 signed copy'), query: { kind: 'signed', label: 'Signed by both parties' } }), 201);
  const after = must(await api('GET', `/org-agreements/${a.id}`, { token: owner.token }));
  assert.equal(after.status, 'signed'); assert.equal(after.files.length, 1); assert.equal(after.parties.length, 2);
  const dl = await api('GET', `/org-agreement-files/${file.id}`, { token: owner.token });
  assert.equal(dl.status, 200); assert.equal(dl.body.toString(), '%PDF-1.4 signed copy');
  assert.equal((await api('GET', `/org-agreement-files/${file.id}`, { token: outsider.token })).status, 404);
  const onDisk = (await pool.query('SELECT file_name FROM org_agreement_files WHERE id=$1', [file.id])).rows[0];
  assert.match(onDisk.file_name, /\.bin$/);

  const list = must(await api('GET', `/organisations/${o.id}/agreements`, { token: owner.token }));
  assert.equal(list.length, 1); assert.equal(list[0].signed_files, 1);
  must(await api('DELETE', `/org-agreement-files/${file.id}`, { token: owner.token }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_agreement_files')).rows[0].n, 1, 'hidden, not deleted');
  must(await api('DELETE', `/org-agreements/${a.id}`, { token: owner.token }));
  assert.equal(must(await api('GET', `/organisations/${o.id}/agreements`, { token: owner.token })).length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_agreements')).rows[0].n, 1, 'archived, not deleted');
});

test('jersey numbers differ per team, event, game and tournament and resolve most-specific first', async () => {
  const cap1 = await signup(), player = await signup(), stranger = await signup();
  const team = must(await api('POST', '/teams', { token: cap1.token, body: { name: 'Jersey FC', sport: 'football' } }), 201);
  must(await api('POST', `/teams/${team.id}/members`, { token: cap1.token, body: { user_id: player.id, jersey_no: 7 } }), 201);
  const ev = must(await api('POST', '/events', { token: cap1.token, body: { name: 'Cup', sport: 'football', kind: 'tournament' } }), 201);
  const fx = (await pool.query("INSERT INTO fixtures(event_id, home_team_id, scheduled_at, round) VALUES ($1,$2,now(),'Final') RETURNING id", [ev.id, team.id])).rows[0];

  assert.equal(must(await api('GET', '/jersey-numbers/resolve', { token: player.token, query: { team_id: team.id } })).number, 7);
  must(await api('POST', '/jersey-numbers', { token: player.token, body: { scope_kind: 'event', scope_id: ev.id, number: 10 } }));
  must(await api('POST', '/jersey-numbers', { token: player.token, body: { scope_kind: 'game', scope_id: fx.id, number: 99 } }));
  assert.deepEqual(must(await api('GET', '/jersey-numbers/resolve', { token: player.token, query: { game_id: fx.id, team_id: team.id } })), { number: 99, source: 'game' });
  assert.equal(must(await api('GET', '/jersey-numbers/resolve', { token: player.token, query: { event_id: ev.id, team_id: team.id } })).number, 10);
  assert.equal((await api('POST', '/jersey-numbers', { token: stranger.token, body: { scope_kind: 'team', scope_id: team.id, number: 3, user_id: player.id } })).status, 403);
  must(await api('POST', '/jersey-numbers', { token: cap1.token, body: { scope_kind: 'team', scope_id: team.id, number: 8, user_id: player.id } }));
  assert.equal((await pool.query('SELECT jersey_no FROM team_members WHERE team_id=$1 AND user_id=$2', [team.id, player.id])).rows[0].jersey_no, 8, 'roster follows');
  assert.equal((await api('POST', '/jersey-numbers', { token: player.token, body: { scope_kind: 'tournament', scope_id: ev.id, number: 1000 } })).status, 400);
  const mine = must(await api('GET', '/jersey-numbers', { token: player.token }));
  assert.equal(mine.length, 3); assert.ok(mine.find((r) => r.scope_kind === 'game').scope_name.includes('Final'));
  assert.equal(must(await api('GET', '/jersey-numbers', { token: cap1.token, query: { scope_kind: 'team', scope_id: team.id } })).length, 1);
  assert.equal((await api('GET', '/jersey-numbers', { token: stranger.token, query: { scope_kind: 'team', scope_id: team.id } })).status, 403);
});
