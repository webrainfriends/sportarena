import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `edu_${n}_${roles[0]}`, display_name: `Edu ${n}`, email: `edu${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
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

async function academy() {
  const owner = await signup();
  const td = await signup();
  const coach = await signup(['coach']);
  const coach2 = await signup(['coach']);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `EduAcademy ${n}`, kind: 'academy' } }), 201);
  for (const [u, role] of [[td, 'staff'], [coach, 'coach'], [coach2, 'coach']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${td.id}`, { token: owner.token, body: { job_title: 'Technical Director', template: 'head_coach' } }));
  return { owner, td, coach, coach2, org };
}

test('Module library — list, create, publish', async (t) => {
  const a = await academy();

  await t.test('TD creates a CPD module in draft', async () => {
    const mod = ok(await api('POST', `/organisations/${a.org.id}/academy/edu-modules`, {
      token: a.td.token,
      body: { title: 'Safeguarding Refresher', kind: 'cpd', cpd_hours: 3, mandatory: true, pillar: 'mental', description: 'Annual safeguarding update.' },
    }), 201);
    assert.equal(mod.kind, 'cpd');
    assert.equal(mod.status, 'draft');
    a.mod = mod;
  });

  await t.test('Coach cannot create modules', async () => {
    const r = await api('POST', `/organisations/${a.org.id}/academy/edu-modules`, {
      token: a.coach.token,
      body: { title: 'Fake', kind: 'cpd', cpd_hours: 1, mandatory: false },
    });
    assert.ok([403, 404].includes(r.status));
  });

  await t.test('TD lists modules', async () => {
    const rows = ok(await api('GET', `/organisations/${a.org.id}/academy/edu-modules`, { token: a.td.token }));
    assert.ok(rows.some((m) => m.id === a.mod.id));
  });

  await t.test('TD publishes module', async () => {
    const updated = ok(await api('PATCH', `/academy/edu-modules/${a.mod.id}`, {
      token: a.td.token,
      body: { row_version: a.mod.row_version, status: 'published' },
    }));
    assert.equal(updated.status, 'published');
    a.mod = updated;
  });
});

test('Assignments — assign coach, list mine', async (t) => {
  const a = await academy();
  const mod = ok(await api('POST', `/organisations/${a.org.id}/academy/edu-modules`, {
    token: a.td.token,
    body: { title: 'Tactical Module', kind: 'cpd', cpd_hours: 2, mandatory: false, pillar: 'tactical' },
  }), 201);
  ok(await api('PATCH', `/academy/edu-modules/${mod.id}`, { token: a.td.token, body: { row_version: mod.row_version, status: 'published' } }));

  await t.test('TD assigns coach to module', async () => {
    const asn = ok(await api('POST', `/academy/edu-modules/${mod.id}/assign`, {
      token: a.td.token,
      body: { coach_id: a.coach.id, due_on: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) },
    }), 201);
    assert.equal(asn.status, 'assigned');
    a.asn = asn;
  });

  await t.test('Coach lists own assignments', async () => {
    const rows = ok(await api('GET', `/organisations/${a.org.id}/academy/my-edu-assignments`, {
      token: a.coach.token, query: { status: 'all', limit: 50 },
    }));
    assert.ok(rows.some((r) => r.id === a.asn.id));
  });

  await t.test('Coach cannot assign others', async () => {
    const r = await api('POST', `/academy/edu-modules/${mod.id}/assign`, {
      token: a.coach.token,
      body: { coach_id: a.coach2.id },
    });
    assert.ok([403, 404].includes(r.status));
  });
});

test('Completions — submit, approve, reject', async (t) => {
  const a = await academy();
  const mod = ok(await api('POST', `/organisations/${a.org.id}/academy/edu-modules`, {
    token: a.td.token,
    body: { title: 'Physical Conditioning', kind: 'cpd', cpd_hours: 1.5, mandatory: true, pillar: 'physical' },
  }), 201);
  ok(await api('PATCH', `/academy/edu-modules/${mod.id}`, { token: a.td.token, body: { row_version: mod.row_version, status: 'published' } }));
  const asn = ok(await api('POST', `/academy/edu-modules/${mod.id}/assign`, {
    token: a.td.token,
    body: { coach_id: a.coach.id, due_on: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10) },
  }), 201);

  await t.test('Coach submits completion evidence', async () => {
    const ikey = `test-${Date.now()}-${Math.random()}`;
    const cmp = ok(await api('POST', `/academy/edu-assignments/${asn.id}/completions`, {
      token: a.coach.token,
      body: { evidence_kind: 'certificate', evidence_note: 'Completed online safeguarding course.', idempotency_key: ikey },
    }), 201);
    assert.equal(cmp.status, 'submitted');
    a.cmp = cmp;
    a.ikey = ikey;
  });

  await t.test('Idempotency: duplicate submission returns existing record', async () => {
    const r = ok(await api('POST', `/academy/edu-assignments/${asn.id}/completions`, {
      token: a.coach.token,
      body: { evidence_kind: 'certificate', evidence_note: 'Duplicate.', idempotency_key: a.ikey },
    }));
    assert.equal(r.id, a.cmp.id);
  });

  await t.test('TD reviews and approves', async () => {
    const updated = ok(await api('POST', `/academy/edu-completions/${a.cmp.id}/review`, {
      token: a.td.token,
      body: { decision: 'approved', review_note: 'Evidence verified.' },
    }));
    assert.equal(updated.status, 'approved');
  });
});

