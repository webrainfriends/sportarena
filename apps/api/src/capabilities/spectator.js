// Public tournament & spectator experience (#501): the public projection of an event, game, table and bracket; following; share cards; fan engagement.
// Reads are `auth: 'public'` and return an allow-listed view of the canonical data (see ../spectator.js); REST, OpenAPI and MCP all share these definitions.
import { z } from 'zod';
import { cap, capabilities, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound, tooMany } from '../errors.js';
import { YOUTH_SQL } from '../youth.js';
import {
  ALERTS, REACTIONS, isYouthEvent, eventState, loadViewableEvent, loadViewableFixture, publicFixtures, publicStandings, bracketOf, placementsFor, supportersOf, publicMedia,
  publicLiveFrom, publicOfficials, publicStreams, spendAllowance, resultLabel,
} from '../spectator.js';
import { liveState } from '../scoring/state.js';
import { buildCard, CARD_TYPES, isIndexable } from '../share-cards.js';

const TAG = 'Public events';
const dt = z.string().datetime({ offset: true });
const FOLLOW_LIMIT = 200;
const WRITES_PER_HOUR = 60;
const DEFAULT_ALERTS = ['start', 'result', 'schedule'];

// ------------------------------------------------------------------ the public tournament page
cap({
  name: 'get_public_event', method: 'GET', path: '/public/events/:id', tag: TAG, auth: 'public',
  summary: 'The public page of an event, projected from the canonical event data: identity and organiser, sport(s), dates, venue, format, live / upcoming / completed state, live and next games, recent results, the table (labelled provisional or final), bracket, official awards, sponsor placements, approved media, races, registration and share links. Anyone can read it without signing in unless the organiser made the event unlisted (link only) or private (404 for outsiders). Young people are never named on a youth event.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { ev, role } = await loadViewableEvent(user, i.id);
    const youth = isYouthEvent(ev);
    const [org, organiser, venue, stages, disciplines, counts, entrants, awards, media, streams, followers, mine] = await Promise.all([
      ev.organisation_id ? one('SELECT id, name FROM organisations WHERE id=$1', [ev.organisation_id]) : null,
      one('SELECT id, display_name FROM users WHERE id=$1', [ev.organizer_id]),
      ev.venue_id ? one('SELECT id, name, city, address, emoji, timezone FROM venues WHERE id=$1', [ev.venue_id]) : null,
      many('SELECT name, kind FROM event_stages WHERE event_id=$1 ORDER BY position', [ev.id]),
      many('SELECT d.name, s.slug AS sport, s.emoji, d.mode FROM event_disciplines d JOIN sports s ON s.id=d.sport_id WHERE d.event_id=$1 ORDER BY d.name', [ev.id]),
      many("SELECT status, count(*)::int AS n FROM fixtures WHERE event_id=$1 GROUP BY status", [ev.id]),
      many(`SELECT e.id AS entry_id, t.id AS team_id, t.name, t.emoji, t.color, u.id AS user_id, u.display_name, u.handle FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id LEFT JOIN users u ON u.id=e.user_id AND NOT ${YOUTH_SQL}
             WHERE e.event_id=$1 AND e.status='accepted' ORDER BY coalesce(t.name, u.display_name) LIMIT 200`, [ev.id]),
      many(`SELECT a.id, a.name, a.kind, a.awarded_at, t.id AS team_id, t.name AS team_name, t.emoji AS team_emoji, u.id AS user_id, u.display_name, u.handle FROM awards a LEFT JOIN teams t ON t.id=a.team_id LEFT JOIN users u ON u.id=a.user_id AND NOT ${YOUTH_SQL}
             WHERE a.event_id=$1 AND (a.team_id IS NOT NULL OR u.id IS NOT NULL) ORDER BY a.awarded_at DESC LIMIT 50`, [ev.id]),
      publicMedia(ev.id, { limit: 12 }),
      publicStreams(ev.id, null),
      one("SELECT count(*)::int AS n FROM spectator_follows WHERE subject_type='event' AND subject_id=$1 AND removed_at IS NULL", [ev.id]),
      user ? one("SELECT id, alerts FROM spectator_follows WHERE user_id=$1 AND subject_type='event' AND subject_id=$2 AND removed_at IS NULL", [user.id, ev.id]) : null,
    ]);
    const by = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    const live = (by.live ?? 0) + (by.paused ?? 0);
    const state = eventState(ev, live);
    const liveIds = (await many("SELECT id FROM fixtures WHERE event_id=$1 AND status IN ('live','paused') ORDER BY started_at NULLS LAST LIMIT 12", [ev.id])).map((r) => r.id);
    const nextIds = (await many("SELECT id FROM fixtures WHERE event_id=$1 AND status='scheduled' AND scheduled_at >= now() - interval '2 hours' ORDER BY scheduled_at LIMIT 8", [ev.id])).map((r) => r.id);
    const recentIds = (await many("SELECT id FROM fixtures WHERE event_id=$1 AND status IN ('finished','completed') ORDER BY coalesce(finished_at, scheduled_at) DESC LIMIT 8", [ev.id])).map((r) => r.id);
    const [liveNow, next, recent, table, bracket, sponsors, supporters] = await Promise.all([
      liveIds.length ? publicFixtures(ev.id, { ids: liveIds }) : [],
      nextIds.length ? publicFixtures(ev.id, { ids: nextIds }) : [],
      recentIds.length ? publicFixtures(ev.id, { ids: recentIds }) : [],
      publicStandings(ev),
      bracketOf(ev.id),
      placementsFor(ev, { youth }),
      supportersOf(ev.id),
    ]);
    recent.sort((a, b) => new Date(b.scheduled_at) - new Date(a.scheduled_at));
    const racesCap = capabilities.find((c) => c.name === 'list_event_races');
    const races = racesCap ? (await racesCap.handler({ user }, { id: ev.id }).catch(() => [])).filter((r) => r.public ?? r.pub ?? true).map((r) => ({ id: r.id, name: r.name, sport: r.sport_name ?? r.sport, emoji: r.emoji, status: r.status })) : [];
    const spots = ev.capacity == null ? null : Math.max(ev.capacity - (await one("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status IN ('accepted','pending')", [ev.id])).n, 0);
    const regOpen = ev.status === 'open' && (!ev.registration_deadline || new Date(ev.registration_deadline) > new Date()) && (spots == null || spots > 0);
    return {
      event: {
        id: ev.id, name: ev.name, kind: ev.kind, status: ev.status, state, description: ev.description, banner_emoji: ev.banner_emoji,
        sport: { slug: ev.sport_slug, name: ev.sport, emoji: ev.sport_emoji }, disciplines, starts_on: ev.starts_on, ends_on: ev.ends_on, city: ev.city ?? venue?.city ?? null, region: ev.region, levels: ev.levels,
        min_age: ev.min_age, max_age: ev.max_age, youth, archived: !!ev.archived_at, visibility: ev.public_visibility, indexable: isIndexable(ev),
        organiser: { name: org?.name ?? organiser?.display_name ?? null, organisation_id: org?.id ?? null }, venue: venue ? { id: venue.id, name: venue.name, city: venue.city, address: venue.address, emoji: venue.emoji, timezone: venue.timezone } : null,
        format: { stages, points: { win: ev.points_win, draw: ev.points_draw, loss: ev.points_loss } },
      },
      registration: { open: regOpen, fee_cents: ev.entry_fee_cents, currency: ev.currency, deadline: ev.registration_deadline, capacity: ev.capacity, spots_left: spots, link: { screen: 'Event', id: ev.id } },
      tickets: null, // ticketing is not part of the platform yet; registration above is the only entry link
      fixtures: { counts: by, live: liveNow, next, recent },
      standings: table,
      bracket: { ...bracket, label: ev.status === 'completed' ? 'final' : 'provisional' },
      entrants: entrants.map((e) => (e.team_id ? { team_id: e.team_id, name: e.name, emoji: e.emoji, color: e.color } : { user_id: e.user_id, name: e.display_name, handle: e.handle })).filter((e) => e.name && !(youth && e.user_id)),
      awards: awards.filter((a) => !(youth && a.user_id)).map((a) => ({ id: a.id, name: a.name, kind: a.kind, awarded_at: a.awarded_at, team: a.team_id ? { id: a.team_id, name: a.team_name, emoji: a.team_emoji } : null, athlete: a.user_id ? { id: a.user_id, name: a.display_name, handle: a.handle } : null, official: true })),
      sponsors: { placements: sponsors, supporters },
      media, streams, races,
      engagement: { reactions: !!ev.public_reactions && !youth, mvp_vote: !!ev.public_mvp_vote && !youth },
      share: { card: { type: 'event', id: ev.id }, page_path: `/api/v1/share/events/${ev.id}` },
      follow: { followers: followers.n, mine: mine ? { id: mine.id, alerts: mine.alerts } : null },
      viewer: { role },
    };
  },
});

