// Real pickup & safety data for the screenshot scripts (#788). Everything goes through the public API in a throwaway database (plus the admin
// decision that a guardian link needs and one run of the sweep); nothing is hard-coded into the product.
//   seedPickup({ call, reg, org, owner, coach, cohort, db, apiDir, env })  ->  { sessionId, kids, guardians, delegate }
import { execFileSync } from 'node:child_process';

const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const dayOf = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

export async function seedPickup({ call, reg, org, owner, coach, cohort, db, apiDir, env, log = console.log }) {
  Object.assign(process.env, env);                                   // same signing key as the API process, so we can mint the platform admin's token
  const { signToken } = await import(`${apiDir}src/auth.js`);
  const adminId = (await db.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,'Platform admin','{admin}','x','x',$1) RETURNING id", [`pk_admin_${Date.now().toString(36)}`])).rows[0].id;
  const admin = { token: await signToken({ id: adminId, roles: ['admin'] }) };
  const names = ['Kabir Malhotra', 'Lucia Ferrer', 'Noah Dsouza', 'Ishaan Rao'];
  const kids = [], guardians = [];
  for (const [i, name] of names.entries()) {
    const kid = await reg(`pk_kid${i}`, name, ['athlete'], { dob: yearsAgo(11) });
    const parent = await reg(`pk_parent${i}`, `${name.split(' ')[1]} family guardian`, ['athlete'], { dob: yearsAgo(40) });
    const l = await call('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid.id, relationship: 'parent' } });
    await call('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } });
    await call('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } });
    await call('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } });
    await call('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'participation' } });
    kids.push(kid); guardians.push(parent);
  }
  await call('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.map((k) => `${k.handle},yes`).join('\n')}` } });
  const start = dayOf(3);
  const made = await call('POST', `/cohorts/${cohort.id}/academy/timetable`, { token: owner.token, body: { idempotency_key: `pk-${Date.now()}`, starts_on: start, ends_on: start, weekdays: [new Date(`${start}T00:00:00Z`).getUTCDay()], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: coach.id } });
  const sessionId = made.created[0].id;
  await call('POST', `/organisations/${org.id}/academy/sessions/publish`, { token: owner.token, body: { session_ids: [sessionId], acknowledge_warnings: true } });
  await db.query("UPDATE academy_sessions SET title='U12 Football · Pitch 2', starts_at=now() - interval '95 minutes', ends_at=now() - interval '25 minutes' WHERE id=$1", [sessionId]);
  for (const k of kids.slice(0, 3)) await call('POST', `/academy/sessions/${sessionId}/attendance`, { token: coach.token, body: { entries: [{ user_id: k.id, status: 'present' }] } });
  // Lucia: her guardian shows their own QR, handed over
  const qr = await call('GET', '/me/pickup-pass?' + new URLSearchParams({ session_id: sessionId, child_id: kids[1].id }), { token: guardians[1].token });
  await call('POST', `/academy/sessions/${sessionId}/pickup/handover`, { token: coach.token, body: { idempotency_key: `pk-h1-${Date.now()}`, athlete_id: kids[1].id, collector_user_id: guardians[1].id, pass_token: qr.token } });
  // Noah: an uncle with a passphrase collects; the guardian has not confirmed yet
  const uncle = await reg('pk_uncle', 'Rahul Dsouza', ['athlete'], { dob: yearsAgo(38) });
  await call('POST', `/youth/children/${kids[2].id}/pickup-delegates`, { token: guardians[2].token, body: { delegate_user_id: uncle.id, relationship: 'relative', passphrase: 'blue heron', valid_days: 30, phone: '+34 600 111 222' } });
  await call('POST', `/youth/children/${kids[2].id}/pickup-delegates`, { token: guardians[2].token, body: { delegate_name: 'Dr Anil Rao', relationship: 'family_friend', can_collect: false, is_emergency: true, emergency_rank: 1, valid_days: 365, phone: '+34 611 222 333' } });
  await call('POST', `/academy/sessions/${sessionId}/pickup/handover`, { token: coach.token, body: { idempotency_key: `pk-h2-${Date.now()}`, athlete_id: kids[2].id, collector_user_id: uncle.id, passphrase: 'blue heron', attested: ['id_seen'] } });
  // Aarav: someone who is not on the list tries to collect: blocked and raised
  const stranger = await reg('pk_stranger', 'Jordan Pike', ['athlete'], { dob: yearsAgo(33) });
  await call('POST', `/academy/sessions/${sessionId}/pickup/handover`, { token: coach.token, body: { idempotency_key: `pk-h3-${Date.now()}`, athlete_id: kids[0].id, collector_user_id: stranger.id, attested: ['id_seen'] } });
  // the sweep walks the ladder for Aarav (25 minutes late) and raises the no-show for Ishaan
  execFileSync('node', ['--input-type=module', '-e', "import('./src/pickup-sweeps.js').then((m) => m.sweepPickups()).then(() => process.exit(0))"], { cwd: apiDir, env: { ...process.env, ...env }, stdio: 'inherit' });
  log('pickup fixture ready');
  return { sessionId, kids, guardians, delegate: uncle };
}
