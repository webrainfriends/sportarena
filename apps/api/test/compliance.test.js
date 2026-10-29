import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const E = await import('../src/compliance/engine.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base, n = 0, admin, admin2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cm_${n}_${roles[0]}`, display_name: `Cmp ${n}`, email: `cm${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const platformAdmin = async (handle, email) => {
  const r = await api('POST', '/auth/register', { body: { handle, display_name: handle, email, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [r.body.user.id]);
  return { id: r.body.user.id, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await platformAdmin('cmp_boss_one', 'rraja.edge@gmail.com');
  admin2 = await platformAdmin('cmp_boss_two', 'rrajas1978@icloud.com');
});
after(async () => { server.close(); await pool.end(); });

/** A platform rule written by one admin and approved by the other. */
const rule = async (over = {}) => {
  const body = {
    key: `rule.${++n}`, scope: 'platform', domains: ['event_permit'], topic: `topic.${n}`, title: 'Public assembly permit', classification: 'legal_mandatory', country: 'IN',
    effective_from: day(-30), approval_owner: 'Legal counsel, India', source_title: 'Local public-assembly bylaw', source_url: 'https://example.org/bylaw',
    requirements: [{ key: 'permit', kind: 'permit', label: 'Public assembly permit', holder: 'event' }], ...over,
  };
  const r = must(await api('POST', '/compliance/rules', { token: admin.token, body }), 201);
  must(await api('POST', `/compliance/versions/${r.version_id}/decision`, { token: admin2.token, body: { decision: 'approve' } }));
  return { ...r, body };
};
const addr = (kind, id, a) => pool.query('INSERT INTO addresses(owner_kind, owner_id, kind, locality, region, country, is_default) VALUES ($1,$2,$3,$4,$5,$6,true)', [kind, id, kind === 'venue' ? 'venue' : 'other', a.locality ?? null, a.region ?? null, a.country ?? null]);
/** An event whose venue sits in a place, so jurisdiction rules can be judged. */
const placedEvent = async (org, place = { country: 'IN', region: 'Maharashtra', locality: 'Mumbai' }, extra = {}) => {
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cmp Cup ${++n}`, sport: 'football', starts_on: day(10), ends_on: day(12), ...extra } }), 201);
  const v = (await pool.query("INSERT INTO venues(name, city, owner_id) VALUES ($1,$2,$3) RETURNING id", [`Ground ${n}`, place.locality, org.id])).rows[0];
  await addr('venue', v.id, place);
  await pool.query('UPDATE events SET venue_id=$2 WHERE id=$1', [ev.id, v.id]);
  return ev;
};
const evalPerson = (u, p, ev, domain = 'federation_eligibility') => api('POST', '/compliance/evaluate', { token: u.token, body: { subject_type: 'person', subject_id: p.id, event_id: ev.id, domain } });
const evalEvent = (org, ev, extra = {}) => api('POST', '/compliance/evaluate', { token: org.token, body: { subject_type: 'event', subject_id: ev.id, ...extra } });

// ------------------------------------------------------------------ the pure engine
test('engine: applicability says unknown when a fact is missing, never silently "does not apply"', () => {
  const v = { country: 'IN', region: 'Maharashtra', applies: { roles: ['media'], min_age: 18 } };
  assert.equal(E.applicability(v, { country: 'IN', region: 'maharashtra', roles: ['media'], age: 30 }).result, 'yes');
  assert.deepEqual(E.applicability(v, { country: 'IN', roles: ['media'], age: 30 }).unknown, ['state or province']);
  assert.equal(E.applicability(v, { country: 'US', region: 'Maharashtra', roles: ['media'], age: 30 }).result, 'no');
  assert.equal(E.applicability(v, { country: 'IN', region: 'Maharashtra', roles: ['media'], age: 12 }).result, 'no');
  assert.equal(E.applicability(v, { country: 'IN', region: 'Maharashtra', roles: [], age: 30 }).result, 'no', 'a known-empty role list is a "no"');
  assert.equal(E.applicability({ applies: { roles: ['x'] } }, {}, ['roles']).result, 'no', 'an event has no role to judge');
});

test('engine: precedence ranks classification, then jurisdiction, then specificity, then date and version', () => {
  const base = { rule_id: 'r', key: 'k', version: 1, effective_from: '2026-01-01', applies: {} };
  const legal = { ...base, classification: 'legal_mandatory', country: 'IN' }, city = { ...legal, municipality: 'Mumbai', region: 'MH' }, org = { ...base, classification: 'organisation_policy' };
  assert.ok(E.byPrecedence(legal, org) < 0);
  assert.ok(E.byPrecedence(city, legal) < 0, 'the narrower jurisdiction wins within a class');
  assert.ok(E.byPrecedence({ ...legal, effective_from: '2026-06-01' }, legal) < 0, 'then the later effective date');
  assert.ok(E.byPrecedence({ ...legal, version: 2 }, legal) < 0, 'then the higher version');
});

test('engine: versions are chosen by effective date and a repeal removes the rule', () => {
  const v = (version, from, to, extra = {}) => ({ rule_id: 'r1', version, status: 'approved', effective_from: from, effective_to: to, ...extra });
  const vs = [v(1, '2026-01-01', null), v(2, '2027-01-01', null), v(3, '2028-01-01', null, { repeals: true }), v(4, '2025-01-01', null, { status: 'draft' })];
  assert.equal(E.inForce(vs, '2026-06-01')[0].version, 1);
  assert.equal(E.inForce(vs, '2027-06-01')[0].version, 2, 'history is kept: asking for 2026 still gives version 1');
  assert.equal(E.inForce(vs, '2028-06-01').length, 0);
  assert.equal(E.inForce(vs, '2024-06-01').length, 0, 'a draft never applies');
});

test('engine: evidence status is pending until reviewed, expiring near the end, non-compliant when expired', () => {
  const req = { key: 'p', kind: 'permit', label: 'Permit', warn_days: 30 };
  const j = (items, cover = '2026-06-10') => E.judgeRequirement(req, items, { ref: '2026-06-01', cover }).status;
  assert.equal(j([]), 'missing');
  assert.equal(j([{ kind: 'permit', status: 'submitted' }]), 'pending');
  assert.equal(j([{ kind: 'permit', status: 'verified', valid_to: '2026-12-31' }]), 'compliant');
  assert.equal(j([{ kind: 'permit', status: 'verified', valid_to: '2026-06-20' }]), 'expiring');
  assert.equal(j([{ kind: 'permit', status: 'verified', valid_to: '2026-06-05' }]), 'non_compliant');
  assert.equal(j([{ kind: 'permit', status: 'rejected' }]), 'non_compliant');
  assert.equal(j([{ kind: 'training', status: 'verified' }]), 'missing', 'another kind of evidence does not count');
  assert.equal(E.judgeRequirement({ ...req, max_age_days: 365 }, [{ kind: 'permit', status: 'verified', issued_on: '2024-01-01' }], { ref: '2026-06-01', cover: '2026-06-10' }).status, 'non_compliant', 'too old');
});

test('engine: an explanation never says anyone is legally compliant', () => {
  const results = [{ outcome: 'applies', status: 'missing', title: 'Permit', classification: 'legal_mandatory', requirements: [{ label: 'Permit', status: 'missing', detail: 'No evidence on record' }] }];
  const x = E.explain(results, E.summarise(results));
  assert.equal(x.assertion, 'none');
  assert.doesNotMatch(x.text, /you are (legally )?compliant|is compliant|are compliant/i);
  assert.match(x.text, /human reviewer/);
});

// ------------------------------------------------------------------ authoring
test('the library: platform rules need the platform admin, laws need a second approver, versions are immutable and never deleted', async () => {
  const org = await signup(['organizer']);
  const body = { key: `lib.${++n}`, scope: 'platform', domains: ['event_permit'], topic: 'lib.topic', title: 'Fire safety certificate', classification: 'regulatory', country: 'SG', effective_from: day(-5), approval_owner: 'Counsel, Singapore' };
  assert.equal((await api('POST', '/compliance/rules', { token: org.token, body })).status, 403, 'not the platform admin');
  const r = must(await api('POST', '/compliance/rules', { token: admin.token, body }), 201);
  assert.equal(r.status, 'draft');
  assert.equal((await api('POST', `/compliance/versions/${r.version_id}/decision`, { token: admin.token, body: { decision: 'approve' } })).status, 409, 'a law is not approved by its author');
  assert.equal((await api('POST', `/compliance/versions/${r.version_id}/decision`, { token: org.token, body: { decision: 'approve' } })).status, 403);
  const done = must(await api('POST', `/compliance/versions/${r.version_id}/decision`, { token: admin2.token, body: { decision: 'approve' } }));
  assert.equal(done.status, 'approved'); assert.equal(done.self_approved, false);
  assert.equal((await api('POST', `/compliance/versions/${r.version_id}/decision`, { token: admin2.token, body: { decision: 'withdraw' } })).status, 409, 'already approved');
  await assert.rejects(pool.query("UPDATE cmp_rule_versions SET title='Changed' WHERE id=$1", [r.version_id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM cmp_rule_versions WHERE id=$1', [r.version_id]), /never deleted/);
  await assert.rejects(pool.query('DELETE FROM cmp_rules WHERE id=$1', [r.rule_id]), /never deleted/);
  // a change is a new version
  const v2 = must(await api('POST', '/compliance/rules', { token: admin.token, body: { ...body, rule_id: r.rule_id, title: 'Fire safety certificate (2027)', effective_from: day(300) } }), 201);
  assert.equal(v2.version, 2);
  const one = must(await api('GET', `/compliance/rules/${r.rule_id}`, { token: org.token }));
  assert.deepEqual(one.versions.map((v) => v.version), [1], 'drafts are visible only to those who can approve them');
  assert.equal(one.can_manage, false);
  assert.equal(must(await api('GET', `/compliance/rules/${r.rule_id}`, { token: admin.token })).versions.length, 2);
  const list = must(await api('GET', '/compliance/rules', { token: org.token, query: { country: 'SG' } }));
  assert.ok(list.some((x) => x.id === r.rule_id && x.current?.version === 1 && x.upcoming === null), 'the draft is not scheduled');
});

test('the library: classification follows who may author it; laws cannot be waivable; federation rules are not authored here', async () => {
  const owner = await signup(['organizer']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Club ${++n}`, kind: 'club' } }), 201);
  const base = { key: `org.${++n}`, scope: 'organisation', organisation_id: org.id, domains: ['event_permit'], topic: 'org.topic', title: 'Club insurance policy', classification: 'organisation_policy', effective_from: day(), approval_owner: 'Club board', waivable: true };
  assert.equal((await api('POST', '/compliance/rules', { token: owner.token, body: { ...base, classification: 'legal_mandatory', waivable: false } })).status, 400, 'an organisation cannot write a law');
  assert.equal((await api('POST', '/compliance/rules', { token: owner.token, body: { ...base, classification: 'federation_mandated' } })).status, 400);
  assert.equal((await api('POST', '/compliance/rules', { token: admin.token, body: { ...base, scope: 'platform', organisation_id: undefined, classification: 'regulatory' } })).status, 400, 'a regulation is never waivable by a person');
  const stranger = await signup(['organizer']);
  assert.equal((await api('POST', '/compliance/rules', { token: stranger.token, body: base })).status, 403);
  const r = must(await api('POST', '/compliance/rules', { token: owner.token, body: base }), 201);
  const d = must(await api('POST', `/compliance/versions/${r.version_id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  assert.equal(d.self_approved, true, 'an organisation may approve its own policy; it is recorded');
  assert.equal((await api('GET', `/compliance/rules/${r.rule_id}`, { token: stranger.token })).status, 404, "another organisation's rules are not visible");
  const cat = must(await api('GET', '/compliance/catalogue', { token: owner.token }));
  assert.deepEqual(cat.jurisdictions.map((j) => j.code), ['IN', 'US', 'CA', 'SG', 'MY', 'LK', 'AU', 'GB']);
  assert.ok(cat.domains.some((x) => x.key === 'procurement') && cat.evidence_kinds.includes('background_check'));
});

test('packs: a jurisdiction pack is data. It loads as drafts, applies only once approved, and exports again', async () => {
  const pack = { pack_code: 'LK-2026', rules: [
    { key: `lk.pack.${++n}`, domains: ['event_permit'], topic: 'lk.assembly', title: 'Police notification for public events', classification: 'regulatory', country: 'LK', effective_from: day(-1), approval_owner: 'Counsel, Sri Lanka', requirements: [{ key: 'notice', kind: 'approval', label: 'Police notification acknowledged', holder: 'event' }] },
    { key: `lk.pack.${++n}`, domains: ['accreditation'], topic: 'lk.accr', title: 'Background check for staff', classification: 'recommended_standard', country: 'LK', effective_from: day(-1), approval_owner: 'Counsel, Sri Lanka', requirements: [] },
  ] };
  assert.equal((await api('POST', '/compliance/packs', { token: (await signup(['organizer'])).token, body: pack })).status, 403);
  const r = must(await api('POST', '/compliance/packs', { token: admin.token, body: pack }), 201);
  assert.equal(r.drafts, 2);
  const org = await signup(['organizer']);
  const ev = await placedEvent(org, { country: 'LK', locality: 'Colombo', region: 'Western' });
  const before_ = must(await evalEvent(org, ev));
  assert.equal(before_.results.filter((x) => x.pack).length, 0);
  assert.ok(!before_.results.some((x) => x.title === 'Police notification for public events'), 'a draft has no effect');
  must(await api('POST', `/compliance/versions/${r.versions[0].version_id}/decision`, { token: admin2.token, body: { decision: 'approve' } }));
  const after_ = must(await evalEvent(org, ev));
  assert.equal(after_.results.find((x) => x.title === 'Police notification for public events').outcome, 'applies');
  const exp = must(await api('GET', '/compliance/packs/LK', { token: org.token }));
  assert.ok(exp.rules.some((x) => x.title === 'Police notification for public events') && !exp.rules.some((x) => x.title === 'Background check for staff'), 'only approved rules are exported');
  assert.match(exp.note, /not legal advice/);
});

// ------------------------------------------------------------------ event permits
test('event permits: jurisdiction and precedence decide which rule governs; unknown facts are surfaced, never assumed', async () => {
  const org = await signup(['organizer']);
  const tag = `perm${++n}`;
  const national = await rule({ topic: tag, title: 'National assembly permit', country: 'IN' });
  const city = await rule({ topic: tag, title: 'Mumbai municipal permit', country: 'IN', region: 'Maharashtra', municipality: 'Mumbai', requirements: [{ key: 'bmc', kind: 'permit', label: 'Municipal permit', holder: 'event' }] });
  await rule({ topic: `${tag}.us`, title: 'US permit', country: 'US' });
  const ev = await placedEvent(org);
  const out = must(await evalEvent(org, ev));
  const by = Object.fromEntries(out.results.map((r) => [r.title, r]));
  assert.equal(by['Mumbai municipal permit'].outcome, 'applies');
  assert.equal(by['Mumbai municipal permit'].status, 'missing');
  assert.equal(by['National assembly permit'].outcome, 'does_not_apply');
  assert.equal(by['National assembly permit'].superseded_by.title, 'Mumbai municipal permit', 'the narrower jurisdiction overrides within the topic');
  assert.equal(by['US permit'].outcome, 'does_not_apply');
  assert.equal(out.facts.values.country, 'IN'); assert.equal(out.facts.sources.country, 'venue address');
  assert.equal(out.summary.overall, 'missing'); assert.equal(out.summary.blocked, true);
  assert.equal(out.explanation.assertion, 'none');
  // an event whose place is unknown cannot be judged against a place-specific rule
  const bare = must(await api('POST', '/events', { token: org.token, body: { name: `Bare ${++n}`, sport: 'football', starts_on: day(10), ends_on: day(11) } }), 201);
  const unk = must(await evalEvent(org, bare));
  const u = unk.results.find((r) => r.title === 'National assembly permit');
  assert.equal(u.outcome, 'unknown'); assert.ok(u.missing_facts.includes('country'), 'it says which fact is missing');
  assert.equal(unk.summary.blocked, true, 'unknown blocks a gate: the engine will not guess');
  // nobody but the people who run the event can ask
  assert.equal((await evalEvent(await signup(['organizer']), ev)).status, 404);
  assert.equal((await api('POST', '/compliance/evaluate', { body: { subject_type: 'event', subject_id: ev.id } })).status, 401);
  assert.equal(national.version, 1);
});

test('event permits: the same rules govern opening and starting an event; evidence is reviewed by a second person; every attempt is audited', async () => {
  const org = await signup(['organizer']);
  await rule({ topic: `start${++n}`, title: 'Venue fire certificate', country: 'AU', classification: 'regulatory', requirements: [{ key: 'fire', kind: 'certificate', label: 'Fire safety certificate', holder: 'venue' }] });
  const ev = await placedEvent(org, { country: 'AU', region: 'NSW', locality: 'Sydney' });
  const blocked = await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.code, 'compliance_blocked');
  assert.equal(blocked.body.error.details.blockers[0].title, 'Venue fire certificate');
  assert.equal((await pool.query('SELECT status FROM events WHERE id=$1', [ev.id])).rows[0].status, 'open', 'nothing changed');
  const trail = must(await api('GET', '/compliance/decisions', { token: org.token, query: { event_id: ev.id, blocked: 'true' } }));
  assert.equal(trail.length, 1, 'the refused attempt is on record even though its transaction rolled back');
  assert.equal(trail[0].trigger, 'event_start'); assert.equal(trail[0].decided_by, org.id);
  // the venue's certificate is filed for this event and waits for a reviewer
  const venueId = (await pool.query('SELECT venue_id FROM events WHERE id=$1', [ev.id])).rows[0].venue_id;
  const filed = must(await api('POST', '/compliance/evidence', { token: org.token, body: { holder_type: 'venue', holder_id: venueId, event_id: ev.id, kind: 'certificate', title: 'Fire certificate FC-77', reference: 'FC-77/2026', issuer: 'NSW Fire', valid_to: day(200) } }), 201);
  assert.equal(filed.status, 'submitted');
  assert.equal(must(await evalEvent(org, ev)).results.find((r) => r.title === 'Venue fire certificate').status, 'pending', 'an uploaded document is not proof');
  assert.equal((await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } })).status, 409);
  // the person who filed it cannot review it; a stranger cannot see it; the platform team can
  assert.equal((await api('POST', `/compliance/evidence/${filed.id}/review`, { token: org.token, body: { decision: 'verify', verified_what: 'Original seen at the venue office' } })).status, 404);
  assert.equal((await api('POST', `/compliance/evidence/${filed.id}/review`, { token: (await signup(['organizer'])).token, body: { decision: 'verify', verified_what: 'Original seen' } })).status, 404);
  assert.equal((await api('POST', `/compliance/evidence/${filed.id}/review`, { token: admin.token, body: { decision: 'verify' } })).status, 400, 'say what you checked');
  must(await api('POST', `/compliance/evidence/${filed.id}/review`, { token: admin.token, body: { decision: 'verify', verified_what: 'Original certificate seen; number matches the NSW register' } }));
  const opened = must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } }));
  assert.equal(opened.status, 'ongoing');
  const trail2 = must(await api('GET', '/compliance/decisions', { token: org.token, query: { event_id: ev.id } }));
  assert.equal(trail2.length, 3, 'two refused attempts and the one that went through'); assert.equal(trail2[0].blocked, false); assert.equal(trail2[0].overall, 'compliant');
  assert.deepEqual(trail2.slice(1).map((d) => d.blocked), [true, true]);
  const full = must(await api('GET', `/compliance/decisions/${trail2[0].id}`, { token: org.token }));
  const r0 = full.results.find((r) => r.title === 'Venue fire certificate');
  assert.equal(r0.version, 1); assert.ok(r0.requirements[0].evidence_id === filed.id, 'the evidence relied on is named');
  assert.equal(full.facts.values.country, 'AU'); assert.equal(full.facts.sources.country, 'venue address');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='compliance_evidence_verified' AND entity_id=$1", [filed.id])).rowCount === 1);
  // the reference number: holder side and reviewers only, and every reveal is logged
  const mine = must(await api('GET', '/compliance/evidence', { token: org.token, query: { holder_type: 'venue', holder_id: venueId, event_id: ev.id } }));
  assert.equal(mine[0].reference, 'FC-77/2026');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_compliance_reference'")).rowCount >= 1);
  assert.equal((await api('GET', '/compliance/evidence', { token: (await signup(['organizer'])).token, query: { holder_type: 'venue', holder_id: venueId } })).status, 404);
  // reviewed evidence is never edited
  await assert.rejects(pool.query("UPDATE cmp_evidence SET title='x' WHERE id=$1", [filed.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM cmp_evidence WHERE id=$1', [filed.id]), /never deleted/);
});

test('event permits: expired evidence is non-compliant, a later rule version changes the answer for later dates only, and history is retained', async () => {
  const org = await signup(['organizer']);
  const tag = `hist${++n}`;
  const v1 = await rule({ topic: tag, title: 'Crowd plan', country: 'GB', effective_from: day(-100), requirements: [{ key: 'plan', kind: 'approval', label: 'Crowd management plan approved', holder: 'event' }] });
  const ev = await placedEvent(org, { country: 'GB', region: 'England', locality: 'Leeds' }, { starts_on: day(40), ends_on: day(41) });
  const hold = must(await api('POST', '/compliance/evidence', { token: org.token, body: { holder_type: 'event', holder_id: ev.id, event_id: ev.id, kind: 'approval', title: 'Crowd plan approval', valid_to: day(41) } }), 201);
  must(await api('POST', `/compliance/evidence/${hold.id}/review`, { token: admin.token, body: { decision: 'verify', verified_what: 'Approval letter checked with the council' } }));
  assert.equal(must(await evalEvent(org, ev)).summary.overall, 'compliant');
  const rec = must(await evalEvent(org, ev, { record: true }));
  assert.ok(rec.decision_id);
  // a stricter version takes effect after the event's own date: today's answer is unchanged, a later date sees it
  const v2 = must(await api('POST', '/compliance/rules', { token: admin.token, body: { ...v1.body, rule_id: v1.rule_id, key: undefined, scope: undefined, domains: undefined, topic: undefined, title: 'Crowd plan (stricter)', effective_from: day(60), requirements: [{ key: 'plan', kind: 'approval', label: 'Crowd plan approved', holder: 'event' }, { key: 'steward', kind: 'training', label: 'Steward training', holder: 'event' }] } }), 201);
  must(await api('POST', `/compliance/versions/${v2.version_id}/decision`, { token: admin2.token, body: { decision: 'approve' } }));
  assert.equal(must(await evalEvent(org, ev)).results.find((r) => r.key === v1.body.key).version, 1);
  const later = must(await evalEvent(org, ev, { as_of: day(90) }));
  assert.equal(later.results.find((r) => r.key === v1.body.key).version, 2);
  assert.equal(later.results.find((r) => r.key === v1.body.key).requirements.find((q) => q.key === 'steward').status, 'missing', 'the new requirement is asked for');
  assert.equal(later.results.find((r) => r.key === v1.body.key).requirements.find((q) => q.key === 'plan').status, 'non_compliant', 'and the old approval will have lapsed by then');
  const old = must(await evalEvent(org, ev, { as_of: day(-50) }));
  assert.equal(old.results.find((r) => r.key === v1.body.key).version, 1, 'a past date is judged by the rule text of that time');
  // the decision recorded earlier still shows version 1 and its text
  const keep = must(await api('GET', `/compliance/decisions/${rec.decision_id}`, { token: org.token }));
  assert.equal(keep.results.find((r) => r.key === v1.body.key).version, 1);
  // expiry: evidence that lapsed before the event is non-compliant
  const ev2 = await placedEvent(org, { country: 'GB', region: 'England', locality: 'Leeds' }, { starts_on: day(40), ends_on: day(45) });
  const short = must(await api('POST', '/compliance/evidence', { token: org.token, body: { holder_type: 'event', holder_id: ev2.id, event_id: ev2.id, kind: 'approval', title: 'Short approval', valid_to: day(20) } }), 201);
  must(await api('POST', `/compliance/evidence/${short.id}/review`, { token: admin.token, body: { decision: 'verify', verified_what: 'Letter checked' } }));
  const r2 = must(await evalEvent(org, ev2)).results.find((r) => r.key === v1.body.key);
  assert.equal(r2.status, 'non_compliant'); assert.match(r2.requirements[0].detail, /Expired on/);
  assert.equal(r2.outcome, 'applies', 'a legal rule cannot be waived, so no exception is on offer');
  // revoking evidence takes effect at once
  must(await api('POST', `/compliance/evidence/${hold.id}/review`, { token: admin.token, body: { decision: 'revoke', note: 'Council withdrew the approval' } }));
  assert.equal(must(await evalEvent(org, ev)).results.find((r) => r.key === v1.body.key).status, 'non_compliant');
});

test('exceptions: only a waivable rule, only by someone with authority, never for yourself, limited in time, shown in the decision', async () => {
  const owner = await signup(['organizer']);
  const orgRow = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Club ${++n}`, kind: 'club' } }), 201);
  const law = await rule({ topic: `law${n}`, title: 'Law', country: 'CA' });
  const policy = must(await api('POST', '/compliance/rules', { token: owner.token, body: { key: `pol.${++n}`, scope: 'organisation', organisation_id: orgRow.id, domains: ['event_permit'], topic: `pol${n}`, title: 'Club first-aid policy', classification: 'organisation_policy', effective_from: day(-1), approval_owner: 'Club board', waivable: true, requirements: [{ key: 'aid', kind: 'training', label: 'First-aider on site', holder: 'event' }] } }), 201);
  must(await api('POST', `/compliance/versions/${policy.version_id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  const ev = await placedEvent(owner, { country: 'CA', region: 'Ontario', locality: 'Toronto' });
  await pool.query('UPDATE events SET organisation_id=$2 WHERE id=$1', [ev.id, orgRow.id]);
  const grant = (token, rule_id, extra = {}) => api('POST', '/compliance/exceptions', { token, body: { rule_id, holder_type: 'event', holder_id: ev.id, event_id: ev.id, reason: 'Paramedics are on site instead', valid_to: new Date(Date.now() + 5 * 864e5).toISOString(), ...extra } });
  assert.equal((await grant(owner.token, law.rule_id)).status, 409, 'a law cannot be waived');
  assert.equal((await grant((await signup(['organizer'])).token, policy.rule_id)).status, 403);
  assert.equal((await grant(owner.token, policy.rule_id, { valid_to: new Date(Date.now() + 400 * 864e5).toISOString() })).status, 400, 'at most a year');
  const before_ = must(await evalEvent(owner, ev)).results.find((r) => r.title === 'Club first-aid policy');
  assert.equal(before_.status, 'missing');
  const x = must(await grant(owner.token, policy.rule_id), 201);
  const after_ = must(await evalEvent(owner, ev, { record: true }));
  const r = after_.results.find((q) => q.title === 'Club first-aid policy');
  assert.equal(r.status, 'exception'); assert.deepEqual(r.exception_ids, [x.id]);
  const d = must(await api('GET', `/compliance/decisions/${after_.decision_id}`, { token: owner.token }));
  assert.deepEqual(d.override_exception_ids, [x.id]); assert.equal(d.exceptions[0].granted_by, owner.id);
  const listed = must(await api('GET', '/compliance/exceptions', { token: owner.token, query: { holder_type: 'event', holder_id: ev.id } }));
  assert.equal(listed[0].reason, 'Paramedics are on site instead');
  must(await api('POST', `/compliance/exceptions/${x.id}/revoke`, { token: owner.token, body: { reason: 'Paramedics withdrew' } }));
  assert.equal(must(await evalEvent(owner, ev)).results.find((q) => q.title === 'Club first-aid policy').status, 'missing');
  await assert.rejects(pool.query('DELETE FROM cmp_exceptions WHERE id=$1', [x.id]), /never deleted/);
  // an organisation's rule applies only to its own events
  const outsider = await signup(['organizer']);
  const other = await placedEvent(outsider, { country: 'CA', region: 'Ontario', locality: 'Toronto' });
  const theirs = must(await evalEvent(outsider, other));
  assert.ok(theirs.results.some((q) => q.title === 'Law'), 'the platform library applies to everyone');
  assert.ok(!theirs.results.some((q) => q.title === 'Club first-aid policy'), "another organisation's policy does not");
});

// ------------------------------------------------------------------ accreditation
test('accreditation: the rules in force must be met before a badge is issued; an automatic approval waits instead of failing', async () => {
  const org = await signup(['organizer']);
  const ev = await placedEvent(org, { country: 'MY', region: 'Selangor', locality: 'Shah Alam' });
  await rule({ topic: `acc${++n}`, domains: ['accreditation'], title: 'Safeguarding training for athletes', classification: 'regulatory', country: 'MY', applies: { roles: ['athlete'] }, requirements: [{ key: 'safeguarding', kind: 'training', label: 'Safeguarding course', holder: 'person' }] });
  const cat = must(await api('POST', `/events/${ev.id}/accreditation/categories`, { token: org.token, body: { name: `Players ${++n}`, eligible: ['athlete'], approval: 'organiser', self_apply: true } }), 201);
  const auto = must(await api('POST', `/events/${ev.id}/accreditation/categories`, { token: org.token, body: { name: `Auto ${++n}`, eligible: ['athlete'], approval: 'auto', self_apply: true } }), 201);
  const p = await signup(['athlete']);
  const entry = must(await api('POST', `/events/${ev.id}/entries`, { token: p.token }), 201);
  must(await api('PATCH', `/entries/${entry.id}`, { token: org.token, body: { status: 'accepted' } }));
  const app = must(await api('POST', `/accreditation/categories/${cat.id}/apply`, { token: p.token }), 201);
  const refused = await api('POST', `/accreditations/${app.id}/decision`, { token: org.token, body: { decision: 'approve' } });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details.code, 'compliance_blocked');
  assert.match(refused.body.error.details.blockers[0].reason, /Safeguarding course/);
  const viaAuto = must(await api('POST', `/accreditation/categories/${auto.id}/apply`, { token: p.token }), 201);
  assert.equal(viaAuto.status, 'submitted', 'not an error: the application waits for a person');
  // the athlete files training for this event; the organiser (a different person) verifies it
  const t = must(await api('POST', '/compliance/evidence', { token: p.token, body: { holder_type: 'person', holder_id: p.id, event_id: ev.id, kind: 'training', title: 'Safeguarding course', valid_to: day(300) } }), 201);
  assert.equal((await api('POST', `/compliance/evidence/${t.id}/review`, { token: p.token, body: { decision: 'verify', verified_what: 'my own certificate' } })).status, 404, 'no self-verification');
  const queue = must(await api('GET', '/compliance/review-queue', { token: org.token, query: { event_id: ev.id } }));
  assert.equal(queue.length, 1);
  assert.equal((await api('GET', '/compliance/review-queue', { token: p.token, query: { event_id: ev.id } })).status, 404);
  must(await api('POST', `/compliance/evidence/${t.id}/review`, { token: org.token, body: { decision: 'verify', verified_what: 'Certificate seen and checked with the provider' } }));
  const approved = must(await api('POST', `/accreditations/${app.id}/decision`, { token: org.token, body: { decision: 'approve' } }));
  assert.equal(approved.status, 'approved');
  // the dashboard sees the same thing
  const dash = must(await api('GET', `/events/${ev.id}/compliance`, { token: org.token }));
  const row = dash.sections.accreditation.subjects.find((s) => s.subject_id === p.id);
  assert.equal(row.overall, 'compliant');
  assert.ok(dash.totals.compliant >= 1);
  assert.equal((await api('GET', `/events/${ev.id}/compliance`, { token: p.token })).status, 404, 'the athlete does not see the organiser dashboard');
});

test('accreditation: young people are judged by age and their guardian consent is read from the guardian module', async () => {
  const org = await signup(['organizer']);
  const ev = await placedEvent(org, { country: 'IN', region: 'Karnataka', locality: 'Bengaluru' });
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const adult = await signup(['athlete'], { dob: yearsAgo(30) });
  await rule({ topic: `kid${++n}`, domains: ['youth_safeguarding', 'accreditation'], title: 'Guardian consent for under-16s', classification: 'regulatory', country: 'IN', applies: { max_age: 15 }, requirements: [{ key: 'guardian', kind: 'signed_document', label: 'Guardian consent', holder: 'person' }] });
  const ask = (u) => api('POST', '/compliance/evaluate', { token: u.token, body: { subject_type: 'person', subject_id: u.id, event_id: ev.id, domain: 'accreditation' } });
  const k = must(await ask(kid)), a = must(await ask(adult));
  assert.equal(k.facts.values.age, 12);
  assert.equal(k.results.find((r) => r.title === 'Guardian consent for under-16s').outcome, 'applies');
  assert.equal(a.results.find((r) => r.title === 'Guardian consent for under-16s').outcome, 'does_not_apply');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_dob_compliance'")).rowCount >= 1, 'the date-of-birth read is logged');
  assert.ok(!JSON.stringify(k).includes(yearsAgo(12)), 'only the age is kept, never the date of birth');
});

// ------------------------------------------------------------------ federation eligibility (#477) and the federation's own policies (#68)
test('federation eligibility: the engine adds its rules to the match-day decision, and a federation policy is read as a federation-mandated rule', async () => {
  const org = await signup(['organizer']), mgr = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Bats ${++n}`, sport: 'cricket' } }), 201);
  const ev = await placedEvent(org, { country: 'IN', region: 'Delhi', locality: 'New Delhi' }, { sport: 'cricket' });
  const en = must(await api('POST', `/events/${ev.id}/entries`, { token: mgr.token, body: { team_id: team.id } }), 201);
  must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  const p = await signup(['athlete'], { dob: yearsAgo(25) });
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: p.id } }), 201);
  const reg = must(await api('POST', `/events/${ev.id}/registrations`, { token: mgr.token, body: { team_id: team.id, user_id: p.id } }), 201);
  must(await api('POST', `/registrations/${reg.id}/review`, { token: org.token, body: { action: 'register', row_version: reg.row_version } }));
  must(await api('POST', `/events/${ev.id}/registration/policy`, { token: org.token, body: { rules: {}, expected_version: 0 } }), 201);
  const check = async () => must(await api('GET', `/events/${ev.id}/eligibility`, { token: org.token, query: { team_id: team.id, user_id: p.id } }));
  assert.equal((await check()).decisions[0].decision, 'eligible', 'no rule written: nothing changes');
  await rule({ topic: `elig${++n}`, domains: ['federation_eligibility'], title: 'Anti-doping education', classification: 'regulatory', country: 'IN', applies: { roles: ['athlete'] }, requirements: [{ key: 'ade', kind: 'training', label: 'Anti-doping course', holder: 'person' }] });
  const d1 = (await check()).decisions[0];
  assert.equal(d1.decision, 'ineligible');
  const c1 = d1.checks.find((x) => x.rule.startsWith('policy:'));
  assert.equal(c1.status, 'fail'); assert.match(c1.reason, /Anti-doping course/);
  const t = must(await api('POST', '/compliance/evidence', { token: p.token, body: { holder_type: 'person', holder_id: p.id, event_id: ev.id, kind: 'training', title: 'WADA education', valid_to: day(300) } }), 201);
  assert.equal((await check()).decisions[0].checks.find((x) => x.rule.startsWith('policy:')).status, 'pending');
  must(await api('POST', `/compliance/evidence/${t.id}/review`, { token: org.token, body: { decision: 'verify', verified_what: 'Course certificate checked on the provider site' } }));
  assert.equal((await check()).decisions[0].decision, 'eligible');
  // a federation's own versioned policy (#68) is read as a federation-mandated rule: there is no second place to write it
  const fedOwner = await signup(['organizer']);
  const sportId = (await pool.query("SELECT id FROM sports WHERE slug='cricket'")).rows[0].id;
  const body_ = must(await api('POST', '/federation/bodies', { token: fedOwner.token, body: { name: `Cricket Board ${++n}`, level: 'national', abbreviation: `CB${n}`, country: 'IN', sports: [{ sport_id: sportId }] } }), 201);
  const pol = async (kind, params) => {
    const q = must(await api('POST', `/federation/bodies/${body_.id}/policies`, { token: fedOwner.token, body: { kind, title: `${kind} rules ${++n}` } }), 201);
    must(await api('POST', `/federation/policies/${q.id}/versions`, { token: fedOwner.token, body: { effective_from: day(-30), params } }), 201);
  };
  await pol('competition_entry', { requires_licensed_players: true });
  await pol('registration', { requires_guardian_consent_under_18: true });
  await pool.query("INSERT INTO fed_sanctions(body_id, event_id, applicant_id, status, sanction_no, requested_starts_on, requested_ends_on, approved_starts_on, approved_ends_on) VALUES ($1,$2,$3,'approved',$6,$4,$5,$4,$5)", [body_.id, ev.id, org.id, day(10), day(12), `S-${n}`]);
  const fx = must(await evalPerson(org, p, ev));
  const lic = fx.results.find((r) => r.title === 'Licensed players only');
  assert.equal(lic.classification, 'federation_mandated'); assert.equal(lic.source, 'federation_policy');
  assert.equal(lic.status, 'missing', 'the licence is read from the federation licence register; this player has none');
  assert.equal(fx.results.find((r) => r.title.startsWith('Guardian consent for under-18')).outcome, 'does_not_apply', 'an adult');
  const d2 = (await check()).decisions[0];
  assert.equal(d2.decision, 'ineligible');
  assert.match(d2.checks.find((x) => x.source?.label?.startsWith('Licensed players only')).reason, /licence/i);
});

