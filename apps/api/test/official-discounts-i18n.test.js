/**
 * i18n coverage test for official-discounts (R36 / #1017).
 * Verifies that all odisc.* keys defined in en.js are present in every
 * language pack. The main i18n-catalogues.test.js checks full catalogue
 * parity; this file is a focused smoke test for the new feature keys.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUES } from '../../app/src/i18n/catalogue.js';

const REQUIRED_LANGS = ['hi', 'ta', 'te', 'ml', 'mr', 'kn', 'bn', 'or', 'si', 'ur', 'id'];

describe('official-discounts i18n', () => {
  it('en.js contains all required odisc.* keys', () => {
    const en = CATALOGUES.en;
    const odiscKeys = Object.keys(en).filter((k) => k.startsWith('odisc.'));
    assert.ok(odiscKeys.length >= 40, `Expected at least 40 odisc.* keys in en.js, found ${odiscKeys.length}`);

    // Spot-check critical keys
    const required = [
      'odisc.title',
      'odisc.create',
      'odisc.kind.percent',
      'odisc.kind.fixed',
      'odisc.funded_referee',
      'odisc.funded_platform',
      'odisc.type.bulk_games',
      'odisc.type.early_commitment',
      'odisc.type.loyalty',
      'odisc.type.coupon',
      'odisc.floor_minor',
      'odisc.floor_minor_hint',
      'odisc.stackable',
      'odisc.preview',
      'odisc.apply_code',
      'odisc.admin.pending_approvals',
    ];
    for (const key of required) {
      assert.ok(key in en, `Missing required key: ${key}`);
      assert.ok(typeof en[key] === 'string' && en[key].trim().length > 0, `Key ${key} is empty`);
    }
  });

  for (const lang of REQUIRED_LANGS) {
    it(`${lang}.js contains all odisc.* keys from en.js`, () => {
      const en = CATALOGUES.en;
      const pack = CATALOGUES[lang];
      assert.ok(pack, `Language pack ${lang} is not loaded`);
      const odiscKeys = Object.keys(en).filter((k) => k.startsWith('odisc.'));
      const missing = odiscKeys.filter((k) => !(k in pack));
      assert.deepEqual(missing, [], `${lang}.js is missing keys: ${missing.join(', ')}`);
    });
  }
});
