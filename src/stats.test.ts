import { describe, expect, it } from "vitest";

import { formatStats, inRange, summarize } from "./stats.js";
import type { UsageRecord } from "./usage.js";

const now = new Date(2026, 9, 4, 12, 0, 0);

function record(input: Partial<Omit<UsageRecord, "time">> & { time: Date }): UsageRecord {
  return {
    v: 1,
    provider: "typesafe",
    model: "jev-latest",
    project: "p",
    inputTokens: 500,
    outputTokens: 40,
    latencyMs: 200,
    verdict: "allow",
    costUSD: 0.000021,
    ...input,
    time: input.time.toISOString(),
  };
}

describe("inRange", () => {
  it("counts days back from the start of today, 0 meaning today", () => {
    const yesterday = record({ time: new Date(2026, 9, 3, 23, 0) });
    expect(inRange({ record: yesterday, range: { kind: "days", days: 0 }, now })).toBe(false);
    expect(inRange({ record: yesterday, range: { kind: "days", days: 1 }, now })).toBe(true);
  });

  it("selects a calendar year or everything", () => {
    const lastYear = record({ time: new Date(2025, 11, 31) });
    expect(inRange({ record: lastYear, range: { kind: "year", year: 2026 }, now })).toBe(false);
    expect(inRange({ record: lastYear, range: { kind: "all" }, now })).toBe(true);
  });
});

describe("summarize", () => {
  const records = [
    record({ time: now, latencyMs: 100 }),
    record({ time: now, latencyMs: 300, verdict: "escalate" }),
    record({ time: now, latencyMs: 200 }),
    record({
      time: now,
      provider: "cloudflare",
      model: "clef",
      inputTokens: 1_000_000,
      outputTokens: 0,
      costUSD: 0.24,
      verdict: "deny",
    }),
    record({
      time: now,
      provider: "cloudflare",
      model: "clef",
      inputTokens: null,
      outputTokens: null,
      costUSD: null,
      verdict: "error",
    }),
  ];

  it("totals tokens, cost and verdicts, per model with the median latency", () => {
    const stats = summarize({ records, range: { kind: "days", days: 7 }, now });

    expect(stats).toMatchObject({
      range: "last 7 days",
      reviews: 5,
      inputTokens: 1_001_500,
      outputTokens: 120,
      unpriced: 1,
      verdicts: { allow: 2, escalate: 1, deny: 1, error: 1 },
    });
    expect(stats.costUSD).toBeCloseTo(0.240063, 6);
    expect(
      stats.models.map((model) => [model.model, model.reviews, model.medianLatencyMs]),
    ).toEqual([
      ["jev-latest", 3, 200],
      // The median of two latencies is their mean.
      ["clef", 2, 200],
    ]);
  });

  it("renders a table like opencode stats", () => {
    const text = formatStats({
      stats: summarize({ records, range: { kind: "year", year: 2026 }, now }),
    });

    expect(text).toContain("auto-approval stats · 2026 so far · all projects");
    expect(text).toContain("reviews 5   tokens 1.0M in / 120 out   cost $0.24");
    expect(text).toMatch(/typesafe\s+jev-latest\s+3\s+1,500\s+120\s+\$0\.00006\s+200 ms/);
    expect(text).toContain("verdicts  allow 40% · escalate 20% · deny 20% · error 20%");
    expect(text).toContain("1 review(s) without a price");
  });

  it("says so when nothing was reviewed", () => {
    expect(
      formatStats({
        stats: summarize({ records: [], range: { kind: "days", days: 0 }, now }),
        project: "p",
      }),
    ).toBe(
      "auto-approval stats · today · this project\n\nno decision model reviews in this range\n",
    );
  });

  it("never prints control characters from a model name", () => {
    const text = formatStats({
      stats: summarize({
        records: [record({ time: now, model: "jev\u001b]0;pwned\u0007" })],
        range: { kind: "all" },
        now,
      }),
    });

    expect(text.includes("\u001b") || text.includes("\u0007")).toBe(false);
    expect(text).toContain("jev?]0;pwned?");
  });

  it("handles a large log in linear time", () => {
    const many = Array.from({ length: 200_000 }, (_, index) =>
      record({ time: now, latencyMs: index }),
    );
    const started = performance.now();

    expect(summarize({ records: many, range: { kind: "all" }, now }).reviews).toBe(200_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
