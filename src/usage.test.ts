import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { costUSD, fileUsageRecorder, projectID, type UsageRecord, usageLogPath } from "./usage.js";

const record: UsageRecord = {
  v: 1,
  time: "2026-10-04T10:00:00.000Z",
  provider: "cloudflare",
  model: "clef",
  project: "abc",
  inputTokens: 219,
  outputTokens: 0,
  latencyMs: 383,
  verdict: "deny",
  costUSD: 0.00005256,
};

describe("costUSD", () => {
  it.each([
    ["typesafe", "jev-latest", 1_000_000, 0.042],
    ["typesafe", "jev-1.13.0", 500_000, 0.021],
    ["cloudflare", "clef", 1_000_000, 0.24],
    ["cloudflare", "clef-flash", 1_000_000, 0.09],
  ] as const)("prices %s %s", (provider, model, inputTokens, expected) => {
    expect(costUSD({ provider, model, inputTokens })).toBeCloseTo(expected, 10);
  });

  it("leaves an unknown model or a missing token count unpriced", () => {
    expect(costUSD({ provider: "cloudflare", model: "clef-next", inputTokens: 10 })).toBeNull();
    expect(costUSD({ provider: "cloudflare", model: "constructor", inputTokens: 10 })).toBeNull();
    expect(costUSD({ provider: "typesafe", model: "jev-latest", inputTokens: null })).toBeNull();
  });
});

describe("usageLogPath", () => {
  it("lives under XDG_DATA_HOME", () => {
    expect(usageLogPath({ env: { XDG_DATA_HOME: "/data" } })).toBe(
      "/data/opencode-auto-approval-plugin/usage.jsonl",
    );
  });

  it("falls back to ~/.local/share", () => {
    expect(usageLogPath({ env: {} })).toMatch(
      /\/\.local\/share\/opencode-auto-approval-plugin\/usage\.jsonl$/,
    );
  });
});

describe("projectID", () => {
  it("hashes the resolved directory, so the path itself is not stored", () => {
    const id = projectID({ directory: "/workspace/app" });
    expect(id).toMatch(/^[\da-f]{16}$/);
    expect(projectID({ directory: "/workspace/app/" })).toBe(id);
    expect(projectID({ directory: "/workspace/other" })).not.toBe(id);
  });
});

describe("fileUsageRecorder", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("appends one JSON line per record, creating a private file", async () => {
    directory = await mkdtemp(join(tmpdir(), "usage-"));
    const path = join(directory, "nested", "usage.jsonl");
    const recordUsage = fileUsageRecorder({ path });

    recordUsage(record);
    recordUsage({ ...record, verdict: "allow" });

    await vi.waitFor(async () => {
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(lines.map((line) => JSON.parse(line).verdict)).toEqual(["deny", "allow"]);
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("drops a record it cannot write instead of throwing", async () => {
    directory = await mkdtemp(join(tmpdir(), "usage-"));
    // The parent is a file, so the directory cannot be created.
    const recordUsage = fileUsageRecorder({ path: join(directory, "usage.jsonl", "x", "y") });
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(join(directory ?? "", "usage.jsonl"), ""),
    );

    expect(() => recordUsage(record)).not.toThrow();
  });
});
