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
});
