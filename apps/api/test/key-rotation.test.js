// Key rotation (#632): the keyring keeps old values readable, a run re-encrypts what it can map and reports what it cannot, nothing is lost,
// append-only tables are never bypassed, and the platform-admin gate holds. Every test builds its own data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
process.env.SPORTARENA_MASTER_KEY_K2 = Buffer.alloc(32, 9).toString('base64');
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');
const { encrypt, decrypt, keyIdOf, reencrypt } = await import('../src/crypto.js');
const { startRotation, encryptedColumns, contextPool } = await import('../src/key-rotation.js');

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

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  config.keyIds = ['k1', 'k2']; config.activeKeyId = 'k1';
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await reg('key_boss', 'rraja.edge@gmail.com');
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [admin.id]);
  plain = await reg('key_plain', 'plain-keys@example.com');
});
after(async () => { config.activeKeyId = 'k1'; server.close(); await pool.end(); });

test('keyring: k1 writes v1 as before; another active key writes v2.<id>; both always decrypt; reencrypt moves a value across', () => {
  config.activeKeyId = 'k1';
  const old = encrypt('secret', 'users.phone');
  assert.ok(old.startsWith('v1.') && keyIdOf(old) === 'k1');
  config.activeKeyId = 'k2';
  const fresh = encrypt('secret', 'users.phone');
  assert.ok(fresh.startsWith('v2.k2.') && keyIdOf(fresh) === 'k2');
  assert.equal(decrypt(old, 'users.phone'), 'secret');
  assert.equal(decrypt(fresh, 'users.phone'), 'secret');
  const moved = reencrypt(old, 'users.phone');
  assert.equal(keyIdOf(moved), 'k2'); assert.equal(decrypt(moved, 'users.phone'), 'secret');
  assert.equal(reencrypt(fresh, 'users.phone'), fresh, 'already current: unchanged');
  assert.throws(() => decrypt(fresh, 'users.address'), /unable to authenticate|Unsupported state/i, 'the context binding still holds');
  config.activeKeyId = 'k1';
});

test('the context pool knows the unusual contexts the app uses', () => {
  const p = contextPool();
  for (const c of ['race.reason', 'access_credentials', 'off_assessment_versions.narrative', 'users.dob']) assert.ok(p.includes(c), c);
});

test('every encrypted column is discovered, and each has a primary key to page by or says why not', async () => {
  const cols = await encryptedColumns();
  assert.ok(cols.length > 150);
  for (const c of cols) assert.ok(c.pk || c.skip, c.key);
  assert.deepEqual(cols.find((c) => c.key === 'physio_report_versions.snapshot_enc').pk, ['report_id', 'version'], 'a composite primary key is paged as a tuple');
  assert.ok(cols.some((c) => c.key === 'users.email_enc'));
});

test('a run re-encrypts what it can map, leaves the rest untouched and reports it, and is idempotent; nothing is lost', async () => {
  config.activeKeyId = 'k1';
  await pool.query(`CREATE TABLE zz_enc (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone_enc text, thing_enc text, mystery_enc text)`);
  await pool.query(`CREATE TABLE zz_locked (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_enc text)`);
  await pool.query(`CREATE FUNCTION zz_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only' USING ERRCODE = 'check_violation'; END $$`);
  await pool.query(`CREATE TRIGGER zz_locked_guard BEFORE UPDATE ON zz_locked FOR EACH ROW EXECUTE FUNCTION zz_no_update()`);
  const mystery = encrypt('who knows', 'nowhere.known');
  const ins = await pool.query('INSERT INTO zz_enc(phone_enc, thing_enc, mystery_enc) VALUES ($1,$2,$3) RETURNING id', [encrypt('+91 98100 00001', 'zz_enc.phone'), encrypt('odd context', 'race.reason'), mystery]);
  const locked = await pool.query('INSERT INTO zz_locked(note_enc) VALUES ($1) RETURNING id, note_enc', [encrypt('frozen', 'zz_locked.note')]);
  const usersBefore = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;

  config.activeKeyId = 'k2';
  const run = await startRotation(admin.id, { wait: true });
  const done = (await pool.query('SELECT * FROM key_rotation_runs WHERE id=$1', [run.id])).rows[0];
  assert.equal(done.status, 'done', done.error);

  const row = (await pool.query('SELECT * FROM zz_enc WHERE id=$1', [ins.rows[0].id])).rows[0];
  assert.equal(keyIdOf(row.phone_enc), 'k2'); assert.equal(decrypt(row.phone_enc, 'zz_enc.phone'), '+91 98100 00001');
  assert.equal(keyIdOf(row.thing_enc), 'k2'); assert.equal(decrypt(row.thing_enc, 'race.reason'), 'odd context', 'found through the context pool');
  assert.equal(row.mystery_enc, mystery, 'an unmappable value is left exactly as it was');
  assert.equal(done.report['zz_enc.mystery_enc'].unmapped, 1);
  assert.equal(done.report['zz_locked.note_enc'].blocked.startsWith('23514'), true, 'append-only table is reported, never bypassed');
  assert.equal((await pool.query('SELECT note_enc FROM zz_locked WHERE id=$1', [locked.rows[0].id])).rows[0].note_enc, locked.rows[0].note_enc);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, usersBefore, 'no rows lost');
  const u = (await pool.query('SELECT email_enc FROM users WHERE id=$1', [plain.id])).rows[0];
  assert.equal(keyIdOf(u.email_enc), 'k2');
  assert.equal((await api('POST', '/auth/login', { body: { email: 'plain-keys@example.com', password: 'correct-horse-battery' } })).status, 200, 'sign-in still works (blind index stays on k1)');

  // idempotent: a second run has nothing left to re-encrypt in mapped columns
  const again = await startRotation(admin.id, { wait: true });
  const rep = (await pool.query('SELECT report FROM key_rotation_runs WHERE id=$1', [again.id])).rows[0].report;
  assert.equal(rep['zz_enc.phone_enc'].reencrypted, 0);
  assert.equal(rep['users.email_enc'].reencrypted, 0);
  config.activeKeyId = 'k1';
});

