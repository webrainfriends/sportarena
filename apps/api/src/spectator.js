// Public tournament & spectator projection (#501). Everything here READS the canonical event / fixture / scoring / sponsorship / media data and reshapes it
// into an allow-listed, public-safe view; nothing is copied into a separate store. The rules every public surface (REST, OpenAPI, MCP, share pages) shares:
//   * drafts are organiser-only; a `private` event is visible to its organiser and participants only; `unlisted` is reachable by link but never listed;
//   * a youth event (maximum age under 18) and any young person never appear by name, never get a stats page, a fan vote or an indexable share page;
//   * only accepted sponsorships with a placement, and only media the rights engine says is live and public, are shown;
//   * a result is `provisional` until the score sheet is approved (fixture completed) and the table is `provisional` until the event is completed.
import { pool, many, one } from './db.js';
import { notFound } from './errors.js';
import { isAdmin, standings } from './helpers.js';
import { hasOrgGrant } from './org-access.js';
import { liveState } from './scoring/state.js';
import { ASSET_COLS, assetState } from './media-rights.js';
import { notify } from './notify.js';
import { YOUTH_SQL } from './youth.js';
import { ROUND_LABEL } from './tournament/bracket.js';
import { stageViews } from './tournament/view.js';

export const YOUTH_AGE = 18;
export const isYouthEvent = (ev) => ev.max_age != null && ev.max_age < YOUTH_AGE;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLOTS = ['title_partner', 'fixture', 'scorecard', 'leaderboard'];
export const ALERTS = ['start', 'score', 'result', 'schedule', 'media'];
export const REACTIONS = ['fire', 'clap', 'wow', 'strong'];
const NO_ONE = '00000000-0000-0000-0000-000000000000';

/** SQL: is user `u` (a $n placeholder) the organiser or a participant of event alias `e`? Used for private events. */
export const participantSql = (e, u) => `(${e}.organizer_id=${u}
  OR EXISTS (SELECT 1 FROM event_entries n WHERE n.event_id=${e}.id AND n.status IN ('accepted','pending','waitlisted') AND (n.user_id=${u} OR n.team_id IN (SELECT m.team_id FROM team_members m WHERE m.user_id=${u} AND m.status='active')))
  OR EXISTS (SELECT 1 FROM event_invitations v WHERE v.event_id=${e}.id AND v.status='invited' AND (v.user_id=${u} OR v.team_id IN (SELECT m.team_id FROM team_members m WHERE m.user_id=${u} AND m.status='active')))
  OR EXISTS (SELECT 1 FROM event_staff st WHERE st.event_id=${e}.id AND st.user_id=${u} AND st.status IN ('invited','accepted'))
  OR EXISTS (SELECT 1 FROM event_staff_assignments sa WHERE sa.event_id=${e}.id AND sa.user_id=${u} AND sa.status IN ('invited','accepted'))
  OR EXISTS (SELECT 1 FROM fixtures x WHERE x.event_id=${e}.id AND x.referee_id=${u}))`;

/** 'organiser' (owner, delegate or platform admin), 'participant', or null. */
export async function viewerRole(user, ev, c = pool) {
  if (!user) return null;
  if (isAdmin(user) || user.id === ev.organizer_id || await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c)) return 'organiser';
  return (await c.query(`SELECT ${participantSql('e', '$2')} AS ok FROM events e WHERE e.id=$1`, [ev.id, user.id])).rows[0]?.ok ? 'participant' : null;
}

const EVENT_SQL = 'SELECT e.*, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1';

/** The event as this viewer may see it on a public page. A draft or an outsider's view of a private event is a 404, so existence is not leaked. */
export async function loadViewableEvent(user, eventId, c = pool) {
  if (!UUID.test(String(eventId))) throw notFound('Event');
  const ev = (await c.query(EVENT_SQL, [eventId])).rows[0];
  if (!ev) throw notFound('Event');
  const role = await viewerRole(user, ev, c);
  if (role === 'organiser') return { ev, role };
  if (ev.status === 'draft') throw notFound('Event');
  if (ev.public_visibility === 'private' && role !== 'participant') throw notFound('Event');
  return { ev, role };
}

