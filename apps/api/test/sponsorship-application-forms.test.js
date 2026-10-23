// Configurable sponsorship application forms (#286): versions, conditional answers, uploads, drafts, idempotent submit, receipts, corrections, isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { validateApplication, formDefinition } = await import('../src/application-forms.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `af_${n}_${roles[0]}`, display_name: `Forms ${n}`, email: `af${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const upload = async (token, appId, field, bytes = Buffer.from('%PDF-1.4 test document'), name = 'doc.pdf') => {
  const r = await fetch(`${base}/api/v1/program-applications/${appId}/files?field=${field}&name=${name}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/pdf' }, body: bytes });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const download = (token, fileId) => fetch(`${base}/api/v1/application-files/${fileId}`, { headers: { authorization: `Bearer ${token}` } });

const DEF = {
  sections: [
    { id: 'about', title: 'About you', fields: [
      { key: 'summary', label: 'Project summary', type: 'longtext', required: true },
      { key: 'youth', label: 'Is this a youth programme?', type: 'yesno', required: true },
      { key: 'guardian', label: 'Guardian contact', type: 'text', required: true, confidential: true, when: { field: 'youth', op: 'eq', value: true } },
      { key: 'start', label: 'Start date', type: 'date', required: false, profile_key: 'start_hint' },
      { key: 'size', label: 'Group size', type: 'number', min: 1, max: 500 },
      { key: 'level', label: 'Level', type: 'choice', options: [{ value: 'club', label: 'Club' }, { value: 'pro', label: 'Pro' }] },
      { key: 'org_name', label: 'Organisation', type: 'text', profile_key: 'org_name' },
    ] },
    { id: 'money', title: 'Budget and proof', fields: [
      { key: 'budget', label: 'Budget', type: 'budget', required: true },
      { key: 'proof', label: 'Proof of registration', type: 'file', required: true, max_files: 2 },
      { key: 'refs', label: 'References', type: 'references', required: true, max_items: 2 },
    ] },
  ],
};
const brand = async () => {
  const owner = await signup(['sponsor']);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Brand ${n}` } }), 201);
  return { owner, b };
};
const setup = async (def = DEF) => {
  const w = await brand();
  let p = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Youth fund', objective: 'Grow the game', currency: 'USD', budget_cents: 1000000, max_award_cents: 500000 } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: w.owner.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201);
  p = must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: w.owner.token, body: { status: 'published', version: p.row_version } }));
  const form = must(await api('POST', `/sponsorship-programs/${p.id}/forms`, { token: w.owner.token, body: { name: 'Application', definition: def } }), 201);
  const pinned = must(await api('POST', `/program-rounds/${r.id}/form`, { token: w.owner.token, body: { version: r.row_version, form_id: form.id } }));
  return { w, p, r: pinned, form };
};
const applicant = async () => { const a = await signup(['athlete']); return { a, target: { target_type: 'athlete', target_id: a.id } }; };
const goodDraft = (extra = {}) => ({
  requested_cents: 200000,
  answers: { summary: 'Coaching clinics', youth: false, size: 20, level: 'club' },
  budget: [{ label: 'Coaches', amount_cents: 150000 }, { label: 'Kit', amount_cents: 80000 }],
  references: [{ name: 'Sam Ref', relationship: 'Club chair', email: 'sam@example.com', may_contact: false }],
  ...extra,
});
const draft = (x, s, body, extra = {}) => api('POST', `/program-rounds/${s.r.id}/draft`, { token: x.a.token, body: { ...x.target, ...body, ...extra } });
const fileId = async (x, appId, field = 'proof') => must(await upload(x.a.token, appId, field), 201);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('form definitions: conditions may only look backwards, options and one budget are enforced', async () => {
  assert.equal(formDefinition.safeParse(DEF).success, true);
  const bad = (f) => formDefinition.safeParse({ sections: [{ id: 's', title: 'S', fields: f }] }).success;
  assert.equal(bad([{ key: 'a', label: 'A', type: 'text', when: { field: 'b', op: 'filled' } }, { key: 'b', label: 'B', type: 'text' }]), false, 'forward reference');
  assert.equal(bad([{ key: 'a', label: 'A', type: 'choice' }]), false, 'choice needs options');
  assert.equal(bad([{ key: 'a', label: 'A', type: 'budget' }, { key: 'b', label: 'B', type: 'budget' }]), false, 'one budget');
  assert.equal(bad([{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'A2', type: 'text' }]), false, 'duplicate key');
  const def = formDefinition.parse(DEF);
  const hidden = validateApplication(def, { answers: { summary: 's', youth: false, guardian: 'ignored' } }, { strict: false });
  assert.equal(hidden.answers.guardian, undefined, 'a hidden answer is dropped');
  const shown = validateApplication(def, { answers: { summary: 's', youth: true } }, { strict: true });
  assert.ok(shown.issues.some((x) => x.path === 'answers.guardian'), 'required once its condition holds');
});

