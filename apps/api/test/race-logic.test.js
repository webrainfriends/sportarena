import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEntrant, rankEntries, classify, parseCsv, toCsv, rulesSchema, fmtMs, computeKeys, encodeCursor, decodeCursor } from '../src/race.js';

// The pure heart of race timing: the same reads always give the same splits, times, exceptions and cutoff findings (no database involved).
const rules = (over = {}) => rulesSchema.parse(over);
const CPS = [
  { id: 'a', seq: 1, code: 'START', label: 'Start', kind: 'start', distance_m: 0, read_rule: 'last' },
  { id: 'b', seq: 2, code: 'HALF', label: 'Half', kind: 'split', distance_m: 5000, read_rule: 'first', cutoff_s: 1800 },
  { id: 'c', seq: 3, code: 'FIN', label: 'Finish', kind: 'finish', distance_m: 10000, read_rule: 'first' },
];
const G = Date.parse('2030-01-01T08:00:00Z');
const rd = (id, code, ms) => ({ id, code, at: G + ms });
const run = (reads, o = {}) => reconcileEntrant({ checkpoints: CPS, reads, gunAt: G, rules: rules(), ...o });

test('the same reads in any order give the same result digest', () => {
  const reads = [rd('1', 'START', 6000), rd('2', 'HALF', 900000), rd('3', 'FIN', 2400000), rd('4', 'START', 5000)];
  const a = run(reads), b = run([...reads].reverse()), c = run([reads[2], reads[0], reads[3], reads[1]]);
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, c.digest);
  assert.equal(a.net_time_ms, 2400000 - 6000, 'the last read of the start mat counts (read rule last)');
  assert.equal(a.gun_time_ms, 2400000);
  assert.equal(a.official_time_ms, a.net_time_ms, 'net is the default ranking clock');
  assert.deepEqual(a.splits.map((s) => [s.code, s.net_ms]), [['START', 0], ['HALF', 894000], ['FIN', 2394000]]);
  assert.equal(a.splits[1].segment_ms, 900000 - 6000);
});

test('duplicates inside the window count once, a later conflicting read is flagged and ignored', () => {
  const dup = run([rd('1', 'START', 5000), rd('2', 'FIN', 2000000), rd('3', 'FIN', 2002000)]);
  assert.equal(dup.finish_at, new Date(G + 2000000).toISOString(), 'the first duplicate counts (read rule first)');
  assert.ok(dup.flags.includes('duplicate_read'));
  assert.ok(!dup.exceptions.some((e) => e.kind === 'multiple_reads'));
  const far = run([rd('1', 'START', 5000), rd('2', 'FIN', 2000000), rd('3', 'FIN', 2030000)]);
  assert.equal(far.finish_at, new Date(G + 2000000).toISOString());
  assert.ok(far.exceptions.some((e) => e.kind === 'multiple_reads' && e.detail.ignored.includes('3')));
  assert.ok(far.flags.includes('review'));
  const wide = reconcileEntrant({ checkpoints: CPS, reads: [rd('1', 'START', 5000), rd('2', 'FIN', 2000000), rd('3', 'FIN', 2030000)], gunAt: G, rules: rules({ dedupe_window_s: 60 }) });
  assert.ok(!wide.exceptions.some((e) => e.kind === 'multiple_reads'), 'a wider window makes them one crossing');
});

test('missing, out-of-order and negative reads are exceptions, never invented or silently repaired', () => {
  const gap = run([rd('1', 'START', 5000), rd('3', 'FIN', 2000000)]);
  assert.deepEqual(gap.exceptions.filter((e) => e.kind === 'missing_read').map((e) => e.checkpoint_code), ['HALF'], 'a finisher with no half way read has a gap to look at');
  assert.equal(gap.status, 'finished');
  assert.equal(gap.official_time_ms, 1995000, 'the time is still computed from the reads that exist');
  const racing = run([rd('1', 'START', 5000), rd('2', 'HALF', 900000)]);
  assert.equal(racing.exceptions.filter((e) => e.kind === 'missing_read').length, 0, 'not yet reaching a checkpoint is not a gap');
  assert.equal(racing.status, 'started');
  const hole = run([rd('1', 'START', 5000), rd('3', 'FIN', 2000000), rd('2', 'HALF', 1000000)]);
  assert.equal(hole.splits[1].status, 'read');
  const noHalfAfterFinish = reconcileEntrant({ checkpoints: [...CPS.slice(0, 1), { id: 'x', seq: 2, code: 'K1', label: 'K1', kind: 'split', distance_m: 1000, read_rule: 'first' }, { id: 'y', seq: 3, code: 'K2', label: 'K2', kind: 'split', distance_m: 2000, read_rule: 'first' }, { ...CPS[2], seq: 4 }], reads: [rd('1', 'START', 5000), rd('2', 'K2', 700000), rd('3', 'FIN', 2000000)], gunAt: G, rules: rules() });
  assert.deepEqual(noHalfAfterFinish.exceptions.filter((e) => e.kind === 'missing_read').map((e) => e.checkpoint_code), ['K1']);
  assert.equal(noHalfAfterFinish.splits[1].status, 'missing');
  assert.equal(noHalfAfterFinish.splits[1].at, null, 'a missing read has no invented time');
  const ooo = run([rd('1', 'START', 7000), rd('2', 'HALF', 6000), rd('3', 'FIN', 2000000)]);
  assert.ok(ooo.exceptions.some((e) => e.kind === 'out_of_order' && e.checkpoint_code === 'HALF'));
  const neg = run([rd('1', 'START', 7000), rd('2', 'FIN', 6000)]);
  assert.ok(neg.exceptions.some((e) => e.kind === 'negative_time'));
  assert.equal(neg.official_time_ms, null);
});

