import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// t('key', { name }) must pass exactly the {placeholders} the English text has, or the person sees a literal "{name}".
test("every t('key', {…}) call passes the same parameters as the English text's {placeholders}", () => {
  let out = '';
  try { out = execFileSync('node', [new URL('../../../scripts/i18n-params-check.mjs', import.meta.url).pathname], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout?.toString() ?? String(e); }
  assert.match(out, /0 problems/, out);
});