cap({
  name: 'list_public_fixtures', method: 'GET', path: '/public/events/:id/fixtures', tag: TAG, auth: 'public',
  summary: 'The schedule and results of an event as the public sees them: every game with its state (scheduled, live, full time = provisional, completed = final, cancelled, postponed), score, venue time zone, and whether it was rescheduled or corrected. Filter by team, status or time window.',
  input: z.object({ id, team_id: id.optional(), status: z.enum(['scheduled', 'live', 'paused', 'finished', 'completed', 'cancelled', 'postponed', 'abandoned']).optional(), from: dt.optional(), to: dt.optional(), ...page }),
  async handler({ user }, i) {
    const { ev } = await loadViewableEvent(user, i.id);
    const items = await publicFixtures(ev.id, { team_id: i.team_id ?? null, status: i.status ?? null, from: i.from ?? null, to: i.to ?? null, limit: i.limit, offset: i.offset });
    const total = (await one('SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1', [ev.id])).n;
    return { items, total, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'get_public_standings', method: 'GET', path: '/public/events/:id/standings', tag: TAG, auth: 'public',
  summary: 'The league table of an event with its honest label: provisional until the event is completed (games_to_finalise says how many games are not yet official), final afterwards. Rows are plain data so clients can render a table, not only a graphic.',
  input: z.object({ id }),
  async handler({ user }, i) { const { ev } = await loadViewableEvent(user, i.id); return publicStandings(ev); },
});

cap({
  name: 'get_public_bracket', method: 'GET', path: '/public/events/:id/bracket', tag: TAG, auth: 'public',
  summary: 'The knockout bracket as rounds of games (teams or "winner of …" placeholders, times, scores) plus the champion once the final is official. `list` is the same bracket as a flat, ordered list of games for readers that cannot use a drawn bracket.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { ev } = await loadViewableEvent(user, i.id);
    const b = await bracketOf(ev.id);
    const list = b.rounds.flatMap((r) => r.games.map((g) => ({ round: r.label, id: g.id, status: g.status, label: resultLabel(g.status), scheduled_at: g.scheduled_at, home: g.home_name ?? g.home_placeholder ?? 'To be decided', away: g.away_name ?? g.away_placeholder ?? 'To be decided',
      score: ['live', 'paused', 'finished', 'completed'].includes(g.status) ? { home: g.home_score, away: g.away_score } : null, winner_team_id: g.status === 'completed' ? g.winner_team_id : null })));
    return { label: ev.status === 'completed' ? 'final' : 'provisional', ...b, list };
  },
});

// ------------------------------------------------------------------ the live centre of one game
cap({
  name: 'get_public_fixture', method: 'GET', path: '/public/fixtures/:id', tag: TAG, auth: 'public',
  summary: 'The public live centre of a game, fed by the scoring engine: score and state (live / provisional full time / final), a timeline of public events, the players named in it (adults only, never on a youth event), officials where the organiser allows it, the stream reference, sponsor placements, approved media, fan reactions and MVP vote where the organiser enabled them, the correction history and share links. Poll it, or stream /live/public/fixtures/:id.',
  input: z.object({ id, refresh: z.coerce.boolean().default(false).describe('set on repeat reads (polling) so they are not counted as new sponsor exposure') }),
  async handler({ user }, i) {
    const { f, ev } = await loadViewableFixture(user, i.id);
    const youth = isYouthEvent(ev);
    const [row] = await publicFixtures(ev.id, { ids: [f.id], limit: 1 });
    const state = await liveState(f.id, null, { limit: 200 });
    const live = await publicLiveFrom(ev, state);
    const [officials, streams, media, sponsors, changes, followers, mine, reactions, myReaction] = await Promise.all([
      publicOfficials(ev, f.id), publicStreams(ev.id, f.id), publicMedia(ev.id, { fixtureId: f.id, limit: 12 }), placementsFor(ev, { fixtureId: f.id, youth, count: !i.refresh }),
      many(`SELECT id, kind, was_final, before, after, created_at FROM fixture_public_changes WHERE fixture_id=$1 AND kind IN ('result','schedule','status') AND (kind <> 'status' OR after->>'status' IN ('cancelled','postponed','abandoned')) ORDER BY id DESC LIMIT 20`, [f.id]),
      one("SELECT count(*)::int AS n FROM spectator_follows WHERE subject_type='fixture' AND subject_id=$1 AND removed_at IS NULL", [f.id]),
      user ? one("SELECT id, alerts FROM spectator_follows WHERE user_id=$1 AND subject_type='fixture' AND subject_id=$2 AND removed_at IS NULL", [user.id, f.id]) : null,
      ev.public_reactions && !youth ? many('SELECT emoji, count(*)::int AS n FROM fixture_reactions WHERE fixture_id=$1 GROUP BY emoji', [f.id]) : [],
      user && ev.public_reactions && !youth ? one('SELECT emoji FROM fixture_reactions WHERE fixture_id=$1 AND user_id=$2', [f.id, user.id]) : null,
    ]);
    const mvp = ev.public_mvp_vote && !youth ? await mvpView(f, user) : null;
    return {
      fixture: row, live, event: { id: ev.id, name: ev.name, sport: ev.sport, youth, state: eventState(ev, 0) },
      officials, streams, media, sponsors,
      corrections: changes.map((c) => ({ id: c.id, kind: c.kind, official_before: c.was_final, before: c.before, after: c.after, at: c.created_at })),
      engagement: { reactions: ev.public_reactions && !youth ? { enabled: true, counts: Object.fromEntries(REACTIONS.map((r) => [r, reactions.find((x) => x.emoji === r)?.n ?? 0])), mine: myReaction?.emoji ?? null, choices: REACTIONS } : { enabled: false },
        mvp_vote: mvp ?? { enabled: false } },
      share: { fixture: { type: 'fixture', id: f.id }, result: row.label === 'final' ? { type: 'result', id: f.id } : null, page_path: `/api/v1/share/fixtures/${f.id}` },
      follow: { followers: followers.n, mine: mine ? { id: mine.id, alerts: mine.alerts } : null },
    };
  },
});

/** The fan MVP vote of a game: candidates are the adults on the two teams; the result is labelled as a fan vote, never an official award. */
async function mvpView(f, user) {
  const teams = [f.home_team_id, f.away_team_id].filter(Boolean);
  const candidates = teams.length ? await many(
    `SELECT DISTINCT u.id, u.display_name, u.handle, u.avatar_emoji, m.team_id FROM team_members m JOIN users u ON u.id=m.user_id
      WHERE m.team_id = ANY($1) AND m.status='active' AND m.role IN ('captain','player') AND NOT ${YOUTH_SQL} ORDER BY u.display_name LIMIT 60`, [teams]) : [];
  const tally = await many('SELECT candidate_id, count(*)::int AS votes FROM fixture_mvp_votes WHERE fixture_id=$1 GROUP BY candidate_id', [f.id]);
  const mine = user ? (await one('SELECT candidate_id FROM fixture_mvp_votes WHERE fixture_id=$1 AND voter_id=$2', [f.id, user.id]))?.candidate_id ?? null : null;
  const open = ['live', 'paused', 'finished'].includes(f.status) || (f.status === 'completed' && f.finished_at && Date.now() - new Date(f.finished_at) < 24 * 3600 * 1000);
  return { enabled: true, open, official: false, label: 'Fan vote — not an official award', candidates: candidates.map((c) => ({ ...c, votes: tally.find((t) => t.candidate_id === c.id)?.votes ?? 0 })), mine };
}

// ------------------------------------------------------------------ share cards
cap({
  name: 'get_share_card', method: 'GET', path: '/public/share/:type/:id', tag: TAG, auth: 'public',
  summary: 'A public-safe share card for an event, a game, a final result, a table or an award: title, status label, summary lines, a deep link into the app, a server-rendered share page (with link-preview metadata) and an image. Built as an anonymous visitor would see it, so private events, drafts, young people and unfinished results produce no card (404 / 409), and a card stops working when the organiser withdraws the event.',
  input: z.object({ type: z.enum(CARD_TYPES), id }),
  async handler(_, i) {
    const card = await buildCard(i.type, i.id);
    const kind = { event: 'events', standings: 'events', fixture: 'fixtures', result: 'fixtures', award: 'awards' }[i.type];
    const target = i.type === 'fixture' || i.type === 'result' ? i.id : i.type === 'award' ? i.id : card.event_id;
    return { ...card, page_path: `/api/v1/share/${kind}/${target}`, image_path: `/api/v1/share/cards/${i.type}/${i.id}.svg` };
  },
});


cap({
  name: 'record_placement_click', method: 'POST', path: '/public/placements/:id/click', tag: TAG, auth: 'public',
  summary: 'Count a visitor following a sponsor placement\'s call to action and return where it leads. Only active placements of an accepted sponsorship on a visible event count; the click is a measured fact, nothing is estimated.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one(
      `SELECT p.id, p.cta_url, p.event_id, e.max_age FROM event_sponsor_placements p JOIN sponsorships ss ON ss.id=p.sponsorship_id AND ss.status='active' JOIN events e ON e.id=p.event_id
        WHERE p.id=$1 AND p.status='active' AND p.cta_url IS NOT NULL`, [i.id]);
    if (!p || (p.max_age != null && p.max_age < 18)) throw notFound('Placement');
    await loadViewableEvent(user, p.event_id); // a private event's placement is not reachable by outsiders
    await pool.query('INSERT INTO placement_daily_counts(placement_id, day, clicks) VALUES ($1, current_date, 1) ON CONFLICT (placement_id, day) DO UPDATE SET clicks = placement_daily_counts.clicks + 1', [p.id]);
    return { url: p.cta_url };
  },
});

