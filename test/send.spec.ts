import { SELF } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

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

// --- /v1/send upstream stubbing -------------------------------------------------
//
// `src/index.ts` memoizes its RateLimiters and FcmClient at module scope
// (`ipLimiter ??= ...`, `fcm ??= ...`) — deliberate isolate-local warm reuse, the
// same shape production wants. The consequence for tests: FcmClient captures
// whatever the `fetch` identifier resolves to only ONCE, at its first
// construction in this isolate. A fresh `vi.stubGlobal("fetch", ...)` per test
// would only be visible to a *new* FcmClient instance — never to the one already
// memoized from an earlier test in this file. So instead of re-stubbing per test,
// we stub the global exactly once with a stable dispatcher (`beforeAll` below),
// and each test only swaps out `currentHandler`, which the dispatcher reads on
// every call. This is correct regardless of exactly when FcmClient's fetchFn was
// captured.
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

function stubUpstream(fcmResponses: Array<Response>) {
  const calls: { url: string; body: string | null }[] = [];
  currentHandler = (req, init) => {
    calls.push({ url: req.url, body: init?.body != null ? String(init.body) : null });
    if (req.url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    }
    if (req.url.includes("fcm.googleapis.com")) {
      return fcmResponses.shift() ?? new Response("unexpected", { status: 500 });
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

// Every test below uses its own IP (and, where relevant, its own token names) so
// that the shared, isolate-wide RateLimiter maps (module-scoped in src/index.ts)
// never cross-contaminate between tests — see the comment above.
describe("POST /v1/send", () => {
  it("fans out and returns per-token verdicts; ios is unsupported, android is delivered", async () => {
    stubUpstream([new Response(JSON.stringify({ name: "projects/test/messages/1" }), { status: 200 })]);

    const res = await send("10.0.1.1", {
      tokens: [
        { platform: "android", token: "andro-1" },
        { platform: "ios", token: "ios-1" },
      ],
      payload: { type: "test" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { token: "andro-1", status: "delivered" },
        { token: "ios-1", status: "unsupported" },
      ],
    });
  });

  it("400s invalid bodies and 413s an oversized payload", async () => {
    const malformed = await send("10.0.1.2", "{not json");
    expect(malformed.status).toBe(400);
    expect((await malformed.json()) as { error: string }).toEqual({ error: "invalid JSON" });

    const missingTokens = await send("10.0.1.2", { payload: { a: 1 } });
    expect(missingTokens.status).toBe(400);

    const oversized = await send("10.0.1.2", {
      tokens: [{ platform: "android", token: "t" }],
      payload: { blob: "x".repeat(5000) },
    });
    expect(oversized.status).toBe(413);
  });

  it("never logs request-derived data", async () => {
    const methods = ["log", "warn", "error", "info", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));

    stubUpstream([new Response("{}", { status: 200 })]);
    const res = await send("10.0.1.3", {
      tokens: [{ platform: "android", token: "SECRET-TOKEN" }],
      payload: { secret: "SECRET-PAYLOAD" },
    });
    expect(res.status).toBe(200);

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const joined = call
          .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" ");
        expect(joined).not.toContain("SECRET-TOKEN");
        expect(joined).not.toContain("SECRET-PAYLOAD");
      }
      spy.mockRestore();
    }
  });

  it("429s with Retry-After once the per-IP limit is exhausted", async () => {
    // RATE_LIMIT_PER_IP is bound to "5" for tests (see vitest.config.ts). Loop
    // up to limit+1 requests, each with a fresh token so the per-token limiter
    // (bound to "2") never interferes, from one dedicated IP so no other test
    // can affect — or be affected by — this counter.
    stubUpstream(Array.from({ length: 6 }, () => new Response("{}", { status: 200 })));

    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await send("10.0.1.4", {
        tokens: [{ platform: "android", token: `ip4-tok-${i}` }],
        payload: { n: i },
      });
      if (last.status === 429) break;
    }

    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBe("3600");
  });

  it("per-token rate limit yields retryable for that token, while another token still delivers", async () => {
    // RATE_LIMIT_PER_TOKEN is bound to "2" for tests. Send the same token three
    // times in one request (plus a distinct token) to exercise the limiter
    // without needing multiple round trips.
    stubUpstream([
      new Response("{}", { status: 200 }), // dup-tok #1
      new Response("{}", { status: 200 }), // dup-tok #2
      new Response("{}", { status: 200 }), // other-tok
    ]);

    const res = await send("10.0.1.5", {
      tokens: [
        { platform: "android", token: "dup-tok" },
        { platform: "android", token: "dup-tok" },
        { platform: "android", token: "dup-tok" },
        { platform: "android", token: "other-tok" },
      ],
      payload: { n: 1 },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { token: string; status: string }[] };
    expect(body.results).toEqual([
      { token: "dup-tok", status: "delivered" },
      { token: "dup-tok", status: "delivered" },
      { token: "dup-tok", status: "retryable" },
      { token: "other-tok", status: "delivered" },
    ]);
  });
});
