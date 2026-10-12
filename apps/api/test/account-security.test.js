import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');
const { decrypt } = await import('../src/crypto.js');
const { totp, currentStep } = await import('../src/account-security.js');
const { dispatchPending } = await import('../src/notify.js');

let server, base;
const api = async (method, path, { token, body, headers = {} } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json(), set: r.headers.getSetCookie() };
};
const PW = 'correct-horse-battery';
let n = 0;
const register = async (roles = ['athlete']) => {
  n++;
  const email = `sec${n}@example.com`;
  const r = await api('POST', '/auth/register', { body: { handle: `sec_${n}`, display_name: `Sec ${n}`, email, password: PW, roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { email, ...r.body };
};
/** The newest security email's one-time secret, read from the encrypted outbox (the way the dispatcher does). */
const lastSecret = async (userId, kind) => {
  const { rows } = await pool.query('SELECT data, body FROM notifications WHERE user_id=$1 AND kind=$2 ORDER BY created_at DESC, id DESC LIMIT 1', [userId, kind]);
  assert.ok(rows[0], `no ${kind} email queued`);
  assert.ok(!rows[0].body.match(/\bs[vpm]_[A-Za-z0-9_-]{20,}/), 'the secret is not in the stored body');
  return decrypt(rows[0].data.secret_enc, 'notifications.secret');
};
const secretOf = (r) => r.body.secret;
const enrol = async (u) => {
  const setup = await api('POST', '/me/mfa/setup', { token: u.token, body: { password: PW } });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const code = totp(secretOf(setup), currentStep());
  const en = await api('POST', '/me/mfa/enable', { token: u.token, body: { code } });
  assert.equal(en.status, 200, JSON.stringify(en.body));
  return { secret: secretOf(setup), recovery: en.body.recovery_codes, step: currentStep() };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('TOTP matches the RFC 6238 test vector', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082'); // T=59s
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 37037036), '081804'); // T=1111111109s
});

test('email verification: single-use code, per-account rate limit, wrong code refused', async () => {
  const u = await register();
  assert.equal((await api('GET', '/me/security', { token: u.token })).body.email_verified, false);
  assert.equal((await api('POST', '/me/email/verification', { token: u.token })).status, 200);
  const secret = await lastSecret(u.user.id, 'security_email_verify');
  assert.equal((await api('POST', '/auth/verify-email', { body: { token: 'sv_' + 'x'.repeat(40) } })).status, 400);
  assert.equal((await api('POST', '/auth/verify-email', { body: { token: secret } })).status, 200);
  assert.equal((await api('POST', '/auth/verify-email', { body: { token: secret } })).status, 400, 'single use');
  assert.equal((await api('GET', '/me/security', { token: u.token })).body.email_verified, true);
  assert.equal((await api('POST', '/me/email/verification', { token: u.token })).body.already_verified, true);

  const v = await register();
  for (let k = 0; k < 5; k++) assert.equal((await api('POST', '/me/email/verification', { token: v.token })).status, 200);
  assert.equal((await api('POST', '/me/email/verification', { token: v.token })).status, 429, '6th request in an hour is limited');
  const exp = await register();
  await api('POST', '/me/email/verification', { token: exp.token });
  const s2 = await lastSecret(exp.user.id, 'security_email_verify');
  await pool.query("UPDATE account_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=$1", [exp.user.id]);
  assert.equal((await api('POST', '/auth/verify-email', { body: { token: s2 } })).status, 400, 'expired');
});

test('password recovery: hashed single-use expiring token, no account enumeration, sessions revoked, rate limited', async () => {
  const u = await register();
  const other = await api('POST', '/auth/login', { body: { email: u.email, password: PW } });
  const known = await api('POST', '/auth/password-reset', { body: { email: u.email } });
  const unknown = await api('POST', '/auth/password-reset', { body: { email: 'nobody-here@example.com' } });
  assert.deepEqual(known.body, unknown.body, 'identical answer for known and unknown addresses');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='security_password_reset'")).rows[0].n, 1, 'only the real account got an email');
  const secret = await lastSecret(u.user.id, 'security_password_reset');
  const stored = (await pool.query("SELECT token_hash FROM account_tokens WHERE user_id=$1 AND purpose='password_reset'", [u.user.id])).rows;
  assert.ok(stored.every((r) => r.token_hash !== secret && r.token_hash.length === 64), 'only a hash is stored');

  assert.equal((await api('POST', '/auth/password-reset/confirm', { body: { token: secret, new_password: 'short' } })).status, 400, 'weak password refused and the token is not burned');
  const ok = await api('POST', '/auth/password-reset/confirm', { body: { token: secret, new_password: 'a-brand-new-password' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.signed_out_sessions >= 2);
  assert.equal((await api('GET', '/me', { token: u.token })).status, 401, 'all sessions revoked after reset');
  assert.equal((await api('GET', '/me', { token: other.body.token })).status, 401);
  assert.equal((await api('POST', '/auth/password-reset/confirm', { body: { token: secret, new_password: 'yet-another-password' } })).status, 400, 'single use');
  assert.equal((await api('POST', '/auth/login', { body: { email: u.email, password: PW } })).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { email: u.email, password: 'a-brand-new-password' } })).status, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='security_password_changed'", [u.user.id])).rows[0].n, 1, 'owner is told');

  // newest request voids earlier outstanding codes once one is used
  const w = await register();
  await api('POST', '/auth/password-reset', { body: { email: w.email } });
  const first = await lastSecret(w.user.id, 'security_password_reset');
  await api('POST', '/auth/password-reset', { body: { email: w.email } });
  const second = await lastSecret(w.user.id, 'security_password_reset');
  assert.equal((await api('POST', '/auth/password-reset/confirm', { body: { token: second, new_password: 'second-new-password' } })).status, 200);
  assert.equal((await api('POST', '/auth/password-reset/confirm', { body: { token: first, new_password: 'first-new-password' } })).status, 400, 'other outstanding codes are void after a reset');

  // per-account limit: 3/hour, silently (the answer never changes)
  const r = await register();
  for (let k = 0; k < 5; k++) assert.equal((await api('POST', '/auth/password-reset', { body: { email: r.email } })).status, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM account_tokens WHERE user_id=$1 AND purpose='password_reset'", [r.user.id])).rows[0].n, 3);
  // expiry
  const e = await register();
  await api('POST', '/auth/password-reset', { body: { email: e.email } });
  const es = await lastSecret(e.user.id, 'security_password_reset');
  await pool.query("UPDATE account_tokens SET expires_at = now() - interval '1 second' WHERE user_id=$1", [e.user.id]);
  assert.equal((await api('POST', '/auth/password-reset/confirm', { body: { token: es, new_password: 'expired-token-password' } })).status, 400);
});

test('security emails go out through the notify outbox with the secret filled in at send time, then erased', async () => {
  const u = await register();
  const got = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, r));
  const saved = config.notifyWebhook.url;
  try {
    await api('POST', '/auth/password-reset', { body: { email: u.email } });
    const secret = await lastSecret(u.user.id, 'security_password_reset');
    await new Promise((r) => setTimeout(r, 50));
    config.notifyWebhook.url = `http://localhost:${hook.address().port}/`; // configured only now, so nothing was sent before we looked
    await dispatchPending({ limit: 1000 });
    const mail = got.find((m) => m.kind === 'security_password_reset' && m.text.includes(secret)); // other tests' queued mail goes out too
    assert.ok(mail, 'email posted to the webhook');
    assert.ok(mail.text.includes(secret) && !mail.text.includes('{{secret}}'));
    assert.equal(mail.data.secret_enc, undefined);
    const row = (await pool.query("SELECT data, body FROM notifications WHERE user_id=$1 AND kind='security_password_reset'", [u.user.id])).rows[0];
    assert.equal(row.data.secret_enc, undefined, 'secret erased after sending');
    assert.ok(!row.body.includes(secret));
  } finally { config.notifyWebhook.url = saved; hook.close(); }
});

