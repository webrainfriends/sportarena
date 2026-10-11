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
  const r = await api('POST', '/auth/register', { body: { handle: `bd_${n}_${roles[0]}`, display_name: `Bd ${n}`, email: `bd${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const setup = async () => {
  const org = await signup(['organizer']), lead = await signup(['coach']), mem = await signup(['athlete']), outsider = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Board Cup ${++n}`, sport: 'football' } })).body;
  const dept = (await api('POST', `/events/${ev.id}/departments`, { token: org.token, body: { name: `Ops ${n}`, kind: 'operations', lead_user_id: lead.id } })).body;
  const join = async (u, role = 'member') => {
    const inv = role === 'lead' ? (await api('GET', '/me/department-invites', { token: u.token })).body[0]
      : (await api('POST', `/departments/${dept.id}/members`, { token: org.token, body: { user_id: u.id } })).body;
    assert.equal((await api('POST', `/department-members/${inv.id}/respond`, { token: u.token, body: { accept: true } })).status, 200);
  };
  await join(lead, 'lead'); await join(mem);
  const plan = await api('POST', `/departments/${dept.id}/plans`, { token: lead.token, body: { title: 'Match day run', goal: 'Smooth gates' } });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  return { org, lead, mem, outsider, ev, dept, plan: plan.body };
};
const card = async (u, planId, body) => {
  const r = await api('POST', `/plans/${planId}/cards`, { token: u.token, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const board = async (u, planId, qs = '') => (await api('GET', `/plans/${planId}/board${qs}`, { token: u.token })).body;

test('plans: default columns, only organiser/lead create, outsiders see nothing', async () => {
  const { org, mem, outsider, dept, plan } = await setup();
  assert.deepEqual(plan.columns.map((c) => c.key), ['backlog', 'doing', 'blocked', 'review', 'done']);
  assert.equal((await api('POST', `/departments/${dept.id}/plans`, { token: mem.token, body: { title: 'Sneaky plan' } })).status, 403);
  assert.equal((await api('POST', `/departments/${dept.id}/plans`, { token: org.token, body: { title: 'Bad dates', starts_on: '2030-05-02', ends_on: '2030-05-01' } })).status, 400);
  assert.equal((await api('GET', `/plans/${plan.id}/board`, { token: outsider.token })).status, 403);
  assert.equal((await api('POST', `/plans/${plan.id}/cards`, { token: outsider.token, body: { title: 'Nope nope' } })).status, 403);
});

test('cards: create lands in the first column in order; assignees must be team members and get notified', async () => {
  const { lead, mem, outsider, plan } = await setup();
  const a = await card(lead, plan.id, { title: 'Set up gates', assignee_ids: [mem.id], priority: 'high', labels: ['gates'], checklist: [{ text: 'Barriers' }, { text: 'Signage' }] });
  const b = await card(mem, plan.id, { title: 'Brief marshals' });
  assert.equal(a.column_key, 'backlog');
  assert.equal((await api('POST', `/plans/${plan.id}/cards`, { token: lead.token, body: { title: 'Outsider job', assignee_ids: [outsider.id] } })).status, 400);
  assert.equal((await api('POST', `/plans/${plan.id}/cards`, { token: lead.token, body: { title: 'Wrong col', column_key: 'nope' } })).status, 400);
  assert.equal((await api('POST', `/plans/${plan.id}/cards`, { token: lead.token, body: { title: 'Time travel', starts_at: '2030-05-02T10:00:00Z', ends_at: '2030-05-02T09:00:00Z' } })).status, 400);
  const bd = await board(lead, plan.id);
  assert.deepEqual(bd.columns[0].cards.map((x) => x.title), ['Set up gates', 'Brief marshals']);
  assert.deepEqual(bd.columns[0].cards.map((x) => x.position), [0, 1]);
  assert.equal(bd.columns[0].cards[0].checklist_total, 2);
  assert.equal(bd.columns[0].cards[0].assignees[0].id, mem.id);
  const note = (await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='card_assigned'", [mem.id])).rowCount;
  assert.equal(note, 1);
  assert.equal(b.priority, 'normal');
});

test('move: reorders within and across columns, stamps done, blocked needs a reason, history is kept', async () => {
  const { lead, mem, plan } = await setup();
  const [a, b, c3] = [await card(lead, plan.id, { title: 'Card A' }), await card(lead, plan.id, { title: 'Card B' }), await card(lead, plan.id, { title: 'Card C' })];
  let r = await api('POST', `/cards/${c3.id}/move`, { token: mem.token, body: { column_key: 'backlog', position: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await board(lead, plan.id)).columns[0].cards.map((x) => x.title), ['Card C', 'Card A', 'Card B']);
  assert.equal((await api('POST', `/cards/${a.id}/move`, { token: mem.token, body: { column_key: 'blocked' } })).status, 400, 'blocked needs a reason');
  r = await api('POST', `/cards/${a.id}/move`, { token: mem.token, body: { column_key: 'blocked', reason: 'Waiting for barriers' } });
  assert.equal(r.body.blocked_reason, 'Waiting for barriers');
  r = await api('POST', `/cards/${a.id}/move`, { token: mem.token, body: { column_key: 'done' } });
  assert.ok(r.body.done_at);
  assert.equal(r.body.blocked_reason, null);
  assert.equal((await api('POST', `/cards/${a.id}/move`, { token: mem.token, body: { column_key: 'zzz' } })).status, 400);
  const bd = await board(lead, plan.id);
  assert.deepEqual(bd.columns.map((x) => x.cards.length), [2, 0, 0, 0, 1]);
  r = await api('POST', `/cards/${a.id}/move`, { token: mem.token, body: { column_key: 'doing' } });
  assert.equal(r.body.done_at, null, 'reopening clears done');
  const detail = await api('GET', `/cards/${a.id}`, { token: lead.token });
  assert.deepEqual(detail.body.history.map((h) => `${h.action}:${h.from_column ?? ''}>${h.to_column ?? ''}`), ['created:>backlog', 'moved:backlog>blocked', 'moved:blocked>done', 'moved:done>doing']);
  const cm = await api('POST', `/cards/${a.id}/comments`, { token: lead.token, body: { body: 'Barriers arrive at 9' } });
  assert.equal(cm.status, 201);
  assert.equal((await api('GET', `/cards/${a.id}`, { token: mem.token })).body.comments.length, 1);
  assert.ok(b.id);
});

test('columns: cannot drop one that still holds cards; archiving a card keeps it', async () => {
  const { lead, plan } = await setup();
  const a = await card(lead, plan.id, { title: 'Keep me', column_key: 'review' });
  const cols = plan.columns.filter((c) => c.key !== 'review');
  assert.equal((await api('PATCH', `/plans/${plan.id}`, { token: lead.token, body: { columns: cols } })).status, 409);
  const arch = await api('PATCH', `/cards/${a.id}`, { token: lead.token, body: { archived: true } });
  assert.equal(arch.body.status, 'archived');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_cards WHERE id=$1', [a.id])).rows[0].n, 1);
  assert.equal((await board(lead, plan.id)).columns.flatMap((c) => c.cards).length, 0);
  assert.equal((await api('PATCH', `/plans/${plan.id}`, { token: lead.token, body: { columns: cols } })).status, 200, 'now free to drop');
  const done = await api('PATCH', `/plans/${plan.id}`, { token: lead.token, body: { archived: true } });
  assert.equal(done.body.status, 'archived');
  assert.equal((await api('POST', `/plans/${plan.id}/cards`, { token: lead.token, body: { title: 'Late card' } })).status, 409);
});

test('schedules: my schedule spans events; event timeline is time-ordered and scoped', async () => {
  const { org, lead, mem, outsider, ev, dept, plan } = await setup();
  await card(lead, plan.id, { title: 'Later job', assignee_ids: [mem.id], starts_at: '2031-06-02T12:00:00Z', ends_at: '2031-06-02T13:00:00Z' });
  await card(lead, plan.id, { title: 'Early job', assignee_ids: [mem.id], starts_at: '2031-06-01T08:00:00Z' });
  await card(lead, plan.id, { title: 'Not mine', starts_at: '2031-06-01T07:00:00Z' });
  const doneCard = await card(lead, plan.id, { title: 'Finished job', assignee_ids: [mem.id], due_on: '2031-05-30' });
  await api('POST', `/cards/${doneCard.id}/move`, { token: lead.token, body: { column_key: 'done' } });
  const mine = await api('GET', '/me/event-schedule', { token: mem.token });
  assert.deepEqual(mine.body.map((x) => x.title), ['Early job', 'Later job']);
  assert.equal((await api('GET', '/me/event-schedule?include_done=true', { token: mem.token })).body.length, 3);
  assert.equal(mine.body[0].event_id, ev.id);
  const tl = await api('GET', `/events/${ev.id}/timeline`, { token: org.token });
  assert.deepEqual(tl.body.map((x) => x.title), ['Finished job', 'Not mine', 'Early job', 'Later job']);
  assert.equal((await api('GET', `/events/${ev.id}/timeline`, { token: outsider.token })).status, 403);
  const plans = await api('GET', `/events/${ev.id}/plans`, { token: mem.token });
  assert.equal(plans.body[0].counts.backlog, 3);
  assert.equal(plans.body[0].counts.done, 1);
  assert.ok(dept.id);
});
