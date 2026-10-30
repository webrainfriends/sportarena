// Compliance policy layer (#568) on the compliance platform (#595): jurisdiction and "cannot be judged yet", precedence between rules of one topic,
// effective dates and history, the append-only decision trail, laws that need a second administrator, the dashboard statuses, the event gates and
// jurisdiction packs. Rules are data; nothing here is specific to a module.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { encrypt } = await import('../src/crypto.js');
const { gate } = await import('../src/compliance.js');
const { applicability, byPrecedence, settleTopics } = await import('../src/compliance-policy.js');

let server, base, n = 0, admin, admin2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const codeOf = (r) => r.body.error?.details?.code;
const person = async (roles = [], extra = {}) => {
  n++;
  const r = await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx,dob_enc) VALUES ($1,$2,$3,'x','x',$1,$4) RETURNING id", [`pp_${n}`, `Person ${n}`, roles, extra.dob ? encrypt(extra.dob, 'users.dob') : null]);
  return { id: r.rows[0].id, token: await signToken({ id: r.rows[0].id, roles }) };
};
const day = (d = 0) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const sportId = async (slug = 'football') => (await pool.query('SELECT id FROM sports WHERE slug=$1', [slug])).rows[0].id;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const mk = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
  admin = await mk('cpol_root'); admin2 = await mk('cpol_root2');
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
// tests share one database: platform rules from an earlier test are long archived (kept, but out of every later date)
beforeEach(async () => { await pool.query("UPDATE comp_requirements SET archived_at = now() - interval '400 days' WHERE scope_kind = 'platform' AND archived_at IS NULL"); });
after(async () => { server.close(); await pool.end(); });

