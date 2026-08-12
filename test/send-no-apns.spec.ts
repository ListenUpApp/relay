import { SELF } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

// Runs under vitest.config.default.ts's project — the isolate where APNs is
// UNCONFIGURED (no APNS_* bindings), so apnsConfigFromEnv resolves null and
// every ios token gets "unsupported" from sendIos(). These two cases used to
// live in test/send.spec.ts; they moved here once test/send-apns.spec.ts
// started exercising the real APNs path under its own isolate (see
// vitest.config.ts) — a single isolate can't be both "APNs configured" and
// "APNs absent" at once, since src/index.ts memoizes the ApnsClient at
// module scope. See test/send.spec.ts for the stubUpstream/currentHandler
// rationale reused here.
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

describe("POST /v1/send — APNs unconfigured", () => {
  it("fans out and returns per-token verdicts; ios is unsupported when APNs is unconfigured, android is delivered", async () => {
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

  it("an already rate-limited ios token yields retryable, not unsupported", async () => {
    // RATE_LIMIT_PER_TOKEN is bound to "2" for tests. Send the same ios token
    // three times in one request: the first two clear the token limiter and
    // fall through to the APNs path — unconfigured here, so "unsupported";
    // the third is rate-limited before APNs is ever consulted → "retryable".
    const res = await send("10.0.1.6", {
      tokens: [
        { platform: "ios", token: "ios-rl-tok" },
        { platform: "ios", token: "ios-rl-tok" },
        { platform: "ios", token: "ios-rl-tok" },
      ],
      payload: { n: 1 },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { token: string; status: string }[] };
    expect(body.results.map((r) => r.status)).toEqual(["unsupported", "unsupported", "retryable"]);
  });
});
