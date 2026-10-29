// A bracket as a graph of nodes whose inputs are teams, winners/losers of other nodes, or nothing (a bye). `resolveGraph` removes the
// nodes a bye makes impossible or trivial, rewires the rest, and returns fixtures in the same shape single-elimination uses
// (win_feeds / lose_feeds point at the one fixture a winner / loser goes to), so every format shares one persistence and progression path.
//
//   input:  { team: id } | { win: key } | { lose: key } | { empty: true } | { text: 'Pool A winner' }  (text = a named placeholder)
//   node:   { key, label, round_kind, bracket_side, round_no, slot, inputs: [a, b], conditional?, legs?, ... }

const EMPTY = { empty: true };
const isTeam = (x) => x && x.team;
const isEmpty = (x) => x && x.empty;

export function resolveGraph(nodes, { external = [] } = {}) {
  // `external` = fixtures that already exist (a main bracket): they count as real nodes other nodes may take winners/losers from.
  const ext = new Map(external.map((e) => [e.key, { key: e.key, label: e.label, inputs: [{ text: 'x' }, { text: 'x' }], external: true }]));
  const byKey = new Map([...ext, ...nodes.map((n) => [n.key, n])]);
  const memo = new Map();
  /** What a node is once byes are accounted for: 'void' (nobody plays), 'pass' (one side only: that side walks through) or 'real'. */
  const kindOf = (key) => {
    if (memo.has(key)) return memo.get(key);
    memo.set(key, 'real'); // cycles are a bug in the format builder; treat as real rather than recurse forever
    const n = byKey.get(key);
    const ins = n.inputs.map((x) => norm(x));
    const empties = ins.filter(isEmpty).length;
    const k = n.conditional ? 'real' : empties === 2 ? 'void' : empties === 1 ? 'pass' : 'real';
    memo.set(key, k);
    return k;
  };
  /** An input after following void / pass-through nodes. */
  function norm(x) {
    if (!x || x.empty || x.team || x.text) return x ?? EMPTY;
    const n = byKey.get(x.win ?? x.lose);
    if (!n) return EMPTY;
    const k = kindOf(n.key);
    if (k === 'real') return x;
    if (k === 'void') return EMPTY;
    // pass-through: a winner is whichever single side exists; a loser does not exist
    if (x.lose) return EMPTY;
    const only = n.inputs.map((i) => norm(i)).find((i) => !isEmpty(i));
    return only ?? EMPTY;
  }

  const real = nodes.filter((n) => kindOf(n.key) === 'real');
  const stubs = [...ext.values()];
  const placeholderOf = (x) => {
    if (x.text) return x.text;
    const n = byKey.get(x.win ?? x.lose);
    return `${x.win ? 'Winner' : 'Loser'} ${n.label}`;
  };
  const fixtures = new Map([...stubs.map((n) => [n.key, { key: n.key, win_feeds: null, lose_feeds: null, external: true }]), ...real.map((n) => [n.key, {
    key: n.key, label: n.label, round_kind: n.round_kind, bracket_side: n.bracket_side ?? null, round_no: n.round_no ?? null, slot: n.slot ?? 0, round_index: n.round_index ?? n.round_no ?? 0,
    home: null, away: null, home_placeholder: null, away_placeholder: null, win_feeds: null, lose_feeds: null,
    conditional: n.conditional ?? null, legs: n.legs ?? null, tie: n.tie ?? null, pool: n.pool ?? null,
  }])]);
  const byes = [];
  for (const n of real) {
    const f = fixtures.get(n.key);
    ['home', 'away'].forEach((side, k) => {
      const x = norm(n.inputs[k]);
      if (isTeam(x)) { f[side] = x.team; if (n.inputs[k]?.team == null) byes.push(x.team); }
      else if (x.text) f[`${side}_placeholder`] = x.text;
      else if (x.win || x.lose) {
        const src = fixtures.get(x.win ?? x.lose);
        const slot = x.win ? 'win_feeds' : 'lose_feeds';
        if (src[slot]) throw new Error(`Bracket graph: ${src.key} already ${slot === 'win_feeds' ? 'sends its winner' : 'sends its loser'} elsewhere`);
        src[slot] = { key: n.key, side };
        f[`${side}_placeholder`] = placeholderOf(x);
      } else f[`${side}_placeholder`] = 'Bye';
    });
  }
  const all = [...fixtures.values()];
  return {
    fixtures: all.filter((f) => !f.external), byes: [...new Set(byes)],
    externalFeeds: all.filter((f) => f.external).flatMap((f) => ['win_feeds', 'lose_feeds'].filter((k) => f[k]).map((k) => ({ from: f.key, slot: k, to: f[k] }))),
  };
}

export const WIN = (key) => ({ win: key });
export const LOSE = (key) => ({ lose: key });
export const TEAM = (id) => (id ? { team: id } : EMPTY);
export { EMPTY };