test('a time that cannot be computed on the policy clock is flagged, never replaced by the other clock', () => {
  const noStart = run([rd('2', 'HALF', 900000), rd('3', 'FIN', 2400000)]);
  assert.equal(noStart.gun_time_ms, 2400000);
  assert.equal(noStart.net_time_ms, null);
  assert.equal(noStart.official_time_ms, null, 'net clock race: no net time means no official time, not the gun time');
  assert.ok(noStart.flags.includes('needs_review') && noStart.exceptions.some((e) => e.kind === 'needs_review' && e.detail.basis_wanted === 'net'));
  const gunOnly = run([rd('2', 'HALF', 900000), rd('3', 'FIN', 2400000)], { rules: rules({ time_basis: 'gun' }) });
  assert.equal(gunOnly.official_time_ms, 2400000, 'a gun-clock race ranks on gun time');
  const noGun = run([rd('1', 'START', 5000), rd('3', 'FIN', 2400000)], { gunAt: null });
  assert.equal(noGun.official_time_ms, 2395000, 'a net race does not need a gun time');
  assert.ok(!noGun.exceptions.some((e) => e.kind === 'no_gun_time'));
  const gunNone = run([rd('1', 'START', 5000), rd('3', 'FIN', 2400000)], { gunAt: null, rules: rules({ time_basis: 'gun' }) });
  assert.equal(gunNone.official_time_ms, null);
  assert.ok(gunNone.exceptions.some((e) => e.kind === 'no_gun_time'));
  const override = run([rd('2', 'HALF', 900000), rd('3', 'FIN', 2400000)], { useGun: true });
  assert.equal(override.official_time_ms, 2400000, 'an approved correction can rank one entrant on gun time');
  assert.equal(override.basis_used, 'gun');
});

test('penalties and adjustments are added on top of the derived time, and change the digest', () => {
  const base = run([rd('1', 'START', 5000), rd('3', 'FIN', 2005000)]);
  const pen = run([rd('1', 'START', 5000), rd('3', 'FIN', 2005000)], { adjustmentMs: 30000 });
  assert.equal(base.official_time_ms, 2000000);
  assert.equal(pen.official_time_ms, 2030000);
  assert.equal(pen.net_time_ms, 2000000, 'the raw net time is untouched');
  assert.notEqual(base.digest, pen.digest);
});

test('cutoffs: a read after the limit is missed, no read is no_evidence, never confirmed from silence', () => {
  const missed = run([rd('1', 'START', 5000), rd('2', 'HALF', 2000000), rd('3', 'FIN', 4000000)]);
  assert.deepEqual(missed.cutoffs.map((k) => [k.code, k.outcome]), [['HALF', 'missed']]);
  const passed = run([rd('1', 'START', 5000), rd('2', 'HALF', 900000)]);
  assert.equal(passed.cutoffs[0].outcome, 'passed');
  const silent = run([rd('1', 'START', 5000), rd('3', 'FIN', 3000000)]);
  assert.equal(silent.cutoffs[0].outcome, 'no_evidence');
  assert.equal(silent.cutoffs[0].elapsed_ms, null);
  const none = run([]);
  assert.deepEqual(none.cutoffs, [], 'someone who never started has no cutoff finding');
  assert.equal(none.status, 'registered');
  const gunBasis = reconcileEntrant({ checkpoints: CPS, reads: [rd('1', 'START', 600000), rd('2', 'HALF', 1900000)], gunAt: G, rules: rules({ cutoff_basis: 'gun' }) });
  assert.equal(gunBasis.cutoffs[0].outcome, 'missed', 'measured from the gun the late starter is over the limit; on the net clock they would not be');
  const netBasis = reconcileEntrant({ checkpoints: CPS, reads: [rd('1', 'START', 600000), rd('2', 'HALF', 1900000)], gunAt: G, rules: rules({ cutoff_basis: 'net' }) });
  assert.equal(netBasis.cutoffs[0].outcome, 'passed');
});