// ------------------------------------------------------------------ following: subscribes to public alerts, grants nothing private
const subject = z.object({ subject_type: z.enum(['event', 'team', 'athlete', 'fixture']), subject_id: id, alerts: z.array(z.enum(ALERTS)).max(4).optional() });

async function checkFollowable(user, type, sid) {
  if (type === 'event') await loadViewableEvent(user, sid);
  else if (type === 'fixture') await loadViewableFixture(user, sid);
  else if (type === 'team') { if (!(await one('SELECT 1 AS x FROM teams WHERE id=$1', [sid]))) throw notFound('Team'); }
  else {
    // an athlete can be followed only if they are an adult athlete: a young person is never followable, and nobody else is a public subject
    const a = await one(`SELECT u.id FROM users u WHERE u.id=$1 AND 'athlete' = ANY(u.roles) AND NOT ${YOUTH_SQL}`, [sid]);
    if (!a) throw notFound('Athlete');
  }
}

cap({
  name: 'follow_subject', method: 'POST', path: '/me/follows', tag: 'Following', status: 201,
  summary: 'Follow an event, a team, an athlete (adults only) or a single game, and choose which alerts you want: start, score, result, schedule (default: start, result and schedule changes). Calling it again changes the alerts. Following only subscribes you to public alerts; it never grants access to a roster, health, finance or youth information.',
  input: subject,
  async handler({ user }, i) {
    await checkFollowable(user, i.subject_type, i.subject_id);
    return tx(async (c) => {
      const existing = (await c.query('SELECT id, alerts, removed_at FROM spectator_follows WHERE user_id=$1 AND subject_type=$2 AND subject_id=$3 FOR UPDATE', [user.id, i.subject_type, i.subject_id])).rows[0];
      if (!existing || existing.removed_at) {
        const n = (await c.query('SELECT count(*)::int AS n FROM spectator_follows WHERE user_id=$1 AND removed_at IS NULL', [user.id])).rows[0].n;
        if (n >= FOLLOW_LIMIT) throw conflict(`You can follow up to ${FOLLOW_LIMIT} things — unfollow one first`);
        if (!(await spendAllowance(c, user.id, 'follow', WRITES_PER_HOUR))) throw tooMany('Slow down — try again in a little while');
      }
      const alerts = i.alerts ?? (existing && !existing.removed_at ? existing.alerts : DEFAULT_ALERTS);
      return (await c.query(
        `INSERT INTO spectator_follows(user_id, subject_type, subject_id, alerts) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, subject_type, subject_id) DO UPDATE SET removed_at=NULL, updated_at=now(), alerts=$4 RETURNING id, subject_type, subject_id, alerts, created_at`,
        [user.id, i.subject_type, i.subject_id, alerts])).rows[0];
    });
  },
});

