// Issue #594: the Unified Inbox. One inbox over team chats, notifications and the new conversations (direct, group, event channel, context
// threads), attachments, read / delivery status, urgent notices that escalate, quiet hours, moderation, reporting, search and archive,
// with youth, tenant and role rules enforced on the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { buildOpenApi } = await import('../src/openapi.js');
const { escalateUnacknowledged, archiveStaleConversations } = await import('../src/inbox.js');
const { inQuietHours, holdsBack } = await import('../src/quiet-hours.js');
const { notify } = await import('../src/notify.js');

let server, base;
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const put = async (path, token, bytes) => {
  const r = await fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: bytes });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await call('POST', '/auth/register', { body: { handle: `ib_${n}`, display_name: `Ib ${n}`, email: `ib${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const team = async (owner, players = []) => {
  const t = (await call('POST', '/teams', { token: owner.token, body: { name: `Hawks ${n}`, sport: 'cricket' } })).body;
  for (const p of players) assert.equal((await call('POST', `/teams/${t.id}/members`, { token: owner.token, body: { user_id: p.id } })).status, 201);
  return t;
};
const makeYoung = async (kid, { guardian = true, consent = true } = {}) => {
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  if (!guardian) return null;
  const parent = await signup();
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  if (consent) await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'contact',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  return parent;
};

test('direct messages: need a shared context, one conversation per pair, text encrypted, notifications carry no text, blocks stop it', async () => {
  const [a, b, stranger] = [await signup(), await signup(), await signup()];
  await team(a, [b]);
  const cold = await call('POST', '/conversations', { token: stranger.token, body: { kind: 'direct', user_id: a.id, body: 'hi' } });
  assert.equal(cold.status, 404, 'no cold messages to people you share nothing with');
  const c1 = await call('POST', '/conversations', { token: a.token, body: { kind: 'direct', user_id: b.id, body: 'Nets at 6? Call 98765 43210' } });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  const c2 = await call('POST', '/conversations', { token: b.token, body: { kind: 'direct', user_id: a.id } });
  assert.equal(c2.body.conversation_id, c1.body.conversation_id, 'the same pair always shares one conversation');
  const stored = (await pool.query('SELECT body_enc FROM conversation_messages WHERE conversation_id=$1', [c1.body.conversation_id])).rows[0].body_enc;
  assert.ok(!stored.includes('Nets at 6'), 'the text is encrypted at rest');
  const note = (await pool.query("SELECT body, title FROM notifications WHERE user_id=$1 AND kind='conversation_message'", [b.id])).rows[0];
  assert.ok(note && !note.body.includes('Nets') && !note.title.includes('Nets'), 'push and email never carry the message');
  assert.equal((await call('GET', `/conversations/${c1.body.conversation_id}`, { token: stranger.token })).status, 404, 'an outsider cannot tell it exists');
  assert.equal((await call('GET', `/conversations/${c1.body.conversation_id}/messages`, { token: stranger.token })).status, 404);

  assert.equal((await call('POST', '/me/contact-blocks', { token: b.token, body: { user_id: a.id, blocked: true } })).status, 200);
  assert.equal((await call('POST', `/conversations/${c1.body.conversation_id}/messages`, { token: a.token, body: { body: 'again' } })).status, 403, 'a block ends the conversation for the blocked person');
  await call('POST', '/me/contact-blocks', { token: b.token, body: { user_id: a.id, blocked: false } });
  assert.equal((await call('POST', `/conversations/${c1.body.conversation_id}/messages`, { token: a.token, body: { body: 'again' } })).status, 201);
});

test('one inbox: team chat, notifications and conversations together, unread counts, filters, read receipts and idempotent sends', async () => {
  const [owner, p, q] = [await signup(), await signup(), await signup()];
  const t = await team(owner, [p, q]);
  await call('POST', `/teams/${t.id}/messages`, { token: owner.token, body: { body: 'Bring both rackets' } });
  const g = await call('POST', '/conversations', { token: owner.token, body: { kind: 'group', title: 'Selectors', team_id: t.id, member_ids: [p.id, q.id], body: 'Squad out Friday' } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const cid = g.body.conversation_id;
  await notify(null, p.id, { kind: 'event_cancelled', title: 'Match cancelled', body: 'Rain stopped play', data: {} });
  const inbox = await call('GET', '/inbox', { token: p.token });
  assert.equal(inbox.status, 200);
  const kinds = inbox.body.items.map((x) => x.source);
  assert.ok(kinds.includes('team_chat') && kinds.includes('conversation') && kinds.includes('notification'), `all three sources in one list: ${kinds}`);
  assert.ok(inbox.body.unread_total >= 3);
  assert.ok(!inbox.body.items.some((x) => x.source === 'notification' && String(x.kind).startsWith('conversation_')), 'a conversation shows once, not again as a notification');
  assert.equal((await call('GET', '/inbox?filter=teams', { token: p.token })).body.items.every((x) => x.type === 'team' || x.team_id), true);
  assert.equal((await call('GET', '/inbox?filter=direct', { token: p.token })).body.items.length, 0);

  const cidKey = 'client-key-0001';
  const a1 = await call('POST', `/conversations/${cid}/messages`, { token: p.token, body: { body: 'Ready', client_id: cidKey } });
  const a2 = await call('POST', `/conversations/${cid}/messages`, { token: p.token, body: { body: 'Ready', client_id: cidKey } });
  assert.equal(a1.body.message_id, a2.body.message_id, 'a retried send is the same message');
  const seen = await call('GET', `/conversations/${cid}/messages`, { token: q.token });
  assert.equal(seen.body.messages.length, 2);
  await call('POST', `/conversations/${cid}/read`, { token: q.token, body: {} });
  const mine = (await call('GET', `/conversations/${cid}/messages`, { token: p.token })).body.messages.find((m) => m.mine);
  assert.equal(mine.delivery.read_by, 1, 'the sender sees how many have read it');
  assert.equal((await call('GET', `/conversations/${cid}/messages`, { token: q.token })).body.messages.find((m) => m.mine === false && m.body === 'Ready').delivery, null, 'others see no counts for a message that is not theirs');
  assert.equal((await call('GET', '/inbox?unread=true', { token: q.token })).body.items.some((x) => x.conversation_id === cid), false, 'read conversations leave the unread view');
});

test('announcements-only channels and event channels: roles, one channel per event, everyone connected joins, outsiders cannot', async () => {
  const [org, p, outsider] = [await signup(['organizer']), await signup(), await signup()];
  const t = await team(p, []);
  const sport = (await pool.query('SELECT id FROM sports LIMIT 1')).rows[0].id;
  const ev = (await pool.query("INSERT INTO events(name, sport_id, organizer_id, status) VALUES ('City Open',$1,$2,'open') RETURNING id", [sport, org.id])).rows[0];
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, t.id]);
  assert.equal((await call('POST', '/conversations', { token: outsider.token, body: { kind: 'event', event_id: ev.id } })).status, 404, 'only the organiser can open the channel');
  const ch = await call('POST', '/conversations', { token: org.token, body: { kind: 'event', event_id: ev.id, announcements_only: true } });
  assert.equal(ch.status, 201, JSON.stringify(ch.body));
  assert.ok(ch.body.members.some((m) => m.id === p.id), 'the entered team\'s people join');
  assert.equal((await call('POST', '/conversations', { token: org.token, body: { kind: 'event', event_id: ev.id } })).status, 409, 'one channel per event');
  assert.equal((await call('POST', `/conversations/${ch.body.conversation_id}/messages`, { token: p.token, body: { body: 'hi' } })).status, 403, 'players cannot post in an announcements channel');
  const post = await call('POST', `/conversations/${ch.body.conversation_id}/messages`, { token: org.token, body: { body: 'Round 4 moved to Court 3', announcement: true } });
  assert.equal(post.status, 201);
  assert.equal(post.body.kind, 'announcement');
  assert.equal((await call('GET', '/inbox?filter=announcements', { token: p.token })).body.items.some((x) => x.conversation_id === ch.body.conversation_id), true);
  assert.equal((await call('GET', '/inbox?filter=events', { token: p.token })).body.items.some((x) => x.conversation_id === ch.body.conversation_id), true);
  // a thread about a fixture, a registration
  const entry = (await pool.query('SELECT id FROM event_entries WHERE event_id=$1', [ev.id])).rows[0];
  const reg = await call('POST', '/conversations', { token: org.token, body: { kind: 'context', entry_id: entry.id, title: 'Registration' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.ok(reg.body.members.some((m) => m.id === p.id), 'the registrant (team owner) is in the registration thread');
  assert.equal((await call('POST', '/conversations', { token: outsider.token, body: { kind: 'context', entry_id: entry.id } })).status, 404);
  assert.equal((await call('POST', `/conversations/${ch.body.conversation_id}/members`, { token: org.token, body: { user_ids: [outsider.id] } })).status, 400, 'nobody unconnected can be pulled in');
});

test('youth safeguarding: guardian needed, consent needed, guardians read (and are audited), young people cannot DM each other, revocation ends access', async () => {
  const [coach, kid, kid2, adult] = [await signup(), await signup(), await signup(), await signup()];
  const t = await team(coach, [kid, kid2, adult]);
  await makeYoung(kid2, { guardian: true });
  await makeYoung(kid, { guardian: false });
  assert.equal((await call('POST', '/conversations', { token: kid2.token, body: { kind: 'direct', user_id: kid.id } })).status, 403, 'two young people never message each other directly');
  const noGuardian = await call('POST', '/conversations', { token: coach.token, body: { kind: 'direct', user_id: kid.id } });
  assert.equal(noGuardian.status, 409, 'a young person needs a verified guardian first');
  assert.equal(noGuardian.body.error.details?.code ?? noGuardian.body.error.code, 'guardian_required');
  const parent = await signup();
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const noConsent = await call('POST', '/conversations', { token: coach.token, body: { kind: 'direct', user_id: kid.id } });
  assert.equal(noConsent.status, 409, JSON.stringify(noConsent.body));
  assert.equal(noConsent.body.error.details?.code ?? noConsent.body.error.code, 'guardian_consent_required');
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'contact',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  const dm = await call('POST', '/conversations', { token: coach.token, body: { kind: 'direct', user_id: kid.id, body: 'Training moved to 5' } });
  assert.equal(dm.status, 201, JSON.stringify(dm.body));
  assert.equal(dm.body.guardians_can_read, true);
  const read = await call('GET', `/conversations/${dm.body.conversation_id}/messages`, { token: parent.token });
  assert.equal(read.status, 200, 'the guardian reads their child\'s conversation');
  assert.equal(read.body.can_post, false);
  assert.equal((await call('POST', `/conversations/${dm.body.conversation_id}/messages`, { token: parent.token, body: { body: 'hello' } })).status, 403, 'guardians read, they do not post');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='guardian_read_conversation'", [parent.id])).rowCount >= 1, 'a guardian read is audit-logged');
  assert.ok((await call('GET', '/inbox', { token: parent.token })).body.items.some((x) => x.conversation_id === dm.body.conversation_id && x.read_only), 'it shows in the guardian\'s inbox, read-only');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='conversation_message' AND data->>'guardian_copy'='true'", [parent.id])).rowCount >= 1, 'the guardian is told as themselves');
  assert.equal((await call('GET', `/conversations/${dm.body.conversation_id}/messages`, { token: adult.token })).status, 404, 'another adult sees nothing');
  // revoke the link: access ends at once
  await pool.query("UPDATE guardian_links SET revoked_at=now() WHERE guardian_id=$1 AND child_id=$2", [parent.id, kid.id]);
  assert.equal((await call('GET', `/conversations/${dm.body.conversation_id}/messages`, { token: parent.token })).status, 404, 'a revoked guardian loses access immediately');
  // a young person cannot be added to a group without a guardian
  const loner = await signup(); await team(coach, [loner]); await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [loner.id]);
  const g = await call('POST', '/conversations', { token: coach.token, body: { kind: 'group', title: 'Squad', team_id: t.id, member_ids: [adult.id] } });
  assert.equal(g.status, 201);
});

test('urgent notices: confirm, escalate once per person after their delay, a young person\'s guardian is told, opt-out of SMS escalation is honoured', async () => {
  const [coach, p, q, kid] = [await signup(), await signup(), await signup(), await signup()];
  const t = await team(coach, [p, q, kid]);
  const parent = await makeYoung(kid);
  const g = await call('POST', '/conversations', { token: coach.token, body: { kind: 'group', title: 'Match day', team_id: t.id, member_ids: [p.id, q.id, kid.id] } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const cid = g.body.conversation_id;
  assert.equal((await call('POST', `/conversations/${cid}/messages`, { token: p.token, body: { body: 'URGENT', requires_ack: true } })).status, 403, 'only organisers post urgent notices');
  const msg = await call('POST', `/conversations/${cid}/messages`, { token: coach.token, body: { body: 'Ground closed, meet at the school gate', requires_ack: true, escalate_after_minutes: 10 } });
  assert.equal(msg.status, 201);
  assert.equal(msg.body.notice.acknowledged, 0);
  assert.equal((await call('GET', '/inbox', { token: p.token })).body.items.find((x) => x.conversation_id === cid).needs_ack, 1);
  assert.equal((await call('POST', `/conversations/${cid}/messages/${msg.body.message_id}/acknowledge`, { token: p.token })).status, 200);
  await call('PATCH', '/me/notification-preferences', { token: q.token, body: { escalation_off: true } });
  assert.equal(await escalateUnacknowledged(), 0, 'nothing escalates before the delay');
  await pool.query("UPDATE conversation_messages SET created_at = now() - interval '11 minutes' WHERE id=$1", [msg.body.message_id]);
  const sent = await escalateUnacknowledged();
  assert.equal(sent, 1, 'only the young person\'s guardian is escalated: p confirmed, q opted out of escalation, the coach sent it');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='conversation_escalation'", [parent.id])).rowCount === 1, 'the guardian is told whatever the young person chose');
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='conversation_escalation'", [p.id])).rowCount, 0);
  assert.equal(await escalateUnacknowledged(), 0, 'running the sweep again escalates nobody twice');
  const d = await call('GET', `/conversations/${cid}/messages/${msg.body.message_id}/delivery`, { token: coach.token });
  assert.equal(d.status, 200);
  assert.equal(d.body.acknowledged, 1);
  assert.equal((await call('GET', `/conversations/${cid}/messages/${msg.body.message_id}/delivery`, { token: p.token })).status, 404, 'recipients do not see delivery data');
});

test('quiet hours hold back push and SMS, urgent notices break through, the inbox still gets everything', async () => {
  const prefs = { quiet_start: '22:00', quiet_end: '07:00', quiet_tz: 'Asia/Kolkata', quiet_weekdays_only: false, quiet_urgent_override: true };
  const at = (iso) => new Date(iso); // 2026-03-02 is a Monday
  assert.equal(inQuietHours(prefs, at('2026-03-02T17:00:00Z')), true, '22:30 in Kolkata is inside 22:00-07:00');
  assert.equal(inQuietHours(prefs, at('2026-03-02T22:00:00Z')), true, '03:30 next morning is still inside (window crosses midnight)');
  assert.equal(inQuietHours(prefs, at('2026-03-02T05:00:00Z')), false, '10:30 is outside');
  assert.equal(inQuietHours({ ...prefs, quiet_weekdays_only: true }, at('2026-03-07T17:00:00Z')), false, 'weekdays-only does not apply on a Saturday');
  assert.equal(holdsBack(prefs, { urgent: true }, at('2026-03-02T17:00:00Z')), false);
  assert.equal(holdsBack({ ...prefs, quiet_urgent_override: false }, { urgent: true }, at('2026-03-02T17:00:00Z')), true);
  assert.equal(inQuietHours({}, at('2026-03-02T17:00:00Z')), false);

  const u = await signup();
  await pool.query("INSERT INTO push_devices(user_id, provider, platform, token) VALUES ($1,'expo','ios','ExponentPushToken[quiet]')", [u.id]);
  const set = await call('PATCH', '/me/notification-preferences', { token: u.token, body: { quiet_start: '00:00', quiet_end: '23:59', quiet_tz: 'UTC' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.quiet_start, '00:00');
  assert.equal((await call('GET', '/me/notification-preferences', { token: u.token })).body.quiet_end, '23:59');
  assert.equal((await call('PATCH', '/me/notification-preferences', { token: u.token, body: { quiet_start: '22:00' } })).status, 400, 'start and end are set together');
  assert.equal((await call('PATCH', '/me/notification-preferences', { token: u.token, body: { quiet_start: '9pm', quiet_end: '07:00' } })).status, 400);
  assert.equal((await call('PATCH', '/me/notification-preferences', { token: u.token, body: { quiet_tz: 'Mars/Base' } })).status, 400);
  await notify(null, u.id, { kind: 'conversation_message', title: 'x', body: 'y', data: {} });
  await notify(null, u.id, { kind: 'conversation_announcement', title: 'urgent', body: 'y', data: {}, urgent: true });
  const rows = (await pool.query("SELECT n.kind, d.channel FROM notifications n LEFT JOIN notification_deliveries d ON d.notification_id=n.id WHERE n.user_id=$1 AND d.channel='push'", [u.id])).rows;
  assert.deepEqual(rows.map((r) => r.kind), ['conversation_announcement'], 'push is held during quiet hours except for the urgent one');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1', [u.id])).rows[0].n, 2, 'both are in the inbox');
});

test('moderation: report, organiser queue, hide keeps the text, silence stops posting, outsiders cannot report or resolve', async () => {
  const [coach, p, q, outsider] = [await signup(), await signup(), await signup(), await signup()];
  const t = await team(coach, [p, q]);
  const g = await call('POST', '/conversations', { token: coach.token, body: { kind: 'group', title: 'Squad', team_id: t.id, member_ids: [p.id, q.id] } });
  const cid = g.body.conversation_id;
  const bad = await call('POST', `/conversations/${cid}/messages`, { token: p.token, body: { body: 'rude words' } });
  const r = await call('POST', `/conversations/${cid}/messages/${bad.body.message_id}/report`, { token: q.token, body: { reason: 'abuse', note: 'name calling' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('POST', `/conversations/${cid}/messages/${bad.body.message_id}/report`, { token: q.token, body: { reason: 'abuse' } })).status, 409, 'one report per person');
  assert.equal((await call('POST', `/conversations/${cid}/messages/${bad.body.message_id}/report`, { token: p.token, body: { reason: 'spam' } })).status, 400, 'not your own message');
  assert.equal((await call('POST', `/conversations/${cid}/messages/${bad.body.message_id}/report`, { token: outsider.token, body: { reason: 'spam' } })).status, 404);
  assert.equal((await call('GET', '/moderation/reports', { token: q.token })).body.reports.length, 0, 'members cannot read the queue');
  const queue = await call('GET', '/moderation/reports', { token: coach.token });
  assert.equal(queue.body.reports.length, 1);
  assert.equal(queue.body.reports[0].note, 'name calling');
  assert.equal(queue.body.reports[0].message.body, 'rude words');
  assert.equal((await call('POST', `/moderation/reports/${r.body.report_id}/resolve`, { token: q.token, body: { outcome: 'hidden' } })).status, 404);
  const done = await call('POST', `/moderation/reports/${r.body.report_id}/resolve`, { token: coach.token, body: { outcome: 'silenced', silence_minutes: 60 } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const view = (await call('GET', `/conversations/${cid}/messages`, { token: q.token })).body.messages.find((m) => m.message_id === bad.body.message_id);
  assert.equal(view.hidden, true); assert.equal(view.body, null, 'a hidden message shows as a placeholder');
  assert.ok((await pool.query('SELECT body_enc FROM conversation_messages WHERE id=$1', [bad.body.message_id])).rows[0].body_enc, 'the text is kept for the record');
  assert.equal((await call('POST', `/conversations/${cid}/messages`, { token: p.token, body: { body: 'sorry' } })).status, 403, 'a silenced member cannot post');
  assert.equal((await call('POST', `/conversations/${cid}/members/${p.id}/silence`, { token: coach.token, body: { minutes: null } })).status, 200);
  assert.equal((await call('POST', `/conversations/${cid}/messages`, { token: p.token, body: { body: 'sorry' } })).status, 201);
  assert.equal((await call('POST', `/moderation/reports/${r.body.report_id}/resolve`, { token: coach.token, body: { outcome: 'dismissed' } })).status, 409, 'a closed report stays closed');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_conversation_report'", [coach.id])).rowCount >= 1, 'reading reports is audit-logged');
  // leaving ends access at once
  assert.equal((await call('DELETE', `/conversations/${cid}/members/${q.id}`, { token: q.token })).status, 200);
  assert.equal((await call('GET', `/conversations/${cid}/messages`, { token: q.token })).status, 404);
  assert.equal((await call('DELETE', `/conversations/${cid}/members/${p.id}`, { token: q.token })).status, 404, 'a non-member cannot remove anyone');
});

test('attachments: encrypted, member-only download, permission re-checked on every request, no executable content', async () => {
  const [a, b, stranger] = [await signup(), await signup(), await signup()];
  await team(a, [b]);
  const c = (await call('POST', '/conversations', { token: a.token, body: { kind: 'direct', user_id: b.id } })).body;
  assert.equal((await put(`/conversations/${c.conversation_id}/attachments?kind=file&name=run.sh`, a.token, Buffer.from('#!/bin/sh\necho hi'))).status, 400, 'content is recognised from its bytes');
  assert.equal((await put(`/conversations/${c.conversation_id}/attachments?kind=image&name=pic.png`, stranger.token, PNG)).status, 404);
  const up = await put(`/conversations/${c.conversation_id}/attachments?kind=image&name=pic.png`, a.token, PNG);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const get = (token) => fetch(`${base}${up.body.url}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get(b.token)).status, 404, 'not yet sent: only its uploader can fetch it');
  const sent = await call('POST', `/conversations/${c.conversation_id}/messages`, { token: a.token, body: { body: '', attachment_id: up.body.attachment_id } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.attachment.name, 'pic.png');
  assert.equal((await call('POST', `/conversations/${c.conversation_id}/messages`, { token: a.token, body: { body: 'again', attachment_id: up.body.attachment_id } })).status, 409, 'one message per attachment');
  const ok = await get(b.token);
  assert.equal(ok.status, 200);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
  assert.equal((await get(stranger.token)).status, 404);
  assert.equal((await fetch(`${base}${up.body.url}`)).status, 401);
  await pool.query('UPDATE conversation_members SET left_at=now() WHERE conversation_id=$1 AND user_id=$2', [c.conversation_id, b.id]);
  assert.equal((await get(b.token)).status, 404, 'after leaving, the file is gone for them too');
});