test('builder: versions are immutable, stale publish is 409, staff-only, rounds pin a version, archive is blocked while pinned', async () => {
  const s = await setup();
  const outsider = await signup(['sponsor']);
  assert.equal((await api('POST', `/sponsorship-programs/${s.p.id}/forms`, { token: outsider.token, body: { name: 'Nope nope', definition: DEF } })).status, 403);
  assert.equal(s.r.form_id, s.form.id); assert.equal(s.r.form_version, 1);
  const v2def = { sections: [{ id: 'a', title: 'A', fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }] }] };
  const v2 = must(await api('POST', `/sponsorship-forms/${s.form.id}/versions`, { token: s.w.owner.token, body: { version: s.form.row_version, definition: v2def } }), 201);
  assert.equal(v2.latest_version, 2);
  assert.equal((await api('POST', `/sponsorship-forms/${s.form.id}/versions`, { token: s.w.owner.token, body: { version: s.form.row_version, definition: v2def } })).status, 409, 'stale form version');
  const old = must(await api('GET', `/sponsorship-forms/${s.form.id}`, { token: s.w.owner.token, query: { version: 1 } }));
  assert.deepEqual(old.definition, formDefinition.parse(DEF), 'v1 unchanged after v2');
  assert.equal((await api('POST', `/sponsorship-forms/${s.form.id}/archive`, { token: s.w.owner.token })).status, 409, 'round still pinned');
  const x = await applicant();
  const view = must(await api('GET', `/program-rounds/${s.r.id}/application-form`, { token: x.a.token }));
  assert.equal(view.form.version, 1, 'round stays on the version it is pinned to');
  const unpinned = must(await api('POST', `/program-rounds/${s.r.id}/form`, { token: s.w.owner.token, body: { version: s.r.row_version, form_id: null } }));
  assert.equal(unpinned.form_id, null);
  must(await api('POST', `/sponsorship-forms/${s.form.id}/archive`, { token: s.w.owner.token }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_form_versions WHERE form_id=$1', [s.form.id])).rows[0].n, 2, 'nothing deleted');
});

