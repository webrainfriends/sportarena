import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `oh_${n}_${roles[0]}`, display_name: `Home ${n}`, email: `oh${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (days, hour, min = 0) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, min, 0, 0); return d.toISOString(); };
const PDF = Buffer.from('%PDF-1.4 fake evidence body').toString('base64');

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('oh_root','oh_root','{admin}','x','x','oh_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
});
after(async () => { server.close(); await pool.end(); });

async function setup(sport = 'basketball', evExtra = {}) {
  const org = await signup(['organizer']);
  const caps = await Promise.all([signup(['athlete']), signup(['athlete']), signup(['athlete']), signup(['athlete'])]);
  const teams = [];
  for (const [i, c] of caps.entries()) teams.push(must(await api('POST', '/teams', { token: c.token, body: { name: `OH${n}-${i}`, sport } }), 201));
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Open ${n}`, sport } }), 201);
  if (Object.keys(evExtra).length) must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: evExtra }));
  for (const [i, c] of caps.entries()) {
    const e = must(await api('POST', `/events/${ev.id}/entries`, { token: c.token, body: { team_id: teams[i].id } }), 201);
    await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } });
  }
  const fx = async (scheduled_at, pair = 0, extra = {}) => must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: teams[pair * 2].id, away_team_id: teams[pair * 2 + 1].id, scheduled_at, ...extra } }), 201);
  return { org, ev, teams, fx, caps };
}
const referee = async (sport = 'basketball') => {
  const r = await signup(['referee']);
  must(await api('POST', '/me/sport-profiles', { token: r.token, body: { sport, role: 'referee' } }), 201);
  return r;
};
const invite = (org, fixtureId, user, role = 'referee') => api('POST', `/fixtures/${fixtureId}/officials`, { token: org.token, body: { user_id: user.id, role } });
const mine = async (u) => must(await api('GET', '/me/official-assignments', { token: u.token }));
const accept = (u, id) => api('POST', `/official-assignments/${id}/respond`, { token: u.token, body: { response: 'accept' } });
const verifyReferee = async (u, sport = 'basketball') => {
  const sp = (await pool.query('SELECT id FROM sports WHERE slug=$1', [sport])).rows[0].id;
  const c = must(await api('POST', '/verification/cases', { token: u.token, body: { type: 'referee', sport: sp, claim_note: 'Grade 3, State Association', evidence: [{ kind: 'id_document', data: PDF, file_name: 'id.pdf' }, { kind: 'federation_licence', reference: 'REF-1234' }] } }), 201);
  must(await api('POST', `/admin/verification/cases/${c.id}/claim`, { token: admin.token }));
  const rules = must(await api('GET', '/verification/rules'));
  const checklist = rules.types.find((t) => t.type === 'referee').checklist.map((x) => ({ key: x.key, ok: true }));
  must(await api('POST', `/admin/verification/cases/${c.id}/decision`, { token: admin.token, body: { decision: 'approve', checklist } }));
  return c;
};

test('referee verification extends the canonical service; policy "verified" is enforced at invite AND accept', async () => {
  const { org, fx } = await setup('basketball', { official_policy: 'verified' });
  const plain = await referee(), badged = await referee();
  const f = await fx(at(20, 9));
  assert.equal((await invite(org, f.id, plain)).status, 400, 'unverified official refused by the server, not just hidden in the UI');
  const stranger = await signup(['athlete']);
  assert.equal((await api('PATCH', `/events/${(await pool.query('SELECT event_id FROM fixtures WHERE id=$1', [f.id])).rows[0].event_id}`, { token: stranger.token, body: { official_policy: 'optional' } })).status, 403);
  await verifyReferee(badged);
  assert.equal((await invite(org, f.id, badged)).status, 201);
  assert.equal((await invite(org, f.id, badged, 'scorer')).status, 201, 'scorers carry no officiating credential');
  // a badge that lapses after the invite blocks the accept
  await pool.query("UPDATE verification_cases SET expires_at = now() - interval '1 day' WHERE subject_id=$1 AND type='referee'", [badged.id]);
  const [a] = (await mine(badged)).filter((x) => x.role === 'referee');
  assert.equal((await accept(badged, a.id)).status, 400);
  const home = must(await api('GET', '/me/officials/home', { token: badged.token }));
  assert.equal(home.credential.state, 'expired');
  assert.ok(home.inbox.some((x) => x.kind === 'credential'));
  assert.equal(must(await api('GET', '/me/officials/home', { token: plain.token })).credential.state, 'self_declared');
});

test('policy "licensed" needs an active federation licence of the minimum grade', async () => {
  const { org, fx } = await setup('basketball', { official_policy: 'licensed', official_min_grade_rank: 2 });
  const ref = await referee();
  const f = await fx(at(21, 9));
  assert.equal((await invite(org, f.id, ref)).status, 400);
});

