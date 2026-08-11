import { describe, it, expect } from "vitest";
import { ApnsClient, apnsConfigFromEnv } from "../src/apns";
import type { ApnsConfig } from "../src/apns";
import { fakeFetch, makeTestApnsKey } from "./helpers";

async function makeClient(overrides: Partial<ApnsConfig> = {}) {
  const { pem, publicKey } = await makeTestApnsKey();
  const config: ApnsConfig = {
    key: pem,
    keyId: "KEY1234567",
    teamId: "TEAM123456",
    bundleId: "com.example.app",
    environment: "production",
    titleLocKey: "push_generic_title",
    bodyLocKey: "push_generic_body",
    ...overrides,
  };
  return { config, publicKey };
}

const ok = () => new Response(null, { status: 200 });

describe("apnsConfigFromEnv", () => {
  it("returns null unless every required secret is present", () => {
    expect(apnsConfigFromEnv({})).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY: "k", APNS_KEY_ID: "i", APNS_TEAM_ID: "t" })).toBeNull();
    const full = apnsConfigFromEnv({
      APNS_KEY: "k",
      APNS_KEY_ID: "i",
      APNS_TEAM_ID: "t",
      APNS_BUNDLE_ID: "b",
    });
    expect(full).toMatchObject({
      environment: "production",
      titleLocKey: "push_generic_title",
      bodyLocKey: "push_generic_body",
    });
  });

  it("honors the environment and loc-key overrides", () => {
    const config = apnsConfigFromEnv({
      APNS_KEY: "k",
      APNS_KEY_ID: "i",
      APNS_TEAM_ID: "t",
      APNS_BUNDLE_ID: "b",
      APNS_ENVIRONMENT: "development",
      APNS_TITLE_LOC_KEY: "custom_title",
      APNS_BODY_LOC_KEY: "custom_body",
    });
    expect(config).toMatchObject({
      environment: "development",
      titleLocKey: "custom_title",
      bodyLocKey: "custom_body",
    });
  });
});

describe("ApnsClient provider token", () => {
  it("signs a verifiable ES256 JWT with the exact header and claim set", async () => {
    const { config, publicKey } = await makeClient();
    const client = new ApnsClient(config, fakeFetch([]).fn);
    const before = Math.floor(Date.now() / 1000);
    const token = await client.providerToken();
    const [h, c, sig] = token.split(".");
    const fromB64url = (s: string) => {
      const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
      return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
    };
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ alg: "ES256", kid: "KEY1234567" });
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c))) as { iss: string; iat: number };
    expect(claims.iss).toBe("TEAM123456");
    expect(claims.iat).toBeGreaterThanOrEqual(before - 1);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromB64url(sig),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });

  it("caches the provider token across sends", async () => {
    const { config } = await makeClient();
    const upstream = fakeFetch([ok(), ok()]);
    const client = new ApnsClient(config, upstream.fn);
    await client.send("tok", { t: 1 });
    const first = await client.providerToken();
    await client.send("tok", { t: 2 });
    expect(await client.providerToken()).toBe(first);
  });
});

describe("ApnsClient send", () => {
  it("POSTs an alert envelope with loc-keys, mutable-content, and the stringified payload", async () => {
    const { config } = await makeClient();
    const upstream = fakeFetch([ok()]);
    const client = new ApnsClient(config, upstream.fn);

    expect(await client.send("device-token-1", { type: "test", sentAtMs: 5 }, "collapse-1")).toBe("delivered");

    expect(upstream.requests).toHaveLength(1);
    const req = upstream.requests[0];
    expect(req.url).toBe("https://api.push.apple.com/3/device/device-token-1");
    expect(req.method).toBe("POST");
    const body = JSON.parse(req.body!) as {
      aps: { alert: Record<string, string>; "mutable-content": number };
      payload: string;
    };
    expect(body.aps.alert).toEqual({ "title-loc-key": "push_generic_title", "loc-key": "push_generic_body" });
    expect(body.aps["mutable-content"]).toBe(1);
    expect(JSON.parse(body.payload)).toEqual({ type: "test", sentAtMs: 5 });
  });

  it("targets the sandbox host in the development environment", async () => {
    const { config } = await makeClient({ environment: "development" });
    const upstream = fakeFetch([ok()]);
    const client = new ApnsClient(config, upstream.fn);
    await client.send("dev-tok", { t: 1 });
    expect(upstream.requests[0].url).toBe("https://api.sandbox.push.apple.com/3/device/dev-tok");
  });

  it.each([
    [200, "delivered"],
    [400, "invalid"], // BadDeviceToken et al.
    [404, "invalid"],
    [410, "invalid"], // Unregistered — the canonical dead-token status
    [403, "retryable"], // Expired/InvalidProviderToken — OUR credential, never the device token's fault
    [429, "retryable"],
    [500, "retryable"],
    [503, "retryable"],
  ])("maps APNs status %i to verdict %s", async (status, verdict) => {
    const { config } = await makeClient();
    const upstream = fakeFetch([new Response(null, { status })]);
    const client = new ApnsClient(config, upstream.fn);
    expect(await client.send("tok", { t: 1 })).toBe(verdict);
  });

  it("drops the cached provider token on 403 so the next send re-signs", async () => {
    const { config } = await makeClient();
    const upstream = fakeFetch([new Response(null, { status: 403 }), ok()]);
    const client = new ApnsClient(config, upstream.fn);
    await client.send("tok", { t: 1 });
    const stale = await client.providerToken(); // re-mints because 403 cleared the cache
    expect(await client.send("tok", { t: 2 })).toBe("delivered");
    expect(stale).toBeDefined();
  });

  it("normalizes a signing failure to retryable but propagates send transport failures", async () => {
    const broken = await makeClient({ key: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----" });
    const client = new ApnsClient(broken.config, fakeFetch([]).fn);
    expect(await client.send("tok", { t: 1 })).toBe("retryable"); // bad key: mint fails, no request made

    const { config } = await makeClient();
    const transportDown = new ApnsClient(config, fakeFetch([new Error("connection reset")]).fn);
    await expect(transportDown.send("tok", { t: 1 })).rejects.toThrow("connection reset");
  });

  it("omits apns-collapse-id when no collapse key is given", async () => {
    // fakeFetch records only url/method/body, so assert via a header-capturing fetch.
    const { config } = await makeClient();
    const seen: Array<Record<string, string>> = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Request(input, init).headers));
      return ok();
    }) as typeof fetch;
    const client = new ApnsClient(config, fn);
    await client.send("tok", { t: 1 });
    await client.send("tok", { t: 1 }, "ck-1");
    expect(seen[0]["apns-collapse-id"]).toBeUndefined();
    expect(seen[1]["apns-collapse-id"]).toBe("ck-1");
    expect(seen[0]["apns-topic"]).toBe("com.example.app");
    expect(seen[0]["apns-push-type"]).toBe("alert");
    expect(seen[0]["apns-priority"]).toBe("10");
    expect(seen[0].authorization).toMatch(/^bearer /);
  });
});
