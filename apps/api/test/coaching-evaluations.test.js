import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ev_${n}_${roles[0]}`, display_name: `Ev ${n}`, email: `ev${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (d, hour) => fromLocal(addDays(new Date().toISOString().slice(0, 10), d), hour * 60, 'Asia/Kolkata').toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const card = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Group clinic', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 0, per_person: true, min_participants: 1, max_participants: 10 } }), 201);
  const k = ok(await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: at(3, 17), online_url: 'https://meet.example.com/x', max_participants: 6 } }), 201);
  const a = await signup();
  ok(await api('POST', `/coach/classes/${k.id}/join`, { token: a.token, body: {} }), 201);
  const sheet = ok(await api('POST', '/coaching/rubrics', { token: coach.token, body: { name: 'Midfield profile', sport: 'football', dimensions: [
    { key: 'first_touch', name: 'First touch', pillar: 'technical', weight: 2, scale_min: 1, scale_max: 5, target: 5, anchors: { 1: 'Loses the ball on receipt', 5: 'Controls and plays in one movement under pressure' }, evidence_hint: 'Count touches under pressure' },
    { key: 'scanning', name: 'Scanning', pillar: 'tactical', weight: 1, scale_min: 1, scale_max: 5 },
    { key: 'sprint', name: '30 m sprint', pillar: 'physical', weight: 1, scale_min: 3, scale_max: 6, direction: 'lower_is_better', unit: 's' },
    { key: 'composure', name: 'Composure', pillar: 'mental', weight: 0, scale_min: 1, scale_max: 5 }] } }), 201);
  return { coach, k, a, sheet: { id: sheet.rubric_id ?? sheet.id } };
}
const rev = async (s, evId) => ok(await api('GET', `/coaching/evaluations/${evId}`, { token: s.coach.token }));

test('an evaluation sheet carries pillars, weights, anchors and targets; a class evaluation starts from the scores already given', async () => {
  const s = await setup();
  const listed = ok(await api('GET', '/coaching/rubrics', { token: s.coach.token })).find((r) => r.id === s.sheet.id);
  assert.equal(listed.dimensions[0].pillar, 'technical'); assert.equal(listed.dimensions[0].anchors['1'], 'Loses the ball on receipt'); assert.equal(listed.dimensions[0].target, 5);
  ok(await api('POST', `/coach/classes/${s.k.id}/scores`, { token: s.coach.token, body: { rubric_id: s.sheet.id, scores: [{ athlete_id: s.a.id, dimension_key: 'first_touch', score: 3 }] } }));
  const ev = ok(await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id, context_type: 'class', class_id: s.k.id } }), 201);
  assert.equal(ev.status, 'draft'); assert.equal(ev.criteria.find((c) => c.key === 'first_touch').score, 3, 'the class score is carried in');
  const stranger = await signup(['coach']);
  assert.equal((await api('POST', '/coaching/evaluations', { token: stranger.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id } })).status, 403, 'no coaching relationship');
});

test('scores are checked on their own scale; the weighted pillar and overall figures are computed; edits are versioned', async () => {
  const s = await setup();
  const ev = ok(await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id } }), 201);
  const patch = (body, row = ev.row_version) => api('PATCH', `/coaching/evaluations/${ev.id}`, { token: s.coach.token, body: { row_version: row, ...body } });
  assert.equal((await patch({ scores: { first_touch: { score: 9 } } })).status, 400, 'outside the scale');
  assert.equal((await patch({ scores: { nope: { score: 3 } } })).status, 400, 'unknown criterion');
  const v = ok(await patch({ scores: { first_touch: { score: 4, comment: 'Quick feet, scans early', evidence: [{ type: 'clip', url: 'https://clips.example.com/a', at: '12:40', text: 'Turn under pressure' }] }, scanning: { score: 3 }, sprint: { score: 4.5 }, composure: { score: 5 } }, narrative: { strengths: 'Receives on the half-turn', private: 'Watch the left ankle load' } }));
  // first_touch 4 -> 75 (weight 2), scanning 3 -> 50, sprint 4.5 on 3..6 lower-is-better -> 50; composure weight 0 is shown but not counted: (75*2+50+50)/4 = 62.5
  assert.equal(v.summary.overall, 62.5); assert.equal(v.summary.pillars.technical.score, 75); assert.equal(v.summary.pillars.physical.score, 50); assert.equal(v.summary.coverage.scored, 4);
  assert.equal(v.criteria.find((c) => c.key === 'first_touch').to_target, 1, 'distance to the target is shown');
  assert.equal((await patch({ title: 'stale' }, ev.row_version)).status, 409, 'a stale edit is refused');
  assert.equal((await patch({ scores: { composure: { score: null } } }, v.row_version)).status, 200, 'a score can be cleared');
});