// ------------------------------------------------------------------ explain, AI and access
test('explain: the plain-language answer never asserts compliance, even when an AI step rewords it', async () => {
  const org = await signup(['organizer']);
  await rule({ topic: `ex${++n}`, title: 'Ambulance on site', classification: 'regulatory', country: 'US', requirements: [{ key: 'amb', kind: 'permit', label: 'Ambulance booking', holder: 'event' }] });
  const ev = await placedEvent(org, { country: 'US', region: 'Texas', locality: 'Austin' });
  const plain = must(await api('POST', '/compliance/explain', { token: org.token, body: { subject_type: 'event', subject_id: ev.id } }));
  assert.equal(plain.assertion, 'none'); assert.equal(plain.ai_reworded, false);
  assert.match(plain.text, /Ambulance booking/); assert.match(plain.text, /human reviewer/);
  let seen;
  setAiTransport(async (b) => { seen = JSON.stringify(b); return 'Good news: you are fully compliant and safe to proceed.'; });
  try {
    const ai = must(await api('POST', '/compliance/explain', { token: org.token, body: { subject_type: 'event', subject_id: ev.id } }));
    assert.equal(ai.ai_reworded, true);
    assert.match(ai.text, /not a legal opinion/i);
    assert.match(seen, /Never say or imply/); assert.ok(!seen.includes(ev.name), 'no names go to the model');
  } finally { setAiTransport(null); }
});

