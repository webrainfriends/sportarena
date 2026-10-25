import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
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
const key = () => `idem-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `om_${n}_${roles[0]}`, display_name: `Market ${n}`, email: `om${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const team = async (owner) => must(await api('POST', '/teams', { token: owner.token, body: { name: `Falcons ${++n}`, sport: 'football' } }), 201);
const create = (u, body) => api('POST', '/billboard', { token: u.token, body: { title: `Opportunity ${++n}`, sport: 'football', ...body } });
const apply = (u, p, body = {}) => api('POST', `/billboard/${p.id}/responses`, { token: u.token, body: { message: 'Pick me', ...body } });
const verify = (u, type = 'coach') => pool.query("INSERT INTO verification_cases(subject_type, subject_id, type, status, decided_at, expires_at, requested_by, rules_version) VALUES ('user', $1, $2, 'approved', now(), now() + interval '1 year', $1, 1)", [u.id, type]);
const savePrefs = async (u) => must(await api('POST', '/me/recruitment-preferences', { token: u.token, body: { version: 0, sport_slugs: ['football'], levels: ['amateur'], regions: ['Mumbai'], open_to: ['trial'], open_to_contact: true, notes: 'Private note for selectors' } }));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('om_root','om_root','{admin}','x','x','om_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('post terms: pay is stated honestly and invalid combinations are refused', async () => {
  const mgr = await signup(['coach']), t = await team(mgr);
  const bad = async (body, text) => { const r = await create(mgr, body); assert.equal(r.status, 400, JSON.stringify(r.body));  assert.match(JSON.stringify(r.body), text); };
  await bad({ kind: 'assignment', opportunity_type: 'paid_assignment', team_id: t.id }, /how much/);
  await bad({ kind: 'assignment', opportunity_type: 'volunteering', compensation: 'paid', budget_cents: 100 }, /not paid/);
  await bad({ kind: 'assignment', opportunity_type: 'volunteering', compensation: 'unpaid', budget_cents: 100 }, /no amount/);
  await bad({ kind: 'assignment', opportunity_type: 'paid_assignment', compensation: 'paid', budget_cents: 5000 }, /team that pays/);
  await bad({ kind: 'team_recruiting', opportunity_type: 'sponsorship', team_id: t.id }, /sponsor/i);
  await bad({ kind: 'sponsorship_wanted', opportunity_type: 'trial' }, /sponsorship/i);
  await bad({ kind: 'team_recruiting', team_id: t.id, closes_at: new Date(Date.now() - 1000).toISOString() }, /future/);
  await bad({ kind: 'match_players', starts_at: inDays(2), closes_at: inDays(3) }, /before the work starts/);
  await bad({ kind: 'match_players', budget_cents: 100, currency: 'ZZZ' }, /Unsupported|supported/);
  assert.equal((await create(mgr, { kind: 'assignment', opportunity_type: 'volunteering', target_type: 'event', target_id: '00000000-0000-4000-8000-000000000001' })).status, 404);
  // unstated pay stays unstated; volunteering defaults to unpaid; paid work carries a currency
  const free = must(await create(mgr, { kind: 'match_players', opportunity_type: 'trial' }), 201);
  assert.equal(free.compensation, null);
  const vol = must(await create(mgr, { kind: 'assignment', opportunity_type: 'volunteering', title: 'Ball crew' }), 201);
  assert.equal(vol.compensation, 'unpaid');
  const paid = must(await create(mgr, { kind: 'assignment', opportunity_type: 'paid_assignment', team_id: t.id, budget_cents: 250000, currency: 'GBP' }), 201);
  assert.deepEqual([paid.compensation, paid.currency], ['paid', 'GBP']);
  // legacy clients that send only a budget still work and get the platform currency
  const legacy = must(await create(mgr, { kind: 'team_recruiting', team_id: t.id, budget_cents: 5000, rate_unit: 'match' }), 201);
  assert.equal(legacy.currency, 'INR');
  const list = must(await api('GET', '/billboard', { query: { opportunity_type: 'volunteering' } }));
  assert.ok(list.every((p) => p.opportunity_type === 'volunteering') && list.some((p) => p.id === vol.id));
  assert.equal(must(await api('GET', '/billboard', { query: { paid: 'true', opportunity_type: 'paid_assignment' } })).some((p) => p.id === paid.id), true);
});

