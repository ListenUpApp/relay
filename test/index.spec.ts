import { describe, it, expect } from "vitest";
import { intEnv, checkSenderCredential } from "../src/index";

describe("intEnv", () => {
  it("falls back on undefined", () => {
    expect(intEnv(undefined, 42)).toBe(42);
  });
  it("falls back on zero (not a positive limit)", () => {
    expect(intEnv("0", 42)).toBe(42);
  });
  it("falls back on negative values", () => {
    expect(intEnv("-5", 42)).toBe(42);
  });
  it("falls back on non-numeric strings", () => {
    expect(intEnv("abc", 42)).toBe(42);
  });
  it("parses a valid positive integer string", () => {
    expect(intEnv("7", 42)).toBe(7);
  });
});

describe("checkSenderCredential", () => {
  const request = (authorization?: string) =>
    new Request("https://relay.test/v1/send", authorization === undefined ? {} : { headers: { authorization } });

  it("is absent when the relay has no SENDER_TOKEN configured, even with a header sent", () => {
    expect(checkSenderCredential(request(), undefined)).toBe("absent");
    expect(checkSenderCredential(request("Bearer whatever"), undefined)).toBe("absent");
  });

  it("is absent when no Authorization header is sent (migration window)", () => {
    expect(checkSenderCredential(request(), "secret")).toBe("absent");
  });

  it("is invalid when the header isn't a Bearer credential", () => {
    expect(checkSenderCredential(request("Basic dXNlcjpwYXNz"), "secret")).toBe("invalid");
  });

  it("is invalid when the bearer token doesn't match", () => {
    expect(checkSenderCredential(request("Bearer wrong"), "secret")).toBe("invalid");
  });

  it("is invalid when the bearer token has the right prefix but differs in length", () => {
    expect(checkSenderCredential(request("Bearer sec"), "secret")).toBe("invalid");
  });

  it("is valid when the bearer token matches exactly", () => {
    expect(checkSenderCredential(request("Bearer secret"), "secret")).toBe("valid");
  });
});