test('access and MCP: outsiders get 404, the decision log is scoped, and every route is also a tool', async () => {
  const org = await signup(['organizer']), out = await signup(['organizer']);
  const ev = await placedEvent(org);
  assert.equal((await api('GET', `/events/${ev.id}/compliance`, { token: out.token })).status, 404);
  assert.equal((await api('GET', '/compliance/decisions', { token: out.token, query: { event_id: ev.id } })).status, 404);
  assert.equal((await api('GET', '/compliance/decisions', { token: org.token })).status, 400);
  assert.equal((await api('GET', '/compliance/review-queue', { token: org.token })).status, 404, 'the platform queue is the platform team\'s');
  assert.equal((await api('GET', '/compliance/review-queue', { token: admin.token })).status, 200);
  const tools = (await rpc('tools/list', {}, org.token)).tools.map((t) => t.name);
  for (const name of ['evaluate_compliance', 'explain_compliance', 'get_event_compliance', 'publish_policy_rule_version', 'decide_policy_version', 'import_policy_pack', 'export_policy_pack', 'submit_compliance_evidence', 'review_compliance_evidence', 'grant_compliance_exception', 'list_compliance_decisions', 'get_compliance_catalogue']) assert.ok(tools.includes(name), `${name} is an MCP tool`);
  const viaMcp = await rpc('tools/call', { name: 'get_compliance_catalogue', arguments: {} }, org.token);
  assert.ok(JSON.stringify(viaMcp).includes('procurement'));
});