test('draft saves, resumes (also from another session) and detects a stale version; reusable profile prefills; drafts are private', async () => {
  const s = await setup();
  const x = await applicant();
  must(await api('POST', '/me/applicant-profile', { token: x.a.token, body: { version: 0, data: { org_name: 'Harbour FC', start_hint: '2026-12-01' } } }));
  assert.equal((await api('POST', '/me/applicant-profile', { token: x.a.token, body: { version: 0, data: { org_name: 'x' } } })).status, 409);
  const v = must(await api('GET', `/program-rounds/${s.r.id}/application-form`, { token: x.a.token, query: x.target }));
  assert.equal(v.profile.org_name, 'Harbour FC'); assert.equal(v.applications.length, 0);
  const d1 = must(await draft(x, s, { requested_cents: 100000, answers: { summary: 'Half done' } }));
  assert.equal(d1.status, 'draft'); assert.equal(d1.form_version, 1); assert.equal(d1.row_version, 1);
  const resumed = must(await api('GET', `/program-rounds/${s.r.id}/application-form`, { token: x.a.token, query: x.target }));
  assert.equal(resumed.applications[0].id, d1.id); assert.equal(resumed.applications[0].answers.summary, 'Half done');
  assert.equal((await draft(x, s, { answers: { summary: 'x' } })).status, 409, 'version needed once a draft exists');
  const d2 = must(await draft(x, s, { requested_cents: 100000, answers: { summary: 'More', youth: true, guardian: 'Pat 555' } }, { version: 1 }));
  assert.equal(d2.row_version, 2); assert.equal(d2.answers.guardian, 'Pat 555');
  const stale = await draft(x, s, { answers: { summary: 'old tab' } }, { version: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details.current_version, 2);
  assert.equal((await draft(x, s, { answers: { summary: 'x', nonsense: 1 } }, { version: 2 })).status, 422, 'unknown question');
  const row = (await pool.query('SELECT answers, confidential_enc FROM sponsorship_applications WHERE id=$1', [d1.id])).rows[0];
  assert.equal(row.answers.guardian, undefined, 'confidential answer is not in the open column');
  assert.ok(row.confidential_enc && !row.confidential_enc.includes('Pat'), 'and is encrypted');
  const staffList = must(await api('GET', `/sponsorship-programs/${s.p.id}/applications`, { token: s.w.owner.token }));
  assert.equal(staffList.length, 0, 'brand staff never see drafts');
  assert.equal((await api('GET', `/program-applications/${d1.id}`, { token: s.w.owner.token })).status, 404);
  const other = await applicant();
  assert.equal((await api('GET', `/program-applications/${d1.id}`, { token: other.a.token })).status, 404);
  assert.equal((await api('POST', `/program-applications/${d1.id}/submit`, { token: other.a.token, body: { idempotency_key: 'other-user-key' } })).status, 404);
});

test('submit: required, conditional, budget and upload rules; receipt keeps the exact form version; retries and races never duplicate', async () => {
  const s = await setup();
  const x = await applicant();
  const d = must(await draft(x, s, goodDraft({ answers: { summary: 'Clinics', youth: true } })));
  const noGuardian = await api('POST', `/program-applications/${d.id}/submit`, { token: x.a.token, body: { idempotency_key: 'key-0000001' } });
  assert.equal(noGuardian.status, 422);
  assert.ok(noGuardian.body.error.details.some((i) => i.path === 'answers.guardian'));
  assert.ok(noGuardian.body.error.details.some((i) => i.path === 'files.proof'), 'required upload missing');
  const d2 = must(await draft(x, s, goodDraft({ answers: { summary: 'Clinics', youth: false } }), { version: d.row_version }));
  assert.equal((await draft(x, s, goodDraft({ budget: [{ label: 'Kit', amount_cents: 100 }] }), { version: d2.row_version })).status, 422, 'budget below request');
  assert.equal((await draft(x, s, goodDraft({ requested_cents: 900000 }), { version: d2.row_version })).status, 422, 'above maximum award');
  assert.equal((await upload(x.a.token, d.id, 'summary')).status, 400, 'not a file question');
  assert.equal((await upload(x.a.token, d.id, 'proof', Buffer.from('MZ not a pdf at all'))).status, 400, 'type is read from the bytes');
  await fileId(x, d.id);
  const keyA = 'attempt-AAAAAAAA';
  const results = await Promise.all([1, 2, 3].map(() => api('POST', `/program-applications/${d.id}/submit`, { token: x.a.token, body: { idempotency_key: keyA } })));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200], JSON.stringify(results.map((r) => r.body)));
  const receipts = new Set(results.map((r) => r.body.receipt_no));
  assert.equal(receipts.size, 1); assert.match([...receipts][0], /^SA-\d{6}$/);
  assert.equal(results.filter((r) => r.body.replayed).length, 2, 'two of three were replays');
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM sponsorship_applications WHERE round_id=$1', [s.r.id])).rows[0].c, 1, 'one application row');
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM sponsorship_application_events WHERE application_id=$1 AND kind='submitted'", [d.id])).rows[0].c, 1);
  assert.equal((await api('POST', `/program-applications/${d.id}/submit`, { token: x.a.token, body: { idempotency_key: 'another-key-0001' } })).status, 409, 'a different key cannot file again');
  const receipt = must(await api('GET', `/program-applications/${d.id}`, { token: x.a.token }));
  assert.equal(receipt.status, 'submitted'); assert.equal(receipt.form_version, 1); assert.equal(receipt.form.definition.sections.length, 2);
  assert.equal(receipt.answers.summary, 'Clinics'); assert.equal(receipt.budget.length, 2); assert.equal(receipt.references[0].name, 'Sam Ref');
  // another form version published later does not change what this application was filled under
  const f = must(await api('GET', `/sponsorship-forms/${s.form.id}`, { token: s.w.owner.token }));
  must(await api('POST', `/sponsorship-forms/${s.form.id}/versions`, { token: s.w.owner.token, body: { version: f.row_version, definition: { sections: [{ id: 'z', title: 'Z', fields: [{ key: 'other', label: 'Other', type: 'text' }] }] } } }), 201);
  must(await api('POST', `/program-rounds/${s.r.id}/form`, { token: s.w.owner.token, body: { version: (await pool.query('SELECT row_version FROM sponsorship_rounds WHERE id=$1', [s.r.id])).rows[0].row_version, form_id: s.form.id } }));
  const after = must(await api('GET', `/program-applications/${d.id}`, { token: x.a.token }));
  assert.equal(after.form_version, 1); assert.equal(after.form.sha256, receipt.form.sha256);
  assert.equal((await api('POST', `/program-rounds/${s.r.id}/applications`, { token: x.a.token, body: { ...x.target, requested_cents: 1000 } })).status, 409, 'the plain apply is refused on a form round');
});