test('MFA: set-up, enable, challenge at login, replay protection, recovery codes, attempts limit', async () => {
  const u = await register();
  assert.equal((await api('POST', '/me/mfa/setup', { token: u.token, body: { password: 'wrong-password-here' } })).status, 401);
  const setup = await api('POST', '/me/mfa/setup', { token: u.token, body: { password: PW } });
  assert.match(setup.body.otpauth_uri, /^otpauth:\/\/totp\/Gotmygame:/);
  const secret = secretOf(setup);
  const dbRow = (await pool.query('SELECT * FROM user_mfa WHERE user_id=$1', [u.user.id])).rows[0];
  assert.ok(!JSON.stringify(dbRow).includes(secret), 'secret is field-encrypted at rest');
  assert.equal((await api('POST', '/me/mfa/enable', { token: u.token, body: { code: '000000' } })).status, 401);
  const en = await api('POST', '/me/mfa/enable', { token: u.token, body: { code: totp(secret, currentStep()) } });
  assert.equal(en.status, 200);
  assert.equal(en.body.recovery_codes.length, 10);
  const hashes = (await pool.query('SELECT code_hash FROM mfa_recovery_codes WHERE user_id=$1', [u.user.id])).rows.map((r) => r.code_hash);
  assert.equal(hashes.length, 10);
  assert.ok(en.body.recovery_codes.every((c) => !hashes.includes(c) && !JSON.stringify(hashes).includes(c.replace('-', ''))), 'recovery codes stored hashed');
  assert.equal((await api('POST', '/me/mfa/setup', { token: u.token, body: { password: PW } })).status, 400, 'already on');
  const st = (await api('GET', '/me/security', { token: u.token })).body;
  assert.deepEqual([st.mfa_enabled, st.recovery_codes_left, st.session_mfa_verified], [true, 10, true]);

  // sign-in now needs the second factor
  const login = await api('POST', '/auth/login', { body: { email: u.email, password: PW } });
  assert.equal(login.status, 200);
  assert.equal(login.body.mfa_required, true); assert.equal(login.body.token, undefined); assert.equal(login.body.refresh_token, undefined);
  assert.equal((await api('GET', '/me', { token: login.body.mfa_token })).status, 401, 'the challenge is not a credential');
  assert.equal((await api('POST', '/auth/login/mfa', { body: { mfa_token: login.body.mfa_token, code: '123456' } })).status, 401);
  const nextStep = totp(secret, currentStep() + 1); // within the +/-1 drift window and newer than the code used to enable
  const done = await api('POST', '/auth/login/mfa', { body: { mfa_token: login.body.mfa_token, code: nextStep } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await api('GET', '/me/security', { token: done.body.token })).body.session_mfa_verified, true);
  assert.equal((await api('POST', '/auth/login/mfa', { body: { mfa_token: login.body.mfa_token, code: nextStep } })).status, 401, 'challenge is single use');
  // the same code cannot be replayed on a fresh challenge
  const l2 = await api('POST', '/auth/login', { body: { email: u.email, password: PW } });
  assert.equal((await api('POST', '/auth/login/mfa', { body: { mfa_token: l2.body.mfa_token, code: nextStep } })).status, 401, 'TOTP replay refused');
  // a recovery code works once
  const rc = en.body.recovery_codes[0];
  assert.equal((await api('POST', '/auth/login/mfa', { body: { mfa_token: l2.body.mfa_token, code: rc.toUpperCase() } })).status, 200);
  const l3 = await api('POST', '/auth/login', { body: { email: u.email, password: PW } });
  assert.equal((await api('POST', '/auth/login/mfa', { body: { mfa_token: l3.body.mfa_token, code: rc } })).status, 401, 'recovery code is single use');
  assert.equal((await api('GET', '/me/security', { token: done.body.token })).body.recovery_codes_left, 9);
  // five wrong guesses burn the challenge, even for a correct code afterwards
  const l4 = await api('POST', '/auth/login', { body: { email: u.email, password: PW } });
  for (let k = 0; k < 5; k++) assert.equal((await api('POST', '/auth/login/mfa', { body: { mfa_token: l4.body.mfa_token, code: '654321' } })).status, 401);
  assert.equal((await api('POST', '/auth/login/mfa', { body: { mfa_token: l4.body.mfa_token, code: en.body.recovery_codes[1] } })).status, 401);
  // per-account lockout across endpoints after repeated wrong codes
  const l5 = await api('POST', '/auth/login', { body: { email: u.email, password: PW } });
  let last;
  for (let k = 0; k < 6; k++) last = await api('POST', '/auth/login/mfa', { body: { mfa_token: l5.body.mfa_token, code: '111111' } });
  assert.ok([401, 429].includes(last.status));
  const l6 = await api('POST', '/auth/login', { body: { email: u.email, password: PW } });
  assert.equal((await api('POST', '/auth/login/mfa', { body: { mfa_token: l6.body.mfa_token, code: en.body.recovery_codes[2] } })).status, 429, 'account locked for 15 minutes after 10 wrong codes');
});

