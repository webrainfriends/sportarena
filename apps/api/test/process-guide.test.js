import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The academy process guide (Process card + PDF) must stay true to the product. These checks fail when an organisation / academy / venue /
// coach / tax module is added or a screen the guide shows changes without the guide being updated. See docs/academy-process-guide.md.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { ACADEMY_STEPS, NOT_IN_GUIDE, WATCHED_MODULES, SHOT_SIZES, REPO_ROOT, MANIFEST_FILE, sourcesHash, shotFile } = await import('../src/guides/academy-process.js');
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { CATALOGUES, LANGUAGE_CODES } = await import('../../app/src/i18n/catalogue.js');

const read = (f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');

test('every organisation / academy API module is covered by a guide step (or explicitly excluded)', () => {
  const dir = path.join(REPO_ROOT, 'apps/api/src/capabilities');
  const watched = fs.readdirSync(dir).filter((f) => WATCHED_MODULES.test(f));
  const covered = new Set([...ACADEMY_STEPS.flatMap((s) => s.modules), ...Object.keys(NOT_IN_GUIDE)]);
  const missing = watched.filter((f) => !covered.has(f));
  assert.deepEqual(missing, [], `add these modules to a step in src/guides/academy-process.js (or NOT_IN_GUIDE with a reason): ${missing.join(', ')}`);
  for (const s of ACADEMY_STEPS) for (const m of s.modules) assert.ok(fs.existsSync(path.join(dir, m)), `${s.id}: module ${m} no longer exists - update the guide`);
});

test('steps are well formed and open screens that exist', () => {
  const app = read('apps/app/src/App.js'), org = read('apps/app/src/screens/org.js'), academy = read('apps/app/src/screens/academy.js');
  assert.equal(new Set(ACADEMY_STEPS.map((s) => s.id)).size, ACADEMY_STEPS.length, 'unique ids');
  for (const s of ACADEMY_STEPS) {
    assert.ok(s.title && s.why && s.steps.length >= 2, `${s.id} has text`);
    for (const f of s.sources) assert.ok(fs.existsSync(path.join(REPO_ROOT, f)), `${s.id}: source ${f} exists`);
    const t = s.target;
    if (t.screen) assert.match(app.split('const PAGES')[1] ?? '', new RegExp(`[ ,{]${t.screen}[,: ]`), `${s.id}: route ${t.screen} is registered`);
    if (t.academy) assert.match(academy, new RegExp(`key: '${t.academy}'`), `${s.id}: academy section ${t.academy}`);
    if (t.org) assert.match(org, new RegExp(`\\['${t.org}'`), `${s.id}: organisation tab ${t.org}`);
  }
});

test('the guide text is translated: English matches this file and every language has every key', () => {
  const en = CATALOGUES.en;
  for (const s of ACADEMY_STEPS) {
    assert.equal(en[`guide.${s.id}.title`], s.title, `${s.id} title in en.js matches the API`);
    assert.equal(en[`guide.${s.id}.why`], s.why, `${s.id} why in en.js matches the API`);
  }
  for (const code of LANGUAGE_CODES) for (const s of ACADEMY_STEPS) for (const k of ['title', 'why']) assert.ok(CATALOGUES[code][`guide.${s.id}.${k}`], `${code} guide.${s.id}.${k}`);
});

test('every step has fresh screenshots (retake with `npm run guide:shots` after changing a screen)', () => {
  assert.ok(fs.existsSync(MANIFEST_FILE), 'manifest.json exists - run npm run guide:shots');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const stale = [];
  for (const s of ACADEMY_STEPS) {
    for (const size of Object.keys(SHOT_SIZES)) assert.ok(fs.existsSync(path.join(path.dirname(MANIFEST_FILE), shotFile(s.id, size))), `${s.id} ${size} screenshot exists`);
    if (manifest.steps?.[s.id] !== sourcesHash(s)) stale.push(s.id);
  }
  assert.deepEqual(stale, [], `screens changed since these screenshots were taken: ${stale.join(', ')}. Update the step text if needed, then run npm run guide:shots`);
});

let server, base, token;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const r = await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'pg_user', display_name: 'Guide Reader', email: 'pg@example.com', password: 'correct-horse-battery', roles: ['organizer'] }) });
  token = (await r.json()).token;
});
after(async () => { server.close(); await pool.end(); });
const get = (p, auth = true) => fetch(`${base}/api/v1${p}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} });

test('the guide, its screenshots and its PDF are served to signed-in users only', async () => {
  assert.equal((await get('/process-guides/academy', false)).status, 401);
  const g = await (await get('/process-guides/academy')).json();
  assert.equal(g.steps.length, ACADEMY_STEPS.length);
  assert.ok(g.steps.every((s) => s.screenshots.phone && s.screenshots.desktop), 'every step reports its screenshots');
  assert.equal((await get('/process-guides/club')).status, 400);
  assert.equal((await get('/process-guides/academy/steps/nope/screenshot/phone')).status, 404);
  const shot = await (await get(`/process-guides/academy/steps/${ACADEMY_STEPS[0].id}/screenshot/phone`)).json();
  assert.equal(shot.content_type, 'image/png');
  assert.equal(Buffer.from(shot.content, 'base64').subarray(1, 4).toString(), 'PNG');
  const pdf = await (await get('/process-guides/academy/pdf')).json();
  const buf = Buffer.from(pdf.content, 'base64');
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');
  const tmp = path.join(process.env.TMPDIR ?? '/tmp', `guide-${process.pid}.pdf`);
  fs.writeFileSync(tmp, buf);
  const text = execFileSync('pdftotext', [tmp, '-'], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  for (const s of ACADEMY_STEPS) assert.ok(text.includes(s.title), `PDF contains "${s.title}"`);
});
