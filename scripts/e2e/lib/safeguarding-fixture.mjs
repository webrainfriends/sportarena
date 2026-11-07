// Real safeguarding data for the screenshot scripts (#784). Everything goes through the public API in a throwaway database; nothing is hard-coded into the product.
//   seedSafeguarding({ call, reg, org, owner, coach, kids, parents })  ->  { officer, lead, cases }
export async function seedSafeguarding({ call, reg, org, owner, coach, kids, log = console.log }) {
  const officer = await reg('sg_officer', 'Meera Iyer', ['coach']), lead = await reg('sg_lead', 'Daniel Okafor', ['coach']);
  for (const u of [officer, lead]) {
    await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role: 'staff' } });
    await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } });
  }
  await call('POST', `/organisations/${org.id}/academy/staff/${officer.id}`, { token: owner.token, body: { job_title: 'Safeguarding lead', template: 'safeguarding' } });
  // the academy's own youth-access requirement: staff must have made the safeguarding declaration. The two officers have; the head coach has not yet.
  const req = await call('POST', '/compliance/requirements', { token: owner.token, body: { scope_kind: 'organisation', scope_id: org.id, name: 'Safeguarding briefing', category: 'attestation', method: 'declaration', statement: 'I have completed the academy safeguarding briefing and will follow its code of conduct.' } });
  await call('POST', `/compliance/requirements/${req.id}/obligations`, { token: owner.token, body: { roles: ['coach'], consequences: ['youth_access'] } });
  for (const u of [officer, lead]) await call('POST', '/compliance/records', { token: u.token, body: { requirement_id: req.id, confirm: true } });
  const base = `/organisations/${org.id}/academy/safeguarding`;
  await call('POST', `${base}/officers`, { token: owner.token, body: { user_id: officer.id, tier: 1 } });
  await call('POST', `${base}/officers`, { token: owner.token, body: { user_id: lead.id, tier: 2 } });
  await call('POST', `${base}/policy`, { token: owner.token, body: { retention_years: 7, require_guardian_copy: true, allow_private_channels: false, quiet_from: '21:00', quiet_to: '06:00' } });
  await call('POST', `${base}/report-rules`, { token: owner.token, body: { jurisdiction: 'IN', incident_type: 'welfare', authority_label: 'Child Welfare Committee', notify_within_hours: 24, guidance: 'Consider whether the statutory duty to report applies.' } });
  await call('POST', `${base}/report-rules`, { token: owner.token, body: { jurisdiction: 'IN', incident_type: 'conduct', authority_label: 'Local police (POCSO)', notify_within_hours: 24 } });
  const raise = (token, b) => call('POST', `${base}/cases`, { token, body: { idempotency_key: `sgfx-${Math.random().toString(36).slice(2, 12)}`, ...b } });
  const cases = [];
  cases.push(await raise(coach.token, { athlete_id: kids[1].id, category: 'welfare', risk: 'high', jurisdiction: 'IN-KA', summary: 'Athlete was withdrawn at training for three weeks and said they were afraid to go home.' }));
  cases.push(await raise(coach.token, { athlete_id: kids[2].id, category: 'online', risk: 'medium', summary: 'A parent reported messages to the athlete from an unknown account that mentions the academy.' }));
  cases.push(await raise(kids[3].token, { athlete_id: kids[3].id, category: 'other', risk: 'low', summary: 'I would like to talk to someone about a problem with another player.' }));
  const done = await raise(coach.token, { athlete_id: kids[0].id, category: 'pickup', risk: 'low', summary: 'An unlisted adult arrived to collect the athlete; the pickup was blocked and the guardian informed.' });
  cases.push(done);
  // work two of them as the officer so the desk shows live states
  const list = await call('GET', `${base}/cases`, { token: officer.token, body: undefined });
  const byNo = Object.fromEntries((list?.items ?? []).map((c) => [c.case_no, c]));
  const high = byNo[cases[0].case_no];
  if (high) {
    await call('PATCH', `/academy/safeguarding/cases/${high.id}`, { token: officer.token, body: { action: 'acknowledge', row_version: high.row_version } });
    await call('POST', `/academy/safeguarding/cases/${high.id}/actions`, { token: officer.token, body: { kind: 'risk_review', note: 'Speak to the athlete with a second officer present.' } });
    await call('POST', `/academy/safeguarding/cases/${high.id}/actions`, { token: officer.token, body: { kind: 'guardian_contact', note: 'Contact the guardian using the approved wording.' } });
  }
  const closed = byNo[done.case_no];
  if (closed) {
    const c1 = await call('PATCH', `/academy/safeguarding/cases/${closed.id}`, { token: officer.token, body: { action: 'acknowledge', row_version: closed.row_version } });
    await call('PATCH', `/academy/safeguarding/cases/${closed.id}`, { token: officer.token, body: { action: 'close', row_version: c1.row_version, outcome: 'Pickup blocked; guardians reviewed the collector list.', close_reason: 'resolved' } });
  }
  log('safeguarding fixture ready');
  return { officer, lead, cases };
}