test('stale form version: a draft started on v1 cannot be submitted after the round moves to v2; rebase carries matching answers', async () => {
  const s = await setup();
  const x = await applicant();
  const d = must(await draft(x, s, goodDraft()));
  await fileId(x, d.id);
  const f = must(await api('GET', `/sponsorship-forms/${s.form.id}`, { token: s.w.owner.token }));
  const v2 = { sections: [{ id: 'a', title: 'A', fields: [{ key: 'summary', label: 'Summary', type: 'longtext', required: true }, { key: 'extra', label: 'Extra', type: 'text', required: true }] }] };
  must(await api('POST', `/sponsorship-forms/${s.form.id}/versions`, { token: s.w.owner.token, body: { version: f.row_version, definition: v2 } }), 201);
  const rv = (await pool.query('SELECT row_version FROM sponsorship_rounds WHERE id=$1', [s.r.id])).rows[0].row_version;
  must(await api('POST', `/program-rounds/${s.r.id}/form`, { token: s.w.owner.token, body: { version: rv, form_id: s.form.id } }));
  const sub = await api('POST', `/program-applications/${d.id}/submit`, { token: x.a.token, body: { idempotency_key: 'stale-key-0001' } });
  assert.equal(sub.status, 409); assert.equal(sub.body.error.details.code, 'stale_form_version'); assert.equal(sub.body.error.details.current_form_version, 2);
  const saveStale = await draft(x, s, { requested_cents: 200000, answers: { summary: 'Clinics' } }, { version: d.row_version });
  assert.equal(saveStale.status, 409); assert.equal(saveStale.body.error.details.code, 'stale_form_version');
  const re = must(await draft(x, s, { requested_cents: 200000, answers: { summary: 'Clinics', extra: 'Added' } }, { version: d.row_version, rebase: true }));
  assert.equal(re.form_version, 2); assert.equal(re.answers.summary, 'Clinics');
  const done = must(await api('POST', `/program-applications/${d.id}/submit`, { token: x.a.token, body: { idempotency_key: 'stale-key-0002' } }));
  assert.equal(done.form_version, 2);
});

