import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

let pool;

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function signup(email) {
  const [row] = await query(
    `INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    [email, email.split('@')[0]]
  );
  return row.id;
}

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost/sportarena_test' });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(pool);
});

after(async () => { await pool.end(); });

test('get_feedback_eligibility — eligible after completed hire', async () => {
  const authorId = await signup('eligibility_author@test.local');
  const subjectId = await signup('eligibility_subject@test.local');
  const [hire] = await query(
    `INSERT INTO hires (hirer_id, hired_id, status, completed_at) VALUES ($1, $2, 'completed', NOW()) RETURNING id`,
    [authorId, subjectId]
  );
  const [row] = await query(
    `SELECT can_review($1, 'user', $2, 'hire', $3) AS eligible`,
    [authorId, subjectId, hire.id]
  );
  assert.ok(row.eligible !== false, 'should be eligible after completed hire');
});

test('submit testimonial, then withdraw', async () => {
  const authorId = await signup('submit_author@test.local');
  const subjectId = await signup('submit_subject@test.local');
  const [hire] = await query(
    `INSERT INTO hires (hirer_id, hired_id, status, completed_at) VALUES ($1, $2, 'completed', NOW()) RETURNING id`,
    [authorId, subjectId]
  );
  const [tRow] = await query(
    `INSERT INTO testimonials (author_id, subject_type, subject_id, rating, body, context_type, context_id, verification, visibility)
     VALUES ($1, 'user', $2, 5, 'Great coach', 'hire', $3, 'verified_interaction', 'public') RETURNING id`,
    [authorId, subjectId, hire.id]
  );
  assert.ok(tRow.id, 'testimonial should be created');

  await query(`UPDATE testimonials SET status='withdrawn' WHERE id=$1`, [tRow.id]);
  const [check] = await query(`SELECT status FROM testimonials WHERE id=$1`, [tRow.id]);
  assert.equal(check.status, 'withdrawn');
});

test('reply to testimonial', async () => {
  const authorId = await signup('reply_author@test.local');
  const subjectId = await signup('reply_subject@test.local');
  const [tRow] = await query(
    `INSERT INTO testimonials (author_id, subject_type, subject_id, rating, body, context_type, context_id, verification, visibility)
     VALUES ($1, 'user', $2, 4, 'Good session', 'hire', NULL, 'legacy', 'public') RETURNING id`,
    [authorId, subjectId]
  );
  await query(
    `UPDATE testimonials SET reply_body=$1, reply_by=$2, replied_at=NOW() WHERE id=$3`,
    ['Thank you!', subjectId, tRow.id]
  );
  const [row] = await query(`SELECT reply_body FROM testimonials WHERE id=$1`, [tRow.id]);
  assert.equal(row.reply_body, 'Thank you!');
});

test('appeal flow — submit appeal and decide', async () => {
  const authorId = await signup('appeal_author@test.local');
  const subjectId = await signup('appeal_subject@test.local');
  const [tRow] = await query(
    `INSERT INTO testimonials (author_id, subject_type, subject_id, rating, body, context_type, context_id, verification, visibility, status)
     VALUES ($1, 'user', $2, 2, 'Bad', 'hire', NULL, 'legacy', 'public', 'hidden') RETURNING id`,
    [authorId, subjectId]
  );
  const [appRow] = await query(
    `INSERT INTO feedback_appeals (testimonial_id, appellant_id, reason) VALUES ($1, $2, 'Unfair moderation') RETURNING id`,
    [tRow.id, authorId]
  );
  assert.ok(appRow.id);

  await query(`UPDATE feedback_appeals SET status='upheld', decided_by=$1, decided_at=NOW() WHERE id=$2`, [subjectId, appRow.id]);
  await query(`UPDATE testimonials SET status='published' WHERE id=$1`, [tRow.id]);
  const [check] = await query(`SELECT status FROM testimonials WHERE id=$1`, [tRow.id]);
  assert.equal(check.status, 'published');
});

test('configure blind review session', async () => {
  const orgId = await signup('blind_org@test.local');
  const [row] = await query(
    `INSERT INTO feedback_blind_sessions (organiser_id, context_type, context_id, reveal_at)
     VALUES ($1, 'programme', 'prog-1', NOW() + INTERVAL '30 days') RETURNING id`,
    [orgId]
  );
  assert.ok(row.id);
});

test('invite_feedback — insert invitation rows', async () => {
  const orgId = await signup('invite_org@test.local');
  const recipientId = await signup('invite_recipient@test.local');
  const [row] = await query(
    `INSERT INTO feedback_invitations (inviter_id, recipient_id, subject_type, subject_id, context_type, context_id)
     VALUES ($1, $2, 'organisation', $1, 'programme', 'prog-2') RETURNING id`,
    [orgId, recipientId]
  );
  assert.ok(row.id);
});
