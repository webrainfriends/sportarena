import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status) => { if (status ? r.status !== status : r.status >= 300) assert.fail(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = must(await api('POST', '/auth/register', { body: { handle: `edu_${n}`, display_name: `Edu ${n}`, email: `edu${n}@example.com`, password: 'correct-horse-battery', roles } }), 201);
  return { ...r.user, token: r.token };
};
const sports = {};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('edu_root','Root','{admin}','x','x','edu_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  for (const s of (await api('GET', '/sports')).body) sports[s.slug] = s;
});
after(async () => { server.close(); await pool.end(); });

/** A listed college with an owner, one programme covering tennis, a general brochure and an apply link. */
const college = async (kind = 'college') => {
  const owner = await signup(['athlete']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Hilltop ${n}`, kind, city: 'Pune' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/institution`, { token: owner.token, body: { about: 'Sports degrees', website: 'https://hilltop.example', country: 'India', contact_email: 'admissions@hilltop.example', contact_phone: '+91 20 5550 0000', listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/programmes`, { token: owner.token, body: { title: 'BSc Sports Science', kind: 'degree', mode: 'on_campus', sport_ids: [sports.tennis.id], duration_months: 36, fee_minor: 250000, currency: 'INR', next_intake_on: '2027-07-01', apply_url: 'https://hilltop.example/apply/bsc' } }), 201);
  const brochure = must(await api('POST', `/organisations/${org.id}/brochures`, { token: owner.token, body: { title: 'Prospectus 2027', url: 'https://hilltop.example/prospectus.pdf', programme_id: prog.id } }), 201);
  return { owner, org, prog, brochure };
};

test('rules of a sport: the platform team writes them, everyone reads them, each cites a source', async () => {
  const empty = must(await api('GET', '/sports/tennis/rules'));
  assert.deepEqual(empty.rules, [], 'no invented content: empty until someone adds it');
  const ath = await signup();
  assert.equal((await api('POST', '/sports/tennis/rules', { token: ath.token, body: { title: 'Scoring', body: 'Points are 15, 30, 40, game.' } })).status, 403);
  const r = must(await api('POST', '/sports/tennis/rules', { token: admin.token, body: { title: 'Scoring', body: 'Points are 15, 30, 40, game.', source_url: 'https://www.itftennis.com/rules', position: 1 } }), 201);
  assert.equal((await api('POST', '/sports/tennis/rules', { token: admin.token, body: { title: 'Bad', body: 'x y', source_url: 'http://insecure.example' } })).status, 400);
  assert.equal(must(await api('GET', '/sports/tennis/rules')).rules.length, 1);
  must(await api('PATCH', `/sport-rules/${r.id}`, { token: admin.token, body: { status: 'archived' } }));
  assert.equal(must(await api('GET', '/sports/tennis/rules')).rules.length, 0, 'archived sections are hidden, not deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sport_rules')).rows[0].n, 1);
  assert.equal((await api('GET', '/sports/nonsense-sport/rules')).status, 404);
});

test('institutions: listing needs a contact route; contacts are encrypted, hidden from the directory and logged when read', async () => {
  const owner = await signup();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Quiet College', kind: 'university' } }), 201);
  assert.equal((await api('PATCH', `/organisations/${org.id}/institution`, { token: owner.token, body: { listed: true } })).status, 400, 'nothing to contact them by');
  const other = await signup();
  assert.equal((await api('PATCH', `/organisations/${org.id}/institution`, { token: other.token, body: { about: 'x' } })).status, 404, 'outsiders do not learn it exists');
  const c = await college();
  const dir = must(await api('GET', '/institutions?q=Hilltop'));
  assert.equal(dir.length, 1);
  assert.deepEqual(Object.keys(dir[0]).filter((k) => /mail|phone|contact/.test(k)), [], 'directory carries no contact details');
  assert.ok(!(await api('GET', '/institutions')).body.some((o) => o.name === 'Quiet College'), 'unlisted stays hidden');
  assert.equal((await api('GET', `/institutions/${c.org.id}/contact`)).status, 401);
  const ath = await signup();
  const contact = must(await api('GET', `/institutions/${c.org.id}/contact`, { token: ath.token }));
  assert.equal(contact.email, 'admissions@hilltop.example'); assert.equal(contact.phone, '+91 20 5550 0000');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='read_pii' AND entity='institution_profiles'", [ath.id])).rows[0].n, 1);
  const raw = (await pool.query('SELECT contact_email_enc, contact_phone_enc FROM institution_profiles WHERE organisation_id=$1', [c.org.id])).rows[0];
  assert.ok(!raw.contact_email_enc.includes('admissions') && !raw.contact_phone_enc.includes('5550'));
  assert.equal(must(await api('GET', `/institutions/${c.org.id}`)).programmes.length, 1);
});

test('programmes: search by sport, kind and place; multi-sport; archive hides but keeps', async () => {
  const c = await college();
  const gen = must(await api('POST', `/organisations/${c.org.id}/programmes`, { token: c.owner.token, body: { title: 'Sports Management Certificate', kind: 'certification', mode: 'online', sport_ids: [] } }), 201);
  assert.equal((await api('POST', `/organisations/${c.org.id}/programmes`, { token: c.owner.token, body: { title: 'Fee no currency', kind: 'course', fee_minor: 5 } })).status, 400);
  assert.equal((await api('POST', `/organisations/${c.org.id}/programmes`, { token: c.owner.token, body: { title: 'Bad sport', kind: 'course', sport_ids: ['00000000-0000-0000-0000-000000000000'] } })).status, 400);
  const tennis = must(await api('GET', '/programmes?sport=tennis&country=india'));
  assert.ok(tennis.some((p) => p.id === c.prog.id) && !tennis.some((p) => p.id === gen.id), 'sport filter');
  assert.ok(must(await api('GET', '/programmes?kind=certification&mode=online')).some((p) => p.id === gen.id));
  must(await api('PATCH', `/programmes/${c.prog.id}`, { token: c.owner.token, body: { sport_ids: [sports.tennis.id, sports.football.id] } }));
  assert.ok(must(await api('GET', '/programmes?sport=football')).some((p) => p.id === c.prog.id));
  must(await api('PATCH', `/programmes/${c.prog.id}`, { token: c.owner.token, body: { sport_ids: [sports.football.id] } }));
  assert.ok(!must(await api('GET', '/programmes?sport=tennis')).some((p) => p.id === c.prog.id), 'un-ticked sport no longer matches');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM programme_sports WHERE programme_id=$1', [c.prog.id])).rows[0].n, 2, 'the removed sport row is kept');
  const detail = must(await api('GET', `/programmes/${c.prog.id}`));
  assert.equal(detail.apply_url, 'https://hilltop.example/apply/bsc'); assert.equal(detail.brochures.length, 1);
  const stranger = await signup();
  assert.equal((await api('PATCH', `/programmes/${c.prog.id}`, { token: stranger.token, body: { title: 'Hijack' } })).status, 404);
  must(await api('PATCH', `/programmes/${c.prog.id}`, { token: c.owner.token, body: { status: 'archived' } }));
  assert.equal((await api('GET', `/programmes/${c.prog.id}`)).status, 404);
  assert.equal(must(await api('GET', `/organisations/${c.org.id}/programmes`, { token: c.owner.token })).find((p) => p.id === c.prog.id).status, 'archived');
});

test('enquiry to join: reply, brochure, route to website, stages, privacy and notifications', async () => {
  const c = await college();
  const ath = await signup(), other = await signup();
  assert.equal((await api('POST', '/enquiries', { token: ath.token, body: { organisation_id: c.org.id, programme_id: c.prog.id, message: 'Is a tennis scholarship possible?' } })).status === 201, true);
  const list = must(await api('GET', '/me/enquiries', { token: ath.token }));
  assert.equal(list.length, 1); assert.equal(list[0].institution.startsWith('Hilltop'), true); assert.equal(list[0].sport, 'Tennis', 'sport taken from the programme');
  const eq = list[0];
  const dup = await api('POST', '/enquiries', { token: ath.token, body: { organisation_id: c.org.id, programme_id: c.prog.id, message: 'again' } });
  assert.equal(dup.status, 409); assert.equal(dup.body.error?.details?.enquiry_id ?? dup.body.details?.enquiry_id, eq.id);
  assert.equal((await api('GET', `/enquiries/${eq.id}`, { token: other.token })).status, 404, 'other athletes cannot open it');
  assert.equal((await api('POST', '/enquiries', { token: other.token, body: { organisation_id: c.org.id, programme_id: '00000000-0000-0000-0000-000000000000', message: 'x' } })).status, 404);
  // the owner was notified, and the text is encrypted at rest
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='enquiry_new'", [c.owner.id])).rows[0].n, 1);
  assert.ok(!(await pool.query('SELECT body_enc FROM enquiry_messages WHERE enquiry_id=$1', [eq.id])).rows[0].body_enc.includes('scholarship'));
  // staff read: logged, athlete read: not
  const t = must(await api('GET', `/enquiries/${eq.id}`, { token: c.owner.token }));
  assert.equal(t.my_side, 'staff'); assert.equal(t.messages[0].body, 'Is a tennis scholarship possible?'); assert.equal(t.apply_url, 'https://hilltop.example/apply/bsc');
  assert.equal(JSON.stringify(t).includes('example.com'), false, 'the athlete\'s email is never shown to the institution');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND entity='enquiries'", [c.owner.id])).rows[0].n, 1);
  // staff replies with a brochure; athlete is notified and sees it unread
  must(await api('POST', `/enquiries/${eq.id}/messages`, { token: c.owner.token, body: { body: 'Yes, see the prospectus.', brochure_id: c.brochure.id } }), 201);
  assert.equal(must(await api('GET', '/me/enquiries', { token: ath.token }))[0].unread, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='enquiry_reply'", [ath.id])).rows[0].n, 1);
  assert.equal((await api('POST', `/enquiries/${eq.id}/messages`, { token: ath.token, body: { body: 'sneaky', brochure_id: c.brochure.id } })).status, 403, 'athletes do not share brochures');
  let th = must(await api('GET', `/enquiries/${eq.id}`, { token: ath.token }));
  assert.equal(th.status, 'in_conversation'); assert.equal(th.messages.at(-1).brochure_url, 'https://hilltop.example/prospectus.pdf');
  assert.equal(must(await api('GET', '/me/enquiries', { token: ath.token }))[0].unread, false);
  must(await api('POST', `/enquiries/${eq.id}/messages`, { token: ath.token, body: { body: 'Thanks! How do I apply?' } }), 201);
  // route to website
  assert.equal((await api('POST', `/enquiries/${eq.id}/refer`, { token: ath.token, body: {} })).status, 403, 'only the institution routes');
  const ref = must(await api('POST', `/enquiries/${eq.id}/refer`, { token: c.owner.token, body: {} }));
  assert.equal(ref.url, 'https://hilltop.example/apply/bsc'); assert.equal(ref.status, 'referred');
  // joining process
  assert.equal((await api('PATCH', `/enquiries/${eq.id}/status`, { token: ath.token, body: { status: 'admitted' } })).status, 403);
  must(await api('PATCH', `/enquiries/${eq.id}/status`, { token: c.owner.token, body: { status: 'applied' } }));
  must(await api('PATCH', `/enquiries/${eq.id}/status`, { token: c.owner.token, body: { status: 'admitted', note: 'Offer letter sent' } }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='enquiry_status'", [ath.id])).rows[0].n, 2);
  assert.equal((await api('PATCH', `/enquiries/${eq.id}/status`, { token: c.owner.token, body: { status: 'new' } })).status, 400);
  const summary = must(await api('GET', `/organisations/${c.org.id}/admissions`, { token: c.owner.token }));
  assert.equal(summary.stages.admitted, 1); assert.equal(summary.programmes, 1);
  assert.equal(must(await api('GET', `/organisations/${c.org.id}/enquiries?status=admitted&q=Edu`, { token: c.owner.token })).length, 1);
  assert.equal((await api('GET', `/organisations/${c.org.id}/enquiries`, { token: ath.token })).status, 404);
});

test('broadcast goes only to enquirers who consented; consent is withdrawable; withdrawn enquiries are skipped', async () => {
  const c = await college();
  const yes = await signup(), no = await signup(), later = await signup(), gone = await signup();
  const ask = async (u, consent) => must(await api('POST', '/enquiries', { token: u.token, body: { organisation_id: c.org.id, programme_id: c.prog.id, message: 'Hello', comms_consent: consent } }), 201);
  const eYes = await ask(yes, true); await ask(no, false); const eLater = await ask(later, true); const eGone = await ask(gone, true);
  must(await api('POST', `/enquiries/${eGone.id}/withdraw`, { token: gone.token }));
  must(await api('PATCH', `/enquiries/${eLater.id}/consent`, { token: later.token, body: { comms_consent: false } }));
  const body = { subject: 'Open day', body: 'Join us on 12 March.', programme_id: c.prog.id };
  const dry = must(await api('POST', `/organisations/${c.org.id}/broadcasts`, { token: c.owner.token, body: { ...body, dry_run: true } }), 201);
  assert.deepEqual([dry.recipients, dry.skipped_no_consent], [1, 2]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM enquiry_broadcasts")).rows[0].n, 0, 'a dry run sends nothing');
  assert.equal((await api('POST', `/organisations/${c.org.id}/broadcasts`, { token: yes.token, body })).status, 404);
  const sent = must(await api('POST', `/organisations/${c.org.id}/broadcasts`, { token: c.owner.token, body }), 201);
  assert.equal(sent.recipients, 1);
  const got = async (u) => (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='enquiry_broadcast'", [u.id])).rows[0].n;
  assert.deepEqual([await got(yes), await got(no), await got(later), await got(gone)], [1, 0, 0, 0]);
  assert.equal(must(await api('GET', `/enquiries/${eYes.id}`, { token: yes.token })).messages.some((m) => m.kind === 'broadcast'), true);
  assert.equal(must(await api('GET', `/organisations/${c.org.id}/broadcasts`, { token: c.owner.token }))[0].recipients, 1);
  // nobody left to reach
  must(await api('PATCH', `/enquiries/${eYes.id}/consent`, { token: yes.token, body: { comms_consent: false } }));
  assert.equal((await api('POST', `/organisations/${c.org.id}/broadcasts`, { token: c.owner.token, body })).status, 409);
});

test('sponsor link: needs the athlete\'s consent, tells the sponsor, lets that sponsor offer, and is withdrawn with consent', async () => {
  const c = await college();
  const ath = await signup(), brand = await signup(['sponsor']);
  const sp = must(await api('POST', '/sponsors', { token: brand.token, body: { name: 'Ace Gear' } }), 201);
  const e = must(await api('POST', '/enquiries', { token: ath.token, body: { organisation_id: c.org.id, programme_id: c.prog.id, message: 'Hi' } }), 201);
  const link = (body = {}) => api('POST', `/enquiries/${e.id}/sponsor-links`, { token: c.owner.token, body: { sponsor_id: sp.id, ...body } });
  assert.equal((await link()).status, 403, 'no consent, no introduction');
  must(await api('PATCH', `/enquiries/${e.id}/consent`, { token: ath.token, body: { sponsor_consent: true } }));
  const offer = { sponsor_id: sp.id, target_type: 'athlete', target_id: ath.id, in_kind: 'Racquets', objectives: 'Exposure', deliverables: 'Wear the logo', starts_on: '2027-01-01', ends_on: '2027-12-31' };
  assert.equal((await api('POST', '/sponsorships', { token: brand.token, body: offer })).status, 409, 'athlete is not open to discovery');
  must(await link({ note: 'Strong junior record' }), 201);
  assert.equal((await link()).status, 409, 'no double introduction');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsor_introduction'", [brand.id])).rows[0].n, 1);
  const intros = must(await api('GET', `/sponsors/${sp.id}/introductions`, { token: brand.token }));
  assert.equal(intros[0].handle, ath.handle); assert.equal(intros[0].programme_title, 'BSc Sports Science');
  assert.equal((await api('GET', `/sponsors/${sp.id}/introductions`, { token: ath.token })).status, 403);
  assert.equal(must(await api('GET', `/enquiries/${e.id}`, { token: ath.token })).sponsor_links[0].sponsor_name, 'Ace Gear', 'the athlete sees who was told');
  must(await api('POST', '/sponsorships', { token: brand.token, body: offer }), 201);
  // withdrawing consent withdraws the introduction (new offers are blocked again)
  must(await api('PATCH', `/enquiries/${e.id}/consent`, { token: ath.token, body: { sponsor_consent: false } }));
  assert.equal(must(await api('GET', `/sponsors/${sp.id}/introductions?status=withdrawn`, { token: brand.token })).length, 1);
});

test('credentials: issued to enrolled people, shown on profile and passport if they allow, verifiable, revocable', async () => {
  const c = await college();
  const ath = await signup();
  const e = must(await api('POST', '/enquiries', { token: ath.token, body: { organisation_id: c.org.id, programme_id: c.prog.id, message: 'Hi' } }), 201);
  const issue = (body) => api('POST', `/organisations/${c.org.id}/credentials`, { token: c.owner.token, body: { enquiry_id: e.id, kind: 'certificate', title: 'Level 1 Tennis Coaching', ...body } });
  assert.equal((await issue()).status, 409, 'not enrolled yet');
  must(await api('PATCH', `/enquiries/${e.id}/status`, { token: c.owner.token, body: { status: 'enrolled' } }));
  assert.equal((await issue({ expires_on: '2000-01-01', issued_on: '2001-01-01' })).status, 400);
  assert.equal((await api('POST', `/organisations/${c.org.id}/credentials`, { token: ath.token, body: { enquiry_id: e.id, kind: 'badge', title: 'Self-awarded' } })).status, 404, 'athletes cannot issue');
  const cred = must(await issue(), 201);
  assert.match(cred.code, /^GMG-[0-9A-F]{12}$/);
  const mine = must(await api('GET', '/me/credentials', { token: ath.token }));
  assert.equal(mine[0].institution.startsWith('Hilltop'), true); assert.equal(mine[0].sport, 'Tennis');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='credential_issued'", [ath.id])).rows[0].n, 1);
  const person = must(await api('GET', `/people/${ath.id}`));
  assert.equal(person.credentials[0].title, 'Level 1 Tennis Coaching');
  const link = must(await api('POST', '/me/passport-links', { token: ath.token, body: {} }), 201);
  assert.equal(must(await api('GET', `/passport/${link.token}`)).credentials[0].code, cred.code);
  const noCred = must(await api('POST', '/me/passport-links', { token: ath.token, body: { show_credentials: false } }), 201);
  assert.equal(must(await api('GET', `/passport/${noCred.token}`)).credentials, null);
  const v = must(await api('GET', `/credentials/verify/${cred.code.toLowerCase()}`));
  assert.deepEqual([v.valid, v.status, v.holder.handle], [true, 'valid', ath.handle]);
  // the holder hides it: gone from profile and passport, holder name hidden from verification, still valid
  must(await api('PATCH', `/me/credentials/${cred.id}`, { token: ath.token, body: { show_on_profile: false } }));
  assert.deepEqual(must(await api('GET', `/people/${ath.id}`)).credentials, []);
  const hidden = must(await api('GET', `/credentials/verify/${cred.code}`));
  assert.equal(hidden.valid, true); assert.equal(hidden.holder, null);
  assert.equal((await api('PATCH', `/me/credentials/${cred.id}`, { token: (await signup()).token, body: { show_on_profile: true } })).status, 404);
  // revoke keeps the record
  must(await api('PATCH', `/me/credentials/${cred.id}`, { token: ath.token, body: { show_on_profile: true } }));
  assert.equal((await api('POST', `/credentials/${cred.id}/revoke`, { token: ath.token, body: { reason: 'nope' } })).status, 404);
  must(await api('POST', `/credentials/${cred.id}/revoke`, { token: c.owner.token, body: { reason: 'Issued in error' } }));
  assert.deepEqual([must(await api('GET', `/credentials/verify/${cred.code}`)).valid, must(await api('GET', `/credentials/verify/${cred.code}`)).status], [false, 'revoked']);
  assert.deepEqual(must(await api('GET', `/people/${ath.id}`)).credentials, []);
  assert.equal(must(await api('GET', '/me/credentials', { token: ath.token }))[0].status, 'revoked');
  assert.equal(must(await api('GET', `/organisations/${c.org.id}/credentials?status=revoked`, { token: c.owner.token })).length, 1);
  assert.equal((await api('GET', '/credentials/verify/GMG-NOSUCHCODE')).status, 404);
});

test('an archived institution is read-only for admissions, and young people cannot enquire on their own', async () => {
  const c = await college();
  const ath = await signup();
  const e = must(await api('POST', '/enquiries', { token: ath.token, body: { organisation_id: c.org.id, message: 'General question' } }), 201);
  must(await api('POST', `/organisations/${c.org.id}/archive`, { token: c.owner.token }));
  assert.equal((await api('POST', `/enquiries/${e.id}/messages`, { token: c.owner.token, body: { body: 'reply' } })).status, 409);
  assert.equal((await api('POST', '/enquiries', { token: (await signup()).token, body: { organisation_id: c.org.id, message: 'hello' } })).status, 404, 'archived institutions leave the directory');
  assert.equal(must(await api('GET', `/enquiries/${e.id}`, { token: ath.token })).messages.length, 1, 'history stays readable');
  const kid = await signup();
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [kid.id]);
  const c2 = await college();
  assert.equal((await api('POST', '/enquiries', { token: kid.token, body: { organisation_id: c2.org.id, message: 'hi' } })).status, 403);
});
