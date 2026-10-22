// Public sponsorship calls and private invitations (#285): deadlines in a timezone, invitation-only visibility, FAQs,
// invitations (opt-in, youth), notifications, awards linking to canonical sponsorships, isolation, stale versions, migration backfill.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { sendCallNotices } = await import('../src/sponsorship-calls.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sc_${n}_${roles[0]}`, display_name: `Call ${n}`, email: `sc${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const brand = async () => { const owner = await signup(['sponsor']); const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Call brand ${n}` } }), 201); return { owner, b }; };
const program = async (w, extra = {}) => must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Open call', objective: 'Back local talent', currency: 'USD', budget_cents: 100000, max_award_cents: 50000, ...extra } }), 201);
const round = async (w, p, extra = {}) => must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: w.owner.token, body: { opens_on: day(-1), closes_on: day(30), ...extra } }), 201);
const publish = async (w, p) => must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: w.owner.token, body: { status: 'published', version: p.row_version } }));
const live = async (extra = {}, roundExtra = {}) => { const w = await brand(); let p = await program(w, extra); const r = await round(w, p, roundExtra); p = await publish(w, p); return { w, p, r }; };
const apply = (token, r, body) => api('POST', `/program-rounds/${r.id}/applications`, { token, body: { requested_cents: 20000, pitch: 'Please', ...body } });
const athlete = async ({ optIn = true } = {}) => { const a = await signup(['athlete']); if (optIn) must(await api('POST', '/me/sponsorship-profile', { token: a.token, body: { open_to_sponsors: true } })); return { a, target: { target_type: 'athlete', target_id: a.id } }; };
const invite = (w, p, invitees, message) => api('POST', `/sponsorship-programs/${p.id}/invitations`, { token: w.owner.token, body: { invitees, message } });
const listed = async (token, query) => (await api('GET', '/funding-opportunities', { token, query })).body;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('expired call: the deadline instant in the round timezone is enforced on the server', async () => {
  const w = await brand();
  let p = await program(w);
  // a deadline today in a zone where it already passed (UTC-12 is the last zone to reach any given date; use a time that is surely past in Pacific/Kiritimati UTC+14)
  const r = await round(w, p, { opens_on: day(-2), closes_on: day(0), closes_time: '00:01', timezone: 'Pacific/Kiritimati' });
  assert.equal(new Date(r.closes_at) < new Date(), true, 'deadline already passed');
  p = await publish(w, p);
  const x = await athlete();
  const res = await apply(x.a.token, r, x.target);
  assert.equal(res.status, 409);
  assert.match(res.body.error?.message ?? res.body.message, /closed/);
  assert.equal((await listed(x.a.token)).length, 0, 'an expired round is not offered');
  const page = must(await api('GET', `/funding-opportunities/${p.id}`, { token: x.a.token }));
  assert.equal(page.can_apply, false);
  assert.equal(page.rounds[0].state, 'closed');
  // the same calendar day with a later deadline in a far-west zone is still open
  const w2 = await brand();
  let p2 = await program(w2);
  const r2 = await round(w2, p2, { opens_on: day(-1), closes_on: day(1), closes_time: '23:00', timezone: 'Pacific/Honolulu' });
  p2 = await publish(w2, p2);
  must(await apply(x.a.token, r2, x.target), 201);
  assert.equal((await api('POST', `/program-rounds/${r2.id}/applications`, { token: x.a.token, body: { ...x.target, requested_cents: 100 } })).status, 409, 'one live application per round and target');
  // the deadline is edited into the past: applications stop
  const y = await athlete();
  const edited = must(await api('PATCH', `/program-rounds/${r2.id}`, { token: w2.owner.token, body: { version: r2.row_version, opens_on: day(-3), closes_on: day(-2) } }));
  assert.equal(new Date(edited.closes_at) < new Date(), true);
  assert.equal((await apply(y.a.token, r2, y.target)).status, 409);
  assert.equal((await api('POST', `/sponsorship-programs/${p2.id}/rounds`, { token: w2.owner.token, body: { opens_on: day(0), closes_on: day(1), timezone: 'Mars/Olympus' } })).status, 400, 'unknown timezone rejected');
});

