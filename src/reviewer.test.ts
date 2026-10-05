import { describe, expect, it } from "vitest";

import { estimateTokens } from "./reviewer.js";

describe("estimateTokens", () => {
  it("counts ASCII at 2.5 characters per token, the dense end of code and JSON", () => {
    expect(estimateTokens("x".repeat(25_000))).toBe(10_000);
  });

  it("counts other characters at 1.1 tokens, above the measured Japanese rate", () => {
    // Jev counted 20,988 tokens for 20,000 Japanese characters.
    expect(estimateTokens("日".repeat(20_000))).toBe(22_000);
  });

  it("counts a surrogate pair as one character", () => {
    expect(estimateTokens("😀")).toBe(2);
  });
});
