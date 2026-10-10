import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tw_${n}_${roles[0]}`, display_name: `Tm ${n}`, email: `tw${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });


const setup = async () => {
  const owner = await signup(['athlete']);
  const org = await signup(['organizer']);
  const team = (await api('POST', '/teams', { token: owner.token, body: { name: 'Hawks', sport: 'cricket', description: 'Sunday side' } })).body;
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'Winter Cup', sport: 'cricket', starts_on: day(5), ends_on: day(6), entry_fee_cents: 0 } })).body;
  const players = [];
  for (let k = 0; k < 3; k++) {
    const p = await signup(['athlete']);
    assert.equal((await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: p.id } })).status, 201);
    players.push(p);
  }
  return { owner, org, team, ev, players };
};

test('master team and sub-teams: same roster or a different one, master untouched', async () => {
  const { owner, team, ev, players } = await setup();
  const [p1, p2, p3] = players;
  const same = await api('POST', `/teams/${team.id}/sub-teams`, { token: owner.token, body: { event_id: ev.id } });
  assert.equal(same.status, 201, JSON.stringify(same.body));
  assert.equal(same.body.kind, 'sub'); assert.equal(same.body.parent_team_id, team.id); assert.equal(same.body.members, 4); // owner + 3
  assert.match(same.body.name, /Hawks · Winter Cup/);

  const diff = await api('POST', `/teams/${team.id}/sub-teams`, { token: owner.token, body: { name: 'Hawks B', member_ids: [p1.id, p2.id] } });
  assert.equal(diff.body.members, 3);
  // players who are not on the master roster are refused
  const outsider = await signup(['athlete']);
  assert.equal((await api('POST', `/teams/${team.id}/sub-teams`, { token: owner.token, body: { member_ids: [outsider.id] } })).status, 400);
  // a player cannot create sub-teams; nor a sub-team of a sub-team
  assert.equal((await api('POST', `/teams/${team.id}/sub-teams`, { token: p1.token, body: {} })).status, 403);
  assert.equal((await api('POST', `/teams/${diff.body.id}/sub-teams`, { token: owner.token, body: {} })).status, 400);

  // change the sub-team roster: p3 in, p1 out; the master roster stays as it was
  const roster = await api('POST', `/teams/${diff.body.id}/sub-roster`, { token: owner.token, body: { user_ids: [p2.id, p3.id] } });
  assert.equal(roster.status, 200, JSON.stringify(roster.body));
  assert.deepEqual(roster.body.map((m) => m.id).sort(), [p2.id, p3.id, owner.id].sort());
  const master = (await api('GET', `/teams/${team.id}`, { token: owner.token })).body;
  assert.equal(master.members.length, 4);
  assert.equal(master.sub_teams.length, 2);
  assert.equal(master.can_manage, true);
  const sub = (await api('GET', `/teams/${diff.body.id}`, { token: owner.token })).body;
  assert.equal(sub.master_team.id, team.id);
  // browse hides sub-teams, "mine" includes them
  const browse = (await api('GET', '/teams?sport=cricket', {})).body;
  assert.ok(browse.every((t) => t.kind === 'master'));
  assert.ok((await api('GET', '/teams?mine=true', { token: owner.token })).body.some((t) => t.id === diff.body.id));
  // a master manager runs the sub-team; a player does not
  assert.equal((await api('PATCH', `/teams/${diff.body.id}`, { token: owner.token, body: { name: 'Hawks B-side' } })).status, 200);
  assert.equal((await api('PATCH', `/teams/${diff.body.id}`, { token: p2.token, body: { name: 'Nope' } })).status, 403);
  // archive keeps the row
  assert.equal((await api('PATCH', `/teams/${diff.body.id}`, { token: owner.token, body: { archived: true } })).status, 200);
  assert.equal((await api('GET', `/teams/${team.id}/sub-teams`, { token: owner.token })).body.length, 1);
  assert.equal((await api('GET', `/teams/${team.id}/sub-teams?include_archived=true`, { token: owner.token })).body.length, 2);
});

