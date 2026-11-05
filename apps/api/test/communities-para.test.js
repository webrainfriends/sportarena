// PS-25 community para/adaptive extensions
// Covers: para_sports filter, adaptive flag, new report categories
import { expect, test, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db.js';
import { createTestUser, dropTestData } from './helpers.js';

let owner, member, adminClient;

beforeAll(async () => {
  adminClient = await pool.connect();
  owner = await createTestUser(adminClient, { handle: 'comm_para_owner' });
  member = await createTestUser(adminClient, { handle: 'comm_para_member' });
});

afterAll(async () => {
  await dropTestData(adminClient, [owner, member]);
  await adminClient.release();
});

test('creates community with adaptive=true and para_sports', async () => {
  const res = await owner.post('/communities', {
    name: 'Wheelchair Basketball NSW',
    slug: 'wheelchair-basketball-nsw',
    visibility: 'public',
    join_mode: 'open',
    audience: 'adults',
    adaptive: true,
    para_sports: ['wheelchair-basketball', 'para-athletics'],
  });
  expect(res.status).toBe(201);
});

test('list_communities adaptive filter returns adaptive communities', async () => {
  const res = await member.get('/communities', { adaptive: true });
  expect(res.status).toBe(200);
  const all = res.body.items;
  expect(all.every((c) => c.adaptive === true)).toBe(true);
  expect(all.some((c) => c.slug === 'wheelchair-basketball-nsw')).toBe(true);
});

test('list_communities para_sport filter returns matching communities', async () => {
  const res = await member.get('/communities', { para_sport: 'wheelchair-basketball' });
  expect(res.status).toBe(200);
  expect(res.body.items.some((c) => c.slug === 'wheelchair-basketball-nsw')).toBe(true);
});

test('community card includes para_sports and adaptive fields', async () => {
  const res = await member.get('/communities/wheelchair-basketball-nsw');
  expect(res.status).toBe(200);
  expect(res.body.adaptive).toBe(true);
  expect(res.body.para_sports).toContain('wheelchair-basketball');
});

test('can file report with disability_abuse reason', async () => {
  // First join the community
  await member.post('/communities/wheelchair-basketball-nsw/join', {});
  // Create a post
  const postRes = await owner.post('/communities/wheelchair-basketball-nsw/posts', { body: 'Welcome to the community!' });
  expect(postRes.status).toBe(201);
  // Report with new reason
  const reportRes = await member.post('/social/reports', {
    target_type: 'community_post',
    target_id: postRes.body.id,
    reason: 'disability_abuse',
    note: 'Test report for disability abuse reason',
  });
  expect(reportRes.status).toBe(201);
  expect(reportRes.body.status).toBe('open');
});

test('can file report with unwanted_contact reason', async () => {
  const postRes = await owner.post('/communities/wheelchair-basketball-nsw/posts', { body: 'Second post' });
  const reportRes = await member.post('/social/reports', {
    target_type: 'community_post',
    target_id: postRes.body.id,
    reason: 'unwanted_contact',
  });
  expect(reportRes.status).toBe(201);
});

test('can file report with scam reason', async () => {
  const postRes = await owner.post('/communities/wheelchair-basketball-nsw/posts', { body: 'Third post' });
  const reportRes = await member.post('/social/reports', {
    target_type: 'community_post',
    target_id: postRes.body.id,
    reason: 'scam',
  });
  expect(reportRes.status).toBe(201);
});