cap({
  name: 'unfollow_subject', method: 'DELETE', path: '/me/follows/:id', tag: 'Following', summary: 'Stop following (the follow is kept as ended history; alerts stop at once).', input: z.object({ id }),
  async handler({ user }, i) {
    if (!(await one('UPDATE spectator_follows SET removed_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 AND removed_at IS NULL RETURNING id', [i.id, user.id]))) throw notFound('Follow');
    return { ok: true };
  },
});

cap({
  name: 'list_my_follows', method: 'GET', path: '/me/follows', tag: 'Following', summary: 'What you follow, with the name of each event, team, athlete or game and your alert choices.', input: z.object({ subject_type: z.enum(['event', 'team', 'athlete', 'fixture']).optional() }),
  async handler({ user }, i) {
    const rows = await many("SELECT id, subject_type, subject_id, alerts, created_at FROM spectator_follows WHERE user_id=$1 AND removed_at IS NULL AND ($2::text IS NULL OR subject_type=$2) ORDER BY created_at DESC LIMIT 300", [user.id, i.subject_type ?? null]);
    const ids = (t) => rows.filter((r) => r.subject_type === t).map((r) => r.subject_id);
    const [events, teams, athletes, fixtures] = await Promise.all([
      many("SELECT id, name, status, banner_emoji, starts_on, public_visibility FROM events WHERE id = ANY($1)", [ids('event')]),
      many('SELECT id, name, emoji, color FROM teams WHERE id = ANY($1)', [ids('team')]),
      many(`SELECT u.id, u.display_name, u.handle, u.avatar_emoji FROM users u WHERE u.id = ANY($1) AND NOT ${YOUTH_SQL}`, [ids('athlete')]),
      many(`SELECT f.id, f.status, f.scheduled_at, f.event_id, e.name AS event_name, e.public_visibility, h.name AS home_name, a.name AS away_name FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id = ANY($1)`, [ids('fixture')]),
    ]);
    const find = (list, sid) => list.find((x) => x.id === sid);
    return rows.map((r) => {
      let label = null, extra = {};
      if (r.subject_type === 'event') { const e = find(events, r.subject_id); label = e?.name; extra = { status: e?.status, emoji: e?.banner_emoji }; }
      if (r.subject_type === 'team') { const t = find(teams, r.subject_id); label = t?.name; extra = { emoji: t?.emoji }; }
      if (r.subject_type === 'athlete') { const a = find(athletes, r.subject_id); label = a?.display_name; extra = { handle: a?.handle, emoji: a?.avatar_emoji }; }
      if (r.subject_type === 'fixture') { const f = find(fixtures, r.subject_id); label = f ? `${f.home_name ?? 'TBD'} v ${f.away_name ?? 'TBD'}` : null; extra = { status: f?.status, event_id: f?.event_id, event_name: f?.event_name, scheduled_at: f?.scheduled_at }; }
      return { ...r, label, ...extra };
    });
  },
});

