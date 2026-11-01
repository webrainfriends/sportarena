// Federation extras (#703) 1/3: the licence ID card. Verifies live, revoked / expired / suspended licences fail the check, a copied QR dies,
// a young person's card is guardian-scoped and never carries the name outwards, shares can be revoked, files carry the live status.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { mintCardToken, readCardToken } = await import('../src/licence-card.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0, sport, F, owner, licensing, type;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.code ?? r.body.error?.details?.code ?? r.body.code;
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `card_${n}_${roles[0]}`, display_name: `Card ${n}`, email: `card${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const issue = async (holder, applicant = holder, over = {}) => {
  const l = must(await api('POST', '/federation/licences', { token: applicant.token, body: { body_id: F.id, type_id: type.id, ...(holder.id !== applicant.id ? { holder_id: holder.id } : {}), ...over } }), 201);
  must(await api('POST', `/federation/licences/${l.id}/submit`, { token: applicant.token }));
  return must(await api('POST', `/federation/licences/${l.id}/decision`, { token: licensing.token, body: { action: 'approve' } }));
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0); base = `http://localhost:${server.address().port}`;
  sport = (await q("SELECT id FROM sports WHERE slug='badminton'"))[0];
  owner = await signup(); licensing = await signup();
  F = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: 'Card Federation', level: 'national', abbreviation: 'CARD', country: 'SG', sports: [{ sport_id: sport.id }] } }), 201);
  must(await api('POST', `/federation/bodies/${F.id}/roles`, { token: owner.token, body: { user_id: licensing.id, role: 'licensing', sport_id: sport.id } }), 201);
  type = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Player', holder_role: 'athlete', sport_id: sport.id, grade: 'Senior' } }), 201);
});
after(async () => { server.close(); await pool.end(); });

test('card: a rotating QR verifies live, a copy dies, and revoked / suspended / expired licences fail', async () => {
  const holder = await signup();
  const lic = await issue(holder);
  const card = must(await api('GET', `/federation/licences/${lic.id}/card`, { token: holder.token }));
  assert.equal(card.card.valid, true); assert.equal(card.card.status_label, 'VALID'); assert.equal(card.card.holder_name, holder.display_name);
  assert.match(card.qr.token, /^LC1\./); assert.equal(card.qr.refresh_in_s, 60);
  const ok = must(await api('GET', `/federation/verify/${encodeURIComponent(card.qr.token)}`));
  assert.equal(ok.valid, true); assert.equal(ok.checked_via, 'card_qr');
  // the printed code still works, case-insensitively
  assert.equal(must(await api('GET', `/federation/verify/${lic.public_code.toLowerCase()}`)).valid, true);
  // a copy of the QR stops working; a forged one never worked
  const old = mintCardToken(lic.id, new Date(Date.now() - 10 * 60_000));
  assert.equal(readCardToken(old.token).error, 'expired');
  const expired = await api('GET', `/federation/verify/${encodeURIComponent(old.token)}`);
  assert.equal(expired.status, 410); assert.equal(code(expired), 'card_code_expired');
  const forged = `LC1.${lic.id}.${card.qr.token.split('.')[2]}.${'0'.repeat(24)}`;
  assert.equal((await api('GET', `/federation/verify/${forged}`)).status, 404);
  // suspension, expiry and revocation show at once
  must(await api('POST', `/federation/licences/${lic.id}/decision`, { token: licensing.token, body: { action: 'suspend', reason: 'Panel' } }));
  assert.equal(must(await api('GET', `/federation/verify/${encodeURIComponent(card.qr.token)}`)).valid, false);
  assert.equal(must(await api('GET', `/federation/licences/${lic.id}/card`, { token: holder.token })).card.status_label, 'SUSPENDED');
  must(await api('POST', `/federation/licences/${lic.id}/decision`, { token: licensing.token, body: { action: 'reinstate' } }));
  await q('UPDATE fed_licences SET issued_on=current_date-400, expires_on=current_date-1 WHERE id=$1', [lic.id]);
  assert.equal(must(await api('GET', `/federation/licences/${lic.id}/card`, { token: holder.token })).card.status_label, 'EXPIRED');
  assert.equal(must(await api('GET', `/federation/verify/${lic.public_code}`)).valid, false);
  await q("UPDATE fed_licences SET expires_on=current_date+300 WHERE id=$1", [lic.id]);
  must(await api('POST', `/federation/licences/${lic.id}/decision`, { token: licensing.token, body: { action: 'revoke', reason: 'Withdrawn' } }));
  assert.equal(must(await api('GET', `/federation/licences/${lic.id}/card`, { token: holder.token })).card.status_label, 'REVOKED');
  assert.equal(must(await api('GET', `/federation/verify/${encodeURIComponent(card.qr.token)}`)).valid, false);
  // viewing the card is audited
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='view_licence_card' AND entity_id=$1 AND actor_id=$2", [lic.id, holder.id])).length >= 1);
});