test('uploads are confidential and scoped: applicant and the program\'s staff only; limits; removal hides but keeps; staff reads are audited', async () => {
  const s = await setup();
  const x = await applicant(), other = await applicant();
  const d = must(await draft(x, s, goodDraft()));
  const f1 = await fileId(x, d.id);
  assert.equal((await upload(other.a.token, d.id, 'proof')).status, 404, 'another user cannot upload to it');
  await fileId(x, d.id);
  assert.equal((await upload(x.a.token, d.id, 'proof')).status, 400, 'max_files');
  assert.equal((await download(x.a.token, f1.id)).status, 200);
  assert.equal((await download(other.a.token, f1.id)).status, 404);
  assert.equal((await download(s.w.owner.token, f1.id)).status, 404, 'staff cannot open files of a draft');
  must(await api('POST', `/program-applications/${d.id}/submit`, { token: x.a.token, body: { idempotency_key: 'files-key-0001' } }));
  const res = await download(s.w.owner.token, f1.id);
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_application_file'", [s.w.owner.id])).rowCount >= 1, 'staff read is audited');
  const rival = await brand();
  assert.equal((await download(rival.owner.token, f1.id)).status, 404, 'another brand has no access');
  assert.equal((await api('GET', `/program-applications/${d.id}`, { token: rival.owner.token })).status, 404);
  assert.equal((await api('DELETE', `/application-files/${f1.id}`, { token: x.a.token })).status, 409, 'locked after submit');
  const s2 = await setup(); const y = await applicant();
  const d3 = must(await draft(y, s2, goodDraft()));
  const g = await fileId(y, d3.id);
  must(await api('DELETE', `/application-files/${g.id}`, { token: y.a.token }));
  assert.equal((await download(y.a.token, g.id)).status, 404);
  assert.equal((await pool.query('SELECT removed_at FROM sponsorship_application_files WHERE id=$1', [g.id])).rows[0].removed_at !== null, true, 'kept, only hidden');
  assert.equal((await api('GET', `/program-applications/${d.id}`, { token: s.w.owner.token })).body.files.length, 2);
});

test('staff reading confidential answers is audited; corrections change only flagged answers and keep history; replay is idempotent', async () => {
  const s = await setup();
  const x = await applicant();
  const d = must(await draft(x, s, goodDraft({ answers: { summary: 'Clinics', youth: true, guardian: 'Pat 555', size: 20 } })));
  await fileId(x, d.id);
  must(await api('POST', `/program-applications/${d.id}/submit`, { token: x.a.token, body: { idempotency_key: 'corr-key-00001' } }));
  const before = (await pool.query("SELECT count(*)::int AS c FROM audit_log WHERE actor_id=$1 AND action='read_pii'", [s.w.owner.id])).rows[0].c;
  const seen = must(await api('GET', `/program-applications/${d.id}`, { token: s.w.owner.token }));
  assert.equal(seen.answers.guardian, 'Pat 555');
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM audit_log WHERE actor_id=$1 AND action='read_pii'", [s.w.owner.id])).rows[0].c, before + 1);
  assert.equal((await api('POST', `/program-applications/${d.id}/request-correction`, { token: x.a.token, body: { reason: 'self', fields: ['size'] } })).status, 403, 'the applicant cannot return their own');
  assert.equal((await api('POST', `/program-applications/${d.id}/request-correction`, { token: s.w.owner.token, body: { reason: 'Fix', fields: ['made_up'] } })).status, 400);
  const ret = must(await api('POST', `/program-applications/${d.id}/request-correction`, { token: s.w.owner.token, body: { reason: 'Group size looks wrong', fields: ['size', 'requested_cents'] } }));
  assert.equal(ret.status, 'returned'); assert.deepEqual(ret.correction.fields, ['size', 'requested_cents']);
  assert.equal((await api('PATCH', `/program-applications/${d.id}`, { token: s.w.owner.token, body: { decision: 'decline' } })).status, 409, 'cannot be decided while returned');
  assert.equal((await api('POST', `/program-applications/${d.id}/correction`, { token: x.a.token, body: { idempotency_key: 'fix-key-000001', version: ret.row_version, answers: { summary: 'Rewritten' } } })).status, 403, 'summary was not flagged');
  assert.equal((await api('POST', `/program-applications/${d.id}/correction`, { token: x.a.token, body: { idempotency_key: 'fix-key-000001', version: ret.row_version - 1, answers: { size: 25 } } })).status, 409, 'stale version');
  assert.equal((await upload(x.a.token, d.id, 'proof')).status, 403, 'file question not flagged');
  const body = { idempotency_key: 'fix-key-000002', version: ret.row_version, answers: { size: 25 }, requested_cents: 180000 };
  const fixed = must(await api('POST', `/program-applications/${d.id}/correction`, { token: x.a.token, body }));
  assert.equal(fixed.status, 'submitted'); assert.equal(fixed.answers.size, 25); assert.equal(fixed.answers.summary, 'Clinics'); assert.equal(fixed.form_version, 1);
  const replay = must(await api('POST', `/program-applications/${d.id}/correction`, { token: x.a.token, body }));
  assert.equal(replay.replayed, true);
  const ev = fixed.events.map((e) => e.kind);
  assert.deepEqual(ev, ['submitted', 'correction_requested', 'corrected']);
  const row = (await pool.query("SELECT fields, before FROM sponsorship_application_events WHERE application_id=$1 AND kind='corrected'", [d.id])).rows[0];
  assert.deepEqual(row.fields.sort(), ['requested_cents', 'size']); assert.equal(row.before.size, 20); assert.equal(row.before.requested_cents, 200000);
  const award = must(await api('PATCH', `/program-applications/${d.id}`, { token: s.w.owner.token, body: { decision: 'award', program_version: (await pool.query('SELECT row_version FROM sponsorship_programs WHERE id=$1', [s.p.id])).rows[0].row_version } }));
  assert.equal(award.award.status, 'issued'); assert.equal(Number(award.award.amount_cents), 180000);
});

