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
});
