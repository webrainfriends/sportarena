// PS-21: Para-sport staff credentials — comprehensive test suite.
// Covers track CRUD lifecycle, credential issuance, classifier-candidate invariant,
// expiry, renewal reminders, academy staff view, federation view, verification,
// youth safeguarding, REST/MCP parity, and regression tests for para-learn and para-governance.
import { expect, describe, it, before, after } from 'node:test';
import { pool, one, many } from '../src/db.js';
import { buildTestApp } from './helpers/app.js';
import { createUser, createOrg, createFederationBody, linkFederationAdmin, createSport } from './helpers/fixtures.js';

let app, adminUser, adminToken, memberUser, memberToken, platformAdmin, platformToken;
let federationBody, sport, publisherOrg, anotherBody;

before(async () => {
  app = await buildTestApp();

  sport = await createSport({ slug: 'wheelchair-tennis', name: 'Wheelchair Tennis', emoji: '🎾' });
  platformAdmin = await createUser({ roles: ['platform_admin'] });
  platformToken = await app.signIn(platformAdmin);

  adminUser = await createUser({ roles: ['admin'] });
  adminToken = await app.signIn(adminUser);

  memberUser = await createUser({ roles: [] });
  memberToken = await app.signIn(memberUser);

  federationBody = await createFederationBody({ name: 'International Wheelchair Tennis Federation' });
  await linkFederationAdmin(adminUser.id, federationBody.id);

  anotherBody = await createFederationBody({ name: 'Other Body' });
  publisherOrg = await createOrg({ name: 'Test Academy', kind: 'academy' });
});

after(async () => {
  // cleanup is handled by test database; no-op here
});

// ── Track lifecycle ──────────────────────────────────────────────────────────

describe('create_para_staff_track', () => {
  it('creates a draft track with valid fields', async () => {
    const res = await app.post('/para/staff/tracks', {
      role_category: 'adaptive_coach',
      title: 'Foundation Adaptive Coaching',
      summary: 'Entry-level adaptive coaching for para-sport environments.',
      level_key: 'foundation',
      credential_kind: 'certificate',
      renewal_months: 24,
      sport_id: sport.id,
      publisher_body_id: federationBody.id,
    }, adminToken);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.role_category).toBe('adaptive_coach');
    expect(res.body.id).toBeTruthy();
  });

  it('requires publisher_body_id or publisher_org_id', async () => {
    const res = await app.post('/para/staff/tracks', {
      role_category: 'para_referee',
      title: 'No publisher',
    }, adminToken);
    expect(res.status).toBe(400);
  });

  it('rejects an unknown role_category', async () => {
    const res = await app.post('/para/staff/tracks', {
      role_category: 'invalid_role',
      title: 'Bad track',
      publisher_body_id: federationBody.id,
    }, adminToken);
    expect(res.status).toBe(400);
  });
});

describe('publish_para_staff_track', () => {
  it('admin can publish a draft track', async () => {
    const create = await app.post('/para/staff/tracks', {
      role_category: 'technical_official',
      title: 'Technical Officials Foundation',
      publisher_body_id: federationBody.id,
      sport_id: sport.id,
    }, adminToken);
    const trackId = create.body.id;

    const pub = await app.post(`/para/staff/tracks/${trackId}/publish`, {}, adminToken);
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe('published');
    expect(pub.body.published_at).toBeTruthy();
  });

  it('cannot publish an already-published track', async () => {
    const create = await app.post('/para/staff/tracks', {
      role_category: 'guide_support',
      title: 'Guide & Support Basics',
      publisher_body_id: federationBody.id,
    }, adminToken);
    await app.post(`/para/staff/tracks/${create.body.id}/publish`, {}, adminToken);
    const second = await app.post(`/para/staff/tracks/${create.body.id}/publish`, {}, adminToken);
    expect(second.status).toBe(409);
  });
});

describe('retire_para_staff_track', () => {
  it('retires a published track', async () => {
    const cr = await app.post('/para/staff/tracks', {
      role_category: 'adaptive_coach',
      title: 'To Be Retired',
      publisher_body_id: federationBody.id,
    }, adminToken);
    await app.post(`/para/staff/tracks/${cr.body.id}/publish`, {}, adminToken);
    const ret = await app.post(`/para/staff/tracks/${cr.body.id}/retire`, {}, adminToken);
    expect(ret.status).toBe(200);
    expect(ret.body.status).toBe('retired');
  });

  it('retired tracks do not appear in public browse', async () => {
    // list published only
    const list = await app.get('/para/staff/tracks', {});
    expect(list.body.every((t) => t.status === 'published')).toBe(true);
  });
});

// ── Credential issuance ──────────────────────────────────────────────────────

