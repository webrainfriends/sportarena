// Repechage, placement (classification) and consolation. Repechage is driven by a versioned TEMPLATE, never a hard-coded sport:
// the template names who enters the second-chance ladder and how it ends; the organiser pins one on the stage. Entrants depend on who
// reaches the final, so the ladder is generated once both finalists are known, from the completed main-bracket games.
import { resolveGraph, WIN, LOSE, TEAM, EMPTY } from './graph.js';

export const REPECHAGE_TEMPLATES = {
  opponents_of_finalists_cross_bronze: {
    version: 1, label: 'Repechage: those beaten by a finalist; two bronze contests',
    description: 'Everyone who lost (before the semi-finals) to one of the two finalists plays a ladder in that finalist’s half. Each ladder winner then meets the semi-final loser from the other half for a bronze medal.',
    entry: 'lost_to_finalist', ending: 'cross_half_bronze', commonly_used_in: 'combat sports — confirm against your sport’s current rules',
  },
  opponents_of_finalists_single_bronze: {
    version: 1, label: 'Repechage: those beaten by a finalist; ladder winners meet for bronze',
    description: 'As above, but the two ladder winners play each other for a single bronze; the semi-final losers are placed with the ladder entrants.',
    entry: 'lost_to_finalist', ending: 'repechage_final', commonly_used_in: 'configure to match your competition rules',
  },
};
export const PLACEMENT_DEPTHS = [3, 4, 8, 16];

/** Which half of the draw (index of the semi-final) a fixture feeds, by following win_feeds to the semi-final. */
function halfOf(f, byId) {
  let cur = f;
  while (cur) {
    const next = cur.win_feeds_fixture_id ? byId.get(cur.win_feeds_fixture_id) : null;
    if (!next) return null;
    if (next.round_kind === 'final') return cur.id;
    cur = next;
  }
  return null;
}

/**
 * @param {object[]} rows main-bracket fixtures of the stage { id, round_kind, round_index, slot, status, home_team_id, away_team_id, winner_team_id, win_feeds_fixture_id }
 * @param {string} templateId
 * @returns {{ready:boolean, reason?:string, halves?:object[], graph?:{fixtures:object[]}, template:object}}
 */
