import { RateLimiter, TtlCache } from './ai-store';

describe('RateLimiter', () => {
  it('is per key, blocks after the limit and resets after the window', () => {
    let t = 1_000;
    const rl = new RateLimiter(3, 100, () => t);
    expect(rl.consume('a').allowed).toBe(true);
    expect(rl.consume('a').allowed).toBe(true);
    expect(rl.consume('a')).toMatchObject({ allowed: true, remaining: 0 });
    expect(rl.consume('a').allowed).toBe(false);
    // Another key is unaffected.
    expect(rl.consume('b').allowed).toBe(true);
    // Window elapsed: quota restored and stale buckets pruned.
    t += 101;
    expect(rl.consume('a').allowed).toBe(true);
    expect(rl.size()).toBe(1);
  });
});

describe('TtlCache', () => {
  it('expires entries, prunes on write and caps its size', () => {
    let t = 0;
    const c = new TtlCache<number>(50, () => t, 3);
    c.set('k1', 1);
    expect(c.get('k1')).toBe(1);
    t = 49;
    expect(c.get('k1')).toBe(1);
    t = 50;
    expect(c.get('k1')).toBeUndefined();
    expect(c.size()).toBe(0);

    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4); // exceeds maxEntries(3): oldest dropped
    expect(c.get('a')).toBeUndefined();
    expect(c.get('d')).toBe(4);
    expect(c.size()).toBeLessThanOrEqual(3);
  });
});