test('availability: time off and the travel buffer are enforced on invite and on reschedule', async () => {
  const { org, fx } = await setup();
  const ref = await referee();
  must(await api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'Asia/Kolkata', buffer_min: 60, travel_km: 40, region: 'Bengaluru' } }));
  assert.equal((await api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'Not/AZone' } })).status, 400);
  const off = must(await api('POST', '/me/officials/availability/time-off', { token: ref.token, body: { starts_at: at(22, 0), ends_at: at(22, 23), note: 'Family' } }), 201);
  const blocked = await fx(at(22, 9));
  assert.equal((await invite(org, blocked.id, ref)).status, 409);
  must(await api('POST', `/me/officials/availability/${off.id}/remove`, { token: ref.token }));
  assert.equal((await invite(org, blocked.id, ref)).status, 201);
  // 60 minute buffer: 09:00-10:30 confirmed, so 11:00 is too close, 12:00 is fine
  must(await accept(ref, (await mine(ref))[0].id));
  const near = await fx(at(22, 11), 1);
  assert.equal((await invite(org, near.id, ref)).status, 409, 'inside the buffer');
  assert.equal((await api('PATCH', `/fixtures/${near.id}`, { token: org.token, body: { scheduled_at: at(22, 12) } })).status, 200);
  assert.equal((await invite(org, near.id, ref)).status, 201);
  const second = (await mine(ref)).find((x) => x.fixture_id === near.id);
  assert.equal((await accept(ref, second.id)).status, 200);
  assert.equal((await api('PATCH', `/fixtures/${near.id}`, { token: org.token, body: { scheduled_at: at(22, 10, 45) } })).status, 409, 'reschedule keeps the same buffer rule');
  // time off over confirmed matches reports them, never drops them
  const t = must(await api('POST', '/me/officials/availability/time-off', { token: ref.token, body: { starts_at: at(22, 8), ends_at: at(22, 10) } }), 201);
  assert.equal(t.affected_assignments.length, 1);
});

test('Officials Home and calendar: today, pending, inbox, conflicts; sources are canonical', async () => {
  const { org, fx } = await setup();
  const ref = await referee();
  must(await api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'UTC', buffer_min: 0 } }));
  must(await api('POST', '/me/officials/availability/weekly', { token: ref.token, body: { windows: [{ weekday: new Date(at(30, 9)).getUTCDay(), start_minute: 8 * 60, end_minute: 18 * 60 }] } }));
  const soon = await fx(at(1, 23, 0)), later = await fx(at(30, 9), 1), outside = await fx(at(31, 9), 0);
  for (const f of [soon, later, outside]) assert.equal((await invite(org, f.id, ref)).status, 201);
  let home = must(await api('GET', '/me/officials/home', { token: ref.token }));
  assert.equal(home.stats.pending, 3);
  assert.equal(home.pending_requests.length, 3);
  assert.ok(home.inbox.filter((x) => x.kind === 'invitation').length === 3);
  const rows = await mine(ref);
  for (const r of rows) assert.equal((await accept(ref, r.id)).status, 200);
  home = must(await api('GET', '/me/officials/home', { token: ref.token }));
  assert.equal(home.stats.pending, 0);
  assert.equal(home.next.fixture_id, soon.id);
  assert.ok(home.inbox.some((x) => x.kind === 'checklist' && x.fixture_id === soon.id), 'pre-match checks outstanding');
  const cal = must(await api('GET', '/me/officials/calendar', { token: ref.token, query: { from: at(25, 0), to: at(40, 0) } }));
  const e30 = cal.entries.find((e) => e.fixture_id === later.id), e31 = cal.entries.find((e) => e.fixture_id === outside.id);
  assert.equal(e30.source_type, 'fixture_official');
  assert.equal(e30.outside_availability, false);
  assert.equal(e31.outside_availability, true, 'weekday has no window');
  assert.equal((await api('GET', '/me/officials/calendar', { token: ref.token, query: { from: at(0, 0), to: at(100, 0) } })).status, 400);
  // another official sees nothing of mine
  const other = await referee();
  assert.equal(must(await api('GET', '/me/officials/home', { token: other.token })).stats.this_week, 0);
});