test('a deadline that passes while an application waits on the lock is still rejected (clock, not transaction start)', async () => {
  const { w, r } = await live({}, { closes_on: day(30) });
  const x = await athlete();
  // simulate "passes during the request": move the stored deadline a second into the past directly, then apply
  await pool.query("UPDATE sponsorship_rounds SET closes_at = now() - interval '1 second' WHERE id=$1", [r.id]);
  assert.equal((await apply(x.a.token, r, x.target)).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_applications WHERE round_id=$1', [r.id])).rows[0].n, 0);
});

test('private calls are not discoverable: not in search, not by id, not applicable without an invitation', async () => {
  const { w, p, r } = await live({ visibility: 'invitation_only' });
  const invited = await athlete(), outsider = await athlete(), anon = undefined;
  assert.equal((await listed(anon)).length, 0, 'signed out');
  assert.equal((await listed(outsider.a.token)).length, 0);
  assert.equal((await api('GET', `/funding-opportunities/${p.id}`, { token: outsider.a.token })).status, 404);
  assert.equal((await api('GET', `/funding-opportunities/${p.id}`)).status, 404, 'signed out');
  assert.equal((await api('GET', `/funding-opportunities/${p.id}`, { token: outsider.a.token })).status, (await api('GET', '/funding-opportunities/00000000-0000-4000-8000-000000000000', { token: outsider.a.token })).status, 'same answer as an unknown id');
  assert.equal((await apply(outsider.a.token, r, outsider.target)).status, 404);
  const res = must(await invite(w, p, [invited.target]), 201);
  assert.equal(res.invited.length, 1);
  assert.equal((await listed(outsider.a.token)).length, 0, 'still hidden from everyone else');
  const mine = await listed(invited.a.token);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].invitations[0].status, 'invited');
  assert.equal((await listed(invited.a.token, { invited: 'true' })).length, 1);
  assert.equal((await listed(outsider.a.token, { invited: 'true' })).length, 0);
  const page = must(await api('GET', `/funding-opportunities/${p.id}`, { token: invited.a.token }));
  assert.equal(page.can_apply, true);
  assert.equal(page.budget_cents, undefined, 'budget is never shown');
  assert.equal((await pool.query('SELECT status FROM sponsorship_invitations WHERE id=$1', [res.invited[0].id])).rows[0].status, 'viewed');
  const ok = must(await apply(invited.a.token, r, invited.target), 201);
  assert.equal(ok.invitation_id, res.invited[0].id);
  assert.equal((await pool.query('SELECT status FROM sponsorship_invitations WHERE id=$1', [res.invited[0].id])).rows[0].status, 'applied');
  // an invitation for athlete A cannot be used for another target or by someone else
  assert.equal((await apply(outsider.a.token, r, invited.target)).status, 404);
  // brand staff still see their own call
  assert.equal((await api('GET', `/funding-opportunities/${p.id}`, { token: w.owner.token })).status, 200);
  // switching to public lists it, switching back hides it again
  let cur = must(await api('GET', `/sponsorship-programs/${p.id}`, { token: w.owner.token }));
  cur = must(await api('PATCH', `/sponsorship-programs/${p.id}`, { token: w.owner.token, body: { version: cur.row_version, visibility: 'public' } }));
  assert.equal((await listed(outsider.a.token)).length, 1);
  must(await api('PATCH', `/sponsorship-programs/${p.id}`, { token: w.owner.token, body: { version: cur.row_version, visibility: 'invitation_only' } }));
  assert.equal((await listed(outsider.a.token)).length, 0);
});

