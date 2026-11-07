// PS-25 Para-athlete peer mentoring — integration tests
// Covers: mentor profile CRUD, FORBIDDEN_TERMS rejection, mentorship lifecycle, consent revocation,
// guardian visibility, blocked party rejection, feedback, session scheduling.
import { expect, test, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db.js';
import { createTestUser, createTestSport, dropTestData } from './helpers.js';

let mentor, mentee, guardian, youngAthlete, blockedUser, sport, adminClient;

beforeAll(async () => {
  adminClient = await pool.connect();
  sport = await createTestSport(adminClient, { slug: 'wheelchair-basketball', name: 'Wheelchair Basketball' });
  mentor = await createTestUser(adminClient, { handle: 'para_mentor_1' });
  mentee = await createTestUser(adminClient, { handle: 'para_mentee_1' });
  guardian = await createTestUser(adminClient, { handle: 'para_guardian_1' });
  youngAthlete = await createTestUser(adminClient, { handle: 'para_young_1', isYouth: true, guardianId: guardian.id });
  blockedUser = await createTestUser(adminClient, { handle: 'para_blocked_1' });
  // Block blockedUser ↔ mentor
  await adminClient.query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)", [mentor.id, blockedUser.id]);
});

afterAll(async () => {
  await dropTestData(adminClient, [mentor, mentee, guardian, youngAthlete, blockedUser]);
  await adminClient.release();
});

// ─────────────────────────────────────────────── mentor profile

test('creates a para mentor profile', async () => {
  const res = await mentor.post('/para/mentors/me', {
    bio: 'Ten years competing in para-athletics across four continents.',
    sports: ['wheelchair-basketball', 'para-athletics'],
    disciplines: ['sprint', 'field-throws'],
    peer_years: 10,
    comm_formats: ['video', 'in_person'],
    availability: 'weekends',
    languages: ['en'],
    accepting: true,
    listed: true,
  });
  expect(res.status).toBe(200);
  expect(res.body.athlete_id).toBe(mentor.id);
});

test('rejects bio with FORBIDDEN_TERMS (diagnosis)', async () => {
  const res = await mentor.post('/para/mentors/me', { bio: 'I have a diagnosis of cerebral palsy.' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/medical|classification/i);
});

test('rejects bio with FORBIDDEN_TERMS (impairment)', async () => {
  const res = await mentor.post('/para/mentors/me', { bio: 'My physical impairment is well managed.' });
  expect(res.status).toBe(400);
});

test('rejects bio with FORBIDDEN_TERMS (condition)', async () => {
  const res = await mentor.post('/para/mentors/me', { bio: 'Managing my condition since 2010.' });
  expect(res.status).toBe(400);
});

test('rejects bio with FORBIDDEN_TERMS (classification)', async () => {
  const res = await mentor.post('/para/mentors/me', { bio: 'My sport classification is T54.' });
  expect(res.status).toBe(400);
});

test('allows clean bio without medical language', async () => {
  const res = await mentor.post('/para/mentors/me', { bio: 'Ten years as a para-athlete, two world championship medals.' });
  expect(res.status).toBe(200);
});

test('lists mentor in directory when listed=true', async () => {
  const res = await mentee.get('/para/mentors');
  expect(res.status).toBe(200);
  expect(res.body.items.some((m) => m.athlete_id === mentor.id)).toBe(true);
});

test('blocked user cannot see mentor profile', async () => {
  const res = await blockedUser.get(`/para/mentors/${mentor.id}`);
  expect(res.status).toBe(404);
});

// ─────────────────────────────────────────────── mentorship lifecycle

test('mentee can request mentorship', async () => {
  const res = await mentee.post('/para/mentorships', {
    mentor_id: mentor.id,
    sport_id: sport.id,
    goal: 'I want to improve my race start and corner technique.',
  });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('requested');
});

test('duplicate request is rejected', async () => {
  const res = await mentee.post('/para/mentorships', { mentor_id: mentor.id });
  expect(res.status).toBe(409);
});

test('blocked user cannot request mentorship', async () => {
  const res = await blockedUser.post('/para/mentorships', { mentor_id: mentor.id });
  expect(res.status).toBe(404);
});

test('mentor can list incoming requests', async () => {
  const res = await mentor.get('/para/mentorships', { role: 'mentor', status: 'requested' });
  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThan(0);
});

test('mentor accepts mentorship → status becomes active', async () => {
  const listRes = await mentor.get('/para/mentorships', { role: 'mentor', status: 'requested' });
  const item = listRes.body.items[0];
  const res = await mentor.post(`/para/mentorships/${item.id}/respond`, { response: 'accept' });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('active');
});

test('mentee can schedule a session in an active mentorship', async () => {
  const listRes = await mentee.get('/para/mentorships', { role: 'mentee', status: 'active' });
  const item = listRes.body.items[0];
  const res = await mentee.post(`/para/mentorships/${item.id}/sessions`, {
    title: 'Race start drill review',
    format: 'video',
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
  });
  expect(res.status).toBe(201);
  expect(res.body.format).toBe('video');
});

test('mentee can submit feedback after active', async () => {
  const listRes = await mentee.get('/para/mentorships', { role: 'mentee', status: 'active' });
  const item = listRes.body.items[0];
  const res = await mentee.post(`/para/mentorships/${item.id}/feedback`, { rating: 5, body: 'Excellent session, very motivating.' });
  expect(res.status).toBe(201);
});

test('goal is NOT returned to mentor (only mentee sees it)', async () => {
  const listRes = await mentor.get('/para/mentorships', { role: 'mentor', status: 'active' });
  const item = listRes.body.items[0];
  expect(item.goal).toBeUndefined();
});

test('either party can end mentorship', async () => {
  const listRes = await mentee.get('/para/mentorships', { role: 'mentee', status: 'active' });
  const item = listRes.body.items[0];
  const res = await mentee.post(`/para/mentorships/${item.id}/end`, { outcome: 'completed', reason: 'Goals achieved.' });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('completed');
});

// ─────────────────────────────────────────────── youth consent

test('youth athlete requires guardian consent to request mentoring', async () => {
  // No consent record → should fail with guardian_consent_required
  const res = await youngAthlete.post('/para/mentorships', { mentor_id: mentor.id });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('guardian_consent_required');
});
