import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoneyIn, minorDigits, parseAmount, toMajorText } from '../../app/src/money-core.js';

const f = (loc, minor, cur, o) => formatMoneyIn(loc, minor, cur, o).replace(/ /g, ' ');

test('precision comes from the currency: zero, two and three decimals', () => {
  assert.deepEqual(['JPY', 'VND', 'SGD', 'INR', 'USD', 'KWD', 'BHD', 'OMR'].map(minorDigits), [0, 0, 2, 2, 2, 3, 3, 3]);
  assert.equal(f('en-SG', 2550, 'SGD'), '$25.50', 'in Singapore the local symbol for SGD is $');
  assert.equal(f('en-IN', 2550, 'SGD'), 'SGD 25.50', 'elsewhere the code is spelled out so it cannot be mistaken for another dollar');
  assert.equal(f('en-IN', 120000, 'INR'), '₹1,200');
  assert.equal(f('en-IN', 120050, 'INR'), '₹1,200.50');
  assert.match(f('ja-JP', 5000, 'JPY'), /5,000$/, 'JPY has no minor unit: 5000 is five thousand yen, not fifty');
  assert.match(f('en', 12345, 'KWD'), /12\.345/);
  assert.match(f('en', 5, 'KWD'), /0\.005/);
  assert.equal(f('en', 1250, 'SGD', { compact: false }), 'SGD 12.50'.replace('SGD ', 'SGD ').replace(' ', ' '));
});

test('the currency is the record\'s, never the viewer\'s locale: the same invoice reads the same in any region', () => {
  for (const loc of ['en-IN', 'en-SG', 'ta-IN', 'ur-PK', 'id-ID', 'de-DE']) {
    const s = f(loc, 123456, 'SGD');
    assert.ok(/\$|SGD|S\$/.test(s), `${loc}: ${s}`);
    assert.ok(!s.includes('₹'), `${loc}: ${s}`);
  }
  assert.ok(!f('en-IN', 123456, 'USD').includes('₹'));
});

test('a missing currency is a bare number, a missing amount a dash; nothing is guessed', () => {
  assert.equal(f('en-IN', 120000, undefined), '1,200');
  assert.equal(f('en-IN', 120000, null), '1,200');
  assert.equal(f('en', null, 'SGD'), '—');
  assert.equal(f('en', undefined, 'SGD'), '—');
  assert.equal(f('en', 'abc', 'SGD'), '—');
  assert.equal(f('en', '250000', 'INR'), '₹2,500', 'amounts the API sends as strings');
  assert.equal(f('en', 10n ** 12n, 'SGD'), f('en', 10 ** 12, 'SGD'));
  assert.equal(f('en', 0, 'SGD'), 'SGD 0');
  assert.ok(f('en-SG', -2550, 'SGD').startsWith('−'), 'refunds / credit notes show a minus');
  assert.equal(f('en-SG', 2550, 'SGD', { signed: true })[0], '+');
  assert.equal(f('en', 100, 'XXXX'), '1', 'an invalid code is not a currency');
});

test('typed amounts parse exactly to minor units and refuse what the currency cannot hold', () => {
  assert.equal(parseAmount('12.50', 'SGD'), 1250);
  assert.equal(parseAmount('1,200', 'INR'), 120000);
  assert.equal(parseAmount('1,200.50', 'INR'), 120050);
  assert.equal(parseAmount('12,5', 'EUR'), 1250);
  assert.equal(parseAmount('5000', 'JPY'), 5000);
  assert.equal(parseAmount('12.345', 'KWD'), 12345);
  assert.equal(parseAmount('0.29', 'USD'), 29);
  assert.equal(parseAmount('12.345', 'USD'), null, 'a third decimal is rejected, not rounded away');
  assert.equal(parseAmount('12.5', 'JPY'), null);
  assert.equal(parseAmount('', 'USD'), null);
  assert.equal(parseAmount('abc', 'USD'), null);
  assert.equal(parseAmount('-5', 'USD'), null);
  assert.equal(parseAmount('99999999999999999999', 'USD'), null);
  assert.equal(toMajorText(12345, 'KWD'), '12.345');
  assert.equal(toMajorText(1250, 'SGD'), '12.50');
  assert.equal(toMajorText(5000, 'JPY'), '5000');
});
