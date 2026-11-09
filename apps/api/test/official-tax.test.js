import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `taxu_${n}`, display_name: `TaxUser ${n}`, email: `taxu${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ---- inclusive tax helper --------------------------------------------------
test('inclusiveTax rounds correctly', async () => {
  const { inclusiveTax } = await import('../src/capabilities/official-tax.js');
  // 9% GST on 109: tax = round(109 * 900 / (10000+900)) = round(9) = 9, net = 100
  assert.equal(inclusiveTax(109_00, 900), 9_00);
  // 20% VAT on 120: tax = 20
  assert.equal(inclusiveTax(120_00, 2000), 20_00);
  // 0% -> 0 tax
  assert.equal(inclusiveTax(100_00, 0), 0);
  // zero gross
  assert.equal(inclusiveTax(0, 900), 0);
});

// ---- only referee role can access ------------------------------------------
test('non-referee cannot set tax profile', async () => {
  const org = await signup(['organizer']);
  const r = await api('POST', '/mcp', { token: org.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'Org User', tax_country: 'SG', tax_regime: 'gst', registration_status: 'registered' } } });
  assert.equal(r.status, 403, 'organizer must be forbidden');
});

// ---- full profile round-trip -----------------------------------------------
test('referee can create and read back tax profile', async () => {
  const ref = await signup(['referee']);
  const setR = await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'Rafi Nadal', tax_country: 'SG', tax_regime: 'gst', registration_status: 'registered', registration_id: 'SG200000001A', price_display: 'inclusive', withholding_applicable: false } } });
  assert.equal(setR.status, 200, JSON.stringify(setR.body));
  const profile = setR.body.result;
  assert.equal(profile.tax_country, 'SG');
  assert.equal(profile.tax_regime, 'gst');
  assert.equal(profile.registration_status, 'registered');
  assert.equal(profile.price_display, 'inclusive');

  const getR = await api('POST', '/mcp', { token: ref.token, body: { name: 'get_official_tax_profile', input: {} } });
  assert.equal(getR.status, 200);
  assert.equal(getR.body.result.tax_country, 'SG');
});

// ---- second save creates new version (append-only) -------------------------
test('profile updates create new effective-dated versions', async () => {
  const ref = await signup(['referee']);
  await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'V1 Official', tax_country: 'AU', tax_regime: 'gst', registration_status: 'not_registered' } } });
  await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'V1 Official', tax_country: 'AU', tax_regime: 'gst', registration_status: 'registered', registration_id: 'ABN1234567' } } });
  const rows = await pool.query('SELECT * FROM official_tax_profiles WHERE user_id=$1 ORDER BY effective_from', [ref.id]);
  assert.equal(rows.rows.length, 2, 'must have two versions');
});

// ---- tax rate operations ----------------------------------------------------
test('add and read back tax rates', async () => {
  const ref = await signup(['referee']);
  await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'Rate Tester', tax_country: 'GB', tax_regime: 'vat', registration_status: 'registered' } } });
  const addR = await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_rate', input: { tax_class: 'standard', rate_percent: 20, source: 'HMRC Notice 700, effective 2024-04-06' } } });
  assert.equal(addR.status, 200);
  assert.equal(addR.body.result.rate_bp, 2000);
});

// ---- earnings report --------------------------------------------------------
test('earnings report returns empty when no payout_items', async () => {
  const ref = await signup(['referee']);
  await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'Empty Earner', tax_country: 'SG', tax_regime: 'gst', registration_status: 'not_registered' } } });
  const r = await api('POST', '/mcp', { token: ref.token, body: { name: 'official_earnings_report', input: { period_from: '2024-01-01', period_to: '2024-12-31' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result.groups, []);
});

// ---- invoice generation requires profile + rate -----------------------------
test('generate invoice returns 400 when no profile', async () => {
  const ref = await signup(['referee']);
  const r = await api('POST', '/mcp', { token: ref.token, body: { name: 'generate_official_tax_invoice', input: { period_from: '2024-01-01', period_to: '2024-12-31', currency: 'SGD', kind: 'invoice' } } });
  assert.equal(r.status, 400, 'must require tax profile');
});

// ---- jurisdiction policies list --------------------------------------------
test('list_jurisdiction_tax_policies returns seed data', async () => {
  const ref = await signup(['referee']);
  const r = await api('POST', '/mcp', { token: ref.token, body: { name: 'list_jurisdiction_tax_policies', input: {} } });
  assert.equal(r.status, 200);
  assert.ok(r.body.result.length >= 9, 'expect at least 9 seeded jurisdictions');
  const sg = r.body.result.find(p => p.country_code === 'SG');
  assert.ok(sg, 'SG policy must be seeded');
  assert.equal(sg.standard_rate_bp, 900, 'SG GST is 9%');
});

// ---- invoice mark-paid and void lifecycle ----------------------------------
test('invoice lifecycle: generate -> mark paid -> attempt void fails', async () => {
  const ref = await signup(['referee']);
  await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'Invoice Tester', tax_country: 'SG', tax_regime: 'gst', registration_status: 'registered' } } });
  await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_rate', input: { tax_class: 'standard', rate_percent: 9, source: 'IRAS 2024' } } });
  // With no payout items, invoice will have 0 lines — that is valid; the invoice still generates
  const genR = await api('POST', '/mcp', { token: ref.token, body: { name: 'generate_official_tax_invoice', input: { period_from: '2024-01-01', period_to: '2024-12-31', currency: 'SGD', kind: 'invoice' } } });
  assert.equal(genR.status, 200, JSON.stringify(genR.body));
  const inv = genR.body.result;
  assert.equal(inv.status, 'open');
  assert.match(inv.invoice_no, /^ORI-\d{4}-\d{5}$/);

  const paidR = await api('POST', '/mcp', { token: ref.token, body: { name: 'mark_official_invoice_paid', input: { invoice_id: inv.id, paid_note: 'Bank transfer ref 1234' } } });
  assert.equal(paidR.status, 200);
  assert.equal(paidR.body.result.status, 'paid');

  // Voiding a paid invoice must fail
  const voidR = await api('POST', '/mcp', { token: ref.token, body: { name: 'void_official_tax_invoice', input: { invoice_id: inv.id, reason: 'Mistake' } } });
  assert.equal(voidR.status, 400, 'cannot void a paid invoice');
});

// ---- isolation: referee A cannot see referee B's invoices ------------------
test('referee cannot access another referee tax data', async () => {
  const refA = await signup(['referee']);
  const refB = await signup(['referee']);
  await api('POST', '/mcp', { token: refA.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'Referee A', tax_country: 'SG', tax_regime: 'gst', registration_status: 'registered' } } });
  await api('POST', '/mcp', { token: refA.token, body: { name: 'set_official_tax_rate', input: { tax_class: 'standard', rate_percent: 9, source: 'IRAS 2024' } } });
  const genR = await api('POST', '/mcp', { token: refA.token, body: { name: 'generate_official_tax_invoice', input: { period_from: '2024-01-01', period_to: '2024-12-31', currency: 'SGD', kind: 'invoice' } } });
  const invId = genR.body.result.id;

  // refB tries to get refA's invoice
  const r = await api('POST', '/mcp', { token: refB.token, body: { name: 'get_official_tax_invoice', input: { invoice_id: invId } } });
  assert.equal(r.status, 404, 'must not leak another official invoice');
});

// ---- annual statement -------------------------------------------------------
test('official_tax_statement returns structured breakdown', async () => {
  const ref = await signup(['referee']);
  await api('POST', '/mcp', { token: ref.token, body: { name: 'set_official_tax_profile', input: { legal_name: 'Stmt Tester', tax_country: 'AU', tax_regime: 'gst', registration_status: 'registered' } } });
  const r = await api('POST', '/mcp', { token: ref.token, body: { name: 'official_tax_statement', input: { year: 2024, granularity: 'month' } } });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.result.periods), 'must have periods array');
  assert.equal(r.body.result.periods.length, 12, 'month granularity must have 12 periods');
});

// ---- i18n catalogue (smoke test) -------------------------------------------
test('i18n catalogue has all otax keys in every language', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const dir = resolve('../app/src/i18n');
  const langs = (await readdir(dir)).filter(f => f.endsWith('.js') && f !== 'en.js' && f !== 'index.js');
  const enSrc = await readFile(resolve(dir, 'en.js'), 'utf8');
  const otaxKeys = [...enSrc.matchAll(/'(otax\.[^']+)':/g)].map(m => m[1]);
  assert.ok(otaxKeys.length >= 50, `en.js must have >= 50 otax keys, got ${otaxKeys.length}`);
  for (const lang of langs) {
    const src = await readFile(resolve(dir, lang), 'utf8');
    for (const key of otaxKeys) {
      assert.ok(src.includes(`'${key}':`), `${lang} missing key ${key}`);
    }
  }
});
