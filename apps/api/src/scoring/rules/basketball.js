// Basketball-family rules derived from the event stream: team fouls and the bonus, personal fouls and fouling out, timeouts left and a target
// score (3x3). Pure: nothing here is estimated, every number comes from events the scorer tapped. Used for basketball, wheelchair
// basketball and 3x3 through the optional `basketball{}` block of the ruleset.
import { SIDES, otherSide } from '../basic.js';

const zero = () => ({ home: 0, away: 0 });

export function basketballState(rs, live) {
  const B = rs.basketball;
  if (!B) return null;
  let period = 0; // 0 until the first period starts
  const teamFouls = zero(), timeouts = new Map(), players = new Map();
  const used = (side, i) => timeouts.get(`${side}:${i}`) ?? 0;
  const window = (p) => B.timeouts.findIndex((w) => p >= w.from && p <= w.to);
  for (const e of live) {
    if (e.kind === 'period_start') { period = e.period ?? period + 1; teamFouls.home = 0; teamFouls.away = 0; continue; }
    if (!SIDES.includes(e.side)) continue;
    const p = e.period ?? (period || 1);
    if (e.kind === 'foul') {
      teamFouls[e.side]++;
      if (e.player_id) players.set(e.player_id, { player_id: e.player_id, side: e.side, fouls: (players.get(e.player_id)?.fouls ?? 0) + 1 });
    } else if (e.kind === 'timeout') {
      const w = window(p);
      if (w >= 0) timeouts.set(`${e.side}:${w}`, used(e.side, w) + 1);
    }
  }
  const w = window(period || 1);
  const left = (side) => (w < 0 ? null : Math.max(0, B.timeouts[w].allowed - used(side, w)));
  const fouledOut = B.player_fouls_out ? [...players.values()].filter((x) => x.fouls >= B.player_fouls_out).map(({ player_id, side }) => ({ player_id, side })) : [];
  // a side is "in the bonus" when its opponent has committed enough team fouls in this period
  const bonus = B.team_fouls_bonus ? { home: teamFouls.away >= B.team_fouls_bonus, away: teamFouls.home >= B.team_fouls_bonus } : { home: false, away: false };
  return {
    team_fouls: teamFouls, bonus, fouled_out: fouledOut,
    player_fouls: [...players.values()].sort((a, b) => b.fouls - a.fouls),
    timeouts_left: { home: left('home'), away: left('away') },
    target_score: B.target_score ?? null,
  };
}

/** Why `next` is illegal under the basketball rules, or null. Only unambiguous breaches are refused. */
export function basketballReject(rs, live, next) {
  const B = rs.basketball;
  if (!B || !SIDES.includes(next.side)) return null;
  const st = basketballState(rs, live);
  if (next.player_id && st.fouled_out.some((p) => p.player_id === next.player_id)) return 'That player has fouled out';
  if (next.kind === 'timeout' && st.timeouts_left[next.side] === 0) return `${next.side === 'home' ? 'Home' : 'Away'} has no timeouts left`;
  return null;
}

/** 3x3 ends as soon as a side reaches the target score. */
export const basketballOver = (rs, score) => !!rs.basketball?.target_score && (score.home >= rs.basketball.target_score || score.away >= rs.basketball.target_score);
export { otherSide };