/** Guard for the older read capabilities (standings, bracket, fixtures, live): only the private-event rule, drafts keep behaving as before. */
export async function assertEventReadable(user, eventId, c = pool) {
  const ev = (await c.query('SELECT id, organizer_id, organisation_id, public_visibility FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev || ev.public_visibility !== 'private') return;
  if (!(await viewerRole(user, ev, c))) throw notFound('Event');
}
export async function assertFixtureReadable(user, fixtureId, c = pool) {
  const f = UUID.test(String(fixtureId)) ? (await c.query('SELECT event_id FROM fixtures WHERE id=$1', [fixtureId])).rows[0] : null;
  if (f) await assertEventReadable(user, f.event_id, c);
}

/** Resolve a fixture and the event around it for a public view. */
export async function loadViewableFixture(user, fixtureId, c = pool) {
  if (!UUID.test(String(fixtureId))) throw notFound('Fixture');
  const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [fixtureId])).rows[0];
  if (!f) throw notFound('Fixture');
  const { ev, role } = await loadViewableEvent(user, f.event_id, c);
  return { f, ev, role };
}

// ------------------------------------------------------------------ state labels
/** upcoming | live | in_progress | paused | completed | cancelled */
export function eventState(ev, liveCount) {
  if (ev.status === 'cancelled') return 'cancelled';
  if (ev.status === 'completed') return 'completed';
  if (ev.status === 'paused') return 'paused';
  if (liveCount > 0) return 'live';
  return ev.status === 'ongoing' ? 'in_progress' : 'upcoming';
}
/** live | provisional (full time, score sheet not approved yet) | final | scheduled | cancelled | postponed | abandoned */
export const resultLabel = (status) => ({ live: 'live', paused: 'live', finished: 'provisional', completed: 'final' }[status] ?? status);
const SCORE_SHOWN = new Set(['live', 'paused', 'finished', 'completed']);

const FIXTURE_COLS = `f.id, f.event_id, f.round, f.round_kind, f.status, f.scheduled_at, f.duration_min, f.home_team_id, f.away_team_id, f.home_score, f.away_score, f.winner_team_id,
  f.home_placeholder, f.away_placeholder, f.started_at, f.finished_at,
  h.name AS home_name, h.emoji AS home_emoji, h.color AS home_color, a.name AS away_name, a.emoji AS away_emoji, a.color AS away_color,
  r.name AS court, ve.name AS venue_name, ve.city AS venue_city, coalesce(ve.timezone, 'UTC') AS venue_timezone`;
const FIXTURE_FROM = `FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues ve ON ve.id=r.venue_id`;

const side = (f, p) => (f[`${p}_team_id`] ? { team_id: f[`${p}_team_id`], name: f[`${p}_name`], emoji: f[`${p}_emoji`], color: f[`${p}_color`] } : { team_id: null, name: f[`${p}_placeholder`] ?? 'To be decided', emoji: null, color: null });

/** The scoreboard of a game in progress, from the match log (never typed twice). */
async function liveScore(fixtureId) {
  const s = await liveState(fixtureId, null, { limit: 1 });
  const sc = s.score ?? {};
  return { home: sc.home ?? 0, away: sc.away ?? 0, over: !!sc.over, periods: sc.periods ?? null, sets: sc.sets ?? null, period: s.phase?.period ?? null, period_open: s.phase?.period_open ?? null, ruleset: { label: s.ruleset?.label, kind: s.ruleset?.kind, periods: s.ruleset?.periods } };
}

