// Issue #249 (phase 1): brand kits + logo, versioned templates, branded invoice PDFs, and who may do what.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', MEDIA_DIR: mkdtempSync(join(tmpdir(), 'bd-')) });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body, raw, type } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? { 'content-type': type ?? 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `bd_${n}_${roles[0]}`, display_name: `BD ${n}`, email: `bd${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };

// a real, valid size×size solid-colour PNG
const crcT = Array.from({ length: 256 }, (_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]); const o = Buffer.alloc(4); o.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(b)); return Buffer.concat([o, b, c]); };
const png = (size) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]); return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]); };

const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
async function invoiceFixture() {
  const mgr = await signup(['venue_manager']), cust = await signup();
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Brand Arena ${n}`, timezone: 'UTC', currency: 'INR' } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000 } }), 201);
  must(await api('POST', '/reservations', { token: cust.token, body: { items: [{ resource_id: court.id, starts_at: at(3, 10), ends_at: at(3, 12) }] } }), 201);
  const inv = must(await api('GET', `/invoices?venue_id=${v.id}`, { token: mgr.token }))[0];
  return { mgr, cust, inv };
}

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

const kitBody = { name: 'Main', display_name: 'Brand Arena', legal_name: 'Brand Arena Pvt Ltd', address: '1 Court Road', footer_text: 'Thank you for playing' };

test('families are listed honestly: only invoices and coaching reports have a connected source', async () => {
  const u = await signup();
  const f = must(await api('GET', '/branded-documents/families', { token: u.token }));
  assert.equal(f.families.find((x) => x.family === 'invoice').source.available, true);
  assert.ok(f.families.filter((x) => !['invoice', 'coaching_report'].includes(x.family)).every((x) => x.source.available === false && x.source.reason));
  const t = await api('POST', '/document-templates', { token: u.token, body: { family: 'rehab_plan', name: 'Rehab' } });
  assert.equal(t.status, 409);
});

test('logo upload validates the bytes, keeps old assets, and stays private to the kit owner', async () => {
  const a = await signup(), b = await signup();
  const kit = must(await api('POST', '/brand-kits', { token: a.token, body: kitBody }));
  assert.equal((await api('PUT', `/brand-kits/${kit.id}/logo`, { token: a.token, raw: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/svg+xml' })).status, 400);
  assert.equal((await api('PUT', `/brand-kits/${kit.id}/logo`, { token: a.token, raw: png(16) })).status, 400, 'too small');
  assert.equal((await api('PUT', `/brand-kits/${kit.id}/logo`, { token: b.token, raw: png(64) })).status, 404, 'not your kit');
  const up = must(await api('PUT', `/brand-kits/${kit.id}/logo`, { token: a.token, raw: png(64) }), 201);
  assert.equal(up.width, 64); assert.ok(up.warnings.length, 'low-resolution warning');
  const up2 = must(await api('PUT', `/brand-kits/${kit.id}/logo`, { token: a.token, raw: png(80) }), 201);
  assert.notEqual(up.asset_id, up2.asset_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM brand_assets WHERE kit_id=$1', [kit.id])).rows[0].n, 2, 'old logo kept');
  const dl = await api('GET', `/brand-kits/${kit.id}/logo`, { token: a.token });
  assert.equal(dl.status, 200); assert.equal(dl.body.subarray(1, 4).toString(), 'PNG');
  assert.equal((await api('GET', `/brand-kits/${kit.id}/logo`, { token: b.token })).status, 404);
  assert.equal((await api('GET', '/brand-kits', { token: b.token })).body.length, 0);
  await assert.rejects(pool.query('UPDATE brand_assets SET width_px=1'), /append-only/);
});

test('organisation kits: finance may use, only owner/admin may change', async () => {
  const owner = await signup(), fin = await signup(), outsider = await signup();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Brand Org' } }), 201);
  must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: fin.handle, role: 'finance' } }), 201);
  must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: fin.token, body: { accept: true } }));
  assert.equal((await api('POST', '/brand-kits', { token: fin.token, body: { ...kitBody, organisation_id: org.id } })).status, 403);
  assert.equal((await api('POST', '/brand-kits', { token: outsider.token, body: { ...kitBody, organisation_id: org.id } })).status, 404);
  const kit = must(await api('POST', '/brand-kits', { token: owner.token, body: { ...kitBody, organisation_id: org.id } }));
  assert.equal(must(await api('GET', '/brand-kits', { token: fin.token })).length, 1);
  assert.equal((await api('PATCH', `/brand-kits/${kit.id}`, { token: fin.token, body: { row_version: 1, display_name: 'X' } })).status, 403);
  assert.equal((await api('PUT', `/brand-kits/${kit.id}/logo`, { token: fin.token, raw: png(64) })).status, 403);
  assert.equal((await api('GET', '/brand-kits', { token: outsider.token })).body.length, 0);
  // optimistic locking
  must(await api('PATCH', `/brand-kits/${kit.id}`, { token: owner.token, body: { row_version: 1, display_name: 'New' } }));
  assert.equal((await api('PATCH', `/brand-kits/${kit.id}`, { token: owner.token, body: { row_version: 1, display_name: 'Stale' } })).status, 409);
});

test('templates: layouts cannot drop mandatory blocks; published versions are immutable', async () => {
  const u = await signup();
  const kit = must(await api('POST', '/brand-kits', { token: u.token, body: kitBody }));
  const bad = await api('POST', '/document-templates', { token: u.token, body: { family: 'invoice', name: 'No totals', layout: { blocks: [{ type: 'header' }, { type: 'title' }, { type: 'parties' }, { type: 'lines' }] } } });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /totals/);
  assert.equal((await api('POST', '/document-templates', { token: u.token, body: { family: 'invoice', name: 'Script', layout: { blocks: [{ type: 'title' }, { type: 'parties' }, { type: 'lines' }, { type: 'totals' }, { type: 'html', text: '<script>' }] } } })).status, 400);
  const t = must(await api('POST', '/document-templates', { token: u.token, body: { family: 'invoice', name: 'Modern', starter: 'modern', kit_id: kit.id } }));
  assert.equal(t.status, 'draft');
  const p1 = must(await api('POST', `/document-templates/${t.id}/publish`, { token: u.token, body: { row_version: t.row_version } }));
  assert.equal(p1.version, 1);
  assert.equal((await api('POST', `/document-templates/${t.id}/publish`, { token: u.token, body: { row_version: t.row_version } })).status, 409, 'stale');
  const [cur] = must(await api('GET', '/document-templates?family=invoice', { token: u.token }));
  must(await api('PATCH', `/document-templates/${t.id}`, { token: u.token, body: { row_version: cur.row_version, layout: { ...cur.draft, paper: 'Letter' } } }));
  assert.equal((await pool.query('SELECT layout->>\'paper\' AS p FROM document_template_versions WHERE template_id=$1 AND version=1', [t.id])).rows[0].p, 'A4', 'published version untouched by draft edit');
  await assert.rejects(pool.query('DELETE FROM document_template_versions'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM brand_kits'), /never deleted/);
});

test('branded invoice PDF: canonical numbers, stored immutably, access re-checked on every download', async () => {
  const { mgr, cust, inv } = await invoiceFixture();
  const stranger = await signup();
  const kit = must(await api('POST', '/brand-kits', { token: mgr.token, body: kitBody }));
  must(await api('PUT', `/brand-kits/${kit.id}/logo`, { token: mgr.token, raw: png(320) }), 201);
  const t = must(await api('POST', '/document-templates', { token: mgr.token, body: { family: 'invoice', name: 'Modern', starter: 'modern', kit_id: kit.id } }));
  assert.equal((await api('POST', '/branded-documents/invoice', { token: mgr.token, body: { invoice_id: inv.id, template_id: t.id } })).status, 409, 'draft not publishable until published');
  must(await api('POST', `/document-templates/${t.id}/publish`, { token: mgr.token, body: { row_version: t.row_version } }));
  const before = (await pool.query('SELECT total_cents, number, status FROM invoices WHERE id=$1', [inv.id])).rows[0];
  const d = must(await api('POST', '/branded-documents/invoice', { token: mgr.token, body: { invoice_id: inv.id, template_id: t.id } }));
  assert.deepEqual((await pool.query('SELECT total_cents, number, status FROM invoices WHERE id=$1', [inv.id])).rows[0], before, 'generation changes nothing');
  const pdf = must(await api('GET', `/branded-documents/${d.id}/file`, { token: mgr.token }));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pdf.length, d.size_bytes);
  assert.ok(pdf.toString('latin1').includes('/Subtype /Image'), 'logo embedded');
  assert.equal(must(await api('GET', `/branded-documents/${d.id}/file`, { token: cust.token })).length, d.size_bytes, 'the buyer can download too');
  assert.equal((await api('GET', `/branded-documents/${d.id}/file`, { token: stranger.token })).status, 404);
  assert.equal((await api('POST', '/branded-documents/invoice', { token: stranger.token, body: { invoice_id: inv.id } })).status, 404);
  assert.equal((await api('POST', '/branded-documents/invoice', { token: cust.token, body: { invoice_id: inv.id, template_id: t.id } })).status, 404, "the customer cannot use the venue's template");
  // a later logo change does not reach published versions: both documents keep the logo frozen into v1 until the template is republished
  must(await api('PUT', `/brand-kits/${kit.id}/logo`, { token: mgr.token, raw: png(400) }), 201);
  const d2 = must(await api('POST', '/branded-documents/invoice', { token: mgr.token, body: { invoice_id: inv.id, template_id: t.id } }));
  assert.notEqual(d.id, d2.id, 'regeneration is a new document');
  const pinned = async (x) => (await pool.query('SELECT logo_asset_id FROM generated_documents WHERE id=$1', [x])).rows[0].logo_asset_id;
  assert.equal(await pinned(d.id), await pinned(d2.id));
  const [cur] = must(await api('GET', '/document-templates', { token: mgr.token }));
  must(await api('POST', `/document-templates/${t.id}/publish`, { token: mgr.token, body: { row_version: cur.row_version } }));
  const d3 = must(await api('POST', '/branded-documents/invoice', { token: mgr.token, body: { invoice_id: inv.id, template_id: t.id } }));
  assert.notEqual(await pinned(d3.id), await pinned(d.id), 'v2 picks up the new logo');
  assert.equal(await pinned(d.id), (await pool.query('SELECT logo_asset_id FROM document_template_versions WHERE template_id=$1 AND version=1', [t.id])).rows[0].logo_asset_id, 'issued document keeps its original logo');
  assert.equal(must(await api('GET', `/branded-documents?invoice_id=${inv.id}`, { token: cust.token })).length, 3);
  // plain classic layout without a template
  assert.equal(must(await api('POST', '/branded-documents/invoice', { token: cust.token, body: { invoice_id: inv.id } })).template_version_id, null);
  await assert.rejects(pool.query('UPDATE generated_documents SET pages=9'), /append-only/);
});

test('preview renders SAMPLE through the same engine; non-Latin text is refused rather than garbled', async () => {
  const u = await signup();
  const kit = must(await api('POST', '/brand-kits', { token: u.token, body: kitBody }));
  const r = await api('POST', '/branded-documents/preview', { token: u.token, body: { layout: { blocks: [{ type: 'header' }, { type: 'title' }, { type: 'parties' }, { type: 'lines' }, { type: 'totals' }, { type: 'footer' }] }, kit_id: kit.id } });
  assert.equal(r.status, 200); assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api('POST', '/branded-documents/preview', { token: u.token, body: { layout: { blocks: [{ type: 'title' }] } } })).status, 400);
  const other = await signup();
  assert.equal((await api('POST', '/branded-documents/preview', { token: other.token, body: { layout: { blocks: [{ type: 'header' }, { type: 'title' }, { type: 'parties' }, { type: 'lines' }, { type: 'totals' }] }, kit_id: kit.id } })).status, 404);
  const ta = await api('POST', '/branded-documents/preview', { token: u.token, body: { layout: { blocks: [{ type: 'title' }, { type: 'parties' }, { type: 'lines' }, { type: 'totals' }, { type: 'text', text: 'வணக்கம்' }] } } });
  assert.equal(ta.status, 422); assert.equal(ta.body.error.code, 'unsupported_characters');
});

test('text blocks may carry alignment and size; other blocks may not', async () => {
  const u = await signup();
  const base = [{ type: 'title' }, { type: 'parties' }, { type: 'lines' }, { type: 'totals' }];
  const ok = await api('POST', '/branded-documents/preview', { token: u.token, body: { layout: { blocks: [...base, { type: 'text', text: 'Pay within 14 days', align: 'center', size: 'large' }] } } });
  assert.equal(ok.status, 200); assert.equal(ok.body.subarray(0, 5).toString(), '%PDF-');
  const bad = await api('POST', '/branded-documents/preview', { token: u.token, body: { layout: { blocks: [{ type: 'title', align: 'center' }, ...base.slice(1)] } } });
  assert.equal(bad.status, 400);
});
