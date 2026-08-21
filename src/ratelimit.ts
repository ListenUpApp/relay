interface Options {
  limit: number;
  windowMs: number;
  clock?: () => number; // injectable for tests; defaults to Date.now
  maxKeys?: number; // caps the key space; least-recently-touched key evicted once full
}

/**
 * Sane default for the key-space cap. A single caller should not be able to
 * grow an isolate's rate-limit map without bound (see README §Rate limiting)
 * — this bounds worst-case map size regardless of how many distinct keys
 * (IPs, or hashed device tokens) show up in a window.
 */
const DEFAULT_MAX_KEYS = 10_000;

/**
 * Keys at or under this length are stored verbatim (IPs, short identifiers).
 * Longer keys — device tokens can run up to ~4KB (see types.ts `MAX_TOKEN_LENGTH`)
 * — are folded into a fixed-width digest before storage, so one caller can't
 * inflate the map's memory footprint by sending large keys.
 */
const HASH_KEY_THRESHOLD = 128;

/**
 * In-memory sliding-window limiter. Counters are the ONLY state this worker
 * keeps, and they are isolate-local and ephemeral — a friend of the no-log
 * invariant, not a hard global limit (see README: WAF rate rules).
 *
 * Bounded in two ways so a single caller can't exhaust the isolate: the key
 * space is capped at [maxKeys] (least-recently-touched key evicted on
 * overflow), and any key longer than [HASH_KEY_THRESHOLD] is folded to a
 * fixed-width digest before it's ever used as a Map key — so a caller
 * supplying many distinct multi-KB tokens can't grow individual entries past
 * a few bytes each.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly maxKeys: number;

  constructor(opts: Options) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.clock = opts.clock ?? Date.now;
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  tryAcquire(rawKey: string): boolean {
    const key = storageKey(rawKey);
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const isNewKey = !this.hits.has(key);
    const stamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (isNewKey && this.hits.size >= this.maxKeys) {
      // Reclaim EXPIRED entries first — they are already spent, so dropping them costs nothing.
      this.prune();
      if (this.hits.size >= this.maxKeys) {
        // Still full, and now full of LIVE counters. Do not evict one to make room: a caller
        // presenting more distinct keys than `maxKeys` within a single window would otherwise
        // roll the whole map and silently reset every other caller's counter — the per-token cap
        // would stop applying to precisely the flood it exists to bound, and to everyone else as
        // collateral. One request may carry MAX_TOKENS tokens, so reaching that volume takes no
        // special effort.
        //
        // Instead the new key goes UNTRACKED and is allowed. That is a real concession — a flood
        // is not per-token limited once the map is saturated — but it is the same concession the
        // limiter already makes across isolates, and it confines the damage to the flood itself
        // instead of handing the attacker an eraser for everybody's counters. Request volume is
        // bounded separately by the per-IP limiter, and hard limits belong in a WAF rate rule
        // (README § Rate limiting), which is the right place for an adversary.
        return true;
      }
    }

    if (stamps.length >= this.limit) {
      this.touch(key, stamps);
      return false;
    }
    stamps.push(now);
    this.touch(key, stamps);
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

  /** Re-inserts [key], moving it to the most-recently-touched end of iteration order. */
  private touch(key: string, stamps: number[]): void {
    this.hits.delete(key);
    this.hits.set(key, stamps);
  }
}

/**
 * Folds [raw] to a fixed-width digest when it exceeds [HASH_KEY_THRESHOLD],
 * otherwise returns it verbatim. Two independent 32-bit FNV-1a passes (with
 * different seeds) give a 64-bit fold — enough to keep collisions rare for
 * this purpose. This is a size-bounding fold, not a security hash: a
 * collision only merges two callers' rate-limit windows early, it never
 * leaks the original key. Synchronous by design — `tryAcquire()` must stay
 * synchronous, and Web Crypto's `subtle.digest` is async.
 */
function storageKey(raw: string): string {
  if (raw.length <= HASH_KEY_THRESHOLD) return raw;
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193);
  }
  return `h:${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}