test('Appeals — open and resolve', async (t) => {
  const a = await academy();
  const mod = ok(await api('POST', `/organisations/${a.org.id}/academy/edu-modules`, {
    token: a.td.token,
    body: { title: 'Lifestyle Module', kind: 'cpd', cpd_hours: 1, mandatory: false, pillar: 'lifestyle' },
  }), 201);
  ok(await api('PATCH', `/academy/edu-modules/${mod.id}`, { token: a.td.token, body: { row_version: mod.row_version, status: 'published' } }));
  const asn = ok(await api('POST', `/academy/edu-modules/${mod.id}/assign`, { token: a.td.token, body: { coach_id: a.coach.id } }), 201);
  const cmp = ok(await api('POST', `/academy/edu-assignments/${asn.id}/completions`, {
    token: a.coach.token,
    body: { evidence_kind: 'reflection', evidence_note: 'Lifestyle reflection journal.', idempotency_key: `apl-${Date.now()}` },
  }), 201);
  ok(await api('POST', `/academy/edu-completions/${cmp.id}/review`, { token: a.td.token, body: { decision: 'rejected', review_note: 'Insufficient detail.' } }));

  await t.test('Coach opens appeal', async () => {
    const apl = ok(await api('POST', `/academy/edu-completions/${cmp.id}/appeal`, {
      token: a.coach.token,
      body: { appeal_note: 'I provided a thorough journal. Requesting reconsideration.' },
    }), 201);
    assert.ok(apl.appeal_note);
    a.apl = apl;
  });

  await t.test('TD resolves appeal (uphold)', async () => {
    const resolved = ok(await api('POST', `/academy/edu-appeals/${a.apl.id}/resolve`, {
      token: a.td.token,
      body: { outcome: 'upheld', resolution_note: 'On reflection journal meets standard.' },
    }));
    assert.equal(resolved.outcome, 'upheld');
  });
});

test('Mentor pairings — list and create', async (t) => {
  const a = await academy();

  await t.test('Empty pairing list', async () => {
    const rows = ok(await api('GET', `/organisations/${a.org.id}/academy/mentor-pairings`, { token: a.td.token, query: { status: 'all' } }));
    assert.ok(Array.isArray(rows));
  });

  await t.test('TD creates a mentor pairing', async () => {
    const pairing = ok(await api('POST', `/organisations/${a.org.id}/academy/mentor-pairings`, {
      token: a.td.token,
      body: { mentor_id: a.coach.id, mentee_id: a.coach2.id, starts_on: new Date().toISOString().slice(0, 10), frequency_weeks: 2, goals: [{ key: 'tactical_awareness', label: 'Improve tactical awareness', status: 'active' }] },
    }), 201);
    assert.equal(pairing.status, 'active');
    a.pairing = pairing;
  });

  await t.test('Duplicate live pairing is rejected', async () => {
    const r = await api('POST', `/organisations/${a.org.id}/academy/mentor-pairings`, {
      token: a.td.token,
      body: { mentor_id: a.coach.id, mentee_id: a.coach2.id, starts_on: new Date().toISOString().slice(0, 10), frequency_weeks: 2, goals: [] },
    });
    assert.equal(r.status, 409);
  });

  await t.test('Pairing appears in list', async () => {
    const rows = ok(await api('GET', `/organisations/${a.org.id}/academy/mentor-pairings`, { token: a.td.token, query: { status: 'all' } }));
    assert.ok(rows.some((p) => p.id === a.pairing.id));
  });
});

test('Mentor sessions — schedule and complete', async (t) => {
  const a = await academy();
  const pairing = ok(await api('POST', `/organisations/${a.org.id}/academy/mentor-pairings`, {
    token: a.td.token,
    body: { mentor_id: a.coach.id, mentee_id: a.coach2.id, starts_on: new Date().toISOString().slice(0, 10), frequency_weeks: 2, goals: [] },
  }), 201);

  await t.test('Mentor schedules a session', async () => {
    const sess = ok(await api('POST', `/academy/mentor-pairings/${pairing.id}/sessions`, {
      token: a.coach.token,
      body: { scheduled_at: new Date(Date.now() + 7 * 864e5).toISOString(), duration_min: 60, session_type: 'one_to_one' },
    }), 201);
    assert.equal(sess.status, 'scheduled');
    a.sess = sess;
  });

  await t.test('Mentee also can see sessions', async () => {
    const rows = ok(await api('GET', `/academy/mentor-pairings/${pairing.id}/sessions`, { token: a.coach2.token, query: { status: 'all', limit: 20 } }));
    assert.ok(rows.some((s) => s.id === a.sess.id));
  });

  await t.test('Mentor completes session with agreed actions', async () => {
    const updated = ok(await api('POST', `/academy/mentor-sessions/${a.sess.id}/complete`, {
      token: a.coach.token,
      body: { row_version: a.sess.row_version, agreed_actions: [{ key: 'shadow_td', label: 'Shadow TD for 2 sessions', status: 'pending' }] },
    }));
    assert.equal(updated.status, 'completed');
  });
});

