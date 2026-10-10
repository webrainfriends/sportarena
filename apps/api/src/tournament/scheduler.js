// Greedy, deterministic match scheduler. Pure: callers hand in the free slots (already net of venue hours, blocks, bookings and
// holidays) and any existing busy intervals per team; it returns who plays where and when, with no team or area double-booked.
const MIN = 60_000;

/**
 * @param {object} p
 * @param {{key:string, home?:string|null, away?:string|null, after?:string[]}[]} p.matches in priority order (earlier rounds first)
 * @param {{date:string, runs:{resourceId:string, slots:{start:Date,end:Date}[]}[]}[]} p.days ascending; slots are free and sorted
 * @param {number} p.durationMin minimum playing time of a match
 * @param {number} [p.restMin] gap a team needs between two of its games (and a dependent match needs after its feeders)
 * @param {number} [p.maxPerTeamPerDay]
 * @param {Map<string,{start:Date,end:Date}[]>} [p.teamBusy] games the teams already have elsewhere
 */
export function planSchedule({ matches, days, durationMin, restMin = 60, maxPerTeamPerDay = 1, teamBusy = new Map() }) {
  const placed = new Map(), unplaced = [];
  const busy = new Map([...teamBusy].map(([t, iv]) => [t, iv.map((x) => ({ start: +x.start, end: +x.end }))]));
  const perDay = new Map(); // `${team}|${date}` -> count
  const used = new Map();   // resourceId -> [{start,end}]
  const overlaps = (list, s, e) => list.some((x) => x.start < e && x.end > s);

  for (const m of matches) {
    const deps = m.after ?? [];
    const missing = deps.find((k) => !placed.has(k));
    if (missing) { unplaced.push({ key: m.key, reason: `waiting on ${missing}, which could not be scheduled` }); continue; }
    const notBefore = Math.max(0, ...deps.map((k) => +placed.get(k).end + restMin * MIN));
    const teams = [m.home, m.away].filter(Boolean);
    let hit = null, why = 'no free slot in the window';
    for (const day of days) {
      if (teams.some((t) => (perDay.get(`${t}|${day.date}`) ?? 0) >= maxPerTeamPerDay)) { why = 'teams already play the maximum games per day'; continue; }
      const cands = [];
      day.runs.forEach((run, ri) => {
        for (let i = 0; i < run.slots.length; i++) {
          const start = +run.slots[i].start; let end = +run.slots[i].end, j = i;
          while (end - start < durationMin * MIN && j + 1 < run.slots.length && +run.slots[j + 1].start === end) { j++; end = +run.slots[j].end; }
          if (end - start >= durationMin * MIN) cands.push({ resourceId: run.resourceId, start, end, ri });
        }
      });
      cands.sort((a, b) => a.start - b.start || a.ri - b.ri);
      for (const c of cands) {
        if (c.start < notBefore) { why = 'earlier rounds finish too late for the window'; continue; }
        if (overlaps(used.get(c.resourceId) ?? [], c.start, c.end)) continue;
        if (teams.some((t) => overlaps(busy.get(t) ?? [], c.start - restMin * MIN, c.end + restMin * MIN))) { why = 'teams are busy or need rest'; continue; }
        hit = { ...c, date: day.date }; break;
      }
      if (hit) break;
    }
    if (!hit) { unplaced.push({ key: m.key, reason: why }); continue; }
    const rec = { key: m.key, resource_id: hit.resourceId, start: new Date(hit.start), end: new Date(hit.end), date: hit.date, minutes: Math.round((hit.end - hit.start) / MIN) };
    placed.set(m.key, rec);
    (used.get(hit.resourceId) ?? used.set(hit.resourceId, []).get(hit.resourceId)).push({ start: hit.start, end: hit.end });
    for (const t of teams) {
      (busy.get(t) ?? busy.set(t, []).get(t)).push({ start: hit.start, end: hit.end });
      perDay.set(`${t}|${hit.date}`, (perDay.get(`${t}|${hit.date}`) ?? 0) + 1);
    }
  }
  return { placed: [...placed.values()], unplaced };
}

/** Circle-method round robin. Returns matches with `round` (1-based) in play order. */
export function roundRobinPairs(teams) {
  const slots = teams.length % 2 ? [...teams, null] : [...teams];
  const n = slots.length, out = [];
  for (let r = 0; r < n - 1; r++) {
    for (let k = 0; k < n / 2; k++) {
      const a = slots[k], b = slots[n - 1 - k];
      if (a && b) out.push({ round: r + 1, home: r % 2 ? b : a, away: r % 2 ? a : b });
    }
    slots.splice(1, 0, slots.pop());
  }
  return out;
}
