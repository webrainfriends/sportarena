// Single-elimination bracket structure: standard 1-vs-N seeding, byes for the top seeds when the field is not a power of two,
// winners feed forward, semi-final losers optionally feed a third-place match.
export const ROUND_KINDS = { 2: 'final', 4: 'semi', 8: 'quarter', 16: 'round_of_16', 32: 'round_of_32' };
export const ROUND_LABEL = { final: 'Final', semi: 'Semi-final', quarter: 'Quarter-final', round_of_16: 'Round of 16', round_of_32: 'Round of 32', third_place: 'Third place' };
export const MAX_KNOCKOUT_TEAMS = 32;

/** Seed numbers by bracket position: [1,8,4,5,2,7,3,6] for 8. Consecutive pairs meet in round one. */
export function seedOrder(size) {
  let o = [1];
  while (o.length < size) { const n = o.length * 2; o = o.flatMap((s) => [s, n + 1 - s]); }
  return o;
}

const nextPow2 = (n) => { let s = 2; while (s < n) s *= 2; return s; };

/**
 * @param {string[]} teams team ids ordered best seed first
 * @returns {{size:number, fixtures:{key:string, round_kind:string, slot:number, round_index:number, home:string|null, away:string|null,
 *   home_placeholder:string|null, away_placeholder:string|null, win_feeds:{key:string, side:'home'|'away'}|null, lose_feeds:{key:string, side:'home'|'away'}|null}[], byes:string[]}}
 */
export function buildBracket(teams, { thirdPlace = false } = {}) {
  const n = teams.length;
  if (n < 2) throw new Error('A knockout needs at least 2 teams');
  if (n > MAX_KNOCKOUT_TEAMS) throw new Error(`A knockout supports at most ${MAX_KNOCKOUT_TEAMS} teams`);
  const size = nextPow2(n), order = seedOrder(size);
  const teamAt = (seed) => (seed <= n ? teams[seed - 1] : null);
  const rounds = [];
  for (let r = 0, count = size / 2; count >= 1; r++, count /= 2) rounds.push({ kind: ROUND_KINDS[count * 2], count });
  const key = (r, s) => `${rounds[r].kind}:${s}`;
  const fixtures = new Map(), byes = [];
  // round one (some matches are byes: the present seed walks into round two)
  const advance = []; // winners already known after round one
  for (let s = 0; s < rounds[0].count; s++) {
    const a = teamAt(order[2 * s]), b = teamAt(order[2 * s + 1]);
    if (a && b) fixtures.set(key(0, s), { key: key(0, s), round_kind: rounds[0].kind, slot: s, round_index: 0, home: a, away: b, home_placeholder: null, away_placeholder: null, win_feeds: null, lose_feeds: null });
    else { advance[s] = a ?? b; byes.push(a ?? b); }
  }
  for (let r = 1; r < rounds.length; r++) {
    for (let s = 0; s < rounds[r].count; s++) {
      const f = { key: key(r, s), round_kind: rounds[r].kind, slot: s, round_index: r, home: null, away: null, home_placeholder: null, away_placeholder: null, win_feeds: null, lose_feeds: null };
      for (const side of ['home', 'away']) {
        const fromSlot = 2 * s + (side === 'home' ? 0 : 1);
        const feeder = fixtures.get(key(r - 1, fromSlot));
        if (feeder) { feeder.win_feeds = { key: f.key, side }; f[`${side}_placeholder`] = `Winner ${ROUND_LABEL[feeder.round_kind]} ${fromSlot + 1}`; }
        else if (r === 1) f[side] = advance[fromSlot]; // a bye
      }
      fixtures.set(f.key, f);
    }
  }
  const semis = rounds.length >= 2 && rounds[rounds.length - 2].kind === 'semi' ? [0, 1].map((k) => fixtures.get(key(rounds.length - 2, k))) : [];
  if (thirdPlace && semis.length === 2 && semis.every(Boolean)) { // with a bye in the semi-finals there is no third-place match
    const t = { key: 'third_place:0', round_kind: 'third_place', slot: 0, round_index: rounds.length - 1, home: null, away: null, home_placeholder: null, away_placeholder: null, win_feeds: null, lose_feeds: null };
    ['home', 'away'].forEach((side, k) => {
      const semi = semis[k];
      semi.lose_feeds = { key: t.key, side };
      t[`${side}_placeholder`] = `Loser ${ROUND_LABEL.semi} ${k + 1}`;
    });
    fixtures.set(t.key, t);
  }
  return { size, fixtures: [...fixtures.values()], byes };
}

/** Keys a fixture must wait for (its feeders), used to order the schedule. */
export function dependenciesOf(fixtures) {
  const deps = new Map(fixtures.map((f) => [f.key, []]));
  for (const f of fixtures) for (const x of [f.win_feeds, f.lose_feeds]) if (x) deps.get(x.key).push(f.key);
  return deps;
}
