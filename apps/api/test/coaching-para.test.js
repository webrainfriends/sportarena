import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// PS-13 (#843): Para-sport coaching adaptations
// Tests for coaching-para.js capability:
//   - get_session_support_requirements: only consented needs; unrelated coach gets 404
//   - assign_session_guide / remove_session_guide / list_session_guides round-trip
//   - save_para_session_template: stores para_template tag; scrub strips athlete IDs
//   - list_para_session_templates: filters correctly
//   - block with para_adaptations saves and round-trips
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `CP ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('cp_root','cp_root','{admin}','x','x','cp_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// Create a minimal coaching session with two athletes enrolled and return ids
async function setupSession(coach) {
  const sport = (await pool.query("INSERT INTO sports(name, slug, is_para) VALUES('Wheelchair Basketball','wheelchair-basketball',true) ON CONFLICT(slug) DO UPDATE SET is_para=true RETURNING id")).rows[0];
  const a1 = await signup(['athlete']);
  const a2 = await signup(['athlete']);
  // create session record
  const rec = (await pool.query(
    "INSERT INTO coaching_session_records(coach_id, sport_id, source_type, source_id, title, status) VALUES($1,$2,'team_session','test-src','Para test session','planned') RETURNING *",
    [coach.id, sport.id],
  )).rows[0];
  // add athletes to session
  await pool.query('INSERT INTO coaching_session_participants(session_record_id, athlete_id) VALUES($1,$2),($1,$3)', [rec.id, a1.id, a2.id]);
  return { rec, a1, a2, sport };
}

// Share support needs with coach (simulates athlete's consent in inclusion module)
async function shareNeeds(athleteId, coachId, needKeys) {
  await pool.query(
    "INSERT INTO inclusion_shares(athlete_id, audience_role, audience_user_id, need_keys, shared_by) VALUES($1,'coach',$2,$3,$1)",
    [athleteId, coachId, needKeys],
  );
}

test('get_session_support_requirements returns consented needs only', async () => {
  const coach = await signup(['coach']);
  const { rec, a1, a2 } = await setupSession(coach);

  // Only a1 has shared needs
  await shareNeeds(a1.id, coach.id, ['sighted_guide', 'tapper']);

  const r = ok(await api('GET', `/coaching/sessions/${rec.id}/para-needs`, { token: coach.token }));
  assert.equal(r.athletes.length, 2);
  const r1 = r.athletes.find((a) => a.athlete_id === a1.id);
  const r2 = r.athletes.find((a) => a.athlete_id === a2.id);
  assert(r1, 'athlete a1 should be in result');
  assert.deepEqual(r1.support_needs.sort(), ['sighted_guide', 'tapper'].sort());
  assert(r2, 'athlete a2 should be in result');
  assert.deepEqual(r2.support_needs, [], 'a2 has no shared needs');
  assert(r.disclaimer, 'should include disclaimer');
});

test('get_session_support_requirements returns 404 for unrelated coach', async () => {
  const coach = await signup(['coach']);
  const otherCoach = await signup(['coach']);
  const { rec } = await setupSession(coach);
  const r = await api('GET', `/coaching/sessions/${rec.id}/para-needs`, { token: otherCoach.token });
  assert.equal(r.status, 404);
});

test('assign_session_guide / list_session_guides / remove_session_guide round-trip', async () => {
  const coach = await signup(['coach']);
  const { rec, a1 } = await setupSession(coach);

  // Assign a named guide (another platform user)
  const guide = await signup(['athlete']);
  const assigned = ok(await api('POST', `/coaching/sessions/${rec.id}/guides`, { token: coach.token, body: { athlete_id: a1.id, guide_user_id: guide.id, guide_role: 'sighted_guide', note: 'Meets athlete at entrance ramp' } }), 201);
  assert.equal(assigned.athlete_id, a1.id);
  assert.equal(assigned.guide_role, 'sighted_guide');

  // List guides
  const list = ok(await api('GET', `/coaching/sessions/${rec.id}/guides`, { token: coach.token }));
  assert.equal(list.guides.length, 1);
  assert.equal(list.guides[0].guide_role, 'sighted_guide');

  // Remove guide
  const removed = ok(await api('DELETE', `/coaching/sessions/${rec.id}/guides/${assigned.id}`, { token: coach.token }));
  assert.equal(removed.removed, true);

  // List again — should be empty
  const list2 = ok(await api('GET', `/coaching/sessions/${rec.id}/guides`, { token: coach.token }));
  assert.equal(list2.guides.length, 0);
});

test('assign_session_guide with unnamed external guide (no guide_user_id)', async () => {
  const coach = await signup(['coach']);
  const { rec, a1 } = await setupSession(coach);
  const assigned = ok(await api('POST', `/coaching/sessions/${rec.id}/guides`, { token: coach.token, body: { athlete_id: a1.id, guide_role: 'personal_assistant' } }), 201);
  assert.equal(assigned.guide_user_id, null);
  assert.equal(assigned.guide_role, 'personal_assistant');
});

test('assign_session_guide fails for non-owner coach', async () => {
  const coach = await signup(['coach']);
  const otherCoach = await signup(['coach']);
  const { rec, a1 } = await setupSession(coach);
  const guide = await signup(['athlete']);
  const r = await api('POST', `/coaching/sessions/${rec.id}/guides`, { token: otherCoach.token, body: { athlete_id: a1.id, guide_user_id: guide.id, guide_role: 'tapper' } });
  assert.equal(r.status, 404);
});

test('save_para_session_template stores para_template tag; scrub strips athlete IDs', async () => {
  const coach = await signup(['coach']);
  const blocks = [
    {
      kind: 'skill',
      title: 'Court positioning drill',
      instructions: 'Athletes navigate cones in wheelchairs.',
      duration_min: 15,
      para_adaptations: [{ need_keys: ['sighted_guide'], athlete_ids: ['00000000-0000-0000-0000-000000000001'], instruction: 'Use verbal directional cues' }],
      accessible_media: { caption_text: 'Video shows court cones from overhead.', screen_reader_description: 'Overhead view of sports court with orange cones in a figure-eight pattern.' },
      athlete_difficulty: 'maintained',
    },
  ];
  const r = ok(await api('POST', '/coaching/para-templates', { token: coach.token, body: { title: 'WB Court Positioning', scope: 'session', para_template: 'wheelchair_basketball', blocks } }), 201);
  assert.equal(r.para_template, 'wheelchair_basketball');

  // Verify scrub stripped para_adaptations and accessible_media but kept athlete_difficulty
  const tpl = (await pool.query('SELECT blocks FROM coach_templates WHERE id=$1', [r.id])).rows[0];
  const saved = tpl.blocks[0];
  assert(!saved.para_adaptations, 'para_adaptations should be stripped by scrub()');
  assert(!saved.accessible_media, 'accessible_media should be stripped by scrub()');
  assert.equal(saved.athlete_difficulty, 'maintained', 'athlete_difficulty should be preserved');
});

test('list_para_session_templates filters by para_template', async () => {
  const coach = await signup(['coach']);
  const makeBlocks = () => [{ kind: 'skill', title: 'Block', instructions: 'x', duration_min: 10 }];
  ok(await api('POST', '/coaching/para-templates', { token: coach.token, body: { title: 'Boccia Template A', scope: 'session', para_template: 'goalball_boccia', blocks: makeBlocks() } }), 201);
  ok(await api('POST', '/coaching/para-templates', { token: coach.token, body: { title: 'WB Template B', scope: 'session', para_template: 'wheelchair_basketball', blocks: makeBlocks() } }), 201);

  const all = ok(await api('GET', '/coaching/para-templates', { token: coach.token }));
  assert(all.templates.some((t) => t.para_template === 'goalball_boccia'));
  assert(all.templates.some((t) => t.para_template === 'wheelchair_basketball'));

  const filtered = ok(await api('GET', '/coaching/para-templates', { token: coach.token, query: { para_template: 'goalball_boccia' } }));
  assert(filtered.templates.every((t) => t.para_template === 'goalball_boccia'), 'Only boccia templates should be returned');
});

test('block with para_adaptations saves and round-trips via plan save', async () => {
  const coach = await signup(['coach']);
  const { rec, a1 } = await setupSession(coach);

  const blocks = [
    {
      kind: 'warm_up',
      title: 'Accessible warm-up',
      instructions: 'Lap around the court at comfortable pace.',
      duration_min: 10,
      para_adaptations: [
        {
          need_keys: ['sighted_guide'],
          instruction: 'Complete circuit with sighted guide. Guide walks alongside and verbalises obstacles.',
          equipment: ['tethered rope (1.5m)'],
          cues: ['Listen for the direction call before each turn.'],
          communication: 'spoken',
        },
        {
          need_keys: ['tapper'],
          instruction: 'Guide uses shoulder taps: two taps = left, three taps = right.',
          communication: 'tactile',
        },
      ],
      accessible_media: {
        caption_text: 'Video: coach demonstrates the warm-up circuit with an athlete.',
        screen_reader_description: 'Coach and athlete walk a rectangular circuit around a sports court.',
      },
      athlete_difficulty: 'maintained',
    },
  ];

  const plan = ok(await api('POST', `/coaching/sessions/${rec.id}/plan`, { token: coach.token, body: { blocks, change_note: 'Add para warm-up' } }), 201);
  assert(plan.id || plan.session_record_id, 'plan version should be returned');

  // Read back and verify
  const ws = ok(await api('GET', `/coaching/sessions/${rec.id}`, { token: coach.token }));
  const saved = ws.plan?.blocks?.[0];
  assert(saved, 'Block should be in plan');
  assert.equal(saved.para_adaptations?.length, 2, 'para_adaptations should round-trip');
  assert.equal(saved.para_adaptations[0].communication, 'spoken');
  assert.equal(saved.para_adaptations[1].communication, 'tactile');
  assert.equal(saved.accessible_media?.caption_text, blocks[0].accessible_media.caption_text);
  assert.equal(saved.athlete_difficulty, 'maintained');
});