test('history: completed derives from the fixture, with report and verification-at-the-time', async () => {
  const { org, fx } = await setup();
  const ref = await referee();
  await verifyReferee(ref);
  const f = await fx(at(2, 9));
  await invite(org, f.id, ref);
  await accept(ref, (await mine(ref))[0].id);
  must(await api('POST', `/fixtures/${f.id}/result`, { token: org.token, body: { home_score: 2, away_score: 1 } }));
  const h = must(await api('GET', '/me/officials/history', { token: ref.token }));
  assert.equal(h.items[0].status, 'completed');
  assert.equal(h.items[0].verified_at_the_time, true);
  assert.deepEqual(h.totals.map((t) => [t.role, t.matches]), [['referee', 1]]);
  assert.equal((await mine(ref))[0].status, 'completed');
  const home = must(await api('GET', '/me/officials/home', { token: ref.token }));
  assert.equal(home.stats.completed_this_season, 1);
  assert.ok(home.inbox.some((x) => x.kind === 'report_due'));
  must(await api('POST', `/fixtures/${f.id}/reports`, { token: ref.token, body: { category: 'match_report', summary: 'Played to a close finish' } }), 201);
  assert.ok(!must(await api('GET', '/me/officials/home', { token: ref.token })).inbox.some((x) => x.kind === 'report_due'));
  assert.equal(must(await api('GET', '/me/officials/history', { token: ref.token })).items[0].reports_filed, 1);
});

test('briefing + checklist: crew and organiser only; ticks are logged and idempotent; youth names withheld', async () => {
  const { org, fx } = await setup('football');
  const ref = await referee('football'), outsider = await referee('football');
  const f = await fx(at(3, 9));
  await invite(org, f.id, ref);
  assert.equal((await api('GET', `/fixtures/${f.id}/briefing`, { token: ref.token })).status, 404, 'invited, not yet crew');
  await accept(ref, (await mine(ref))[0].id);
  const b = must(await api('GET', `/fixtures/${f.id}/briefing`, { token: ref.token }));
  assert.equal(b.my_role, 'referee');
  assert.equal(b.sport.slug, 'football');
  assert.ok(b.rules.book && b.rules.standard_hash && b.structure.periods.count >= 1);
  assert.ok(b.checklist.length >= 6 && b.checklist.every((c) => c.done === false));
  assert.equal((await api('GET', `/fixtures/${f.id}/briefing`, { token: outsider.token })).status, 404);
  assert.equal((await api('POST', `/fixtures/${f.id}/briefing/checks`, { token: outsider.token, body: { item_key: 'field_ready', done: true } })).status, 404);
  assert.equal((await api('POST', `/fixtures/${f.id}/briefing/checks`, { token: ref.token, body: { item_key: 'nonsense', done: true } })).status, 400);
  for (let k = 0; k < 3; k++) must(await api('POST', `/fixtures/${f.id}/briefing/checks`, { token: ref.token, body: { item_key: 'field_ready', done: true } }));
  must(await api('POST', `/fixtures/${f.id}/briefing/checks`, { token: org.token, body: { item_key: 'equipment_checked', done: true } }));
  const after = must(await api('GET', `/fixtures/${f.id}/briefing`, { token: org.token }));
  assert.deepEqual(after.checklist.filter((c) => c.done).map((c) => c.key).sort(), ['equipment_checked', 'field_ready']);
  const hist = must(await api('GET', `/fixtures/${f.id}/briefing/checks/history`, { token: ref.token }));
  assert.equal(hist.length, 2, 'repeat ticks do not add rows');
  assert.equal(JSON.stringify(b).includes('email'), false, 'no private contact details');
});