test('export is brand-scoped and audited, omits drafts and confidential data; tenant isolation on reads; legacy applications still work', async () => {
  const s = await setup();
  const x = await applicant(), y = await applicant();
  const d = must(await draft(x, s, goodDraft({ answers: { summary: 'Clinics', youth: true, guardian: 'SECRET-GUARDIAN' } })));
  await fileId(x, d.id);
  must(await api('POST', `/program-applications/${d.id}/submit`, { token: x.a.token, body: { idempotency_key: 'export-key-001' } }));
  must(await draft(y, s, goodDraft()));
  const ex = must(await api('GET', `/sponsorship-programs/${s.p.id}/applications-export`, { token: s.w.owner.token }));
  assert.equal(ex.rows, 1); assert.ok(!ex.csv.includes('SECRET-GUARDIAN')); assert.ok(ex.csv.includes('SA-'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='export' AND entity='sponsorship_applications'", [s.w.owner.id])).rowCount >= 1);
  const rival = await brand();
  assert.equal((await api('GET', `/sponsorship-programs/${s.p.id}/applications-export`, { token: rival.owner.token })).status, 403);
  assert.equal((await api('GET', `/sponsorship-programs/${s.p.id}/forms`, { token: rival.owner.token })).status, 403);
  assert.equal((await api('GET', `/sponsorship-forms/${s.form.id}`, { token: rival.owner.token })).status, 403);
  assert.equal((await api('POST', `/program-rounds/${s.r.id}/form`, { token: rival.owner.token, body: { version: 1, form_id: null } })).status, 403);
  assert.equal((await api('GET', `/program-rounds/${s.r.id}/application-form`, { token: x.a.token })).body.applications.length, 1, 'applicant sees only their own');
  const mine = must(await api('GET', '/my/program-applications', { token: y.a.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'draft');
  // a round without a form keeps the original flow, and its existing applications are untouched
  const w2 = await brand();
  const p2 = must(await api('POST', '/sponsorship-programs', { token: w2.owner.token, body: { sponsor_id: w2.b.id, name: 'Plain fund', currency: 'USD', budget_cents: 100000 } }), 201);
  const r2 = must(await api('POST', `/sponsorship-programs/${p2.id}/rounds`, { token: w2.owner.token, body: { opens_on: day(-1), closes_on: day(10) } }), 201);
  must(await api('POST', `/sponsorship-programs/${p2.id}/status`, { token: w2.owner.token, body: { status: 'published', version: p2.row_version } }));
  const z = await applicant();
  const legacy = must(await api('POST', `/program-rounds/${r2.id}/applications`, { token: z.a.token, body: { ...z.target, requested_cents: 5000, pitch: 'Plain' } }), 201);
  assert.equal(legacy.status, 'submitted'); assert.equal(legacy.form_id, null);
  assert.equal((await api('POST', `/program-rounds/${r2.id}/draft`, { token: z.a.token, body: { ...z.target, answers: {} } })).status, 409, 'no form on this round');
  must(await api('POST', `/program-applications/${legacy.id}/withdraw`, { token: z.a.token }));
});

test('migration 089 is additive and repeatable: existing applications, rounds and agreements keep every value', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../migrations/089_sponsorship_application_forms.sql', import.meta.url), 'utf8');
  const w = await brand();
  let p = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Legacy fund', currency: 'USD', budget_cents: 100000 } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: w.owner.token, body: { opens_on: day(-1), closes_on: day(10) } }), 201);
  p = must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: w.owner.token, body: { status: 'published', version: p.row_version } }));
  const x = await applicant();
  const legacy = must(await api('POST', `/program-rounds/${r.id}/applications`, { token: x.a.token, body: { ...x.target, requested_cents: 7000, pitch: 'Before the migration' } }), 201);
  const won = must(await api('PATCH', `/program-applications/${legacy.id}`, { token: w.owner.token, body: { decision: 'award', program_version: p.row_version } }));
  const award = must(await api('POST', `/program-awards/${won.award.id}/respond`, { token: x.a.token, body: { decision: 'accept', offer_version: won.award.offer_version } }));
  const snap = async () => ({
    a: (await pool.query('SELECT status, requested_cents, awarded_cents, pitch, terms_snapshot, sponsorship_id, created_at FROM sponsorship_applications WHERE id=$1', [legacy.id])).rows[0],
    s: (await pool.query('SELECT status, amount_cents, currency, visibility, application_id FROM sponsorships WHERE id=$1', [award.sponsorship_id])).rows[0],
    r: (await pool.query('SELECT name, opens_on, closes_on, terms_version FROM sponsorship_rounds WHERE id=$1', [r.id])).rows[0],
  });
  const before = await snap();
  await pool.query(sql);
  await pool.query(sql);
  assert.deepEqual(await snap(), before);
  const row = (await pool.query('SELECT form_id, form_version, answers, row_version, receipt_no FROM sponsorship_applications WHERE id=$1', [legacy.id])).rows[0];
  assert.equal(row.form_id, null); assert.equal(row.form_version, null); assert.deepEqual(row.answers, {}); assert.equal(row.row_version, 1); assert.equal(row.receipt_no, null);
  assert.equal(before.a.status, 'awarded'); assert.equal(before.s.visibility, 'private', 'athlete deals stay private by default');
});

