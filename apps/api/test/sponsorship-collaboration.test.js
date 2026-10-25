// Sponsor collaboration (#306): tasks, assignments, internal notes, reminders and escalation on agreements and programs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { sendTaskReminders, ensureExpiryTasks, processSponsorTasks } = await import('../src/sponsor-collaboration.js');
const { config } = await import('../src/config.js');
const { STEPS } = await import('../src/worker.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `co_${n}_${roles[0]}`, display_name: `Collab ${n}`, email: `co${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 3 };
const period = { starts_on: '2030-01-01', ends_on: '2030-06-30' };
const mkAdmin = async () => { n++; const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [`co_admin_${n}`])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const sql = async (q, p = []) => (await pool.query(q, p)).rows;
const inDays = async (k) => (await sql('SELECT (current_date + $1::int)::text AS d', [k]))[0].d;

/** A corporate brand (organisation + staff in each role) with one accepted agreement with an athlete, and an outsider. */
const world = async () => {
  const owner = await signup(['sponsor']), ath = await signup(['athlete']), outsider = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Acme ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Brand ${n}` } }), 201);
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: owner.token, body: { sponsor_type: 'organization', organisation_id: org.id } }));
  const staff = {};
  for (const role of ['manager', 'evaluator', 'finance', 'auditor']) {
    const u = await signup(['athlete']);
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
    staff[role] = u;
  }
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: owner.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', ...period, lines: [money] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } }));
  return { owner, ath, outsider, org, b, staff, deal, id: deal.id };
};
const mk = (w, who, extra = {}) => api('POST', '/sponsorship-tasks', { token: who.token, body: { sponsorship_id: w.id, title: 'Chase the signed photo release', ...extra } });
const task = async (w, who, extra) => must(await mk(w, who, extra), 201);
const patch = (t, who, body) => api('PATCH', `/sponsorship-tasks/${t.id}`, { token: who.token, body: { expected_version: t.row_version, ...body } });
const inbox = (u, like) => sql("SELECT * FROM notifications WHERE user_id=$1 AND kind LIKE $2 ORDER BY created_at, id", [u.id, like ?? 'sponsorship_task%']);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('internal notes and tasks never leak: the other side, other tenants and platform admins see only shared items', async () => {
  const w = await world();
  const mine = await task(w, w.owner, { visibility: 'internal', title: 'Brand-only: renegotiate the fee' });
  const shared = await task(w, w.owner, { visibility: 'shared', title: 'Send the kit sizes' });
  const theirs = await task(w, w.ath, { visibility: 'internal', title: 'Athlete-only: ask for a higher fee' });
  const note = must(await api('POST', '/sponsorship-notes', { token: w.owner.token, body: { task_id: mine.id, body: 'Budget is tight this quarter' } }), 201);
  assert.equal(note.visibility, 'internal');
  must(await api('POST', '/sponsorship-notes', { token: w.ath.token, body: { sponsorship_id: w.id, body: 'My private thought' } }), 201);

  const titles = async (u) => (must(await api('GET', '/sponsorship-tasks', { token: u.token, query: { sponsorship_id: w.id } })).items.map((t) => t.title)).sort();
  assert.deepEqual(await titles(w.owner), ['Brand-only: renegotiate the fee', 'Send the kit sizes']);
  assert.deepEqual(await titles(w.staff.auditor), ['Brand-only: renegotiate the fee', 'Send the kit sizes'], 'brand staff share the brand\'s internal work');
  assert.deepEqual(await titles(w.ath), ['Athlete-only: ask for a higher fee', 'Send the kit sizes']);
  // direct reads: 404, not 403, so the item's existence is not revealed
  assert.equal((await api('GET', `/sponsorship-tasks/${mine.id}`, { token: w.ath.token })).status, 404);
  assert.equal((await api('GET', `/sponsorship-tasks/${theirs.id}`, { token: w.owner.token })).status, 404);
  assert.equal((await api('GET', `/sponsorship-tasks/${shared.id}`, { token: w.ath.token })).status, 200);
  // notes
  const notesFor = async (u) => must(await api('GET', '/sponsorship-notes', { token: u.token, query: { sponsorship_id: w.id } })).items.map((x) => x.body);
  assert.deepEqual(await notesFor(w.owner), ['Budget is tight this quarter']);
  assert.deepEqual(await notesFor(w.ath), ['My private thought']);
  assert.equal((await api('GET', '/sponsorship-notes', { token: w.ath.token, query: { task_id: mine.id } })).status, 404);
  // another tenant sees nothing, learns nothing
  for (const r of [await api('GET', '/sponsorship-tasks', { token: w.outsider.token, query: { sponsorship_id: w.id } }), await api('GET', `/sponsorship-tasks/${shared.id}`, { token: w.outsider.token }), await mk(w, w.outsider)])
    assert.equal(r.status, 404);
  // a platform admin reads shared items only and writes nothing
  const admin = await mkAdmin();
  assert.deepEqual(await titles(admin), ['Send the kit sizes']);
  assert.equal((await api('GET', `/sponsorship-tasks/${mine.id}`, { token: admin.token })).status, 404);
  assert.equal((await mk(w, admin)).status, 403);
  assert.deepEqual(await notesFor(admin), []);
  // a shared task is read-only for the other side
  assert.equal((await patch(shared, w.ath, { status: 'done' })).status, 403);
  const seen = must(await api('GET', `/sponsorship-tasks/${shared.id}`, { token: w.ath.token }));
  assert.equal(seen.can_edit, false);
  assert.equal((await api('POST', '/sponsorship-notes', { token: w.owner.token, body: { task_id: mine.id, visibility: 'shared', body: 'x' } })).status, 400, 'a note on an internal task cannot be shared');
});

test('exports honour the same visibility and are audit-logged; roles are enforced server-side', async () => {
  const w = await world();
  await task(w, w.owner, { title: 'Brand secret' });
  await task(w, w.ath, { title: 'Athlete secret' });
  await task(w, w.owner, { visibility: 'shared', title: 'Common' });
  const csv = must(await api('GET', '/sponsorship-task-export', { token: w.staff.auditor.token, query: { sponsorship_id: w.id } }));
  assert.equal(csv.rows, 2);
  assert.ok(csv.csv.includes('Brand secret') && csv.csv.includes('Common') && !csv.csv.includes('Athlete secret'));
  assert.equal((await api('GET', '/sponsorship-task-export', { token: w.staff.evaluator.token, query: { sponsorship_id: w.id } })).status, 403, 'evaluators cannot export');
  assert.equal((await api('GET', '/sponsorship-task-export', { token: w.outsider.token, query: { sponsorship_id: w.id } })).status, 404);
  assert.equal((await sql("SELECT 1 FROM audit_log WHERE action='export' AND entity='sponsorship_tasks'")).length >= 1, true);
  assert.equal((await mk(w, w.staff.auditor)).status, 403, 'auditors read but cannot create');
  must(await mk(w, w.staff.evaluator), 201);
  must(await mk(w, w.staff.finance), 201);
});

test('assignment: only a live member of your own side; the assignee is told once, without the task text', async () => {
  const w = await world();
  assert.equal((await mk(w, w.owner, { assignee_id: w.outsider.id })).status, 400, 'not on the team');
  assert.equal((await mk(w, w.owner, { assignee_id: w.ath.id })).status, 400, 'the other side cannot be assigned');
  const t = await task(w, w.owner, { assignee_id: w.staff.manager.id, title: 'Confidential: fee cap 12000', detail: 'amount 12000 SGD' });
  const got = await inbox(w.staff.manager);
  assert.equal(got.length, 1);
  assert.ok(!JSON.stringify(got[0]).match(/Confidential|12000|SGD/), 'no sensitive preview');
  assert.equal(got[0].data.task_id, t.id);
  const t2 = must(await patch(t, w.owner, { assignee_id: w.staff.finance.id }));
  assert.equal((await inbox(w.staff.finance)).length, 1);
  // assigning to yourself, or re-sending an unchanged assignee, notifies nobody
  must(await patch(t2, w.owner, { assignee_id: w.owner.id }));
  assert.equal((await inbox(w.owner)).length, 0);
});

test('stale versions and invalid transitions are refused; concurrent edits cannot both win', async () => {
  const w = await world();
  const t = await task(w, w.owner);
  const [a, b] = await Promise.all([patch(t, w.owner, { title: 'First edit' }), patch(t, w.staff.manager, { title: 'Second edit' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.error.details.code, 'stale_version');
  const cur = must(await api('GET', `/sponsorship-tasks/${t.id}`, { token: w.owner.token }));
  const done = must(await patch(cur, w.owner, { status: 'done' }));
  assert.ok(done.completed_at);
  assert.equal((await patch(done, w.owner, { title: 'edit a done task' })).status, 409);
  const reopened = must(await patch(done, w.owner, { status: 'open' }));
  assert.equal(reopened.completed_at, null);
  const cancelled = must(await patch(reopened, w.owner, { status: 'cancelled' }));
  const final = await patch(cancelled, w.owner, { status: 'open' });
  assert.equal(final.status, 409);
  assert.equal(final.body.error.details.code, 'invalid_transition');
  assert.equal((await sql('SELECT count(*)::int AS n FROM sponsorship_tasks WHERE id=$1', [t.id]))[0].n, 1, 'cancelled, never deleted');
});

test('reminders: once per milestone, retries and a second worker send nothing twice, copy has no task text', async () => {
  const w = await world();
  const t = await task(w, w.owner, { assignee_id: w.staff.manager.id, due_on: await inDays(2), title: 'Secret sponsorship clause review' });
  const base0 = (await inbox(w.staff.manager)).length;
  const runs = await Promise.all([sendTaskReminders(), sendTaskReminders()]);
  assert.equal(runs.reduce((a, b) => a + b, 0), 1, 'two workers at once send one reminder');
  assert.equal((await sendTaskReminders()), 0, 'a retry sends nothing');
  const mine = await inbox(w.staff.manager);
  assert.equal(mine.length, base0 + 1);
  assert.equal(mine.at(-1).title, 'A sponsorship task is coming up');
  assert.ok(!JSON.stringify(mine.at(-1)).includes('Secret'));
  // the due date arrives: one more; overdue: one more; each only once
  await sql('UPDATE sponsorship_tasks SET due_on=current_date WHERE id=$1', [t.id]);
  assert.equal(await sendTaskReminders(), 1);
  assert.equal(await sendTaskReminders(), 0);
  await sql("UPDATE sponsorship_tasks SET due_on=current_date-1 WHERE id=$1", [t.id]);
  assert.equal(await sendTaskReminders(), 1);
  assert.equal((await inbox(w.staff.manager)).map((x) => x.title).at(-1), 'A sponsorship task is overdue');
  assert.equal((await inbox(w.owner, 'sponsorship_task_escalation')).length, 0, 'not escalated yet');
  // the other side is never reminded about the brand's internal task
  assert.equal((await inbox(w.ath)).length, 0);
  assert.ok(STEPS.some(([name, key]) => name === 'sponsor_tasks' && key === 'sponsor_task_reminders'), 'the worker runs the reminders');
});

test('escalation: two days overdue goes to the managers once; manual escalation is idempotent per version; a done task stops everything', async () => {
  const w = await world();
  const t = await task(w, w.staff.evaluator, { assignee_id: w.staff.evaluator.id, due_on: await inDays(-3) });
  await sendTaskReminders();
  await sendTaskReminders();
  const esc = await inbox(w.staff.manager, 'sponsorship_task_escalation');
  assert.equal(esc.length, 1, 'managers hear once');
  assert.equal((await inbox(w.owner, 'sponsorship_task_escalation')).length, 1, 'the owner is a manager too');
  assert.equal((await inbox(w.staff.finance, 'sponsorship_task_escalation')).length, 0, 'finance is not a manager');
  const after = must(await api('GET', `/sponsorship-tasks/${t.id}`, { token: w.owner.token }));
  assert.equal(after.escalation_level, 1);
  assert.ok(after.overdue);
  // manual escalation, retried with the same version: the second is refused and nothing is sent twice
  const open = await task(w, w.owner, { assignee_id: w.staff.finance.id, title: 'Another' });
  const before = (await inbox(w.staff.manager, 'sponsorship_task_escalation')).length;
  const [x, y] = await Promise.all([1, 2].map(() => api('POST', `/sponsorship-tasks/${open.id}/escalate`, { token: w.staff.finance.token, body: { expected_version: open.row_version, reason: 'Blocked on legal' } })));
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal((await inbox(w.staff.manager, 'sponsorship_task_escalation')).length, before + 1);
  assert.equal((await sql('SELECT body FROM sponsorship_notes WHERE task_id=$1', [open.id]))[0].body, 'Escalated: Blocked on legal');
  // done tasks are no longer chased
  const fresh = must(await api('GET', `/sponsorship-tasks/${t.id}`, { token: w.owner.token }));
  must(await patch(fresh, w.owner, { status: 'done' }));
  await sql('UPDATE sponsorship_tasks SET due_on=current_date-9 WHERE id=$1', [t.id]);
  assert.equal(await sendTaskReminders(), 0);
});

test('removed staff lose access at once; their tasks go to the managers and deep links are re-checked', async () => {
  const w = await world();
  const t = await task(w, w.owner, { assignee_id: w.staff.evaluator.id, due_on: await inDays(1) });
  must(await api('GET', `/sponsorship-tasks/${t.id}`, { token: w.staff.evaluator.token }));
  assert.equal(must(await api('GET', '/sponsorship-tasks', { token: w.staff.evaluator.token, query: { mine: 'true' } })).items.length, 1);
  must(await api('DELETE', `/organisations/${w.org.id}/members/${w.staff.evaluator.id}`, { token: w.owner.token }));
  // read, write and the notification deep link all fail now
  assert.equal((await api('GET', `/sponsorship-tasks/${t.id}`, { token: w.staff.evaluator.token })).status, 404);
  assert.equal((await api('GET', '/sponsorship-tasks', { token: w.staff.evaluator.token, query: { sponsorship_id: w.id } })).status, 404);
  assert.equal((await patch(t, w.staff.evaluator, { status: 'done' })).status, 404);
  assert.equal((await api('GET', '/sponsorship-notes', { token: w.staff.evaluator.token, query: { task_id: t.id } })).status, 404);
  assert.equal((await api('GET', '/sponsorship-task-export', { token: w.staff.evaluator.token, query: { sponsorship_id: w.id } })).status, 404);
  assert.deepEqual(must(await api('GET', '/sponsorship-tasks', { token: w.staff.evaluator.token, query: { mine: 'true' } })).items, []);
  // the leaver is not reminded; the managers are told the task has no one
  const mark = (await inbox(w.staff.evaluator)).length;
  await sendTaskReminders();
  assert.equal((await inbox(w.staff.evaluator)).length, mark);
  const orphan = (await inbox(w.owner, 'sponsorship_task_escalation')).at(-1);
  assert.equal(orphan.title, 'A sponsorship task has no one to do it');
  const view = must(await api('GET', `/sponsorship-tasks/${t.id}`, { token: w.owner.token }));
  assert.equal(view.assignee.active, false, 'the roster is checked, not assumed');
  assert.equal((await patch(view, w.owner, { assignee_id: w.staff.evaluator.id })).status, 400, 'a leaver cannot be assigned again');
});

test('programs are the brand\'s own workspace: staff only, no other side, no admin, no sharing', async () => {
  const w = await world();
  const p = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Youth fund', currency: 'USD', budget_cents: 100000 } }), 201);
  const t = must(await api('POST', '/sponsorship-tasks', { token: w.staff.manager.token, body: { program_id: p.id, title: 'Review round 1 scoring', assignee_id: w.staff.evaluator.id, due_on: await inDays(1) } }), 201);
  assert.equal(t.scope, 'program');
  assert.equal((await api('POST', '/sponsorship-tasks', { token: w.owner.token, body: { program_id: p.id, title: 'Share it', visibility: 'shared' } })).status, 400);
  assert.equal((await api('POST', '/sponsorship-tasks', { token: w.staff.auditor.token, body: { program_id: p.id, title: 'x1' } })).status, 403);
  for (const u of [w.ath, w.outsider, await mkAdmin()]) {
    assert.equal((await api('GET', '/sponsorship-tasks', { token: u.token, query: { program_id: p.id } })).status, 404);
    assert.equal((await api('GET', `/sponsorship-tasks/${t.id}`, { token: u.token })).status, 404);
  }
  assert.equal((await api('POST', '/sponsorship-tasks', { token: w.owner.token, body: { program_id: p.id, sponsorship_id: w.id, title: 'both' } })).status, 400, 'exactly one target');
  must(await api('POST', '/sponsorship-notes', { token: w.staff.manager.token, body: { program_id: p.id, body: 'Panel meets Friday' } }), 201);
  assert.equal(must(await api('GET', '/sponsorship-notes', { token: w.staff.auditor.token, query: { program_id: p.id } })).items.length, 1);
  await sendTaskReminders();
  const link = (await inbox(w.staff.evaluator)).at(-1);
  assert.equal(link.data.program_id, p.id);
  assert.equal(link.data.task_id, t.id);
});

test('shared discussion reaches the other side without its text; closed agreements are read-only; notifications respect mute preferences', async () => {
  const w = await world();
  const s = await task(w, w.owner, { visibility: 'shared', title: 'Shared: confirm shoot date' });
  assert.equal((await inbox(w.ath, 'sponsorship_update')).filter((x) => x.title.includes('shared task')).length, 1);
  must(await api('POST', '/sponsorship-notes', { token: w.owner.token, body: { task_id: s.id, visibility: 'shared', body: 'Can we do the 14th at 10am?' } }), 201);
  must(await api('POST', '/sponsorship-notes', { token: w.ath.token, body: { task_id: s.id, visibility: 'shared', body: 'Yes, 14th works' } }), 201);
  const ping = (await inbox(w.ath, 'sponsorship_update')).at(-1);
  assert.ok(!JSON.stringify(ping).match(/14th|10am/), 'no preview of the message');
  const thread = must(await api('GET', `/sponsorship-tasks/${s.id}`, { token: w.ath.token }));
  assert.deepEqual(thread.notes_list.map((x) => x.body), ['Can we do the 14th at 10am?', 'Yes, 14th works']);
  assert.equal((await api('POST', '/sponsorship-notes', { token: w.staff.finance.token, body: { task_id: s.id, visibility: 'shared', body: 'finance speaking for the brand' } })).status, 403, 'only roles that may speak for the brand share');
  // mute preference (#243): the assignment is not delivered, the task is still assigned
  await sql("INSERT INTO notification_prefs(user_id, muted_kinds) VALUES ($1, ARRAY['sponsorship_task']) ON CONFLICT (user_id) DO UPDATE SET muted_kinds=EXCLUDED.muted_kinds", [w.staff.manager.id]);
  const before = (await inbox(w.staff.manager)).length;
  const t = await task(w, w.owner, { assignee_id: w.staff.manager.id });
  assert.equal((await inbox(w.staff.manager)).length, before);
  assert.equal(t.assignee.id, w.staff.manager.id);
  // a declined / withdrawn agreement can no longer take work
  await sql("UPDATE sponsorships SET status='ended' WHERE id=$1", [w.id]);
  must(await mk(w, w.owner), 201);
  await sql("UPDATE sponsorships SET status='withdrawn' WHERE id=$1", [w.id]);
  assert.equal((await mk(w, w.owner)).status, 409);
  assert.equal((await api('POST', '/sponsorship-notes', { token: w.owner.token, body: { sponsorship_id: w.id, body: 'late' } })).status, 409);
  assert.equal(await sendTaskReminders(), 0, 'no reminders on a withdrawn agreement');
});

test('recipient organisations: only a representative writes; the migration is additive', async () => {
  const owner = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Solo ${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const d = must(await api('POST', '/sponsorships', { token: owner.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Kit', ...period, lines: [money] } }), 201);
  // an offer that is still being negotiated can already carry shared work; the recipient assigns to themselves
  const t = must(await api('POST', '/sponsorship-tasks', { token: ath.token, body: { sponsorship_id: d.id, title: 'Read the contract', assignee_id: ath.id, due_on: await inDays(5) } }), 201);
  assert.equal(t.side, 'recipient');
  assert.equal((await api('GET', `/sponsorship-tasks/${t.id}`, { token: owner.token })).status, 404, 'the brand never sees the recipient\'s internal tasks');
  const cols = (await sql("SELECT column_name FROM information_schema.columns WHERE table_name='sponsorships'")).map((c) => c.column_name);
  assert.ok(['status', 'renews_id', 'accepted_version', 'amount_cents'].every((c) => cols.includes(c)), 'existing agreement columns are untouched');
});

/** A published program of the world's brand with one open round, and an applicant with a submitted application. */
const applied = async (w, who) => {
  const p = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Youth fund', currency: 'USD', budget_cents: 100000, max_award_cents: 50000 } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: w.owner.token, body: { opens_on: await inDays(-1), closes_on: await inDays(30) } }), 201);
  must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: w.owner.token, body: { status: 'published', version: p.row_version } }));
  const a = who ?? await signup(['athlete']);
  const app = must(await api('POST', `/program-rounds/${r.id}/applications`, { token: a.token, body: { requested_cents: 20000, pitch: 'Please', target_type: 'athlete', target_id: a.id } }), 201);
  return { p, r, a, app };
};
const thread = (u, app, extra = {}) => api('POST', '/sponsorship-notes', { token: u.token, body: { application_id: app.id, ...extra } });

test('program discussion: a private thread between the brand and one applicant, never visible to other applicants, brands or admins', async () => {
  const w = await world();
  const { p, a, app } = await applied(w);
  const other = await applied(w); // a second applicant on another program of the same brand
  const second = await signup(['athlete']);
  const app2 = must(await api('POST', `/program-rounds/${other.r.id}/applications`, { token: second.token, body: { requested_cents: 10000, pitch: 'Me too', target_type: 'athlete', target_id: second.id } }), 201);
  // the brand speaks (manager has the program right), the applicant answers
  must(await thread(w.staff.manager, app, { visibility: 'shared', body: 'Can you share your season calendar?' }), 201);
  must(await thread(a, app, { body: 'Sure, sending it today', visibility: 'internal' }), 201);
  const mineSeen = must(await api('GET', '/sponsorship-notes', { token: a.token, query: { application_id: app.id } }));
  assert.deepEqual(mineSeen.items.map((x) => [x.side, x.visibility]), [['sponsor', 'shared'], ['recipient', 'shared']], 'an applicant\'s note is always shared');
  assert.equal(mineSeen.can_write, true);
  // roles: evaluators note internally for the brand but do not speak to applicants; auditors only read
  must(await thread(w.staff.evaluator, app, { visibility: 'internal', body: 'Pitch looks thin; check references' }), 201);
  assert.equal((await thread(w.staff.evaluator, app, { visibility: 'shared', body: 'x' })).status, 403);
  assert.equal((await thread(w.staff.auditor, app, { body: 'x' })).status, 403);
  assert.equal(must(await api('GET', '/sponsorship-notes', { token: w.staff.auditor.token, query: { application_id: app.id } })).items.length, 3, 'brand staff see internal notes too');
  assert.equal(must(await api('GET', '/sponsorship-notes', { token: a.token, query: { application_id: app.id } })).items.length, 2, 'the applicant never sees the brand\'s internal note');
  // isolation: another applicant, an outsider brand, an admin and the other program's team learn nothing
  for (const u of [second, w.outsider, await mkAdmin()]) {
    assert.equal((await api('GET', '/sponsorship-notes', { token: u.token, query: { application_id: app.id } })).status, u === second ? 404 : 404);
    assert.equal((await thread(u, app, { visibility: 'shared', body: 'let me in' })).status, 404);
  }
  assert.deepEqual(must(await api('GET', '/sponsorship-notes', { token: second.token, query: { application_id: app2.id } })).items, []);
  assert.equal(must(await api('GET', '/sponsorship-notes', { token: w.owner.token, query: { program_id: p.id } })).items.length, 0, 'threads are not mixed into the program\'s internal notes');
  // notifications: generic, to the right people, deduped
  const told = await inbox(a, 'sponsorship_update');
  assert.ok(told.length >= 1 && !JSON.stringify(told).match(/calendar|season/), 'no preview of the message');
  assert.equal(told.at(-1).data.application_id, app.id);
  assert.equal(told.at(-1).data.program_id, undefined, 'the applicant is not handed the program');
  const brandTold = await inbox(w.staff.manager, 'sponsorship_update');
  assert.equal(brandTold.at(-1).data.program_id, p.id);
  assert.ok(!JSON.stringify(brandTold).includes('Sure, sending'));
  // read-only once the program is archived; no direct thread with a minor; a draft application cannot write
  await sql("UPDATE users SET youth_until=current_date+400 WHERE id=$1", [second.id]);
  assert.equal((await thread(second, app2, { body: 'hello' })).status, 403, 'a minor is not put in a direct thread');
  assert.equal(must(await api('GET', '/sponsorship-notes', { token: second.token, query: { application_id: app2.id } })).youth_blocked, true);
  await sql("UPDATE sponsorship_programs SET status='archived' WHERE id=$1", [p.id]);
  assert.equal((await thread(a, app, { body: 'late' })).status, 409);
  assert.equal(must(await api('GET', '/sponsorship-notes', { token: a.token, query: { application_id: app.id } })).items.length, 2, 'the record stays readable');
  assert.equal((await sql('SELECT count(*)::int AS n FROM sponsorship_notes WHERE application_id=$1', [app.id]))[0].n, 3, 'nothing is deleted');
});

test('expiry tasks are created automatically once per side and end date, complete with the renewal plan, and follow a moved end date', async () => {
  const w = await world();
  const brandSide = async () => sql("SELECT * FROM sponsorship_tasks WHERE sponsorship_id=$1 AND system_key IS NOT NULL ORDER BY side, created_at", [w.id]);
  assert.equal(await ensureExpiryTasks(), 0, 'far from the end date nothing is created');
  await sql('UPDATE sponsorships SET ends_on=current_date+45 WHERE id=$1', [w.id]);
  assert.equal(await ensureExpiryTasks(), 2, 'one for each side');
  assert.equal(await ensureExpiryTasks(), 0, 'rerun adds nothing');
  await Promise.all([1, 2].map(() => ensureExpiryTasks()));
  const tasks = await brandSide();
  assert.deepEqual(tasks.map((t) => [t.side, t.kind, t.status, t.visibility]), [['recipient', 'expiry', 'open', 'internal'], ['sponsor', 'expiry', 'open', 'internal']]);
  assert.equal(tasks.length, 2, 'two parallel sweeps still make one per side');
  const sp = tasks.find((t) => t.side === 'sponsor'), re = tasks.find((t) => t.side === 'recipient');
  assert.equal(re.assignee_id, w.ath.id);
  assert.equal(sp.assignee_id, w.owner.id);
  const due = (await sql("SELECT (current_date+15)::text AS d"))[0].d;
  assert.equal(String((await sql('SELECT due_on::text AS d FROM sponsorship_tasks WHERE id=$1', [sp.id]))[0].d), due, 'dated 30 days before the term ends');
  // visible only to its own side, flagged as automatic
  const seen = must(await api('GET', '/sponsorship-tasks', { token: w.ath.token, query: { sponsorship_id: w.id } })).items;
  assert.deepEqual(seen.map((t) => [t.title, t.system]), [['Decide whether to renew this agreement', true]]);
  // recording the plan completes it for that side only
  const rev = must(await api('GET', `/sponsorships/${w.id}`, { token: w.ath.token })).renewal.renewal_rev;
  must(await api('POST', `/sponsorships/${w.id}/renewal-assessment`, { token: w.ath.token, body: { expected_renewal_rev: rev, intent: 'renew' } }));
  await ensureExpiryTasks();
  assert.deepEqual((await brandSide()).map((t) => [t.side, t.status]), [['recipient', 'done'], ['sponsor', 'open']]);
  // the end date moves: the stale reminder is cancelled (never deleted) and a new one made for the new date
  await sql('UPDATE sponsorships SET ends_on=current_date+60 WHERE id=$1', [w.id]);
  await ensureExpiryTasks();
  const after = await brandSide();
  assert.equal(after.filter((t) => t.side === 'sponsor' && t.status === 'cancelled').length, 1);
  assert.equal(after.filter((t) => t.side === 'sponsor' && t.status === 'open').length, 1);
  // it feeds the normal reminders: due soon -> the assignee hears once, generically
  await sql("UPDATE sponsorship_tasks SET due_on=current_date+2 WHERE sponsorship_id=$1 AND side='sponsor' AND status='open'", [w.id]);
  const before = (await inbox(w.owner)).length;
  assert.ok(await processSponsorTasks() >= 1);
  const got = (await inbox(w.owner)).slice(before);
  assert.equal(got.length, 1);
  assert.ok(!JSON.stringify(got).match(/renew/i), 'no text of the task in the notification');
  // a renewal in progress, or an ended agreement, makes no new tasks
  const w2 = await world();
  await sql('UPDATE sponsorships SET ends_on=current_date+20 WHERE id=$1', [w2.id]);
  const rev2 = must(await api('GET', `/sponsorships/${w2.id}`, { token: w2.owner.token })).renewal.renewal_rev;
  must(await api('POST', `/sponsorships/${w2.id}/renewal`, { token: w2.owner.token, body: { expected_renewal_rev: rev2, starts_on: await inDays(25), ends_on: await inDays(200) } }), 201);
  await ensureExpiryTasks();
  assert.equal((await sql('SELECT count(*)::int AS n FROM sponsorship_tasks WHERE sponsorship_id=$1', [w2.id]))[0].n, 0, 'a live renewal needs no reminder');
});

test('delivery status is honest: the app is told whether the worker is beating and whether email is configured', async () => {
  const w = await world();
  const off = must(await api('GET', '/sponsorship-tasks', { token: w.owner.token, query: { sponsorship_id: w.id } })).reminders;
  assert.equal(off.in_app, true);
  assert.equal(off.email, !!config.notifyWebhook.url);
  assert.equal(off.worker, false, 'no worker has beaten in a fresh database');
  await sql("INSERT INTO worker_heartbeats(worker_id, mode, host, status, interval_seconds, last_beat_at) VALUES ('w-collab-test','external','test','running',60,now())");
  assert.equal(must(await api('GET', '/sponsorship-tasks', { token: w.owner.token, query: { sponsorship_id: w.id } })).reminders.worker, true);
  const saved = config.notifyWebhook.url;
  config.notifyWebhook.url = 'http://127.0.0.1:9/hook';
  assert.equal(must(await api('GET', '/sponsorship-tasks', { token: w.owner.token, query: { sponsorship_id: w.id } })).reminders.email, true);
  config.notifyWebhook.url = saved;
  await sql("DELETE FROM worker_heartbeats WHERE worker_id='w-collab-test'");
});
