// Pure-logic fixtures for the tender maths. These are the worked examples in docs/tender-zone.md: if a formula changes, they fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineAmounts, convertMinor, evaluatedCost, divRound } from '../src/tender/money.js';
import { technicalScore, commercialScores, rank, rubricIssues, rubricSchema, sensitivity, round2 } from '../src/tender/scoring.js';
import { buildScenario } from '../src/tender/award.js';
import { exportSheet, importSheet, templateHash } from '../src/tender/sheet.js';
import { xlsx, zip } from '../src/tender/xlsx.js';

const proj = { id: 'p1', ref: 'TND-2026-00001', version: 1, currency: 'INR' };
const lots = [{ code: 'L1', title: 'Pitch', qty: 2, unit: 'site' }, { code: 'L2', title: 'Crew', qty: 36, unit: 'shift' }];

test('money: one rounding per step, half-up, discount before tax, inclusive prices split exactly', () => {
  assert.deepEqual(lineAmounts({ qty: '36', rate_minor: 150000, discount_bp: 500, tax_bp: 1800 }), { net_minor: 5130000, tax_minor: 923400, gross_minor: 6053400 });
  assert.deepEqual(lineAmounts({ qty: '1', rate_minor: 11800, tax_bp: 1800, tax_inclusive: true }), { net_minor: 10000, tax_minor: 1800, gross_minor: 11800 });
  assert.deepEqual(lineAmounts({ qty: '0.3333', rate_minor: 10000 }), { net_minor: 3333, tax_minor: 0, gross_minor: 3333 });
  assert.deepEqual(lineAmounts({ qty: '1', rate_minor: 5, discount_bp: 5000 }), { net_minor: 3, tax_minor: 0, gross_minor: 3 }, '2.5 rounds half-up to 3');
  assert.equal(divRound(5n, 2n), 3n);
  assert.throws(() => lineAmounts({ qty: '1.00001', rate_minor: 1 }), /decimal places/);
  assert.throws(() => lineAmounts({ qty: '1', rate_minor: 1.5 }), /whole number/);
  assert.throws(() => lineAmounts({ qty: '1', rate_minor: 1, tax_bp: 20000 }), /between 0% and 100%/);
});

test('fx: dated snapshot converts with exact decimals and respects each currency\'s exponent; missing rates fail loudly', () => {
  const fx = { date: '2026-10-01', base: 'INR', rates: { INR: '1', USD: '83.10', JPY: '0.55' } };
  assert.equal(convertMinor(10000, 'USD', 'INR', fx), 831000, '100.00 USD = 8310.00 INR');
  assert.equal(convertMinor(1000, 'JPY', 'INR', fx), 55000, '1000 yen (0 decimals) = 550.00 INR');
  assert.equal(convertMinor(831000, 'INR', 'USD', fx), 10000);
  assert.equal(convertMinor(123, 'INR', 'INR', fx), 123);
  assert.throws(() => convertMinor(1, 'EUR', 'INR', fx), /No exchange rate for EUR/);
  const c = evaluatedCost({ lines: [{ lot_code: 'L1', qty: '2', rate_minor: 5000, currency: 'USD', tax_bp: 0 }, { lot_code: 'L2', qty: '1', rate_minor: 100000, currency: 'INR' }], lots: ['L1', 'L2'], currency: 'INR', fx, basis: 'net' });
  assert.equal(c.total_minor, 831000 + 100000); assert.deepEqual(c.original, { USD: 10000, INR: 100000 }, 'bid currencies are preserved');
  const missing = evaluatedCost({ lines: [{ lot_code: 'L1', qty: '2', rate_minor: 5000 }], lots: ['L1', 'L2'], currency: 'INR', basis: 'net' });
  assert.equal(missing.total_minor, null); assert.deepEqual(missing.missing_lots, ['L2']); // an unpriced lot is unknown, never zero
});

const rub = rubricSchema.parse({ weights: { technical: 60, commercial: 40 }, technical_pass_mark: 50, min_reviewers: 2, criteria: [{ key: 'scope', title: 'Scope', weight: 60, scale_max: 10 }, { key: 'safety', title: 'Safety', weight: 40, scale_max: 10, min_normalised: 40 }] });

