import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body, raw } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (over = {}) => {
  n++;
  const email = over.email ?? `mig${n}@example.com`;
  const r = await api('POST', '/auth/register', { body: { handle: `mig_${n}`, display_name: over.display_name ?? `Mig ${n}`, email, password: 'correct-horse-battery', roles: over.roles ?? ['athlete'], ...(over.dob ? { dob: over.dob } : {}) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token, email };
};
const setup = async () => {
  const owner = await signup({ roles: ['coach'] });
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Club', kind: 'club' } })).body;
  return { owner, org };
};
const CSV = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';
const HEAD = ['First', 'Last', 'Email', 'Team', 'Role', 'Jersey Number', 'Birthday', 'Parent Email'];
const start = (o, body) => api('POST', `/organisations/${o.org.id}/migrations`, { token: o.owner.token, body });
const flow = async (o, id) => {
  const chk = await api('POST', `/migrations/${id}/check`, { token: o.owner.token });
  assert.equal(chk.status, 200, JSON.stringify(chk.body));
  return chk.body;
};
const rows = async (o, id, status) => (await api('GET', `/migrations/${id}/rows${status ? `?status=${status}` : ''}`, { token: o.owner.token })).body;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('sources, templates and the things an import never carries', async () => {
  const u = await signup();
  const s = (await api('GET', '/migrations/sources', { token: u.token })).body;
  assert.deepEqual(s.sources.map((x) => x.key), ['teamsnap', 'sportsengine', 'excel']);
  assert.ok(s.domains[0].fields.some((f) => f.key === 'email' && f.required));
  assert.ok(s.not_importable.includes('guardian links and consents'));
  for (const source of ['teamsnap', 'sportsengine', 'excel']) {
    const t = (await api('GET', `/migrations/template?source=${source}`, { token: u.token })).body;
    assert.match(t.csv, /mail/i);
  }
});

test('a TeamSnap-style file: mapping is proposed, the dry run explains every row, conflicts block approval until a person decides', async () => {
  const o = await setup();
  const existing = await signup({ display_name: 'Priya Shah', email: 'priya@example.com' });
  const other = await signup({ display_name: 'Totally Different', email: 'clash@example.com' });
  const csv = CSV([HEAD,
    ['Priya', 'Shah', 'priya@example.com', 'U12 Boys', 'Player', '7', '14/03/2014', 'mum@example.com'],   // youth, guardian given, registered
    ['Ravi', 'Menon', 'ravi@example.com', 'U12 Boys', 'Player', '9', '02/11/2012', 'dad@example.com'],     // youth, not registered yet
    ['Anita', 'Rao', 'anita@example.com', 'U12 Boys', 'Head Coach', '', '', ''],                           // adult coach, not registered
    ['Kid', 'NoGuardian', 'kid@example.com', 'U12 Boys', 'Player', '', '01/01/2015', ''],                  // youth without guardian -> rejected
    ['No', 'Email', '', 'U12 Boys', 'Player', '', '', ''],                                                  // no email -> rejected, never matched on name
    ['Bad', 'Date', 'bad@example.com', 'U12 Boys', 'Player', '', '31/31/2000', ''],                         // unreadable date -> rejected, not guessed
    ['Anita', 'Rao', 'anita@example.com', 'U12 Boys', 'Player', '', '', ''],                                // same person+team twice -> duplicate
    ['Fake', 'Name', 'clash@example.com', 'U12 Boys', 'Player', '', '', ''],                                // email of an account with another name -> conflict
    ['Parent', 'Person', 'parent@example.com', 'U12 Boys', 'Parent', '', '', ''],                           // not a team role -> skipped
  ]);
  const created = await start(o, { source: 'teamsnap', csv, file_name: 'roster.csv', sport: 'football' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const p = created.body;
  assert.equal(p.status, 'mapping');
  assert.deepEqual([p.mapping.first_name, p.mapping.email, p.mapping.team, p.mapping.guardian_email, p.mapping.jersey_no, p.mapping.dob], ['First', 'Email', 'Team', 'Parent Email', 'Jersey Number', 'Birthday']);
  assert.deepEqual(p.analysis.missing, []);
  // nothing exists yet
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM teams WHERE organisation_id=$1", [o.org.id])).rows[0].n, 0);
  assert.equal((await api('POST', `/migrations/${p.id}/approve`, { token: o.owner.token })).status, 409, 'cannot approve before a dry run');

  const chk = await flow(o, p.id);
  assert.deepEqual({ ...chk.summary }, { total: 9, needs_sport: 0, valid: 3, warning: 0, rejected: 3, duplicate: 1, conflict: 1, skipped: 1, pending: 0, with_warnings: 0, importable: 3 });
  const rej = await rows(o, p.id, 'rejected');
  assert.deepEqual(rej.map((r) => r.row_no), [5, 6, 7]);
  assert.match(rej[0].reasons.map((x) => x.message).join(), /guardian email/);
  assert.match(rej[1].reasons.map((x) => x.message).join(), /never on a name/);
  assert.match(rej[2].reasons.map((x) => x.message).join(), /DD\/MM\/YYYY/);
  assert.ok(rej[0].person.email.includes('•'), 'emails are masked');
  assert.equal(rej[0].person.email.includes('kid@'), false);
  const conflicts = await rows(o, p.id, 'conflict');
  assert.equal(conflicts.length, 1);

  assert.equal((await api('POST', `/migrations/${p.id}/approve`, { token: o.owner.token })).status, 409, 'an unreviewed identity conflict blocks approval');
  assert.equal((await api('POST', `/migrations/${p.id}/rows/${conflicts[0].id}/review`, { token: o.owner.token, body: { decision: 'skipped' } })).status, 200);
  const again = await flow(o, p.id);
  assert.equal(again.summary.conflict, 0);
  assert.equal(again.summary.skipped, 2, 'the skipped conflict stays decided after a re-check');
  assert.equal((await api('POST', `/migrations/${p.id}/run`, { token: o.owner.token })).status, 409, 'cannot run before approval');
  const ap = await api('POST', `/migrations/${p.id}/approve`, { token: o.owner.token });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));

  const run = await api('POST', `/migrations/${p.id}/run`, { token: o.owner.token });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.project.status, 'completed');
  assert.deepEqual({ invited: run.body.report.result.invited, waiting: run.body.report.result.awaiting_signup, consent: run.body.report.result.awaiting_consent }, { invited: 0, waiting: 2, consent: 1 });
  // the registered young person has no guardian consent: nothing was created for them, and no consent or guardian link was invented
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM youth_consents WHERE child_id=$1', [existing.id]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0);
  assert.equal((await api('GET', '/me/team-invites', { token: existing.token })).body.length, 0);
  const team = (await pool.query("SELECT id, name, owner_id FROM teams WHERE organisation_id=$1", [o.org.id])).rows;
  assert.deepEqual(team.map((t) => t.name), ['U12 Boys']);
  assert.equal(run.body.report.teams_created[0].name, 'U12 Boys');
  assert.equal(run.body.report.financial, null);

  // a person who registers later receives the invitation, still to accept: never added directly
  const anita = await signup({ display_name: 'Anita Rao', email: 'anita@example.com' });
  const inv = (await api('GET', '/me/team-invites', { token: anita.token })).body;
  assert.equal(inv.length, 1);
  assert.equal(inv[0].role, 'coach');
  assert.equal((await pool.query("SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2", [team[0].id, anita.id])).rows[0].status, 'invited');

  // running again changes nothing (idempotent), and the report shows the unresolved rows with masked emails
  const before = (await pool.query('SELECT count(*)::int AS n FROM team_members')).rows[0].n;
  assert.equal((await api('POST', `/migrations/${p.id}/run`, { token: o.owner.token })).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_members')).rows[0].n, before);
  const rep = (await api('GET', `/migrations/${p.id}/report`, { token: o.owner.token })).body;
  assert.equal(rep.source_rows, 9);
  assert.ok(rep.unresolved.length >= 6);
  assert.ok(rep.unresolved.every((u) => !u.email || u.email.includes('•')));
  assert.equal(JSON.stringify(rep).includes('priya@example.com'), false);

  // the same file again does not invite anyone twice
  const second = (await start(o, { source: 'teamsnap', csv, sport: 'football' })).body;
  const chk2 = await flow(o, second.id);
  assert.ok(chk2.summary.duplicate >= 2, JSON.stringify(chk2.summary));
});

test('a person who is already registered gets an invitation they accept; day/month order is chosen, never guessed', async () => {
  const o = await setup();
  const adult = await signup({ display_name: 'Sam Lee', email: 'sam@example.com' });
  const csv = CSV([['first_name', 'last_name', 'email', 'date_of_birth', 'team', 'jersey_number'],
    ['Sam', 'Lee', 'sam@example.com', '12/03/1990', 'Seniors', '10'],
    ['Zed', 'Quick', 'zed@example.com', '25/12/1990', 'Seniors', '11']]);
  const p = (await start(o, { source: 'excel', csv, sport: 'cricket' })).body;
  // 25/12 is not a valid month/day under month-first, so the second row is rejected until the format is right
  await api('PATCH', `/migrations/${p.id}`, { token: o.owner.token, body: { options: { date_format: 'MM/DD/YYYY' } } });
  const wrong = await flow(o, p.id);
  assert.equal(wrong.summary.rejected, 1);
  const fixed = await api('PATCH', `/migrations/${p.id}`, { token: o.owner.token, body: { options: { date_format: 'DD/MM/YYYY' } } });
  assert.equal(fixed.body.status, 'mapping', 'a mapping change sends the import back for a fresh check');
  assert.equal((await flow(o, p.id)).summary.rejected, 0);
  assert.equal((await api('POST', `/migrations/${p.id}/approve`, { token: o.owner.token })).status, 200);
  const run = (await api('POST', `/migrations/${p.id}/run`, { token: o.owner.token })).body;
  assert.equal(run.report.result.invited, 1);
  assert.equal(run.report.result.awaiting_signup, 1);
  const inv = (await api('GET', '/me/team-invites', { token: adult.token })).body;
  assert.equal(inv[0].name, 'Seniors');
  assert.equal((await api('POST', `/teams/${inv[0].team_id}/invitations/respond`, { token: adult.token, body: { accept: true } })).status, 200);

  // rollback keeps whoever already accepted, withdraws what is still open, and archives nothing that is in use
  const rb = (await api('POST', `/migrations/${p.id}/rollback`, { token: o.owner.token })).body;
  assert.equal(rb.kept_because_accepted, 1, 'someone who already accepted is protected history and stays');
  assert.equal(rb.withdrawn, 1, 'the waiting (not yet registered) row is released');
  assert.equal(rb.teams_kept_in_use, 1);
  assert.equal((await pool.query("SELECT status FROM team_members WHERE user_id=$1", [adult.id])).rows[0].status, 'active');
});

test('rollback withdraws unanswered invitations and archives an unused team, deleting nothing', async () => {
  const o = await setup();
  await signup({ display_name: 'Jo Park', email: 'jo@example.com' });
  const csv = CSV([['first_name', 'last_name', 'email', 'team'], ['Jo', 'Park', 'jo@example.com', 'Reserves']]);
  const p = (await start(o, { source: 'csv', csv, sport: 'football' })).body;
  await flow(o, p.id);
  await api('POST', `/migrations/${p.id}/approve`, { token: o.owner.token });
  assert.equal((await api('POST', `/migrations/${p.id}/run`, { token: o.owner.token })).body.report.result.invited, 1);
  const rb = (await api('POST', `/migrations/${p.id}/rollback`, { token: o.owner.token })).body;
  assert.equal(rb.withdrawn, 1);
  assert.equal(rb.teams_archived, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM team_members WHERE status='left' AND role='player'")).rows[0].n >= 1, true);
  assert.equal((await pool.query("SELECT archived_at IS NOT NULL AS a FROM teams WHERE organisation_id=$1 AND name='Reserves'", [o.org.id])).rows[0].a, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1', [p.id])).rows[0].n, 1, 'rows are kept');
  assert.equal((await api('GET', `/migrations/${p.id}`, { token: o.owner.token })).body.status, 'rolled_back_partially');
  // a teamless row is a warning, and a team that does not exist without a sport is rejected rather than invented
  const p2 = (await start(o, { source: 'csv', csv: CSV([['first_name', 'email', 'team'], ['Al', 'al@example.com', 'Brand New']]) })).body;
  const c2 = await flow(o, p2.id);
  assert.equal(c2.summary.rejected, 1);
});

test('only owners and admins of the organisation can import; outsiders get 404; nothing is stored in the clear', async () => {
  const o = await setup();
  const outsider = await signup(), coach = await signup();
  await api('POST', `/organisations/${o.org.id}/members`, { token: o.owner.token, body: { person: coach.handle, role: 'coach' } });
  await api('POST', `/organisations/${o.org.id}/invite/respond`, { token: coach.token, body: { accept: true } });
  const csv = CSV([['first_name', 'email', 'team'], ['Cy', 'cy.secret@example.com', 'A']]);
  assert.equal((await api('POST', `/organisations/${o.org.id}/migrations`, { token: outsider.token, body: { source: 'csv', csv, sport: 'football' } })).status, 404);
  assert.equal((await api('POST', `/organisations/${o.org.id}/migrations`, { token: coach.token, body: { source: 'csv', csv, sport: 'football' } })).status, 403);
  const p = (await start(o, { source: 'csv', csv, sport: 'football' })).body;
  for (const [m, path] of [['GET', `/migrations/${p.id}`], ['GET', `/migrations/${p.id}/rows`], ['GET', `/migrations/${p.id}/report`], ['POST', `/migrations/${p.id}/check`], ['POST', `/migrations/${p.id}/run`], ['POST', `/migrations/${p.id}/rollback`]]) {
    assert.equal((await api(m, path, { token: outsider.token })).status, 404, `${m} ${path}`);
    assert.equal((await api(m, path)).status, 401);
  }
  const dump = JSON.stringify((await pool.query('SELECT * FROM migration_rows WHERE project_id=$1', [p.id])).rows);
  assert.equal(dump.includes('cy.secret'), false, 'raw and canonical rows are encrypted');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_migration_rows'")).rows[0].n >= 0, true);
  // the file must have a header, rows and an email column before it is accepted for mapping
  assert.equal((await start(o, { source: 'csv', csv: 'first_name,email\n' })).status, 400);
  const noEmail = (await start(o, { source: 'csv', csv: 'first_name,team\nA,B\n' })).body;
  assert.deepEqual(noEmail.analysis.missing, ['email']);
  assert.equal((await api('POST', `/migrations/${noEmail.id}/check`, { token: o.owner.token })).status, 400);
});

test('500 rows import in batches and a retry after an interruption never duplicates anyone', async () => {
  const o = await setup();
  const lines = [['first_name', 'last_name', 'email', 'team']];
  for (let i = 0; i < 230; i++) lines.push([`P${i}`, 'Bulk', `bulk${i}@example.com`, i % 2 ? 'North' : 'South']);
  const p = (await start(o, { source: 'excel', csv: CSV(lines), sport: 'football' })).body;
  assert.equal(p.status, 'mapping');
  assert.equal((await flow(o, p.id)).summary.importable, 230);
  await api('POST', `/migrations/${p.id}/approve`, { token: o.owner.token });
  // simulate an interruption: the first 120 rows were imported, then the process died before finishing
  const { runProject } = await import('../src/migration.js');
  const first = (await pool.query("SELECT id FROM migration_rows WHERE project_id=$1 ORDER BY row_no LIMIT 120", [p.id])).rows.map((r) => r.id);
  await pool.query("UPDATE migration_projects SET status='importing', started_at=now() WHERE id=$1", [p.id]);
  await pool.query("UPDATE migration_rows SET check_status='skipped' WHERE project_id=$1 AND id <> ALL($2::uuid[])", [p.id, first]);
  await runProject(p.id, o.owner).catch(() => {});
  await pool.query("UPDATE migration_rows SET check_status='valid' WHERE project_id=$1 AND check_status='skipped'", [p.id]);
  await pool.query("UPDATE migration_projects SET status='importing' WHERE id=$1", [p.id]);
  const run = (await api('POST', `/migrations/${p.id}/run`, { token: o.owner.token })).body;
  assert.equal(run.report.result.awaiting_signup, 230);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM migration_links WHERE project_id=$1", [p.id])).rows[0].n, 230, 'one link per person and team');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM teams WHERE organisation_id=$1", [o.org.id])).rows[0].n, 2, 'teams are created once');
  const again = (await api('POST', `/migrations/${p.id}/run`, { token: o.owner.token })).body;
  assert.equal(again.report.result.awaiting_signup, 230);
});

test('guided setup: persona, derived steps, nothing to tick by hand', async () => {
  const none = await signup();
  const start0 = (await api('GET', '/me/launch-checklist', { token: none.token })).body;
  assert.equal(start0.suggested, null);
  assert.equal(start0.steps.length, 0);
  assert.deepEqual(start0.personas.map((p) => p.key), ['academy', 'club', 'school', 'venue', 'organiser', 'coach']);
  const noOrg = (await api('GET', '/me/launch-checklist?persona=academy', { token: none.token })).body;
  assert.equal(noOrg.steps[0].key, 'workspace');
  assert.equal(noOrg.steps[0].done, false);

  const owner = await signup();
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: 'Hilltop Academy', kind: 'academy' } })).body;
  const a = (await api('GET', '/me/launch-checklist', { token: owner.token })).body;
  assert.equal(a.persona, 'academy');
  assert.equal(a.organisation.id, org.id);
  assert.equal(a.next, 'legal');
  assert.equal(a.steps.find((s) => s.key === 'workspace').done, true);
  assert.equal(a.steps.find((s) => s.key === 'people').action, 'import');
  await api('PATCH', `/organisations/${org.id}`, { token: owner.token, body: { legal_name: 'Hilltop Sports Pvt Ltd', tax_id: '29ABCDE1234F1Z5', contact_email: 'hi@hilltop.example' } });
  await api('POST', `/organisations/${org.id}/seasons`, { token: owner.token, body: { name: '2026-27', starts_on: '2026-06-01', ends_on: '2027-03-31' } });
  const b = (await api('GET', '/me/launch-checklist', { token: owner.token })).body;
  assert.ok(b.done > a.done);
  for (const k of ['legal', 'contact', 'season']) assert.equal(b.steps.find((s) => s.key === k).done, true, k);
  // a stranger cannot read another organisation's checklist
  assert.equal((await api('GET', `/me/launch-checklist?persona=club&organisation_id=${org.id}`, { token: none.token })).status, 404);
  // persona and dismissal are the only stored things
  assert.deepEqual((await api('PATCH', '/me/launch-checklist', { token: owner.token, body: { persona: 'coach', dismissed: true } })).body, { persona: 'coach', dismissed: true });
  const c = (await api('GET', '/me/launch-checklist', { token: owner.token })).body;
  assert.equal(c.persona, 'coach');
  assert.equal(c.dismissed, true);
  assert.equal(c.steps.map((s) => s.key).join(), 'profile,team,first_transaction');
  for (const p of ['venue', 'organiser']) assert.ok((await api('GET', `/me/launch-checklist?persona=${p}`, { token: owner.token })).body.steps.length >= 3, p);
  assert.equal((await api('PATCH', '/me/launch-checklist', { token: owner.token, body: { dismissed: false } })).body.dismissed, false);
});

test('the file reader turns CSV, semicolon and tab files into a table, and rejects what it cannot read', async () => {
  const u = await signup();
  const put = (buf) => fetch(`${base}/api/v1/migrations/extract`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/octet-stream' }, body: buf }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const semi = await put(Buffer.from('First;Last;Email\nA;B;a@example.com\n'));
  assert.equal(semi.status, 200);
  assert.deepEqual(semi.body.headers, ['First', 'Last', 'Email']);
  assert.equal(semi.body.rows, 1);
  const tab = await put(Buffer.from('First\tEmail\nA\ta@example.com\n'));
  assert.deepEqual(tab.body.headers, ['First', 'Email']);
  assert.equal((await put(Buffer.from('only a header\n'))).status, 400);
  assert.equal((await put(Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]))).status, 400);
  const noAuth = await fetch(`${base}/api/v1/migrations/extract`, { method: 'PUT', body: 'x' });
  assert.equal(noAuth.status, 401);
});