test('every sport in the catalogue can be named by a rule and matched by the engine (sport-agnostic, no silent default)', async () => {
  const sports = (await pool.query('SELECT slug FROM sports')).rows.map((r) => r.slug);
  assert.ok(sports.length > 50);
  for (const slug of sports) {
    assert.equal(E.applicability({ applies: { sports: [slug] } }, { sport: slug }).result, 'yes', slug);
    assert.equal(E.applicability({ applies: { sports: [slug] } }, { sport: 'other-sport' }).result, 'no', slug);
    assert.equal(E.applicability({ applies: { sports: [slug] } }, {}).result, 'unknown', `${slug}: a missing sport is unknown, not a default`);
  }
});

// ------------------------------------------------------------------ standard country rulebooks and AI-drafted rulebooks
test('standard rulebooks: eight priority countries, every rule valid, imported as drafts, approved in one step, then tailored', async () => {
  const { PACK_RULE } = await import('../src/capabilities/compliance-rules.js');
  const { standardPack } = await import('../src/compliance/standard-packs.js');
  const org = await signup(['organizer']);
  const list = must(await api('GET', '/compliance/standard-rulebooks', { token: org.token }));
  assert.deepEqual(list.map((c) => c.code), ['IN', 'US', 'CA', 'SG', 'MY', 'LK', 'AU', 'GB']);
  for (const c of list) {
    assert.equal(c.rules, 6, c.code);
    for (const r of standardPack(c.code).rules) {
      assert.ok(PACK_RULE.safeParse(r).success, `${c.code} ${r.key}: ${JSON.stringify(PACK_RULE.safeParse(r).error?.issues?.[0])}`);
      assert.ok(r.source_title && r.approval_owner.includes('counsel'), `${r.key} names its instrument and who reviews it`);
      assert.ok(!r.waivable || r.classification === 'recommended_standard');
    }
  }
  const pack = must(await api('GET', '/compliance/standard-rulebooks/IN', { token: org.token }));
  assert.equal(pack.rules.length, 6); assert.match(pack.note, /not legal advice/);
  assert.equal((await api('GET', '/compliance/standard-rulebooks/ZZ', { token: org.token })).status, 404);
  // importing is the platform admin's; it creates drafts only and is idempotent
  assert.equal((await api('POST', '/compliance/standard-rulebooks/IN/import', { token: org.token })).status, 403);
  const first = must(await api('POST', '/compliance/standard-rulebooks/IN/import', { token: admin.token }), 201);
  assert.equal(first.imported, 6);
  assert.equal(must(await api('POST', '/compliance/standard-rulebooks/IN/import', { token: admin.token }), 201).imported, 0, 'a second import adds nothing');
  const ev = await placedEvent(org, { country: 'IN', region: 'Karnataka', locality: 'Bengaluru' });
  assert.ok(!must(await evalEvent(org, ev)).results.some((r) => r.key.startsWith('std.in.')), 'drafts have no effect');
  assert.equal(must(await api('GET', '/compliance/standard-rulebooks', { token: org.token })).find((c) => c.code === 'IN').drafts, 6);
  // one step approves what the approver may; the author's own laws wait for a second person
  const mine = must(await api('POST', '/compliance/packs/decision', { token: admin.token, body: { pack_code: first.pack_code, decision: 'approve' } }));
  assert.ok(mine.skipped.length >= 3 && mine.skipped.every((s) => /second person/.test(s.why)) && mine.done >= 1);
  const rest = must(await api('POST', '/compliance/packs/decision', { token: admin2.token, body: { pack_code: first.pack_code, decision: 'approve' } }));
  assert.equal(rest.skipped.length, 0); assert.equal(mine.done + rest.done, 6);
  assert.equal((await api('POST', '/compliance/packs/decision', { token: admin2.token, body: { pack_code: first.pack_code, decision: 'approve' } })).status, 404, 'nothing left to decide');
  const out = must(await evalEvent(org, ev));
  const permit = out.results.find((r) => r.key === 'std.in.event-permit');
  assert.equal(permit.outcome, 'applies'); assert.equal(permit.status, 'missing'); assert.match(permit.source_title, /public gatherings/i);
  assert.equal(out.results.find((r) => r.key === 'std.in.event-privacy').classification, 'legal_mandatory');
  // tailoring: a new version of a standard rule narrows it to a state; the older version is kept
  const rid = must(await api('GET', '/compliance/rules', { token: admin.token, query: { country: 'IN' } })).find((r) => r.key === 'std.in.event-permit').id;
  const v2 = must(await api('POST', '/compliance/rules', { token: admin.token, body: { rule_id: rid, title: 'Karnataka police permission', classification: 'regulatory', country: 'IN', region: 'Karnataka', effective_from: day(-1), approval_owner: 'Counsel, India', requirements: pack.rules[0].requirements } }), 201);
  must(await api('POST', `/compliance/versions/${v2.version_id}/decision`, { token: admin2.token, body: { decision: 'approve' } }));
  assert.equal(must(await evalEvent(org, ev)).results.find((r) => r.key === 'std.in.event-permit').version, 2);
  assert.equal(must(await api('GET', `/compliance/rules/${rid}`, { token: admin.token })).versions.length, 2);
  // every priority country imports
  for (const code of ['US', 'CA', 'SG', 'MY', 'LK', 'AU', 'GB']) assert.equal(must(await api('POST', `/compliance/standard-rulebooks/${code}/import`, { token: admin.token }), 201).imported, 6, code);
});