test('scoring: weights and bounds are enforced, N/A reweights, missing blocks, thresholds fail the bid, consensus overrides the mean', () => {
  assert.deepEqual(rubricIssues(rub), []);
  assert.match(rubricIssues({ ...rub, weights: { technical: 70, commercial: 40 } })[0], /add up to 100/);
  assert.match(rubricIssues({ ...rub, criteria: [{ ...rub.criteria[0], weight: 50 }, rub.criteria[1]] }).join(), /not 100/);
  const two = (a, b) => [{ reviewer_id: 'r1', score: a, weight: 1 }, { reviewer_id: 'r2', score: b, weight: 1 }];
  const t = technicalScore(rub, { scope: two(8, 6), safety: two(9, 7) });
  assert.equal(t.score, 74); // (60*70 + 40*80) / 100
  assert.equal(t.complete, true);
  const na = technicalScore(rub, { scope: two(null, null), safety: two(8, 8) });
  assert.equal(na.score, 80, 'N/A dropped, the remaining weight is rescaled'); assert.deepEqual(na.by_criterion.scope, { na: true });
  const miss = technicalScore(rub, { scope: two(8, 6), safety: [{ reviewer_id: 'r1', score: 9, weight: 1 }] });
  assert.deepEqual(miss.missing, ['safety']); assert.equal(miss.complete, false);
  const low = technicalScore(rub, { scope: two(9, 9), safety: two(3, 3) });
  assert.deepEqual(low.failed, ['safety'], 'below the mandatory threshold');
  assert.equal(technicalScore(rub, { scope: two(8, 6), safety: two(9, 7) }, { scope: 10 }).score, 92, 'consensus replaces the mean');
  assert.equal(round2(2.675), 2.68);
  const weighted = technicalScore(rub, { scope: [{ reviewer_id: 'a', score: 10, weight: 3 }, { reviewer_id: 'b', score: 0, weight: 1 }], safety: two(10, 10) });
  assert.equal(weighted.by_criterion.scope.raw, 7.5, 'reviewer weights apply');
});

test('ranking: lowest cost scores 100, ineligible and incomplete bids never rank, ties follow the published tie-break then share a rank', () => {
  assert.deepEqual(commercialScores({ a: 4140000, b: 4600000, c: null }), { a: 100, b: 90 });
  const full = (id, tech, cost, over = {}) => ({ id, eligibility: 'eligible', technical: { score: tech, complete: true, missing: [], failed: [] }, cost_minor: cost, submitted_at: '2026-10-01T10:00:00Z', ...over });
  const r = rank(rub, [full('a', 86, 4600000), full('b', 60, 4140000), full('c', 99, 1000000, { eligibility: 'ineligible' }), full('d', 90, 4000000, { technical: { score: null, complete: false, missing: ['scope'], failed: [] } })]);
  const row = (id) => r.rows.find((x) => x.id === id);
  assert.equal(row('a').total, 87.6); assert.equal(row('b').total, 76); assert.equal(row('a').rank, 1); assert.equal(row('b').rank, 2);
  assert.equal(row('c').rank, null, 'the cheapest ineligible bid never wins'); assert.equal(row('d').rank, null);
  assert.equal(r.final, false); assert.ok(r.blockers.some((b) => b.startsWith('d:')), 'an incomplete bid blocks the final ranking');
  assert.equal(rank(rub, [full('a', 86, 4600000), full('b', 60, 4140000)]).final, true);
  // below the technical pass mark never ranks
  assert.equal(rank(rub, [full('a', 40, 100), full('b', 60, 200)]).rows.find((x) => x.id === 'a').rank, null);
  // tie: equal totals -> commercial score decides, then technical, then earlier submission; a full tie shares the rank and is flagged
  const weights = rubricSchema.parse({ ...rub, weights: { technical: 50, commercial: 50 } });
  const t1 = rank(weights, [full('x', 80, 100), full('y', 60, 100)]); // x: 80/100 -> total 90 ; y: 60/100 -> 80
  assert.equal(t1.rows[0].id, 'x');
  const tie = rank(weights, [full('p', 70, 200), full('q', 70, 200)]);
  assert.deepEqual(tie.rows.map((x) => [x.rank, x.tied]), [[1, true], [1, true]]);
  const early = rank(weights, [full('late', 70, 200, { submitted_at: '2026-10-02T00:00:00Z' }), full('early', 70, 200)]);
  assert.equal(early.rows[0].id, 'early', 'earlier submission only after commercial and technical tie');
  assert.equal(rank({ ...weights, tie_break: [] }, [full('p', 70, 200), full('q', 70, 200)]).rows[0].tied, true);
  const s = sensitivity(rub, [full('a', 86, 4600000), full('b', 60, 4140000)], [{ technical: 10, commercial: 90 }, { technical: 90, commercial: 10 }]);
  assert.equal(s[0].changed, true); assert.equal(s[1].changed, false);
});