test('closed, filled and expired opportunities reject applications; expired ones leave the default list', async () => {
  const mgr = await signup(['coach']), a = await signup(), b = await signup(), c = await signup();
  const open = must(await create(mgr, { kind: 'match_players', closes_at: inDays(2) }), 201);
  const r = must(await apply(a, open), 201);
  assert.ok(r.id);
  await pool.query("UPDATE billboard_posts SET closes_at = now() - interval '1 minute' WHERE id=$1", [open.id]);
  const late = await apply(b, open);
  assert.equal(late.status, 409);
  assert.equal(code(late), 'opportunity_closed');
  assert.ok(!must(await api('GET', '/billboard', { query: { q: open.title } })).some((p) => p.id === open.id), 'expired posts are not listed by default');
  const shown = must(await api('GET', '/billboard', { query: { q: open.title, include_closed: 'true' } })).find((p) => p.id === open.id);
  assert.equal(shown.is_expired, true);
  // taken down
  const down = must(await create(mgr, { kind: 'match_players' }), 201);
  must(await api('POST', `/billboard/${down.id}/close`, { token: mgr.token }));
  assert.equal(code(await apply(c, down)), 'opportunity_closed');
  // filled
  const one = must(await create(mgr, { kind: 'assignment', opportunity_type: 'volunteering', positions_needed: 1 }), 201);
  const ra = must(await apply(a, one), 201);
  must(await api('PATCH', `/billboard/responses/${ra.id}`, { token: mgr.token, body: { status: 'accepted' } }));
  assert.equal(code(await apply(c, one)), 'positions_filled');
});

test('applicant evidence: required sections, selector-only access, only what the applicant allowed, changeable while open', async () => {
  const mgr = await signup(['coach']), t = await team(mgr), a = await signup(), stranger = await signup(['coach']);
  await savePrefs(a);
  const p = must(await create(mgr, { kind: 'team_recruiting', team_id: t.id, required_sections: ['preferences'] }), 201);
  const none = await apply(a, p);
  assert.equal(none.status, 400);
  assert.equal(code(none), 'evidence_required');
  const r = must(await apply(a, p, { shared_sections: ['preferences'], idempotency_key: key() }), 201);
  assert.deepEqual(r.shared_sections, ['preferences']);
  const staff = must(await api('GET', `/billboard/responses/${r.id}/application`, { token: mgr.token }));
  assert.equal(staff.evidence.preferences.notes, 'Private note for selectors');
  assert.equal(staff.evidence.availability, null, 'sections the applicant did not share stay hidden');
  assert.equal(staff.evidence.academic, null);
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE action='read_recruitment_evidence' AND entity_id=$1", [r.id])).rows.length, 1);
  // applicants see what they share, never the evidence payload; strangers see nothing
  const self = must(await api('GET', `/billboard/responses/${r.id}/application`, { token: a.token }));
  assert.equal(self.evidence, undefined);
  assert.deepEqual(self.application.shared_sections, ['preferences']);
  assert.equal((await api('GET', `/billboard/responses/${r.id}/application`, { token: stranger.token })).status, 403);
  // the required section cannot be dropped; extra ones can be added and removed, and each change is recorded
  const share = (sections, row_version, token = a.token) => api('POST', `/billboard/responses/${r.id}/sharing`, { token, body: { shared_sections: sections, row_version, idempotency_key: key() } });
  assert.equal(code(await share([], self.application.row_version)), 'evidence_required');
  assert.equal((await share(['preferences', 'availability'], self.application.row_version, stranger.token)).status, 403);
  const widened = must(await share(['preferences', 'availability'], self.application.row_version));
  assert.deepEqual(widened.shared_sections, ['preferences', 'availability']);
  assert.equal(code(await share(['preferences'], self.application.row_version)), 'stale_version');
  const after = must(await api('GET', `/billboard/responses/${r.id}/application`, { token: mgr.token }));
  assert.notEqual(after.evidence.availability, null);
  assert.ok(after.events.some((e) => e.kind === 'evidence'));
  // once decided, sharing is closed
  must(await api('PATCH', `/billboard/responses/${r.id}`, { token: mgr.token, body: { status: 'declined' } }));
  assert.equal(code(await share(['preferences'], widened.row_version + 1)), 'closed_application');
});

test('verified-applicants-only and role profiles are enforced on the server', async () => {
  const mgr = await signup(['coach']), a = await signup(), v = await signup();
  await verify(v, 'coach');
  const p = must(await create(mgr, { kind: 'match_players', verified_applicants_only: true }), 201);
  assert.equal((await apply(a, p)).status, 403);
  must(await apply(v, p), 201);
  const ref = must(await create(mgr, { kind: 'assignment', opportunity_type: 'volunteering', title: 'Referee' }), 201);
  assert.equal(ref.opportunity_type, 'volunteering');
});

const bad = async (u, body, text) => { const r = await create(u, body); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(JSON.stringify(r.body), text); };

