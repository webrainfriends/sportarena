import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// The app is a hand-rolled stack navigator: push('Name') looks Name up in PAGES. A name that is missing renders `undefined`
// and white-screens the app (a merge has dropped such a line more than once), so check the wiring statically.
const src = new URL('../../app/src/', import.meta.url);
const read = (f) => readFileSync(new URL(f, src), 'utf8');

test('every screen the app navigates to is registered in PAGES and has a title', () => {
  const app = read('App.js');
  const keys = (name) => {
    const body = app.match(new RegExp(`const ${name} = \\{([^\\n]*)\\}`))?.[1] ?? '';
    return [...body.matchAll(/(?:^|,)\s*([A-Za-z]+)\s*(?::|(?=,|$))/g)].map((m) => m[1]);
  };
  const pages = new Set(keys('PAGES')), titles = new Set(keys('TITLES'));
  assert.ok(pages.size > 20, 'could not read PAGES from App.js');
  const files = ['App.js', ...readdirSync(new URL('screens/', src)).filter((f) => f.endsWith('.js')).map((f) => `screens/${f}`), ...readdirSync(src).filter((f) => f.endsWith('.js'))];
  const targets = new Set();
  for (const f of new Set(files)) for (const m of read(f).matchAll(/\b(?:push|replace)\(\s*'([A-Z][A-Za-z]+)'/g)) targets.add(m[1]);
  const tabs = new Set([...app.matchAll(/\['([A-Z][A-Za-z]+)',\s*[A-Z][A-Za-z]+\]/g)].map((m) => m[1]));
  const missing = [...targets].filter((t) => !pages.has(t) && !tabs.has(t));
  assert.deepEqual(missing, [], `navigated to but not in PAGES: ${missing.join(', ')}`);
  const untitled = [...pages].filter((p) => !titles.has(p));
  assert.deepEqual(untitled, [], `in PAGES but no TITLES entry: ${untitled.join(', ')}`);
});

// A screen that App.js imports must really be exported by its file: a missing export is `undefined` at runtime and white-screens the app
// the moment someone opens it (a bad edit once deleted several coaching screens and nothing else noticed).
test('every screen App.js imports is exported by the screen file', () => {
  const app = read('App.js');
  const missing = [];
  for (const m of app.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/(screens\/[\w-]+)'/g)) {
    const file = read(`${m[2]}.js`);
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (!name) continue;
      const declared = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class|let)\\s+${name}\\b`).test(file) || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(file);
      if (!declared) missing.push(`${m[2]}: ${name}`);
    }
  }
  assert.deepEqual(missing, [], `imported but not exported: ${missing.join(', ')}`);
});