test('revoked and declined invitations stop access; an applicant who withdraws can apply again; invitations are notified', async () => {
  const { w, p, r } = await live({ visibility: 'invitation_only' });
  const a = await athlete(), b = await athlete();
  const res = must(await invite(w, p, [a.target, b.target], 'We like your work'), 201);
  assert.equal(res.invited.length, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='sponsorship_invitation' AND user_id=$1", [a.a.id])).rows[0].n, 1, 'invitee is notified');
  const [va, vb] = res.invited;
  must(await api('POST', `/program-invitations/${va.id}/revoke`, { token: w.owner.token }));
  assert.equal((await apply(a.a.token, r, a.target)).status, 404, 'revoked');
  assert.equal((await listed(a.a.token)).length, 0);
  assert.equal((await api('POST', `/program-invitations/${va.id}/revoke`, { token: w.owner.token })).status, 409);
  assert.equal((await api('POST', `/program-invitations/${vb.id}/decline`, { token: a.a.token })).status, 404, 'not your invitation');
  must(await api('POST', `/program-invitations/${vb.id}/decline`, { token: b.a.token }));
  assert.equal((await apply(b.a.token, r, b.target)).status, 404, 'declined');
  assert.equal((await api('POST', `/program-invitations/${vb.id}/decline`, { token: b.a.token })).status, 409);
  const list = must(await api('GET', `/sponsorship-programs/${p.id}/invitations`, { token: w.owner.token }));
  assert.deepEqual(list.map((x) => x.status).sort(), ['declined', 'revoked']);
  // re-invite after a revocation is a new live invitation
  const again = must(await invite(w, p, [a.target]), 201);
  assert.equal(again.invited.length, 1);
  assert.equal(must(await invite(w, p, [a.target]), 201).skipped[0].reason, 'Already invited');
  const app = must(await apply(a.a.token, r, a.target), 201);
  must(await api('POST', `/program-applications/${app.id}/withdraw`, { token: a.a.token }));
  must(await apply(a.a.token, r, a.target), 201); // invitation is usable again after a withdrawal
  // invitations made while still a draft are announced when it is published
  const w2 = await brand();
  let d = await program(w2, { visibility: 'invitation_only' });
  const c = await athlete();
  must(await invite(w2, d, [c.target]), 201);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsorship_invitation'", [c.a.id])).rows[0].n, 0);
  await round(w2, d); await publish(w2, d);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsorship_invitation'", [c.a.id])).rows[0].n, 1);
});

test('invitation rules: athlete opt-in, verified-only, youth, own staff, target types', async () => {
  const { w, p } = await live();
  const closed = await athlete({ optIn: false });
  const kid = await athlete();
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.a.id]);
  const picky = await athlete();
  must(await api('POST', '/me/sponsorship-profile', { token: picky.a.token, body: { open_to_sponsors: true, verified_sponsors_only: true } }));
  const res = must(await invite(w, p, [closed.target, kid.target, picky.target]), 201);
  assert.equal(res.invited.length, 0);
  assert.match(res.skipped.find((x) => x.target_id === closed.a.id).reason, /not open/);
  assert.match(res.skipped.find((x) => x.target_id === kid.a.id).reason, /independence/);
  assert.match(res.skipped.find((x) => x.target_id === picky.a.id).reason, /verified/);
  assert.equal(must(await invite(w, p, [{ target_type: 'athlete', target_id: w.owner.id }]), 201).invited.length, 0, 'brand staff are not invitable');
  // only brand staff may invite; another brand is refused
  const other = await brand(), stranger = await signup(['athlete']);
  assert.equal((await invite(other, p, [closed.target])).status, 403);
  assert.equal((await api('POST', `/sponsorship-programs/${p.id}/invitations`, { token: stranger.token, body: { invitees: [closed.target] } })).status, 403);
  // a team target is invited through its organiser
  const org = await signup(['organizer']);
  const sport = (await pool.query('SELECT slug FROM sports LIMIT 1')).rows[0].slug;
  const team = must(await api('POST', '/teams', { token: org.token, body: { name: 'Invited club', sport } }), 201);
  const ok = must(await invite(w, p, [{ target_type: 'team', target_id: team.id }]), 201);
  assert.equal(ok.invited[0].invitee_user_id, org.id);
});

