// Tests for coach-crm.js (issue #517)
import { expect, test, beforeEach, afterEach } from '@jest/globals';
import { createTestCoach, createTestAthlete, createTestApp, cleanup } from './helpers.js';

let app, coach, athlete, anotherCoach;
beforeEach(async () => {
  app = await createTestApp();
  coach = await createTestCoach(app);
  athlete = await createTestAthlete(app);
  anotherCoach = await createTestCoach(app);
});
afterEach(() => cleanup(app));

// ── add_coach_crm_lead ─────────────────────────────────────────────────────────
test('add_coach_crm_lead with athlete_id reuses existing user', async () => {
  const res = await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  expect(res.status).toBe(201);
  expect(res.body.stage).toBe('new_lead');
  const users = await app.db.query('SELECT count(*) FROM users WHERE id=$1', [athlete.id]);
  expect(Number(users.rows[0].count)).toBe(1);
});

test('add_coach_crm_lead off-platform encrypts name at rest', async () => {
  const res = await app.post('/api/v1/coach/crm/leads', coach, { athlete_name: 'Rafael Nadal', source_kind: 'manual_entry' });
  expect(res.status).toBe(201);
  const row = await app.db.query('SELECT athlete_name_enc, athlete_id FROM coach_crm_leads WHERE id=$1', [res.body.id]);
  expect(row.rows[0].athlete_name_enc).not.toBeNull();
  expect(row.rows[0].athlete_id).toBeNull();
  expect(row.rows[0].athlete_name_enc).not.toBe('Rafael Nadal');
});

test('add_coach_crm_lead requires athlete_id or athlete_name', async () => {
  const res = await app.post('/api/v1/coach/crm/leads', coach, { source_kind: 'manual_entry' });
  expect(res.status).toBe(400);
});

// ── move_coach_crm_lead ────────────────────────────────────────────────────────
test('move_coach_crm_lead advances stage and writes event', async () => {
  const lead = await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  const move = await app.patch(`/api/v1/coach/crm/leads/${lead.body.id}/stage`, coach, { to_stage: 'contacted', row_version: 1 });
  expect(move.status).toBe(200);
  expect(move.body.stage).toBe('contacted');
  expect(move.body.row_version).toBe(2);
  const events = await app.db.query('SELECT action, to_stage FROM coach_crm_lead_events WHERE lead_id=$1', [lead.body.id]);
  expect(events.rows.some((e) => e.action === 'stage_moved' && e.to_stage === 'contacted')).toBe(true);
});

test('move_coach_crm_lead stale row_version returns 409', async () => {
  const lead = await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  const res = await app.patch(`/api/v1/coach/crm/leads/${lead.body.id}/stage`, coach, { to_stage: 'contacted', row_version: 999 });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('stale_version');
});

test('move_coach_crm_lead cannot move from terminal stage', async () => {
  const lead = await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  await app.patch(`/api/v1/coach/crm/leads/${lead.body.id}/stage`, coach, { to_stage: 'won', row_version: 1 });
  const res = await app.patch(`/api/v1/coach/crm/leads/${lead.body.id}/stage`, coach, { to_stage: 'contacted', row_version: 2 });
  expect(res.status).toBe(400);
});

// ── log_coach_crm_comm ─────────────────────────────────────────────────────────
test('log_coach_crm_comm duplicate idempotency_key returns existing', async () => {
  const lead = await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  const key = 'idem-key-12345678';
  const r1 = await app.post(`/api/v1/coach/crm/leads/${lead.body.id}/communications`, coach, { kind: 'note', summary: 'First note', idempotency_key: key });
  const r2 = await app.post(`/api/v1/coach/crm/leads/${lead.body.id}/communications`, coach, { kind: 'note', summary: 'Different note', idempotency_key: key });
  expect(r1.body.id).toBe(r2.body.id);
  expect(r2.body.duplicate).toBe(true);
  const count = await app.db.query('SELECT count(*) FROM coach_crm_lead_communications WHERE lead_id=$1', [lead.body.id]);
  expect(Number(count.rows[0].count)).toBe(1);
});

// ── lifecycle dashboard ────────────────────────────────────────────────────────
test('get_coach_lifecycle_dashboard returns summary', async () => {
  const res = await app.get('/api/v1/coach/crm/dashboard', coach, {});
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('summary');
  expect(res.body.summary).toHaveProperty('active_count');
});

// ── retention analytics ────────────────────────────────────────────────────────
test('get_coach_retention_analytics returns funnel metrics', async () => {
  const res = await app.get('/api/v1/coach/crm/analytics', coach, {});
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('funnel');
  expect(res.body).toHaveProperty('definitions');
  expect(res.body).not.toHaveProperty('predicted_clv');
  expect(res.body).not.toHaveProperty('churn_risk');
});

// ── export CSV ─────────────────────────────────────────────────────────────────
test('export_coach_crm_leads_csv audit-logs the export', async () => {
  await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  const res = await app.get('/api/v1/coach/crm/leads/export.csv', coach, {});
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('csv');
  const auditRow = await app.db.query("SELECT id FROM audit_log WHERE user_id=$1 AND action='coach_crm_leads.export'", [coach.id]);
  expect(auditRow.rows.length).toBeGreaterThan(0);
});

// ── access control ─────────────────────────────────────────────────────────────
test('another coach cannot read a lead', async () => {
  const lead = await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  const res = await app.get(`/api/v1/coach/crm/leads/${lead.body.id}`, anotherCoach, {});
  expect([403, 404]).toContain(res.status);
});

test('observer staff sees lead summary but not loss_note', async () => {
  const lead = await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  await app.patch(`/api/v1/coach/crm/leads/${lead.body.id}/stage`, coach, { to_stage: 'lost', row_version: 1 });
  await app.patch(`/api/v1/coach/crm/leads/${lead.body.id}`, coach, { loss_note: 'Private note', row_version: 2 });
  const observer = await createTestCoach(app);
  await app.post(`/api/v1/coach/crm/leads/${lead.body.id}/staff`, coach, { staff_id: observer.id, role: 'observer' });
  const res = await app.get(`/api/v1/coach/crm/leads/${lead.body.id}`, observer, {});
  expect(res.status).toBe(200);
  expect(res.body.loss_note).toBeNull();
});

// ── archive ────────────────────────────────────────────────────────────────────
test('archive_coach_crm_lead disappears from list but history preserved', async () => {
  const lead = await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry' });
  await app.post(`/api/v1/coach/crm/leads/${lead.body.id}/archive`, coach, {});
  const list = await app.get('/api/v1/coach/crm/leads', coach, {});
  expect(list.body.leads.find((l) => l.id === lead.body.id)).toBeUndefined();
  const events = await app.db.query('SELECT id FROM coach_crm_lead_events WHERE lead_id=$1', [lead.body.id]);
  expect(events.rows.length).toBeGreaterThan(0);
});

// ── campaigns ──────────────────────────────────────────────────────────────────
test('send_coach_crm_campaign with marketing_consent=false athlete is not sent', async () => {
  await app.post('/api/v1/coach/crm/leads', coach, { athlete_id: athlete.id, source_kind: 'manual_entry', marketing_consent: false });
  const cam = await app.post('/api/v1/coach/crm/campaigns', coach, { name: 'Test campaign', kind: 'general', use_case_key: 'coach_announcement', audience_filter: { marketing_consent_only: true } });
  const send = await app.post(`/api/v1/coach/crm/campaigns/${cam.body.id}/send`, coach, { row_version: 1 });
  expect(send.status).toBe(200);
  expect(send.body.recipient_count).toBe(0);
});
