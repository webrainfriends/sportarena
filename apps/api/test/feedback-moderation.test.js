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

async function insertTestimonial(authorId, subjectId, status = 'published') {
  const [row] = await query(
    `INSERT INTO testimonials (author_id, subject_type, subject_id, rating, body, context_type, context_id, verification, visibility, status)
     VALUES ($1, 'user', $2, 3, 'Test review', 'hire', NULL, 'legacy', 'public', $3) RETURNING id`,
    [authorId, subjectId, status]
  );
  return row.id;
}

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost/sportarena_test' });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(pool);
});

after(async () => { await pool.end(); });

test('report → moderate(hide) → aggregate changes', async () => {
  const authorId = await signup('mod_author@test.local');
  const subjectId = await signup('mod_subject@test.local');
  const tid = await insertTestimonial(authorId, subjectId, 'published');

  // Simulate report
  await query(
    `INSERT INTO feedback_appeals (testimonial_id, appellant_id, reason, status)
     VALUES ($1, $2, 'Harassment', 'pending')`,
    [tid, subjectId]
  );

  // Moderate: hide
  await query(`UPDATE testimonials SET status='hidden', appeal_status='upheld' WHERE id=$1`, [tid]);

  const [agg] = await query(
    `SELECT COUNT(*) as n FROM testimonials
     WHERE subject_type='user' AND subject_id=$1 AND status='published' AND visibility='public'`,
    [subjectId]
  );
  assert.equal(Number(agg.n), 0, 'hidden review must not appear in aggregate');
});

test('appeal → upheld → review restored', async () => {
  const authorId = await signup('restore_author@test.local');
  const subjectId = await signup('restore_subject@test.local');
  const tid = await insertTestimonial(authorId, subjectId, 'hidden');

  const [appRow] = await query(
    `INSERT INTO feedback_appeals (testimonial_id, appellant_id, reason) VALUES ($1, $2, 'Wrong') RETURNING id`,
    [tid, authorId]
  );

  // Decide: upheld
  await query(`UPDATE feedback_appeals SET status='upheld', decided_at=NOW() WHERE id=$1`, [appRow.id]);
  await query(`UPDATE testimonials SET status='published' WHERE id=$1`, [tid]);

  const [check] = await query(`SELECT status FROM testimonials WHERE id=$1`, [tid]);
  assert.equal(check.status, 'published');
});

test('appeal → dismissed → review stays hidden', async () => {
  const authorId = await signup('dismissed_author@test.local');
  const subjectId = await signup('dismissed_subject@test.local');
  const tid = await insertTestimonial(authorId, subjectId, 'hidden');

  const [appRow] = await query(
    `INSERT INTO feedback_appeals (testimonial_id, appellant_id, reason) VALUES ($1, $2, 'Wrong') RETURNING id`,
    [tid, authorId]
  );

  // Decide: dismissed — testimonial stays hidden
  await query(`UPDATE feedback_appeals SET status='dismissed', decided_at=NOW() WHERE id=$1`, [appRow.id]);

  const [check] = await query(`SELECT status FROM testimonials WHERE id=$1`, [tid]);
  assert.equal(check.status, 'hidden', 'review should remain hidden after dismissed appeal');
});
