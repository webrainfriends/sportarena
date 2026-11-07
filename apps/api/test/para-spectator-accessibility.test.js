// PS-26: Accessible para-sport spectator results, media and broadcasts
// Tests: scoreboard, play-by-play CRUD, accessible media, accessible streams, settings CRUD,
//        403 for non-organiser, youth name suppression, no medical data in any response.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });

import { migrate, dropSchema } from '../src/migrate.js';
import { startServer }         from '../src/server.js';
import { db }                  from '../src/db.js';

let server, baseUrl;
// fixtures created in before()
let orgUser, otherUser, youthOrgUser;
let eventId, fixtureId, youthEventId, youthFixtureId;
let assetId, streamId;

before(async () => {
  await dropSchema();
  await migrate();
  server  = await startServer({ port: 0 });
  baseUrl = `http://localhost:${server.address().port}/api/v1`;

  // Create test users
  const { rows: [org] } = await db.query(
    `INSERT INTO users (email, display_name, dob) VALUES ('org@test.invalid','Org User','1990-01-01') RETURNING id`,
  );
  orgUser = org;

  const { rows: [other] } = await db.query(
    `INSERT INTO users (email, display_name, dob) VALUES ('other@test.invalid','Other User','1990-01-01') RETURNING id`,
  );
  otherUser = other;

  const { rows: [yorg] } = await db.query(
    `INSERT INTO users (email, display_name, dob) VALUES ('yorg@test.invalid','Youth Org','1990-01-01') RETURNING id`,
  );
  youthOrgUser = yorg;

  // Create a para event + fixture
  const { rows: [ev] } = await db.query(
    `INSERT INTO events (name, slug, sport, status, public_view, organiser_id) VALUES ('Test Para Event','test-para-evt','athletics','published',true,$1) RETURNING id`,
    [orgUser.id],
  );
  eventId = ev.id;

  const { rows: [fx] } = await db.query(
    `INSERT INTO fixtures (event_id, status, scheduled_at) VALUES ($1,'scheduled',now()) RETURNING id`,
    [eventId],
  );
  fixtureId = fx.id;

  // Create a youth event (DOB-inferred youth)
  const { rows: [yev] } = await db.query(
    `INSERT INTO events (name, slug, sport, status, public_view, organiser_id, min_age, max_age) VALUES ('Youth Para','youth-para-evt','athletics','published',true,$1,10,17) RETURNING id`,
    [youthOrgUser.id],
  );
  youthEventId = yev.id;

  const { rows: [yfx] } = await db.query(
    `INSERT INTO fixtures (event_id, status, scheduled_at) VALUES ($1,'scheduled',now()) RETURNING id`,
    [youthEventId],
  );
  youthFixtureId = yfx.id;

  // Create a media asset and stream with a11y defaults
  const { rows: [ast] } = await db.query(
    `INSERT INTO mr_assets (event_id, kind, right_kind, title, audience, status, territory_mode, source_kind, external_url, platforms)
       VALUES ($1,'video','highlight','Test clip','public','published','worldwide','external','https://example.com/clip.mp4',ARRAY['web','mobile_app'])
     RETURNING id`,
    [eventId],
  );
  assetId = ast.id;

  const { rows: [str] } = await db.query(
    `INSERT INTO mr_streams (event_id, provider, state, playback_ref, status, access_policy, fixture_id)
       VALUES ($1,'youtube','live','https://example.com/stream','active','public',$2)
     RETURNING id`,
    [eventId, fixtureId],
  );
  streamId = str.id;
});

after(async () => {
  await server?.close();
});

// Helper: authenticated fetch
async function authed(userId, method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Test-User-Id': userId },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}
async function pub(path) {
  return fetch(`${baseUrl}${path}`);
}

// ------------------------------------------------------------------ scoreboard

test('scoreboard returns class-aware structure', async () => {
  const res = await pub(`/public/events/${eventId}/para-scoreboard`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.classes), 'classes array present');
  assert.ok('class_aware_scoreboard' in body);
  assert.ok('combined_disclaimer' in body);
  // No medical or clinical data
  const text = JSON.stringify(body);
  for (const forbidden of ['diagnosis', 'medical', 'clinical', 'impairment_code', 'disability']) {
    assert.ok(!text.includes(forbidden), `no ${forbidden} in scoreboard`);
  }
});

test('scoreboard 404 for unknown event', async () => {
  const res = await pub(`/public/events/00000000-0000-0000-0000-000000000000/para-scoreboard`);
  assert.equal(res.status, 404);
});

// ------------------------------------------------------------------ play-by-play

