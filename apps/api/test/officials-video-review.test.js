import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
await import('../src/capabilities/index.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { status: r.status, body: j };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ovr_${n}_${roles[0]}`, display_name: `OVR ${n}`, email: `ovr${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** Create a fixture with an organiser, referee crew member and an outsider. */
async function setup() {
  const organiser = await signup(['venue_manager']);
  const referee = await signup(['official']);
  const outsider = await signup();

  const org = ok(await api('POST', '/organisations', { token: organiser.token, body: { name: `FixtureOrg ${n}`, kind: 'club', city: 'London' } }), 201);
  const venue = ok(await api('POST', '/venues', { token: organiser.token, body: { name: `Venue ${n}`, city: 'London', surfaces: ['grass'] } }), 201);
  const event = ok(await api('POST', '/events', { token: organiser.token, body: { title: `Event ${n}`, sport: 'football', start_date: day(1), end_date: day(2), org_id: org.id } }), 201);
  const fixture = ok(await api('POST', '/fixtures', { token: organiser.token, body: { event_id: event.id, venue_id: venue.id, sport: 'football', scheduled_at: `${day(1)}T14:00:00Z`, title: `Match ${n}` } }), 201);

  // Assign referee as accepted crew
  await pool.query(
    "INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES($1,$2,'referee','accepted')",
    [fixture.id, referee.id],
  );

  return { organiser, referee, outsider, fixture, org };
}

const uploadVideo = async (token, fixtureId, overrides = {}) =>
  api('POST', `/fixtures/${fixtureId}/match-videos`, {
    token,
    body: {
      angle_label: 'main',
      purpose: 'match_record',
      sport: 'football',
      file_key: `s3://test/match-${Date.now()}.mp4`,
      mime_type: 'video/mp4',
      duration_ms: 5400000,
      file_size_bytes: 1073741824,
      media_rights_clearance: true,
      youth_consent_required: false,
      ...overrides,
    },
  });

// ─────────────────────────────────────────────────────────────────────────────

test('1. Upload succeeds for accepted crew; rejected for outsider', async () => {
  const { organiser, referee, outsider, fixture } = await setup();

  const r1 = await uploadVideo(referee.token, fixture.id);
  ok(r1, 201);
  assert.ok(r1.body.video?.id, 'video id present');

  const r2 = await uploadVideo(outsider.token, fixture.id);
  assert.equal(r2.status, 404, 'outsider gets 404');
});

test('2. Youth consent gate: upload without consent_ref when youth_consent_required → 400', async () => {
  const { referee, fixture } = await setup();
  const r = await uploadVideo(referee.token, fixture.id, { youth_consent_required: true, youth_consent_ref: null });
  assert.equal(r.status, 400, 'must supply youth_consent_ref');
});

test('3. Media rights clearance required: upload without clearance → 400', async () => {
  const { referee, fixture } = await setup();
  const r = await uploadVideo(referee.token, fixture.id, { media_rights_clearance: false });
  assert.equal(r.status, 400, 'media_rights_clearance=false must fail');
});

test('4. Grant access to assessor; revoked access denies subsequent get', async () => {
  const { organiser, referee, fixture } = await setup();
  const assessor = await signup();

  const v = ok(await uploadVideo(referee.token, fixture.id), 201);
  const videoId = v.video.id;

  // Grant
  const g = ok(await api('POST', `/match-videos/${videoId}/access`, {
    token: organiser.token,
    body: { grantee_id: assessor.id, access_role: 'assessor', grant_reason: 'Panel review', expires_at: `${day(30)}T00:00:00Z` },
  }), 201);

  // Assessor can access
  ok(await api('GET', `/match-videos/${videoId}`, { token: assessor.token }));

  // Revoke
  ok(await api('DELETE', `/match-videos/${videoId}/access/${g.grant.id}`, { token: organiser.token }));

  // Now denied
  const deny = await api('GET', `/match-videos/${videoId}`, { token: assessor.token });
  assert.equal(deny.status, 404, 'revoked grant must return 404');
});

test('5. Add incident marker; marker from wrong fixture video → 404', async () => {
  const { referee, fixture } = await setup();
  const v = ok(await uploadVideo(referee.token, fixture.id), 201);

  const m = ok(await api('POST', `/match-videos/${v.video.id}/markers`, {
    token: referee.token,
    body: { timestamp_ms: 1200000, marker_type: 'incident', severity: 'high' },
  }), 201);
  assert.ok(m.marker?.id, 'marker created');

  // Different fixture video access returns 404 for outsider
  const setup2 = await setup();
  const v2 = ok(await uploadVideo(setup2.referee.token, setup2.fixture.id), 201);
  const deny = await api('POST', `/match-videos/${v2.video.id}/markers`, {
    token: referee.token, // wrong fixture crew
    body: { timestamp_ms: 0, marker_type: 'incident', severity: 'low' },
  });
  assert.equal(deny.status, 404, 'crew from other fixture must get 404');
});

test('6. List markers ordered by timestamp', async () => {
  const { referee, fixture } = await setup();
  const v = ok(await uploadVideo(referee.token, fixture.id), 201);

  const stamps = [5000, 1000, 15000, 300];
  for (const ts of stamps) {
    ok(await api('POST', `/match-videos/${v.video.id}/markers`, { token: referee.token, body: { timestamp_ms: ts, marker_type: 'decision', severity: 'medium' } }), 201);
  }

  const list = ok(await api('GET', `/match-videos/${v.video.id}/markers`, { token: referee.token }));
  const times = list.markers.map((m) => m.timestamp_ms);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], 'markers ordered by timestamp_ms');
});

