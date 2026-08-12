import { SELF } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

// Fixed test value — see vitest.config.ts's SENDER_TOKEN binding.
const VALID_TOKEN = "test-sender-secret";

// Same stub-upstream shape as test/send.spec.ts (see the comment there for why
// each test file installs its own `beforeAll` global-fetch stub rather than
// re-stubbing per test): FcmClient memoizes whatever `fetch` resolves to at its
// first construction in this isolate.
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

function stubFcmOk() {
  currentHandler = (req) => {
    if (req.url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    }
    if (req.url.includes("fcm.googleapis.com")) {
      return new Response(JSON.stringify({ name: "projects/test/messages/1" }), { status: 200 });
    }
    throw new Error(`unexpected upstream: ${req.url}`);
  };
}

function send(ip: string, authorization?: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip, "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  return SELF.fetch("https://relay.test/v1/send", {
    method: "POST",
    headers,
    body: JSON.stringify({ tokens: [{ platform: "android", token: "tok" }], payload: { type: "test" } }),
  });
}

// Every test below uses its own IP so the shared, isolate-wide RateLimiter maps
// (module-scoped in src/index.ts) never cross-contaminate — same convention as
// test/send.spec.ts.
describe("sender credential (phase 1: optional -> mandatory)", () => {
  it("a valid bearer token proceeds", async () => {
    stubFcmOk();
    const res = await send("10.0.3.1", `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("an absent credential still proceeds (migration window)", async () => {
    stubFcmOk();
    const res = await send("10.0.3.2");
    expect(res.status).toBe(200);
  });

  it("an invalid bearer token is rejected with 401, before any provider is contacted", async () => {
    const res = await send("10.0.3.3", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("a non-Bearer Authorization header is rejected with 401", async () => {
    const res = await send("10.0.3.4", "Basic dXNlcjpwYXNz");
    expect(res.status).toBe(401);
  });

  it("never logs the credential", async () => {
    const methods = ["log", "warn", "error", "info", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));

    const res = await send("10.0.3.5", "Bearer this-credential-must-never-be-logged");
    expect(res.status).toBe(401);

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const joined = call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
        expect(joined).not.toContain("this-credential-must-never-be-logged");
      }
      spy.mockRestore();
    }
  });
});
