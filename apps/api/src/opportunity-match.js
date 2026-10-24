// Explainable opportunity matching (issue #316). A pure, deterministic scorer: it compares what a player has stated with what
// an opportunity states and says, rule by rule, whether it fits, does not fit, or cannot be told because someone has not
// entered the data yet. Unknown is never turned into a match or a mismatch, and nothing here reads the database.

export const DIMENSIONS = ['position', 'level', 'region', 'availability', 'cost', 'eligibility'];
export const KINDS = ['team_opening', 'competition', 'study', 'sponsor'];

const WEIGHT = { sport: 3, eligibility: 3, position: 2, level: 2, region: 1.5, availability: 1.5, cost: 1 };
const norm = (s) => String(s ?? '').trim().toLowerCase();
const tokens = (s) => String(s ?? '').split(/[,/;]/).map(norm).filter(Boolean);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

/** Who can supply missing data, and where in the app. */
const fixPlayer = (where) => ({ who: 'player', where });
const fixOrganiser = { who: 'organiser', where: 'The organiser has not stated this yet' };

const rule = (dimension, code, status, detail, fix) => ({ dimension, rule: code, status, detail, ...(fix && status === 'unknown' ? { fix } : {}) });

export function checkSport(s, o) {
  if (!o.sport_slug) return rule('eligibility', 'sport', 'na', 'Open to any sport');
  if (s.profile) return rule('eligibility', 'sport', 'match', `You have a ${o.sport_name ?? o.sport_slug} card`);
  if (s.prefs.sport_slugs.includes(o.sport_slug)) return rule('eligibility', 'sport', 'match', `${o.sport_name ?? o.sport_slug} is in your preferences`);
  return rule('eligibility', 'sport', 'mismatch', `You have no ${o.sport_name ?? o.sport_slug} card and it is not in your preferences`);
}

export function checkPosition(s, o) {
  if (o.kind !== 'team_opening') return rule('position', 'position', 'na', 'Positions do not apply');
  if (!o.positions.length) return rule('position', 'position', 'unknown', 'The post does not say which positions it needs', fixOrganiser);
  const mine = [...new Set([...(s.profile?.positions ?? []), s.profile?.position].map(norm).filter(Boolean))];
  if (!mine.length) return rule('position', 'position', 'unknown', `Needs ${o.positions.join(' / ')}; your card has no position`, fixPlayer('SportProfile'));
  const hit = o.positions.find((p) => mine.includes(norm(p)));
  return hit ? rule('position', 'position', 'match', `You play ${hit}`) : rule('position', 'position', 'mismatch', `Needs ${o.positions.join(' / ')}; you play ${mine.join(' / ')}`);
}

export function checkLevel(s, o) {
  if (o.kind === 'sponsor') return rule('level', 'level', 'na', 'Level does not apply');
  if (!o.levels.length) return rule('level', 'level', 'unknown', 'The listing does not state a level', fixOrganiser);
  const lvl = s.profile?.level;
  if (!lvl) return rule('level', 'level', 'unknown', `Looks for ${o.levels.join(' / ')}; your card has no level`, fixPlayer('SportProfile'));
  return o.levels.includes(lvl) ? rule('level', 'level', 'match', `Your level (${lvl}) is one it looks for`) : rule('level', 'level', 'mismatch', `Looks for ${o.levels.join(' / ')}; your card says ${lvl}`);
}

export function checkRegion(s, o) {
  const mine = [...new Set([s.profile?.region, ...s.prefs.regions].flatMap(tokens))];
  if (o.kind === 'sponsor') {
    if (!o.regions.length) return rule('region', 'region', 'match', 'No region restriction');
    if (!mine.length) return rule('region', 'region', 'unknown', `Funds applicants in ${o.regions.join(', ')}; you have not stated a region`, fixPlayer('SportProfile'));
    const want = o.regions.flatMap(tokens);
    return mine.some((t) => want.includes(t)) ? rule('region', 'region', 'match', 'Your region is one it funds') : rule('region', 'region', 'mismatch', `Funds applicants in ${o.regions.join(', ')} only`, null);
  }
  const theirs = tokens(o.region);
  if (!theirs.length) return rule('region', 'region', 'unknown', 'The listing does not state a region', fixOrganiser);
  if (!mine.length) return rule('region', 'region', 'unknown', `Is in ${o.region}; you have not stated a region`, fixPlayer('SportProfile'));
  if (mine.some((t) => theirs.includes(t))) return rule('region', 'region', 'match', `In ${o.region}`);
  if (s.prefs.open_to.includes('relocation')) return rule('region', 'region', 'match', `In ${o.region}, outside your region, but you are open to relocation`);
  return rule('region', 'region', 'mismatch', `In ${o.region}, outside your region`);
}

const inWindow = (w, date) => {
  const d = day(date);
  if (!d || d < day(w.from_date) || d > day(w.to_date)) return false;
  if (w.weekdays?.length) return w.weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  return true;
};