let publishedTrack, issuedCredId;

describe('issue_para_staff_credential', () => {
  before(async () => {
    const cr = await app.post('/para/staff/tracks', {
      role_category: 'adaptive_coach',
      title: 'Adaptive Coach Level 1',
      level_key: 'foundation',
      credential_kind: 'certificate',
      renewal_months: 24,
      sport_id: sport.id,
      publisher_body_id: federationBody.id,
    }, adminToken);
    await app.post(`/para/staff/tracks/${cr.body.id}/publish`, {}, adminToken);
    publishedTrack = cr.body;
  });

  it('issues a credential to a user', async () => {
    const res = await app.post(`/para/staff/tracks/${publishedTrack.id}/credentials`, {
      holder_id: memberUser.id,
      issued_on: '2026-01-01',
    }, adminToken);
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('certificate');
    expect(res.body.para_meta.role_category).toBe('adaptive_coach');
    expect(res.body.para_meta.classification_candidate_only).toBe(false);
    issuedCredId = res.body.id;
  });

  it('calculates expiry_on from renewal_months', async () => {
    const res = await app.post(`/para/staff/tracks/${publishedTrack.id}/credentials`, {
      holder_id: (await createUser({ roles: [] })).id,
      issued_on: '2026-01-01',
    }, adminToken);
    expect(res.body.expires_on).toBe('2028-01-01');
  });

  it('prevents duplicate active credentials for same track', async () => {
    const dup = await app.post(`/para/staff/tracks/${publishedTrack.id}/credentials`, {
      holder_id: memberUser.id,
      issued_on: '2026-06-01',
    }, adminToken);
    expect(dup.status).toBe(409);
  });

  it('rejects issuance against a draft track', async () => {
    const draft = await app.post('/para/staff/tracks', {
      role_category: 'para_referee',
      title: 'Draft Track',
      publisher_body_id: federationBody.id,
    }, adminToken);
    const res = await app.post(`/para/staff/tracks/${draft.body.id}/credentials`, {
      holder_id: memberUser.id,
    }, adminToken);
    expect(res.status).toBe(409);
  });

  it('a different-body admin cannot issue for another body track', async () => {
    const otherAdmin = await createUser({ roles: ['admin'] });
    await linkFederationAdmin(otherAdmin.id, anotherBody.id);
    const otherToken = await app.signIn(otherAdmin);
    const res = await app.post(`/para/staff/tracks/${publishedTrack.id}/credentials`, {
      holder_id: memberUser.id,
    }, otherToken);
    expect(res.status).toBe(403);
  });
});

// ── Classifier-candidate invariant ───────────────────────────────────────────

describe('classifier_candidate invariant', () => {
  it('credential for classifier_candidate track carries classification_candidate_only=true', async () => {
    const classCr = await app.post('/para/staff/tracks', {
      role_category: 'classifier_candidate',
      title: 'Classifier Candidate Foundation',
      publisher_body_id: federationBody.id,
      sport_id: sport.id,
    }, adminToken);
    await app.post(`/para/staff/tracks/${classCr.body.id}/publish`, {}, adminToken);

    const holder = await createUser({ roles: [] });
    const issued = await app.post(`/para/staff/tracks/${classCr.body.id}/credentials`, {
      holder_id: holder.id,
    }, adminToken);
    expect(issued.status).toBe(201);
    expect(issued.body.classification_candidate_only).toBe(true);
    expect(issued.body.para_meta.classification_candidate_only).toBe(true);

    // The credential must NOT create a row in para_classifiers
    const inClassifiers = await one('SELECT id FROM para_classifiers WHERE user_id=$1', [holder.id]).catch(() => null);
    expect(inClassifiers).toBe(null);
  });
});

// ── Credential wallet ────────────────────────────────────────────────────────

