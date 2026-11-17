import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawPairs } from '../src/draw.js';

const people = (n) => Array.from({ length: n }, (_, i) => `p${i}`);

/**
 * Is `count` out of `trials` consistent with probability `p`? Uses a 5-sigma band, so a
 * fair draw fails roughly 1 in 3.5 million comparisons (about 1 in 40,000 runs of this
 * file), while the biases we guard against are 12-25+ sigma away and always caught.
 */
function assertFair(count, trials, p, label) {
  const expected = trials * p;
  const sigma = Math.sqrt(trials * p * (1 - p));
  assert.ok(Math.abs(count - expected) <= 5 * sigma, `${label}: got ${count}, expected ${expected.toFixed(0)} ± ${(5 * sigma).toFixed(0)}`);
}

test('everyone gives once, receives once, and never draws themselves', () => {
  for (let n = 4; n <= 40; n++) {
    for (let run = 0; run < 40; run++) {
      const pairs = drawPairs(people(n));
      assert.equal(pairs.size, n);
      assert.equal(new Set(pairs.values()).size, n);
      for (const [g, r] of pairs) assert.notEqual(g, r);
    }
  }
});

test('refuses fewer than 4 people (with 3, your own match reveals every pair)', () => {
  assert.throws(() => drawPairs(people(3)));
  assert.throws(() => drawPairs(people(2)));
});

test('knowing who you drew tells you nothing about who drew you', () => {
  // Fix p0 -> p1 and look at who gives to p0. It must be (statistically) uniform over
  // everyone else, INCLUDING p1. A "single circle" draw would never pick p1 here.
  for (const n of [4, 5, 6, 7, 10]) {
    const counts = new Map();
    let samples = 0;
    while (samples < 6000) {
      const pairs = drawPairs(people(n));
      if (pairs.get('p0') !== 'p1') continue;
      samples++;
      const santa = [...pairs].find(([, r]) => r === 'p0')[0];
      counts.set(santa, (counts.get(santa) || 0) + 1);
    }
    assert.equal(counts.size, n - 1, `every other person can be p0's santa (n=${n})`);
    for (const [who, c] of counts) assertFair(c, samples, 1 / (n - 1), `n=${n}: ${who} drew p0`);
  }
});

test('every receiver is equally likely for a given giver', () => {
  const n = 6;
  const counts = new Map();
  const runs = 12000;
  for (let i = 0; i < runs; i++) {
    const r = drawPairs(people(n)).get('p0');
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  assert.equal(counts.size, n - 1);
  for (const [who, c] of counts) assertFair(c, runs, 1 / (n - 1), `p0 drew ${who}`);
});

test('mutual pairs happen exactly as often as fairness requires (1 in n-1)', async () => {
  const { pairCountDistribution } = await import('../src/draw.js');
  for (let n = 4; n <= 60; n++) {
    const p = pairCountDistribution(n);
    const sum = p.reduce((a, b) => a + b, 0);
    const mean = p.reduce((acc, x, m) => acc + x * 2 * m, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(Math.abs(mean - n / (n - 1)) < 1e-6, `n=${n}: E[people in mutual pairs]=${mean}`);
  }
});
