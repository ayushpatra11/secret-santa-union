import { randomInt } from './crypto.js';

/**
 * The Secret Santa draw.
 *
 * Goal: nobody can learn anything about who drew THEM from who THEY drew.
 *
 * Naive draws leak:
 *   - "One big circle" never has A->B and B->A together, so your giftee is
 *     guaranteed NOT to be your Santa.
 *   - A uniformly random derangement makes that mutual case rarer than fair
 *     (e.g. with 5 people it happens 2/11 of the time instead of 1/4).
 *
 * This draw is "perfectly neutral": for every person, given who they drew,
 * every other person (including their own giftee) is exactly equally likely
 * to be their Santa, i.e. P(mutual pair) = 1/(n-1).
 *
 * How: any distribution that depends only on the cycle structure is symmetric, and
 * then P(my Santa is X | I drew Y) is uniform over everyone except Y, apart from the
 * Y case itself, which equals P(I'm in a 2-cycle) = E[#people in 2-cycles] / n.
 * We pick m, the number of mutual pairs, from an exponentially-tilted version of
 * its natural distribution, tuned so that E[2m] = n/(n-1). Then we draw uniformly
 * among derangements with exactly m mutual pairs.
 *
 * With 3 people there is only one possible shape (a 3-cycle) and your own giftee
 * reveals every pair, so the minimum is 4.
 */

export const MIN_PEOPLE = 4;

/** Cryptographically secure Fisher-Yates shuffle (returns a new array). */
export function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Uniform float in [0, 1) from the CSPRNG (53 bits). */
function randomUnit() {
  const hi = randomInt(2 ** 26);
  const lo = randomInt(2 ** 27);
  return (hi * 2 ** 27 + lo) / 2 ** 53;
}

const cache = new Map();

/**
 * For n people, the probability of drawing exactly m mutual pairs (m = 0..n/2).
 * Count of derangements with exactly m 2-cycles is C(n,2m) * (2m-1)!! * A(n-2m),
 * where A(j) counts permutations of j items whose cycles are all >= 3 long:
 * A(j) = (j-1)A(j-1) + (j-1)(j-2)A(j-3). Doubles are exact enough for n <= 100.
 */
export function pairCountDistribution(n) {
  if (cache.has(n)) return cache.get(n);
  const A = [1, 0, 0];
  for (let j = 3; j <= n; j++) A[j] = (j - 1) * A[j - 1] + (j - 1) * (j - 2) * A[j - 3];
  const logFact = [0];
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  // log of C(n, 2m) * (2m)! / (2^m m!) = log(n! / ((n-2m)! 2^m m!))
  const base = [];
  for (let m = 0; 2 * m <= n; m++) {
    const rest = A[n - 2 * m];
    base.push(rest > 0 ? logFact[n] - logFact[n - 2 * m] - m * Math.LN2 - logFact[m] + Math.log(rest) : -Infinity);
  }
  const target = n / (n - 1); // desired E[people in 2-cycles]
  const dist = (logLambda) => {
    const w = base.map((b, m) => b + m * logLambda);
    const max = Math.max(...w);
    const p = w.map((x) => Math.exp(x - max));
    const sum = p.reduce((a, b) => a + b, 0);
    return p.map((x) => x / sum);
  };
  const mean = (p) => p.reduce((acc, x, m) => acc + x * 2 * m, 0);
  let lo = -60;
  let hi = 60;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mean(dist(mid)) < target) lo = mid;
    else hi = mid;
  }
  const p = dist((lo + hi) / 2);
  cache.set(n, p);
  return p;
}

/** Uniform permutation of `ids` whose cycles are all at least 3 long. */
function longCycles(ids) {
  if (ids.length === 0) return new Map();
  for (;;) {
    const perm = shuffle(ids);
    const map = new Map(ids.map((g, i) => [g, perm[i]]));
    let ok = true;
    for (const [g, r] of map) {
      if (r === g || map.get(r) === g) {
        ok = false;
        break;
      }
    }
    if (ok) return map;
  }
}

/** Draw pairs. Returns a Map giverId -> receiverId. */
export function drawPairs(ids, minPeople = MIN_PEOPLE) {
  const n = ids.length;
  if (n < Math.max(minPeople, MIN_PEOPLE)) throw new Error(`Need at least ${Math.max(minPeople, MIN_PEOPLE)} people`);
  if (new Set(ids).size !== n) throw new Error('Duplicate ids');

  const probs = pairCountDistribution(n);
  let u = randomUnit();
  let m = 0;
  while (m < probs.length - 1 && u >= probs[m]) {
    u -= probs[m];
    m++;
  }
  if (probs[m] === 0) m = probs.findIndex((x) => x > 0);

  const order = shuffle(ids);
  const pairs = new Map();
  for (let i = 0; i < 2 * m; i += 2) {
    pairs.set(order[i], order[i + 1]);
    pairs.set(order[i + 1], order[i]);
  }
  for (const [g, r] of longCycles(order.slice(2 * m))) pairs.set(g, r);
  return pairs;
}