test('FAQs: staff manage them with versions, they show on the public page and are searchable, archived ones disappear', async () => {
  const { w, p } = await live();
  const f = must(await api('POST', `/sponsorship-programs/${p.id}/faqs`, { token: w.owner.token, body: { question: 'Who can apply?', answer: 'Verified clubs in Oregon' } }), 201);
  must(await api('POST', `/sponsorship-programs/${p.id}/faqs`, { token: w.owner.token, body: { question: 'When are results?', answer: 'Within a month', position: 0 } }), 201);
  const anyone = await signup(['athlete']);
  let page = must(await api('GET', `/funding-opportunities/${p.id}`));
  assert.deepEqual(page.faqs.map((x) => x.question), ['When are results?', 'Who can apply?']);
  assert.equal((await listed(anyone.token, { q: 'Oregon' })).length, 1, 'FAQ text is searchable');
  assert.equal((await listed(anyone.token, { q: 'zzzz-nothing' })).length, 0);
  const edited = must(await api('POST', `/sponsorship-programs/${p.id}/faqs`, { token: w.owner.token, body: { faq_id: f.id, version: f.row_version, question: 'Who can apply?', answer: 'Any club' } }), 201);
  assert.equal(edited.row_version, 2);
  assert.equal((await api('POST', `/sponsorship-programs/${p.id}/faqs`, { token: w.owner.token, body: { faq_id: f.id, version: f.row_version, question: 'Q', answer: 'A' } })).status, 409, 'stale');
  assert.equal((await api('POST', `/sponsorship-program-faqs/${f.id}/archive`, { token: w.owner.token, body: { version: f.row_version } })).status, 409, 'stale');
  assert.equal((await api('POST', `/sponsorship-programs/${p.id}/faqs`, { token: anyone.token, body: { question: 'Q', answer: 'A' } })).status, 403);
  must(await api('POST', `/sponsorship-program-faqs/${f.id}/archive`, { token: w.owner.token, body: { version: 2 } }));
  page = must(await api('GET', `/funding-opportunities/${p.id}`));
  assert.equal(page.faqs.length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_program_faqs WHERE program_id=$1', [p.id])).rows[0].n, 2, 'archived, not deleted');
});

test('search: region/sport/text filters, closing-soon sort and deterministic pagination; budget never exposed', async () => {
  const sport = (await pool.query('SELECT slug FROM sports ORDER BY slug LIMIT 1')).rows[0].slug;
  const a = await live({ name: 'Searchable alpha', regions: ['Oregon'], sports: [sport] }, { closes_on: day(20) });
  const b = await live({ name: 'Searchable beta', regions: ['Texas'] }, { closes_on: day(5) });
  const x = await signup(['athlete']);
  const all = await listed(x.token, { q: 'Searchable' });
  assert.equal(all.length, 2);
  assert.equal(all[0].budget_cents, undefined);
  assert.deepEqual((await listed(x.token, { q: 'Searchable', region: 'oregon' })).map((r) => r.id).sort(), [a.p.id].sort().concat([b.p.id]).filter((id) => id === a.p.id), 'a region-specific call is matched case-insensitively; others are not');
  assert.equal((await listed(x.token, { q: 'Searchable', sport })).length, 2, 'a call without a sport restriction fits any sport');
  const soon = await listed(x.token, { q: 'Searchable', sort: 'closing_soon' });
  assert.equal(soon[0].id, b.p.id);
  assert.ok(soon[0].rounds[0].closes_at && soon[0].rounds[0].timezone);
  const p1 = await listed(x.token, { q: 'Searchable', limit: '1', offset: '0' }), p2 = await listed(x.token, { q: 'Searchable', limit: '1', offset: '1' });
  assert.notEqual(p1[0].id, p2[0].id);
});

test('awarded applications link to canonical sponsorships and a private award stays private; isolation and export', async () => {
  const { w, p, r } = await live({ visibility: 'invitation_only' });
  const x = await athlete();
  must(await invite(w, p, [x.target]), 201);
  const app = must(await apply(x.a.token, r, x.target), 201);
  const cur = must(await api('GET', `/sponsorship-programs/${p.id}`, { token: w.owner.token }));
  const won = must(await api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: cur.row_version } }));
  const row = (await pool.query('SELECT * FROM sponsorships WHERE id=$1', [won.sponsorship_id])).rows[0];
  assert.equal(row.program_id, p.id); assert.equal(row.round_id, r.id); assert.equal(row.application_id, app.id);
  assert.equal(row.visibility, 'private');
  // another brand cannot read, invite, export or decide anything of this program
  const other = await brand();
  for (const [m, path, body] of [['GET', `/sponsorship-programs/${p.id}`], ['GET', `/sponsorship-programs/${p.id}/invitations`], ['GET', `/sponsorship-programs/${p.id}/applications`], ['GET', `/sponsorship-programs/${p.id}/awards-export`], ['POST', `/sponsorship-programs/${p.id}/faqs`, { question: 'Q', answer: 'A' }], ['POST', `/sponsorship-programs/${p.id}/invitations`, { invitees: [x.target] }]]) {
    const res = await api(m, path, { token: other.owner.token, body });
    assert.equal(res.status, 403, `${m} ${path}`);
  }
  const csv = must(await api('GET', `/sponsorship-programs/${p.id}/awards-export`, { token: w.owner.token }));
  assert.equal(csv.rows, 1);
  const inv = (await pool.query('SELECT id FROM sponsorship_invitations WHERE program_id=$1', [p.id])).rows[0];
  assert.equal((await api('POST', `/program-invitations/${inv.id}/revoke`, { token: other.owner.token })).status, 403);
  assert.equal((await api('POST', `/program-invitations/${inv.id}/revoke`, { token: w.owner.token })).status, 409, 'already applied');
});