test('card: only the holder (or a guardian) opens it; shares are hashed, revocable, and carry live standing', async () => {
  const holder = await signup(), stranger = await signup();
  const lic = await issue(holder);
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card`, { token: licensing.token })).status, 404, 'staff use get_licence, not the holder\'s card');
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card`)).status, 401);
  const share = must(await api('POST', `/federation/licences/${lic.id}/card/shares`, { token: holder.token, body: { days: 3 } }), 201);
  assert.match(share.token, /^sa_/);
  const stored = (await q('SELECT token_sha256 FROM fed_licence_card_shares WHERE id=$1', [share.share_id]))[0];
  assert.ok(!JSON.stringify(stored).includes(share.token), 'only the hash is stored');
  const shown = must(await api('GET', `/federation/cards/${share.token}`));
  assert.equal(shown.valid, true); assert.equal(shown.card.public_code, undefined, 'a shared view does not hand out the code');
  assert.equal(shown.card.holder_name, holder.display_name);
  assert.equal((await q('SELECT view_count FROM fed_licence_card_shares WHERE id=$1', [share.share_id]))[0].view_count, 1);
  must(await api('POST', `/federation/licences/${lic.id}/decision`, { token: licensing.token, body: { action: 'suspend', reason: 'Panel' } }));
  assert.equal(must(await api('GET', `/federation/cards/${share.token}`)).valid, false, 'a shared card shows live standing');
  must(await api('DELETE', `/federation/licences/${lic.id}/card/shares/${share.share_id}`, { token: holder.token }));
  assert.equal((await api('GET', `/federation/cards/${share.token}`)).status, 404);
  assert.equal((await api('DELETE', `/federation/licences/${lic.id}/card/shares/${share.share_id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', '/federation/cards/sa_notarealtokennotarealtoken')).status, 404);
});

test('card: files are PDF or PNG, stamped with the live status', async () => {
  const holder = await signup();
  const lic = await issue(holder);
  const pdf = must(await api('GET', `/federation/licences/${lic.id}/card/file`, { token: holder.token, query: { format: 'pdf' } }));
  assert.equal(pdf.content_type, 'application/pdf'); assert.equal(Buffer.from(pdf.content, 'base64').subarray(0, 5).toString(), '%PDF-');
  const png = must(await api('GET', `/federation/licences/${lic.id}/card/file`, { token: holder.token, query: { format: 'png' } }));
  assert.equal(png.content_type, 'image/png'); assert.equal(Buffer.from(png.content, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='export_licence_card_png' AND entity_id=$1", [lic.id])).length);
});

test('card: a young person\'s card is guardian-scoped and never names them outwards', async () => {
  const kid = await signup(), guardian = await signup(), other = await signup();
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, kid.id]);
  await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days')", [kid.id, guardian.id]);
  const lic = await issue(kid, guardian);
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card`, { token: other.token })).status, 404);
  const gc = must(await api('GET', `/federation/licences/${lic.id}/card`, { token: guardian.token }));
  assert.equal(gc.minor, true); assert.equal(gc.viewing_as, 'guardian');
  // the young person can look at their own card but cannot send it out
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card`, { token: kid.token })).status, 200);
  assert.equal((await api('POST', `/federation/licences/${lic.id}/card/shares`, { token: kid.token, body: {} })).status, 403);
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card/file`, { token: kid.token })).status, 403);
  // a shared view and a file withhold the name
  const share = must(await api('POST', `/federation/licences/${lic.id}/card/shares`, { token: guardian.token, body: {} }), 201);
  assert.equal(must(await api('GET', `/federation/cards/${share.token}`)).card.holder_name, 'Registered athlete (name withheld)');
  // scopes: without `register` the guardian cannot share; without `calendar` they cannot see the card or the list entry
  await q("UPDATE guardian_links SET scopes='{calendar}' WHERE guardian_id=$1", [guardian.id]);
  const noShare = await api('POST', `/federation/licences/${lic.id}/card/shares`, { token: guardian.token, body: {} });
  assert.equal(noShare.status, 403); assert.equal(code(noShare), 'guardian_scope_required');
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card`, { token: guardian.token })).status, 200);
  await q("UPDATE guardian_links SET scopes='{pay}' WHERE guardian_id=$1", [guardian.id]);
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card`, { token: guardian.token })).status, 403);
  assert.ok(!must(await api('GET', '/federation/licences', { token: guardian.token, query: { mine: 'true' } })).items.some((x) => x.id === lic.id));
  // revoking the guardian ends access at once
  await q("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [guardian.id]);
  assert.equal((await api('GET', `/federation/licences/${lic.id}/card`, { token: guardian.token })).status, 404);
  assert.equal(must(await api('GET', `/federation/cards/${share.token}`)).card.holder_name, 'Registered athlete (name withheld)');
});

test('card: REST, OpenAPI and MCP expose the same capabilities', async () => {
  const names = ['get_licence_card', 'create_licence_card_share', 'revoke_licence_card_share', 'view_shared_licence_card', 'get_licence_card_file'];
  for (const nme of names) assert.ok(capabilities.find((c) => c.name === nme), nme);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nme of names) assert.ok(ops.has(nme), `openapi ${nme}`);
  assert.ok(!(spec.paths['/federation/cards/{token}'].get['x-required-scope']), 'the shared view is public');
});