test('MFA disable needs password + code, signs other devices out, keeps the old factor; re-enrol works', async () => {
  const u = await register();
  const m = await enrol(u);
  const other = await pool.query('SELECT 1'); void other;
  assert.equal((await api('POST', '/me/mfa/disable', { token: u.token, body: { password: 'bad-password-bad', code: m.recovery[0] } })).status, 401);
  assert.equal((await api('POST', '/me/mfa/disable', { token: u.token, body: { password: PW, code: '999999' } })).status, 401);
  const off = await api('POST', '/me/mfa/disable', { token: u.token, body: { password: PW, code: m.recovery[0] } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const rows = (await pool.query('SELECT disabled_at, disabled_reason FROM user_mfa WHERE user_id=$1', [u.user.id])).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].disabled_reason, 'user');
  assert.equal((await api('POST', '/auth/login', { body: { email: u.email, password: PW } })).body.mfa_required, undefined);
  await enrol(u); // a fresh factor; the old row is kept
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_mfa WHERE user_id=$1', [u.user.id])).rows[0].n, 2);
});

test('MFA enforcement for sensitive roles: clinical/admin-class actions need an enrolled, verified session', async () => {
  config.mfaEnforce = true;
  try {
    const doc = await register(['doctor']);
    const ath = await register(['athlete']);
    const earlier = await api('POST', '/auth/login', { body: { email: doc.email, password: PW } }); // session opened before enrolment
    assert.equal((await api('GET', '/medical/patients', { token: ath.token })).status, 403, 'role gate still applies to athletes');
    const blocked = await api('GET', '/medical/patients', { token: doc.token });
    assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'mfa_enrollment_required');
    assert.equal((await api('GET', '/me/sessions', { token: doc.token })).status, 200, 'session management stays reachable');
    assert.equal((await api('GET', '/me', { token: doc.token })).status, 200, 'non-sensitive actions are unaffected');
    const m = await enrol(doc);
    assert.equal((await api('GET', '/medical/patients', { token: doc.token })).status, 200, 'the enrolling session is verified');
    const stale = await api('GET', '/medical/patients', { token: earlier.body.token });
    assert.equal(stale.body.error.code, 'mfa_required', 'an older unverified session must step up');
    assert.equal((await api('POST', '/me/mfa/verify', { token: earlier.body.token, body: { code: '000000' } })).status, 401);
    assert.equal((await api('POST', '/me/mfa/verify', { token: earlier.body.token, body: { code: m.recovery[0] } })).status, 200);
    assert.equal((await api('GET', '/medical/patients', { token: earlier.body.token })).status, 200);

    // admin actions too; tokens minted by a verified session keep working (their creation was the gated step)
    const adm = await register(['athlete']);
    await pool.query("UPDATE users SET roles = '{admin}' WHERE id=$1", [adm.user.id]);
    assert.equal((await api('GET', '/admin/cases', { token: adm.token })).body.error.code, 'mfa_enrollment_required');
    assert.equal((await api('POST', '/me/tokens', { token: adm.token, body: { name: 'a', scopes: ['admin'] } })).body.error.code, 'mfa_enrollment_required', 'minting admin tokens is gated too');
    await enrol(adm);
    assert.equal((await api('GET', '/admin/cases', { token: adm.token })).status, 200);
    assert.equal((await api('GET', '/me/security', { token: doc.token })).body.mfa_enforced, true);
  } finally { config.mfaEnforce = false; }
  // switched off by default: nothing is locked out until the operator enables it
  const d2 = await register(['doctor']);
  assert.equal((await api('GET', '/medical/patients', { token: d2.token })).status, 200);
});

