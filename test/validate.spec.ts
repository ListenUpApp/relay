import { describe, it, expect } from "vitest";
import { validateSendRequest } from "../src/validate";
import { MAX_PAYLOAD_BYTES } from "../src/types";

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
  it("rejects grossly oversized payloads", () => {
    const r = validateSendRequest({ ...good(), payload: { blob: "x".repeat(5000) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });
  it("accepts a payload at exactly the byte cap and rejects one byte over it", () => {
    // Build a single-key payload and grow the "x" run until its serialized
    // UTF-8 size lands exactly on MAX_PAYLOAD_BYTES, computed programmatically
    // rather than hand-derived from the envelope's fixed overhead.
    const byteSizeOf = (blobLength: number) =>
      new TextEncoder().encode(JSON.stringify({ blob: "x".repeat(blobLength) })).length;
    const overhead = byteSizeOf(0); // bytes contributed by `{"blob":""}` alone
    const atCapLength = MAX_PAYLOAD_BYTES - overhead;

    const atCap = { blob: "x".repeat(atCapLength) };
    const overCap = { blob: "x".repeat(atCapLength + 1) };
    expect(byteSizeOf(atCapLength)).toBe(MAX_PAYLOAD_BYTES);
    expect(byteSizeOf(atCapLength + 1)).toBe(MAX_PAYLOAD_BYTES + 1);

    expect(validateSendRequest({ ...good(), payload: atCap }).ok).toBe(true);
    const over = validateSendRequest({ ...good(), payload: overCap });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(413);
  });
  it("rejects non-object payloads and missing fields", () => {
    expect(validateSendRequest({ tokens: [{ platform: "android", token: "t" }] }).ok).toBe(false);
    expect(validateSendRequest({ ...good(), payload: "str" }).ok).toBe(false);
    expect(validateSendRequest(null).ok).toBe(false);
  });
});
