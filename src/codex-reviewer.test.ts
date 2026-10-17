import { join } from "node:path";

import type { CodexOptions, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

import { CodexReviewer, type CreateCodex, loadCodex } from "./codex-reviewer.js";
import { parsePluginConfiguration } from "./config.js";
import { OversizeError, type ReviewRequest } from "./reviewer.js";
import type { UsageRecord } from "./usage.js";

const request: ReviewRequest = {
  source: "permission-request",
  sessionID: "main-session",
  action: "bash",
  resource: { command: "pnpm test" },
  userIntent: "run the tests",
};

function configuration(agent: Record<string, unknown> = {}, timeoutMs?: number) {
  return parsePluginConfiguration({
    options: {
      reviewer: {
        agent: { runtime: "codex-sdk", ...agent },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    },
    env: {},
  });
}

type Calls = {
  codex: CodexOptions[];
  threads: ThreadOptions[];
  runs: { input: string; options: TurnOptions }[];
};

/** A Codex that answers with the prompt's review check echoed, as a model that read it all would. */
function fakeCodex(
  input: { verdict?: string; run?: (options: TurnOptions) => Promise<never> } = {},
): CreateCodex & Calls {
  const calls: Calls = { codex: [], threads: [], runs: [] };
  const create: CreateCodex = (options) => {
    calls.codex.push(options);
    return {
      startThread: (threadOptions) => {
        calls.threads.push(threadOptions);
        return {
          run: async (text, runOptions) => {
            calls.runs.push({ input: text, options: runOptions });
            if (input.run) return input.run(runOptions);
            const check = /Review check: "([\da-f-]+)"/.exec(text)?.[1];
            return {
              finalResponse: `{"verdict":"${input.verdict ?? "allow"}","reason":"tests only","check":"${check}"}`,
              usage: {
                input_tokens: 900,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 60,
                reasoning_output_tokens: 20,
              },
            };
          },
        };
      },
    };
  };
  return Object.assign(create, calls);
}

describe("CodexReviewer", () => {
  it("reviews in a read-only Codex thread in auto mode", async () => {
    const codex = fakeCodex();
    const records: UsageRecord[] = [];
    const reviewer = new CodexReviewer({
      configuration: configuration({ model: "gpt-5.6-codex" }),
      directory: "/work/project",
      loadCodex: async () => codex,
      recordUsage: (record) => records.push(record),
      project: "project-id",
    });

    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "allow",
      reason: "tests only",
    });

    expect(codex.codex).toEqual([
      {
        config: expect.objectContaining({
          approvals_reviewer: "auto_review",
          project_doc_max_bytes: 0,
        }),
      },
    ]);
    expect(codex.threads).toEqual([
      {
        model: "gpt-5.6-codex",
        workingDirectory: "/work/project",
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "on-request",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      },
    ]);
    expect(codex.runs[0]?.input).toContain('"command":"pnpm test"');
    expect(reviewer.isReviewerSession()).toBe(false);
    expect(records).toEqual([
      expect.objectContaining({
        provider: "codex-sdk",
        model: "gpt-5.6-codex",
        project: "project-id",
        inputTokens: 900,
        outputTokens: 60,
        verdict: "allow",
        costUSD: null,
      }),
    ]);
  });

  it("leaves the model to Codex when none is configured", async () => {
    const codex = fakeCodex({ verdict: "deny" });
    const reviewer = new CodexReviewer({
      configuration: configuration(),
      directory: "/work/project",
      loadCodex: async () => codex,
    });

    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "deny" });
    expect(codex.threads[0]).not.toHaveProperty("model");
  });

  it("fails a turn that Codex failed", async () => {
    const records: UsageRecord[] = [];
    const reviewer = new CodexReviewer({
      configuration: configuration(),
      directory: "/work/project",
      loadCodex: async () =>
        fakeCodex({ run: async () => Promise.reject(new Error("turn failed")) }),
      recordUsage: (record) => records.push(record),
    });

    await expect(reviewer.review(request)).rejects.toThrow("turn failed");
    expect(records).toEqual([expect.objectContaining({ verdict: "error", model: "default" })]);
  });

  it("aborts the turn when the review times out", async () => {
    let signal: AbortSignal | undefined;
    const reviewer = new CodexReviewer({
      configuration: configuration({}, 20),
      directory: "/work/project",
      loadCodex: async () =>
        fakeCodex({
          run: (options) => {
            signal = options.signal;
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
          },
        }),
    });

    await expect(reviewer.review(request)).rejects.toThrow("Reviewer timed out.");
    expect(signal?.aborted).toBe(true);
  });

  it("escalates an operation too large for the agent reviewer unsent", async () => {
    const codex = fakeCodex();
    const reviewer = new CodexReviewer({
      configuration: configuration({ maxInputBytes: 1_000 }),
      directory: "/work/project",
      loadCodex: async () => codex,
    });

    await expect(
      reviewer.review({ ...request, resource: { command: "x".repeat(2_000) } }),
    ).rejects.toBeInstanceOf(OversizeError);
    expect(codex.runs).toHaveLength(0);
  });

  it("loads the SDK from the configured directory once", async () => {
    const codex = fakeCodex();
    const loads: { sdkPath?: string }[] = [];
    const reviewer = new CodexReviewer({
      configuration: configuration({ codexSdk: { path: "/opt/codex-sdk" } }),
      directory: "/work/project",
      loadCodex: async (input) => {
        loads.push(input);
        return codex;
      },
    });

    await reviewer.review(request);
    await reviewer.review(request);
    expect(loads).toEqual([{ sdkPath: "/opt/codex-sdk" }]);
  });

  it("refuses a configuration for another runtime", () => {
    expect(
      () =>
        new CodexReviewer({
          configuration: parsePluginConfiguration({ options: {}, env: {} }),
          directory: "/work/project",
        }),
    ).toThrow("The Codex SDK runtime is not configured.");
  });
});

describe("loadCodex", () => {
  it("imports the SDK installed next to the plugin", async () => {
    await expect(loadCodex({})).resolves.toBeTypeOf("function");
  });

  it("imports the SDK from a configured package directory", async () => {
    await expect(
      loadCodex({ sdkPath: join(process.cwd(), "node_modules", "@openai", "codex-sdk") }),
    ).resolves.toBeTypeOf("function");
  });

  it("names the option in the error for a wrong directory", async () => {
    await expect(
      loadCodex({ sdkPath: join(process.cwd(), "node_modules", "zod") }),
    ).rejects.toThrow("Could not load @openai/codex-sdk from reviewer.agent.codexSdk.path.");
  });
});