/** Public rows for a set of fixture ids/filters, with result labels and correction flags. */
export async function publicFixtures(eventId, { team_id = null, status = null, from = null, to = null, ids = null, limit = 100, offset = 0 } = {}) {
  const rows = await many(
    `SELECT ${FIXTURE_COLS} ${FIXTURE_FROM}
      WHERE f.event_id=$1 AND ($2::uuid IS NULL OR f.home_team_id=$2 OR f.away_team_id=$2) AND ($3::text IS NULL OR f.status=$3)
        AND ($4::timestamptz IS NULL OR f.scheduled_at >= $4) AND ($5::timestamptz IS NULL OR f.scheduled_at < $5) AND ($6::uuid[] IS NULL OR f.id = ANY($6))
        AND (f.stage_id IS NULL OR EXISTS (SELECT 1 FROM event_stages s WHERE s.id=f.stage_id AND s.published_at IS NOT NULL))
      ORDER BY f.scheduled_at, f.bracket_slot NULLS LAST, f.id LIMIT $7 OFFSET $8`,
    [eventId, team_id, status, from, to, ids, limit, offset]);
  if (!rows.length) return [];
  const changes = await many(
    `SELECT fixture_id, bool_or(kind='result' AND was_final) AS corrected, bool_or(kind='schedule') AS rescheduled, max(created_at) FILTER (WHERE kind IN ('result','schedule','status') AND (was_final OR kind='schedule')) AS changed_at
       FROM fixture_public_changes WHERE fixture_id = ANY($1) GROUP BY fixture_id`, [rows.map((r) => r.id)]);
  const by = new Map(changes.map((c) => [c.fixture_id, c]));
  const out = [];
  for (const f of rows) {
    const live = ['live', 'paused', 'finished'].includes(f.status);
    const score = live ? await liveScore(f.id) : SCORE_SHOWN.has(f.status) ? { home: f.home_score, away: f.away_score } : null;
    const ch = by.get(f.id);
    out.push({ id: f.id, round: f.round, round_kind: f.round_kind, status: f.status, label: resultLabel(f.status), scheduled_at: f.scheduled_at, duration_min: f.duration_min,
      timezone: f.venue_timezone, court: f.court, venue: f.venue_name ? { name: f.venue_name, city: f.venue_city } : null, home: side(f, 'home'), away: side(f, 'away'),
      score, winner_team_id: f.status === 'completed' ? f.winner_team_id : null, corrected: !!ch?.corrected, rescheduled: !!ch?.rescheduled, changed_at: ch?.changed_at ?? null });
  }
  return out;
}

/** The bracket of an event: `rounds` / `champion` are the single-elimination view older clients read; `stages` carries every format
 *  (double elimination, Swiss, pools, series, repechage, placement) as sections. Draft stages are shown to organisers only. */
const ROUND_ORDER = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final', 'third_place'];
export async function bracketOf(eventId, { organiser = false } = {}) {
  const rows = await many(
    `SELECT f.id, f.round, f.round_kind, f.bracket_slot AS slot, f.status, f.scheduled_at, f.duration_min, f.home_team_id, f.away_team_id, f.home_score, f.away_score, f.winner_team_id,
            f.home_placeholder, f.away_placeholder, f.win_feeds_fixture_id, f.lose_feeds_fixture_id, h.name AS home_name, h.emoji AS home_emoji, a.name AS away_name, a.emoji AS away_emoji,
            r.name AS resource_name, ve.timezone AS venue_timezone
       FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues ve ON ve.id=r.venue_id
      WHERE f.event_id=$1 AND f.round_kind IS NOT NULL AND f.round_kind <> 'group' AND f.status <> 'cancelled' AND f.tie_id IS NULL
        AND ($2::boolean OR f.stage_id IS NULL OR EXISTS (SELECT 1 FROM event_stages s WHERE s.id=f.stage_id AND s.published_at IS NOT NULL)) ORDER BY f.scheduled_at, f.bracket_slot`, [eventId, organiser]);
  const rounds = ROUND_ORDER.map((kind) => ({ kind, label: ROUND_LABEL[kind], games: rows.filter((r) => r.round_kind === kind).sort((x, y) => x.slot - y.slot) })).filter((r) => r.games.length);
  const final = rows.find((r) => r.round_kind === 'final' && r.status === 'completed');
  const champion = final ? { team_id: final.winner_team_id, name: final.winner_team_id === final.home_team_id ? final.home_name : final.away_name } : null;
  return { rounds, champion, stages: await stageViews(eventId, { organiser }) };
}

/** Standings with the honest label: provisional until the event is completed, and how many games are still to be made official. */
export async function publicStandings(ev) {
  const rows = await standings(ev.id);
  const pending = (await one("SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1 AND coalesce(round_kind,'group')='group' AND status NOT IN ('completed','cancelled')", [ev.id])).n;
  return { label: ev.status === 'completed' ? 'final' : 'provisional', games_to_finalise: pending, points: { win: ev.points_win, draw: ev.points_draw, loss: ev.points_loss }, rows };
}