test('a self-assessment first, then a frozen shared version: the athlete never sees the private note, and later edits do not rewrite what they saw', async () => {
  const s = await setup();
  const ev = ok(await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id, request_self_assessment: true } }), 201);
  assert.equal(ok(await api('GET', '/me/coaching-evaluations', { token: s.a.token }))[0].waiting_on_you, 'self_assessment');
  const pre = ok(await api('GET', `/me/coaching-evaluations/${ev.id}`, { token: s.a.token }));
  assert.equal(pre.stage, 'self_assessment'); assert.ok(pre.criteria.every((c) => c.score === null), 'before sharing the athlete sees the sheet only');
  assert.equal((await api('POST', `/me/coaching-evaluations/${ev.id}/self`, { token: s.a.token, body: { scores: { first_touch: { score: 9 } } } })).status, 400);
  ok(await api('POST', `/me/coaching-evaluations/${ev.id}/self`, { token: s.a.token, body: { scores: { first_touch: { score: 5, comment: 'I feel confident' }, scanning: { score: 4 } } } }));
  ok(await api('PATCH', `/coaching/evaluations/${ev.id}`, { token: s.coach.token, body: { row_version: (await rev(s, ev.id)).row_version, scores: { first_touch: { score: 3, comment: 'Good, but loses it under pressure' }, scanning: { score: 4 } }, narrative: { development: 'Receive on the back foot', private: 'Considering a trial' } } }));
  const mine = await rev(s, ev.id);
  assert.equal(mine.criteria.find((c) => c.key === 'first_touch').gap, 2, 'the gap between the athlete and the coach is shown');
  assert.equal((await api('POST', `/coaching/evaluations/${ev.id}/share`, { token: s.coach.token, body: {} })).status, 200);
  const seen = ok(await api('GET', `/me/coaching-evaluations/${ev.id}`, { token: s.a.token }));
  assert.equal(seen.stage, 'shared'); assert.equal(seen.narrative.development, 'Receive on the back foot'); assert.equal(seen.narrative.private, undefined, 'the private note never reaches the athlete');
  assert.equal(seen.criteria.find((c) => c.key === 'first_touch').self, 5);
  // the coach edits afterwards: the athlete still sees what was shared until the next share
  const cur = await rev(s, ev.id);
  ok(await api('PATCH', `/coaching/evaluations/${ev.id}`, { token: s.coach.token, body: { row_version: cur.row_version, scores: { first_touch: { score: 5 } } } }));
  assert.equal((await rev(s, ev.id)).unshared_changes, true);
  assert.equal(ok(await api('GET', `/me/coaching-evaluations/${ev.id}`, { token: s.a.token })).criteria.find((c) => c.key === 'first_touch').score, 3, 'the frozen version is unchanged');
  assert.equal(ok(await api('POST', `/coaching/evaluations/${ev.id}/share`, { token: s.coach.token, body: {} })).version, 2);
  assert.equal(ok(await api('GET', `/me/coaching-evaluations/${ev.id}`, { token: s.a.token })).criteria.find((c) => c.key === 'first_touch').score, 5);
  assert.rejects(pool.query("UPDATE coaching_evaluation_versions SET snapshot='{}' WHERE evaluation_id=$1", [ev.id]), /append-only/, 'a shared version cannot be rewritten');
});