test('accepted work becomes a canonical engagement: event role, settlement record, roster member; decisions stay in the history', async () => {
  const org = await signup(['organizer']), mgr = await signup(['coach']), t = await team(mgr), a = await signup(), b = await signup();
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'City Cup', sport: 'football' } }), 201);
  // volunteering attached to an event -> association
  const vol = must(await create(org, { kind: 'assignment', opportunity_type: 'volunteering', target_type: 'event', target_id: ev.id, positions_needed: 1 }), 201);
  assert.equal(vol.compensation, 'unpaid');
  await bad(org, { kind: 'assignment', opportunity_type: 'volunteering', target_type: 'event', target_id: ev.id, target_role: 'organizer' }, /cannot be filled/);
  await bad(org, { kind: 'assignment', opportunity_type: 'volunteering', target_type: 'event', target_id: ev.id, target_role: 'scorer' }, /cannot be filled/);
  assert.equal((await create(a, { kind: 'assignment', opportunity_type: 'volunteering', target_type: 'event', target_id: ev.id })).status, 403, 'only a manager of the event can attach work to it');
  const ra = must(await apply(a, vol), 201);
  must(await api('PATCH', `/billboard/responses/${ra.id}`, { token: org.token, body: { status: 'accepted' } }));
  const assoc = (await pool.query("SELECT role, status FROM associations WHERE user_id=$1 AND target_type='event' AND target_id=$2", [a.id, ev.id])).rows;
  assert.deepEqual(assoc, [{ role: 'volunteer', status: 'active' }]);
  const view = must(await api('GET', `/billboard/responses/${ra.id}/application`, { token: a.token }));
  assert.equal(view.engagement.type, 'association');
  assert.equal(view.engagement.payout, null);
  assert.ok(view.events.some((e) => e.kind === 'engagement'));
  // a paid assignment -> exactly one payout record due in the team ledger, referenced from the application
  const paid = must(await create(mgr, { kind: 'assignment', opportunity_type: 'paid_assignment', team_id: t.id, budget_cents: 250000, currency: 'INR', positions_needed: 2, ends_at: inDays(10) }), 201);
  const rb = must(await apply(b, paid), 201);
  must(await api('PATCH', `/billboard/responses/${rb.id}`, { token: mgr.token, body: { status: 'accepted' } }));
  const pay = (await pool.query('SELECT p.*, r.payout_id FROM team_payouts p JOIN billboard_responses r ON r.payout_id=p.id WHERE r.id=$1', [rb.id])).rows;
  assert.equal(pay.length, 1);
  assert.deepEqual([pay[0].user_id, pay[0].team_id, Number(pay[0].amount_cents), pay[0].currency, pay[0].status], [b.id, t.id, 250000, 'INR', 'due']);
  const mine = must(await api('GET', `/billboard/responses/${rb.id}/application`, { token: b.token }));
  assert.equal(mine.engagement.payout.status, 'due');
  const ledger = must(await api('GET', `/teams/${t.id}/payouts`, { token: mgr.token }));
  assert.ok(ledger.some((x) => x.id === mine.engagement.payout.id && x.status === 'due'), 'the team sees it in the existing settlement ledger');
  // deciding twice does not pay twice
  assert.equal((await api('PATCH', `/billboard/responses/${rb.id}`, { token: mgr.token, body: { status: 'accepted' } })).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_payouts WHERE team_id=$1', [t.id])).rows[0].n, 1);
  // roster post -> team member engagement
  const roster = must(await create(mgr, { kind: 'team_recruiting', team_id: t.id }), 201);
  const rr = must(await apply(a, roster), 201);
  must(await api('PATCH', `/billboard/responses/${rr.id}`, { token: mgr.token, body: { status: 'accepted' } }));
  const row = (await pool.query('SELECT engagement_type, engagement_id FROM billboard_responses WHERE id=$1', [rr.id])).rows[0];
  assert.deepEqual([row.engagement_type, row.engagement_id], ['team_member', t.id]);
});

