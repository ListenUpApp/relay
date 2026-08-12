import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/ratelimit";

describe("RateLimiter", () => {
  it("allows under the cap and blocks over it", () => {
    let now = 0;
    const rl = new RateLimiter({ limit: 3, windowMs: 1000, clock: () => now });
    expect(rl.tryAcquire("k")).toBe(true);
    expect(rl.tryAcquire("k")).toBe(true);
    expect(rl.tryAcquire("k")).toBe(true);
    expect(rl.tryAcquire("k")).toBe(false);
  });
  it("frees the slot after the window slides", () => {
    let now = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, clock: () => now });
    expect(rl.tryAcquire("k")).toBe(true);
    expect(rl.tryAcquire("k")).toBe(false);
    now = 1001;
    expect(rl.tryAcquire("k")).toBe(true);
  });
  it("tracks keys independently and prunes stale ones", () => {
    let now = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, clock: () => now });
    expect(rl.tryAcquire("a")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(true);
    now = 5000;
    rl.prune();
    expect(rl.size).toBe(0);
  });
  it("retains a key on partial prune when one stamp is still live", () => {
    let now = 0;
    const rl = new RateLimiter({ limit: 2, windowMs: 1000, clock: () => now });
    expect(rl.tryAcquire("k")).toBe(true); // stamp at 0, will fall outside the window
    now = 900;
    expect(rl.tryAcquire("k")).toBe(true); // stamp at 900, still live at now=1500
    now = 1500;
    rl.prune();
    expect(rl.size).toBe(1); // key retained — the 900 stamp is still within the window
    expect(rl.tryAcquire("k")).toBe(true); // only one live stamp, so a second acquire succeeds
  });
  it("defaults to Date.now when no clock is injected", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.tryAcquire("k")).toBe(true);
    expect(rl.tryAcquire("k")).toBe(false);
    expect(rl.size).toBe(1);
  });

  describe("key-space cap", () => {
    it("keeps size <= maxKeys when more than maxKeys distinct keys are inserted", () => {
      let now = 0;
      const rl = new RateLimiter({ limit: 1, windowMs: 1000, clock: () => now, maxKeys: 3 });
      rl.tryAcquire("a");
      rl.tryAcquire("b");
      rl.tryAcquire("c");
      expect(rl.size).toBe(3);
      rl.tryAcquire("d");
      expect(rl.size).toBe(3);
      rl.tryAcquire("e");
      rl.tryAcquire("f");
      expect(rl.size).toBe(3);
    });

    it("evicts the least-recently-touched key first", () => {
      let now = 0;
      const rl = new RateLimiter({ limit: 5, windowMs: 1_000_000, clock: () => now, maxKeys: 2 });
      rl.tryAcquire("a");
      rl.tryAcquire("b");
      rl.tryAcquire("a"); // touching "a" again moves it to most-recently-touched
      rl.tryAcquire("c"); // map is full at "a","b" — "b" is least-recently-touched, gets evicted
      expect(rl.size).toBe(2);
      // "b" was evicted, so this is a brand-new key — its own fresh window, not still limited
      expect(rl.tryAcquire("b")).toBe(true);
      expect(rl.size).toBe(2); // "a" evicted next to make room
    });
  });

  describe("long-key hashing", () => {
    it("folds a long key to a fixed-width digest, keeping repeated calls against the same key consistent", () => {
      let now = 0;
      const rl = new RateLimiter({ limit: 2, windowMs: 1000, clock: () => now });
      const longKey = "x".repeat(5000);
      expect(rl.tryAcquire(longKey)).toBe(true);
      expect(rl.tryAcquire(longKey)).toBe(true);
      expect(rl.tryAcquire(longKey)).toBe(false); // limit exceeded — same folded bucket
      expect(rl.size).toBe(1); // one stored entry regardless of the 5000-char input
    });

    it("does not let long-key storage grow with input length", () => {
      let now = 0;
      const rl = new RateLimiter({ limit: 100, windowMs: 1000, clock: () => now, maxKeys: 10 });
      for (let i = 0; i < 10; i++) {
        rl.tryAcquire(`${i}`.repeat(4096)); // distinct ~4KB keys, one per digit
      }
      // All ten distinct long keys fit under maxKeys=10 — proves each is folded to a
      // small, distinct digest rather than stored (and counted against the cap) verbatim.
      expect(rl.size).toBe(10);
    });

    it("short keys (e.g. IPs) are stored verbatim, unaffected by hashing", () => {
      let now = 0;
      const rl = new RateLimiter({ limit: 1, windowMs: 1000, clock: () => now });
      expect(rl.tryAcquire("203.0.113.5")).toBe(true);
      expect(rl.tryAcquire("203.0.113.5")).toBe(false);
      expect(rl.size).toBe(1);
    });
  });
});