test('the athlete responds, asks, talks it through and acknowledges; the coach closes it; only the two of them can see it; it exports to PDF', async () => {
  const s = await setup();
  const outsider = await signup();
  const ev = ok(await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id } }), 201);
  assert.equal((await api('POST', `/coaching/evaluations/${ev.id}/share`, { token: s.coach.token, body: {} })).status, 400, 'nothing scored yet');
  ok(await api('PATCH', `/coaching/evaluations/${ev.id}`, { token: s.coach.token, body: { row_version: ev.row_version, scores: { first_touch: { score: 4 }, scanning: { score: 2, comment: 'Head down on the ball' } }, narrative: { strengths: 'Work rate', next_steps: 'Scan twice before receiving' } } }));
  ok(await api('POST', `/coaching/evaluations/${ev.id}/share`, { token: s.coach.token, body: { note: 'Let us talk Friday' } }));
  assert.equal((await api('GET', `/me/coaching-evaluations/${ev.id}`, { token: outsider.token })).status, 404);
  assert.equal((await api('POST', `/me/coaching-evaluations/${ev.id}/respond`, { token: outsider.token, body: { comment: 'hi' } })).status, 404);
  assert.equal((await api('POST', `/me/coaching-evaluations/${ev.id}/respond`, { token: s.a.token, body: { reactions: { scanning: 'maybe' } } })).status, 400);
  ok(await api('POST', `/me/coaching-evaluations/${ev.id}/respond`, { token: s.a.token, body: { reactions: { first_touch: 'agree', scanning: 'disagree' }, comment: 'I think scanning is better than a 2', questions: 'Can you show me the clip?' } }));
  assert.equal((await rev(s, ev.id)).status, 'responded');
  assert.equal((await rev(s, ev.id)).criteria.find((c) => c.key === 'scanning').reaction, 'disagree');
  ok(await api('POST', `/coaching/evaluations/${ev.id}/messages`, { token: s.coach.token, body: { body: 'Yes, Friday at the pitch', criterion_key: 'scanning' } }), 201);
  assert.equal((await api('POST', `/coaching/evaluations/${ev.id}/messages`, { token: outsider.token, body: { body: 'x' } })).status, 404);
  ok(await api('POST', `/me/coaching-evaluations/${ev.id}/acknowledge`, { token: s.a.token }));
  const seen = ok(await api('GET', `/me/coaching-evaluations/${ev.id}`, { token: s.a.token }));
  assert.ok(seen.thread.length >= 3); assert.ok(seen.acknowledged_at);
  const pdf = ok(await api('GET', `/coaching/evaluations/${ev.id}/export`, { token: s.coach.token }));
  assert.equal(Buffer.from(pdf.content, 'base64').subarray(0, 5).toString(), '%PDF-');
  const mine = ok(await api('GET', `/coaching/evaluations/${ev.id}/export`, { token: s.a.token }));
  assert.equal(Buffer.from(mine.content, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api('GET', `/coaching/evaluations/${ev.id}/export`, { token: outsider.token })).status, 404);
  ok(await api('POST', `/coaching/evaluations/${ev.id}/close`, { token: s.coach.token }));
  assert.equal((await api('PATCH', `/coaching/evaluations/${ev.id}`, { token: s.coach.token, body: { row_version: (await rev(s, ev.id)).row_version, title: 'Changed title' } })).status, 409, 'closed is read-only');
  assert.equal((await api('POST', `/me/coaching-evaluations/${ev.id}/respond`, { token: s.a.token, body: { comment: 'late' } })).status, 409);
  assert.equal(ok(await api('GET', '/coaching/evaluations', { token: s.coach.token, query: { status: 'closed' } })).length, 1);
});

