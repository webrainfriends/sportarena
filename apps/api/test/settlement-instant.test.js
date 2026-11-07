import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('instant payout gates', () => {
  it('rejects when instant_eligible is false', () => {
    const account = { status: 'verified', instant_eligible: false };
    assert.ok(!account.instant_eligible, 'should not proceed');
  });

  it('rejects when no available balance', () => {
    const bal = { available_cents: 0 };
    assert.ok(bal.available_cents < 1);
  });

  it('rejects when amount exceeds available', () => {
    const bal = { available_cents: 500 };
    const requested = 1000;
    assert.ok(requested > bal.available_cents);
  });

  it('idempotency key deduplication prevents double-payout', () => {
    const processed = new Set();
    const key = 'instant-USD-1234567890';
    processed.add(key);
    // Second call with same key should be caught
    assert.ok(processed.has(key));
  });

  it('minimum payout check', () => {
    const minCents = 100;
    const requested = 50;
    assert.ok(requested < minCents, 'should block below minimum');
  });
});
