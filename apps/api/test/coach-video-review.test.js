// Tests for coach-video-review.js (issue #517)
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

test('complete_video_review stores feedback encrypted at rest', async () => {
  const obs = await app.db.query(
    "INSERT INTO coaching_observations(coach_id, athlete_id, type, visibility, notes) VALUES($1,$2,'note','private','test') RETURNING id",
    [coach.id, athlete.id]);
  const obsId = obs.rows[0].id;
  const req = await app.post('/api/v1/coach/video-review', coach, { athlete_id: athlete.id, observation_id: obsId, title: 'Review my serve', brief: 'Focus on the follow-through' });
  expect(req.status).toBe(201);
  await app.db.query("INSERT INTO coaching_evidence(observation_id, kind, content_type, size_bytes, uploaded_by) VALUES($1,'video','video/mp4',1024,$2)", [obsId, athlete.id]);
  await app.patch(`/api/v1/coach/video-review/${req.body.id}/submit`, athlete, { row_version: 1 });
  await app.patch(`/api/v1/coach/video-review/${req.body.id}/start-review`, coach, { row_version: 2 });
  const complete = await app.patch(`/api/v1/coach/video-review/${req.body.id}/complete`, coach, {
    feedback: 'Great follow-through improvement!',
    timestamps: [{ t_secs: 12.5, label: 'Key moment', action_text: 'Notice the wrist rotation here' }],
    assignments: [],
    row_version: 3,
  });
  expect(complete.status).toBe(200);
  const row = await app.db.query('SELECT feedback_enc FROM coach_video_review_requests WHERE id=$1', [req.body.id]);
  expect(row.rows[0].feedback_enc).not.toBeNull();
  expect(row.rows[0].feedback_enc).not.toContain('Great follow-through');
});

test('athlete cannot read feedback before review_complete', async () => {
  const obs = await app.db.query(
    "INSERT INTO coaching_observations(coach_id, athlete_id, type, visibility, notes) VALUES($1,$2,'note','private','test') RETURNING id",
    [coach.id, athlete.id]);
  const req = await app.post('/api/v1/coach/video-review', coach, { athlete_id: athlete.id, observation_id: obs.rows[0].id, title: 'Review', brief: 'Focus' });
  const mine = await app.get('/api/v1/me/video-review', athlete, {});
  expect(mine.status).toBe(200);
  const review = mine.body.find((r) => r.id === req.body.id);
  expect(review?.feedback).toBeNull();
});

test('submit_video_for_review without evidence returns 400', async () => {
  const obs = await app.db.query(
    "INSERT INTO coaching_observations(coach_id, athlete_id, type, visibility, notes) VALUES($1,$2,'note','private','test') RETURNING id",
    [coach.id, athlete.id]);
  const req = await app.post('/api/v1/coach/video-review', coach, { athlete_id: athlete.id, observation_id: obs.rows[0].id, title: 'Review', brief: 'Focus' });
  const sub = await app.patch(`/api/v1/coach/video-review/${req.body.id}/submit`, athlete, { row_version: 1 });
  expect(sub.status).toBe(400);
});

test('coach cannot read another coaches review', async () => {
  const obs = await app.db.query(
    "INSERT INTO coaching_observations(coach_id, athlete_id, type, visibility, notes) VALUES($1,$2,'note','private','test') RETURNING id",
    [coach.id, athlete.id]);
  const req = await app.post('/api/v1/coach/video-review', coach, { athlete_id: athlete.id, observation_id: obs.rows[0].id, title: 'Review', brief: 'Focus' });
  const res = await app.get(`/api/v1/coach/video-review/${req.body.id}`, anotherCoach, {});
  expect([403, 404]).toContain(res.status);
});

test('acknowledge_video_review by non-athlete returns 404', async () => {
  const obs = await app.db.query(
    "INSERT INTO coaching_observations(coach_id, athlete_id, type, visibility, notes) VALUES($1,$2,'note','private','test') RETURNING id",
    [coach.id, athlete.id]);
  const req = await app.post('/api/v1/coach/video-review', coach, { athlete_id: athlete.id, observation_id: obs.rows[0].id, title: 'Review', brief: 'Focus' });
  const res = await app.patch(`/api/v1/coach/video-review/${req.body.id}/acknowledge`, anotherCoach, { row_version: 1 });
  expect([403, 404]).toContain(res.status);
});

test('invalid timestamps_json t_secs rejects', async () => {
  const obs = await app.db.query(
    "INSERT INTO coaching_observations(coach_id, athlete_id, type, visibility, notes) VALUES($1,$2,'note','private','test') RETURNING id",
    [coach.id, athlete.id]);
  const req = await app.post('/api/v1/coach/video-review', coach, { athlete_id: athlete.id, observation_id: obs.rows[0].id, title: 'Review', brief: 'Focus' });
  await app.db.query("INSERT INTO coaching_evidence(observation_id, kind, content_type, size_bytes, uploaded_by) VALUES($1,'video','video/mp4',1024,$2)", [obs.rows[0].id, athlete.id]);
  await app.patch(`/api/v1/coach/video-review/${req.body.id}/submit`, athlete, { row_version: 1 });
  await app.patch(`/api/v1/coach/video-review/${req.body.id}/start-review`, coach, { row_version: 2 });
  const complete = await app.patch(`/api/v1/coach/video-review/${req.body.id}/complete`, coach, {
    feedback: 'Good',
    timestamps: [{ t_secs: 'bad_string', label: 'x', action_text: 'y' }],
    assignments: [],
    row_version: 3,
  });
  expect(complete.status).toBe(400);
});
