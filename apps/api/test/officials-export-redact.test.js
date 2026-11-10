// REF-R10: Tests for redactExport() — PII/fee redaction in official extracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { redactExport } = await import('../src/officials.js');

const baseRow = {
  user_id: 'user-a',
  vat_number: 'GB123456789',
  bank_account: '12345678',
  bank_sort_code: '20-00-00',
  bank_iban: 'GB00BARC00000012345678',
  tax_country: 'GB',
  vat_registered: true,
  fee_minor: 5000,
  fee_currency: 'GBP',
  pay_status: 'paid',
  pay_confirmed_at: new Date().toISOString(),
  bio: 'Elite referee bio',
  birth_date: '1990-03-15',
  is_minor: false,
};

test('own record: all fee/bank fields returned', () => {
  const actor = { id: 'user-a', roles: [] };
  const result = redactExport(baseRow, actor);
  assert.equal(result.fee_minor, 5000);
  assert.equal(result.bank_account, '12345678');
  assert.equal(result.vat_number, 'GB123456789');
});

test('other user (non-admin): fee and bank fields nulled', () => {
  const actor = { id: 'user-b', roles: [] };
  const result = redactExport(baseRow, actor);
  assert.equal(result.fee_minor, null);
  assert.equal(result.bank_account, null);
  assert.equal(result.vat_number, null);
  assert.equal(result.bank_iban, null);
  assert.equal(result.pay_status, null);
});

test('platform admin: all fields returned', () => {
  const actor = { id: 'user-b', roles: ['admin', 'platform_admin'] };
  const result = redactExport(baseRow, actor);
  assert.equal(result.fee_minor, 5000);
  assert.equal(result.bank_account, '12345678');
});

test('bio hidden from non-doctor non-admin', () => {
  const actor = { id: 'user-b', roles: [] };
  const result = redactExport(baseRow, actor);
  assert.equal(result.bio, null);
});

test('bio visible to doctor', () => {
  const actor = { id: 'user-b', roles: ['doctor'] };
  const result = redactExport(baseRow, actor);
  assert.equal(result.bio, 'Elite referee bio');
});

test('minor birth_date truncated for non-guardian', () => {
  const minorRow = { ...baseRow, is_minor: true };
  const actor = { id: 'user-b', roles: [] };
  const result = redactExport(minorRow, actor);
  assert.match(result.birth_date, /^\d{4}-\d{2}-01$/);
});
