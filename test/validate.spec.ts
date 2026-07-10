import { describe, it, expect } from "vitest";
import { validateSendRequest } from "../src/validate";

const good = () => ({
  tokens: [{ platform: "android", token: "tok-1" }],
  payload: { type: "test", sentAt: "2026-07-10T00:00:00Z" },
});

describe("validateSendRequest", () => {
  it("accepts a well-formed request", () => {
    const r = validateSendRequest(good());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tokens[0].token).toBe("tok-1");
  });
  it("accepts optional collapseKey ≤ 64 chars", () => {
    expect(validateSendRequest({ ...good(), collapseKey: "a".repeat(64) }).ok).toBe(true);
    expect(validateSendRequest({ ...good(), collapseKey: "a".repeat(65) }).ok).toBe(false);
  });
  it("rejects empty and oversized token arrays", () => {
    expect(validateSendRequest({ ...good(), tokens: [] }).ok).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ platform: "android", token: `t${i}` }));
    expect(validateSendRequest({ ...good(), tokens: many }).ok).toBe(false);
  });
  it("rejects unknown platforms and oversized tokens", () => {
    expect(validateSendRequest({ ...good(), tokens: [{ platform: "web", token: "t" }] }).ok).toBe(false);
    expect(validateSendRequest({ ...good(), tokens: [{ platform: "android", token: "x".repeat(4097) }] }).ok).toBe(false);
  });
  it("rejects payloads over 4 KB serialized", () => {
    const r = validateSendRequest({ ...good(), payload: { blob: "x".repeat(5000) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });
  it("rejects non-object payloads and missing fields", () => {
    expect(validateSendRequest({ tokens: [{ platform: "android", token: "t" }] }).ok).toBe(false);
    expect(validateSendRequest({ ...good(), payload: "str" }).ok).toBe(false);
    expect(validateSendRequest(null).ok).toBe(false);
  });
});
