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

test('hidden and withdrawn reviews excluded from public aggregate', async () => {
  const subjectId = await signup('agg_subject@test.local');
  const a1 = await signup('agg_a1@test.local');
  const a2 = await signup('agg_a2@test.local');
  const a3 = await signup('agg_a3@test.local');

  await query(
    `INSERT INTO testimonials (author_id, subject_type, subject_id, rating, body, context_type, context_id, verification, visibility, status)
     VALUES ($1,'user',$2,5,'Great','hire',NULL,'legacy','public','published'),
            ($3,'user',$2,1,'Bad','hire',NULL,'legacy','public','hidden'),
            ($4,'user',$2,3,'Ok','hire',NULL,'legacy','public','withdrawn')`,
    [a1, subjectId, a2, subjectId, a3, subjectId]
  );

  const [agg] = await query(
    `SELECT COUNT(*) as n, AVG(rating)::numeric(3,2) as avg
     FROM testimonials
     WHERE subject_type='user' AND subject_id=$1 AND status='published' AND visibility='public'`,
    [subjectId]
  );
  assert.equal(Number(agg.n), 1);
  assert.equal(Number(agg.avg), 5);
});

test('private feedback not in public aggregate', async () => {
  const subjectId = await signup('priv_subject@test.local');
  const a1 = await signup('priv_a1@test.local');
  const a2 = await signup('priv_a2@test.local');

  await query(
    `INSERT INTO testimonials (author_id, subject_type, subject_id, rating, body, context_type, context_id, verification, visibility, status)
     VALUES ($1,'user',$2,5,'Public','hire',NULL,'legacy','public','published'),
            ($3,'user',$2,1,'Private','hire',NULL,'legacy','private','published')`,
    [a1, subjectId, a2, subjectId]
  );

  const [agg] = await query(
    `SELECT COUNT(*) as n FROM testimonials
     WHERE subject_type='user' AND subject_id=$1 AND status='published' AND visibility='public'`,
    [subjectId]
  );
  assert.equal(Number(agg.n), 1);
});

test('by_role breakdown groups author_role correctly', async () => {
  const subjectId = await signup('role_subject@test.local');
  const a1 = await signup('role_a1@test.local');
  const a2 = await signup('role_a2@test.local');
  const a3 = await signup('role_a3@test.local');

  await query(
    `INSERT INTO testimonials (author_id, subject_type, subject_id, rating, body, context_type, context_id, verification, visibility, status, author_role)
     VALUES ($1,'user',$2,5,'As athlete','hire',NULL,'legacy','public','published','athlete'),
            ($3,'user',$2,4,'As guardian','hire',NULL,'legacy','public','published','guardian'),
            ($4,'user',$2,3,'As athlete 2','hire',NULL,'legacy','public','published','athlete')`,
    [a1, subjectId, a2, subjectId, a3, subjectId]
  );

  const rows = await query(
    `SELECT author_role, COUNT(*) as n, AVG(rating)::numeric(3,2) as avg
     FROM testimonials
     WHERE subject_type='user' AND subject_id=$1 AND status='published' AND visibility='public'
     GROUP BY author_role ORDER BY author_role`,
    [subjectId]
  );
  const athlete = rows.find((r) => r.author_role === 'athlete');
  assert.ok(athlete, 'should have athlete group');
  assert.equal(Number(athlete.n), 2);
  assert.equal(Number(athlete.avg), 4);
});

test('coach_reviews bridge: testimonial_id links back', async () => {
  const coachId = await signup('bridge_coach@test.local');
  const clientId = await signup('bridge_client@test.local');
  const [tRow] = await query(
    `INSERT INTO testimonials (author_id, subject_type, subject_id, rating, body, context_type, context_id, verification, visibility)
     VALUES ($1,'user',$2,5,'Coach was great','hire',NULL,'verified_interaction','public') RETURNING id`,
    [clientId, coachId]
  );
  const [cr] = await query(
    `INSERT INTO coach_reviews (coach_id, reviewer_id, session_date, overall_rating, review_text, testimonial_id)
     VALUES ($1, $2, NOW(), 5, 'Coach was great', $3) RETURNING id`,
    [coachId, clientId, tRow.id]
  );
  const [check] = await query(`SELECT testimonial_id FROM coach_reviews WHERE id=$1`, [cr.id]);
  assert.equal(check.testimonial_id, tRow.id);
});