test('ranking: shared places by default, the earlier crossing separates equal times only when the policy says so', () => {
  const rows = [{ id: 'a', time: 100, finish_ms: 5, bib: '2' }, { id: 'b', time: 100, finish_ms: 9, bib: '1' }, { id: 'c', time: 130, finish_ms: 1, bib: '3' }, { id: 'd', time: 100, finish_ms: 5, bib: '4' }];
  const share = rankEntries(rows, 'share');
  assert.deepEqual(['a', 'b', 'c', 'd'].map((k) => share.get(k).rank), [1, 1, 4, 1]);
  assert.ok(share.get('a').tied && !share.get('c').tied);
  const cross = rankEntries(rows, 'earlier_crossing');
  assert.deepEqual(['a', 'd', 'b', 'c'].map((k) => cross.get(k).rank), [1, 1, 3, 4], 'a and d crossed at the same instant and stay tied');
  assert.deepEqual([...rankEntries([...rows].reverse(), 'share')].map(([k, v]) => [k, v.rank]).sort(), [...share].map(([k, v]) => [k, v.rank]).sort());
});

test('classifications use only declared fields; an undeclared gender is in no gender class; a club needs enough finishers', () => {
  const rows = [
    { id: '1', time: 10, finish_ms: 1, bib: '1', gender: 'male', category_id: 'k1', house_id: 'h1' }, { id: '2', time: 11, finish_ms: 2, bib: '2', gender: 'female', category_id: 'k1', house_id: 'h1' },
    { id: '3', time: 12, finish_ms: 3, bib: '3', gender: null, category_id: null, house_id: 'h2' }, { id: '4', time: 13, finish_ms: 4, bib: '4', gender: 'female', category_id: null, house_id: 'h1' },
    { id: '5', time: 14, finish_ms: 5, bib: '5', gender: 'male', category_id: null, house_id: 'h2' },
  ];
  const c = classify(rows, { categories: [{ id: 'k1' }], team: { enabled: true, count: 2 } });
  assert.deepEqual([...c.gender.get('female')].map(([k, v]) => [k, v.rank]), [['2', 1], ['4', 2]]);
  assert.deepEqual([...c.gender.get('male')].map(([k, v]) => [k, v.rank]), [['1', 1], ['5', 2]]);
  assert.ok(![...c.gender.values()].some((m) => m.has('3')), 'no declared gender: not placed in a gender class and never guessed');
  assert.deepEqual([...c.category.get('k1')].map(([k]) => k), ['1', '2']);
  assert.deepEqual(c.teams.map((t) => [t.house_id, t.time, t.rank]), [['h1', 21, 1], ['h2', 26, 2]]);
  const short = classify(rows, { team: { enabled: true, count: 3 } });
  assert.deepEqual(short.teams.map((t) => t.house_id), ['h1'], 'h2 has two finishers and is not scored on three');
});

test('policy: only rules that change how times are computed invalidate results', () => {
  const a = rules();
  assert.equal(computeKeys(a), computeKeys(rules({ public: { enabled: true, names: true }, award_depth: 5, tie_rule: 'earlier_crossing' })));
  assert.notEqual(computeKeys(a), computeKeys(rules({ time_basis: 'gun' })));
  assert.notEqual(computeKeys(a), computeKeys(rules({ dedupe_window_s: 10 })));
  assert.throws(() => rules({ extra_statuses: ['dnf'] }), /already a standard status/);
  assert.equal(rules({ extra_statuses: ['overtime'] }).extra_statuses[0], 'overtime');
});

test('CSV: quoted fields round-trip, formulas are neutralised, cursors survive a round trip', () => {
  assert.deepEqual(parseCsv('﻿Chip,Bib\r\n"A,1",7\r\n"say ""hi""",8\r\n\r\n'), [{ chip: 'A,1', bib: '7' }, { chip: 'say "hi"', bib: '8' }]);
  assert.throws(() => parseCsv('a\n1\n2\n3\n', { maxRows: 2 }), /more than/);
  const out = toCsv(['name', 'time'], [{ name: '=HYPERLINK("x")', time: '-5' }, { name: '+1+1', time: '1:02.000' }, { name: 'Ann, B', time: null }]);
  assert.match(out, /'=HYPERLINK/);
  assert.match(out, /'\+1\+1/);
  assert.match(out, /"Ann, B",/);
  assert.match(out, /,-5\r\n/, 'a plain negative number stays a number');
  assert.deepEqual(decodeCursor(encodeCursor(['2030-01-01T00:00:00.123456Z', 'id'])), ['2030-01-01T00:00:00.123456Z', 'id']);
  assert.equal(decodeCursor('not-a-cursor'), null);
  assert.equal(fmtMs(3723456), '1:02:03.456');
  assert.equal(fmtMs(61000), '1:01.000');
  assert.equal(fmtMs(null), null);
});
