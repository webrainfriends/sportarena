// India GST shared engine unit tests (#503): resolveIndiaGst, freezeGstDetail, resolveTdsDetail, freezeIssuerSnapshot.
// Pure-function tests — no DB required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIndiaGst, freezeGstDetail, resolveTdsDetail, freezeIssuerSnapshot } from '../src/india-tax.js';

test('intra-state: splits tax into CGST + SGST halves', async () => {
  const r = await resolveIndiaGst(null, { gross: 100000, rateBp: 1800, supplierState: '27', buyerState: '27' });
  assert.equal(r.cgst_cents, 9000);
  assert.equal(r.sgst_cents, 9000);
  assert.equal(r.igst_cents, 0);
  assert.equal(r.supply, 'intra_state');
  assert.equal(r.tax_cents, 18000);
});

test('inter-state: single IGST', async () => {
  const r = await resolveIndiaGst(null, { gross: 100000, rateBp: 1800, supplierState: '27', buyerState: '07' });
  assert.equal(r.igst_cents, 18000);
  assert.equal(r.cgst_cents, 0);
  assert.equal(r.sgst_cents, 0);
  assert.equal(r.supply, 'inter_state');
});

test('tax-inclusive: extracts taxable from gross correctly', async () => {
  const r = await resolveIndiaGst(null, { gross: 118000, rateBp: 1800, taxInclusive: true, supplierState: '27', buyerState: '27' });
  assert.ok(r.taxable_cents >= 99999 && r.taxable_cents <= 100001, `taxable ${r.taxable_cents} should be ~100000`);
  assert.equal(r.total_cents, 118000);
});

test('defaults to 18% when no rateBp supplied', async () => {
  const r = await resolveIndiaGst(null, { gross: 100000, supplierState: '27', buyerState: '27' });
  assert.equal(r.rate_bp, 1800);
  assert.equal(r.tax_cents, 18000);
});

test('freezeGstDetail returns all required JSONB keys', async () => {
  const r = await resolveIndiaGst(null, { gross: 100000, rateBp: 1800, supplierState: '27', buyerState: '27', sacCode: '999311' });
  const d = freezeGstDetail(r);
  for (const k of ['cgst_cents', 'sgst_cents', 'igst_cents', 'place_of_supply', 'supply_type', 'hsn_sac_code', 'reverse_charge', 'tax_treatment', 'rate_bp']) {
    assert.ok(k in d, `missing key: ${k}`);
  }
  assert.equal(d.hsn_sac_code, '999311');
  assert.equal(d.supply_type, 'intra_state');
});

test('resolveTdsDetail: Section 194J 10%', () => {
  const d = resolveTdsDetail({ sectionRef: '194J', rateBp: 1000, basisCents: 20000 });
  assert.equal(d.withheld_cents, 2000);
  assert.equal(d.section_ref, '194J');
  assert.equal(d.rate_bp, 1000);
});

test('resolveTdsDetail: Section 194C 2%', () => {
  const d = resolveTdsDetail({ sectionRef: '194C', rateBp: 200, basisCents: 50000 });
  assert.equal(d.withheld_cents, 1000);
});

test('freezeIssuerSnapshot shapes the profile correctly', () => {
  const profile = { gstin: '27AAACN1234F1Z5', legal_name: 'Test Org', trade_name: 'Test', state_code: '27', invoice_prefix: 'NTA', invoice_series: '2025-26', effective_from: '2025-04-01' };
  const snap = freezeIssuerSnapshot(profile);
  assert.equal(snap.gstin, '27AAACN1234F1Z5');
  assert.equal(snap.invoice_prefix, 'NTA');
  assert.equal(snap.effective_at, '2025-04-01');
});