// ------------------------------------------------------------------ sponsors, measured
export async function placementsFor(ev, { fixtureId = null, youth = false, count = true } = {}) {
  const rows = await many(
    `SELECT p.id, p.slot, p.fixture_id, p.cta_label, p.cta_url, sp.id AS sponsor_id, sp.name, sp.emoji, sp.website, ss.in_kind
       FROM event_sponsor_placements p JOIN sponsorships ss ON ss.id=p.sponsorship_id AND ss.status='active' AND ss.target_type='event' AND ss.target_id=p.event_id
       JOIN sponsors sp ON sp.id=ss.sponsor_id
      WHERE p.event_id=$1 AND p.status='active' AND (p.fixture_id IS NULL OR p.fixture_id=$2) ORDER BY array_position(ARRAY['title_partner','leaderboard','scorecard','fixture'], p.slot), p.created_at`, [ev.id, fixtureId]);
  if (count && rows.length) {
    await pool.query(
      `INSERT INTO placement_daily_counts(placement_id, day, impressions) SELECT x, current_date, 1 FROM unnest($1::uuid[]) AS x
         ON CONFLICT (placement_id, day) DO UPDATE SET impressions = placement_daily_counts.impressions + 1`, [rows.map((r) => r.id)]);
  }
  return rows.map((r) => ({ id: r.id, slot: r.slot, sponsor: { id: r.sponsor_id, name: r.name, emoji: r.emoji, website: youth ? null : r.website }, in_kind: r.in_kind,
    cta: !youth && r.cta_url ? { label: r.cta_label, click_path: `/public/placements/${r.id}/click` } : null }));
}
/** The sponsors that back the event (accepted sponsorships), whether or not they hold a placement. */
export const supportersOf = (eventId) => many("SELECT sp.id, sp.name, sp.emoji, ss.in_kind FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ss.target_type='event' AND ss.target_id=$1 AND ss.status='active' ORDER BY sp.name", [eventId]);

// ------------------------------------------------------------------ media: only what the rights engine says is live, public and worldwide
export async function publicMedia(eventId, { fixtureId = null, limit = 24 } = {}) {
  const rows = await many(
    `SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.event_id=$1 AND a.audience='public' AND a.status='published' AND a.territory_mode='worldwide' AND ($2::uuid IS NULL OR a.fixture_id=$2)
       AND (cardinality(a.platforms)=0 OR a.platforms && ARRAY['web','mobile_app','social']::text[]) ORDER BY a.created_at DESC LIMIT 200`, [eventId, fixtureId]);
  const out = [];
  for (const a of rows) {
    if (out.length >= limit) break;
    if (await assetState(a) !== 'live') continue;
    const link = a.source_kind === 'upload' ? (a.stored_file ? `/api/v1/media/assets/${a.id}/file` : null) : a.external_url;
    if (!link) continue;
    out.push({ id: a.id, kind: a.kind, right_kind: a.right_kind, title: a.title, caption: a.caption, credit: a.credit, fixture_id: a.fixture_id, content_type: a.content_type, link });
  }
  return out;
}

// ------------------------------------------------------------------ people: names only for adults, never on a youth event
export async function publicPeople(ev, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length || isYouthEvent(ev)) return new Map();
  const rows = await many(`SELECT u.id, u.display_name, u.handle, u.avatar_emoji FROM users u WHERE u.id = ANY($1) AND NOT ${YOUTH_SQL}`, [want]);
  return new Map(rows.map((r) => [r.id, { id: r.id, display_name: r.display_name, handle: r.handle, avatar_emoji: r.avatar_emoji }]));
}

/** The live view of a game from its scoring state, as the public sees it: allow-listed fields only (no void events, notes, free-text payloads, player ids of young people). */
export async function publicLiveFrom(ev, s) {
  const people = await publicPeople(ev, s.events.map((e) => e.player_id));
  const label = (kind) => [...(s.ruleset?.events ?? []), ...(s.ruleset?.stats ?? [])].find((x) => x.kind === kind)?.label ?? kind.replace(/_/g, ' ');
  const sc = s.score ?? {};
  return {
    status: s.fixture.status, label: resultLabel(s.fixture.status), started_at: s.fixture.started_at, finished_at: s.fixture.finished_at,
    home: s.fixture.home ? { team_id: s.fixture.home.id, name: s.fixture.home.name, emoji: s.fixture.home.emoji, color: s.fixture.home.color } : null,
    away: s.fixture.away ? { team_id: s.fixture.away.id, name: s.fixture.away.name, emoji: s.fixture.away.emoji, color: s.fixture.away.color } : null,
    score: { home: sc.home ?? 0, away: sc.away ?? 0, over: !!sc.over, periods: sc.periods ?? null, sets: sc.sets ?? null, current_set: sc.current_set ?? null },
    phase: { period: s.phase?.period ?? null, period_open: s.phase?.period_open ?? null, periods_total: s.phase?.periods_total ?? null },
    ruleset: { label: s.ruleset?.label, kind: s.ruleset?.kind, period_label: s.ruleset?.periods?.label },
    last_seq: s.last_seq,
    timeline: s.events.filter((e) => e.kind !== 'note').map((e) => ({ seq: e.seq, kind: e.kind, label: label(e.kind), side: e.side, period: e.period, clock_seconds: e.clock_seconds, player: e.player_id ? people.get(e.player_id) ?? null : null })),
  };
}

