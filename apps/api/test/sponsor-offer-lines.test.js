import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLines, lineProblems, newLine, toApiLine, toMinor } from '../../app/src/offer-lines.js';
import { buildSchedule } from '../src/sponsor-schedule.js';

const filled = (kind, patch = {}) => ({ ...newLine(kind, 'INR'), ...patch });

test('money amounts are typed in whole currency units and sent in minor units, per currency', () => {
  assert.equal(toMinor('30,000', 'INR'), 3000000);
  assert.equal(toMinor('12.5', 'USD'), 1250);
  assert.equal(toMinor('500', 'JPY'), 500, 'a zero-decimal currency has no minor unit');
  assert.equal(toMinor('', 'INR'), null); assert.equal(toMinor('0', 'INR'), null); assert.equal(toMinor('abc', 'INR'), null);
});

test('an empty line says what is missing; a complete one says nothing', () => {
  assert.deepEqual(lineProblems(newLine('money', 'INR')), ['enter an amount', 'pick the first due date']);
  assert.ok(lineProblems(filled('endorsement', { cadence: 'custom', custom_dates: [undefined] })).includes('pick at least one date'));
  assert.deepEqual(lineProblems(filled('money', { amount: '100', first_due_on: '2031-01-05' })), []);
  assert.ok(buildLines([]).problem);
});

test('every kind converts to the API shape and the server accepts and schedules the whole mix', () => {
  const lines = [
    filled('money', { amount: '30,000', first_due_on: '2031-01-05', instalments: 4 }),
    filled('money', { label: 'Bonus', mode: 'total', amount: '90,000', cadence: 'custom', custom_dates: ['2031-03-01', '2031-02-01', '2031-02-01'] }),
    filled('goods', { label: 'Kits', quantity: 12, unit: 'kits', estimate: '36,000', first_due_on: '2031-02-20' }),
    filled('service', { label: 'Coaching', quantity: 4, service_type: 'coaching', first_due_on: '2031-02-01' }),
    filled('endorsement', { channels: ['Instagram'], exclusivity: 'No rival kit', placement: '  ', cadence: 'custom', custom_dates: ['2031-03-31'] }),
  ];
  const r = buildLines(lines);
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.lines[1].custom_dates, ['2031-02-01', '2031-03-01'], 'custom dates are de-duplicated and ordered');
  assert.equal(r.lines[1].total_cents, 9000000); assert.equal(r.lines[1].amount_cents, undefined);
  assert.deepEqual(r.lines[4].terms, { channels: ['Instagram'], exclusivity: 'No rival kit' }, 'blank rights are left out');
  assert.equal(r.lines[2].estimate_cents, 3600000);
  const plan = buildSchedule(r.lines, { starts_on: '2031-01-01', ends_on: '2031-06-30' });
  assert.deepEqual(plan.committed, { INR: 12000000 + 9000000 });
  assert.deepEqual(plan.estimated_not_cash, { INR: 3600000 });
  assert.equal(plan.occurrences.length, 4 + 2 + 1 + 1 + 1);
});

test('a budget fixes the currency of cash and estimates', () => {
  const l = filled('goods', { estimate: '10', first_due_on: '2031-02-20', currency: 'INR' });
  assert.equal(toApiLine(l, 'USD').currency, 'USD');
  assert.equal(toApiLine(filled('money', { amount: '5', first_due_on: '2031-01-01', cadence: 'once' }), 'SGD').currency, 'SGD');
});
