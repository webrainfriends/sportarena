// The bracket as spectators and organisers read it: every stage of an event as sections of rounds (or Swiss rounds, pool tables, series),
// always projected from the canonical fixtures; nothing here is stored. Draft stages are only shown to organisers.
import { many } from '../db.js';
import { ROUND_LABEL } from './bracket.js';
import { swissStandings, DEFAULT_SWISS } from './formats/swiss.js';
import { poolTable, qualifiers, DEFAULT_POOLS } from './formats/pools.js';
import { doubleElimPlacements } from './formats/double-elim.js';
import { tieState } from './advance.js';

const KO_ORDER = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final'];
const SECTION_LABEL = { main: 'Main bracket', winners: 'Winners bracket', losers: 'Losers bracket', grand_final: 'Grand final', repechage: 'Repechage', placement: 'Placement games', consolation: 'Consolation bracket' };
const SECTION_ORDER = ['main', 'winners', 'losers', 'grand_final', 'repechage', 'consolation', 'placement'];
const stateOf = (f) => (f.status === 'cancelled' ? (f.void_reason === 'not_required' ? 'not_required' : 'cancelled') : ({ live: 'live', paused: 'live', finished: 'provisional', completed: 'final' }[f.status] ?? 'scheduled'));

const FIXTURES = `SELECT f.id, f.stage_id, f.round, f.round_kind, f.bracket_side, f.round_no, f.pool, f.tie_id, f.leg_no, f.leg_swap, f.conditional, f.void_reason, f.bracket_slot AS slot, f.status,
    f.scheduled_at, f.duration_min, f.home_team_id, f.away_team_id, f.home_score, f.away_score, f.winner_team_id, f.home_placeholder, f.away_placeholder, f.win_feeds_fixture_id, f.lose_feeds_fixture_id,
    h.name AS home_name, h.emoji AS home_emoji, a.name AS away_name, a.emoji AS away_emoji, r.name AS resource_name, ve.timezone AS venue_timezone
  FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues ve ON ve.id=r.venue_id
 WHERE f.stage_id = ANY($1) AND (f.status <> 'cancelled' OR f.void_reason = 'not_required') ORDER BY f.scheduled_at, f.bracket_slot, f.id`;

const gameOf = (f) => ({ ...f, state: stateOf(f), not_required: f.status === 'cancelled' });

/** Collapse the games of a tie into one bracket node carrying the series / aggregate state. */
function nodeOf(tie, games, names) {
  const ordered = games.slice().sort((x, y) => x.leg_no - y.leg_no);
  const st = tieState(tie, games.map((g) => ({ ...g })));
  const name = (id) => names.get(id) ?? null;
  const first = ordered[0];
  return {
    id: first.id, tie_id: tie.id, round: tie.config.label ?? first.round, round_kind: first.round_kind, bracket_side: first.bracket_side, round_no: first.round_no, slot: first.slot,
    status: ordered.every((g) => g.status === 'cancelled') ? 'cancelled' : st.decided ? 'completed' : ordered.some((g) => ['live', 'paused'].includes(g.status)) ? 'live' : ordered.some((g) => g.status === 'completed') ? 'live' : 'scheduled',
    state: st.decided ? 'final' : ordered.some((g) => ['live', 'paused'].includes(g.status)) ? 'live' : ordered.some((g) => g.status === 'completed') ? 'provisional' : 'scheduled',
    scheduled_at: ordered.find((g) => g.status !== 'cancelled' && g.status !== 'completed')?.scheduled_at ?? first.scheduled_at, venue_timezone: first.venue_timezone,
    home_team_id: tie.a_team_id, away_team_id: tie.b_team_id, home_name: name(tie.a_team_id), away_name: name(tie.b_team_id),
    home_emoji: ordered.find((g) => g.home_team_id === tie.a_team_id)?.home_emoji ?? ordered.find((g) => g.away_team_id === tie.a_team_id)?.away_emoji ?? null,
    away_emoji: ordered.find((g) => g.home_team_id === tie.b_team_id)?.home_emoji ?? ordered.find((g) => g.away_team_id === tie.b_team_id)?.away_emoji ?? null,
    home_placeholder: first.leg_swap ? first.away_placeholder : first.home_placeholder, away_placeholder: first.leg_swap ? first.home_placeholder : first.away_placeholder,
    home_score: tie.kind === 'best_of' ? st.a : st.a, away_score: tie.kind === 'best_of' ? st.b : st.b, winner_team_id: tie.winner_team_id,
    tie: { id: tie.id, kind: tie.kind, config: tie.config, status: tie.status, method: tie.method, needed: st.needed ?? null, needs_decider: !!st.needs_decider, legs_played: st.legs_played ?? st.played ?? 0, summary: tie.kind === 'best_of' ? `Best of ${tie.config.best_of}: ${st.a}–${st.b}` : `Aggregate ${st.a}–${st.b}${st.complete ? '' : ` after ${st.legs_played} of ${st.legs} legs`}`,
      games: ordered.map((g) => ({ id: g.id, leg_no: g.leg_no, status: g.status, state: stateOf(g), scheduled_at: g.scheduled_at, home_score: g.home_score, away_score: g.away_score, home_team_id: g.home_team_id, away_team_id: g.away_team_id, winner_team_id: g.winner_team_id, not_required: g.status === 'cancelled' })) },
  };
}