test('award scenarios: exhaustive optimum is proven, heuristic is labelled, constraints and unfilled lots are explained', () => {
  const L = [{ code: 'L1', qty: 2 }, { code: 'L2', qty: 36 }];
  const offer = (entity, score, l1, l2) => ({ entity, score, capacity_ok: true, lots: { L1: { unit_cost_minor: l1 / 2, cost_minor: l1, capacity: 2 }, L2: { unit_cost_minor: l2 / 36, cost_minor: l2, capacity: 36 } } });
  const offers = [offer('A', 87.6, 500, 4100), offer('B', 76, 450, 3690)];
  const hs = buildScenario('highest_score', L, offers, {});
  assert.equal(hs.solver, 'exhaustive'); assert.equal(hs.optimal, true); assert.deepEqual(hs.allocation.map((x) => x.entity), ['A', 'A']);
  const lc = buildScenario('lowest_cost', L, offers, {});
  assert.ok(lc.allocation.every((x) => x.entity === 'B')); assert.equal(lc.cost_minor, 450 + 3690);
  const capped = buildScenario('split_by_lot', L, offers, { max_suppliers: 1 }); assert.equal(capped.suppliers, 1);
  const budget = buildScenario('highest_score', L, offers, { budget_minor: 1000 });
  assert.equal(budget.feasible, false); assert.ok(budget.unfilled.length >= 1, 'infeasible cases say what is unfilled');
  assert.equal(buildScenario('highest_score', L, offers, { min_score: 99 }).feasible, false);
  const single = buildScenario('single_supplier', L, [offer('A', 80, 500, 4100), { entity: 'B', score: 90, capacity_ok: true, lots: { L1: offer('B', 90, 400, 0).lots.L1 } }], {});
  assert.deepEqual(single.allocation.map((x) => x.entity), ['A', 'A'], 'a single supplier must cover every lot to win');
  // quantity split by capacity is heuristic and says so
  const part = { entity: 'P', score: 70, lots: { L2: { unit_cost_minor: 100, cost_minor: 3600, capacity: 20 } } }, part2 = { entity: 'Q', score: 60, lots: { L2: { unit_cost_minor: 110, cost_minor: 3960, capacity: 20 } } };
  const split = buildScenario('split_by_lot', [{ code: 'L2', qty: 36 }], [part, part2], {});
  assert.equal(split.solver, 'greedy'); assert.equal(split.optimal, false); assert.equal(split.allocation.reduce((a, x) => a + x.qty, 0), 36);
  // a large instance falls back to the labelled heuristic
  const many = Array.from({ length: 9 }, (_, i) => ({ code: `X${i}`, qty: 1 })), os = Array.from({ length: 8 }, (_, k) => ({ entity: `S${k}`, score: 50 + k, lots: Object.fromEntries(many.map((l) => [l.code, { unit_cost_minor: 10 + k, cost_minor: 10 + k, capacity: 1 }])) }));
  const big = buildScenario('highest_score', many, os, {}); assert.equal(big.solver, 'greedy'); assert.equal(big.optimal, false);
});

test('pricing sheet: round-trips, binds to the tender version, rejects formulas, changed quantities and stale templates', () => {
  const out = exportSheet(proj, lots, [], 'csv');
  assert.ok(out.body.startsWith('#schema,sportarena.pricing.v1,TND-2026-00001,1,'));
  const filled = out.body.replace(/^(L1,Pitch,2,site),,,,no,/m, '$1,5000.00,0,18,no,').replace(/^(L2,Crew,36,shift),,,,no,/m, '$1,1500.50,5,18,no,Includes uniforms');
  const lines = importSheet(proj, lots, filled);
  assert.deepEqual(lines.map((l) => [l.lot_code, l.rate_minor, l.discount_bp, l.tax_bp]), [['L1', 500000, 0, 1800], ['L2', 150050, 500, 1800]]);
  assert.equal(importSheet(proj, lots, out.body).length, 0, 'unpriced lots are left out, never zero');
  assert.throws(() => importSheet(proj, lots, filled.replace('L2,Crew,36,shift', 'L2,Crew,99,shift')), /fixed by the tender/);
  assert.throws(() => importSheet(proj, lots, filled.replace('Includes uniforms', '=HYPERLINK("http://x")')), /formula/);
  assert.throws(() => importSheet(proj, lots, filled.replace('1500.50', '+1500')), /formula/);
  assert.throws(() => importSheet({ ...proj, version: 2 }, lots, filled), /out of date/);
  assert.throws(() => importSheet(proj, lots, filled.replace('sportarena.pricing.v1', 'sportarena.pricing.v0')), /unsupported version/);
  assert.throws(() => importSheet(proj, lots, 'lot,rate\nL1,1'), /not a Sportarena pricing sheet/);
  assert.throws(() => importSheet(proj, lots, filled.replace('5000.00', '5000.001')), /at most 2 decimals/);
  assert.notEqual(templateHash(proj, lots), templateHash(proj, [{ ...lots[0], qty: 3 }, lots[1]]), 'the template fingerprint changes with the structure');
});

test('xlsx and zip writers produce valid containers with inline strings only', () => {
  const x = xlsx([['a', 1, '=SUM(A1)'], ['<b>', null, 'x & y']], 'Data');
  assert.equal(x.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  const s = x.toString('latin1');
  assert.ok(s.includes('xl/worksheets/sheet1.xml') && s.includes('t="inlineStr"') && !s.includes('<f>'), 'no formulas are ever written');
  assert.ok(s.includes('&lt;b&gt;') && s.includes('x &amp; y'));
  const z = zip([{ name: 'a.txt', data: 'hello' }]);
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
});
