// Official eligibility, conflict of interest and appeals (REF-R09, #1000): the event's eligibility policy, the evaluation of one
// assignment, overrides, declared conflicts and their decisions, and the appeal that opens a canonical support case.
// Driven over REST against a real Postgres, like the other officials suites: everyone signs up through the public API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { encrypt } = await import('../src/crypto.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body).slice(0, 400)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `oe_${n}_${roles[0]}`, display_name: `Elig ${n}`, email: `oe${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (days, hour) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An organiser's event with one fixture and a referee who has been asked to officiate it. */
async function world(sport = 'basketball') {
  const org = await signup(['organizer']);
  const caps = [await signup(['athlete']), await signup(['athlete'])];
  const teams = [];
  for (const [i, c] of caps.entries()) teams.push(must(await api('POST', '/teams', { token: c.token, body: { name: `OE${n}-${i}`, sport } }), 201));
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Eligibility Cup ${n}`, sport } }), 201);
  for (const [i, c] of caps.entries()) {
    const e = must(await api('POST', `/events/${ev.id}/entries`, { token: c.token, body: { team_id: teams[i].id } }), 201);
    await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } });
  }
  const fixture = must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: teams[0].id, away_team_id: teams[1].id, scheduled_at: at(20, 10) } }), 201);
  const ref = await signup(['referee']);
  must(await api('POST', '/me/sport-profiles', { token: ref.token, body: { sport, role: 'referee' } }), 201);
  must(await api('POST', `/fixtures/${fixture.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } }), 201);
  const fo = must(await api('GET', '/me/official-assignments', { token: ref.token }))[0];
  return { org, ev, fixture, ref, fo };
}

test('policy: the organiser sets it, others cannot, and an official with nothing against them is eligible', async () => {
  const { org, ev, ref, fo, fixture } = await world();
  const stranger = await signup(['organizer']);
  const p0 = must(await api('GET', `/events/${ev.id}/official-eligibility-policy`, { token: org.token }));
  assert.equal(p0.official_conflict_declaration_required ?? false, false);
  const p1 = must(await api('PUT', `/events/${ev.id}/official-eligibility-policy`, { token: org.token, body: { official_min_age: 18, official_conflict_declaration_required: true } }));
  assert.equal(p1.official_min_age, 18);
  assert.ok([403, 404].includes((await api('PUT', `/events/${ev.id}/official-eligibility-policy`, { token: stranger.token, body: { official_min_age: 21 } })).status));
  assert.equal((await api('PUT', `/events/${ev.id}/official-eligibility-policy`, { token: org.token, body: { official_min_age: 9 } })).status, 400, 'a minimum age below 16 is refused');

  const e = must(await api('GET', `/official-assignments/${fo.id}/eligibility`, { token: ref.token }));
  assert.equal(e.eligible, true, JSON.stringify(e).slice(0, 300));
  const list = must(await api('GET', `/fixtures/${fixture.id}/officials/eligibility`, { token: org.token }));
  assert.ok(JSON.stringify(list).includes(fo.id));
  assert.ok([403, 404].includes((await api('GET', `/official-assignments/${fo.id}/eligibility`, { token: stranger.token })).status), 'someone unrelated cannot read an assignment\'s eligibility');
  assert.equal((await api('GET', `/official-assignments/${fo.id}/eligibility`)).status, 401);
});

test('conflict of interest: declared by the official, blocks acceptance until decided, detail is never returned in clear to others', async () => {
  const { org, ev, ref, fo } = await world();
  const other = await signup(['referee']);
  must(await api('PUT', `/events/${ev.id}/official-eligibility-policy`, { token: org.token, body: { official_conflict_declaration_required: true } }));
  assert.ok([403, 404].includes((await api('POST', `/official-assignments/${fo.id}/conflicts`, { token: other.token, body: { kind: 'family_member', detail: 'Not my assignment at all' } })).status), 'only the assigned official declares');
  const decl = must(await api('POST', `/official-assignments/${fo.id}/conflicts`, { token: ref.token, body: { kind: 'family_member', counterparty: 'Home team', detail: 'My cousin plays for the home team' } }), 201);
  assert.equal(decl.status, 'open');
  const raw = (await pool.query('SELECT * FROM official_conflicts WHERE id=$1', [decl.id])).rows[0];
  assert.ok(!JSON.stringify(raw).includes('cousin'), 'the detail is encrypted at rest');

  const blocked = must(await api('GET', `/official-assignments/${fo.id}/eligibility`, { token: ref.token }));
  assert.equal(blocked.eligible, false, 'an undecided declaration blocks eligibility when the event requires decisions');
  assert.equal((await api('POST', `/official-assignments/${fo.id}/respond`, { token: ref.token, body: { response: 'accept' } })).status, 409, 'and the assignment cannot be confirmed');

  const seen = must(await api('GET', `/official-assignments/${fo.id}/conflicts`, { token: org.token }));
  assert.ok((seen.items ?? seen).some((x) => x.id === decl.id));
  assert.ok([403, 404].includes((await api('POST', `/official-conflicts/${decl.id}/decision`, { token: ref.token, body: { decision: 'waive' } })).status), 'the official cannot decide their own declaration');
  const dec = must(await api('POST', `/official-conflicts/${decl.id}/decision`, { token: org.token, body: { decision: 'waive', decision_note: 'Distant relation, accepted by both clubs' } }));
  assert.equal(dec.status, 'waived');
  assert.equal((await api('POST', `/official-conflicts/${decl.id}/decision`, { token: org.token, body: { decision: 'escalate' } })).status, 409, 'a decided declaration is not decided twice');
  assert.equal(must(await api('GET', `/official-assignments/${fo.id}/eligibility`, { token: ref.token })).eligible, true);
  assert.equal((await api('POST', `/official-assignments/${fo.id}/respond`, { token: ref.token, body: { response: 'accept' } })).status, 200);

  // a second declaration can be withdrawn by the official while it is open
  const d2 = must(await api('POST', `/official-assignments/${fo.id}/conflicts`, { token: ref.token, body: { kind: 'other', detail: 'Entered by mistake, please ignore' } }), 201);
  assert.equal(must(await api('POST', `/official-conflicts/${d2.id}/withdraw`, { token: ref.token, body: {} })).status, 'withdrawn');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM official_conflicts WHERE fixture_official_id=$1', [fo.id])).rows[0].n, 2, 'nothing is deleted');
});

