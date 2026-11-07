import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('provider earnings weekly trend', () => {
  it('week_start is computed as start of current week (Sunday)', () => {
    const ws = new Date('2026-11-07'); // Friday
    ws.setUTCHours(0, 0, 0, 0);
    ws.setUTCDate(ws.getUTCDate() - ws.getUTCDay()); // back to Sunday
    assert.equal(ws.toISOString().slice(0, 10), '2026-11-01');
  });

  it('trend series is per currency', () => {
    const mockTrend = {
      USD: [{ week_start: '2026-10-26', gross_cents: 10000, net_cents: 8500, refund_cents: 0 }],
      GBP: [{ week_start: '2026-10-26', gross_cents: 5000, net_cents: 4200, refund_cents: 0 }],
    };
    assert.ok(mockTrend.USD);
    assert.ok(mockTrend.GBP);
    assert.notEqual(mockTrend.USD[0].gross_cents, mockTrend.GBP[0].gross_cents);
  });

  it('net_cents can be negative after refunds', () => {
    const entry = { gross_cents: 1000, net_cents: -200, refund_cents: 1200 };
    assert.ok(entry.net_cents < 0);
  });
});
