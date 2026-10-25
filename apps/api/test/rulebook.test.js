import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { BOOKS, paramsOf, cardsFor, bookFor } = await import('../src/rulebook/catalog.js');
const { cleanValues, applyToRuleset, rulesLines, resolveBook } = await import('../src/rulebook/apply.js');
const { builtinRuleset } = await import('../src/scoring/rulesets.js');
const { renderRulebook } = await import('../src/documents/render.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `rb_${n}_${roles[0]}`, display_name: `Rb ${n}`, email: `rb${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const FIRST_RELEASE = ['football', 'cricket', 'athletics', 'table-tennis', 'hockey', 'chess', 'ice-hockey', 'baseball', 'american-football', 'rugby', 'pickleball', 'futsal', 'racquetball', 'squash', 'boxing', 'judo', 'weightlifting', 'karate', 'badminton'];

test('every first-release sport has a rulebook of readable cards and an official source', async () => {
  const sports = (await pool.query('SELECT slug FROM sports')).rows.map((r) => r.slug);
  for (const slug of FIRST_RELEASE) {
    assert.ok(sports.includes(slug), `${slug} is in the sport catalogue`);
    const book = BOOKS[slug];
    assert.ok(book, `${slug} has a rulebook`);
    assert.match(book.official_url, /^https:\/\//);
    assert.ok(book.body && book.cards.length >= 5, `${slug} has at least five cards`);
    for (const f of book.formats ?? ['']) {
      const cards = cardsFor(book, f);
      assert.ok(cards.length >= 3, `${slug} ${f} shows cards`);
      for (const c of cards) assert.ok(c.title && c.body.length > 30, `${slug}/${c.title} has real text`);
    }
    const keys = paramsOf(book).map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, `${slug} setting keys are unique`);
    for (const p of paramsOf(book)) {
      assert.ok(p.label, `${slug}.${p.key} has a label`);
      if (p.type === 'int') assert.ok(p.std >= p.min && p.std <= p.max, `${slug}.${p.key} standard is inside its range`);
      if (p.type === 'choice') assert.ok(p.options.includes(p.std), `${slug}.${p.key} standard is one of the options`);
    }
  }
  assert.equal(bookFor('rugby-sevens').format, 'Sevens');
});

test('cleanValues keeps only real settings that differ from the standard and refuses the rest', () => {
  assert.deepEqual(cleanValues('football', '', { half: 40, subs: 5 }), { ok: true, values: { half: 40 } });
  assert.equal(cleanValues('football', '', { half: 99 }).ok, false);
  assert.equal(cleanValues('football', '', { nonsense: 1 }).ok, false);
  assert.equal(cleanValues('football', '', { tie: 'Coin toss' }).ok, false);
  assert.equal(cleanValues('badminton', '', { bestof: 4 }).ok, false, 'best-of must be odd');
  assert.equal(cleanValues('cricket', 'T20', { ov_odi: 40 }).ok, false, 'an ODI setting is not a T20 setting');
  assert.deepEqual(cleanValues('cricket', 'T20', { ov_t20: 10 }), { ok: true, values: { ov_t20: 10 } });
  assert.equal(cleanValues('curling', '', {}).ok, false, 'no rulebook for this sport');
});

test('local values that change scoring reach the ruleset; the rest only show on the sheet', () => {
  const bad = applyToRuleset('badminton', builtinRuleset({ slug: 'badminton', scoring: 'sets' }), { points: 15, bestof: 1 });
  assert.equal(bad.sets.points_to_win, 15); assert.equal(bad.sets.best_of, 1);
  const tt = applyToRuleset('table-tennis', builtinRuleset({ slug: 'table-tennis', scoring: 'sets' }), { bestof: 7 });
  assert.equal(tt.sets.best_of, 7);
  const rb = applyToRuleset('racquetball', builtinRuleset({ slug: 'racquetball', scoring: 'sets' }), { tiebreak: 9 });
  assert.equal(rb.sets.deciding_points, 9);
  const hockey = applyToRuleset('hockey', builtinRuleset({ slug: 'hockey', scoring: 'goals' }), { quarters: 2 });
  assert.deepEqual(hockey.periods, { count: 2, label: 'Half' });
  const fb = builtinRuleset({ slug: 'football', scoring: 'goals' });
  assert.equal(applyToRuleset('football', fb, { half: 40 }), fb, 'half length is shown, not scored');
  assert.deepEqual(rulesLines('football', '', { half: 40 }), ['Law 7: Length of each half 40 min (standard 45 min)'].map((l) => l.replace('Law 7: ', 'Duration of the match: ')));
  assert.equal(resolveBook('football', '', { half: 40 }).changes.length, 1);
});

test('rulebook API: anyone can read; local rules are versioned, scoped and immutable', async () => {
  const me = await signup(), other = await signup();
  const list = await api('GET', '/rulebook', { token: me.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((b) => b.slug).sort(), [...FIRST_RELEASE].sort());
  assert.equal((await api('GET', '/rulebook')).status, 401);

  const std = await api('GET', '/rulebook/football', { token: me.token });
  assert.equal(std.status, 200);
  assert.equal(std.body.cards.length, 17);
  assert.equal(std.body.changes.length, 0);

  const made = await api('POST', '/local-rules', { token: me.token, body: { sport: 'football', name: 'Under-12 league', settings: { half: 25, subs: 5, ht: 10 }, note: 'Junior rules' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.current_version, 1);
  assert.deepEqual(made.body.current.settings, { half: 25, ht: 10 }, 'only changes from the standard are kept');

  const again = await api('POST', '/local-rules', { token: me.token, body: { set_id: made.body.id, settings: { half: 25, ht: 10 } } });
  assert.equal(again.body.current_version, 1, 'the same values do not make a new version');
  const v2 = await api('POST', '/local-rules', { token: me.token, body: { set_id: made.body.id, settings: { half: 30 } } });
  assert.equal(v2.body.current_version, 2);
  assert.equal(v2.body.versions.length, 2);
  await assert.rejects(pool.query("UPDATE local_rule_versions SET settings='{}' WHERE set_id=$1", [made.body.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM local_rule_versions WHERE set_id=$1', [made.body.id]), /immutable/);

  const view = await api('GET', `/rulebook/football?local_id=${made.body.id}`, { token: me.token });
  assert.equal(view.body.changes.length, 1);
  assert.equal(view.body.changes[0].value, 30);
  assert.equal(view.body.local.version, 2);
  const lawSeven = view.body.cards.find((c) => c.key === 'duration_of_the_match');
  assert.equal(lawSeven.params.find((p) => p.key === 'half').changed, true);

  assert.equal((await api('GET', `/local-rules/${made.body.id}`, { token: other.token })).status, 404, 'a private set is not visible to others');
  assert.equal((await api('POST', '/local-rules', { token: other.token, body: { set_id: made.body.id, settings: { half: 20 } } })).status, 404);
  assert.equal((await api('POST', '/local-rules', { token: me.token, body: { sport: 'football', name: 'Bad', settings: { half: 500 } } })).status, 400);
  assert.equal((await api('POST', '/local-rules', { token: me.token, body: { sport: 'football', name: 'Wrong key', settings: { ov_t20: 12 } } })).status, 400);
  assert.equal((await api('POST', '/local-rules', { token: me.token, body: { sport: 'curling', name: 'None', settings: {} } })).status, 400);

  const mine = await api('GET', '/local-rules?sport=football', { token: me.token });
  assert.equal(mine.body.length, 1);
  assert.equal((await api('GET', '/local-rules?sport=football', { token: other.token })).body.length, 0);
  assert.equal((await api('POST', `/local-rules/${made.body.id}/retire`, { token: me.token })).body.status, 'retired');
  assert.equal((await api('POST', '/local-rules', { token: me.token, body: { set_id: made.body.id, settings: { half: 20 } } })).status, 409);
});

test('scopes: an organisation needs an owner/admin/coach, an event its organiser, a team its captain/coach/manager', async () => {
  const owner = await signup(['organizer']), member = await signup(['athlete']), outsider = await signup(['athlete']), coach = await signup(['coach']);
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: `Rulebook Club ${n}`, kind: 'club' } })).body;
  assert.ok(org.id, JSON.stringify(org));
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,'finance','active'),($1,$3,'coach','active') ON CONFLICT DO NOTHING", [org.id, member.id, coach.id]);
  const orgRules = await api('POST', '/local-rules', { token: coach.token, body: { sport: 'futsal', name: 'Club futsal', scope: 'organisation', organisation_id: org.id, settings: { half: 15 } } });
  assert.equal(orgRules.status, 201, JSON.stringify(orgRules.body));
  assert.equal((await api('POST', '/local-rules', { token: member.token, body: { sport: 'futsal', name: 'Nope', scope: 'organisation', organisation_id: org.id, settings: { half: 10 } } })).status, 403, 'a plain member cannot publish club rules');
  assert.equal((await api('POST', '/local-rules', { token: outsider.token, body: { sport: 'futsal', name: 'Nope', scope: 'organisation', organisation_id: org.id, settings: { half: 10 } } })).status, 403);
  assert.equal((await api('GET', `/local-rules/${orgRules.body.id}`, { token: member.token })).status, 200, 'members can read the club rules');
  assert.equal((await api('GET', `/local-rules/${orgRules.body.id}`, { token: outsider.token })).status, 404);

  const { rows: [sport] } = await pool.query("SELECT id FROM sports WHERE slug='badminton'");
  const ev = (await pool.query("INSERT INTO events(name, sport_id, organizer_id, status) VALUES ('Rules Open', $1, $2, 'open') RETURNING id", [sport.id, owner.id])).rows[0];
  const evRules = await api('POST', '/local-rules', { token: owner.token, body: { sport: 'badminton', name: 'Rules Open rules', scope: 'event', event_id: ev.id, settings: { points: 15 } } });
  assert.equal(evRules.status, 201, JSON.stringify(evRules.body));
  assert.equal((await api('POST', '/local-rules', { token: outsider.token, body: { sport: 'badminton', name: 'xx', scope: 'event', event_id: ev.id, settings: { points: 11 } } })).status, 403);
  assert.equal((await api('POST', '/local-rules', { token: owner.token, body: { sport: 'football', name: 'xx', scope: 'event', event_id: ev.id, settings: { half: 30 } } })).status, 400, 'event is for another sport');
  assert.equal((await api('GET', `/local-rules/${evRules.body.id}`, { token: outsider.token })).status, 200, 'a public event\'s rules are readable');
  assert.equal((await api('GET', `/local-rules?sport=badminton&event_id=${ev.id}`, { token: outsider.token })).body.length, 1);
});

test('the rulebook prints as a PDF for every sport, with local changes marked', async () => {
  const me = await signup();
  for (const slug of FIRST_RELEASE) {
    const r = await api('GET', `/rulebook/${slug}/pdf`, { token: me.token });
    assert.equal(r.status, 200, slug);
    assert.equal(r.body.subarray(0, 4).toString(), '%PDF');
  }
  const made = await api('POST', '/local-rules', { token: me.token, body: { sport: 'cricket', format: 'T20', name: 'Club T20', settings: { ov_t20: 15, bq_t20: 3 } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const view = await api('GET', `/rulebook/cricket?format=T20&local_id=${made.body.id}`, { token: me.token });
  assert.equal(view.body.changes.length, 2);
  assert.ok(view.body.cards.every((c) => c.params.every((p) => !p.formats || p.formats.includes('T20'))), 'only T20 settings are shown for T20');
  const pdf = await api('GET', `/rulebook/cricket/pdf?format=T20&local_id=${made.body.id}`, { token: me.token });
  assert.equal(pdf.status, 200);
  assert.equal((await api('GET', '/rulebook/football/pdf')).status, 401);
  assert.equal((await api('GET', '/rulebook/curling/pdf', { token: me.token })).status, 404);
  const odi = await api('GET', `/rulebook/cricket?format=ODI`, { token: me.token });
  assert.ok(odi.body.cards.some((c) => c.params.some((p) => p.key === 'ov_odi')));
  assert.ok(!odi.body.cards.some((c) => c.params.some((p) => p.key === 'ov_t20')));
  const { buffer } = await renderRulebook({ book: resolveBook('football', '', { half: 40 }), local: { name: 'Juniors', scope: 'personal', version: 1 } });
  assert.ok(buffer.length > 2000);
});
