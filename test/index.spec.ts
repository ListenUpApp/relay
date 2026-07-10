import { describe, it, expect } from "vitest";
import { intEnv } from "../src/index";

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