test('the trend follows shared evaluations over time; a young person\'s evaluation needs a guardian\'s consent to be shared and read', async () => {
  const s = await setup();
  const mk = async (ft, sc) => {
    const ev = ok(await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id } }), 201);
    ok(await api('PATCH', `/coaching/evaluations/${ev.id}`, { token: s.coach.token, body: { row_version: ev.row_version, scores: { first_touch: { score: ft }, scanning: { score: sc } } } }));
    ok(await api('POST', `/coaching/evaluations/${ev.id}/share`, { token: s.coach.token, body: {} }));
    await new Promise((r) => setTimeout(r, 15));
    return ev.id;
  };
  await mk(2, 2); const second = await mk(4, 3);
  const trend = ok(await api('GET', '/coaching/evaluation-trend', { token: s.coach.token, query: { rubric_id: s.sheet.id, athlete_id: s.a.id } }));
  assert.equal(trend.points.length, 2); assert.ok(trend.points[1].overall > trend.points[0].overall);
  assert.equal(ok(await api('GET', '/coaching/evaluation-trend', { token: s.a.token, query: { rubric_id: s.sheet.id } })).points.length, 2, 'the athlete sees their own trend');
  assert.ok((await rev(s, second)).summary.change > 0, 'the change since the previous evaluation is computed');
  // the athlete becomes a young person with no guardian consent: nothing is shown, nothing is deleted
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [s.a.id]);
  assert.deepEqual(ok(await api('GET', '/me/coaching-evaluations', { token: s.a.token })), []);
  assert.equal((await api('GET', `/me/coaching-evaluations/${second}`, { token: s.a.token })).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_evaluations WHERE athlete_id=$1', [s.a.id])).rows[0].n, 2, 'withdrawing consent hides, never deletes');
});

test('export lets the coach choose what goes in and which copy; sending to the athlete puts the shared PDF in their inbox with the usual safeguards', async () => {
  const s = await setup();
  const outsider = await signup();
  const ev = ok(await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id } }), 201);
  assert.equal((await api('POST', `/coaching/evaluations/${ev.id}/send`, { token: s.coach.token, body: {} })).status, 409, 'an unshared evaluation cannot be sent');
  assert.equal((await api('GET', `/coaching/evaluations/${ev.id}/export`, { token: s.coach.token, query: { copy: 'shared' } })).status, 409, 'the shared copy needs a share');
  ok(await api('PATCH', `/coaching/evaluations/${ev.id}`, { token: s.coach.token, body: { row_version: ev.row_version, scores: { first_touch: { score: 4, comment: 'Quick feet, scans early' }, scanning: { score: 3 } }, narrative: { strengths: 'Work rate', private: 'Trial candidate' } } }));
  const pdfOf = async (q, token = s.coach.token) => { const r = ok(await api('GET', `/coaching/evaluations/${ev.id}/export`, { token, query: q })); return Buffer.from(r.content, 'base64'); };
  const slim = await pdfOf({ copy: 'working', sections: 'summary,scores' }), full = await pdfOf({ copy: 'working' });
  assert.equal(slim.subarray(0, 5).toString(), '%PDF-'); assert.ok(slim.length < full.length, 'leaving sections out makes a smaller document');
  assert.equal((await api('GET', `/coaching/evaluations/${ev.id}/export`, { token: s.coach.token, query: { sections: 'nonsense' } })).status, 400);
  ok(await api('POST', `/coaching/evaluations/${ev.id}/share`, { token: s.coach.token, body: {} }));
  const shared = await pdfOf({ copy: 'shared' });
  assert.equal(shared.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api('GET', `/coaching/evaluations/${ev.id}/export`, { token: outsider.token, query: { copy: 'working' } })).status, 404, 'an outsider gets nothing');
  const sent = ok(await api('POST', `/coaching/evaluations/${ev.id}/send`, { token: s.coach.token, body: { note: 'Here is your evaluation, let us talk Friday.' } }));
  assert.ok(sent.conversation_id && sent.attachment_id);
  const inbox = ok(await api('GET', `/conversations/${sent.conversation_id}/messages`, { token: s.a.token }));
  const msg = (inbox.messages ?? inbox).find((m) => m.attachment);
  assert.ok(msg, 'the athlete sees the message with the PDF attached'); assert.match(msg.attachment.name, /\.pdf$/); assert.equal(msg.attachment.content_type, 'application/pdf');
  assert.equal((await api('POST', `/coaching/evaluations/${ev.id}/send`, { token: outsider.token, body: {} })).status, 403, 'only a coach can send');
  const otherCoach = await signup(['coach']);
  assert.equal((await api('POST', `/coaching/evaluations/${ev.id}/send`, { token: otherCoach.token, body: {} })).status, 404, 'only the evaluating coach');
  assert.equal(ok(await api('POST', `/coaching/evaluations/${ev.id}/send`, { token: s.coach.token, body: {} })).conversation_id, sent.conversation_id, 'the same conversation is reused');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='send_coaching_evaluation_message' AND entity_id=$1", [ev.id])).rowCount);
});