export async function publicOfficials(ev, fixtureId) {
  if (!ev.public_show_officials || isYouthEvent(ev)) return [];
  return many(`SELECT o.role, u.display_name, u.handle FROM fixture_officials o JOIN users u ON u.id=o.user_id WHERE o.fixture_id=$1 AND o.status IN ('accepted','completed') AND NOT ${YOUTH_SQL} ORDER BY o.role, u.display_name`, [fixtureId]);
}

export async function publicStreams(eventId, fixtureId) {
  return many(
    `SELECT id, provider, state, playback_ref, archive_ref, scheduled_start, fixture_id FROM mr_streams
      WHERE event_id=$1 AND status='active' AND access_policy='public' AND (fixture_id IS NULL OR fixture_id=$2) ORDER BY (fixture_id IS NULL), scheduled_start NULLS LAST LIMIT 5`, [eventId, fixtureId]);
}

// ------------------------------------------------------------------ follower alerts
const ALERT_KIND = { start: 'fixture_started', score: 'fixture_score', result: 'fixture_result', schedule: 'fixture_schedule' };

async function followersOf(c, fx, kind, scorerIds = []) {
  return (await c.query(
    `SELECT DISTINCT f.user_id FROM spectator_follows f
      WHERE f.removed_at IS NULL AND $5 = ANY(f.alerts) AND (
            (f.subject_type='fixture' AND f.subject_id=$1) OR (f.subject_type='event' AND f.subject_id=$2)
         OR (f.subject_type='team' AND f.subject_id = ANY($3::uuid[])) OR (f.subject_type='athlete' AND f.subject_id = ANY($4::uuid[])))`,
    [fx.id, fx.event_id, [fx.home_team_id, fx.away_team_id].filter(Boolean), scorerIds, kind])).rows.map((r) => r.user_id);
}

/** May this person still watch this game? Alerts stop at once when the event turns private or the follower lost access. */
async function mayWatch(c, userId, ev) {
  if (ev.public_visibility !== 'private') return true;
  return !!(await c.query(`SELECT 1 FROM events e WHERE e.id=$1 AND ${participantSql('e', '$2')}`, [ev.id, userId])).rows.length;
}

/**
 * Turn the change log into follower notifications. Idempotent (each change is claimed with SKIP LOCKED and every alert carries a dedupe key),
 * safe on several instances, and it never rewrites history: it only reads the log and the current public state.
 * Returns how many notifications were queued.
 */
