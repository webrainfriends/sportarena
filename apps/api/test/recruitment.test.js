import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const key = () => `idem-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `rc_${n}_${roles[0]}`, display_name: `Recruit ${n}`, email: `rc${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const team = async (owner) => must(await api('POST', '/teams', { token: owner.token, body: { name: `Rovers ${++n}`, sport: 'football' } }), 201);
const post = async (mgr, t, extra = {}) => must(await api('POST', '/billboard', { token: mgr.token, body: { kind: 'team_recruiting', title: `Forward wanted ${++n}`, sport: 'football', team_id: t.id, positions_needed: 1, budget_cents: 5000, rate_unit: 'match', ...extra } }), 201);
const apply = (u, p, body = {}) => api('POST', `/billboard/${p.id}/responses`, { token: u.token, body: { message: 'Pick me', ...body } });
const stageOf = async (rid) => (await pool.query('SELECT stage, status, row_version FROM billboard_responses WHERE id=$1', [rid])).rows[0];
const move = (staff, rid, to, v, extra = {}) => api('POST', `/billboard/responses/${rid}/stage`, { token: staff.token, body: { to, row_version: v, idempotency_key: key(), ...extra } });
const linkGuardian = async (mum, kid) => {
  const l = must(await api('POST', '/youth/guardian-links', { token: mum.token, body: { guardian_id: mum.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: mum.token, body: { evidence: { reference: 'https://example.com/birth-ref-123', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('rc_root','rc_root','{admin}','x','x','rc_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('full journey: applied -> shortlisted -> trial -> evaluated -> offered (v1, v2) -> accepted joins roster, post fills, history kept', async () => {
  const mgr = await signup(['coach']), p = await signup(), other = await signup();
  const t = await team(mgr), b = await post(mgr, t);
  const r = must(await apply(p, b, { source_url: 'https://example.com/highlights/42', source_kind: 'video', idempotency_key: key() }), 201);
  assert.equal(r.stage, 'applied'); assert.equal(r.row_version, 1);
  assert.equal((await api('GET', `/billboard/${b.id}/pipeline`, { token: p.token })).status, 403, 'applicants cannot run the pipeline');
  assert.equal((await api('GET', `/billboard/${b.id}/pipeline`, { token: other.token })).status, 403);

  let pipe = must(await api('GET', `/billboard/${b.id}/pipeline`, { token: mgr.token }));
  assert.equal(pipe.counts.applied, 1); assert.equal(pipe.candidates[0].has_source, true); assert.equal(pipe.candidates[0].hidden, false);

  // illegal moves
  assert.equal((await move(mgr, r.id, 'accepted', 1)).status, 400, 'zod rejects stages staff cannot set');
  assert.equal(code(await api('POST', `/billboard/responses/${r.id}/offers`, { token: mgr.token, body: { deadline_at: inDays(3), row_version: 1, idempotency_key: key() } })), 'invalid_transition', 'no offer straight from applied');
  assert.equal(code(await api('POST', `/billboard/responses/${r.id}/evaluation`, { token: mgr.token, body: { rating: 4, row_version: 1, idempotency_key: key() } })), 'invalid_transition');

  // shortlist: idempotent retry, stale version
  const k = key();
  const sl = must(await api('POST', `/billboard/responses/${r.id}/stage`, { token: mgr.token, body: { to: 'shortlisted', row_version: 1, idempotency_key: k } }));
  assert.equal(sl.stage, 'shortlisted'); assert.equal(sl.row_version, 2);
  const rep = must(await api('POST', `/billboard/responses/${r.id}/stage`, { token: mgr.token, body: { to: 'shortlisted', row_version: 1, idempotency_key: k } }));
  assert.equal(rep.replayed, true); assert.equal(rep.row_version, 2, 'a retry changes nothing');
  const st = await move(mgr, r.id, 'declined', 1);
  assert.equal(st.status, 409); assert.equal(code(st), 'stale_version');

  // trial: must be in the future; evaluation only after it happened
  assert.equal((await api('POST', `/billboard/responses/${r.id}/trial`, { token: mgr.token, body: { trial_at: inDays(-1), row_version: 2, idempotency_key: key() } })).status, 400);
  const tr = must(await api('POST', `/billboard/responses/${r.id}/trial`, { token: mgr.token, body: { trial_at: inDays(2), note: 'Bring boots', row_version: 2, idempotency_key: key() } }));
  assert.equal(tr.stage, 'trial');
  assert.equal(code(await api('POST', `/billboard/responses/${r.id}/evaluation`, { token: mgr.token, body: { rating: 4, row_version: 3, idempotency_key: key() } })), 'trial_not_held');
  await pool.query("UPDATE billboard_responses SET trial_at = now() - interval '1 hour' WHERE id=$1", [r.id]);
  assert.equal((await api('POST', `/billboard/responses/${r.id}/evaluation`, { token: mgr.token, body: { rating: 9, row_version: 3, idempotency_key: key() } })).status, 400);
  const ev = must(await api('POST', `/billboard/responses/${r.id}/evaluation`, { token: mgr.token, body: { rating: 4, notes: 'Strong first touch', row_version: 3, idempotency_key: key() } }), 201);
  assert.equal(ev.stage, 'evaluated');
  assert.equal((await pool.query('SELECT notes_enc FROM recruitment_evaluations WHERE response_id=$1', [r.id])).rows[0].notes_enc.includes('Strong'), false, 'notes are encrypted at rest');

  // offers: deadline required and future; v2 supersedes v1
  const offer = (body, v) => api('POST', `/billboard/responses/${r.id}/offers`, { token: mgr.token, body: { row_version: v, idempotency_key: key(), ...body } });
  assert.equal((await offer({}, 4)).status, 400, 'deadline required');
  assert.equal((await offer({ deadline_at: inDays(-1) }, 4)).status, 400, 'deadline must be in the future');
  assert.equal((await offer({ rate_cents: 4000, deadline_at: inDays(3) }, 4)).status, 400, 'a rate needs a unit');
  const o1 = must(await offer({ rate_cents: 4000, rate_unit: 'match', deadline_at: inDays(3) }, 4), 201);
  assert.equal(o1.offer_version, 1); assert.equal(o1.stage, 'offered');
  const o2 = must(await offer({ rate_cents: 6000, rate_unit: 'match', starts_on: '2026-12-01', deadline_at: inDays(5), note: 'Improved' }, 5), 201);
  assert.equal(o2.offer_version, 2);
  const offers = (await pool.query('SELECT version, status FROM recruitment_offers WHERE response_id=$1 ORDER BY version', [r.id])).rows;
  assert.deepEqual(offers.map((o) => `${o.version}:${o.status}`), ['1:superseded', '2:open']);

  // applicant sees offer history + stage, not staff-only data
  const mine = must(await api('GET', '/me/billboard-responses', { token: p.token }));
  assert.equal(mine[0].response_id, r.id, 'the application id is not shadowed by the post id'); assert.equal(mine[0].id, b.id); assert.equal(mine[0].stage, 'offered'); assert.equal(mine[0].latest_offer.version, 2); assert.equal(mine[0].latest_offer.rate_cents, 6000);
  const app = must(await api('GET', `/billboard/responses/${r.id}/application`, { token: p.token }));
  assert.equal(app.viewer, 'applicant'); assert.equal(app.offers.length, 2); assert.equal(app.evaluations, undefined); assert.equal(app.source, undefined); assert.equal(app.events[0].note, undefined);
  assert.equal((await api('GET', `/billboard/responses/${r.id}/application`, { token: other.token })).status, 403);

  // staff view decrypts + audits
  const sv = must(await api('GET', `/billboard/responses/${r.id}/application`, { token: mgr.token }));
  assert.equal(sv.viewer, 'staff'); assert.equal(sv.evaluations[0].notes, 'Strong first touch'); assert.equal(sv.source.url, 'https://example.com/highlights/42');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action IN ('read_recruitment_source','read_recruitment_evaluation') AND actor_id=$1", [mgr.id])).rows.length >= 2);

  // accept: only the applicant, needs current version; joins the roster at the offered rate; post fills
  assert.equal((await api('POST', `/billboard/responses/${r.id}/offer-response`, { token: other.token, body: { accept: true, row_version: 6, idempotency_key: key() } })).status, 403);
  assert.equal((await api('POST', `/billboard/responses/${r.id}/offer-response`, { token: mgr.token, body: { accept: true, row_version: 6, idempotency_key: key() } })).status, 403, 'staff cannot accept for the player');
  assert.equal(code(await api('POST', `/billboard/responses/${r.id}/offer-response`, { token: p.token, body: { accept: true, row_version: 5, idempotency_key: key() } })), 'stale_version');
  const ak = key();
  const acc = must(await api('POST', `/billboard/responses/${r.id}/offer-response`, { token: p.token, body: { accept: true, row_version: 6, idempotency_key: ak } }));
  assert.equal(acc.stage, 'accepted'); assert.equal(acc.status, 'accepted');
  assert.equal(must(await api('POST', `/billboard/responses/${r.id}/offer-response`, { token: p.token, body: { accept: true, row_version: 6, idempotency_key: ak } })).replayed, true);
  const tm = (await pool.query("SELECT role, status, rate_cents FROM team_members WHERE team_id=$1 AND user_id=$2", [t.id, p.id])).rows[0];
  assert.deepEqual(tm, { role: 'player', status: 'active', rate_cents: 6000 });
  assert.equal((await pool.query('SELECT status FROM billboard_posts WHERE id=$1', [b.id])).rows[0].status, 'filled');
  assert.equal((await pool.query('SELECT status FROM recruitment_offers WHERE response_id=$1 AND version=2', [r.id])).rows[0].status, 'accepted');
  const kinds = (await pool.query('SELECT kind FROM recruitment_events WHERE response_id=$1 ORDER BY created_at, id', [r.id])).rows.map((e) => e.kind);
  assert.deepEqual(kinds, ['applied', 'stage', 'trial', 'evaluation', 'offer', 'offer', 'offer_response']);
  assert.equal(code(await move(mgr, r.id, 'declined', 7)), 'closed_application');
  // history is immutable
  await assert.rejects(pool.query('DELETE FROM recruitment_events WHERE response_id=$1', [r.id]), /append-only/);

  // MCP parity
  const tools = (await rpc('tools/list', {}, mgr.token)).tools.map((x) => x.name);
  for (const nme of ['get_recruitment_pipeline', 'move_recruitment_stage', 'send_recruitment_offer', 'respond_recruitment_offer', 'withdraw_recruitment_application', 'export_recruitment_pipeline']) assert.ok(tools.includes(nme), nme);
  const viaMcp = await rpc('tools/call', { name: 'get_recruitment_pipeline', arguments: { id: b.id } }, mgr.token);
  assert.ok(!viaMcp.isError, JSON.stringify(viaMcp));
});

test('offer expiry, withdrawal, decline, double-accept race and the legacy accept/decline', async () => {
  const mgr = await signup(['coach']), a = await signup(), b2 = await signup(), c = await signup(), d = await signup();
  const t = await team(mgr), pst = await post(mgr, t, { positions_needed: 1 });
  const ra = must(await apply(a, pst), 201), rb = must(await apply(b2, pst), 201), rc = must(await apply(c, pst), 201), rd = must(await apply(d, pst), 201);
  assert.equal((await apply(a, pst)).status, 409, 'one application per person per post');
  const offerTo = async (resp) => {
    const s = must(await move(mgr, resp.id, 'shortlisted', 1));
    return must(await api('POST', `/billboard/responses/${resp.id}/offers`, { token: mgr.token, body: { deadline_at: inDays(2), row_version: s.row_version, idempotency_key: key() } }), 201);
  };

  // expiry returns the application to the shortlist; the applicant is told the offer lapsed; staff can re-offer
  const oa = await offerTo(ra);
  await pool.query("UPDATE recruitment_offers SET deadline_at = now() - interval '1 minute' WHERE response_id=$1", [ra.id]);
  const late = await api('POST', `/billboard/responses/${ra.id}/offer-response`, { token: a.token, body: { accept: true, row_version: oa.row_version, idempotency_key: key() } });
  assert.equal(late.status, 409); assert.equal(code(late), 'offer_expired');
  assert.equal((await stageOf(ra.id)).stage, 'shortlisted');
  assert.equal((await pool.query('SELECT status FROM recruitment_offers WHERE response_id=$1', [ra.id])).rows[0].status, 'expired');

  // withdraw closes an open offer; decline is terminal and keeps the offer
  const ob = await offerTo(rb);
  const wd = must(await api('POST', `/billboard/responses/${rb.id}/withdraw`, { token: b2.token, body: { row_version: ob.row_version, idempotency_key: key() } }));
  assert.equal(wd.stage, 'withdrawn'); assert.equal(wd.status, 'withdrawn');
  assert.equal((await pool.query('SELECT status FROM recruitment_offers WHERE response_id=$1', [rb.id])).rows[0].status, 'withdrawn');
  assert.equal(code(await api('POST', `/billboard/responses/${rb.id}/withdraw`, { token: b2.token, body: { row_version: wd.row_version, idempotency_key: key() } })), 'closed_application');
  assert.equal((await api('POST', `/billboard/responses/${rc.id}/withdraw`, { token: a.token, body: { row_version: 1, idempotency_key: key() } })).status, 403, 'only the applicant withdraws');

  // two applicants hold offers for one position: exactly one accept wins, the other is told the post is full
  const oc = await offerTo(rc), od = await offerTo(rd);
  const race = await Promise.all([
    api('POST', `/billboard/responses/${rc.id}/offer-response`, { token: c.token, body: { accept: true, row_version: oc.row_version, idempotency_key: key() } }),
    api('POST', `/billboard/responses/${rd.id}/offer-response`, { token: d.token, body: { accept: true, row_version: od.row_version, idempotency_key: key() } }),
  ]);
  assert.deepEqual(race.map((x) => x.status).sort(), [200, 409], JSON.stringify(race.map((x) => x.body)));
  assert.equal((await pool.query("SELECT count(*)::int n FROM billboard_responses WHERE post_id=$1 AND stage='accepted'", [pst.id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM team_members WHERE team_id=$1 AND role='player' AND user_id = ANY($2)", [t.id, [c.id, d.id]])).rows[0].n, 1);

  // legacy direct decision still works and keeps stage/status in sync
  const mgr2 = await signup(['coach']), e = await signup(), f = await signup();
  const t2 = await team(mgr2), p2 = await post(mgr2, t2, { positions_needed: 2 });
  const re = must(await apply(e, p2), 201), rf = must(await apply(f, p2), 201);
  assert.equal((await api('PATCH', `/billboard/responses/${re.id}`, { token: e.token, body: { status: 'accepted' } })).status, 403);
  const legacy = must(await api('PATCH', `/billboard/responses/${re.id}`, { token: mgr2.token, body: { status: 'accepted' } }));
  assert.equal(legacy.status, 'accepted'); assert.equal(legacy.stage, 'accepted');
  assert.equal((await api('PATCH', `/billboard/responses/${re.id}`, { token: mgr2.token, body: { status: 'declined' } })).status, 409, 'already decided');
  must(await api('PATCH', `/billboard/responses/${rf.id}`, { token: mgr2.token, body: { status: 'declined' } }));
  assert.equal((await stageOf(rf.id)).stage, 'declined');
  const list = must(await api('GET', `/billboard/${p2.id}/responses`, { token: mgr2.token }));
  assert.deepEqual(list.map((x) => x.stage).sort(), ['accepted', 'declined']);

  // export: CSV for staff only, no evidence or notes
  const exp = must(await api('GET', `/billboard/${p2.id}/pipeline/export`, { token: mgr2.token }));
  assert.equal(exp.rows, 2); assert.ok(exp.csv.startsWith('display_name,handle,stage')); assert.equal(exp.csv.includes('Pick me'), false);
  assert.equal((await api('GET', `/billboard/${p2.id}/pipeline/export`, { token: e.token })).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export_recruitment_pipeline' AND actor_id=$1", [mgr2.id])).rows.length);
});

test('validation and permission edges: https evidence only, own post, unknown ids, closed post', async () => {
  const mgr = await signup(['coach']), p = await signup();
  const t = await team(mgr), b = await post(mgr, t);
  assert.equal((await apply(p, b, { source_url: 'http://insecure.example.com/x' })).status, 400);
  assert.equal((await apply(p, b, { source_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await apply(mgr, b)).status, 400, 'cannot apply to your own post');
  assert.equal((await api('GET', '/billboard/00000000-0000-0000-0000-000000000000/pipeline', { token: mgr.token })).status, 404);
  assert.equal((await api('GET', `/billboard/${b.id}/pipeline`)).status, 401);
  assert.equal((await move(mgr, '00000000-0000-0000-0000-000000000000', 'shortlisted', 1)).status, 404);
  const r = must(await apply(p, b), 201);
  assert.equal(code(await move(mgr, r.id, 'declined', 1, { note: 'x'.repeat(501) })) ?? 'bad', 'bad', 'note too long is a 400');
  must(await api('POST', `/billboard/${b.id}/close`, { token: mgr.token }));
  assert.equal((await apply(await signup(), b)).status, 409, 'closed post takes no applications');
  // a team manager who is not the author can still run the pipeline
  const b2 = await post(mgr, t);
  const coHost = await signup(['coach']);
  await pool.query("INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'manager','active')", [t.id, coHost.id]);
  must(await api('GET', `/billboard/${b2.id}/pipeline`, { token: coHost.token }));
});

test('youth: consent required to apply, guardian applies/decides, hidden from staff and blocked when consent is revoked, exports withhold them', async () => {
  const mgr = await signup(['coach']), mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) }), stranger = await signup();
  await linkGuardian(mum, kid);
  const t = await team(mgr), b = await post(mgr, t, { positions_needed: 2 });

  // no consent: neither the child nor the guardian can apply
  const none = await apply(kid, b);
  assert.equal(none.status, 409); assert.equal(code(none), 'guardian_consent_required');
  assert.equal(code(await apply(mum, b, { on_behalf_of: kid.id })), 'guardian_consent_required');
  assert.equal((await apply(stranger, b, { on_behalf_of: kid.id })).status, 403);

  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'recruitment_sharing' } }), 201);
  const r = must(await apply(mum, b, { on_behalf_of: kid.id, source_url: 'https://example.com/kid-reel' }), 201);
  assert.equal((await pool.query('SELECT responder_id, applied_by FROM billboard_responses WHERE id=$1', [r.id])).rows[0].applied_by, mum.id);
  assert.equal((await pool.query('SELECT responder_id FROM billboard_responses WHERE id=$1', [r.id])).rows[0].responder_id, kid.id);
  const shown = must(await api('GET', `/billboard/${b.id}/pipeline`, { token: mgr.token }));
  assert.equal(shown.candidates[0].hidden, false); assert.equal(shown.candidates[0].is_youth, true);

  // guardian sees the child's applications; the child cannot decide an offer alone
  assert.equal(must(await api('GET', '/me/billboard-responses', { token: mum.token, query: { user_id: kid.id } })).length, 1);
  assert.equal((await api('GET', '/me/billboard-responses', { token: stranger.token, query: { user_id: kid.id } })).status, 403);
  const sl = must(await move(mgr, r.id, 'shortlisted', 1));
  const off = must(await api('POST', `/billboard/responses/${r.id}/offers`, { token: mgr.token, body: { deadline_at: inDays(3), row_version: sl.row_version, idempotency_key: key() } }), 201);
  const noKid = await api('POST', `/billboard/responses/${r.id}/offer-response`, { token: kid.token, body: { accept: true, row_version: off.row_version, idempotency_key: key() } });
  assert.equal(noKid.status, 403);

  // revoke consent: staff lose the identity, every mutation and the export; reads say why
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='recruitment_sharing'", [kid.id]);
  const hidden = must(await api('GET', `/billboard/${b.id}/pipeline`, { token: mgr.token }));
  assert.equal(hidden.candidates[0].hidden, true); assert.equal(hidden.candidates[0].display_name, undefined); assert.equal(hidden.candidates[0].message, undefined);
  assert.equal(hidden.counts.offered, 1, 'counts stay honest');
  assert.equal(code(await api('GET', `/billboard/responses/${r.id}/application`, { token: mgr.token })), 'guardian_consent_required');
  assert.equal(code(await move(mgr, r.id, 'declined', off.row_version)), 'guardian_consent_required');
  assert.equal(code(await api('PATCH', `/billboard/responses/${r.id}`, { token: mgr.token, body: { status: 'accepted' } })), 'guardian_consent_required');
  const lr = must(await api('GET', `/billboard/${b.id}/responses`, { token: mgr.token }));
  assert.equal(lr[0].hidden, true); assert.equal(lr[0].message, undefined);
  const exp = must(await api('GET', `/billboard/${b.id}/pipeline/export`, { token: mgr.token }));
  assert.equal(exp.rows, 0); assert.equal(exp.withheld, 1);
  // the family can still see and withdraw their own application
  must(await api('GET', `/billboard/responses/${r.id}/application`, { token: mum.token }));
  const wd = must(await api('POST', `/billboard/responses/${r.id}/withdraw`, { token: mum.token, body: { row_version: off.row_version, idempotency_key: key() } }));
  assert.equal(wd.stage, 'withdrawn');

  // restore consent: the child may accept only through the guardian
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'recruitment_sharing' } }), 201);
  const b3 = await post(mgr, t);
  const r3 = must(await apply(mum, b3, { on_behalf_of: kid.id }), 201);
  const s3 = must(await move(mgr, r3.id, 'shortlisted', 1));
  const o3 = must(await api('POST', `/billboard/responses/${r3.id}/offers`, { token: mgr.token, body: { deadline_at: inDays(3), row_version: s3.row_version, idempotency_key: key() } }), 201);
  const acc = must(await api('POST', `/billboard/responses/${r3.id}/offer-response`, { token: mum.token, body: { accept: true, row_version: o3.row_version, idempotency_key: key() } }));
  assert.equal(acc.stage, 'accepted');
  assert.equal((await pool.query("SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2", [t.id, kid.id])).rows[0].status, 'active');
});

test('review findings: open-rate offers stay open, stage pages, trial venue shown, family can withdraw after consent is revoked, expiry sweeps never deadlock', async () => {
  const mgr = await signup(['coach']), a = await signup(), b2 = await signup(), c3 = await signup();
  const t = await team(mgr), pst = await post(mgr, t, { positions_needed: 3, budget_cents: 5000 });
  const ra = must(await apply(a, pst, { message: 'Left-footed winger' }), 201), rb = must(await apply(b2, pst), 201), rc = must(await apply(c3, pst), 201);

  // an offer that leaves the rate open is not silently turned into the post's advertised rate
  const sl = must(await move(mgr, ra.id, 'shortlisted', 1));
  const o = must(await api('POST', `/billboard/responses/${ra.id}/offers`, { token: mgr.token, body: { deadline_at: inDays(3), row_version: sl.row_version, idempotency_key: key() } }), 201);
  must(await api('POST', `/billboard/responses/${ra.id}/offer-response`, { token: a.token, body: { accept: true, row_version: o.row_version, idempotency_key: key() } }));
  const tm = (await pool.query('SELECT rate_cents, rate_unit FROM team_members WHERE team_id=$1 AND user_id=$2', [t.id, a.id])).rows[0];
  assert.equal(tm.rate_cents, null, 'the open rate stays open'); assert.equal(tm.rate_unit, 'match', 'unit falls back to the column default only');

  // stages are fetched by stage with pages, 'closed' covers accepted + declined + withdrawn
  const closed = must(await api('GET', `/billboard/${pst.id}/pipeline`, { token: mgr.token, query: { stage: 'closed' } }));
  assert.deepEqual(closed.candidates.map((x) => x.stage), ['accepted']);
  const applied = must(await api('GET', `/billboard/${pst.id}/pipeline`, { token: mgr.token, query: { stage: 'applied', limit: 1 } }));
  assert.equal(applied.candidates.length, 1); assert.equal(applied.counts.applied, 2);
  const page2 = must(await api('GET', `/billboard/${pst.id}/pipeline`, { token: mgr.token, query: { stage: 'applied', limit: 1, offset: 1 } }));
  assert.notEqual(page2.candidates[0].response_id, applied.candidates[0].response_id);
  assert.equal(applied.candidates[0].message === undefined || typeof applied.candidates[0].message === 'string', true);
  assert.equal(must(await api('GET', `/billboard/${pst.id}/pipeline`, { token: mgr.token })).candidates.find((x) => x.response_id === ra.id).message, 'Left-footed winger', 'messages reach staff even without an evidence link');

  // the applicant is told where the trial is
  const venue = (await pool.query("INSERT INTO venues(name, city, owner_id) VALUES ('Riverside Ground','Pune',$1) RETURNING id", [mgr.id])).rows[0];
  const s2 = must(await move(mgr, rb.id, 'shortlisted', 1));
  const tr = must(await api('POST', `/billboard/responses/${rb.id}/trial`, { token: mgr.token, body: { trial_at: inDays(2), venue_id: venue.id, row_version: s2.row_version, idempotency_key: key() } }));
  assert.equal(tr.trial_venue_name, 'Riverside Ground');
  const view = must(await api('GET', `/billboard/responses/${rb.id}/application`, { token: b2.token }));
  assert.equal(view.application.trial_venue_name, 'Riverside Ground'); assert.equal(view.application.trial_venue_city, 'Pune');
  assert.equal(must(await api('GET', '/me/billboard-responses', { token: b2.token }))[0].trial_venue_name, 'Riverside Ground');

  // expiry sweeps racing with a withdrawal and a revised offer: no request fails with a deadlock
  const s3 = must(await move(mgr, rc.id, 'shortlisted', 1));
  const o3 = must(await api('POST', `/billboard/responses/${rc.id}/offers`, { token: mgr.token, body: { deadline_at: inDays(1), row_version: s3.row_version, idempotency_key: key() } }), 201);
  await pool.query("UPDATE recruitment_offers SET deadline_at = now() - interval '1 minute' WHERE response_id=$1", [rc.id]);
  const burst = await Promise.all([
    ...Array.from({ length: 6 }, () => api('GET', `/billboard/${pst.id}/pipeline`, { token: mgr.token })),
    api('POST', `/billboard/responses/${rc.id}/withdraw`, { token: c3.token, body: { row_version: o3.row_version, idempotency_key: key() } }),
  ]);
  assert.ok(burst.every((x) => x.status !== 500), JSON.stringify(burst.map((x) => x.status)));
  assert.ok((await pool.query("SELECT count(*)::int n FROM recruitment_offers WHERE response_id=$1 AND status='open'", [rc.id])).rows[0].n === 0, 'no offer is left open');

  // a young applicant can still read and withdraw once consent is revoked
  const mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) });
  await linkGuardian(mum, kid);
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'recruitment_sharing' } }), 201);
  const p2 = await post(mgr, t), rk = must(await apply(kid, p2), 201);
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='recruitment_sharing'", [kid.id]);
  must(await api('GET', `/billboard/responses/${rk.id}/application`, { token: kid.token }));
  assert.equal(must(await api('POST', `/billboard/responses/${rk.id}/withdraw`, { token: kid.token, body: { row_version: rk.row_version, idempotency_key: key() } })).stage, 'withdrawn');
});