function roundsOf(nodes, order) {
  const by = new Map();
  for (const n of nodes) {
    const key = n.bracket_side === 'main' && order ? n.round_kind : `${n.round_no ?? 0}`;
    const label = n.bracket_side === 'main' ? (ROUND_LABEL[n.round_kind] ?? n.round) : n.round_kind === 'grand_final' ? n.round : (n.round ?? '').replace(/\s\d+$/, '');
    if (!by.has(key)) by.set(key, { key, label, round_no: n.round_no ?? 0, games: [] });
    by.get(key).games.push(n);
  }
  const rounds = [...by.values()];
  if (order) rounds.sort((x, y) => KO_ORDER.indexOf(x.key) - KO_ORDER.indexOf(y.key) || x.round_no - y.round_no);
  else rounds.sort((x, y) => x.round_no - y.round_no);
  rounds.forEach((r) => r.games.sort((x, y) => (x.slot ?? 0) - (y.slot ?? 0)));
  return rounds;
}

function statusOf(stage, fx) {
  if (!stage.published_at) return 'draft';
  const live = fx.filter((f) => f.status !== 'cancelled');
  if (live.length && live.every((f) => f.status === 'completed')) return 'completed';
  if (live.some((f) => f.status !== 'scheduled')) return 'in_progress';
  return 'published';
}