test('an evaluation sheet fits every sport in the catalogue: own pillars, judged and timed numbers, nothing tied to one sport', async () => {
  const s = await setup();
  const sports = ok(await api('GET', '/sports'));
  assert.ok(sports.length > 20, 'the catalogue is the real one');
  for (const sp of sports) {
    const sheet = ok(await api('POST', '/coaching/rubrics', { token: s.coach.token, body: { name: `Profile ${sp.slug}`, sport: sp.slug, dimensions: [
      { key: 'execution', name: 'Execution', pillar: 'judging', pillar_label: 'Judging', weight: 2, scale_min: 0, scale_max: 10, step: 0.5, input: 'number', target: 9 },
      { key: 'split_time', name: 'Split time', pillar: 'performance_data', pillar_label: 'Performance data', weight: 1, scale_min: 10, scale_max: 60, step: 0.1, input: 'number', unit: 's', direction: 'lower_is_better', target: 25 },
      { key: 'reads_the_game', name: 'Reads the game', pillar: 'tactical', weight: 1, scale_min: 1, scale_max: 5 }] } }), 201);
    const rid = sheet.rubric_id ?? sheet.id;
    const ev = ok(await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: s.a.id, rubric_id: rid, title: `Review ${sp.slug}` } }), 201);
    const patch = (scores) => api('PATCH', `/coaching/evaluations/${ev.id}`, { token: s.coach.token, body: { row_version: 1, scores } });
    assert.equal((await patch({ execution: { score: 8.3 } })).status, 400, `${sp.slug}: a score off the step is refused`);
    const v = ok(await patch({ execution: { score: 8.5 }, split_time: { score: 25 }, reads_the_game: { score: 4 } }));
    // execution 8.5/10 -> 85 (w2); split 25 on 10..60 lower-is-better -> 70 (w1); reads 4 -> 75 (w1): (170 + 70 + 75) / 4 = 78.75 -> 78.8
    assert.equal(v.summary.overall, 78.8, `${sp.slug}: weighted overall`);
    assert.equal(v.pillar_labels.judging, 'Judging'); assert.ok(v.summary.pillars.performance_data, `${sp.slug}: a pillar of the coach's own`);
    assert.equal(v.criteria.find((c) => c.key === 'split_time').unit, 's');
    if (sp === sports.at(-1)) {   // a coach's own pillar names and a typed number reach the PDF without errors, for the last sport as the example
      const pdf = ok(await api('GET', `/coaching/evaluations/${ev.id}/export`, { token: s.coach.token }));
      assert.equal(Buffer.from(pdf.content, 'base64').subarray(0, 5).toString(), '%PDF-');
    }
  }
});