test('minimum age, overrides and appeals: a blocked official can be overridden with a reason or can appeal through a support case', async () => {
  const { org, ev, ref, fo } = await world();
  must(await api('PUT', `/events/${ev.id}/official-eligibility-policy`, { token: org.token, body: { official_min_age: 30 } }));
  const young = new Date(Date.now() - 22 * 365.25 * 864e5).toISOString().slice(0, 10);
  await pool.query('UPDATE users SET dob_enc=$2 WHERE id=$1', [ref.id, encrypt(young, 'users.dob')]);   // the date of birth lives encrypted on the account
  const e = must(await api('GET', `/official-assignments/${fo.id}/eligibility`, { token: ref.token }));
  assert.equal(e.eligible, false);
  const factor = e.factors.find((f) => f.state === 'ineligible');
  assert.ok(factor, JSON.stringify(e).slice(0, 300));
  assert.equal((await api('POST', `/official-assignments/${fo.id}/respond`, { token: ref.token, body: { response: 'accept' } })).status, 400, 'the server refuses the acceptance, not just the screen');

  // appeal: opens one canonical support case, linked to the fixture
  const appeal = must(await api('POST', `/official-assignments/${fo.id}/eligibility/appeal`, { token: ref.token, body: { grounds: 'I hold a senior national licence and the age rule should not apply.' } }), 201);
  const kase = (await pool.query('SELECT c.kind, c.category, c.requester_id, c.status, l.entity_type FROM cases c JOIN case_links l ON l.case_id=c.id WHERE c.id=$1', [appeal.case_id])).rows[0];
  assert.deepEqual([kase.kind, kase.category, kase.requester_id, kase.status, kase.entity_type], ['support', 'events', ref.id, 'open', 'fixture']);
  const msg = (await pool.query('SELECT body_enc FROM case_messages WHERE case_id=$1', [appeal.case_id])).rows[0];
  assert.ok(msg.body_enc && !msg.body_enc.includes('senior national'), 'the grounds are stored encrypted');
  assert.ok([403, 404].includes((await api('POST', `/official-assignments/${fo.id}/eligibility/appeal`, { token: org.token, body: { grounds: 'The organiser cannot appeal for them.' } })).status));

  // override: organiser only, needs a reason and an expiry, and can be revoked
  const key = factor.key;
  assert.equal(key, 'min_age');
  assert.ok(!/record shows/.test(factor.detail ?? ''), 'the evaluation does not reveal the official\'s age');
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();
  assert.ok([403, 404].includes((await api('POST', `/official-assignments/${fo.id}/eligibility/override`, { token: ref.token, body: { factor_key: key, reason: 'I override myself', override_expires_at: expires } })).status));
  const ov = must(await api('POST', `/official-assignments/${fo.id}/eligibility/override`, { token: org.token, body: { factor_key: key, reason: 'Federation exemption granted for this match', override_expires_at: expires } }), 201);
  assert.equal(must(await api('GET', `/official-assignments/${fo.id}/eligibility`, { token: ref.token })).eligible, true, 'the override lifts the block');
  const ovs = must(await api('GET', `/official-assignments/${fo.id}/eligibility/overrides`, { token: org.token }));
  assert.ok((ovs.items ?? ovs).some((x) => x.id === ov.id));
  assert.equal((await api('POST', `/official-assignments/${fo.id}/eligibility/override`, { token: org.token, body: { factor_key: 'suspension', reason: 'Trying to override a suspension', override_expires_at: expires } })).status >= 400, true, 'a suspension can never be overridden here');
  must(await api('POST', `/official-eligibility-overrides/${ov.id}/revoke`, { token: org.token, body: {} }));
  assert.equal(must(await api('GET', `/official-assignments/${fo.id}/eligibility`, { token: ref.token })).eligible, false, 'revoking brings the block back');
});

test('every eligibility and conflict capability is on REST, OpenAPI and MCP', async () => {
  const names = ['get_eligibility_policy', 'update_eligibility_policy', 'evaluate_official_eligibility', 'list_fixture_eligibility', 'grant_eligibility_override', 'revoke_eligibility_override', 'list_eligibility_overrides',
    'appeal_eligibility_decision', 'declare_official_conflict', 'list_official_conflicts', 'decide_official_conflict', 'withdraw_official_conflict'];
  for (const nm of names) assert.equal(capabilities.filter((c) => c.name === nm).length, 1, `${nm} is registered`);
  const spec = must(await api('GET', '/openapi.json'));
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nm of names) assert.ok(ops.has(nm), `${nm} in OpenAPI`);
  const who = await signup(['referee']);
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${who.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await r.text();
  for (const nm of names) assert.ok(text.includes(`"${nm}"`), `${nm} in MCP`);
});