test('standard form templates are valid forms; the draft tailors with AI when asked and falls back to the template', async () => {
  const { templateList } = await import('../src/sponsorship-form-templates.js');
  const { setAiTransport } = await import('../src/ai.js');
  const w = await brand();
  const list = must(await api('GET', '/sponsorship-form-templates', { token: w.owner.token }));
  assert.ok(list.length >= 5);
  for (const t of templateList()) assert.ok(formDefinition.safeParse(t.definition).success, `${t.key} is a valid form: ${JSON.stringify(formDefinition.safeParse(t.definition).error?.issues[0])}`);
  const p = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Swim fund', currency: 'USD', budget_cents: 100000 } }), 201);
  const plain = must(await api('POST', `/sponsorship-programs/${p.id}/form-drafts`, { token: w.owner.token, body: { template: 'athlete' } }), 200);
  assert.equal(plain.ai, false); assert.equal(plain.definition.sections[0].id, 'about_you');
  must(await api('POST', `/sponsorship-programs/${p.id}/forms`, { token: w.owner.token, body: { name: 'From template', definition: plain.definition } }), 201);
  setAiTransport(async () => JSON.stringify({ name: 'Swim travel grant', definition: { sections: [{ id: 'swim', title: 'Swimmer', fields: [{ key: 'pb', label: 'Personal best', type: 'text', required: true }] }] } }));
  try {
    const tailored = must(await api('POST', `/sponsorship-programs/${p.id}/form-drafts`, { token: w.owner.token, body: { template: 'athlete', brief: 'Travel grants for under-18 swimmers' } }), 200);
    assert.equal(tailored.ai, true); assert.equal(tailored.name, 'Swim travel grant');
    setAiTransport(async () => JSON.stringify({ name: 'Bad', definition: { sections: [] } }));
    const fallback = must(await api('POST', `/sponsorship-programs/${p.id}/form-drafts`, { token: w.owner.token, body: { template: 'team', brief: 'Anything at all' } }), 200);
    assert.equal(fallback.ai, false); assert.equal(fallback.template, 'team');
  } finally { setAiTransport(null); }
  const outsider = await signup(['sponsor']);
  assert.equal((await api('POST', `/sponsorship-programs/${p.id}/form-drafts`, { token: outsider.token, body: {} })).status >= 403, true);
});
