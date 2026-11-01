import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { walk } from '../../../scripts/i18n-extract.mjs';
import en from '../../app/src/i18n/en.js';

// A typo in t('some.key') silently shows the raw key to the person; this makes it a failing test instead.
test("every literal t('key') in the app is defined in the English pack", () => {
  const missing = [];
  for (const file of walk()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?<![\w.$])t\(\s*'([a-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g)) {
      if (!(m[1] in en)) missing.push(`${file.split('/apps/app/src/')[1]}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('every navigation title route has a translated title key', () => {
  const app = fs.readFileSync(new URL('../../app/src/App.js', import.meta.url), 'utf8');
  const routes = /const TITLE_ROUTES = \[([^\]]+)\]/.exec(app)?.[1].match(/'([A-Za-z0-9]+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  assert.ok(routes.length > 150, 'TITLE_ROUTES not found');
  assert.deepEqual(routes.filter((r) => !(`nav.title.${r}` in en)), []);
});
