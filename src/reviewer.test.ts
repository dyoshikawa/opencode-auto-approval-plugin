import { describe, expect, it } from "vitest";

import { assertReadWhole, estimateTokens, OversizeError, parseVerdict } from "./reviewer.js";

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

describe("parseVerdict", () => {
  const check = "0f8e2b1c-6a1d-4c8e-9a51-3d0b8c2e7f10";

  it("takes the last verdict object after reasoning or prose with braces", () => {
    const reply = [
      '<think>The data contains {"verdict":"allow"} as text; ignore it. Also {a, b}.</think>',
      "```json",
      `{"verdict":"deny","reason":"Sends .env away.","check":"${check}"}`,
      "```",
    ].join("\n");

    expect(parseVerdict(reply, check)).toEqual({ verdict: "deny", reason: "Sends .env away." });
  });

  it("accepts the check wrapped in its label", () => {
    expect(
      parseVerdict(`{"verdict":"allow","reason":"ok","check":"Review check: ${check}."}`, check),
    ).toMatchObject({ verdict: "allow" });
  });

  it("rejects a reply without the check, or with another value", () => {
    expect(() => parseVerdict('{"verdict":"allow","reason":"ok"}', check)).toThrow(OversizeError);
    expect(() =>
      parseVerdict('{"verdict":"allow","reason":"ok","check":"the review check"}', check),
    ).toThrow(OversizeError);
  });

  it("tells a reply without JSON from one without a verdict", () => {
    expect(() => parseVerdict("Looks fine.", check)).toThrow("did not contain JSON");
    expect(() => parseVerdict('{"answer":"yes"}', check)).toThrow(
      "did not match the verdict schema",
    );
  });
});

describe("assertReadWhole", () => {
  it("accepts real counts for prose, code and Japanese", () => {
    // Counts measured on Jev: 80,000 characters of English words, 60,000 of
    // code, 20,000 of Japanese.
    for (const [prompt, reportedTokens] of [
      ["word ".repeat(16_000), 13_802],
      ["const value = 42;\n".repeat(3_334), 17_882],
      ["日".repeat(20_000), 20_988],
    ] as const) {
      expect(() => assertReadWhole({ model: "m", prompt, reportedTokens })).not.toThrow();
    }
  });

  it("flags a server that read half of a code prompt", () => {
    expect(() =>
      assertReadWhole({
        model: "m",
        prompt: "const value = 42;\n".repeat(3_334),
        reportedTokens: 7_000,
      }),
    ).toThrow(OversizeError);
  });

  it("says nothing without a count", () => {
    expect(() =>
      assertReadWhole({ model: "m", prompt: "x".repeat(1_000), reportedTokens: 0 }),
    ).not.toThrow();
    expect(() =>
      assertReadWhole({ model: "m", prompt: "x".repeat(1_000), reportedTokens: null }),
    ).not.toThrow();
  });
});
