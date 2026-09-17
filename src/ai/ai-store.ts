// In-memory per-user rate limiter and TTL cache. Both prune expired entries
// on access so the maps never grow unbounded.

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consumes one unit for `key`. Returns false when the window quota is exhausted. */
  consume(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const t = this.now();
    this.prune(t);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, b);
    }
    if (b.count >= this.limit) return { allowed: false, remaining: 0, resetAt: b.resetAt };
    b.count++;
    return { allowed: true, remaining: this.limit - b.count, resetAt: b.resetAt };
  }

  size(): number {
    return this.buckets.size;
  }

  private prune(t: number) {
    for (const [k, b] of this.buckets) if (b.resetAt <= t) this.buckets.delete(k);
  }
}

export class TtlCache<T = unknown> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 2000,
  ) {}

  get(key: string): T | undefined {
    const t = this.now();
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= t) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T): void {
    const t = this.now();
    this.prune(t);
    this.entries.set(key, { value, expiresAt: t + this.ttlMs });
  }

  size(): number {
    return this.entries.size;
  }

  private prune(t: number) {
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
    // Hard cap: drop oldest insertions when still too large.
    while (this.entries.size >= this.maxEntries) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
    }
  }
}
