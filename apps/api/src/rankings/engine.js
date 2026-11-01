// Deterministic ranking engine (#507). Pure: it takes evidence rows and a ranking version and returns who is ranked, who is not and why. It never
// reads the database, a clock or a subscription, so the same evidence and the same version always give the same table (reproducible), and a paid
// plan cannot move anyone because it is not an input.

export const RAPID_RESULTS = 8; // this many results by one person for one metric inside 24 hours is flagged for a human to look at

const day = 86400000;
const r4 = (n) => Math.round(n * 10000) / 10000;
const t = (d) => new Date(d).getTime();

export const REASONS = {
  duplicate: 'Duplicate of another result (same person, metric, value, date and event)',
  outside_window: 'Older than the ranking window',
  minutes_not_verified: 'Minutes played were not verified, so a per-90 rate cannot be computed',
  self_generated: 'Played between teams run by the same owner, which this ranking excludes',
};

function sortKey(a, b, dir) {
  if (a.score !== b.score) return dir === 'lower' ? a.score - b.score : b.score - a.score;
  if (a.first_on !== b.first_on) return a.first_on < b.first_on ? -1 : 1;
  if (a.sample_n !== b.sample_n) return b.sample_n - a.sample_n;
  return a.subject < b.subject ? -1 : 1;
}
const sameRank = (a, b) => a.score === b.score && a.first_on === b.first_on && a.sample_n === b.sample_n;

/**
 * @param {Array<{id,subject,value?,minutes?,event_id?,fixture_id?,on,points?,gf?,ga?,same_owner?}>} rows evidence
 * @param {object} v ranking version: formula_kind, aggregation, direction, min_samples, min_distinct_events, window_days, window_games, scope
 * @param {{ asOf: string|Date }} ctx
 */