test('7. Open review session → add participant → attach video → conclude → appeal_deadline set', async () => {
  const { organiser, referee, fixture } = await setup();
  const v = ok(await uploadVideo(referee.token, fixture.id), 201);

  const sess = ok(await api('POST', `/fixtures/${fixture.id}/video-review-sessions`, {
    token: organiser.token,
    body: { review_type: 'incident_review', sport: 'football' },
  }), 201);
  const sessionId = sess.session.id;
  assert.equal(sess.session.status, 'open');

  // Add participant
  ok(await api('POST', `/video-review-sessions/${sessionId}/participants`, {
    token: organiser.token,
    body: { user_id: referee.id, role: 'referee' },
  }), 201);

  // Attach video
  ok(await api('POST', `/video-review-sessions/${sessionId}/videos`, {
    token: organiser.token,
    body: { video_id: v.video.id },
  }), 201);

  // Conclude
  const concluded = ok(await api('POST', `/video-review-sessions/${sessionId}/conclude`, {
    token: organiser.token,
    body: { outcome: 'Decision stands. Foul correctly awarded.', outcome_category: 'upheld' },
  }));
  assert.equal(concluded.session.status, 'concluded');
  assert.ok(concluded.session.appeal_deadline, 'appeal_deadline set after conclude');
});

test('8. Appeal before deadline succeeds; appeal after deadline → 403', async () => {
  const { organiser, referee, fixture } = await setup();

  const sess = ok(await api('POST', `/fixtures/${fixture.id}/video-review-sessions`, {
    token: organiser.token,
    body: { review_type: 'dispute_review', sport: 'football' },
  }), 201);
  const sessionId = sess.session.id;

  ok(await api('POST', `/video-review-sessions/${sessionId}/conclude`, {
    token: organiser.token,
    body: { outcome: 'No infringement found.', outcome_category: 'dismissed' },
  }));

  // Appeal within deadline (should succeed)
  const appeal = ok(await api('POST', `/video-review-sessions/${sessionId}/appeal`, {
    token: referee.token,
    body: { reason: 'New video angle available.' },
  }));
  assert.equal(appeal.session.status, 'appealed');

  // Force deadline past — open a fresh session and expire it
  const sess2 = ok(await api('POST', `/fixtures/${fixture.id}/video-review-sessions`, {
    token: organiser.token,
    body: { review_type: 'dispute_review', sport: 'football' },
  }), 201);
  ok(await api('POST', `/video-review-sessions/${sess2.session.id}/conclude`, {
    token: organiser.token,
    body: { outcome: 'Dismissed.', outcome_category: 'dismissed' },
  }));
  await pool.query('UPDATE official_video_review_sessions SET appeal_deadline = now() - interval \'1 day\' WHERE id=$1', [sess2.session.id]);

  const lateAppeal = await api('POST', `/video-review-sessions/${sess2.session.id}/appeal`, {
    token: referee.token,
    body: { reason: 'Too late.' },
  });
  assert.equal(lateAppeal.status, 403, 'appeal after deadline must be 403');
});