test('a run resumes from its cursor after an interruption', async () => {
  config.activeKeyId = 'k1';
  await pool.query('CREATE TABLE zz_many (id bigserial PRIMARY KEY, v_enc text)');
  for (let i = 0; i < 450; i++) await pool.query('INSERT INTO zz_many(v_enc) VALUES ($1)', [encrypt(`n${i}`, 'zz_many.v')]);
  config.activeKeyId = 'k2';
  const first = (await pool.query("INSERT INTO key_rotation_runs(target_key, cursors) VALUES ('k2', $1) RETURNING id", [{ 'zz_many.v_enc': JSON.stringify(['200']) }])).rows[0];
  await startRotation(admin.id, { wait: true });   // finds the open run for k2 and continues it
  const run = (await pool.query('SELECT * FROM key_rotation_runs WHERE id=$1', [first.id])).rows[0];
  assert.equal(run.status, 'done');
  assert.equal(run.report['zz_many.v_enc'].reencrypted, 250, 'rows 1-200 were already behind the cursor');
  const left = (await pool.query("SELECT count(*)::int AS n FROM zz_many WHERE v_enc LIKE 'v1.%'")).rows[0].n;
  assert.equal(left, 200, 'those rows are untouched until the next full run, never lost');
  config.activeKeyId = 'k1';
});

test('platform admin only: status, start and run are closed to everyone else; reads are audit-logged; counts only', async () => {
  for (const t of [plain.token, undefined]) {
    assert.ok([401, 403].includes((await api('GET', '/platform/security/keys', { token: t })).status));
    assert.ok([401, 403].includes((await api('POST', '/platform/security/keys/rotations', { token: t })).status));
  }
  config.activeKeyId = 'k2';
  const s = await api('GET', '/platform/security/keys', { token: admin.token });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.active_key, 'k2');
  assert.ok(s.body.keys.find((k) => k.key_id === 'k1').values > 0);
  assert.equal(s.body.keys.find((k) => k.key_id === 'k1').retirable, false, 'k1 still protects values (the unmappable one)');
  for (const leaked of ['+91 98100', 'frozen', 'who knows', 'odd context']) assert.ok(!JSON.stringify(s.body).includes(leaked), 'no stored values in the response');
  const start = await api('POST', '/platform/security/keys/rotations', { token: admin.token });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const run = await api('GET', `/platform/security/keys/rotations/${start.body.id}`, { token: admin.token });
  assert.equal(run.status, 200);
  assert.equal((await api('GET', `/platform/security/keys/rotations/${start.body.id}`, { token: plain.token })).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='start_key_rotation' AND actor_id=$1", [admin.id])).rowCount >= 1);
  for (let i = 0; i < 240; i++) {   // the run continues in the background: wait for it before the pool closes
    if ((await api('GET', `/platform/security/keys/rotations/${start.body.id}`, { token: admin.token })).body.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal((await api('GET', `/platform/security/keys/rotations/${start.body.id}`, { token: admin.token })).body.status, 'done');
  config.activeKeyId = 'k1';
});