/** An organisation whose address (and so the place of its events) is in `country`, and an event it organises. */
async function organiser(country, { region = null, city = null, status = 'draft', kind = 'tournament' } = {}) {
  const owner = await person();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Policy Club ${++n}`, kind: 'club' } }), 201);
  if (country) await pool.query("INSERT INTO addresses(owner_kind, owner_id, kind, country, region, locality, is_default) VALUES ('organisation',$1,'billing',$2,$3,$4,true)", [org.id, country, region, city]);
  const ev = (await pool.query("INSERT INTO events(name, sport_id, organizer_id, organisation_id, kind, status, starts_on) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [`Policy Event ${n}`, await sportId(), owner.id, org.id, kind, status, day(30)])).rows[0].id;
  return { owner, org, ev };
}
const platformReq = async (user, body = {}) => api('POST', '/compliance/requirements', { token: user.token, body: { scope_kind: 'platform', name: 'Fire safety permit', category: 'event_permit', subject_kind: 'event', method: 'evidence', ...body } });
const orgReq = async (user, org, body = {}) => api('POST', '/compliance/requirements', { token: user.token, body: { scope_kind: 'organisation', scope_id: org.id, name: 'Fire safety permit', category: 'event_permit', subject_kind: 'event', method: 'evidence', ...body } });
const obl = async (user, req, body = {}) => must(await api('POST', `/compliance/requirements/${req.id}/obligations`, { token: user.token, body: { consequences: ['event_open'], ...body } }), 201);
const evaluate = (user, body) => api('POST', '/compliance/evaluate', { token: user.token, body });
const open = (user, ev) => api('PATCH', `/events/${ev}`, { token: user.token, body: { status: 'open' } });
const itemOf = (r, name) => r.items.find((i) => i.requirement.name === name);

test('the catalogue offers classifications, outcomes, statuses, event types, jurisdictions and the new things a rule can block', async () => {
  const c = must(await api('GET', '/compliance/catalogue', { token: admin.token }));
  assert.deepEqual(c.classifications.map((x) => x.value), ['legal_mandatory', 'regulatory', 'federation_mandated', 'contractual', 'organisation_policy', 'recommended_standard']);
  assert.equal(c.classifications.find((x) => x.value === 'legal_mandatory').needs_second_approver, true);
  assert.deepEqual(c.outcomes, ['applies', 'does_not_apply', 'unknown', 'exception_required']);
  assert.ok(['compliant', 'expiring', 'pending', 'missing', 'exception', 'non_compliant'].every((s) => c.statuses.includes(s)));
  assert.ok(c.jurisdictions.some((j) => j.code === 'IN') && c.jurisdictions.length === 8);
  assert.ok(['event_open', 'event_start', 'tender_award'].every((v) => c.consequences.some((x) => x.value === v)));
});

test('applicability is pure: a dimension the facts cannot answer is unknown, never silently "does not apply"; a kind of subject without the fact is "no"', () => {
  const rule = { ob_country: 'IN', ob_region: null, ob_municipality: null, body_ids: [], competition_ids: [], venue_ids: [], event_types: ['tournament'], min_age: null, max_age: null };
  assert.equal(applicability(rule, { country: 'IN', event_type: 'tournament' }).result, 'yes');
  assert.equal(applicability(rule, { country: 'GB', event_type: 'tournament' }).result, 'no');
  const u = applicability(rule, { event_type: 'tournament' });
  assert.equal(u.result, 'unknown'); assert.deepEqual(u.unknown, ['country']);
  assert.equal(applicability({ ...rule, ob_country: null, event_types: [], min_age: 18 }, {}, ['age']).result, 'no', 'an event has no age');
  assert.equal(applicability({ ...rule, ob_country: null, event_types: [], min_age: 18 }, {}).result, 'unknown', 'a person without a date of birth on file');
  assert.equal(applicability({ ...rule, ob_country: null, event_types: [], min_age: 18 }, { age: 17 }).result, 'no');
});

test('precedence is deterministic: classification, then narrower jurisdiction, then specificity, then date, then version; a higher-ranked unknown is never skipped', () => {
  const base = { ob_id: 'a', ob_roles: [], body_ids: [], competition_ids: [], venue_ids: [], event_types: [], starts_on: '2026-01-01', version: 1, topic: 't', id: 'r1' };
  const law = { ...base, id: 'law', ob_id: 'o1', name: 'Law', classification: 'legal_mandatory', ob_country: 'IN', policy: { result: 'yes', no: [], unknown: [] } };
  const policy = { ...base, id: 'pol', ob_id: 'o2', name: 'Policy', classification: 'organisation_policy', ob_country: null, ob_region: null, ob_municipality: null, policy: { result: 'yes', no: [], unknown: [] } };
  assert.ok(byPrecedence(law, policy) < 0, 'the law outranks the policy');
  const city = { ...law, id: 'city', ob_id: 'o3', name: 'City', ob_municipality: 'Pune', ob_region: 'Maharashtra' };
  assert.ok(byPrecedence(city, law) < 0, 'the narrower jurisdiction wins within a class');
  const { kept, superseded } = settleTopics([law, policy]);
  assert.deepEqual(kept.map((r) => r.id), ['law']); assert.equal(superseded[0].by.id, 'law');
  const unknownLaw = { ...law, policy: { result: 'unknown', no: [], unknown: ['country'] } };
  const { kept: k2 } = settleTopics([unknownLaw, policy]);
  assert.equal(k2.length, 2); assert.equal(k2.find((r) => r.id === 'pol').policy.result, 'unknown', 'what the law says decides which applies, so the policy waits too');
  assert.equal(settleTopics([{ ...law, topic: null }, { ...policy, topic: null }]).kept.length, 2, 'no topic = no competition');
});

test('jurisdiction: a permit required in India blocks opening an Indian event, ignores a British one and cannot yet judge one with no country on record', async () => {
  const req = must(await platformReq(admin, { name: 'India fire permit' }), 201);
  await obl(admin, req, { country: 'IN' });
  const india = await organiser('IN'), britain = await organiser('GB'), nowhere = await organiser(null);

  const a = await open(india.owner, india.ev);
  assert.equal(a.status, 409); assert.equal(codeOf(a), 'compliance_blocked');
  assert.equal(a.body.error.details.blockers[0].rule, 'India fire permit');
  assert.match(a.body.error.details.explanation, /human reviewer/);

  must(await open(britain.owner, britain.ev));                                            // the rule names India: nothing in force here

  const u = await open(nowhere.owner, nowhere.ev);                                         // the rule names a country the event cannot answer
  assert.equal(u.status, 409);
  const ev = must(await evaluate(nowhere.owner, { subject_kind: 'event', subject_id: nowhere.ev }));
  const item = itemOf(ev, 'India fire permit');
  assert.equal(item.outcome, 'unknown'); assert.equal(item.state, 'unknown'); assert.deepEqual(item.policy.missing_facts, ['country']);
  assert.match(item.explanation, /cannot be judged yet/);
  // giving the organisation a country answers it
  await pool.query("INSERT INTO addresses(owner_kind, owner_id, kind, country, is_default) VALUES ('organisation',$1,'billing','GB',true)", [nowhere.org.id]);
  const ok = must(await evaluate(nowhere.owner, { subject_kind: 'event', subject_id: nowhere.ev }));
  assert.equal(ok.items.length, 0); assert.equal(ok.excluded[0].outcome, 'does_not_apply'); assert.match(ok.excluded[0].reason, /country/);
  assert.equal(ok.facts.values.country, 'GB'); assert.equal(ok.facts.sources.country, 'organisation address');

  // meeting it opens the event: the organiser submits the permit and the platform team reviews it
  const rec = must(await api('POST', '/compliance/records', { token: india.owner.token, body: { requirement_id: req.id, subject_kind: 'event', subject_id: india.ev, reference: 'FP-2026-1', issued_on: day(-1), expires_on: day(300) } }), 201);
  assert.equal((await open(india.owner, india.ev)).status, 409, 'submitted is not yet reviewed');
  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: admin.token, body: { decision: 'approve' } }));
  must(await open(india.owner, india.ev));
});

test('a recommended standard advises: it is shown, never blocks, and an event with only advice opens', async () => {
  const org = await organiser('IN');
  const req = must(await orgReq(org.owner, org.org, { name: 'Accessibility checklist', classification: 'recommended_standard' }), 201);
  await obl(org.owner, req);
  const e = must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, consequence: 'event_open' }));
  const item = itemOf(e, 'Accessibility checklist');
  assert.equal(item.status, 'missing'); assert.equal(item.blocking, false); assert.equal(e.decision, 'clear');
  must(await open(org.owner, org.ev));
});

test('a law outranks an organisation policy on the same topic; the policy is shown as overridden, with why', async () => {
  const org = await organiser('IN');
  const law = must(await platformReq(admin, { name: 'Venue safety law', classification: 'legal_mandatory', topic: 'venue_safety' }), 201);
  assert.equal(law.approval_status, 'pending_approval');
  await obl(admin, law, { country: 'IN', consequences: [] });
  const pol = must(await orgReq(org.owner, org.org, { name: 'Our safety policy', topic: 'venue_safety' }), 201);
  await obl(org.owner, pol, { consequences: [] });

  // a law waits for a second administrator: until then it applies to no one
  let e = must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev }));
  assert.deepEqual(e.items.map((i) => i.requirement.name), ['Our safety policy']);
  assert.equal((await api('POST', `/compliance/requirements/${law.id}/approval`, { token: admin.token, body: { decision: 'approve' } })).status, 403, 'not the person who wrote it');
  assert.equal((await api('POST', `/compliance/requirements/${law.id}/approval`, { token: org.owner.token, body: { decision: 'approve' } })).status, 404, 'not an organisation');
  must(await api('POST', `/compliance/requirements/${law.id}/approval`, { token: admin2.token, body: { decision: 'approve' } }));

  e = must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev }));
  assert.deepEqual(e.items.map((i) => i.requirement.name), ['Venue safety law']);
  assert.equal(e.items[0].policy.classification, 'legal_mandatory');
  const over = e.excluded.find((x) => x.requirement.name === 'Our safety policy');
  assert.equal(over.outcome, 'does_not_apply'); assert.equal(over.superseded_by.classification, 'legal_mandatory'); assert.match(over.reason, /Overridden for topic "venue_safety"/);
  assert.match(e.explanation.text, /overridden by a higher-ranked rule/);

  // a law is never waivable and is not edited once approved
  const w = await api('POST', '/compliance/waivers', { token: admin.token, body: { requirement_id: law.id, subject_kind: 'event', subject_id: org.ev, reason: 'We would rather not', effective_to: day(30) } });
  assert.equal(w.status, 409); assert.equal(codeOf(w), 'not_waivable');
  const edit = await api('POST', '/compliance/requirements', { token: admin.token, body: { requirement_id: law.id, scope_kind: 'platform', name: 'Venue safety law', category: 'event_permit', subject_kind: 'event', method: 'evidence', validity_days: 30 } });
  assert.equal(edit.status, 409); assert.equal(codeOf(edit), 'law_not_editable');
  // classes are authored by the right scope
  assert.equal((await orgReq(org.owner, org.org, { name: 'Pretend law', classification: 'legal_mandatory' })).status, 400);
  assert.equal((await platformReq(admin, { name: 'Not a federation', classification: 'federation_mandated' })).status, 400);
});

test('effective dates and history: the rules of a date are the rules in force then; a repeal is an end date; wording is the version saved by then', async () => {
  const org = await organiser('IN');
  const req = must(await orgReq(org.owner, org.org, { name: 'Dated permit', validity_days: 365 }), 201);
  const o = await obl(org.owner, req, { starts_on: day(10), consequences: [] });
  const before = must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, as_of: day(5) }));
  const after = must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, as_of: day(20) }));
  assert.equal(before.items.length, 0, 'not yet in force'); assert.equal(after.items.length, 1);
  assert.equal(after.items[0].policy.effective_from, day(10));

  // end it: from that date it no longer applies, but an earlier date still shows it
  must(await api('POST', `/compliance/requirements/${req.id}/obligations`, { token: org.owner.token, body: { obligation_id: o.id, starts_on: day(10), ends_on: day(15), consequences: [] } }), 201);
  assert.equal(must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, as_of: day(20) })).items.length, 0);
  assert.equal(must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, as_of: day(12) })).items.length, 1);

  // wording: version 2 replaces version 1 today, and a date before it shows version 1
  await pool.query("UPDATE comp_requirement_versions SET changed_at = now() - interval '40 days' WHERE requirement_id=$1 AND version=1", [req.id]);
  must(await orgReq(org.owner, org.org, { requirement_id: req.id, name: 'Dated permit', validity_days: 90 }), 201);
  const o2 = await obl(org.owner, req, { starts_on: day(-60), consequences: [] });
  assert.ok(o2.id);
  const old = must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, as_of: day(-20) }));
  const now = must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, as_of: day(0) }));
  assert.equal(itemOf(old, 'Dated permit').requirement.version, 1); assert.equal(itemOf(old, 'Dated permit').requirement.validity_days, 365);
  assert.equal(itemOf(now, 'Dated permit').requirement.version, 2); assert.equal(itemOf(now, 'Dated permit').requirement.validity_days, 90);
  // archived rules are kept for the dates they were in force
  must(await api('POST', `/compliance/requirements/${req.id}/archive`, { token: org.owner.token, body: {} }));
  assert.equal(must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, as_of: day(-20) })).items.length >= 1, true);
  assert.equal(must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, as_of: day(0) })).items.length, 0);
});

test('age bands: a person with no date of birth cannot be judged yet; with one, the age on the date decides; the date of birth is never kept', async () => {
  const org = await organiser('IN');
  const req = must(await orgReq(org.owner, org.org, { name: 'Adult declaration', subject_kind: 'person', category: 'declaration', method: 'declaration', statement: 'I am an adult.' }), 201);
  await obl(org.owner, req, { consequences: ['registration'], min_age: 18, roles: [] });
  const nobirth = await person(), adult = await person([], { dob: '1990-05-05' }), kid = await person([], { dob: `${new Date().getUTCFullYear() - 12}-01-01` });
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,'coach','active',now()),($1,$3,'coach','active',now()),($1,$4,'coach','active',now())", [org.org.id, nobirth.id, adult.id, kid.id]);
  const st = async (u) => must(await api('GET', '/compliance/status', { token: u.token }));
  const a = itemOf(await st(nobirth), 'Adult declaration');
  assert.equal(a.state, 'unknown'); assert.deepEqual(a.policy.missing_facts, ['age']);
  assert.equal((await st(adult)).items.length, 1, 'an adult is asked'); assert.equal(itemOf(await st(adult), 'Adult declaration').state, 'missing');
  assert.equal((await st(kid)).items.length, 0, 'a twelve-year-old is not asked');
  // the adult reads were audited and only the age is kept in a decision
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_dob_compliance' AND entity_id=$1", [adult.id])).rowCount);
  const g = await gate(pool, adult.id, 'registration', { organisation_id: org.org.id });
  assert.equal(g.decision, 'blocked');
});

test('the decision trail is append-only: a refused opening is kept with its facts and rules, an allowed one too, and nothing can be edited or deleted', async () => {
  const org = await organiser('IN');
  const req = must(await orgReq(org.owner, org.org, { name: 'Trail permit' }), 201);
  await obl(org.owner, req);
  assert.equal((await open(org.owner, org.ev)).status, 409);
  const list = must(await api('GET', '/compliance/decisions', { token: org.owner.token, query: { event_id: org.ev } }));
  assert.equal(list.items.length, 1); assert.equal(list.items[0].consequence, 'event_open'); assert.equal(list.items[0].blocked, true); assert.equal(list.items[0].blockers, 1);
  const d = must(await api('GET', `/compliance/decisions/${list.items[0].id}`, { token: org.owner.token }));
  assert.equal(d.results.items[0].name, 'Trail permit'); assert.equal(d.results.items[0].version, 1); assert.equal(d.results.items[0].classification, 'organisation_policy');
  assert.equal(JSON.stringify(d).includes('dob'), false, 'no date of birth');
  // outsiders get a 404, not a hint
  const stranger = await person();
  assert.equal((await api('GET', `/compliance/decisions/${d.id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', '/compliance/decisions', { token: stranger.token, query: { event_id: org.ev } })).status, 404);
  await assert.rejects(pool.query("UPDATE comp_decisions SET blocked=false WHERE id=$1", [d.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM comp_decisions WHERE id=$1', [d.id]), /append-only/);
  await assert.rejects(pool.query('TRUNCATE comp_decisions'), /append-only/);
  // a manager can keep an evaluation; a holder cannot
  const kept = must(await evaluate(org.owner, { subject_kind: 'event', subject_id: org.ev, record: true }));
  assert.ok(kept.decision_id);
  assert.equal((await evaluate(stranger, { subject_kind: 'event', subject_id: org.ev, record: true })).status, 404);
});

test('starting an event is a gate too; a rule written for opening does not stop it from starting, and the dashboard counts every status', async () => {
  const org = await organiser('IN', { status: 'open' });
  const req = must(await orgReq(org.owner, org.org, { name: 'Start-day medical plan' }), 201);
  await obl(org.owner, req, { consequences: ['event_start'] });
  const stop = await api('PATCH', `/events/${org.ev}`, { token: org.owner.token, body: { status: 'ongoing' } });
  assert.equal(stop.status, 409); assert.equal(codeOf(stop), 'compliance_blocked');
  const gaps = must(await api('GET', '/compliance/gaps', { token: org.owner.token, query: { scope_kind: 'organisation', scope_id: org.org.id, subject_kind: 'event', attention_only: 'false' } }));
  assert.equal(gaps.dashboard.missing, 1); assert.equal(gaps.dashboard.compliant, 0);
  const rec = must(await api('POST', '/compliance/records', { token: org.owner.token, body: { requirement_id: req.id, subject_kind: 'event', subject_id: org.ev, reference: 'MP-1', issued_on: day(-1), expires_on: day(60) } }), 201);
  must(await api('POST', `/compliance/records/${rec.id}/decision`, { token: admin.token, body: { decision: 'approve' } }));
  must(await api('PATCH', `/events/${org.ev}`, { token: org.owner.token, body: { status: 'ongoing' } }));
  const after = must(await api('GET', '/compliance/gaps', { token: org.owner.token, query: { scope_kind: 'organisation', scope_id: org.org.id, subject_kind: 'event', attention_only: 'false' } }));
  assert.equal(after.dashboard.expiring, 1, 'valid for 60 more days, inside the reminder window'); assert.equal(after.subjects[0].decision, 'clear');
});

test('federation eligibility: a competition-limited, country-limited rule applies to that competition only (registration reads the same engine)', async () => {
  const a = await organiser('IN'), b = await organiser('IN');
  const req = must(await orgReq(a.owner, a.org, { name: 'Entry declaration', subject_kind: 'person', category: 'declaration', method: 'declaration', statement: 'I accept the entry rules.' }), 201);
  await obl(a.owner, req, { consequences: ['registration'], competition_ids: [a.ev], country: 'IN' });
  const p = await person();
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,'coach','active',now())", [a.org.id, p.id]);
  assert.equal((await gate(pool, p.id, 'registration', { event_id: a.ev, organisation_id: a.org.id })).decision, 'blocked', 'that competition');
  assert.equal((await gate(pool, p.id, 'registration', { event_id: b.ev, organisation_id: a.org.id })).decision, 'clear', 'another competition of the same club');
});

test('jurisdiction packs: export a scope\'s rules, import them elsewhere (checked first, idempotent), laws arrive waiting for approval; bad packs import nothing', async () => {
  const src = await organiser('IN'), dst = await organiser('IN');
  const r1 = must(await orgReq(src.owner, src.org, { name: 'Pack insurance', topic: 'insurance', category: 'insurance', source_title: 'Local rules', approval_owner: 'Club board' }), 201);
  await obl(src.owner, r1, { country: 'IN', region: 'Maharashtra', event_types: ['tournament'], consequences: ['event_open'], sport_id: await sportId('cricket') });
  const pack = must(await api('GET', '/compliance/rules/export', { token: src.owner.token, query: { scope_kind: 'organisation', scope_id: src.org.id } }));
  assert.equal(pack.format, 'sportarena.compliance-rules/1'); assert.equal(pack.rules.length, 1);
  assert.equal(pack.rules[0].obligations[0].sport, 'cricket'); assert.equal(pack.rules[0].obligations[0].country, 'IN'); assert.equal(pack.rules[0].topic, 'insurance');
  assert.equal(JSON.stringify(pack).includes(src.org.id), false, 'a pack carries no ids of this platform');

  const first = must(await api('POST', '/compliance/rules/import', { token: dst.owner.token, body: { scope_kind: 'organisation', scope_id: dst.org.id, pack } }), 201);
  assert.deepEqual(first.created.map((x) => x.code), ['pack_insurance']);
  const second = must(await api('POST', '/compliance/rules/import', { token: dst.owner.token, body: { scope_kind: 'organisation', scope_id: dst.org.id, pack } }), 201);
  assert.deepEqual(second.skipped, ['pack_insurance']); assert.equal(second.created.length, 0);
  const listed = must(await api('GET', '/compliance/requirements', { token: dst.owner.token, query: { scope_kind: 'organisation', scope_id: dst.org.id } }));
  assert.equal(listed.requirements.length, 1); assert.equal(listed.requirements[0].obligations[0].region, 'Maharashtra'); assert.equal(listed.requirements[0].classification, 'organisation_policy');

  // a bad rule stops the whole pack; a law arrives pending
  const bad = { ...pack, rules: [{ ...pack.rules[0], code: 'fresh_rule' }, { ...pack.rules[0], code: 'broken', classification: 'legal_mandatory' }] };
  const refused = await api('POST', '/compliance/rules/import', { token: dst.owner.token, body: { scope_kind: 'organisation', scope_id: dst.org.id, pack: bad } });
  assert.equal(refused.status, 400);
  assert.equal(must(await api('GET', '/compliance/requirements', { token: dst.owner.token, query: { scope_kind: 'organisation', scope_id: dst.org.id } })).requirements.length, 1, 'nothing was imported');
  assert.equal((await api('POST', '/compliance/rules/import', { token: (await person()).token, body: { scope_kind: 'organisation', scope_id: dst.org.id, pack } })).status, 404);
  const lawPack = { format: pack.format, rules: [{ ...pack.rules[0], code: 'imported_law', name: 'Imported law', classification: 'regulatory', obligations: [] }] };
  const law = must(await api('POST', '/compliance/rules/import', { token: admin.token, body: { scope_kind: 'platform', pack: lawPack } }), 201);
  assert.equal(law.created[0].approval_status, 'pending_approval');
});

test('every sport in the catalogue can be named by a rule (the policy layer never reads a sport itself)', async () => {
  const org = await organiser('IN');
  const req = must(await orgReq(org.owner, org.org, { name: 'Sport-specific briefing', subject_kind: 'person', category: 'declaration', method: 'declaration', statement: 'I have read the briefing.' }), 201);
  const sports = (await pool.query('SELECT id, slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length >= 200);
  for (const s of sports) await obl(org.owner, req, { consequences: [], sport_id: s.id, country: 'IN' });
  const listed = must(await api('GET', '/compliance/requirements', { token: org.owner.token, query: { scope_kind: 'organisation', scope_id: org.org.id } }));
  assert.equal(listed.requirements[0].obligations.length, sports.length);
});
