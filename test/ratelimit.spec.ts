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
});