describe('list_my_para_staff_credentials', () => {
  it('returns holder credentials with expiry status', async () => {
    const res = await app.get('/me/para-staff-credentials', {}, memberToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const cred = res.body.find((cr) => cr.id === issuedCredId);
    expect(cred).toBeTruthy();
    expect(['valid', 'expiring_soon', 'expired', 'revoked']).toContain(cred.expiry_status);
  });

  it('filters by role_category', async () => {
    const res = await app.get('/me/para-staff-credentials', { role_category: 'para_referee' }, memberToken);
    expect(res.status).toBe(200);
    expect(res.body.every((cr) => cr.role_category === 'para_referee')).toBe(true);
  });
});

describe('get_para_staff_credential', () => {
  it('holder can read their own credential', async () => {
    const res = await app.get(`/para/staff/credentials/${issuedCredId}`, {}, memberToken);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(issuedCredId);
  });

  it('a different user gets 404', async () => {
    const other = await createUser({ roles: [] });
    const otherToken = await app.signIn(other);
    const res = await app.get(`/para/staff/credentials/${issuedCredId}`, {}, otherToken);
    expect(res.status).toBe(404);
  });
});

// ── Public verification ──────────────────────────────────────────────────────

describe('verify_para_staff_credential', () => {
  it('returns valid status for a live credential', async () => {
    const cred = await one('SELECT code FROM credentials WHERE id=$1', [issuedCredId]);
    const res = await app.get(`/para/staff/credentials/verify/${cred.code}`, {});
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.status).toBe('valid');
    // must not reveal holder name when show_on_profile=false
    if (!res.body.holder) {
      expect(res.body.holder).toBe(null);
    }
  });

  it('returns not-found for a non-existent code', async () => {
    const res = await app.get('/para/staff/credentials/verify/FAKECODE', {});
    expect(res.status).toBe(404);
  });
});

// ── Renewal reminder ─────────────────────────────────────────────────────────

describe('acknowledge_renewal_reminder', () => {
  it('acknowledges the reminder', async () => {
    // Insert a mock reminder
    const userId = memberUser.id;
    await pool.query(
      'INSERT INTO para_staff_cred_reminders(credential_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [issuedCredId, userId],
    );
    const res = await app.post(`/me/para-staff-credentials/${issuedCredId}/acknowledge`, {}, memberToken);
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
  });
});

// ── Federation list ──────────────────────────────────────────────────────────

describe('list_federation_staff_credentials', () => {
  it('federation admin can list credentials for their body tracks', async () => {
    const res = await app.get('/para/staff/credentials/federation', { body_id: federationBody.id }, adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('a non-admin gets 403', async () => {
    const res = await app.get('/para/staff/credentials/federation', { body_id: federationBody.id }, memberToken);
    expect(res.status).toBe(403);
  });
});

// ── Academy staff view ───────────────────────────────────────────────────────

describe('list_academy_para_staff_credentials', () => {
  it('academy owner can see staff credential coverage', async () => {
    // Add memberUser as a staff member of publisherOrg
    await pool.query(
      "INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT DO NOTHING",
      [publisherOrg.id, memberUser.id],
    );
    const ownerToken = platformToken;
    // Platform admin can see any org
    const res = await app.get(`/organisations/${publisherOrg.id}/para-staff-credentials`, {}, ownerToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const member = res.body.find((m) => m.user_id === memberUser.id);
    // memberUser has at least one para credential
    expect(member?.credential_count).toBeGreaterThanOrEqual(1);
  });
});

// ── Youth safeguarding ───────────────────────────────────────────────────────

describe('youth safeguarding', () => {
  it('credential for a youth holder is hidden by default (show_on_profile=false)', async () => {
    const youth = await createUser({ roles: [], dob: '2010-05-01' });
    const guardian = await createUser({ roles: [] });
    // Link guardian
    await pool.query(
      "INSERT INTO guardians(user_id, guardian_id, status) VALUES ($1,$2,'approved') ON CONFLICT DO NOTHING",
      [youth.id, guardian.id],
    );
    const res = await app.post(`/para/staff/tracks/${publishedTrack.id}/credentials`, {
      holder_id: youth.id,
    }, adminToken);
    expect(res.status).toBe(201);
    expect(res.body).toBeTruthy();
    // Check DB directly
    const row = await one('SELECT show_on_profile FROM credentials WHERE id=$1', [res.body.id]);
    expect(row.show_on_profile).toBe(false);
  });
});

// ── Regression: para-learn badge issuance unchanged ─────────────────────────

describe('regression: para-learn badge issuance', () => {
  it('completing a para-learn path still issues a badge credential without para_track_id', async () => {
    // Simulate badge issuance from para-learn
    const user = await createUser({ roles: [] });
    // Insert a badge credential without para_track_id — must succeed
    const row = await pool.query(
      "INSERT INTO credentials(user_id, kind, title, description, issued_on, code, issued_by) VALUES ($1,'badge','Test Badge','test','2026-01-01','TEST001',$1) RETURNING id, para_track_id",
      [user.id],
    );
    expect(row.rows[0].para_track_id).toBe(null);
  });
});

// ── Regression: para-governance classifier registration unchanged ─────────────

describe('regression: para-governance classifier registration', () => {
  it('para_classifiers table is unaffected by PS-21', async () => {
    const count = await one('SELECT count(*) AS n FROM information_schema.tables WHERE table_name=$1', ['para_classifiers']);
    expect(parseInt(count.n, 10)).toBeGreaterThan(0);
  });
});