test('task board: create, assign, move, subtasks, comments, files, archive', async () => {
  const { owner, team, players } = await setup();
  const [p1, p2] = players;
  const outsider = await signup(['athlete']);
  const t = await api('POST', `/teams/${team.id}/tasks`, { token: owner.token, body: { title: 'Book the nets', tags: ['Logistics'], assignee_ids: [p1.id], subtasks: ['Call venue', 'Pay deposit'], due_on: day(3) } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal(t.body.assignees.length, 1); assert.equal(t.body.subtasks_total, 2); assert.equal(t.body.status, 'new');
  // outsiders cannot see or create; assigning a non-member is refused
  assert.equal((await api('GET', `/teams/${team.id}/tasks`, { token: outsider.token })).status, 403);
  assert.equal((await api('POST', `/teams/${team.id}/tasks`, { token: outsider.token, body: { title: 'sneaky' } })).status, 403);
  assert.equal((await api('POST', `/teams/${team.id}/tasks`, { token: owner.token, body: { title: 'Bad assign', assignee_ids: [outsider.id] } })).status, 400);
  // the assignee is notified, can move it and tick a subtask; another member cannot edit it
  const inbox = (await api('GET', '/notifications', { token: p1.token })).body;
  assert.ok(JSON.stringify(inbox).includes('team_task_assigned'));
  assert.equal((await api('PATCH', `/team-tasks/${t.body.id}`, { token: p2.token, body: { status: 'done' } })).status, 403);
  const moved = await api('PATCH', `/team-tasks/${t.body.id}`, { token: p1.token, body: { status: 'in_progress' } });
  assert.equal(moved.body.status, 'in_progress');
  assert.equal((await api('PATCH', `/team-tasks/${t.body.id}`, { token: p1.token, body: { assignee_ids: [p1.id, p2.id] } })).status, 403); // only managers/creator re-assign
  const full = (await api('GET', `/team-tasks/${t.body.id}`, { token: p1.token })).body;
  const sub = await api('PATCH', `/team-task-subtasks/${full.subtasks[0].id}`, { token: p1.token, body: { done: true } });
  assert.equal(sub.body.done, true);
  assert.equal((await api('POST', `/team-tasks/${t.body.id}/subtasks`, { token: p1.token, body: { title: 'Confirm umpire' } })).status, 201);
  assert.equal((await api('POST', `/team-tasks/${t.body.id}/comments`, { token: p2.token, body: { body: 'On it?' } })).status, 201);
  assert.equal((await api('POST', `/team-tasks/${t.body.id}/files`, { token: p1.token, body: { name: 'quote.pdf', url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await api('POST', `/team-tasks/${t.body.id}/files`, { token: p1.token, body: { name: 'quote.pdf', url: 'https://example.com/quote.pdf', size_bytes: 1200 } })).status, 201);

  const board = (await api('GET', `/teams/${team.id}/tasks`, { token: p2.token })).body;
  assert.equal(board.columns.in_progress.length, 1); assert.equal(board.columns.new.length, 0);
  const card = board.columns.in_progress[0];
  assert.deepEqual([card.subtasks_total, card.subtasks_done, card.comments, card.files], [3, 1, 1, 1]);
  assert.equal(board.workload.find((w) => w.id === p1.id).open_tasks, 1);
  assert.equal((await api('GET', `/teams/${team.id}/tasks?mine=true`, { token: p2.token })).body.columns.in_progress.length, 0);
  assert.equal((await api('GET', `/teams/${team.id}/tasks?mine=true`, { token: p1.token })).body.columns.in_progress.length, 1);

  // archive hides it but keeps the row
  assert.equal((await api('DELETE', `/team-tasks/${t.body.id}`, { token: p2.token })).status, 403);
  assert.equal((await api('DELETE', `/team-tasks/${t.body.id}`, { token: owner.token })).status, 200);
  assert.equal((await api('GET', `/team-tasks/${t.body.id}`, { token: owner.token })).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_tasks WHERE id=$1', [t.body.id])).rows[0].n, 1);
});

test('attendance: request, RSVP, confirm, check-in, and sub-team entries', async () => {
  const { owner, org, team, ev, players } = await setup();
  const [p1, p2, p3] = players;
  const en = (await api('POST', `/events/${ev.id}/entries`, { token: owner.token, body: { team_id: team.id } })).body;
  assert.equal((await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } })).status, 200);

  const req = await api('POST', `/teams/${team.id}/attendance/request`, { token: owner.token, body: { event_id: ev.id } });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal(req.body.asked, 3);
  assert.equal((await api('POST', `/teams/${team.id}/attendance/request`, { token: p1.token, body: { event_id: ev.id } })).status, 403);

  assert.equal((await api('POST', `/teams/${team.id}/attendance`, { token: p1.token, body: { event_id: ev.id, rsvp: 'going' } })).body.rsvp, 'going');
  assert.equal((await api('POST', `/teams/${team.id}/attendance`, { token: p2.token, body: { event_id: ev.id, rsvp: 'no', note: 'Exams' } })).status, 200);
  const outsider = await signup(['athlete']);
  assert.equal((await api('POST', `/teams/${team.id}/attendance`, { token: outsider.token, body: { event_id: ev.id, rsvp: 'going' } })).status, 403);
  assert.equal((await api('POST', `/teams/${team.id}/attendance`, { token: p1.token, body: { rsvp: 'going' } })).status, 400); // needs event or fixture

  // confirm only works for people who said they are coming
  assert.equal((await api('PATCH', `/teams/${team.id}/attendance/${p2.id}`, { token: owner.token, body: { event_id: ev.id } })).status, 409);
  assert.equal((await api('PATCH', `/teams/${team.id}/attendance/${p1.id}`, { token: p1.token, body: { event_id: ev.id } })).status, 403);
  assert.ok((await api('PATCH', `/teams/${team.id}/attendance/${p1.id}`, { token: owner.token, body: { event_id: ev.id } })).body.confirmed_at);
  // check-in works even without an RSVP
  assert.ok((await api('POST', `/teams/${team.id}/attendance/${p3.id}/check-in`, { token: owner.token, body: { event_id: ev.id } })).body.checked_in_at);

  const att = (await api('GET', `/teams/${team.id}/attendance?event_id=${ev.id}`, { token: p1.token })).body;
  assert.deepEqual(att.counts, { going: 1, maybe: 0, no: 1, pending: 2, confirmed: 1, checked_in: 1, total: 4 }); // owner is pending too
  assert.equal(att.people.find((p) => p.id === p2.id).note, undefined); // notes are manager-only
  assert.equal((await api('GET', `/teams/${team.id}/attendance?event_id=${ev.id}`, { token: owner.token })).body.people.find((p) => p.id === p2.id).note, 'Exams');
  // changing the answer drops the earlier confirmation
  await api('POST', `/teams/${team.id}/attendance`, { token: p1.token, body: { event_id: ev.id, rsvp: 'maybe' } });
  assert.equal((await api('GET', `/teams/${team.id}/attendance?event_id=${ev.id}`, { token: owner.token })).body.counts.confirmed, 0);

  // a sub-team created for the event takes RSVPs for it; a team not in the event does not
  const sub = (await api('POST', `/teams/${team.id}/sub-teams`, { token: owner.token, body: { event_id: ev.id, member_ids: [p1.id] } })).body;
  assert.equal((await api('POST', `/teams/${sub.id}/attendance`, { token: p1.token, body: { event_id: ev.id, rsvp: 'going' } })).status, 200);
  const other = (await api('POST', '/teams', { token: org.token, body: { name: 'Other', sport: 'cricket' } })).body;
  assert.equal((await api('POST', `/teams/${other.id}/attendance`, { token: org.token, body: { event_id: ev.id, rsvp: 'going' } })).status, 400);

  const ws = (await api('GET', `/teams/${team.id}/workspace`, { token: p1.token })).body;
  assert.equal(ws.schedule.events[0].my_rsvp, 'maybe');
  assert.equal(ws.sub_teams.length, 1);
  assert.deepEqual(ws.board, { new: 0, in_progress: 0, review: 0, done: 0 });
});
