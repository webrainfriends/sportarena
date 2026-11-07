import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/settlement.js';

describe('coach class earning splits', () => {
  it('allocate preserves sum exactly', () => {
    const total = 1000;
    const weights = [70, 30];
    const parts = allocate(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, 'parts must sum to total');
    assert.equal(parts[0], 700);
    assert.equal(parts[1], 300);
  });

  it('allocate handles 3-way uneven split', () => {
    const total = 100;
    const weights = [1, 1, 1];
    const parts = allocate(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, 'parts must sum to total');
  });

  it('allocate handles single-coach 100%', () => {
    const total = 500;
    const weights = [100];
    const parts = allocate(total, weights);
    assert.equal(parts[0], 500);
  });

  it('allocate handles zero weights gracefully', () => {
    const total = 500;
    const weights = [0];
    const parts = allocate(total, weights);
    assert.equal(parts[0], 0);
  });

  it('1000 random inputs always preserve sum', () => {
    for (let i = 0; i < 1000; i++) {
      const total = Math.floor(Math.random() * 100000) + 1;
      const n = Math.floor(Math.random() * 5) + 1;
      const weights = Array.from({ length: n }, () => Math.floor(Math.random() * 100) + 1);
      const parts = allocate(total, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `failed for total=${total} weights=${weights}`);
    }
  });
});
