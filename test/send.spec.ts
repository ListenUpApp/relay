import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("healthz", () => {
  it("responds 200 with ok", async () => {
    const res = await SELF.fetch("https://relay.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s unknown routes", async () => {
    const res = await SELF.fetch("https://relay.test/nope");
    expect(res.status).toBe(404);
  });
});