// ------------------------------------------------------------------ fan engagement (organiser opt-in; one reaction / one vote per person; hourly allowance)
async function engagementFixture(user, fixtureId, flag) {
  const { f, ev } = await loadViewableFixture(user, fixtureId);
  if (isYouthEvent(ev) || !ev[flag]) throw conflict('The organiser has not enabled this for the event');
  return { f, ev };
}

cap({
  name: 'react_to_fixture', method: 'POST', path: '/public/fixtures/:id/reaction', tag: TAG, status: 201,
  summary: 'React to a game (fire, clap, wow, strong). One reaction per person per game; send another to change it. Only where the organiser enabled reactions; never on a youth event.',
  input: z.object({ id, reaction: z.enum(REACTIONS) }),
  async handler({ user }, i) {
    const { f } = await engagementFixture(user, i.id, 'public_reactions');
    if (f.status === 'scheduled') throw conflict('Reactions open when the game starts');
    return tx(async (c) => {
      if (!(await spendAllowance(c, user.id, 'reaction', WRITES_PER_HOUR))) throw tooMany('Slow down — try again in a little while');
      await c.query(`INSERT INTO fixture_reactions(fixture_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT (fixture_id, user_id) DO UPDATE SET emoji=$3, updated_at=now()`, [i.id, user.id, i.reaction]);
      const counts = (await c.query('SELECT emoji, count(*)::int AS n FROM fixture_reactions WHERE fixture_id=$1 GROUP BY emoji', [i.id])).rows;
      return { mine: i.reaction, counts: Object.fromEntries(REACTIONS.map((r) => [r, counts.find((x) => x.emoji === r)?.n ?? 0])) };
    });
  },
});

