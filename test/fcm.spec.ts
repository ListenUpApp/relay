import { describe, it, expect, vi } from "vitest";
import { FcmClient } from "../src/fcm";
import { makeTestServiceAccount, fakeFetch, tokenResponse } from "./helpers";

describe("FcmClient default fetch", () => {
  it("resolves the global fetch at call time (regression: bare-reference default threw Illegal invocation in workerd)", async () => {
    const { json } = await makeTestServiceAccount();
    const fcm = new FcmClient(json); // DEFAULT fetchFn — the production construction path
    // Stub AFTER construction: a capture-at-construction default would bypass this stub
    // (and, invoked as `this.fetchFn`, the bare global throws a synchronous
    // "Illegal invocation"), sending every real-world verdict to "retryable".
    const upstream = fakeFetch([tokenResponse(), new Response("{}", { status: 200 })]);
    vi.stubGlobal("fetch", upstream.fn);
    try {
      expect(await fcm.send("tok", { t: 1 })).toBe("delivered");
      expect(upstream.requests).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("FcmClient auth", () => {
  it("exchanges a signed JWT for an access token and caches it", async () => {
    const { json } = await makeTestServiceAccount();
    const upstream = fakeFetch([tokenResponse("at-1")]); // ONE response queued: a second network call would throw
    const fcm = new FcmClient(json, upstream.fn);
    expect(await fcm.accessToken()).toBe("at-1");
    expect(await fcm.accessToken()).toBe("at-1"); // cache hit — no second request
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(upstream.requests[0].body).toContain("grant_type=");
  });

  it("signs a verifiable RS256 JWT with the exact claim set", async () => {
    const { json, publicKey } = await makeTestServiceAccount();
    const upstream = fakeFetch([tokenResponse()]);
    const fcm = new FcmClient(json, upstream.fn);
    await fcm.accessToken();

    const assertion = new URLSearchParams(upstream.requests[0].body!).get("assertion")!;
    const [headerB64, claimsB64, sigB64] = assertion.split(".");
    const fromB64url = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

    expect(JSON.parse(new TextDecoder().decode(fromB64url(headerB64)))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(claimsB64)));
    expect(claims.iss).toBe("relay-test@test-project.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.exp).toBe(claims.iat + 3600);

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromB64url(sigB64),
      new TextEncoder().encode(`${headerB64}.${claimsB64}`),
    );
    expect(verified).toBe(true);
  });
});

describe("FcmClient send", () => {
  it("sends a HIGH-priority data message and maps 200 → delivered", async () => {
    const { json } = await makeTestServiceAccount();
    const upstream = fakeFetch([
      tokenResponse(),
      new Response(JSON.stringify({ name: "projects/test-project/messages/1" }), { status: 200 }),
    ]);
    const fcm = new FcmClient(json, upstream.fn);
    const verdict = await fcm.send("tok-1", { type: "test" }, "ck-1");
    expect(verdict).toBe("delivered");
    expect(upstream.requests[1].url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    const sentBody = JSON.parse(upstream.requests[1].body!);
    expect(sentBody.message.token).toBe("tok-1");
    expect(sentBody.message.android.priority).toBe("HIGH");
    expect(sentBody.message.android.collapse_key).toBe("ck-1");
    expect(JSON.parse(sentBody.message.data.payload)).toEqual({ type: "test" });
    expect(sentBody.message.notification).toBeUndefined(); // data-only, ALWAYS
  });

  it("omits collapse_key when not provided", async () => {
    const { json } = await makeTestServiceAccount();
    const upstream = fakeFetch([tokenResponse(), new Response("{}", { status: 200 })]);
    const fcm = new FcmClient(json, upstream.fn);
    await fcm.send("tok", { t: 1 });
    expect(JSON.parse(upstream.requests[1].body!).message.android.collapse_key).toBeUndefined();
  });

  it.each([
    [404, "invalid"], [400, "invalid"], [403, "invalid"],
    [401, "retryable"], [429, "retryable"], [500, "retryable"], [503, "retryable"],
  ])("maps FCM %i → %s", async (status, expected) => {
    const { json } = await makeTestServiceAccount();
    const upstream = fakeFetch([tokenResponse(), new Response("{}", { status: status as number })]);
    const fcm = new FcmClient(json, upstream.fn);
    expect(await fcm.send("tok", { t: 1 })).toBe(expected);
  });

  it("returns retryable when the token exchange itself fails", async () => {
    const { json } = await makeTestServiceAccount();
    const upstream = fakeFetch([new Response("denied", { status: 500 })]);
    const fcm = new FcmClient(json, upstream.fn);
    expect(await fcm.send("tok", { t: 1 })).toBe("retryable");
  });

  it("propagates transport errors from the send POST itself", async () => {
    const { json } = await makeTestServiceAccount();
    const upstream = fakeFetch([tokenResponse(), new Error("network down")]);
    const fcm = new FcmClient(json, upstream.fn);
    await expect(fcm.send("tok", { t: 1 })).rejects.toThrow("network down");
  });
});
