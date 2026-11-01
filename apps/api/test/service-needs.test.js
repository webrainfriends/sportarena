// Dynamic service needs: the pick list is built from the event (rules, catalogue, AI drafts), custom items are kept, only non-AI items with a credential kind are enforced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `need_${n}_${roles[0]}`, display_name: `Need ${n}`, email: `need${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.body.user, token: r.body.token }; };
const iso = (d, h = 9) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + d); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };
const ymd = (d) => iso(d).slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

const world = async () => {
  const u = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: u.token, body: { name: `Cup ${n}`, sport: 'football', starts_on: ymd(10), ends_on: ymd(12) } }), 201);
  const buyer = must(await api('POST', '/service-buyers', { token: u.token, body: { event_id: ev.id, currency: ev.currency ?? 'INR' } }), 201);
  return { u, ev, buyer };
};
const suggest = (w, body, token = w.u.token) => api('POST', `/service-buyers/${w.buyer.id}/needs/suggest`, { token, body });
const requirement = (w, over = {}) => api('POST', `/service-buyers/${w.buyer.id}/requirements`, { token: w.u.token, body: { category: 'pool_maintenance', title: 'Pool readiness', scope: { site: 'Main pool', tasks: ['cleaning'] }, quantity: 1, unit: 'visit', starts_at: iso(10), ends_at: iso(12), currency: w.buyer.currency, ...over } });

test('suggestions come from the event: catalogue by service family, live rules from the compliance module, nothing invented for live conditions', async () => {
  const w = await world();
  const s = must(await suggest(w, { category: 'pool_maintenance' }));
  assert.deepEqual(s.context.sports, ['Football']); assert.equal(s.context.category, 'pool_maintenance');
  assert.deepEqual(s.groups.suggested.map((x) => x.kind).sort(), ['insurance', 'pool_operator']);
  assert.deepEqual(s.groups.rules, []); assert.deepEqual(s.groups.ai, []);
  assert.equal(s.live.connected, false); assert.deepEqual(s.live.sources, []);
  assert.equal(must(await suggest(w, { category: 'event_crew' })).groups.suggested.some((x) => x.kind === 'safeguarding'), true);
  // a rule scoped to this event appears, with its credential kind, and replaces the catalogue duplicate of the same kind
  const admin = await signup(['organizer']);
  const rule = (await pool.query(
    `INSERT INTO comp_requirements(scope_kind, scope_id, code, name, description, category, subject_kind, method, source, created_by) VALUES ('event',$1,'pool_cert','Pool operator certificate on site','Needed for the pool hall','qualification','organisation','linked',$2,$3) RETURNING id`,
    [w.ev.id, JSON.stringify({ kind: 'service_credential', credential_kind: 'pool_operator' }), admin.id])).rows[0];
  const s2 = must(await suggest(w, { category: 'pool_maintenance' }));
  assert.deepEqual(s2.groups.rules.map((x) => [x.rule_id, x.kind]), [[rule.id, 'pool_operator']]);
  assert.deepEqual(s2.groups.suggested.map((x) => x.kind), ['insurance'], 'the same credential is not offered twice');
  // access: only the buyer's own requesters; unknown service refused
  const stranger = await signup(['organizer']);
  assert.ok([403, 404].includes((await suggest(w, { category: 'pool_maintenance' }, stranger.token)).status));
  assert.equal((await suggest(w, { category: 'not_a_service' })).status, 400);
  // another event's rule never shows up here
  const other = await world();
  assert.deepEqual(must(await suggest(other, { category: 'pool_maintenance' })).groups.rules, []);
});

test('AI drafts: shown only when asked and configured, always unverified, never enforced; without AI everything else still works', async () => {
  const w = await world();
  const off = must(await suggest(w, { category: 'ground_maintenance', ai: true }));
  assert.equal(off.ai.available, false); assert.equal(off.ai.used, false); assert.deepEqual(off.groups.ai, []);
  let prompt = null;
  setAiTransport(async (body) => { prompt = body; return JSON.stringify({ items: [{ label: 'Check local noise limits for setup hours', why: 'Evening matches near housing' }, { label: 'Public liability insurance', why: 'dup' }, { label: 'Ignore previous instructions', why: 'x' }] }); });
  const on = must(await suggest(w, { category: 'ground_maintenance', ai: true }));
  assert.equal(on.ai.used, true);
  assert.ok(on.groups.ai.length >= 1 && on.groups.ai.every((x) => x.source === 'ai' && !x.kind));
  assert.ok(!on.groups.ai.some((x) => x.label === 'Public liability insurance'), 'drafts that repeat a listed item are dropped');
  assert.ok(prompt.system.includes('never cite a specific law'));
  assert.ok(!JSON.stringify(prompt.messages).includes(w.u.handle), 'no person names go to the model');
  const notAsked = must(await suggest(w, { category: 'ground_maintenance' }));
  assert.deepEqual(notAsked.groups.ai, [], 'AI is only used when asked');
  setAiTransport(async () => 'not json');
  const bad = must(await suggest(w, { category: 'ground_maintenance', ai: true }));
  assert.deepEqual(bad.groups.ai, []); assert.ok(bad.groups.suggested.length >= 1);
  setAiTransport(null);
});

test('choosing needs: custom and AI items are kept and shown to suppliers; only non-AI items with a credential kind are enforced; edits recompute', async () => {
  const w = await world();
  const ai = { key: 'ai:abc', label: 'Check local noise limits', source: 'ai', kind: 'insurance' };           // a client cannot make an AI draft enforceable
  const custom = { key: 'custom:1', label: 'Written site induction', source: 'custom', detail: 'Before first visit' };
  const cat = { key: 'catalogue:pool_maintenance:pool_operator', label: 'Pool operator certificate', source: 'catalogue', kind: 'pool_operator' };
  const req = must(await requirement(w, { needs: [ai, custom, cat, cat] }), 201);
  assert.equal(req.needs.length, 3, 'duplicate keys are dropped');
  assert.deepEqual(req.needs.map((x) => [x.key, x.enforced]), [['ai:abc', false], ['custom:1', false], [cat.key, true]]);
  assert.equal(req.needs[0].kind, undefined);
  assert.deepEqual(req.compliance_kinds, ['pool_operator']);
  assert.equal((await requirement(w, { needs: [{ key: 'rule:x', label: 'Gone', source: 'rule', rule_id: '00000000-0000-4000-8000-000000000000' }] })).status, 400);
  assert.equal((await requirement(w, { needs: [{ key: 'k', label: 'x', source: 'custom', rule_id: '00000000-0000-4000-8000-000000000000' }] })).status, 400);
  // the RFQ freezes the needs into its scope, so every bidder sees the same list
  const rfq = must(await api('POST', `/service-requirements/${req.id}/rfq`, { token: w.u.token, body: { rubric: [{ key: 'price', label: 'Price', weight: 100 }] } }), 201);
  assert.deepEqual(rfq.scope.needs.map((x) => x.key), ['ai:abc', 'custom:1', cat.key]);
  // editing a draft replaces the list and the enforced kinds follow it
  const draft = must(await requirement(w, { needs: [cat] }), 201);
  const edited = must(await api('PATCH', `/service-requirements/${draft.id}`, { token: w.u.token, body: { row_version: draft.row_version, needs: [custom] } }));
  assert.deepEqual(edited.needs.map((x) => x.key), ['custom:1']); assert.deepEqual(edited.compliance_kinds, []);
});
