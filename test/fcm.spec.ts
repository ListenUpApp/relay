import { describe, it, expect } from "vitest";
import { FcmClient } from "../src/fcm";
import { makeTestServiceAccount, fakeFetch, tokenResponse } from "./helpers";

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