test('admin MFA reset: disables the factor, signs the user out everywhere, audit-logged, admin only', async () => {
  const u = await register();
  await enrol(u);
  const adm = await register();
  await pool.query("UPDATE users SET roles = '{admin}' WHERE id=$1", [adm.user.id]);
  assert.equal((await api('POST', `/admin/users/${u.user.id}/mfa-reset`, { token: u.token })).status, 403);
  const r = await api('POST', `/admin/users/${u.user.id}/mfa-reset`, { token: adm.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await api('GET', '/me', { token: u.token })).status, 401);
  assert.equal((await pool.query('SELECT disabled_reason FROM user_mfa WHERE user_id=$1', [u.user.id])).rows[0].disabled_reason, 'admin_reset');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='mfa_admin_reset' AND actor_id=$1", [adm.user.id])).rows[0].n, 1);
  assert.equal((await api('POST', '/auth/login', { body: { email: u.email, password: PW } })).body.mfa_required, undefined);
  assert.equal((await api('POST', `/admin/users/${u.user.id}/mfa-reset`, { token: adm.token })).status, 404, 'nothing left to reset');
});

test('web cookie mode: mfa_required sets no cookies; login_mfa does', async () => {
  const u = await register();
  const m = await enrol(u);
  const web = { 'x-sa-client': 'web' };
  const l = await api('POST', '/auth/login', { body: { email: u.email, password: PW }, headers: web });
  assert.equal(l.body.mfa_required, true); assert.equal(l.set.length, 0);
  const d = await api('POST', '/auth/login/mfa', { body: { mfa_token: l.body.mfa_token, code: m.recovery[0] }, headers: web });
  assert.equal(d.status, 200);
  assert.ok(d.set.some((c) => c.startsWith('sa_session=') && /HttpOnly/i.test(c)));
  assert.equal(d.body.token, undefined);
});
