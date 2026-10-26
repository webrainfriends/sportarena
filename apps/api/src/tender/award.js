// Award scenarios (pure). A scenario allocates lots (and quantities) to ranked, eligible suppliers under constraints and reports
// allocation, evaluated cost, coverage, unfilled lots and why. Small instances are solved exhaustively and reported as proven optimal;
// larger ones use a documented greedy heuristic that is never presented as a global optimum.
//
// lots:   [{ code, qty, estimate_minor|null }]
// offers: [{ entity, score (ranking total), capacity_ok, lots: { [code]: { unit_cost_minor, cost_minor (full lot), capacity } } }]
// constraints: { max_suppliers, min_score, budget_minor, max_exposure_minor, min_coverage_lots, kind }
const EXHAUSTIVE_LIMIT = 200000;

export const SCENARIO_KINDS = ['highest_score', 'lowest_cost', 'single_supplier', 'split_by_lot'];

const objective = (kind, alloc, offers) => {
  const cost = alloc.reduce((a, x) => a + x.cost_minor, 0);
  const scoreSum = alloc.reduce((a, x) => a + offers.find((o) => o.entity === x.entity).score, 0);
  return kind === 'lowest_cost' ? -cost : scoreSum * 1e6 - cost / 1e3; // higher is better; cost only breaks score ties
};

function check(alloc, lots, c, offers) {
  const violations = [];
  const entities = new Set(alloc.map((a) => a.entity));
  const cost = alloc.reduce((a, x) => a + x.cost_minor, 0);
  if (c.max_suppliers && entities.size > c.max_suppliers) violations.push(`more than ${c.max_suppliers} suppliers`);
  if (c.budget_minor !== undefined && c.budget_minor !== null && cost > c.budget_minor) violations.push('over budget');
  if (c.max_exposure_minor) for (const e of entities) if (alloc.filter((a) => a.entity === e).reduce((s, x) => s + x.cost_minor, 0) > c.max_exposure_minor) violations.push('supplier exposure above the limit');
  for (const l of lots) if (alloc.filter((a) => a.lot === l.code).reduce((s, x) => s + x.qty, 0) > l.qty + 1e-9) violations.push(`lot ${l.code} over-allocated`);
  return violations;
}

function describe(alloc, lots, offers, c) {
  const filled = new Map();
  for (const a of alloc) filled.set(a.lot, (filled.get(a.lot) ?? 0) + a.qty);
  const unfilled = lots.filter((l) => (filled.get(l.code) ?? 0) + 1e-9 < l.qty).map((l) => {
    const cands = offers.filter((o) => o.lots[l.code]);
    const reason = !cands.length ? 'no eligible supplier bid on this lot' : cands.every((o) => (o.score < (c.min_score ?? 0))) ? 'bidders are below the minimum score' : 'constraints or capacity leave it unfilled';
    return { lot: l.code, missing_qty: l.qty - (filled.get(l.code) ?? 0), reason };
  });
  const cost = alloc.reduce((a, x) => a + x.cost_minor, 0);
  const est = lots.reduce((a, l) => a + (l.estimate_minor ?? 0), 0);
  return {
    allocation: alloc, cost_minor: cost, coverage: { filled: lots.length - unfilled.length, total: lots.length }, unfilled,
    suppliers: [...new Set(alloc.map((a) => a.entity))].length, budget_impact_minor: c.budget_minor != null ? c.budget_minor - cost : est ? est - cost : null,
    violations: check(alloc, lots, c, offers),
  };
}

export function buildScenario(kind, lots, offersAll, constraints = {}) {
  const c = { ...constraints, kind };
  const offers = offersAll.filter((o) => o.capacity_ok !== false && o.score >= (c.min_score ?? 0)).sort((a, b) => b.score - a.score || String(a.entity).localeCompare(String(b.entity)));
  if (!offers.length) return { kind, feasible: false, solver: 'none', optimal: false, ...describe([], lots, offersAll, c), explanation: 'No eligible supplier meets the minimum score and capacity rules.' };

  // whole-lot candidates per lot (quantity splits are heuristic only)
  const fullLot = (o, l) => { const x = o.lots[l.code]; return x && x.capacity >= l.qty ? { lot: l.code, entity: o.entity, qty: l.qty, cost_minor: x.cost_minor } : null; };
  const wholeOnly = lots.every((l) => offers.some((o) => fullLot(o, l)) || !offers.some((o) => o.lots[l.code]));

  if (kind === 'single_supplier') {
    let best = null;
    for (const o of offers) {
      const alloc = lots.map((l) => fullLot(o, l)).filter(Boolean);
      const d = describe(alloc, lots, offersAll, c);
      if (d.violations.length) continue;
      if (!best || alloc.length > best.alloc.length || (alloc.length === best.alloc.length && o.score > best.score)) best = { alloc, score: o.score };
    }
    const d = describe(best?.alloc ?? [], lots, offersAll, c);
    return { kind, feasible: !!best && d.unfilled.length === 0, solver: 'enumeration', optimal: true, ...d, explanation: best ? (d.unfilled.length ? 'No single supplier covers every lot; the best partial cover is shown.' : 'One supplier covers every lot.') : 'No single supplier fits the constraints.' };
  }

  const combos = (offers.length + 1) ** lots.length;
  if (wholeOnly && combos <= EXHAUSTIVE_LIMIT) {
    let best = null;
    const rec = (i, alloc) => {
      if (i === lots.length) {
        if (check(alloc, lots, c, offers).length) return;
        const key = [alloc.length, objective(kind, alloc, offers)];
        if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { alloc: [...alloc], key };
        return;
      }
      rec(i + 1, alloc);
      for (const o of offers) { const a = fullLot(o, lots[i]); if (a) { alloc.push(a); rec(i + 1, alloc); alloc.pop(); } }
    };
    rec(0, []);
    const d = describe(best?.alloc ?? [], lots, offersAll, c);
    return { kind, feasible: d.unfilled.length === 0 && !d.violations.length, solver: 'exhaustive', optimal: true, ...d, explanation: d.unfilled.length ? 'Not every lot can be filled within the constraints; the maximum cover is shown.' : 'Proven best allocation for the chosen objective.' };
  }

  // heuristic: per lot, best supplier by objective with quantity split across suppliers by capacity
  const alloc = [];
  for (const l of lots) {
    let remaining = l.qty;
    const cands = offers.filter((o) => o.lots[l.code]).sort((a, b) => kind === 'lowest_cost' ? a.lots[l.code].unit_cost_minor - b.lots[l.code].unit_cost_minor : b.score - a.score || a.lots[l.code].unit_cost_minor - b.lots[l.code].unit_cost_minor);
    for (const o of cands) {
      if (remaining <= 0) break;
      const x = o.lots[l.code], q = Math.min(remaining, x.capacity);
      if (q <= 0) continue;
      const trial = [...alloc, { lot: l.code, entity: o.entity, qty: q, cost_minor: Math.round(x.unit_cost_minor * q) }];
      if (check(trial, lots, c, offers).length) continue;
      alloc.push(trial[trial.length - 1]); remaining -= q;
    }
  }
  const d = describe(alloc, lots, offersAll, c);
  return { kind, feasible: d.unfilled.length === 0 && !d.violations.length, solver: 'greedy', optimal: false, ...d, explanation: 'Heuristic allocation (not proven optimal). Quantities may be split across suppliers by capacity.' };
}