test('deadline notices: invitees are reminded once before the deadline, brand staff hear once when it passes', async () => {
  await sendCallNotices(); // settle rounds left over from other tests
  const w = await brand();
  let p = await program(w, { visibility: 'invitation_only' });
  const r = await round(w, p, { opens_on: day(-1), closes_on: day(5) });
  p = await publish(w, p);
  const x = await athlete();
  must(await invite(w, p, [x.target]), 201);
  assert.equal(await sendCallNotices(), 0, 'not close to the deadline yet');
  await pool.query("UPDATE sponsorship_rounds SET closes_at = now() + interval '3 hours' WHERE id=$1", [r.id]);
  assert.equal(await sendCallNotices(), 1);
  assert.equal(await sendCallNotices(), 0, 'idempotent');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsorship_call'", [x.a.id])).rows[0].n, 1);
  await pool.query("UPDATE sponsorship_rounds SET closes_at = now() - interval '1 minute' WHERE id=$1", [r.id]);
  assert.equal(await sendCallNotices(), 1, 'the brand owner is told the call closed');
  assert.equal(await sendCallNotices(), 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsorship_call'", [w.owner.id])).rows[0].n, 1);
});

test('migration is additive: existing rounds keep their date window, programs stay public', async () => {
  const { r, p } = await live();
  await pool.query('UPDATE sponsorship_rounds SET opens_at=NULL, closes_at=NULL, timezone=$2 WHERE id=$1', [r.id, 'UTC']); // a pre-#285 row
  const x = await athlete();
  assert.equal(p.visibility, 'public');
  must(await apply(x.a.token, r, x.target), 201);
  await pool.query("UPDATE sponsorship_rounds SET closes_on=current_date - 1, opens_on=current_date - 5 WHERE id=$1", [r.id]);
  const y = await athlete();
  assert.equal((await apply(y.a.token, r, y.target)).status, 409, 'closed by its date even without stored instants');
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM sponsorship_rounds WHERE closes_at IS NULL OR opens_at IS NULL");
  assert.ok(rows[0].n >= 1);
});
