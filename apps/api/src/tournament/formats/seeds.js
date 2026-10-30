// Seed validation before a draw is locked: warnings and blocking errors the organiser sees while editing, derived only from the field and its seeds.
import { seedOrder } from '../bracket.js';

/**
 * @param {{team_id:string, name:string, city?:string|null, seed:number|null, rating?:number, group?:string|null, protected?:boolean}[]} teams in seed order
 * @param {{format:string, pool_count?:number, min?:number, max?:number}} ctx
 * @returns {{ok:boolean, errors:{code:string,message:string}[], warnings:{code:string,message:string,teams?:string[]}[], first_round:{home:string,away:string|null}[]}}
 */
export function validateSeeds(teams, ctx = {}) {
  const errors = [], warnings = [];
  const n = teams.length;
  if (n < (ctx.min ?? 2)) errors.push({ code: 'field_too_small', message: `This format needs at least ${ctx.min ?? 2} teams; ${n} accepted.` });
  if (ctx.max && n > ctx.max) errors.push({ code: 'field_too_large', message: `This format supports at most ${ctx.max} teams; ${n} accepted.` });
  const seen = new Map();
  for (const t of teams) if (t.seed != null) { if (seen.has(t.seed)) errors.push({ code: 'duplicate_seed', message: `Seed ${t.seed} is held by both ${seen.get(t.seed)} and ${t.name}.` }); else seen.set(t.seed, t.name); }
  const unseeded = teams.filter((t) => t.seed == null);
  if (unseeded.length && unseeded.length < n) warnings.push({ code: 'unseeded', message: `${unseeded.length} team(s) have no seed and are placed after the seeded ones by rating.`, teams: unseeded.map((t) => t.team_id) });
  const seeds = [...seen.keys()].sort((a, b) => a - b);
  if (seeds.length && seeds[seeds.length - 1] > n) warnings.push({ code: 'seed_beyond_field', message: `Seed ${seeds[seeds.length - 1]} is higher than the number of teams (${n}); seeds are renumbered when the draw is built.` });
  const gaps = seeds.filter((s, i) => i > 0 && s !== seeds[i - 1] + 1);
  if (gaps.length) warnings.push({ code: 'seed_gap', message: 'Seeds have gaps; the draw uses their order, not the numbers.' });
  for (let i = 1; i < n; i++) if (teams[i].rating != null && teams[i - 1].rating != null && teams[i].rating > teams[i - 1].rating + 1e-9 && teams[i].seed != null && teams[i - 1].seed != null) {
    warnings.push({ code: 'seed_against_rating', message: `${teams[i].name} is rated higher than ${teams[i - 1].name}, who is seeded above them.`, teams: [teams[i].team_id, teams[i - 1].team_id] }); break;
  }

  // first-round pairs implied by the seeding (single/double elimination layout)
  const first = [];
  if (n >= 2) {
    let size = 2; while (size < n) size *= 2;
    const order = seedOrder(size);
    for (let s = 0; s < size / 2; s++) { const a = teams[order[2 * s] - 1], b = teams[order[2 * s + 1] - 1]; first.push({ home: a?.team_id ?? null, away: b?.team_id ?? null }); }
    const byes = first.filter((p) => !p.home || !p.away).length;
    if (byes && teams.slice(0, byes).some((t) => t.protected === false)) { /* byes always go to the top seeds by construction */ }
    if (byes) warnings.push({ code: 'byes', message: `${byes} first-round bye${byes === 1 ? '' : 's'}: the top ${byes} seed${byes === 1 ? '' : 's'} advance without playing.` });
    for (const p of first) {
      const a = teams.find((t) => t.team_id === p.home), b = teams.find((t) => t.team_id === p.away);
      if (a && b && a.city && b.city && a.city.toLowerCase() === b.city.toLowerCase() && ['knockout', 'double_elimination'].includes(ctx.format)) warnings.push({ code: 'same_city_round_one', message: `${a.name} and ${b.name} are from the same city and meet in round one.`, teams: [a.team_id, b.team_id] });
      if (a && b && a.group && a.group === b.group) warnings.push({ code: 'same_group_round_one', message: `${a.name} and ${b.name} come from the same group and meet in round one.`, teams: [a.team_id, b.team_id] });
    }
  }
  if (ctx.format === 'pools' && ctx.pool_count && n < ctx.pool_count * 2) errors.push({ code: 'pools_too_small', message: `${ctx.pool_count} pools need at least ${ctx.pool_count * 2} teams.` });
  if (ctx.format === 'pools' && ctx.pool_count && n % ctx.pool_count) warnings.push({ code: 'uneven_pools', message: 'Pools have different sizes; wildcards are ranked on points per game.' });
  return { ok: !errors.length, errors, warnings, first_round: first };
}
