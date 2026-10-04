import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const endpoints = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  cloudflare: "https://api.cloudflare.com/client/v4/accounts/x/ai/run/@cf/cloudflare/clef",
} as const;

describe("costUSD", () => {
  it.each([
    ["typesafe", "jev-latest", 1_000_000, 0.042],
    ["typesafe", "jev-1.13.0", 500_000, 0.021],
    ["cloudflare", "clef", 1_000_000, 0.24],
    ["cloudflare", "clef-flash", 1_000_000, 0.09],
  ] as const)("prices %s %s", (provider, model, inputTokens, expected) => {
    expect(costUSD({ provider, endpoint: endpoints[provider], model, inputTokens })).toBeCloseTo(
      expected,
      10,
    );
  });

  it("leaves an unknown model or a missing token count unpriced", () => {
    const endpoint = endpoints.cloudflare;
    expect(
      costUSD({ provider: "cloudflare", endpoint, model: "clef-next", inputTokens: 10 }),
    ).toBeNull();
    expect(
      costUSD({ provider: "cloudflare", endpoint, model: "constructor", inputTokens: 10 }),
    ).toBeNull();
    expect(
      costUSD({
        provider: "typesafe",
        endpoint: endpoints.typesafe,
        model: "jev-latest",
        inputTokens: null,
      }),
    ).toBeNull();
  });

  it("does not price a self-hosted System One endpoint", () => {
    expect(
      costUSD({
        provider: "typesafe",
        endpoint: "http://localhost:8787/v1/systemone",
        model: "jev-latest",
        inputTokens: 1_000,
      }),
    ).toBeNull();
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
  let directory: string;

  beforeEach(async () => {
    directory = join("tmp", "tests", "home", randomUUID());
    await mkdir(directory, { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("appends one JSON line per record, creating a private file", async () => {
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

  it("drops a record it cannot write, then recovers once the directory can be made", async () => {
    // A file where the log directory should be makes mkdir fail.
    const blocker = join(directory, "data");
    await writeFile(blocker, "");
    const path = join(blocker, "usage.jsonl");
    const recordUsage = fileUsageRecorder({ path });

    expect(() => recordUsage(record)).not.toThrow();
    await rm(blocker);

    recordUsage({ ...record, verdict: "allow" });
    await vi.waitFor(async () => {
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      // The first record may or may not have raced the removal; the second lands.
      expect(lines.map((line) => JSON.parse(line).verdict).at(-1)).toBe("allow");
    });
  });
});
