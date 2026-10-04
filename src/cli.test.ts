import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "./cli.js";
import { projectID, type UsageRecord } from "./usage.js";

const now = new Date(2026, 9, 4, 12, 0, 0);

function line(input: Partial<UsageRecord>): string {
  return JSON.stringify({
    v: 1,
    time: now.toISOString(),
    provider: "cloudflare",
    model: "clef",
    project: projectID({ directory: "/work/a" }),
    inputTokens: 200,
    outputTokens: 0,
    latencyMs: 400,
    verdict: "allow",
    costUSD: 0.000048,
    ...input,
  });
}

describe("stats command", () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stats-"));
    file = join(directory, "usage.jsonl");
    await writeFile(
      file,
      [
        line({}),
        line({ project: projectID({ directory: "/work/b" }), verdict: "deny" }),
        line({ time: new Date(2025, 0, 1).toISOString() }),
        "not json",
        JSON.stringify({ v: 2 }),
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function run(argv: string[]): Promise<{ code: number; output: string }> {
    let output = "";
    const code = await main({ argv, now, write: (text) => (output += text) });
    return { code, output };
  }

  it("defaults to the current year and skips malformed lines", async () => {
    const { code, output } = await run(["stats", "--file", file]);

    expect(code).toBe(0);
    expect(output).toContain("2026 so far · all projects");
    expect(output).toContain("reviews 2 ");
  });

  it("filters by project and prints JSON", async () => {
    const { output } = await run([
      "stats",
      "--file",
      file,
      "--all",
      "--project",
      "/work/a",
      "--json",
    ]);

    expect(JSON.parse(output)).toMatchObject({ range: "all time", reviews: 2 });
  });

  it("treats a missing log as no reviews", async () => {
    const { code, output } = await run(["stats", "--file", join(directory, "none.jsonl")]);

    expect(code).toBe(0);
    expect(output).toContain("no decision model reviews in this range");
  });

  it.each([
    [["stats", "--days", "-1"]],
    [["stats", "--days", "1", "--all"]],
    [["stats", "--bogus"]],
    [["report"]],
  ])("rejects %j with the usage", async (argv) => {
    const { code, output } = await run(argv);

    expect(code).toBe(2);
    expect(output).toContain("Usage: opencode-auto-approval-plugin stats");
  });
});