cap({
  name: 'vote_fixture_mvp', method: 'POST', path: '/public/fixtures/:id/mvp-vote', tag: TAG, status: 201,
  summary: 'Vote for the fan MVP of a game among the adult players of the two teams. One vote per person per game (send another to change it) while the game is live and for 24 hours after full time. Only where the organiser enabled MVP voting. It is a fan vote shown as such, never an official award or result.',
  input: z.object({ id, candidate_id: id }),
  async handler({ user }, i) {
    const { f } = await engagementFixture(user, i.id, 'public_mvp_vote');
    const view = await mvpView(f, user);
    if (!view.open) throw conflict('Voting is closed for this game');
    if (!view.candidates.some((c) => c.id === i.candidate_id)) throw badRequest('That player is not a candidate for this game');
    if (i.candidate_id === user.id) throw badRequest('You cannot vote for yourself');
    await tx(async (c) => {
      if (!(await spendAllowance(c, user.id, 'mvp_vote', WRITES_PER_HOUR))) throw tooMany('Slow down — try again in a little while');
      await c.query(`INSERT INTO fixture_mvp_votes(fixture_id, voter_id, candidate_id) VALUES ($1,$2,$3) ON CONFLICT (fixture_id, voter_id) DO UPDATE SET candidate_id=$3, updated_at=now()`, [i.id, user.id, i.candidate_id]);
    });
    return mvpView(f, user);
  },
});