test('AI-drafted rulebook: validated, marked, returned as a package and stored nowhere; unavailable AI says so', async () => {
  const org = await signup(['organizer']);
  assert.equal((await api('POST', '/compliance/rulebook-drafts', { token: org.token, body: { country: 'NZ' } })).status, 403);
  const off = await api('POST', '/compliance/rulebook-drafts', { token: admin.token, body: { country: 'NZ' } });
  assert.equal(off.status, 409); assert.equal(off.body.error.details.code, 'ai_unavailable');
  const good = { key: 'ai.nz.privacy', domains: ['privacy'], topic: 'ai.nz.privacy', title: 'Privacy notice for event data', classification: 'regulatory', summary: 'Declare how data is used.', source_title: 'Privacy Act 2020', source_url: 'http://not-https.example', effective_from: '2026-01-01',
    approval_owner: 'whoever', requirements: [{ key: 'notice', kind: 'declaration', label: 'Privacy notice declared', holder: 'event' }], waivable: true, ignore_me: 'x' };
  const bad = { key: 'x', title: 'no domains' };
  const injected = { ...good, key: 'ai.nz.fed', topic: 'ai.nz.fed', classification: 'federation_mandated' };
  let seen;
  setAiTransport(async (b) => { seen = JSON.stringify(b); return `Here you go: ${JSON.stringify({ rules: [good, bad, injected] })}`; });
  let pack;
  try { pack = must(await api('POST', '/compliance/rulebook-drafts', { token: admin.token, body: { country: 'NZ', focus: 'athletics meets' } })); } finally { setAiTransport(null); }
  assert.match(seen, /Never invent statute numbers/); assert.match(seen, /athletics meets/);
  assert.equal(pack.rules.length, 1); assert.equal(pack.dropped.length, 2);
  const r = pack.rules[0];
  assert.equal(r.waivable, false, 'a regulation is never waivable'); assert.equal(r.source_url, undefined, 'an unverifiable link is dropped');
  assert.match(r.change_note, /AI-drafted/); assert.match(pack.pack_code, /^AI-NZ-\d{8}$/); assert.equal(r.pack_code, pack.pack_code);
  assert.match(pack.warnings[0], /counsel/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cmp_rules WHERE key='ai.nz.privacy'")).rows[0].n, 0, 'nothing is stored');
  // the package loads like any pack, as a draft that still needs a person
  const loaded = must(await api('POST', '/compliance/packs', { token: admin.token, body: { pack_code: pack.pack_code, rules: pack.rules } }), 201);
  assert.equal(loaded.drafts, 1);
  assert.equal((await pool.query("SELECT status FROM cmp_rule_versions WHERE id=$1", [loaded.versions[0].version_id])).rows[0].status, 'draft');
});