export async function sendFollowerAlerts(limit = 200) {
  const { tx } = await import('./db.js');
  let sent = 0;
  const batch = await many('SELECT id FROM fixture_public_changes WHERE processed_at IS NULL ORDER BY id LIMIT $1', [limit]);
  if (!batch.length) return 0;
  const fixtureIds = new Set((await many('SELECT DISTINCT fixture_id FROM fixture_public_changes WHERE id = ANY($1)', [batch.map((b) => b.id)])).map((r) => r.fixture_id));
  for (const fid of fixtureIds) {
    sent += await tx(async (c) => {
      const rows = (await c.query('SELECT * FROM fixture_public_changes WHERE fixture_id=$1 AND processed_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED', [fid])).rows;
      if (!rows.length) return 0;
      const fx = (await c.query(`SELECT f.*, h.name AS home_name, a.name AS away_name FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1`, [fid])).rows[0];
      const ev = (await c.query('SELECT id, name, status, public_visibility, max_age FROM events WHERE id=$1', [fx.event_id])).rows[0];
      let n = 0;
      const vs = `${fx.home_name ?? 'TBD'} v ${fx.away_name ?? 'TBD'}`;
      const send = async (alert, title, body, key) => {
        if (ev.status === 'draft') return;
        for (const uid of await followersOf(c, fx, alert, alert === 'score' ? await scorerIdsOf(c, fx, ev) : [])) {
          if (!(await mayWatch(c, uid, ev))) continue;
          if (await notify(c, uid, { kind: ALERT_KIND[alert], title, body, data: { event_id: fx.event_id, fixture_id: fx.id, spectator: true }, dedupe_key: `spectator:${key}:${uid}` })) n++;
        }
      };
      for (const ch of rows) {
        if (ch.kind === 'status' && ch.after.status === 'live' && ch.before.status === 'scheduled') await send('start', `Kick-off: ${vs}`, `${ev.name} · the game has started`, `start:${fx.id}`);
        else if (ch.kind === 'status' && ch.after.status === 'completed') await send('result', `Final: ${vs}`, `${ev.name} · ${fx.home_score ?? 0}–${fx.away_score ?? 0}`, `final:${fx.id}:${ch.id}`);
        else if (ch.kind === 'status' && ['cancelled', 'postponed', 'abandoned'].includes(ch.after.status)) await send('schedule', `${ch.after.status === 'cancelled' ? 'Cancelled' : ch.after.status === 'postponed' ? 'Postponed' : 'Abandoned'}: ${vs}`, ev.name, `status:${ch.id}`);
        else if (ch.kind === 'schedule') await send('schedule', `Schedule change: ${vs}`, `${ev.name} · now ${new Date(ch.after.scheduled_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`, `sched:${ch.id}`);
        else if (ch.kind === 'result' && ch.was_final) await send('result', `Result corrected: ${vs}`, `${ev.name} · now ${ch.after.home_score ?? 0}–${ch.after.away_score ?? 0}`, `corr:${ch.id}`);
      }
      // live scoring: one alert for the score as it stands now, only if it moved since the last alert
      if (rows.some((r) => r.kind === 'live') && ['live', 'paused'].includes(fx.status)) {
        const sc = await liveScore(fx.id);
        const prev = (await c.query('SELECT last_score FROM fixture_alert_state WHERE fixture_id=$1 FOR UPDATE', [fx.id])).rows[0]?.last_score;
        if (!prev || prev.home !== sc.home || prev.away !== sc.away) {
          await c.query('INSERT INTO fixture_alert_state(fixture_id, last_score) VALUES ($1,$2) ON CONFLICT (fixture_id) DO UPDATE SET last_score=$2, updated_at=now()', [fx.id, JSON.stringify({ home: sc.home, away: sc.away })]);
          if (prev || sc.home || sc.away) await send('score', `${fx.home_name ?? 'TBD'} ${sc.home}–${sc.away} ${fx.away_name ?? 'TBD'}`, `${ev.name} · live`, `score:${fx.id}:${rows[rows.length - 1].id}`);
        }
      }
      await c.query('UPDATE fixture_public_changes SET processed_at=now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      return n;
    });
  }
  return sent;
}

/** Adults who just scored (so their followers hear about it). Young people and youth events never feed athlete alerts. */
async function scorerIdsOf(c, fx, ev) {
  if (isYouthEvent(ev)) return [];
  return (await c.query(
    `SELECT DISTINCT m.player_id FROM match_events m JOIN users u ON u.id=m.player_id WHERE m.fixture_id=$1 AND m.player_id IS NOT NULL AND m.voided_at IS NULL AND m.recorded_at > now() - interval '10 minutes' AND NOT ${YOUTH_SQL}`, [fx.id])).rows.map((r) => r.player_id);
}

/** Per-person allowance for spectator writes (reactions, votes, follows): stops stuffing without needing an IP. */
export async function spendAllowance(c, userId, kind, perHour) {
  const used = (await c.query("SELECT count(*)::int AS n FROM spectator_actions WHERE user_id=$1 AND created_at > now() - interval '1 hour'", [userId])).rows[0].n;
  if (used >= perHour) return false;
  await c.query('INSERT INTO spectator_actions(user_id, kind) VALUES ($1,$2)', [userId, kind]);
  return true;
}

export const ZERO_UUID = NO_ONE;
