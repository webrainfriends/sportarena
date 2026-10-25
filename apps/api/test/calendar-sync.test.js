import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const ics = await import('../src/ics.js');

let server, base;
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* ics */ }
  return { status: r.status, body: json, text, type: r.headers.get('content-type') };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await call('POST', '/auth/register', { body: { handle: `cs_${n}_${roles[0]}`, display_name: `Cal ${n}`, email: `cs${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (offsetDays, hour, min = 0) => { const d = new Date(Date.now() + offsetDays * 864e5); d.setUTCHours(hour, min, 0, 0); return d.toISOString(); };
const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { ics.setIcsFetcher(); server.close(); await pool.end(); });

test('ics: recurrence runs in wall-clock time across daylight saving, honours EXDATE/overrides, ignores cancelled and free events', () => {
  const text = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:weekly', 'DTSTART;TZID=Europe/London:20260323T180000', 'DTEND;TZID=Europe/London:20260323T190000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;TZID=Europe/London:20260406T180000', 'SUMMARY:secret title', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:cancelled', 'DTSTART:20260325T100000Z', 'DTEND:20260325T110000Z', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:free', 'DTSTART:20260325T100000Z', 'DTEND:20260325T110000Z', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:day', 'DTSTART;VALUE=DATE:20260327', 'DTEND;VALUE=DATE:20260329', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const { busy } = ics.parseBusy(text, { tz: 'UTC', winStart: Date.UTC(2026, 2, 1), winEnd: Date.UTC(2026, 5, 1) });
  const weekly = busy.filter((b) => b.uid === 'weekly').map((b) => new Date(b.startMs).toISOString());
  // 23 Mar is GMT (18:00Z), 30 Mar is BST after the clocks change (17:00Z), 6 Apr is excluded
  assert.deepEqual(weekly, ['2026-03-23T18:00:00.000Z', '2026-03-30T17:00:00.000Z']);
  assert.equal(busy.filter((b) => ['cancelled', 'free'].includes(b.uid)).length, 0);
  const day = busy.find((b) => b.uid === 'day');
  assert.ok(day.allDay && day.endMs - day.startMs === 2 * 864e5);
  assert.throws(() => ics.parseBusy('hello', { winStart: 0, winEnd: 1 }), /calendar/);
});

test('ics: the writer folds long lines, escapes text and emits all-day dates', () => {
  const out = ics.writeIcs({ name: 'S', tz: 'UTC', events: [{ uid: 'a', startMs: Date.UTC(2026, 0, 1, 9), endMs: Date.UTC(2026, 0, 1, 10), summary: `Match, "A"; ${'é'.repeat(80)}`, allDay: false }, { uid: 'b', startMs: Date.UTC(2026, 0, 5), endMs: Date.UTC(2026, 0, 6), summary: 'Day', allDay: true }] });
  assert.ok(out.includes('DTSTART:20260101T090000Z') && out.includes('DTSTART;VALUE=DATE:20260105'));
  assert.ok(out.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  assert.ok(out.includes('Match\\, "A"\\;'));
});

test('imports refuse private networks, non-https addresses and credentials', async () => {
  for (const bad of ['http://example.com/a.ics', 'https://127.0.0.1/a.ics', 'https://localhost/a.ics', 'https://10.0.0.5/a.ics', 'https://[::1]/a.ics', 'https://user:pw@example.com/a.ics', 'https://example.com:8443/a.ics', 'not a url']) {
    assert.throws(() => ics.normalizeCalendarUrl(bad), (e) => e.status === 400, bad);
  }
  assert.equal(ics.normalizeCalendarUrl('webcal://example.com/a.ics').protocol, 'https:');
  assert.ok(ics.isPrivateAddress('169.254.169.254') && ics.isPrivateAddress('::ffff:10.1.1.1') && !ics.isPrivateAddress('8.8.8.8'));
  const a = await signup();
  const r = await call('POST', '/me/calendar-imports', { token: a.token, body: { url: 'https://169.254.169.254/latest/meta-data' } });
  assert.equal(r.status, 400);
});

test('preferences: time zone, availability windows and travel buffers are validated, versioned and archived not deleted', async () => {
  const a = await signup(), other = await signup();
  assert.equal((await call('GET', '/me/calendar-sync')).status, 401);
  const first = await call('GET', '/me/calendar-sync', { token: a.token });
  assert.equal(first.status, 200); assert.equal(first.body.version, 0); assert.deepEqual(first.body.windows, []); assert.deepEqual(first.body.feeds, []);

  const save = (token, body) => call('POST', '/me/calendar-preferences', { token, body });
  assert.equal((await save(a.token, { version: 0, timezone: 'Mars/Base' })).status, 400);
  assert.equal((await save(a.token, { version: 0, windows: [{ weekday: 1, from_time: '18:00', to_time: '17:00' }] })).status, 400, 'ends after it starts');
  assert.equal((await save(a.token, { version: 0, windows: [{ weekday: 1, from_time: '09:00', to_time: '12:00' }, { weekday: 1, from_time: '11:00', to_time: '14:00' }] })).status, 400, 'no overlap');
  assert.equal((await save(a.token, { version: 0, buffers: [{ kind: 'match', before_min: 600, after_min: 0 }] })).status, 400);
  const ok = await save(a.token, { version: 0, timezone: 'Asia/Kolkata', windows: [{ weekday: 1, from_time: '18:00', to_time: '21:00' }], buffers: [{ kind: 'match', before_min: 45, after_min: 15 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.timezone, 'Asia/Kolkata'); assert.equal(ok.body.version, 1); assert.equal(ok.body.windows[0].timezone, 'Asia/Kolkata');
  assert.equal((await save(a.token, { version: 0, timezone: 'UTC' })).status, 409, 'creating twice from version 0 is stale');
  assert.equal((await save(a.token, { version: 5, timezone: 'UTC' })).status, 409);
  const re = await save(a.token, { version: 1, windows: [{ weekday: 2, from_time: '07:00', to_time: '09:00' }] });
  assert.equal(re.status, 200); assert.equal(re.body.windows.length, 1); assert.equal(re.body.buffers.length, 1, 'untouched parts stay');
  const archived = await pool.query('SELECT count(*)::int AS n FROM availability_windows WHERE user_id=$1 AND archived_at IS NOT NULL', [a.id]);
  assert.equal(archived.rows[0].n, 1, 'replaced windows are archived');
  assert.equal((await call('GET', '/me/calendar-sync', { token: other.token })).body.version, 0, 'private to the owner');
});

test('subscription feed: busy by default, health hidden, details on request, revocation is immediate, fetches are counted and audited', async () => {
  const a = await signup(), coach = await signup(['coach']);
  await pool.query(`INSERT INTO coach_hires(hirer_id, coach_id, starts_at, duration_min, status) VALUES ($1,$2,$3,45,'confirmed')`, [a.id, coach.id, at(2, 9)]);
  const prov = await signup(['physio']);
  await pool.query(`INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, status) VALUES ($1,$2,$3,30,'confirmed')`, [a.id, prov.id, at(3, 9)]).catch(() => {});

  assert.equal((await call('POST', '/me/calendar-feeds', { body: {} })).status, 401);
  assert.equal((await call('POST', '/me/calendar-feeds', { token: a.token, body: { kinds: ['nonsense'] } })).status, 400);
  const made = await call('POST', '/me/calendar-feeds', { token: a.token, body: { label: 'Phone', kinds: ['training', 'health'] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.ok(made.body.token.startsWith('sa_') && made.body.path.endsWith('.ics'));
  const stored = await pool.query('SELECT token_hash FROM calendar_feeds WHERE id=$1', [made.body.id]);
  assert.notEqual(stored.rows[0].token_hash, made.body.token, 'only a hash is stored');

  const get = (tok) => call('GET', `/calendar/feed/${tok}.ics`);
  const f1 = await get(made.body.token);
  assert.equal(f1.status, 200); assert.match(f1.type, /text\/calendar/);
  assert.ok(f1.text.startsWith('BEGIN:VCALENDAR') && f1.text.includes('SUMMARY:Busy'));
  assert.ok(!f1.text.includes('Session with your coach'), 'busy only by default');
  assert.equal((f1.text.match(/DTEND:/g) ?? []).length, 1 + ((f1.text.match(/Busy/g) ?? []).length - 1), 'every event is closed');
  const dur = /DTSTART:(\d{8}T\d{6}Z)\r\nDTEND:(\d{8}T\d{6}Z)/.exec(f1.text);
  assert.equal(stamp(at(2, 9)), dur[1]); assert.equal(stamp(at(2, 9, 45)), dur[2], 'real 45 minute duration, not the 90 minute assumption');

  const upd = await call('PATCH', `/me/calendar-feeds/${made.body.id}`, { token: a.token, body: { version: 1, detail: 'full' } });
  assert.equal(upd.status, 200); assert.equal(upd.body.version, 2);
  assert.equal((await call('PATCH', `/me/calendar-feeds/${made.body.id}`, { token: a.token, body: { version: 1, detail: 'busy' } })).status, 409, 'stale');
  const f2 = await get(made.body.token);
  assert.ok(f2.text.includes('SUMMARY:Session with your coach'));
  assert.ok(!/Physio|Doctor|Appointment/.test(f2.text), 'health always shows as Busy');

  const prev = await call('GET', `/me/calendar-feeds/${made.body.id}/preview`, { token: a.token });
  assert.equal(prev.status, 200); assert.ok(prev.body.ics.includes('BEGIN:VCALENDAR'));
  assert.equal((await call('GET', `/me/calendar-feeds/${made.body.id}/preview`, { token: (await signup()).token })).status, 404, 'not someone else\'s');
  assert.equal((await call('POST', `/me/calendar-feeds/${made.body.id}/revoke`, { token: (await signup()).token })).status, 404);

  const row = (await pool.query('SELECT fetch_count FROM calendar_feeds WHERE id=$1', [made.body.id])).rows[0];
  assert.equal(row.fetch_count, 2);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE entity='calendar_feeds' AND entity_id=$1 AND action='read_pii'", [made.body.id])).rowCount >= 2);

  assert.equal((await call('POST', `/me/calendar-feeds/${made.body.id}/revoke`, { token: a.token })).status, 200);
  assert.equal((await get(made.body.token)).status, 404, 'revoked links stop at once');
  assert.equal((await get('sa_wrong_token_value')).status, 404);
  assert.equal((await call('PATCH', `/me/calendar-feeds/${made.body.id}`, { token: a.token, body: { version: 2, detail: 'busy' } })).status, 409, 'cannot edit a revoked link');
  const listed = (await call('GET', '/me/calendar-sync', { token: a.token })).body.feeds;
  assert.equal(listed[0].status, 'revoked'); assert.ok(!('token' in listed[0]) && !('token_hash' in listed[0]));
});

test('imports: busy time only, encrypted address, repeatable, soft-removed, failures keep data, shown on the schedule', async () => {
  const a = await signup();
  const text = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap(([uid, s, e]) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${stamp(s)}`, `DTEND:${stamp(e)}`, 'SUMMARY:Dentist at 5 High St', 'DESCRIPTION:private', 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
  let served = text([['e1', at(4, 10), at(4, 11)], ['e2', at(5, 10), at(5, 11)]]);
  let calls = 0;
  ics.setIcsFetcher(async () => { calls++; if (served instanceof Error) throw served; return served; });

  const url = 'https://calendar.example.com/secret-token-123/basic.ics';
  const added = await call('POST', '/me/calendar-imports', { token: a.token, body: { url, label: 'Work' } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.status, 'ok'); assert.equal(added.body.event_count, 2); assert.equal(added.body.source_host, 'calendar.example.com');
  assert.ok(!JSON.stringify(added.body).includes('secret-token'), 'address never returned');
  const raw = (await pool.query('SELECT url_enc FROM calendar_imports WHERE id=$1', [added.body.id])).rows[0];
  assert.ok(raw.url_enc.startsWith('v1.') && !raw.url_enc.includes('secret'), 'address encrypted at rest');
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='calendar_import_events'")).rows.map((r) => r.column_name);
  assert.ok(!cols.some((c) => /title|summary|desc|location|attendee/.test(c)), 'no titles kept');
  assert.equal((await call('POST', '/me/calendar-imports', { token: a.token, body: { url } })).status, 409, 'same calendar twice');

  const sched = async () => (await call('GET', '/me/sport-schedule?kinds=external&to=' + at(10, 0).slice(0, 10), { token: a.token })).body.items;
  let items = await sched();
  assert.equal(items.length, 2); assert.equal(items[0].title, 'Busy'); assert.equal(items[0].context, 'Work');

  // repeat and concurrent syncs never duplicate
  await Promise.all([1, 2, 3].map(() => call('POST', `/me/calendar-imports/${added.body.id}/sync`, { token: a.token })));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM calendar_import_events WHERE import_id=$1', [added.body.id])).rows[0].n, 2);

  // an event moves, another vanishes: updated in place, vanished one is marked removed (row kept)
  served = text([['e1', at(4, 12), at(4, 13)]]);
  assert.equal((await call('POST', `/me/calendar-imports/${added.body.id}/sync`, { token: a.token })).status, 200);
  items = await sched();
  assert.equal(items.length, 1);
  const rows = (await pool.query('SELECT count(*)::int AS n, count(removed_at)::int AS gone FROM calendar_import_events WHERE import_id=$1', [added.body.id])).rows[0];
  assert.equal(rows.n, 3); assert.equal(rows.gone, 2, 'old rows kept, marked removed');

  // source down: explicit error, imported busy time stays
  served = new Error('boom');
  const down = await call('POST', `/me/calendar-imports/${added.body.id}/sync`, { token: a.token });
  assert.equal(down.status, 502);
  assert.equal((await sched()).length, 1, 'previous busy time kept');
  assert.equal((await call('GET', '/me/calendar-sync', { token: a.token })).body.imports[0].status, 'error');
  served = 'not a calendar';
  assert.equal((await call('POST', `/me/calendar-imports/${added.body.id}/sync`, { token: a.token })).status, 400);

  assert.equal((await call('POST', `/me/calendar-imports/${added.body.id}/sync`, { token: (await signup()).token })).status, 404);
  assert.equal((await call('POST', `/me/calendar-imports/${added.body.id}/remove`, { token: a.token })).status, 200);
  assert.equal((await sched()).length, 0, 'removed at once');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM calendar_imports WHERE id=$1', [added.body.id])).rows[0].n, 1, 'soft removal');
  assert.equal((await call('POST', `/me/calendar-imports/${added.body.id}/sync`, { token: a.token })).status, 404);
  assert.ok(calls > 3);
  ics.setIcsFetcher();
});

test('conflicts: real durations, travel buffers, availability, imported busy time and safe resolutions', async () => {
  const a = await signup(), coach = await signup(['coach']);
  const save = (body) => call('POST', '/me/calendar-preferences', { token: a.token, body });
  // buffer needs 30 minutes after training and a Tuesday-evening-only window
  assert.equal((await save({ version: 0, timezone: 'UTC', buffers: [{ kind: 'training', before_min: 0, after_min: 30 }] })).status, 200);

  const hire = async (day, hour, min, dur) => (await pool.query(`INSERT INTO coach_hires(hirer_id, coach_id, starts_at, duration_min, status) VALUES ($1,$2,$3,$4,'confirmed') RETURNING id`, [a.id, coach.id, at(day, hour, min), dur])).rows[0].id;
  const h1 = await hire(3, 10, 0, 60);                     // 10:00-11:00
  const block = (await call('POST', '/me/blocks', { token: a.token, body: { kind: 'gym', starts_at: at(3, 10, 30), ends_at: at(3, 11, 30) } })).body; // overlaps h1
  await hire(3, 11, 15, 30);                               // 11:15-11:45: 15 min after h1 but 30 needed -> buffer

  const r = await call('GET', `/me/schedule-conflicts?from=${at(2, 0).slice(0, 10)}&to=${at(4, 0).slice(0, 10)}`, { token: a.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { conflicts, summary } = r.body;
  const overlap = conflicts.find((c) => c.type === 'overlap' && c.items.some((i) => i.source_id === block.id));
  assert.ok(overlap && overlap.overlap_min === 30 && overlap.severity === 'high');
  assert.ok(overlap.items.every((i) => !i.duration_assumed && i.duration_min > 0));
  const mv = overlap.resolutions.find((x) => x.capability === 'update_athlete_block');
  assert.deepEqual(mv.args, { id: block.id, version: 1 });
  const other = overlap.resolutions.find((x) => x.source_id === h1);
  assert.equal(other.action, 'open'); assert.match(other.note, /never cancelled/, 'canonical bookings are not cancelled from here');
  const buf = conflicts.find((c) => c.type === 'travel_buffer');
  assert.ok(buf && buf.gap_min === 15 && buf.needed_min === 30);
  assert.equal(summary.overlap >= 1 && summary.travel_buffer >= 1, true);
  assert.equal(r.body.availability_configured, false);
  assert.equal(summary.outside_availability, 0, 'no windows set, nothing is outside them');

  // resolve: move the block with the version, stale version refused
  const moved = await call('PATCH', `/me/blocks/${block.id}`, { token: a.token, body: { version: 1, starts_at: at(3, 14), ends_at: at(3, 15) } });
  assert.equal(moved.status, 200); assert.equal(moved.body.version, 2);
  assert.equal((await call('PATCH', `/me/blocks/${block.id}`, { token: a.token, body: { version: 1, title: 'x' } })).status, 409);
  assert.equal((await call('PATCH', `/me/blocks/${block.id}`, { token: a.token, body: { version: 2, ends_at: at(3, 13) } })).status, 400);
  assert.equal((await call('PATCH', `/me/blocks/${block.id}`, { token: (await signup()).token, body: { version: 2, title: 'x' } })).status, 404);
  const r2 = await call('GET', `/me/schedule-conflicts?from=${at(2, 0).slice(0, 10)}&to=${at(4, 0).slice(0, 10)}`, { token: a.token });
  assert.ok(!r2.body.conflicts.some((c) => c.type === 'overlap'), 'overlap is gone');

  // availability: only Mondays 06:00-07:00 -> training is outside
  const cur = (await call('GET', '/me/calendar-sync', { token: a.token })).body;
  await save({ version: cur.version, windows: [{ weekday: 1, from_time: '06:00', to_time: '07:00' }] });
  const r3 = await call('GET', `/me/schedule-conflicts?from=${at(2, 0).slice(0, 10)}&to=${at(4, 0).slice(0, 10)}`, { token: a.token });
  assert.ok(r3.body.availability_configured && r3.body.summary.outside_availability >= 2);
  assert.equal(r3.body.conflicts.find((c) => c.type === 'outside_availability').severity, 'info');

  // imported busy time counts, with its own resolution
  ics.setIcsFetcher(async () => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', `DTSTART:${stamp(at(3, 10, 15))}`, `DTEND:${stamp(at(3, 10, 45))}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  assert.equal((await call('POST', '/me/calendar-imports', { token: a.token, body: { url: 'https://cal.example.org/x.ics' } })).status, 201);
  const r4 = await call('GET', `/me/schedule-conflicts?from=${at(2, 0).slice(0, 10)}&to=${at(4, 0).slice(0, 10)}`, { token: a.token });
  const ext = r4.body.conflicts.find((c) => c.type === 'overlap' && c.items.some((i) => i.source_type === 'external_busy'));
  assert.ok(ext && ext.resolutions.some((x) => x.action === 'external'));
  ics.setIcsFetcher();

  assert.equal((await call('GET', `/me/schedule-conflicts?athlete_id=${coach.id}`, { token: a.token })).status, 404, 'not for people you do not guard');
});

test('team fixtures use their recorded duration, and a team clash offers the RSVP out, never a cancellation', async () => {
  const org = await signup(['organizer']), p = await signup(), coach = await signup(['coach']);
  const ev = (await call('POST', '/events', { token: org.token, body: { name: 'Dur Cup', sport: 'football', kind: 'tournament', starts_on: at(2, 0).slice(0, 10), ends_on: at(2, 0).slice(0, 10) } })).body;
  const mk = async (name) => (await call('POST', '/teams', { token: org.token, body: { name: `${name} ${Math.random().toString(36).slice(2, 6)}`, sport: 'football' } })).body.id;
  const [home, away] = [await mk('Home'), await mk('Away')];
  const fx = (await pool.query(`INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, duration_min) VALUES ($1,$2,$3,$4,'scheduled',60) RETURNING id`, [ev.id, home, away, at(2, 15)])).rows[0].id;
  await pool.query('INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,$3,$4)', [home, p.id, 'player', 'active']);
  await pool.query(`INSERT INTO team_squads(fixture_id, team_id, user_id, status) VALUES ($1,$2,$3,'confirmed')`, [fx, home, p.id]).catch(() => {});
  await pool.query(`INSERT INTO coach_hires(hirer_id, coach_id, starts_at, duration_min, status) VALUES ($1,$2,$3,30,'confirmed')`, [p.id, coach.id, at(2, 15, 45)]);

  const item = (await call('GET', '/me/sport-schedule?kinds=match,team', { token: p.token })).body.items.find((x) => x.title.includes(' v '));
  assert.equal(Date.parse(item.ends_at) - Date.parse(item.starts_at), 60 * 60000, 'the fixture\'s own 60 minutes, not 90');
  const r = (await call('GET', `/me/schedule-conflicts?from=${at(1, 0).slice(0, 10)}&to=${at(3, 0).slice(0, 10)}`, { token: p.token })).body;
  const cf = r.conflicts.find((x) => x.type === 'overlap');
  assert.equal(cf.overlap_min, 15, '15:45-16:00 overlap with a 60 minute fixture (it would be 45 with the old assumption)');
  const out = cf.resolutions.find((x) => x.action === 'rsvp_no');
  assert.equal(out.capability, 'set_event_rsvp'); assert.equal(out.args.id, home);
  assert.equal((await call('POST', `/teams/${out.args.id}/attendance`, { token: p.token, body: { fixture_id: out.args.fixture_id, rsvp: 'no' } })).status, 200);
  assert.ok(cf.resolutions.every((x) => x.capability !== 'cancel_booking'));
});

test('young people: only a verified guardian with current consent can arrange feeds and imports, and withdrawal switches them off', async () => {
  const kid = await signup(), parent = await signup(), stranger = await signup();
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  ics.setIcsFetcher(async () => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:k', `DTSTART:${stamp(at(2, 8))}`, `DTEND:${stamp(at(2, 9))}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));

  assert.equal((await call('POST', '/me/calendar-feeds', { token: kid.token, body: {} })).status, 403, 'a young person cannot arrange sharing alone');
  assert.equal((await call('POST', '/me/calendar-imports', { token: kid.token, body: { url: 'https://cal.example.org/k.ics' } })).status, 403);
  assert.equal((await call('POST', '/me/calendar-feeds', { token: stranger.token, body: { athlete_id: kid.id } })).status, 404, 'existence not leaked');
  assert.equal((await call('POST', '/me/calendar-feeds', { token: parent.token, body: { athlete_id: kid.id } })).status, 409, 'consent needed first');
  assert.equal((await call('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { child_id: kid.id, purpose: 'calendar_sharing' } })).status, 201);

  const feed = await call('POST', '/me/calendar-feeds', { token: parent.token, body: { athlete_id: kid.id } });
  assert.equal(feed.status, 201, JSON.stringify(feed.body));
  const imp = await call('POST', '/me/calendar-imports', { token: parent.token, body: { athlete_id: kid.id, url: 'https://cal.example.org/k.ics' } });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  const ext = async () => (await call('GET', `/me/sport-schedule?kinds=external&to=${at(6, 0).slice(0, 10)}`, { token: kid.token })).body.items.length;
  assert.equal(await ext(), 1);
  assert.equal((await call('GET', `/calendar/feed/${feed.body.token}.ics`)).status, 200);
  assert.equal((await call('GET', `/me/calendar-sync?athlete_id=${kid.id}`, { token: parent.token })).body.feeds.length, 1);
  assert.equal((await call('GET', `/me/calendar-sync?athlete_id=${kid.id}`, { token: stranger.token })).status, 404);

  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='calendar_sharing'", [kid.id]);
  assert.equal((await call('GET', `/calendar/feed/${feed.body.token}.ics`)).status, 404, 'the same link stops the moment consent is withdrawn');
  assert.equal(await ext(), 0, 'imported busy time hidden at once');
  assert.equal((await call('POST', `/me/calendar-imports/${imp.body.id}/sync`, { token: parent.token })).status, 409);
  assert.equal((await call('POST', `/me/calendar-feeds/${feed.body.id}/revoke`, { token: parent.token })).status, 200, 'a guardian can still turn it off');
  ics.setIcsFetcher();
});

test('every calendar capability is on REST, OpenAPI and MCP', async () => {
  const { capabilities } = await import('../src/registry.js');
  const names = ['get_calendar_sync', 'save_calendar_preferences', 'create_calendar_feed', 'update_calendar_feed', 'revoke_calendar_feed', 'preview_calendar_feed', 'add_calendar_import', 'sync_calendar_import', 'remove_calendar_import', 'get_schedule_conflicts', 'update_athlete_block'];
  for (const nm of names) assert.ok(capabilities.some((c) => c.name === nm), nm);
  const spec = (await call('GET', '/openapi.json')).body;
  assert.ok(spec.paths['/me/calendar-feeds'] && spec.paths['/me/schedule-conflicts'] && spec.paths['/me/blocks/{id}']);
});
