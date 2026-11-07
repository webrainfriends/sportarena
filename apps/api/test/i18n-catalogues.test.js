import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOGUES, LANGUAGES, LANGUAGE_CODES, languageOf, translate } from '../../app/src/i18n/catalogue.js';
import { LANGUAGE_CODES as API_LANGUAGES, LOCALE_CODES } from '../src/comms-catalogue.js';

const REQUIRED = ['ta', 'te', 'ml', 'mr', 'kn', 'bn', 'or', 'hi', 'si', 'ur', 'id'];
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const I18N_DIR = resolve(import.meta.dirname, '../../app/src/i18n');

test('every required language pack exists, and the API accepts exactly the same codes', () => {
  for (const code of ['en', ...REQUIRED]) assert.ok(CATALOGUES[code], `missing pack ${code}`);
  assert.deepEqual([...API_LANGUAGES].sort(), [...LANGUAGE_CODES].sort());
  for (const code of REQUIRED) assert.ok(LOCALE_CODES.some((l) => l.startsWith(`${code}-`)), `comms locale missing for ${code}`);
});

test('every language has every key, no blanks, and the same {placeholders} as English', () => {
  const keys = Object.keys(CATALOGUES.en);
  for (const { code } of LANGUAGES) {
    assert.deepEqual(Object.keys(CATALOGUES[code]).sort(), [...keys].sort(), `${code} keys differ from English`);
    for (const k of keys) {
      const v = CATALOGUES[code][k];
      assert.ok(typeof v === 'string' && v.trim(), `${code}.${k} is empty`);
      assert.equal(placeholders(v), placeholders(CATALOGUES.en[k]), `${code}.${k} placeholders differ`);
    }
  }
});

test('non-English packs are really translated (not copies of English) and use their own script', () => {
  for (const code of REQUIRED.filter((c) => c !== 'id')) {
    assert.notEqual(CATALOGUES[code]['account.logout'], CATALOGUES.en['account.logout'], code);
    assert.ok(!/^[\x00-\x7f]+$/.test(CATALOGUES[code]['account.title']), `${code} should not be Latin script`);
  }
});

test('Urdu is RTL; reviewed packs have named reviewers; unreviewed packs are flagged', () => {
  assert.equal(LANGUAGES.find((l) => l.code === 'ur').rtl, true);
  assert.deepEqual(LANGUAGES.filter((l) => l.rtl).map((l) => l.code), ['ur']);
  for (const l of LANGUAGES) {
    if (l.reviewed) {
      assert.ok(l.reviewMeta?.reviewer, `${l.code}: reviewed=true requires reviewMeta.reviewer`);
      assert.ok(l.reviewMeta?.reviewedAt, `${l.code}: reviewed=true requires reviewMeta.reviewedAt`);
    } else {
      assert.ok(!l.reviewMeta?.reviewer || l.code === 'en', `${l.code}: unreviewed must have reviewer: null`);
    }
  }
});

test('no language file has a duplicate key (guards against English-block overwrite regression)', () => {
  const KEY_RE = /^\s*'([\w.]+)'\s*:/;
  const errors = [];
  for (const { code } of LANGUAGES) {
    const src = readFileSync(resolve(I18N_DIR, `${code}.js`), 'utf8');
    const seen = new Map();
    src.split('\n').forEach((line, i) => {
      const m = KEY_RE.exec(line);
      if (!m) return;
      const key = m[1];
      if (seen.has(key)) errors.push(`${code}.js: duplicate key '${key}' at line ${i + 1} (first at ${seen.get(key)})`);
      else seen.set(key, i + 1);
    });
  }
  assert.deepEqual(errors, [], `Duplicate keys found:\n${errors.join('\n')}`);
});

test('translate fills params, falls back to English and to the key', () => {
  assert.equal(translate('ta', 'welcome.hello', { name: 'Ravi' }), 'வணக்கம், Ravi');
  assert.equal(translate('xx', 'common.save'), 'Save');
  assert.equal(translate('ta', 'no.such.key'), 'no.such.key');
  assert.equal(languageOf('or-IN'), 'or');
  assert.equal(languageOf('fr-FR'), 'en');
});