test('only one applicant can take the last place when two selections race', async () => {
  const mgr = await signup(['coach']), t = await team(mgr), a = await signup(), b = await signup();
  const p = must(await create(mgr, { kind: 'assignment', opportunity_type: 'paid_assignment', team_id: t.id, budget_cents: 10000, currency: 'INR', positions_needed: 1 }), 201);
  const ra = must(await apply(a, p), 201), rb = must(await apply(b, p), 201);
  const res = await Promise.all([ra, rb].map((r) => api('PATCH', `/billboard/responses/${r.id}`, { token: mgr.token, body: { status: 'accepted' } })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_payouts WHERE team_id=$1', [t.id])).rows[0].n, 1);
});

test('applying is idempotent and one application per person', async () => {
  const mgr = await signup(['coach']), a = await signup();
  const p = must(await create(mgr, { kind: 'match_players' }), 201);
  const k = key();
  const first = must(await apply(a, p, { idempotency_key: k }), 201);
  const again = must(await apply(a, p, { idempotency_key: k }), 201);
  assert.equal(again.id, first.id);
  assert.equal(again.replayed, true);
  assert.equal((await apply(a, p, { idempotency_key: key() })).status, 409);
  assert.equal((await apply(mgr, p)).status, 400, 'you cannot apply to your own post');
});

test('publisher verification is shown and filterable; fraud reports are support cases linked to the post', async () => {
  const mgr = await signup(['coach']), other = await signup(), reporter = await signup();
  await verify(mgr, 'coach');
  const good = must(await create(mgr, { kind: 'match_players' }), 201), rogue = must(await create(other, { kind: 'match_players' }), 201);
  const list = must(await api('GET', '/billboard'));
  assert.equal(list.find((x) => x.id === good.id).publisher_verified, true);
  assert.equal(list.find((x) => x.id === rogue.id).publisher_verified, false);
  assert.ok(must(await api('GET', '/billboard', { query: { verified_publisher: 'true' } })).every((x) => x.publisher_verified));
  const rep = must(await api('POST', '/cases', { token: reporter.token, body: { kind: 'support', category: 'marketplace_report', subject: 'Asks for upfront fee', description: 'The poster asked me to send money before a trial.', links: [{ type: 'billboard_post', id: rogue.id }] } }), 201);
  assert.equal(rep.category, 'marketplace_report');
  const links = (await pool.query('SELECT entity_type, entity_id FROM case_links WHERE case_id=$1', [rep.id])).rows;
  assert.deepEqual(links, [{ entity_type: 'billboard_post', entity_id: rogue.id }]);
  assert.equal((await api('POST', '/cases', { token: reporter.token, body: { kind: 'support', category: 'marketplace_report', subject: 'Bad link', description: 'does not exist at all', links: [{ type: 'billboard_post', id: '00000000-0000-4000-8000-000000000009' }] } })).status, 404);
  // the reporter's case is theirs alone
  assert.equal((await api('GET', `/cases/${rep.id}`, { token: other.token })).status, 404);
});

test('matching knows pay, deadlines and verified-only; REST, OpenAPI and MCP agree', async () => {
  const mgr = await signup(['coach']), t = await team(mgr), a = await signup();
  must(await api('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'football', role: 'athlete' } }), 201);
  const p = must(await create(mgr, { kind: 'assignment', opportunity_type: 'paid_assignment', team_id: t.id, budget_cents: 90000, currency: 'INR', closes_at: inDays(5), verified_applicants_only: true, title: 'Match scorer needed' }), 201);
  const find = async (q) => (must(await api('GET', '/me/opportunity-matches', { token: a.token, query: { kinds: 'team_opening', include_ineligible: 'true', ...q } })).items).find((x) => x.opportunity.id === p.id);
  const hit = await find({});
  assert.ok(hit);
  assert.equal(hit.opportunity.compensation, 'paid');
  assert.deepEqual([hit.opportunity.pay.cents, hit.opportunity.pay.currency], [90000, 'INR']);
  assert.equal(hit.eligible, false, 'verified-only posts are not an eligible match for an unverified player');
  assert.ok(hit.rules.some((r) => r.rule === 'verification' && r.status === 'mismatch'));
  assert.ok(hit.rules.some((r) => r.rule === 'deadline' && r.status === 'match'));
  assert.ok(!JSON.stringify(hit).includes('which positions it needs'), 'an assignment has no playing position to ask for');
  await pool.query("UPDATE billboard_posts SET closes_at = now() - interval '1 minute' WHERE id=$1", [p.id]);
  assert.equal(await find({}), undefined, 'expired posts are not matched');
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(spec.paths['/billboard/{id}/responses'].post && spec.paths['/billboard/responses/{id}/sharing'].post);
  const tools = (await rpc('tools/list', {}, mgr.token)).tools.map((x) => x.name);
  for (const nme of ['create_billboard_post', 'list_billboard', 'respond_to_post', 'set_application_sharing', 'get_recruitment_application']) assert.ok(tools.includes(nme), nme);
  const viaMcp = await rpc('tools/call', { name: 'list_billboard', arguments: { opportunity_type: 'paid_assignment', include_closed: true } }, mgr.token);
  assert.ok(!viaMcp.isError, JSON.stringify(viaMcp));
  const viaRest = must(await api('GET', '/billboard', { query: { opportunity_type: 'paid_assignment', include_closed: 'true' } }));
  assert.deepEqual(JSON.parse(viaMcp.content[0].text).map((x) => x.id), viaRest.map((x) => x.id));
});