export function computeRanking(rows, v, { asOf }) {
  const asOfT = t(asOf);
  const seen = new Map();
  const excluded = new Map(); // subject -> [{id, reason}]
  const keep = new Map();     // subject -> rows
  const flags = [];
  const drop = (r, reason) => { if (!excluded.has(r.subject)) excluded.set(r.subject, []); excluded.get(r.subject).push({ id: r.id, reason }); };

  const ordered = [...rows].sort((a, b) => (t(a.on) - t(b.on)) || (a.id < b.id ? -1 : 1));
  for (const r of ordered) {
    if (r.same_owner) { drop(r, 'self_generated'); flags.push({ kind: 'self_generated_fixtures', subject: r.subject, id: r.id, key: String(r.fixture_id ?? r.id) }); continue; }
    if (v.window_days && asOfT - t(r.on) > v.window_days * day) { drop(r, 'outside_window'); continue; }
    const dupKey = `${r.subject}|${r.event_id ?? ''}|${r.fixture_id ?? ''}|${String(r.on).slice(0, 10)}|${r.value ?? ''}`;
    if (v.formula_kind !== 'team_form' && seen.has(dupKey)) {
      drop(r, 'duplicate'); flags.push({ kind: 'duplicate_evidence', subject: r.subject, id: r.id, key: dupKey, with: seen.get(dupKey) }); continue;
    }
    seen.set(dupKey, r.id);
    if (v.formula_kind === 'per_90' && !(r.minutes > 0)) { drop(r, 'minutes_not_verified'); continue; }
    if (!keep.has(r.subject)) keep.set(r.subject, []);
    keep.get(r.subject).push(r);
  }

  // rapid activity: many results for one person inside any 24 hours — flagged, never auto-excluded
  if (v.formula_kind !== 'team_form') {
    for (const [subject, list] of keep) {
      for (let i = 0; i + RAPID_RESULTS - 1 < list.length; i++) {
        if (t(list[i + RAPID_RESULTS - 1].on) - t(list[i].on) < day) {
          flags.push({ kind: 'rapid_activity', subject, id: list[i].id, key: String(list[i].on).slice(0, 10), ids: list.slice(i, i + RAPID_RESULTS).map((x) => x.id) });
          break;
        }
      }
    }
  }

  const scoped = !!v.scope?.event_id;
  const entries = [];
  const ineligible = [];
  for (const [subject, list0] of keep) {
    let list = list0;
    if (v.window_games) list = [...list].sort((a, b) => (t(b.on) - t(a.on)) || (a.id < b.id ? -1 : 1)).slice(0, v.window_games);
    const events = new Set(list.map((r) => r.event_id ?? r.fixture_id ?? r.id));
    const reasons = [];
    if (list.length < v.min_samples) reasons.push({ code: 'below_min_samples', have: list.length, need: v.min_samples });
    if (!scoped && events.size < v.min_distinct_events) reasons.push({ code: 'too_few_events', have: events.size, need: v.min_distinct_events });
    const first_on = String(list.map((r) => r.on).sort()[0]).slice(0, 10);
    if (reasons.length) { ineligible.push({ subject, sample_n: list.length, events_n: events.size, reasons, evidence_ids: list.map((r) => r.id) }); continue; }
    let score;
    if (v.formula_kind === 'team_form') {
      const pts = list.reduce((s, r) => s + r.points, 0);
      const gd = list.reduce((s, r) => s + (r.gf - r.ga), 0);
      score = r4(pts / list.length);
      entries.push({ subject, score, gd_per_game: r4(gd / list.length), sample_n: list.length, events_n: events.size, first_on, evidence_ids: list.map((r) => r.id) });
      continue;
    }
    const vals = list.map((r) => Number(r.value));
    if (v.formula_kind === 'per_90') score = r4(vals.reduce((s, x) => s + x, 0) / list.reduce((s, r) => s + Number(r.minutes), 0) * 90);
    else if (v.formula_kind === 'per_match') score = r4(vals.reduce((s, x) => s + x, 0) / new Set(list.map((r) => r.fixture_id ?? r.event_id ?? r.id)).size);
    else if (v.aggregation === 'sum') score = r4(vals.reduce((s, x) => s + x, 0));
    else if (v.aggregation === 'mean') score = r4(vals.reduce((s, x) => s + x, 0) / vals.length);
    else if (v.aggregation === 'last') score = Number([...list].sort((a, b) => (t(b.on) - t(a.on)) || (a.id < b.id ? -1 : 1))[0].value);
    else score = v.direction === 'lower' ? Math.min(...vals) : Math.max(...vals);
    entries.push({ subject, score, sample_n: list.length, events_n: events.size, first_on, evidence_ids: list.map((r) => r.id) });
  }

  const dir = v.direction;
  entries.sort((a, b) => {
    const c = sortKey(a, b, dir);
    if (v.formula_kind === 'team_form' && a.score === b.score && a.gd_per_game !== b.gd_per_game) return b.gd_per_game - a.gd_per_game;
    return c;
  });
  let rank = 0;
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    const tied = prev && sameRank(prev, e) && (v.formula_kind !== 'team_form' || prev.gd_per_game === e.gd_per_game);
    e.rank = tied ? prev.rank : (rank = i + 1);
  });
  return { entries, ineligible, excluded, flags };
}

/** Human-readable formula, shown on every ranking and in "Why am I here?". */
export function describeFormula(v) {
  const win = v.window_days ? ` over the last ${v.window_days} days` : v.window_games ? ` over the last ${v.window_games} games` : '';
  switch (v.formula_kind) {
    case 'team_form': return `Points per game${win} (win/draw/loss points from each event), ties broken by goal difference per game, then more games.`;
    case 'rating': return `Verified skill level (1.0–7.0) from approved competition results only${win}; only reliable levels are ranked, ties broken by who reached it first, then more games.`;
    case 'per_90': return `${v.metric} per 90 verified minutes played${win}: total ${v.metric} ÷ total verified minutes × 90.`;
    case 'per_match': return `${v.metric} per match${win}: total ${v.metric} ÷ number of matches.`;
    default: return `${{ best: v.direction === 'lower' ? 'Lowest' : 'Highest', sum: 'Total', mean: 'Average', last: 'Most recent' }[v.aggregation]} ${v.metric}${win}.`;
  }
}