export async function stageViews(eventId, { organiser = false } = {}) {
  const stages = await many(`SELECT * FROM event_stages WHERE event_id=$1 ${organiser ? '' : 'AND published_at IS NOT NULL'} ORDER BY position, created_at`, [eventId]);
  if (!stages.length) return [];
  const ids = stages.map((s) => s.id);
  const [fixtures, ties, conflicts, revisions, teams] = await Promise.all([
    many(FIXTURES, [ids]),
    many('SELECT * FROM bracket_ties WHERE stage_id = ANY($1) AND key NOT LIKE \'%@retired:%\'', [ids]),
    organiser ? many("SELECT c.*, f.round AS fixture_round FROM bracket_conflicts c JOIN fixtures f ON f.id=c.fixture_id WHERE c.event_id=$1 AND c.status='open' ORDER BY c.created_at", [eventId]) : Promise.resolve([]),
    many('SELECT stage_id, count(*)::int AS n, max(created_at) AS last_at, max(version) AS version FROM bracket_revisions WHERE stage_id = ANY($1) GROUP BY stage_id', [ids]),
    many('SELECT id, name, emoji FROM teams WHERE id IN (SELECT home_team_id FROM fixtures WHERE event_id=$1 UNION SELECT away_team_id FROM fixtures WHERE event_id=$1)', [eventId]),
  ]);
  const names = new Map(teams.map((t) => [t.id, t.name]));
  const emojis = new Map(teams.map((t) => [t.id, t.emoji]));
  const out = [];
  for (const s of stages) {
    const fx = fixtures.filter((f) => f.stage_id === s.id);
    const status = statusOf(s, fx);
    const cfg = s.config ?? {};
    const rev = revisions.find((r) => r.stage_id === s.id);
    const view = {
      id: s.id, kind: s.kind, name: s.name, status, published_at: s.published_at, revision: s.revision, algorithm: s.algorithm, draw_seed: s.published_at || organiser ? s.draw_seed : null, parent_stage_id: s.parent_stage_id,
      locked: fx.some((f) => f.status !== 'scheduled' && f.status !== 'cancelled'), games: fx.filter((f) => f.status !== 'cancelled').length, played: fx.filter((f) => f.status === 'completed').length,
      audit: { entries: rev?.n ?? 0, version: rev?.version ?? 0, last_at: rev?.last_at ?? null },
      format: { third_place: !!cfg.third_place, reset: !!cfg.reset, placement_up_to: cfg.placement_up_to ?? null, consolation: !!cfg.consolation, tie: cfg.tie ?? null, repechage_template: cfg.repechage_template ?? null, swiss: cfg.swiss ?? null, pools: cfg.pools ?? null },
      conflicts: conflicts.filter((c) => c.stage_id === s.id), ...(organiser ? { field: cfg.field ?? [] } : {}),
      sections: [], pools: null, swiss: null, ties: [], placements: [],
    };
    const stageTies = ties.filter((t) => t.stage_id === s.id);
    const tieNodes = stageTies.map((t) => nodeOf(t, fx.filter((f) => f.tie_id === t.id), names));
    const singles = fx.filter((f) => !f.tie_id).map(gameOf);
    const nodes = [...singles, ...tieNodes];
    view.ties = tieNodes.map((n) => ({ id: n.tie_id, label: n.round, ...n.tie, home_name: n.home_name, away_name: n.away_name, winner_team_id: n.winner_team_id }));

    if (s.kind === 'knockout' || s.kind === 'double_elimination') {
      for (const side of SECTION_ORDER) {
        const part = nodes.filter((n) => (n.bracket_side ?? 'main') === side || (side === 'main' && !n.bracket_side && n.round_kind !== 'third_place'));
        const list = side === 'main' ? nodes.filter((n) => (n.bracket_side ?? 'main') === 'main' && n.round_kind !== 'third_place') : part;
        if (!list.length) continue;
        view.sections.push({ key: side, label: SECTION_LABEL[side], rounds: roundsOf(list, side === 'main') });
      }
      const third = nodes.find((n) => n.round_kind === 'third_place');
      if (third) view.third_place = third;
      const fin = nodes.find((n) => n.round_kind === 'final' || (n.round_kind === 'grand_final' && n.round_no === 1));
      const decisive = s.kind === 'double_elimination' ? nodes.filter((n) => n.round_kind === 'grand_final' && n.state === 'final').sort((a, b) => b.round_no - a.round_no)[0] : fin?.state === 'final' ? fin : null;
      if (decisive?.winner_team_id) {
        const wid = decisive.winner_team_id, lid = wid === decisive.home_team_id ? decisive.away_team_id : decisive.home_team_id;
        view.champion = { team_id: wid, name: names.get(wid), emoji: emojis.get(wid) };
        view.placements = s.kind === 'double_elimination'
          ? doubleElimPlacements(singles.map((f) => ({ ...f, round_no: f.round_no, winner_team_id: f.winner_team_id }))).map((p) => ({ place: p.place, team_id: p.team_id, name: names.get(p.team_id), shared: !!p.shared }))
          : [{ place: 1, team_id: wid, name: names.get(wid) }, { place: 2, team_id: lid, name: names.get(lid) }, ...(third?.winner_team_id ? [{ place: 3, team_id: third.winner_team_id, name: names.get(third.winner_team_id) }] : [])];
      }
    } else if (s.kind === 'swiss') {
      const sw = { ...DEFAULT_SWISS, ...(cfg.swiss ?? {}) };
      const field = cfg.field ?? [];
      const played = singles.filter((g) => g.status === 'completed').map((g) => ({ round: g.round_no, home: g.home_team_id, away: g.away_team_id, home_score: g.home_score, away_score: g.away_score }));
      const byes = Object.entries(cfg.swiss_state?.byes ?? {}).filter(([, t]) => t).map(([r, t]) => ({ round: Number(r), home: t, away: null }));
      const table = swissStandings(field, [...played, ...byes], { byePoints: sw.bye_points, tieBreaks: sw.tie_breaks }).map((r) => ({ ...r, name: names.get(r.team) ?? null, team_id: r.team }));
      const nRounds = Math.max(0, ...singles.map((g) => g.round_no ?? 0));
      view.swiss = { rounds_total: cfg.swiss_state?.rounds_total ?? sw.rounds, rounds_generated: nRounds, policy: sw.policy, tie_breaks: sw.tie_breaks,
        rounds: Array.from({ length: nRounds }, (_, k) => ({ round: k + 1, complete: singles.filter((g) => g.round_no === k + 1).every((g) => g.status === 'completed'), games: singles.filter((g) => g.round_no === k + 1).sort((x, y) => x.slot - y.slot), bye: cfg.swiss_state?.byes?.[k + 1] ? { team_id: cfg.swiss_state.byes[k + 1], name: names.get(cfg.swiss_state.byes[k + 1]) } : null })), table };
      view.next_round_ready = nRounds > 0 && nRounds < view.swiss.rounds_total && view.swiss.rounds[nRounds - 1].complete;
    } else if (s.kind === 'pools') {
      const pc = { ...DEFAULT_POOLS, ...(cfg.pools ?? {}) };
      const tables = {};
      view.pools = (cfg.pools_drawn ?? []).map((p) => {
        const games = singles.filter((g) => g.pool === p.name);
        const table = poolTable(p.teams, games.filter((g) => g.status === 'completed').map((g) => ({ home: g.home_team_id, away: g.away_team_id, home_score: g.home_score, away_score: g.away_score })), { tieBreaks: pc.tie_breaks })
          .map((r) => ({ ...r, team_id: r.team, name: names.get(r.team) ?? null }));
        tables[p.name] = table;
        return { name: p.name, teams: p.teams.map((t) => ({ team_id: t, name: names.get(t) ?? null, emoji: emojis.get(t) ?? null })), games: games.sort((x, y) => (x.round_no ?? 0) - (y.round_no ?? 0)), table, complete: games.every((g) => g.status === 'completed') };
      });
      view.pools_complete = view.pools.length > 0 && view.pools.every((p) => p.complete);
      view.qualifiers = view.pools_complete ? qualifiers(tables, pc).map((q) => ({ ...q, name: names.get(q.team) ?? null })) : [];
      view.child_stage_id = stages.find((x) => x.parent_stage_id === s.id)?.id ?? null;
    } else {
      view.rounds = roundsOf(singles.map((g) => ({ ...g, bracket_side: 'x' })), false);
    }
    out.push(view);
  }
  return out;
}