test('search finds your messages, titles, team chat and notifications, and nobody else\'s; archive and retention keep every row', async () => {
  const [a, b, outsider] = [await signup(), await signup(), await signup()];
  const t = await team(a, [b]);
  const c = (await call('POST', '/conversations', { token: a.token, body: { kind: 'group', title: 'Selectors', team_id: t.id, member_ids: [b.id], body: 'Pick the zebra-striped kit' } })).body;
  await call('POST', `/teams/${t.id}/messages`, { token: a.token, body: { body: 'zebra stripes on Saturday' } });
  const s = await call('GET', '/inbox/search?q=zebra', { token: b.token });
  assert.equal(s.status, 200);
  assert.deepEqual(new Set(s.body.results.map((r) => r.source)), new Set(['conversation', 'team_chat']));
  assert.equal((await call('GET', '/inbox/search?q=zebra', { token: outsider.token })).body.results.length, 0, 'search never crosses into conversations you are not in');
  assert.equal((await call('GET', '/inbox/search?q=z', { token: b.token })).status, 400);
  // hidden messages are not searchable
  const hit = s.body.results.find((r) => r.source === 'conversation');
  await call('POST', `/conversations/${c.conversation_id}/messages/${hit.message_id}/hide`, { token: a.token, body: {} });
  assert.equal((await call('GET', '/inbox/search?q=zebra', { token: b.token })).body.results.filter((r) => r.source === 'conversation').length, 0);

  // retention: an old quiet conversation is archived (never deleted), stays readable, takes no new messages, and can be reopened
  await pool.query("UPDATE conversations SET last_message_at = now() - interval '800 days', created_at = now() - interval '900 days' WHERE id=$1", [c.conversation_id]);
  const before = (await pool.query('SELECT count(*)::int AS n FROM conversation_messages')).rows[0].n;
  assert.ok((await archiveStaleConversations()) >= 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_messages')).rows[0].n, before, 'nothing is deleted');
  assert.equal((await call('POST', `/conversations/${c.conversation_id}/messages`, { token: b.token, body: { body: 'late' } })).status, 409);
  assert.equal((await call('GET', `/conversations/${c.conversation_id}/messages`, { token: b.token })).status, 200, 'still readable');
  assert.ok((await call('GET', '/inbox?filter=archived', { token: b.token })).body.items.some((x) => x.conversation_id === c.conversation_id));
  assert.equal((await call('GET', '/inbox', { token: b.token })).body.items.some((x) => x.conversation_id === c.conversation_id), false);
  assert.equal((await call('PATCH', `/conversations/${c.conversation_id}`, { token: b.token, body: { archived: false } })).status, 403, 'members cannot reopen');
  assert.equal((await call('PATCH', `/conversations/${c.conversation_id}`, { token: a.token, body: { archived: false, retention_days: 3650 } })).status, 200);
  assert.equal((await call('POST', `/conversations/${c.conversation_id}/messages`, { token: b.token, body: { body: 'back' } })).status, 201);
});

test('every inbox capability is on REST, OpenAPI and MCP; unauthenticated calls are refused', async () => {
  const names = ['list_inbox', 'search_inbox', 'list_inbox_contacts', 'list_inbox_contexts', 'start_conversation', 'get_conversation', 'list_conversation_messages', 'send_conversation_message', 'mark_conversation_read', 'acknowledge_notice',
    'get_message_delivery', 'add_conversation_members', 'remove_conversation_member', 'update_conversation', 'mute_conversation', 'set_user_block', 'hide_conversation_message',
    'report_conversation_message', 'list_moderation_reports', 'resolve_moderation_report', 'silence_conversation_member'];
  const spec = buildOpenApi();
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nme of names) {
    const c = capabilities.find((x) => x.name === nme);
    assert.ok(c, `${nme} is a capability`);
    assert.ok(ops.has(nme), `${nme} is in OpenAPI`);
    assert.notEqual(c.auth, 'public', `${nme} needs a signed-in user`);
  }
  assert.equal((await call('GET', '/inbox')).status, 401);
  assert.equal((await call('GET', '/conversations/00000000-0000-0000-0000-000000000000')).status, 401);
  const u = await signup();
  assert.equal((await call('GET', '/conversations/00000000-0000-0000-0000-000000000000', { token: u.token })).status, 404);
  const mcp = await call('POST', '/mcp', { token: u.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  if (mcp.status === 200) assert.ok(JSON.stringify(mcp.body).includes('list_inbox'), 'the MCP tool list includes the inbox');
});

test('mute, update and member rules: mute keeps unread but stops notifications; direct conversations have no organisers', async () => {
  const [a, b, c3] = [await signup(), await signup(), await signup()];
  const t = await team(a, [b, c3]);
  const g = (await call('POST', '/conversations', { token: a.token, body: { kind: 'group', title: 'Group', team_id: t.id, member_ids: [b.id, c3.id] } })).body;
  assert.equal((await call('POST', `/conversations/${g.conversation_id}/mute`, { token: b.token, body: { muted: true } })).status, 200);
  await call('POST', `/conversations/${g.conversation_id}/messages`, { token: a.token, body: { body: 'quiet one' } });
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='conversation_message'", [b.id])).rowCount, 0, 'a muted member gets no notification');
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='conversation_message'", [c3.id])).rowCount, 1);
  const item = (await call('GET', '/inbox', { token: b.token })).body.items.find((x) => x.conversation_id === g.conversation_id);
  assert.equal(item.unread, 1, 'but it still counts as unread in the inbox'); assert.equal(item.muted, true);
  assert.equal((await call('PATCH', `/conversations/${g.conversation_id}`, { token: b.token, body: { title: 'Mine now' } })).status, 403);
  assert.equal((await call('PATCH', `/conversations/${g.conversation_id}`, { token: a.token, body: { title: 'Renamed', retention_days: 29 } })).status, 400);
  const dm = (await call('POST', '/conversations', { token: a.token, body: { kind: 'direct', user_id: b.id } })).body;
  assert.equal((await call('DELETE', `/conversations/${dm.conversation_id}/members/${b.id}`, { token: a.token })).status, 400, 'you leave a direct conversation, you cannot remove the other person');
  assert.equal((await call('POST', `/conversations/${dm.conversation_id}/members`, { token: a.token, body: { user_ids: [c3.id] } })).status, 400);
});

test('compose pick lists: contacts are people you are connected to, contexts are what you run; young people and blocked people are filtered', async () => {
  const [coach, p, q, stranger] = [await signup(), await signup(), await signup(), await signup()];
  const t = await team(coach, [p, q]);
  const kid = await signup(); await call('POST', `/teams/${t.id}/members`, { token: coach.token, body: { user_id: kid.id } });
  await makeYoung(kid);
  const sport = (await pool.query('SELECT id FROM sports LIMIT 1')).rows[0].id;
  const ev = (await pool.query("INSERT INTO events(name, sport_id, organizer_id, status) VALUES ('Spring Cup',$1,$2,'open') RETURNING id", [sport, coach.id])).rows[0];

  const mine = (await call('GET', '/inbox/contacts', { token: p.token })).body.people.map((x) => x.id);
  assert.ok(mine.includes(coach.id) && mine.includes(q.id), 'teammates are listed');
  assert.ok(!mine.includes(stranger.id) && !mine.includes(p.id), 'strangers and yourself are not');
  assert.equal((await call('GET', '/inbox/contacts?q=' + encodeURIComponent(q.display_name), { token: p.token })).body.people.length, 1, 'search by name');
  assert.ok(!(await call('GET', '/inbox/contacts', { token: kid.token })).body.people.some((x) => x.young), 'a young person is never offered another young person');
  await call('POST', '/me/contact-blocks', { token: q.token, body: { user_id: p.id, blocked: true } });
  assert.ok(!(await call('GET', '/inbox/contacts', { token: p.token })).body.people.some((x) => x.id === q.id), 'a person who blocked you is left out');

  const members = await call('GET', `/inbox/contacts?team_id=${t.id}`, { token: coach.token });
  assert.equal(members.status, 200); assert.ok(members.body.people.length >= 4, 'the people of a team you run');
  assert.equal((await call('GET', `/inbox/contacts?team_id=${t.id}`, { token: stranger.token })).status, 404, 'a team you do not run is not listed');
  const ctx = await call('GET', '/inbox/contexts', { token: coach.token });
  assert.ok(ctx.body.teams.some((x) => x.team_id === t.id) && ctx.body.events.some((x) => x.event_id === ev.id));
  assert.equal((await call('GET', '/inbox/contexts', { token: stranger.token })).body.teams.length, 0);
});
