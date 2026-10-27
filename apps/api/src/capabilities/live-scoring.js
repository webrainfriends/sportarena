// Live scoring engine (#500): the sport-aware layer on top of match tracking. It adds provenance-preserving corrections, bounded history,
// a spectator-safe projection, an advisory scorer lease, and the same append-only live log for heats / finals / field flights.
// Nothing here is a second scoring database: match_events and session_events are logs, official results still go through the
// score-sheet workflow (fixtures) and recordSessionResults (sessions), and every total is derived by the sport plugin.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { publish } from '../live.js';
import { serialized } from '../serialize.js';
import { fixtureContext, authorityOf, assertInLineup, broadcast } from './match-tracking.js';
import { liveState, loggedEvents, rulesetForEvent, redactForPublic, publiclyNameable } from '../scoring/state.js';
import { pluginFor, sessionPlugin, SESSION_KINDS } from '../scoring/plugins/index.js';
import { replayStream, withCorrection } from '../scoring/replay.js';
import { isKnockout } from '../tournament/advance.js';
import { discipline, mustSession, viewer, entryRows, isAssignedOfficial, recordSessionResults } from './multisport-play.js';
import { eventAccess, organizerOnly } from './multisport.js';
import { assertEventReadable, assertFixtureReadable } from '../spectator.js';

const TAG = 'Live scoring';
const kindKey = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
const LEASE_SECONDS = 90;
const needScorer = (x) => { if (!x.canScore) throw forbidden('Only the organiser or the match officials can do that'); };

