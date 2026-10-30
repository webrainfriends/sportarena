// Tamper-evident audit log (#632): rows are chained when sealed, any change or removal of a sealed row is detected, the database refuses
// edits and deletes, concurrent writers and sealers never fork the chain, and the export and verify capabilities are platform-admin only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { audit } = await import('../src/helpers.js');
const { sealAuditLog, verifyAuditChain } = await import('../src/audit-chain.js');

let server, base, admin, plain;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const reg = async (handle, email) => {
  const r = await api('POST', '/auth/register', { body: { handle, display_name: handle, email, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user?.id ?? (await pool.query('SELECT id FROM users WHERE handle=$1', [handle])).rows[0].id };
};
const asOwner = async (sql) => { // the only way to alter the log: a database owner switching the guard off, which the chain must then expose
  const c = await pool.connect();
  try { await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only'); await c.query(sql); } finally { await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only'); c.release(); }
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await reg('chain_boss', 'rraja.edge@gmail.com');
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [admin.id]);
  plain = await reg('chain_plain', 'plain-chain@example.com');
});
after(async () => { server.close(); await pool.end(); });

test('rows written before sealing are chained on the first seal, and the chain verifies', async () => {
  for (let i = 0; i < 5; i++) await audit(null, admin.id, `chain_test_${i}`, 'platform', null);
  const before = (await pool.query('SELECT count(*)::int AS n FROM audit_log WHERE hash IS NULL')).rows[0].n;
  assert.ok(before >= 5, 'inserts are not sealed inline');
  const v = await verifyAuditChain();
  assert.equal(v.intact, true, JSON.stringify(v));
  assert.equal(v.pending_rows, 0);
  assert.ok(v.sealed_rows >= 5);
  assert.match(v.head.hash, /^[0-9a-f]{64}$/);
  const rows = (await pool.query('SELECT seq, prev_hash, hash FROM audit_log WHERE seq IS NOT NULL ORDER BY seq')).rows;
  assert.equal(rows[0].prev_hash, null);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
});

test('the database refuses edits, deletes and truncation of the log', async () => {
  await audit(null, admin.id, 'chain_guard', 'platform', null);
  await verifyAuditChain();
  await assert.rejects(pool.query("UPDATE audit_log SET action = 'x' WHERE action = 'chain_guard'"), /append-only/);
  await assert.rejects(pool.query("DELETE FROM audit_log WHERE action = 'chain_guard'"), /append-only/);
  await assert.rejects(pool.query('TRUNCATE audit_log'), /append-only/);
  await assert.rejects(pool.query("UPDATE audit_log SET hash = 'forged' WHERE action = 'chain_guard'"), /append-only/, 'a sealed row cannot be re-sealed');
});

test('concurrent writers and sealers never fork the chain', async () => {
  await Promise.all([
    ...Array.from({ length: 40 }, (_, i) => audit(null, admin.id, `chain_par_${i}`, 'platform', null)),
    sealAuditLog(), sealAuditLog(), sealAuditLog(),
  ]);
  const v = await verifyAuditChain();
  assert.equal(v.intact, true, JSON.stringify(v));
  assert.equal(v.pending_rows, 0);
});

test('changing, removing or reordering a sealed row is detected, and the first broken row is named', async () => {
  const target = (await pool.query("SELECT seq FROM audit_log WHERE action = 'chain_test_2'")).rows[0].seq;
  await asOwner(`UPDATE audit_log SET action = 'tampered' WHERE seq = ${target}`);
  let v = await verifyAuditChain();
  assert.equal(v.intact, false); assert.equal(v.first_break, target);
  await asOwner(`UPDATE audit_log SET action = 'chain_test_2' WHERE seq = ${target}`);
  assert.equal((await verifyAuditChain()).intact, true, 'restoring the original makes it verify again');

  const victim = (await pool.query("SELECT seq FROM audit_log WHERE action = 'chain_test_3'")).rows[0].seq;
  await asOwner(`CREATE TABLE zz_audit_bk AS SELECT * FROM audit_log WHERE seq = ${victim}; DELETE FROM audit_log WHERE seq = ${victim}`);
  v = await verifyAuditChain();
  assert.equal(v.intact, false); assert.equal(v.first_break, victim + 1, 'the gap shows at the next row');
  await asOwner('INSERT INTO audit_log SELECT * FROM zz_audit_bk; DROP TABLE zz_audit_bk');
  assert.equal((await verifyAuditChain()).intact, true);

  const last = (await pool.query('SELECT max(seq)::int AS seq FROM audit_log')).rows[0].seq;
  await asOwner(`CREATE TABLE zz_audit_bk AS SELECT * FROM audit_log WHERE seq = ${last}; DELETE FROM audit_log WHERE seq = ${last}`);
  v = await verifyAuditChain();
  assert.equal(v.intact, false, 'dropping the newest row is caught against the head');
  assert.equal(v.head_mismatch, true);
  await asOwner('INSERT INTO audit_log SELECT * FROM zz_audit_bk; DROP TABLE zz_audit_bk');
  assert.equal((await verifyAuditChain()).intact, true);
});

test('verify and export are platform-admin only, export pages in sequence order, and reading is audit-logged', async () => {
  for (const t of [plain.token, undefined]) {
    assert.ok([401, 403].includes((await api('POST', '/platform/security/audit-chain/verify', { token: t })).status));
    assert.ok([401, 403].includes((await api('GET', '/platform/security/audit-log', { token: t })).status));
  }
  const v = await api('POST', '/platform/security/audit-chain/verify', { token: admin.token });
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(v.body.intact, true);
  const p1 = await api('GET', '/platform/security/audit-log?limit=10', { token: admin.token });
  assert.equal(p1.status, 200); assert.equal(p1.body.rows.length, 10); assert.ok(p1.body.next_since_seq);
  const p2 = await api('GET', `/platform/security/audit-log?limit=10&since_seq=${p1.body.next_since_seq}`, { token: admin.token });
  assert.ok(p2.body.rows[0].seq > p1.body.rows[9].seq);
  assert.ok(p1.body.rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash)));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export_audit_log' AND actor_id=$1", [admin.id])).rowCount >= 1);
});