test('play-by-play empty list when no entries', async () => {
  const res = await pub(`/public/fixtures/${fixtureId}/play-by-play`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.entries, []);
});

test('organiser can add play-by-play entry', async () => {
  const res = await authed(orgUser.id, 'POST', `/fixtures/${fixtureId}/play-by-play`, {
    fixture_id: fixtureId,
    entry_text: 'T44 class — Bolt leads after 60m',
    entry_kind: 'update',
    para_class_code: 'T44',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entry_text, 'T44 class — Bolt leads after 60m');
  assert.equal(body.para_class_code, 'T44');
  // Store for later
  this._pbpId = body.id;
});

test('play-by-play visible publicly after add', async () => {
  const res = await pub(`/public/fixtures/${fixtureId}/play-by-play`);
  const body = await res.json();
  assert.ok(body.entries.length > 0);
  // No authored_by or user ids exposed
  for (const e of body.entries) {
    assert.ok(!('authored_by' in e), 'authored_by not in public response');
  }
});

test('non-organiser cannot add play-by-play', async () => {
  const res = await authed(otherUser.id, 'POST', `/fixtures/${fixtureId}/play-by-play`, {
    fixture_id: fixtureId,
    entry_text: 'unauthorised entry',
    entry_kind: 'update',
  });
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------------ accessible media

test('accessible media endpoint returns a11y fields', async () => {
  const res = await pub(`/public/events/${eventId}/accessible-media`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.assets));
  for (const a of body.assets) {
    assert.ok('a11y_status' in a, 'a11y_status present');
    assert.ok('caption_ref' in a);
    assert.ok('audio_desc_ref' in a);
    assert.ok('transcript_ref' in a);
    assert.ok('alt_text' in a);
  }
});

test('organiser can set asset a11y metadata', async () => {
  const res = await authed(orgUser.id, 'PATCH', `/media/assets/${assetId}/accessibility`, {
    asset_id: assetId,
    caption_ref: 'https://captions.example.com/clip.vtt',
    a11y_status: 'partial',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.caption_ref, 'https://captions.example.com/clip.vtt');
  assert.equal(body.a11y_status, 'partial');
});

test('non-organiser cannot set asset a11y', async () => {
  const res = await authed(otherUser.id, 'PATCH', `/media/assets/${assetId}/accessibility`, {
    asset_id: assetId,
    a11y_status: 'verified',
  });
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------------ accessible streams

test('accessible streams endpoint returns a11y fields', async () => {
  const res = await pub(`/public/events/${eventId}/accessible-streams`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.streams));
  for (const s of body.streams) {
    assert.ok('a11y_status' in s);
    assert.ok('caption_ref' in s);
    assert.ok('audio_desc_ref' in s);
  }
});

test('organiser can set stream a11y metadata', async () => {
  const res = await authed(orgUser.id, 'PATCH', `/media/streams/${streamId}/accessibility`, {
    stream_id: streamId,
    caption_ref: 'https://captions.example.com/stream.vtt',
    a11y_status: 'verified',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.a11y_status, 'verified');
});

// ------------------------------------------------------------------ settings

test('accessibility settings defaults when not configured', async () => {
  const res = await pub(`/public/fixtures/${fixtureId}/accessibility-settings`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.caption_status, 'unknown');
  assert.equal(body.audio_desc_status, 'unknown');
  assert.equal(body.play_by_play_enabled, true);
});

test('organiser can save accessibility settings', async () => {
  const res = await authed(orgUser.id, 'POST', `/fixtures/${fixtureId}/accessibility-settings`, {
    fixture_id: fixtureId,
    caption_status: 'verified',
    audio_desc_status: 'partial',
    play_by_play_enabled: true,
    caption_provider_url: 'https://captions.example.com',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.caption_status, 'verified');
  assert.equal(body.caption_provider_url, 'https://captions.example.com');
});

test('non-organiser cannot save settings', async () => {
  const res = await authed(otherUser.id, 'POST', `/fixtures/${fixtureId}/accessibility-settings`, {
    fixture_id: fixtureId,
    caption_status: 'verified',
  });
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------------ youth protection

test('scoreboard suppresses athlete names for youth events', async () => {
  const res = await pub(`/public/events/${youthEventId}/para-scoreboard`);
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const cls of body.classes) {
    for (const entry of cls.entries) {
      assert.equal(entry.display_name, null, 'display_name null for youth event');
    }
  }
  if (body.combined) {
    for (const entry of body.combined) {
      assert.equal(entry.display_name, null, 'display_name null in combined for youth event');
    }
  }
});