// ------------------------------------------------------------------ corrections
cap({
  name: 'correct_match_event', method: 'POST', path: '/match-events/:id/correct', tag: TAG, status: 201,
  summary: 'Correct a wrongly logged event (organiser or match official, while the game is live or paused). The original stays in the log, voided, and a replacement takes its place in play order, with a revision record of who corrected it, in what capacity, why, and the before/after. The rest of the game is replayed under the pinned ruleset first: a correction that would make a later event illegal is refused and names that event. Change only what was wrong; everything else is kept.',
  input: z.object({
    id, reason: z.string().min(2).max(300), kind: kindKey.optional(), side: z.enum(['home', 'away']).nullable().optional(), period: z.number().int().min(1).max(20).nullable().optional(),
    clock_seconds: z.number().int().min(0).max(36000).nullable().optional(), player_id: id.nullable().optional(), payload: z.record(z.string(), z.any()).optional(),
    client_key: z.string().min(1).max(80).optional(),
  }).refine((v) => ['kind', 'side', 'period', 'clock_seconds', 'player_id', 'payload'].some((k) => v[k] !== undefined), 'Say what to change'),
  async handler({ user }, i) {
    const m = (await pool.query('SELECT fixture_id FROM match_events WHERE id=$1', [i.id])).rows[0];
    if (!m) throw notFound('Match event');
    let duplicate = false;
    const out = await serialized(`fixture:${m.fixture_id}`, () => tx(async (c) => {
      const x = await fixtureContext(user, m.fixture_id, c, { lock: true });
      needScorer(x);
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM match_events WHERE fixture_id=$1 AND client_key=$2', [m.fixture_id, i.client_key])).rows[0];
        if (dup) { duplicate = true; return dup; }
      }
      if (!['live', 'paused'].includes(x.f.status)) throw conflict('Events can only be corrected while the game is live or paused; after full time, correct the score sheet (revise_score_sheet) instead');
      const cur = (await c.query('SELECT * FROM match_events WHERE id=$1', [i.id])).rows[0];
      if (cur.voided_at) throw conflict('That event is already voided or corrected; correct the event that replaced it');
      const { ruleset } = await rulesetForEvent(x.f.event_id, c, m.fixture_id);
      const logged = await loggedEvents(m.fixture_id, c);
      const lastSeq = logged.reduce((n, e) => Math.max(n, e.seq), 0);
      const pick = (k) => (i[k] !== undefined ? i[k] : cur[k]);
      const next = {
        id: null, seq: lastSeq + 1, kind: i.kind ?? cur.kind, side: pick('side'), period: pick('period'), clock_seconds: pick('clock_seconds'), player_id: pick('player_id'),
        payload: i.payload ?? cur.payload, supersedes_id: cur.id, position_seq: cur.position_seq ?? cur.seq,
      };
      const ctx = { knockout: isKnockout(x.f) };
      const before = replayStream(ruleset, logged, ctx), after = replayStream(ruleset, withCorrection(logged, cur.id, next), ctx);
      if (!after.ok && (before.ok || after.failed.seq !== before.failed.seq)) {
        throw conflict(`This correction would make a later event illegal (event ${after.failed.seq ?? 'new'}, ${after.failed.kind}: ${after.failed.reason})`, { code: 'correction_invalidates_later_events', failed: after.failed });
      }
      if (next.side && ruleset.kind !== 'cricket') await assertInLineup(c, x.f, next.side, [next.player_id, next.payload?.assist_player_id]);
      const authority = authorityOf(x, user);
      const rep = (await c.query(
        `INSERT INTO match_events(fixture_id, event_id, seq, client_key, kind, side, team_id, player_id, period, clock_seconds, payload, recorded_by, supersedes_id, position_seq, source_authority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [m.fixture_id, x.f.event_id, next.seq, i.client_key ?? null, next.kind, next.side, next.side ? x.f[`${next.side}_team_id`] : null, next.player_id, next.period, next.clock_seconds,
          JSON.stringify(next.payload ?? {}), user.id, cur.id, next.position_seq, authority])).rows[0];
      await c.query('UPDATE match_events SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1', [cur.id, user.id, `Corrected: ${i.reason}`]);
      await c.query("INSERT INTO match_event_revisions(fixture_id, match_event_id, replacement_id, action, authority, reason, before, after, actor_id) VALUES ($1,$2,$3,'correct',$4,$5,$6,$7,$8)",
        [m.fixture_id, cur.id, rep.id, authority, i.reason, JSON.stringify(cur), JSON.stringify(rep), user.id]);
      return rep;
    }));
    return { duplicate, event: out, state: await broadcast(m.fixture_id) };
  },
});

// ------------------------------------------------------------------ reading: history and projection
/** A game may be read when its event is not a draft and, for a private event, only by its organiser and participants (the same rule as every other public read). */
const visibleFixture = async (user, fixtureId) => {
  const f = (await pool.query('SELECT f.id, e.status AS es FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [fixtureId])).rows[0];
  if (!f || f.es === 'draft') throw notFound('Fixture');
  await assertFixtureReadable(user, fixtureId);
};
const pub = (e, official) => ({
  seq: e.seq, kind: e.kind, side: e.side, period: e.period, clock_seconds: e.clock_seconds, player_id: e.player_id, payload: e.payload, recorded_at: e.recorded_at,
  corrects_seq: e.supersedes_seq ?? null, voided: !!e.voided_at,
  ...(official ? { id: e.id, void_reason: e.void_reason ?? null, authority: e.source_authority ?? null, recorded_by: e.recorded_by } : {}),
});

cap({
  name: 'get_match_timeline', method: 'GET', path: '/fixtures/:id/timeline', tag: TAG, auth: 'public',
  summary: 'A game\'s event history, one bounded page at a time. Page forward with after_seq, or back from the newest with before_seq. Voided events and their reasons are only returned to the organiser and match officials; everyone else sees the events that count, with corrections marked.',
  input: z.object({ id, after_seq: z.coerce.number().int().min(0).optional(), before_seq: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  async handler({ user }, i) {
    await visibleFixture(user, i.id);
    const x = user ? await fixtureContext(user, i.id) : null;
    const official = !!x?.canScore;
    const back = i.before_seq != null;
    const rows = (await pool.query(
      `SELECT e.*, s.seq AS supersedes_seq FROM match_events e LEFT JOIN match_events s ON s.id=e.supersedes_id
        WHERE e.fixture_id=$1 AND ($2::int IS NULL OR e.seq > $2) AND ($3::int IS NULL OR e.seq < $3) ${official ? '' : 'AND e.voided_at IS NULL'}
        ORDER BY e.seq ${back ? 'DESC' : 'ASC'} LIMIT $4`, [i.id, i.after_seq ?? null, i.before_seq ?? null, i.limit + 1])).rows;
    const more = rows.length > i.limit;
    const page = rows.slice(0, i.limit);
    if (back) page.reverse();
    const last = (await pool.query('SELECT coalesce(max(seq),0) AS n, (SELECT count(*)::int FROM match_event_revisions WHERE fixture_id=$1) AS r FROM match_events WHERE fixture_id=$1', [i.id])).rows[0];
    const subs = i.after_seq || i.before_seq ? [] : (await pool.query('SELECT id, team_id, player_off_id, player_on_id, period, clock_seconds FROM match_substitutions WHERE fixture_id=$1 AND voided_at IS NULL ORDER BY clock_seconds, id', [i.id])).rows;
    const events = official ? page.map((e) => pub(e, true)) : (await redactForPublic({ events: page.map((e) => pub(e, false)) }, null)).events;
    const okSubs = official ? null : await publiclyNameable(subs.flatMap((r) => [r.player_off_id, r.player_on_id]), null);
    return {
      events,
      has_more: more, next_after_seq: !back && page.length ? page[page.length - 1].seq : null, prev_before_seq: back || i.after_seq == null ? (page[0]?.seq ?? null) : null,
      last_seq: last.n, version: last.n + last.r,
      substitutions: official ? subs : subs.filter((r) => okSubs.has(r.player_off_id) && okSubs.has(r.player_on_id)),
    };
  },
});

cap({
  name: 'get_live_projection', method: 'GET', path: '/fixtures/:id/projection', tag: TAG, auth: 'public',
  summary: 'The sport-specific live view of a game, safe for spectators: the score state the sport plugin derives (cricket innings, run rates, target and partnerships; tennis games and sets; football periods, cards and shoot-out; rally sets and server), whether it is scheduled, live, provisional, final or corrected, the pinned ruleset, and a cursor/version for reconnecting. Missing data is absent, never estimated.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await visibleFixture(user, i.id);
    const x = user ? await fixtureContext(user, i.id) : null;
    const st = await liveState(i.id, null, { limit: 1 });
    const { ruleset } = await rulesetForEvent(st.fixture.event_id, null, i.id);
    const logged = (await loggedEvents(i.id)).filter((e) => !e.voided_at);
    const plugin = pluginFor(ruleset);
    const score = plugin.state(ruleset, logged);
    const subs = (await pool.query('SELECT team_id, player_off_id, player_on_id, period, clock_seconds FROM match_substitutions WHERE fixture_id=$1 AND voided_at IS NULL ORDER BY clock_seconds, id', [i.id])).rows;
    const lease = x?.canScore ? (await pool.query("SELECT l.user_id, u.display_name, l.device, l.expires_at FROM fixture_scorer_leases l JOIN users u ON u.id=l.user_id WHERE l.fixture_id=$1 AND l.expires_at > now()", [i.id])).rows[0] ?? null : undefined;
    const staff = !!x?.canScore;
    const okIds = staff ? null : await publiclyNameable([...score.shootout?.sequence?.map((k) => k.player_id) ?? [], ...(score.sent_off ?? []).map((p) => p.player_id), ...plugin.attribution(ruleset, logged).map((p) => p.player_id), ...subs.flatMap((r) => [r.player_off_id, r.player_on_id])], null);
    const view = staff ? { projection: plugin.publicView(score), stats: plugin.liveStats(ruleset, logged, score), players: plugin.attribution(ruleset, logged) } : await redactForPublic({ projection: plugin.publicView(score), stats: plugin.liveStats(ruleset, logged, score), players: plugin.attribution(ruleset, logged).filter((p) => p.player_id == null || okIds.has(p.player_id)) }, null);
    return {
      fixture: st.fixture, live: st.live, version: st.version, last_seq: st.last_seq,
      ruleset: { kind: ruleset.kind, label: ruleset.label, source: st.ruleset.source, version: st.ruleset.version, format_key: st.ruleset.format_key },
      phase: st.phase, projection: view.projection, stats: view.stats,
      players: view.players, substitutions: staff ? subs : subs.filter((r) => okIds.has(r.player_off_id) && okIds.has(r.player_on_id)),
      viewer: { can_score: !!x?.canScore, organiser: !!x?.organiser, manages: x?.side ?? null },
      ...(lease !== undefined ? { scorer: lease } : {}),
    };
  },
});

// ------------------------------------------------------------------ advisory scorer lease
cap({
  name: 'claim_scorer_lease', method: 'POST', path: '/fixtures/:id/scorer-lease', tag: TAG,
  summary: 'Tell the other officials you are scoring this game (organiser or match official). It lasts 90 seconds; call again to keep it. It is a hint for the screen, not a lock: the server still orders every event and refuses illegal ones. Another official\'s active lease is only taken over by the organiser, with takeover=true.',
  input: z.object({ id, device: z.string().max(60).optional(), takeover: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needScorer(x);
      if (['completed', 'cancelled'].includes(x.f.status)) throw conflict(`The game is ${x.f.status}`);
      const cur = (await c.query('SELECT l.*, u.display_name FROM fixture_scorer_leases l JOIN users u ON u.id=l.user_id WHERE l.fixture_id=$1 FOR UPDATE OF l', [i.id])).rows[0];
      if (cur && cur.user_id !== user.id && new Date(cur.expires_at) > new Date()) {
        if (!i.takeover) throw conflict(`${cur.display_name} is scoring this game`, { code: 'lease_held', holder: { user_id: cur.user_id, display_name: cur.display_name, expires_at: cur.expires_at } });
        if (!x.organiser) throw forbidden('Only the organiser can take over from another scorer');
      }
      return (await c.query(
        `INSERT INTO fixture_scorer_leases(fixture_id, user_id, device, claimed_at, expires_at) VALUES ($1,$2,$3,now(), now() + $4 * interval '1 second')
         ON CONFLICT (fixture_id) DO UPDATE SET user_id=$2, device=$3, claimed_at=CASE WHEN fixture_scorer_leases.user_id=$2 THEN fixture_scorer_leases.claimed_at ELSE now() END, expires_at=now() + $4 * interval '1 second'
         RETURNING fixture_id, user_id, device, claimed_at, expires_at`, [i.id, user.id, i.device ?? null, LEASE_SECONDS])).rows[0];
    });
  },
});

cap({
  name: 'release_scorer_lease', method: 'POST', path: '/fixtures/:id/scorer-lease/release', tag: TAG,
  summary: 'Stop showing yourself as the scorer of this game. The lease ends now; nothing is deleted.', input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needScorer(x);
      const r = await c.query('UPDATE fixture_scorer_leases SET expires_at=now() WHERE fixture_id=$1 AND user_id=$2 AND expires_at > now()', [i.id, user.id]);
      return { released: r.rowCount > 0 };
    });
  },
});

// ------------------------------------------------------------------ sessions: heats, finals and field flights
async function sessionContext(user, sessionId, c, { lock = false } = {}) {
  const s = await mustSession(c, sessionId, lock);
  const d = await discipline(c, s.discipline_id);
  const { ev, scope } = await eventAccess(c, user, s.event_id);
  const assigned = await isAssignedOfficial(c, user.id, s.id);
  const organiser = !!scope.organizer;
  return { s, d, ev, organiser, assigned, canScore: organiser || assigned, authority: isAdmin(user) ? 'admin' : organiser ? 'organiser' : 'official' };
}

/** Organiser or assigned official of a session, resolved live (used by the scorer stream's re-check). */
export async function canScoreSession(user, sessionId) {
  const s = (await pool.query('SELECT event_id FROM event_sessions WHERE id=$1', [sessionId])).rows[0];
  if (!s) return false;
  const { scope } = await eventAccess(pool, user, s.event_id);
  return !!scope.organizer || (await isAssignedOfficial(pool, user.id, sessionId));
}

const progressionOf = (d) => {
  const p = d.progression ?? {};
  return { ...(p.qualifiers_per_session != null ? { qp: p.qualifiers_per_session, qt: p.wildcards ?? 0 } : {}), ...(p.cut_after_round != null ? { cut_after_round: p.cut_after_round, cut_to: p.cut_to } : {}) };
};
const sessionRows = async (c, sessionId) => (await c.query('SELECT * FROM session_events WHERE session_id=$1 ORDER BY seq', [sessionId])).rows;
const toEvents = (rows) => rows.map((r) => ({ ...r, payload: { ...(r.payload ?? {}), ...(r.entry_id ? { entry_id: r.entry_id } : {}) } }));
async function sessionConfig(c, s, d) {
  const entryIds = (await c.query("SELECT id FROM event_session_entries WHERE session_id=$1 AND result_status <> 'scratched' ORDER BY lane NULLS LAST, id", [s.id])).rows.map((r) => r.id);
  const hasAttempts = (await c.query("SELECT 1 FROM session_events WHERE session_id=$1 AND kind='attempt' AND voided_at IS NULL LIMIT 1", [s.id])).rowCount > 0;
  const field = hasAttempts || (d.result_type === 'distance');
  return { resultType: d.result_type, entryIds, field, progression: progressionOf(d) };
}

/** The public live view of one session (names follow the programme's privacy setting for this viewer). */
export async function sessionLive(sessionId, user = null, { sinceSeq = 0, limit = 50, includeVoided = false } = {}) {
  const s = (await pool.query('SELECT s.*, d.name AS discipline, d.result_type, d.mode, d.progression, ev.status AS event_status FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id JOIN events ev ON ev.id=s.event_id WHERE s.id=$1', [sessionId])).rows[0];
  if (!s || s.event_status === 'draft') throw notFound('Session');
  const rows = await sessionRows(pool, sessionId);
  const live = toEvents(rows);
  const cfg = await sessionConfig(pool, s, s);
  const state = sessionPlugin.state(cfg, live);
  const { prog, scope } = await viewer(user, s.event_id);
  const names = new Map((await entryRows(pool, sessionId, scope, prog)).map((e) => [e.id, e]));
  const lastSeq = rows.reduce((n, r) => Math.max(n, r.seq), 0);
  const voided = rows.filter((r) => r.voided_at);
  const base = s.status === 'completed' ? (s.corrected_at ? 'corrected' : 'final')
    : state.status === 'provisional' ? 'provisional' : s.status === 'live' || state.started || state.status !== 'scheduled' ? 'live' : 'scheduled';
  const view = sessionPlugin.publicView(state);
  return {
    session: { id: s.id, event_id: s.event_id, label: s.label, stage: s.stage, round: s.round, status: s.status, scheduled_at: s.scheduled_at, discipline: s.discipline, result_type: s.result_type, mode: s.mode },
    live: { state: base, provisional: base !== 'final' && base !== 'corrected', corrected: base === 'corrected' },
    projection: { ...view, entries: view.entries.map((e) => ({ ...e, name: names.get(e.entry_id)?.full_name ?? names.get(e.entry_id)?.team_name ?? null, house: names.get(e.entry_id)?.house ?? null })) },
    qualified: state.qualified, last_seq: lastSeq, version: lastSeq,
    voided_seqs: voided.map((r) => r.seq),
    events: rows.filter((r) => r.seq > sinceSeq && (includeVoided || !r.voided_at)).slice(-limit).map((r) => ({ seq: r.seq, kind: r.kind, entry_id: r.entry_id, payload: r.payload, recorded_at: r.recorded_at, voided: !!r.voided_at, ...(includeVoided ? { id: r.id, void_reason: r.void_reason, authority: r.source_authority } : {}) })),
  };
}
const broadcastSession = async (sessionId) => { const st = await sessionLive(sessionId); publish(`session:${sessionId}`, st); return st; };

cap({
  name: 'get_live_session', method: 'GET', path: '/sessions/:id/live', tag: TAG, auth: 'public',
  summary: 'Live status of a heat, final or field flight: call room / ready / in progress / provisional, lanes, splits, finishes or attempts, provisional places and (only where the organiser pinned progression rules) Q/q or the field cut. Everything is provisional until the official result is recorded. Poll with since_seq or stream /live/sessions/:id.',
  input: z.object({ id, since_seq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(50) }),
  async handler({ user }, i) {
    const probe = (await pool.query('SELECT s.event_id FROM event_sessions s WHERE s.id=$1', [i.id])).rows[0];
    if (!probe) throw notFound('Session');
    await assertEventReadable(user, probe.event_id);
    const canScore = user ? await canScoreSession(user, i.id) : false;
    return { ...(await sessionLive(i.id, user, { sinceSeq: i.since_seq, limit: i.limit, includeVoided: canScore })), viewer: { can_score: canScore } };
  },
});

cap({
  name: 'log_session_event', method: 'POST', path: '/sessions/:id/events', tag: TAG, status: 201,
  summary: 'Record what happened in a heat, final or field flight (organiser, or the official assigned to the session): status (call_room, ready, in_progress), start, lane, split, finish, attempt (valid / foul / pass) or entry_status (dns, dnf, dq). Positions are derived, never typed. Send a client_key to make retries safe and expected_seq to be told with 409 stale_state if someone else has recorded since. The official result is only written by finalize_session_live / record_session_results.',
  input: z.object({
    id, kind: z.enum(SESSION_KINDS), entry_id: id.optional(), payload: z.record(z.string(), z.any()).default({}),
    client_key: z.string().min(1).max(80).optional(), expected_seq: z.number().int().min(0).optional(),
  }),
  async handler({ user }, i) {
    let duplicate = false, stale = null;
    const row = await serialized(`session:${i.id}`, () => tx(async (c) => {
      const x = await sessionContext(user, i.id, c, { lock: true });
      needScorer(x);
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM session_events WHERE session_id=$1 AND client_key=$2', [i.id, i.client_key])).rows[0];
        if (dup) { duplicate = true; return dup; }
      }
      if (['cancelled', 'completed'].includes(x.s.status)) throw conflict(`The session is ${x.s.status}; re-record its result with record_session_results to correct it`);
      if (x.ev.status === 'cancelled') throw conflict('Event is cancelled');
      const rows = await sessionRows(c, i.id);
      const lastSeq = rows.reduce((n, r) => Math.max(n, r.seq), 0);
      if (i.expected_seq != null && i.expected_seq < lastSeq) { stale = lastSeq; return null; }
      const cfg = await sessionConfig(c, x.s, x.d);
      const state = sessionPlugin.state(cfg, toEvents(rows));
      const payload = { ...i.payload, ...(i.entry_id ? { entry_id: i.entry_id } : {}) };
      const bad = sessionPlugin.validate(cfg, state, { kind: i.kind, payload });
      if (bad) throw badRequest(bad);
      const { entry_id, ...rest } = payload;
      if (i.kind === 'lane') await c.query('UPDATE event_session_entries SET lane=$2 WHERE id=$1 AND session_id=$3 AND result_status <> \'scratched\'', [entry_id, rest.lane, i.id]);
      if (x.s.status !== 'live') await c.query("UPDATE event_sessions SET status='live' WHERE id=$1 AND status IN ('draft','scheduled')", [i.id]);
      return (await c.query(
        `INSERT INTO session_events(session_id, event_id, seq, client_key, kind, entry_id, payload, source_authority, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [i.id, x.s.event_id, lastSeq + 1, i.client_key ?? null, i.kind, entry_id ?? null, JSON.stringify(rest), x.authority, user.id])).rows[0];
    }));
    if (stale != null) throw conflict('The session has moved on since you last looked; review the current state and send the event again', { code: 'stale_state', last_seq: stale, expected_seq: i.expected_seq, state: await sessionLive(i.id, user, { includeVoided: true }) });
    return { duplicate, event: row, state: await broadcastSession(i.id) };
  },
});