export function checkAvailability(s, o) {
  if (o.kind === 'sponsor') return rule('availability', 'availability', 'na', 'A funding call has a deadline, not a date to attend');
  const date = o.starts_on;
  if (!date) return rule('availability', 'availability', 'unknown', 'No date has been published', fixOrganiser);
  const wins = s.windows.filter((w) => !o.window_kinds || o.window_kinds.includes(w.kind));
  if (!wins.length) return rule('availability', 'availability', 'unknown', `Is on ${day(date)}; you have not added when you are available`, fixPlayer('PassportRecruitment'));
  return wins.some((w) => inWindow(w, date)) ? rule('availability', 'availability', 'match', `${day(date)} falls in a window you marked available`) : rule('availability', 'availability', 'mismatch', `${day(date)} is outside the windows you marked available`);
}

export function checkCost(s, o) {
  if (o.cost_unstated) return rule('cost', 'cost', 'unknown', 'The programme does not state its fee', fixOrganiser);
  if (!o.cost) return rule('cost', 'cost', 'na', 'No cost to you');
  const { cents, currency } = o.cost;
  if (cents === 0) return rule('cost', 'cost', 'match', 'Free to enter');
  const { budget_cents: budget, budget_currency: cur } = s.prefs;
  if (budget == null) return rule('cost', 'cost', 'unknown', `Costs ${(cents / 100).toFixed(2)} ${currency}; you have not set a budget`, fixPlayer('PassportRecruitment'));
  if (cur !== currency) return rule('cost', 'cost', 'unknown', `Costs ${currency} and your budget is in ${cur}; amounts are never converted`, fixPlayer('PassportRecruitment'));
  return cents <= budget ? rule('cost', 'cost', 'match', `Costs ${(cents / 100).toFixed(2)} ${currency}, within your budget`) : rule('cost', 'cost', 'mismatch', `Costs ${(cents / 100).toFixed(2)} ${currency}, above your budget of ${(budget / 100).toFixed(2)}`);
}

export function checkEligibility(s, o, now) {
  const out = [];
  if (o.min_age != null || o.max_age != null) {
    const band = `${o.min_age ?? ''}–${o.max_age ?? ''}`.replace(/^–/, 'up to ').replace(/–$/, '+');
    if (s.age == null) out.push(rule('eligibility', 'age', 'unknown', `For ages ${band}; your date of birth is not on your account`, fixPlayer('Settings')));
    else if ((o.min_age != null && s.age < o.min_age) || (o.max_age != null && s.age > o.max_age)) out.push(rule('eligibility', 'age', 'mismatch', `For ages ${band}`));
    else out.push(rule('eligibility', 'age', 'match', `Your age is within ${band}`));
  }
  if (o.deadline_at) {
    out.push(new Date(o.deadline_at) > now ? rule('eligibility', 'deadline', 'match', `Open until ${new Date(o.deadline_at).toISOString()}`) : rule('eligibility', 'deadline', 'mismatch', 'Applications have closed'));
  }
  if (o.kind === 'sponsor') {
    if (o.target_types?.length && !o.target_types.includes('athlete')) out.push(rule('eligibility', 'target', 'mismatch', `Funds ${o.target_types.join(', ')} only, not individual athletes`));
    if (s.youth) out.push(rule('eligibility', 'youth', 'mismatch', 'Applications for athletes under the age of independence are not accepted here; a guardian-led process is required'));
    if (o.verified_only) out.push(s.verified ? rule('eligibility', 'verification', 'match', 'You hold a verified badge') : rule('eligibility', 'verification', 'mismatch', 'Only verified applicants are funded; you have no verified badge'));
  }
  return out;
}

/** @param s subject {age, youth, verified, profile, prefs, windows}  @param o opportunity (see capabilities/opportunity-matching.js)  @param now Date */
export function evaluate(s, o, now = new Date()) {
  const rules = [checkSport(s, o),checkPosition(s, o), checkLevel(s, o), checkRegion(s, o), checkAvailability(s, o), checkCost(s, o), ...checkEligibility(s, o, now)]
    .filter((r) => r.status !== 'na');
  const known = rules.filter((r) => r.status === 'match' || r.status === 'mismatch');
  const w = (r) => WEIGHT[r.rule === 'sport' ? 'sport' : r.dimension] ?? 1;
  const total = known.reduce((n, r) => n + w(r), 0);
  const score = total ? Math.round((100 * known.filter((r) => r.status === 'match').reduce((n, r) => n + w(r), 0)) / total) : null;
  const hard = (r) => r.status === 'mismatch' && (r.dimension === 'eligibility' || (o.kind === 'sponsor' && r.dimension === 'region'));
  const eligible = !rules.some(hard);
  const fit = !eligible ? 'ineligible' : score == null ? 'unknown' : score >= 75 ? 'strong' : score >= 50 ? 'possible' : 'weak';
  return {
    eligible, fit, score, checks: { known: known.length, total: rules.length },
    rules,
    missing: rules.filter((r) => r.status === 'unknown').map((r) => ({ dimension: r.dimension, rule: r.rule, detail: r.detail, ...r.fix })),
  };
}

const FIT_ORDER = { strong: 0, possible: 1, weak: 2, unknown: 3, ineligible: 4 };
/** Deterministic order: fit group, then score, then soonest date, then id. */
export const compareMatches = (a, b) =>
  FIT_ORDER[a.fit] - FIT_ORDER[b.fit] || (b.score ?? -1) - (a.score ?? -1)
  || String(a.opportunity.date ?? '9999').localeCompare(String(b.opportunity.date ?? '9999')) || (a.opportunity.id < b.opportunity.id ? -1 : 1);