test('reports: encrypted, append-only revisions, visibility, no clinical detail, organiser told', async () => {
  const { org, fx } = await setup();
  const ref = await referee(), lines = await referee(), outsider = await referee();
  const f = await fx(at(4, 9));
  for (const [u, role] of [[ref, 'referee'], [lines, 'linesman']]) { await invite(org, f.id, u, role); await accept(u, (await mine(u))[0].id); }
  const body = { category: 'misconduct', summary: 'Abuse towards the crew', note: 'Number 7 used abusive language after the whistle.' };
  assert.equal((await api('POST', `/fixtures/${f.id}/reports`, { token: outsider.token, body })).status, 404);
  assert.equal((await api('POST', `/fixtures/${f.id}/reports`, { token: ref.token, body: { ...body, note: 'Player has a fractured wrist and a concussion diagnosis' } })).status, 400);
  assert.equal((await api('POST', `/fixtures/${f.id}/reports`, { token: ref.token, body: { ...body, team_id: '00000000-0000-4000-8000-000000000000' } })).status, 400);
  const r = must(await api('POST', `/fixtures/${f.id}/reports`, { token: ref.token, body }), 201);
  const stored = (await pool.query('SELECT note_enc FROM official_report_revisions WHERE report_id=$1', [r.id])).rows[0].note_enc;
  assert.ok(stored && !stored.includes('abusive'), 'note is encrypted at rest');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=(SELECT organizer_id FROM events WHERE id=(SELECT event_id FROM fixtures WHERE id=$1)) AND kind='official_report'", [f.id])).rowCount === 1);
  const asOrg = must(await api('GET', `/fixtures/${f.id}/reports`, { token: org.token }));
  assert.equal(asOrg.length, 1); assert.match(asOrg[0].note, /abusive/);
  assert.equal(must(await api('GET', `/fixtures/${f.id}/reports`, { token: lines.token })).length, 0, "another official does not see this one");
  assert.equal((await api('GET', `/official-reports/${r.id}`, { token: lines.token })).status, 404);
  assert.equal((await api('POST', `/official-reports/${r.id}/revise`, { token: lines.token, body: { summary: 'x y', reason: 'no way' } })).status, 404);
  must(await api('POST', `/official-reports/${r.id}/revise`, { token: ref.token, body: { summary: 'Abuse towards the crew (amended)', reason: 'Added the time', visibility: 'author' } }));
  assert.equal(must(await api('GET', `/fixtures/${f.id}/reports`, { token: org.token })).length, 0, 'author kept the revision private');
  const full = must(await api('GET', `/official-reports/${r.id}`, { token: ref.token }));
  assert.deepEqual(full.revisions.map((v) => v.revision), [2, 1]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'official_report.%'")).rows[0].n >= 3, true);
});

test('Ask the rules: cited answers, declines calls and result changes, admits gaps', async () => {
  const { org, fx } = await setup('football');
  const ref = await referee('football');
  const f = await fx(at(5, 9));
  await invite(org, f.id, ref); await accept(ref, (await mine(ref))[0].id);
  const ask = (question, extra = {}) => api('GET', '/officials/rules/ask', { token: ref.token, query: { question, fixture_id: f.id, ...extra } });
  const ok = must(await ask('What happens when the ball is offside and how does a free kick restart play?'));
  assert.ok(ok.citations.length >= 1 && ok.citations[0].source.includes('('), 'grounded in a cited section');
  assert.ok(ok.rule_version.standard_hash);
  for (const q of ['Should I give a red card for that tackle?', 'Was that a foul by number 7?', 'Change the score to 3-2 for the home team']) {
    const d = must(await ask(q));
    assert.equal(d.declined, true, q); assert.equal(d.answer, null);
  }
  const gap = must(await ask('Which broadcaster holds the streaming contract for sponsors?'));
  assert.equal(gap.insufficient, true);
  // the assistant cannot mutate anything
  const before = (await pool.query('SELECT home_score, away_score, status FROM fixtures WHERE id=$1', [f.id])).rows[0];
  await ask('Change the score to 9-9');
  assert.deepEqual((await pool.query('SELECT home_score, away_score, status FROM fixtures WHERE id=$1', [f.id])).rows[0], before);
  const stranger = await signup(['athlete']);
  assert.equal((await api('GET', '/officials/rules/ask', { token: stranger.token, query: { question: 'How many players are on the field?', fixture_id: f.id } })).status, 404);
});

test('REST / OpenAPI / MCP share the new officials capabilities', async () => {
  const names = ['get_officials_home', 'get_official_calendar', 'get_my_official_availability', 'save_my_official_prefs', 'set_my_weekly_availability', 'add_my_time_off', 'remove_my_time_off', 'list_my_officiating_history', 'get_match_briefing', 'set_briefing_check', 'get_briefing_check_history', 'file_official_report', 'revise_official_report', 'list_fixture_official_reports', 'get_official_report', 'ask_official_rules'];
  for (const nm of names) assert.ok(capabilities.some((c) => c.name === nm), nm);
  const spec = must(await api('GET', '/openapi.json'));
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nm of names) assert.ok(ops.has(nm), `${nm} in OpenAPI`);
  const ref = await referee();
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ref.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await r.text();
  for (const nm of names) assert.ok(text.includes(`"${nm}"`), `${nm} in MCP`);
  assert.equal((await api('GET', '/me/officials/home')).status, 401);
});

test('an organisation-owned event works for crew: briefing, reports and the organisation team keep access', async () => {
  const { org, ev, fx } = await setup('football');
  const ref = await referee('football');
  const o = must(await api('POST', '/organisations', { token: org.token, body: { name: `Assoc ${n}`, kind: 'club', city: 'Riverside' } }), 201);
  await pool.query('UPDATE events SET organisation_id=$2 WHERE id=$1', [ev.id, o.id]);
  const f = await fx(at(6, 9));
  must(await invite(org, f.id, ref), 201);
  await accept(ref, (await mine(ref))[0].id);
  assert.equal((await api('GET', `/fixtures/${f.id}/briefing`, { token: ref.token })).status, 200);
  must(await api('POST', `/fixtures/${f.id}/reports`, { token: ref.token, body: { category: 'venue_incident', summary: 'Pitch lighting failed for ten minutes' } }), 201);
  assert.equal(must(await api('GET', `/fixtures/${f.id}/reports`, { token: org.token })).length, 1);
});