cap({
  name: 'void_session_event', method: 'POST', path: '/session-events/:id/void', tag: TAG,
  summary: 'Cancel a wrongly recorded session event with a reason (organiser, or the assigned official, while the session is not completed). It stays in the log, marked void, and the live state is recomputed from the remaining events.',
  input: z.object({ id, reason: z.string().min(2).max(300) }),
  async handler({ user }, i) {
    const m = (await pool.query('SELECT session_id FROM session_events WHERE id=$1', [i.id])).rows[0];
    if (!m) throw notFound('Session event');
    await tx(async (c) => {
      const x = await sessionContext(user, m.session_id, c, { lock: true });
      needScorer(x);
      if (x.s.status === 'completed') throw conflict('The session is completed; re-record its result with record_session_results to correct it');
      const cur = (await c.query('SELECT voided_at FROM session_events WHERE id=$1', [i.id])).rows[0];
      if (cur.voided_at) throw conflict('Already voided');
      await c.query('UPDATE session_events SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1', [i.id, user.id, i.reason]);
    });
    return broadcastSession(m.session_id);
  },
});

cap({
  name: 'finalize_session_live', method: 'POST', path: '/sessions/:id/finalize-live', tag: TAG,
  summary: 'Turn the live record of a heat, final or field flight into its official result (organiser, or the assigned official). It hands the derived marks to record_session_results, so the same checks, ranking and tie rules apply; competitors with no result yet stop it. Re-running after a correction re-records the result.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const x = await sessionContext(user, i.id, c, { lock: true });
      needScorer(x);
      const rows = await sessionRows(c, i.id);
      const results = sessionPlugin.toResult(sessionPlugin.state(await sessionConfig(c, x.s, x.d), toEvents(rows)));
      if (!results.length) throw badRequest('Nothing has been recorded yet');
      return recordSessionResults(c, user, { id: i.id, complete: true, results });
    });
    return { ...out, live: await broadcastSession(i.id) };
  },
});

// ------------------------------------------------------------------ pinned progression
cap({
  name: 'set_discipline_progression', method: 'PATCH', path: '/disciplines/:id/progression', tag: TAG,
  summary: 'Pin how athletes progress in a discipline (organiser): heats send qualifiers_per_session through plus `wildcards` fastest/best of the rest; a field event cuts to cut_to after cut_after_round rounds. The live session view shows Q/q and the cut from this and from nothing else; advance_discipline uses it as its default.',
  input: z.object({ id, qualifiers_per_session: z.number().int().min(1).max(24).optional(), wildcards: z.number().int().min(0).max(48).optional(), cut_after_round: z.number().int().min(1).max(12).optional(), cut_to: z.number().int().min(1).max(64).optional() })
    .refine((v) => (v.cut_after_round == null) === (v.cut_to == null), 'Give cut_after_round and cut_to together'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await discipline(c, i.id);
      await organizerOnly(c, user, d.event_id);
      const { id: _id, ...p } = i;
      return (await c.query('UPDATE event_disciplines SET progression=$2 WHERE id=$1 RETURNING id, progression', [i.id, JSON.stringify(p)])).rows[0];
    });
  },
});
