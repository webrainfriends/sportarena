// Real wellbeing & development data for the screenshot scripts (#795). Everything goes through the public API in a throwaway database (plus the admin
// decision a guardian link needs and a few back-dated timestamps so the trend has weeks in it); nothing is hard-coded into the product.
//   seedWellbeing({ call, reg, org, owner, db, apiDir, env })  ->  { mentor, officer, youth, adults, parents, track, W }
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const inDays = (n, h = 16) => { const d = new Date(Date.now() + n * 864e5); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
const ALL = ['tracks', 'mentoring', 'checkins', 'goals', 'guardian_updates', 'referrals'];

export async function seedWellbeing({ call, reg, org, owner, db, apiDir, env, log = console.log }) {
  Object.assign(process.env, env);
  const { signToken } = await import(`${apiDir}src/auth.js`);
  const adminId = (await db.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,'Platform admin','{admin}','x','x',$1) RETURNING id", [`wb_admin_${Date.now().toString(36)}`])).rows[0].id;
  const admin = { token: await signToken({ id: adminId, roles: ['admin'] }) };
  const W = `/organisations/${org.id}/academy/wellbeing`;
  const mentor = await reg('wb_mentor', 'Alex Lee', ['coach']), officer = await reg('wb_officer', 'Dr Sana Qureshi', ['coach']);
  for (const [u, role, title, template] of [[mentor, 'coach', 'Player care mentor', 'mentor'], [officer, 'staff', 'Safeguarding lead', 'safeguarding']]) {
    await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } });
    await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } });
    await call('POST', `/organisations/${org.id}/academy/staff/${u.id}`, { token: owner.token, body: { job_title: title, template } });
  }
  const cohort = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'Performance squad', coach_id: mentor.id } });
  const youthNames = [['Kabir Malhotra', 13], ['Lucia Ferrer', 12], ['Noah Dsouza', 14], ['Ishaan Rao', 11], ['Marta Vidal', 15], ['Arjun Nair', 13]];
  const adultNames = [['Meera Iyer', 21], ['Diego Navarro', 19], ['Sofia Marin', 22], ['Rohan Kapoor', 20]];
  const youth = [], parents = [], adults = [];
  for (const [i, [name, age]] of youthNames.entries()) {
    const kid = await reg(`wb_kid${i}`, name, ['athlete'], { dob: yearsAgo(age) });
    const parent = await reg(`wb_parent${i}`, `${name.split(' ')[1]} family guardian`, ['athlete'], { dob: yearsAgo(41) });
    const l = await call('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid.id, relationship: 'parent' } });
    await call('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } });
    await call('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } });
    await call('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } });
    await call('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'participation' } });
    youth.push(kid); parents.push(parent);
  }
  for (const [i, [name, age]] of adultNames.entries()) adults.push(await reg(`wb_adult${i}`, name, ['athlete'], { dob: yearsAgo(age) }));
  await call('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${[...youth, ...adults].map((k) => `${k.handle},yes`).join('\n')}` } });

  // what each family chose: Marta's guardian has not chosen yet, Arjun's guardian only chose tracks
  const choose = (athlete, by, scopes) => call('POST', '/me/wellbeing/consent', { token: by.token, body: { organisation_id: org.id, athlete_id: athlete.id, scopes } });
  for (const [i, k] of youth.entries()) if (i !== 4) await choose(k, parents[i], i === 5 ? ['tracks'] : ALL);
  for (const a of adults) await choose(a, a, ALL);

  // mentors: Alex mentors six, the director mentors Ishaan; Marta, Arjun and Rohan have none yet
  const mentees = [youth[0], youth[1], youth[2], adults[0], adults[1], adults[2]];
  for (const a of mentees) await call('POST', `${W}/mentors`, { token: owner.token, body: { athlete_id: a.id, mentor_id: mentor.id, cadence_days: 14 } });
  await call('POST', `${W}/mentors`, { token: owner.token, body: { athlete_id: youth[3].id, mentor_id: owner.id, cadence_days: 21 } });

  // check-ins held over the last weeks (booked in the future, then back-dated, then recorded by the mentor)
  const topics = [['sleep_and_routine', 'school_and_study'], ['training_load_and_rest'], ['confidence_and_goals', 'team_and_friendships'], ['nutrition_and_hydration']];
  for (const [n, a] of mentees.entries()) {
    for (const weeksAgo of [6, 4, 2].slice(0, n === 5 ? 1 : 3)) {
      const made = await call('POST', `${W}/checkins`, { token: mentor.token, body: { athlete_id: a.id, scheduled_for: inDays(1), topics: topics[(n + weeksAgo) % 4] } });
      const id = made.ids[0];
      await db.query("UPDATE academy_wellbeing_checkins SET scheduled_for = now() - make_interval(weeks => $2) WHERE id=$1", [id, weeksAgo]);
      const row = (await db.query('SELECT row_version FROM academy_wellbeing_checkins WHERE id=$1', [id])).rows[0];
      const follow = weeksAgo === 2 && n % 3 === 0;
      await call('PATCH', `/academy/wellbeing/checkins/${id}`, { token: mentor.token, body: { row_version: row.row_version, action: 'complete', outcome: follow ? 'follow_up' : 'on_track', next_step: follow ? 'Agree a wind-down routine before bed and try it for a week' : undefined, follow_up_due: follow ? new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) : undefined } });
      await db.query("UPDATE academy_wellbeing_checkins SET completed_at = now() - make_interval(weeks => $2) + interval '1 hour' WHERE id=$1", [id, weeksAgo]);
    }
    if (n < 4) await call('POST', `${W}/checkins`, { token: mentor.token, body: { athlete_id: a.id, scheduled_for: inDays(2 + n * 2), topics: topics[n % 4] } });
  }
  // one that happened and was never recorded: it shows as action due for the mentor
  const late = await call('POST', `${W}/checkins`, { token: mentor.token, body: { athlete_id: youth[1].id, scheduled_for: inDays(1), topics: ['school_and_study'] } });
  await db.query("UPDATE academy_wellbeing_checkins SET scheduled_for = now() - interval '3 days' WHERE id=$1", [late.ids[0]]);

  // goals: one running, one waiting for the family, one reviewed
  const g1 = await call('POST', `${W}/goals`, { token: mentor.token, body: { athlete_id: youth[0].id, title: 'Lead the warm-up twice a week', measure: 'Two sessions a week, for a month, with the coach noting it', target_date: new Date(Date.now() + 28 * 864e5).toISOString().slice(0, 10) } });
  await call('POST', `/me/wellbeing/goals/${g1.id}/respond`, { token: parents[0].token, body: { decision: 'agree' } });
  const g1v = (await db.query('SELECT row_version FROM academy_dev_goals WHERE id=$1', [g1.id])).rows[0];
  await call('PATCH', `/academy/wellbeing/goals/${g1.id}`, { token: mentor.token, body: { row_version: g1v.row_version, action: 'start' } });
  await call('POST', `${W}/goals`, { token: mentor.token, body: { athlete_id: youth[1].id, title: 'Keep a simple training and school diary', measure: 'Five entries a week for a month' } });
  const g3 = await call('POST', `${W}/goals`, { token: mentor.token, body: { athlete_id: adults[0].id, title: 'Plan weekday meals around training', measure: 'A written plan for Monday to Friday' } });
  await call('POST', `/me/wellbeing/goals/${g3.id}/respond`, { token: adults[0].token, body: { decision: 'agree' } });
  await db.query("UPDATE academy_dev_goals SET next_review_on = current_date - 1 WHERE id=$1", [g3.id]);

  // tracks: one with five taking part (shown), one with four (hidden: fewer than five)
  const lead = await call('POST', `${W}/tracks`, { token: owner.token, body: { category: 'leadership', title: 'Leadership foundations', summary: 'Leading a warm-up, giving feedback kindly and taking responsibility for a team routine.', age_min: 11, age_max: 16, delivery: 'group', sports: [], modules: [{ title: 'What a good leader does', outcome: 'Names three habits and shows one' }, { title: 'Leading a warm-up', outcome: 'Runs a five-minute warm-up for the group' }, { title: 'Feedback that helps', outcome: 'Gives one kind, specific piece of feedback' }, { title: 'Owning a routine', outcome: 'Keeps a team routine for four weeks' }] } });
  const fuel = await call('POST', `${W}/tracks`, { token: owner.token, body: { category: 'nutrition_education', title: 'Fuel for performance', summary: 'Eating and drinking for training, match days and recovery, in everyday food.', age_min: 16, age_max: 25, delivery: 'blended', sports: [], modules: [{ title: 'Eating around training', outcome: 'Plans meals for a training day' }, { title: 'Match-day fuel', outcome: 'Builds a match-day plan' }, { title: 'Hydration and recovery', outcome: 'Tracks fluids for a week' }] } });
  await call('POST', `${W}/tracks`, { token: owner.token, body: { category: 'life_skills', title: 'Away from home', summary: 'Packing, routines and keeping in touch when travelling for the academy.', age_min: 10, age_max: 16, delivery: 'group', sports: [], modules: [{ title: 'Packing and routines', outcome: 'Packs own bag from a list' }, { title: 'Keeping in touch', outcome: 'Agrees a plan with their family' }], status: 'active' } });
  await call('POST', `/academy/wellbeing/tracks/${lead.id}/members`, { token: mentor.token, body: { athlete_ids: [youth[0].id, youth[1].id, youth[2].id, youth[3].id, youth[5].id] } });
  await call('POST', `/academy/wellbeing/tracks/${fuel.id}/members`, { token: mentor.token, body: { athlete_ids: adults.map((a) => a.id) } });
  for (const [k, done] of [[youth[0], [0, 1, 2]], [youth[1], [0, 1]], [youth[2], [0]], [youth[3], [0, 1]]]) for (const m of done) await call('POST', `/academy/wellbeing/tracks/${lead.id}/members/${k.id}`, { token: mentor.token, body: { action: 'module_done', module_index: m } });
  for (const [k, done] of [[adults[0], [0, 1]], [adults[1], [0]]]) for (const m of done) await call('POST', `/academy/wellbeing/tracks/${fuel.id}/members/${k.id}`, { token: mentor.token, body: { action: 'module_done', module_index: m } });

  // specialist suggestions: one waiting for a guardian, one the adult athlete agreed to
  await call('POST', `${W}/referrals`, { token: mentor.token, body: { athlete_id: youth[2].id, specialty: 'sports_psychology', reason: 'performance_pressure' } });
  const r2 = await call('POST', `${W}/referrals`, { token: mentor.token, body: { athlete_id: adults[0].id, specialty: 'nutrition', reason: 'nutrition_support' } });
  await call('POST', `/me/wellbeing/referrals/${r2.id}/respond`, { token: adults[0].token, body: { decision: 'consent' } });
  await db.query("UPDATE academy_wellbeing_referrals SET created_at = now() - interval '5 days', decided_at = now() - interval '4 days' WHERE id=$1", [r2.id]);
  await call('POST', `${W}/updates`, { token: mentor.token, body: { athlete_id: youth[0].id, template: 'thank_you', note: 'Great attitude leading the warm-up' } });
  await call('GET', `${W}/athletes/${youth[0].id}`, { token: mentor.token });
  log('wellbeing fixture ready');
  return { mentor, officer, youth, adults, parents, W, cohort };
}
