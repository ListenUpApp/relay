import { SELF } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

// Runs under vitest.config.apns.ts's project — its own isolate, with
// APNS_* bindings configured, so /v1/send's sendIos() drives a real
// ApnsClient against a stubbed api.push.apple.com instead of returning
// "unsupported". See test/send.spec.ts for the module-scope-memoization
// rationale behind the single stubGlobal("fetch", ...) + swappable
// currentHandler shape used here.
type Handler = (req: Request, init: RequestInit | undefined) => Promise<Response> | Response;
let currentHandler: Handler | null = null;

beforeAll(() => {
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!currentHandler) throw new Error("stubUpstream: no handler installed for the running test");
    const req = new Request(input, init);
    return currentHandler(req, init);
  }) as typeof fetch);
});

afterEach(() => {
  currentHandler = null;
});

function stubApnsUpstream(responses: Array<Response | Error>) {
  const calls: { url: string; body: string | null }[] = [];
  currentHandler = (req, init) => {
    calls.push({ url: req.url, body: init?.body != null ? String(init.body) : null });
    if (req.url.includes("api.push.apple.com") || req.url.includes("api.sandbox.push.apple.com")) {
      const next = responses.shift();
      if (next === undefined) throw new Error("stubApnsUpstream: no response queued");
      if (next instanceof Error) throw next;
      return next;
    }
    throw new Error(`unexpected upstream: ${req.url}`);
  };
  return calls;
}

function send(ip: string, body: unknown): Promise<Response> {
  return SELF.fetch("https://relay.test/v1/send", {
    method: "POST",
    headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /v1/send — APNs configured", () => {
  it("delivers an ios push on a 200 from Apple", async () => {
    stubApnsUpstream([new Response(null, { status: 200 })]);

    const res = await send("10.0.2.1", {
      tokens: [{ platform: "ios", token: "ios-ok" }],
      payload: { type: "test" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ token: "ios-ok", status: "delivered" }] });
  });

  it("marks the token invalid on Apple's 410 Unregistered", async () => {
    stubApnsUpstream([new Response(null, { status: 410 })]);

    const res = await send("10.0.2.2", {
      tokens: [{ platform: "ios", token: "ios-dead" }],
      payload: { type: "test" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ token: "ios-dead", status: "invalid" }] });
  });

  it("yields retryable when the transport to Apple fails", async () => {
    stubApnsUpstream([new Error("connection reset")]);

    const res = await send("10.0.2.3", {
      tokens: [{ platform: "ios", token: "ios-flaky" }],
      payload: { type: "test" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ token: "ios-flaky", status: "retryable" }] });
  });
});
