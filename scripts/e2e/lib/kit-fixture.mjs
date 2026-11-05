// Real academy kit data for the screenshot scripts (#798). Everything goes through the public API in a throwaway database (the venue is linked to the
// academy and the guardian-link approvals come from the pickup fixture); nothing is hard-coded into the product.
//   seedKit({ call, org, owner, venue, cohort, students, db, log })  ->  { issues, guardianOf }
// `students` is [{ user, enrolment_id, size? }]: whoever is enrolled in `cohort`; the first one is fitted and issued everything, later ones show other states.
export async function seedKit({ call, org, owner, venue, cohort, students, db, log = console.log }) {
  await db.query('UPDATE venues SET organisation_id=$2 WHERE id=$1', [venue.id, org.id]);
  const prof = await call('GET', `/organisations/${org.id}/academy`, { token: owner.token });
  await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: prof?.row_version ?? 0, currency: 'INR', sports: ['football'], listed: true } });
  const item = (name, style, size, quantity, extra = {}) => call('POST', '/inventory', { token: owner.token, body: { venue_id: venue.id, name, category: 'apparel', quantity, style_key: style, size_label: size, reorder_level: 3, ...extra } });
  const shirts = {};
  for (const [size, q] of [['YS', 4], ['YM', 6], ['YL', 2]]) shirts[size] = await item('Home shirt 25/26', 'home-shirt-2526', size, q, { kit_slot: 'shirt', unit_cost_cents: 90000, sell_price_cents: 150000 });
  for (const [size, q] of [['YS', 5], ['YM', 5], ['YL', 3]]) await item('Training shorts', 'training-shorts', size, q, { kit_slot: 'shorts', unit_cost_cents: 30000, sell_price_cents: 65000 });
  await item('Training bag', 'training-bag', 'One size', 12, { kit_slot: 'bag', category: 'equipment', unit_cost_cents: 70000 });
  const gloves = await item('Goalkeeper gloves', 'keeper-gloves', 'YM', 0, { kit_slot: 'keeper_kit', category: 'equipment', serialised: true });
  if (gloves) await call('POST', `/organisations/${org.id}/academy/kit/units`, { token: owner.token, body: { item_id: gloves.id, serials: ['GK-0101', 'GK-0102', 'GK-0103'] } });
  const ent = async (body) => call('POST', `/organisations/${org.id}/academy/kit/entitlements`, { token: owner.token, body: { scope_type: 'cohort', scope_id: cohort.id, ...body } });
  const home = await ent({ name: 'Home shirt', style_key: 'home-shirt-2526', kit_slot: 'shirt', collection_note: 'Collect from the Riverside Arena front desk, Monday to Friday after 16:00.', replace_after_months: 12 });
  const shorts = await ent({ name: 'Training shorts', style_key: 'training-shorts', kit_slot: 'shorts', mode: 'charged', price_minor: 65000, replace_after_months: 12 });
  const bag = await ent({ name: 'Training bag', style_key: 'training-bag', kit_slot: 'bag', mode: 'deposit', deposit_minor: 150000, return_days: 180, size_required: false });
  await ent({ name: 'Goalkeeper gloves', style_key: 'keeper-gloves', kit_slot: 'keeper_kit', mode: 'deposit', deposit_minor: 120000, return_days: 90 });
  const sup = await call('POST', `/organisations/${org.id}/academy/suppliers`, { token: owner.token, body: { kind: 'sporting_goods', name: 'Kit House Sports', all_venues: true } });
  const sizes = ['YM', 'YM', 'YS', 'YL'];
  const issues = {};
  for (const [i, st] of students.entries()) {
    if (sizes[i]) for (const slot of ['shirt', 'shorts']) await call('POST', `/organisations/${org.id}/academy/kit/sizes`, { token: owner.token, body: { athlete_id: st.user.id, slot, size_label: sizes[i] } });
  }
  const issue = (st, e, extra = {}) => call('POST', `/organisations/${org.id}/academy/kit/issues`, { token: owner.token, body: { enrolment_id: st.enrolment_id, venue_id: venue.id, entitlement_id: e.id, client_ref: `fx-${st.user.id}-${e.id}`.slice(0, 80), ...extra } });
  if (students[0] && home) issues.home0 = await issue(students[0], home);
  if (students[0] && bag) issues.bag0 = await issue(students[0], bag);
  if (students[1] && home) issues.home1 = await issue(students[1], home);
  if (students[1] && shorts) issues.shorts1 = await issue(students[1], shorts);
  if (students[2] && bag) {
    issues.bag2 = await issue(students[2], bag);
    if (issues.bag2) await call('POST', `/organisations/${org.id}/academy/kit/issues/${issues.bag2.id}/report`, { token: owner.token, body: { kind: 'lost', note: 'Left on the team coach after the away fixture' } });
  }
  if (sup && shirts.YL) await call('POST', `/organisations/${org.id}/academy/kit/orders`, { token: owner.token, body: { academy_supplier_id: sup.id, lines: [{ item_id: shirts.YL.id, quantity: 6, unit_cost_cents: 90000 }], expected_on: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10), note: 'Season top-up' } });
  log('kit fixture ready');
  return { issues, entitlements: { home, shorts, bag } };
}
