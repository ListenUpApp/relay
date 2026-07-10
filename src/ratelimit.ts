interface Options {
  limit: number;
  windowMs: number;
  clock?: () => number; // injectable for tests; defaults to Date.now
}

/**
 * In-memory sliding-window limiter. Counters are the ONLY state this worker
 * keeps, and they are isolate-local and ephemeral — this is the no-log
 * invariant's friend, not a hard global limit (see README: WAF rate rules).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(opts: Options) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.clock = opts.clock ?? Date.now;
  }

  tryAcquire(key: string): boolean {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const stamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (stamps.length >= this.limit) {
      this.hits.set(key, stamps);
      return false;
    }
    stamps.push(now);
    this.hits.set(key, stamps);
    return true;
  }

  prune(): void {
    const cutoff = this.clock() - this.windowMs;
    for (const [key, stamps] of this.hits) {
      const live = stamps.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
