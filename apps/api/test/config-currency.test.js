// An unset deploy variable reaches the server as an empty string. That must mean "use the default", never an empty currency
// (which made every coach class publish fail with "Unsupported currency").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const currencyFor = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  "const { config } = await import('./src/config.js'); console.log(JSON.stringify({ pay: config.payments.currency, settle: config.settlement.currencies }));"],
{ env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://x@/x', ...env }, cwd: new URL('..', import.meta.url), encoding: 'utf8' }));

test('empty or blank PAYMENT_CURRENCY / SETTLEMENT_CURRENCIES fall back to INR', () => {
  assert.deepEqual(currencyFor({ PAYMENT_CURRENCY: '', SETTLEMENT_CURRENCIES: '' }), { pay: 'INR', settle: ['INR'] });
  assert.deepEqual(currencyFor({ PAYMENT_CURRENCY: '  ' }), { pay: 'INR', settle: ['INR'] });
});

test('a configured currency is used, upper-cased', () => {
  assert.deepEqual(currencyFor({ PAYMENT_CURRENCY: 'usd' }), { pay: 'USD', settle: ['USD'] });
});
