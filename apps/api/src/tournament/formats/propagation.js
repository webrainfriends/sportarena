// When an official result changes, which later games does it touch? Only games that have not started may be re-filled automatically;
// a game already live or played keeps what happened and is raised for an explicit decision. Pure: callers pass fixture rows.
const STARTED = new Set(['live', 'paused', 'finished', 'completed']);

/**
 * @param {object[]} rows all fixtures of the stage { id, status, home_team_id, away_team_id, winner_team_id, win_feeds_fixture_id, win_feeds_side, lose_feeds_fixture_id, lose_feeds_side, round, scheduled_at }
 * @param {string} fixtureId the corrected fixture
 * @param {{winner:string, loser:string}} next the corrected outcome
 * @returns {{auto:object[], needs_resolution:object[], blocked_downstream:object[], unchanged:boolean}}
 */
export function correctionImpact(rows, fixtureId, next) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const src = byId.get(fixtureId);
  const auto = [], needs = [], blocked = [], seen = new Set();
  const visit = (f, winner, loser) => {
    for (const [fid, side, team] of [[f.win_feeds_fixture_id, f.win_feeds_side, winner], [f.lose_feeds_fixture_id, f.lose_feeds_side, loser]]) {
      if (!fid || seen.has(`${fid}:${side}`)) continue;
      seen.add(`${fid}:${side}`);
      const t = byId.get(fid);
      if (!t) continue;
      const current = t[`${side}_team_id`];
      if (current === team) continue; // nothing changes here
      const row = { fixture_id: t.id, round: t.round, side, from_team_id: current ?? null, to_team_id: team, status: t.status, scheduled_at: t.scheduled_at };
      if (STARTED.has(t.status)) { needs.push({ ...row, reason: t.status === 'completed' ? 'Already played with the earlier line-up' : 'In progress with the earlier line-up' }); blockedBelow(t); }
      else auto.push(row);
    }
  };
  // games below a started game cannot be judged until the organiser decides about it
  const blockedBelow = (t) => {
    for (const fid of [t.win_feeds_fixture_id, t.lose_feeds_fixture_id]) {
      const d = fid && byId.get(fid);
      if (d && !blocked.some((b) => b.fixture_id === d.id)) { blocked.push({ fixture_id: d.id, round: d.round, status: d.status, reason: 'Depends on a game that needs a decision first' }); blockedBelow(d); }
    }
  };
  if (!src) return { auto, needs_resolution: needs, blocked_downstream: blocked, unchanged: true };
  const sameOutcome = src.winner_team_id === next.winner;
  if (!sameOutcome) visit(src, next.winner, next.loser);
  return { auto, needs_resolution: needs, blocked_downstream: blocked, unchanged: sameOutcome };
}
