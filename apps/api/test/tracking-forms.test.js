import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { buildLayout, variantsFor } = await import('../src/tracking/logic.js');
const { builtinRuleset } = await import('../src/scoring/rulesets.js');
const { formFor } = await import('../src/tracking/forms.js');
const { renderTrackingSheet } = await import('../src/documents/render.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const sheetFor = (sport, ruleset, variant = '', custom = {}) => {
  const layout = buildLayout(sport, ruleset, variant, custom);
  return { layout, sheet: { ref: 'TS-TESTTEST', mode: 'standalone', labels: { home: 'Home', away: 'Away' }, occurred_at: null, created_at: new Date().toISOString(), title: null } };
};
const pdfOf = (sport, variant, custom) => {
  const rs = builtinRuleset(sport), { layout, sheet } = sheetFor(sport, rs, variant, custom);
  return renderTrackingSheet({ sheet, layout, kit: null, logo: null, code: 'TS-TESTTEST-0000000000', qr: null, context: {} });
};

test('every sport in the catalogue gets a real in-match scoresheet, not the bare manual page', async () => {
  const sports = (await pool.query('SELECT * FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 150, 'the catalogue is migrated');
  const dir = process.env.SHEET_DUMP_DIR; if (dir) mkdirSync(dir, { recursive: true });
  const seen = new Map();
  for (const sport of sports) {
    const rs = builtinRuleset(sport), form = formFor(sport, rs, variantsFor(sport, rs)[0]);
    assert.ok(form.title && form.sections.length >= 3, `${sport.slug} has a form with sections`);
    assert.ok(form.sections.some((s) => ['running', 'cricket', 'table', 'pair'].includes(s.t)), `${sport.slug} has something to write on while playing`);
    const { buffer, pages } = await pdfOf(sport, variantsFor(sport, rs)[0]);
    assert.equal(buffer.subarray(0, 4).toString(), '%PDF', sport.slug);
    assert.ok(pages >= 1 && pages <= 8, `${sport.slug} prints on ${pages} pages`);
    if (dir && (process.env.SHEET_DUMP_ALL || !seen.has(form.title))) writeFileSync(`${dir}/${sport.slug}.pdf`, buffer);
    seen.set(form.title, (seen.get(form.title) ?? 0) + 1);
  }
  assert.ok(seen.size >= 15, `distinct sheet designs: ${[...seen.keys()].join(', ')}`);
});

test('cricket formats set the overs; custom options and old layouts keep working', async () => {
  const { rows: [cricket] } = await pool.query("SELECT * FROM sports WHERE slug='cricket'");
  assert.deepEqual(variantsFor(cricket, builtinRuleset(cricket)), ['T10', 'T20', 'ODI']);
  const t20 = buildLayout(cricket, builtinRuleset(cricket), 'T20'), odi = buildLayout(cricket, builtinRuleset(cricket), 'ODI');
  assert.equal(t20.form.sections.find((s) => s.t === 'cricket').overs, 20);
  assert.equal(odi.form.sections.find((s) => s.t === 'cricket').overs, 50);
  assert.equal(t20.orientation, 'landscape');
  assert.equal(buildLayout(cricket, builtinRuleset(cricket), 'T20', { orientation: 'portrait' }).orientation, 'portrait');
  const { rows: [football] } = await pool.query("SELECT * FROM sports WHERE slug='football'");
  const plain = await pdfOf(football, 'Standard', { signatures: false, notes_fields: ['Weather'], hidden_stats: ['corner'] });
  assert.equal(plain.buffer.subarray(0, 4).toString(), '%PDF');
  // a sheet pinned before forms existed (layout v1, no form) still renders through the original code path
  const old = buildLayout(football, builtinRuleset(football), 'Standard'); delete old.form; old.v = 1;
  const legacy = await renderTrackingSheet({ sheet: sheetFor(football, builtinRuleset(football)).sheet, layout: old, kit: null, logo: null, code: 'TS-TESTTEST-0000000000', qr: null, context: {} });
  assert.equal(legacy.buffer.subarray(0, 4).toString(), '%PDF');
});

test('creating a sheet for a non-ruleset sport pins a form and serves the PDF; the live tracker mode is unchanged', async () => {
  const r = await api('POST', '/auth/register', { body: { handle: 'forms_1', display_name: 'Forms', email: 'forms1@example.com', password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201);
  const token = r.body.token;
  for (const [sport, variant, mode] of [['cricket', 'T20', 'manual'], ['boxing', undefined, 'manual'], ['weightlifting', undefined, 'manual'], ['high-jump', undefined, 'results'], ['football', undefined, 'points_events'], ['badminton', 'Doubles', 'sets']]) {
    const s = await api('POST', '/tracking/sheets', { token, body: { sport, variant } });
    assert.equal(s.status, 201, `${sport}: ${JSON.stringify(s.body)}`);
    assert.equal(s.body.template.layout.mode, mode, sport);
    assert.ok(s.body.template.layout.form.sections.length >= 3, sport);
    const pdf = await api('GET', `/tracking/sheets/${s.body.id}/pdf`, { token });
    assert.equal(pdf.status, 200, sport);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  }
});