export function repechageGraph(rows, templateId) {
  const tpl = REPECHAGE_TEMPLATES[templateId];
  if (!tpl) throw new Error(`Unknown repechage template "${templateId}"`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const final = rows.find((r) => r.round_kind === 'final');
  if (!final) return { ready: false, reason: 'The stage has no final', template: tpl };
  const semis = rows.filter((r) => r.round_kind === 'semi').sort((a, b) => a.slot - b.slot);
  if (semis.length !== 2 || semis.some((s) => s.status !== 'completed')) return { ready: false, reason: 'Both semi-finals must be completed before the repechage entrants are known', template: tpl };
  const halves = semis.map((s) => {
    const finalist = s.winner_team_id;
    const beaten = rows.filter((r) => r.status === 'completed' && r.winner_team_id === finalist && r.round_kind !== 'semi' && r.round_kind !== 'final' && halfOf(r, byId) === s.id)
      .sort((a, b) => a.round_index - b.round_index || a.slot - b.slot)
      .map((r) => ({ team: r.winner_team_id === r.home_team_id ? r.away_team_id : r.home_team_id, round_kind: r.round_kind, fixture_id: r.id }));
    const semiLoser = s.winner_team_id === s.home_team_id ? s.away_team_id : s.home_team_id;
    return { semi_id: s.id, finalist, entrants: beaten, semi_loser: semiLoser };
  });
  const nodes = [];
  const ladderEnd = halves.map((h, i) => {
    // ladder: entrants[0] v entrants[1], winner v entrants[2] ...
    let cur = h.entrants.length ? TEAM(h.entrants[0].team) : EMPTY;
    h.entrants.slice(1).forEach((e, k) => {
      const key = `RP${i + 1}:${k}`;
      nodes.push({ key, label: `Repechage ${i + 1}.${k + 1}`, round_kind: 'repechage', bracket_side: 'repechage', round_no: k + 1, slot: i, inputs: [cur, TEAM(e.team)] });
      cur = WIN(key);
    });
    return cur;
  });
  if (tpl.ending === 'cross_half_bronze') {
    halves.forEach((h, i) => nodes.push({ key: `BR:${i}`, label: `Bronze ${i + 1}`, round_kind: 'repechage', bracket_side: 'repechage', round_no: 90, slot: i, inputs: [ladderEnd[i], TEAM(halves[1 - i].semi_loser)] }));
  } else {
    const sl = halves.map((h) => TEAM(h.semi_loser));
    // semi-final losers are placed with the ladder entrants: each joins its own half's ladder end before the repechage final
    const ends = ladderEnd.map((e, i) => {
      const key = `RPX:${i}`;
      nodes.push({ key, label: `Repechage ${i + 1} decider`, round_kind: 'repechage', bracket_side: 'repechage', round_no: 80, slot: i, inputs: [e, sl[i]] });
      return WIN(key);
    });
    nodes.push({ key: 'BR:0', label: 'Bronze', round_kind: 'repechage', bracket_side: 'repechage', round_no: 99, slot: 0, inputs: ends });
  }
  const graph = resolveGraph(nodes);
  return { ready: true, halves, graph, template: tpl };
}

/**
 * Classification play-offs for a set of eliminated teams (refs from the main bracket, best-eliminated first). Pairs best v worst, winners play for
 * the better places, losers for the worse, recursively, so every team gets a final place.
 * @param {object[]} refs graph inputs ({lose:key}) in order
 * @param {number} startPlace first place this group fills (e.g. 5)
 */
export function classificationNodes(refs, startPlace, prefix = 'PL') {
  const size = (() => { let s = 2; while (s < refs.length) s *= 2; return s; })();
  const nodes = [];
  const go = (group, place, tag) => {
    if (group.length < 2) return;
    const padded = group.concat(Array(Math.max(0, (() => { let s = 2; while (s < group.length) s *= 2; return s; })() - group.length)).fill(EMPTY));
    const n = padded.length, winners = [], losers = [];
    for (let i = 0; i < n / 2; i++) {
      const key = `${prefix}${place}:${tag}${i}`;
      const last = n === 2;
      nodes.push({ key, label: last ? `Places ${place}–${place + 1}` : `Places ${place}–${place + n - 1} (${i + 1})`, round_kind: 'placement', bracket_side: 'placement', round_no: place, slot: i, inputs: [padded[i], padded[n - 1 - i]], place_from: place });
      winners.push(WIN(key)); losers.push(LOSE(key));
    }
    if (n > 2) { go(winners, place, `${tag}w`); go(losers, place + n / 2, `${tag}l`); }
  };
  go(refs.concat(Array(size - refs.length).fill(EMPTY)).filter((x, i) => i < refs.length || true), startPlace, '');
  return nodes;
}

/** Second-chance bracket for the teams that lose their first game: a seeded single elimination among them. */
export function consolationNodes(refs, prefix = 'CN') {
  let size = 2; while (size < refs.length) size *= 2;
  const padded = refs.concat(Array(size - refs.length).fill(EMPTY));
  const nodes = [];
  let prev = padded, round = 1;
  while (prev.length > 1) {
    const next = [];
    for (let i = 0; i < prev.length / 2; i++) {
      const key = `${prefix}${round}:${i}`;
      nodes.push({ key, label: prev.length === 2 ? 'Consolation final' : `Consolation R${round} ${i + 1}`, round_kind: 'placement', bracket_side: 'consolation', round_no: round, slot: i, inputs: [prev[i], prev[prev.length - 1 - i]] });
      next.push(WIN(key));
    }
    prev = next; round++;
  }
  return nodes;
}
