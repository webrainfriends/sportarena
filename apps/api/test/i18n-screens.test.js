import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

// Guard for "every screen is translated": counts hard-coded English in each screen (title/placeholder/label/accessibilityLabel/hint
// attributes and JSX text) and compares with i18n-baseline.json. A screen may never get MORE literals than its baseline, a screen that
// is not in the baseline must have none, and when you translate a screen the baseline must be lowered (run with I18N_WRITE_BASELINE=1).
// "All screens covered" means this baseline is empty.
const SCREENS = new URL('../../app/src/screens/', import.meta.url);
const BASELINE = new URL('./i18n-baseline.json', import.meta.url);
const ATTR = /\b(title|placeholder|label|accessibilityLabel|hint|subtitle|empty)=(?:"([^"{}]*[A-Za-z]{3}[^"{}]*)"|\{'([^'{}]*[A-Za-z]{3}[^'{}]*)'\}|\{`([^`]*[A-Za-z]{3}[^`]*)`\})/g;
const TEXT = />\s*([A-Za-z][^<>{}\n]*[A-Za-z.!?:])\s*</g;

const literals = (src) => [...src.matchAll(ATTR)].length + [...src.matchAll(TEXT)].filter((m) => /\s|^[A-Z]/.test(m[1]) && !/^[a-z]+$/.test(m[1])).length;
const counts = () => Object.fromEntries(readdirSync(SCREENS).filter((f) => f.endsWith('.js')).sort()
  .map((f) => [f, literals(readFileSync(new URL(f, SCREENS), 'utf8'))]).filter(([, n]) => n > 0));

test('no screen gains hard-coded English, new screens start translated, and the baseline only shrinks', () => {
  const now = counts();
  if (process.env.I18N_WRITE_BASELINE) { writeFileSync(BASELINE, `${JSON.stringify(now, null, 1)}\n`); return; }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const worse = Object.entries(now).filter(([f, n]) => n > (base[f] ?? 0)).map(([f, n]) => `${f}: ${n} hard-coded strings (allowed ${base[f] ?? 0}) — use t() and add the keys to all 12 language files`);
  assert.deepEqual(worse, [], worse.join('\n'));
  const stale = Object.entries(base).filter(([f, n]) => (now[f] ?? 0) < n).map(([f]) => f);
  assert.deepEqual(stale, [], `translated more of: ${stale.join(', ')} — lower test/i18n-baseline.json (I18N_WRITE_BASELINE=1 node --test test/i18n-screens.test.js)`);
});