test('TD observations — create, list, release', async (t) => {
  const a = await academy();

  await t.test('TD creates observation', async () => {
    const obs = ok(await api('POST', `/organisations/${a.org.id}/academy/td-observations`, {
      token: a.td.token,
      body: {
        coach_id: a.coach.id,
        session_date: new Date().toISOString().slice(0, 10),
        context: 'U14 technical session — first touch and passing combos',
        pillar: 'technical',
        overall_rating: 4,
        pillar_ratings: [{ pillar: 'technical', rating: 4 }, { pillar: 'tactical', rating: 3 }],
        strengths_enc: 'Excellent use of body shape before receiving.',
        development_enc: 'Needs to vary tempo of delivery in final third.',
        coaching_points: 'Encourage players to scan earlier.',
      },
    }), 201);
    assert.equal(obs.status, 'draft');
    a.obs = obs;
  });

  await t.test('Coach cannot see unreleased observation', async () => {
    const r = await api('GET', `/academy/td-observations/${a.obs.id}`, { token: a.coach.token });
    assert.ok([403, 404].includes(r.status));
  });

  await t.test('TD lists observations for org', async () => {
    const rows = ok(await api('GET', `/organisations/${a.org.id}/academy/td-observations`, { token: a.td.token, query: { status: 'all' } }));
    assert.ok(rows.some((o) => o.id === a.obs.id));
  });

  await t.test('TD releases observation to coach', async () => {
    const released = ok(await api('POST', `/academy/td-observations/${a.obs.id}/release`, {
      token: a.td.token,
      body: { row_version: a.obs.row_version },
    }));
    assert.equal(released.status, 'released');
  });

  await t.test('Coach can now see released observation (without private notes)', async () => {
    const obs = ok(await api('GET', `/academy/td-observations/${a.obs.id}`, { token: a.coach.token }));
    assert.equal(obs.status, 'released');
    assert.equal(obs.strengths_enc, undefined, 'Private note must not leak to coach');
  });

  await t.test('TD still sees private notes', async () => {
    const obs = ok(await api('GET', `/academy/td-observations/${a.obs.id}`, { token: a.td.token }));
    assert.ok(obs.strengths_enc, 'TD should see decrypted strengths');
  });
});

test('Improvement plans — create, list, add action', async (t) => {
  const a = await academy();
  const obs = ok(await api('POST', `/organisations/${a.org.id}/academy/td-observations`, {
    token: a.td.token,
    body: { coach_id: a.coach.id, session_date: new Date().toISOString().slice(0, 10), context: 'Warm-up drill', pillar: 'tactical', overall_rating: 2 },
  }), 201);

  await t.test('TD creates improvement plan for coach', async () => {
    const plan = ok(await api('POST', `/organisations/${a.org.id}/academy/coach-improvement-plans`, {
      token: a.td.token,
      body: { coach_id: a.coach.id, observation_id: obs.id, focus: 'Tactical awareness in transition', target_date: new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10) },
    }), 201);
    assert.ok(plan.id);
    a.plan = plan;
  });

  await t.test('TD lists improvement plans', async () => {
    const rows = ok(await api('GET', `/organisations/${a.org.id}/academy/coach-improvement-plans`, { token: a.td.token }));
    assert.ok(rows.some((p) => p.id === a.plan.id));
  });

  await t.test('TD adds action to improvement plan', async () => {
    const action = ok(await api('POST', `/academy/coach-improvement-plans/${a.plan.id}/actions`, {
      token: a.td.token,
      body: { action_text: 'Attend tactical video analysis session with head coach', due_on: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10) },
    }), 201);
    assert.ok(action.id);
    a.action = action;
  });

  await t.test('Coach can retrieve own improvement plan', async () => {
    const plan = ok(await api('GET', `/academy/coach-improvement-plans/${a.plan.id}`, { token: a.coach.token }));
    assert.equal(plan.id, a.plan.id);
  });
});

test('Compliance report', async (t) => {
  const a = await academy();

  await t.test('TD can fetch org CPD compliance report', async () => {
    const report = ok(await api('GET', `/organisations/${a.org.id}/academy/coach-edu-report`, { token: a.td.token }));
    assert.ok(Array.isArray(report.module_stats));
    assert.ok(Array.isArray(report.coach_summary));
  });

  await t.test('Coach cannot access compliance report', async () => {
    const r = await api('GET', `/organisations/${a.org.id}/academy/coach-edu-report`, { token: a.coach.token });
    assert.ok([403, 404].includes(r.status));
  });
});