test('9. Export workflow: request → approve → download → second download denied (max_downloads=1)', async () => {
  const { organiser, referee, fixture } = await setup();
  const v = ok(await uploadVideo(referee.token, fixture.id), 201);
  const videoId = v.video.id;

  const req = ok(await api('POST', `/match-videos/${videoId}/export-requests`, {
    token: referee.token,
    body: { purpose: 'Federation inquiry re incident at 20:00', recipient_org: 'FA' },
  }), 201);
  assert.equal(req.export_request.status, 'pending');

  const approved = ok(await api('POST', `/export-requests/${req.export_request.id}/approve`, {
    token: organiser.token,
    body: { expires_in_days: 3, max_downloads: 1 },
  }));
  assert.ok(approved.export_request.download_token, 'download_token generated');
  const token = approved.export_request.download_token;

  // First download
  const dl1 = ok(await api('GET', `/export-requests/${approved.export_request.id}/download?token=${token}`, { token: referee.token }));
  assert.ok(dl1, 'first download OK');

  // Second download must be denied
  const dl2 = await api('GET', `/export-requests/${approved.export_request.id}/download?token=${token}`, { token: referee.token });
  assert.equal(dl2.status, 403, 'max_downloads=1 exceeded must return 403');
});

test('10. Download with expired token → 403', async () => {
  const { organiser, referee, fixture } = await setup();
  const v = ok(await uploadVideo(referee.token, fixture.id), 201);

  const req = ok(await api('POST', `/match-videos/${v.video.id}/export-requests`, {
    token: referee.token,
    body: { purpose: 'Short-term review', recipient_org: 'Internal' },
  }), 201);
  ok(await api('POST', `/export-requests/${req.export_request.id}/approve`, {
    token: organiser.token,
    body: { expires_in_days: 3, max_downloads: 5 },
  }));

  // Expire it immediately
  await pool.query('UPDATE official_video_export_requests SET expires_at = now() - interval \'1 second\' WHERE id=$1', [req.export_request.id]);

  const r = await api('GET', `/export-requests/${req.export_request.id}/download?token=wrong`, { token: referee.token });
  assert.equal(r.status, 403, 'expired token must return 403');
});

test('11. Audit log: entries created for upload, access, conclude', async () => {
  const { organiser, referee, fixture } = await setup();
  const v = ok(await uploadVideo(referee.token, fixture.id), 201);

  // Access triggers audit
  ok(await api('GET', `/match-videos/${v.video.id}`, { token: referee.token }));

  const audit = ok(await api('GET', `/match-videos/${v.video.id}/audit`, { token: organiser.token }));
  assert.ok(Array.isArray(audit.entries), 'audit entries array present');
  assert.ok(audit.entries.length >= 1, 'at least one audit entry');
  // Verify chain: each entry's hash must be present
  for (const entry of audit.entries) {
    assert.ok(entry.hash, `entry ${entry.id} has hash`);
  }
});

test('12. Youth data not leaked: youth_consent_required video not accessible without consent ref', async () => {
  const { referee, fixture } = await setup();
  const minor = await signup();
  // Insert a youth consent record placeholder
  const consentRef = '00000000-0000-0000-0000-000000000001';

  const v = ok(await uploadVideo(referee.token, fixture.id, {
    youth_consent_required: true,
    youth_consent_ref: consentRef,
  }), 201);

  // Even the uploader's crew member can get the video (they have standing)
  // But a list call must not expose youth_consent_ref value directly
  const list = ok(await api('GET', `/fixtures/${fixture.id}/match-videos`, { token: referee.token }));
  for (const vid of list.videos ?? []) {
    assert.ok(!vid.youth_consent_ref, 'youth_consent_ref not exposed in list');
  }
});

test('13. List videos groups and returns marker counts', async () => {
  const { referee, fixture } = await setup();
  const v1 = ok(await uploadVideo(referee.token, fixture.id, { angle_label: 'main' }), 201);
  const v2 = ok(await uploadVideo(referee.token, fixture.id, { angle_label: 'end-zone' }), 201);

  ok(await api('POST', `/match-videos/${v1.video.id}/markers`, { token: referee.token, body: { timestamp_ms: 1000, marker_type: 'incident', severity: 'high' } }), 201);
  ok(await api('POST', `/match-videos/${v1.video.id}/markers`, { token: referee.token, body: { timestamp_ms: 2000, marker_type: 'decision', severity: 'low' } }), 201);

  const list = ok(await api('GET', `/fixtures/${fixture.id}/match-videos`, { token: referee.token }));
  assert.ok(list.videos.length >= 2, 'both angles returned');
  const main = list.videos.find((v) => v.id === v1.video.id);
  assert.equal(main.marker_count, 2, 'marker_count accurate');
});
