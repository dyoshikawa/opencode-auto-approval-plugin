import { join } from "node:path";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  type ClaudeAgentQuery,
  ClaudeAgentReviewer,
  loadClaudeAgentQuery,
} from "./claude-agent-reviewer.js";
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
        agent: { runtime: "claude-agent-sdk", ...agent },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    },
    env: {},
  });
}

/** A Claude Code result message; only the fields the reviewer reads are meaningful. */
function result(input: { text?: string; subtype?: string; isError?: boolean }): SDKMessage {
  return {
    type: "result",
    subtype: input.subtype ?? "success",
    is_error: input.isError ?? false,
    result: input.text ?? "",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 3,
      output_tokens: 40,
    },
  } as unknown as SDKMessage;
}

/** A query that answers with the prompt's review check echoed, as a model that read it all would. */
function fakeQuery(input: { verdict?: string; messages?: SDKMessage[] } = {}): ClaudeAgentQuery & {
  calls: { prompt: string; options: Options }[];
} {
  const calls: { prompt: string; options: Options }[] = [];
  const query = ({ prompt, options }: { prompt: string; options: Options }) => {
    calls.push({ prompt, options });
    const check = /Review check: "([\da-f-]+)"/.exec(prompt)?.[1];
    const messages = input.messages ?? [
      { type: "system" } as unknown as SDKMessage,
      result({
        text: `{"verdict":"${input.verdict ?? "allow"}","reason":"tests only","check":"${check}"}`,
      }),
    ];
    return (async function* () {
      yield* messages;
    })();
  };
  return Object.assign(query, { calls });
}

describe("ClaudeAgentReviewer", () => {
  it("reviews in an isolated, read-only Claude Code session", async () => {
    const query = fakeQuery();
    const records: UsageRecord[] = [];
    const reviewer = new ClaudeAgentReviewer({
      configuration: configuration({ model: "claude-sonnet-5-5" }),
      directory: "/work/project",
      loadQuery: async () => query,
      recordUsage: (record) => records.push(record),
      project: "project-id",
    });

    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "allow",
      reason: "tests only",
    });

    expect(query.calls).toHaveLength(1);
    const [call] = query.calls;
    expect(call?.prompt).toContain('"command":"pnpm test"');
    expect(call?.options).toMatchObject({
      cwd: "/work/project",
      model: "claude-sonnet-5-5",
      tools: ["Read", "Glob", "Grep"],
      permissionMode: "auto",
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      plugins: [],
      persistSession: false,
    });
    expect(call?.options.allowedTools).toBeUndefined();
    await expect(
      call?.options.canUseTool?.("Bash", {}, { signal: new AbortController().signal } as never),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(reviewer.isReviewerSession()).toBe(false);
    expect(records).toEqual([
      expect.objectContaining({
        provider: "claude-agent-sdk",
        model: "claude-sonnet-5-5",
        project: "project-id",
        inputTokens: 123,
        outputTokens: 40,
        verdict: "allow",
        costUSD: 0.0123,
      }),
    ]);
  });

  it("leaves the model to Claude Code when none is configured", async () => {
    const query = fakeQuery({ verdict: "escalate" });
    const reviewer = new ClaudeAgentReviewer({
      configuration: configuration(),
      directory: "/work/project",
      loadQuery: async () => query,
    });

    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "escalate" });
    expect(query.calls[0]?.options).not.toHaveProperty("model");
  });

  it("fails a review that Claude Code ended with an error", async () => {
    const records: UsageRecord[] = [];
    const reviewer = new ClaudeAgentReviewer({
      configuration: configuration(),
      directory: "/work/project",
      loadQuery: async () =>
        fakeQuery({ messages: [result({ subtype: "error_during_execution", isError: true })] }),
      recordUsage: (record) => records.push(record),
    });

    await expect(reviewer.review(request)).rejects.toThrow(
      "Claude Agent SDK review failed (error_during_execution).",
    );
    expect(records).toEqual([expect.objectContaining({ verdict: "error", model: "default" })]);
  });

  it("fails a success result that reports an error", async () => {
    const reviewer = new ClaudeAgentReviewer({
      configuration: configuration(),
      directory: "/work/project",
      loadQuery: async () =>
        fakeQuery({ messages: [result({ text: "API Error: overloaded", isError: true })] }),
    });

    await expect(reviewer.review(request)).rejects.toThrow("Claude Agent SDK review failed");
  });

  it("fails a session that ended without a result", async () => {
    const reviewer = new ClaudeAgentReviewer({
      configuration: configuration(),
      directory: "/work/project",
      loadQuery: async () => fakeQuery({ messages: [] }),
    });

    await expect(reviewer.review(request)).rejects.toThrow("ended without a result");
  });

  it("aborts the session when the review times out", async () => {
    let signal: AbortSignal | undefined;
    const query: ClaudeAgentQuery = ({ options }) => {
      signal = options.abortController?.signal;
      // Like the SDK, the stream only ends by rejecting once it is aborted.
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<SDKMessage>>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("aborted by user")));
            }),
        }),
      };
    };
    const reviewer = new ClaudeAgentReviewer({
      configuration: configuration({}, 20),
      directory: "/work/project",
      loadQuery: async () => query,
    });

    await expect(reviewer.review(request)).rejects.toThrow("Reviewer timed out.");
    expect(signal?.aborted).toBe(true);
  });

  it("escalates an operation too large for the agent reviewer unsent", async () => {
    const query = fakeQuery();
    const reviewer = new ClaudeAgentReviewer({
      configuration: configuration({ maxInputBytes: 1_000 }),
      directory: "/work/project",
      loadQuery: async () => query,
    });

    await expect(
      reviewer.review({ ...request, resource: { command: "x".repeat(2_000) } }),
    ).rejects.toBeInstanceOf(OversizeError);
    expect(query.calls).toHaveLength(0);
  });

  it("loads the SDK once and retries a failed load", async () => {
    const query = fakeQuery();
    const loads: { sdkPath?: string }[] = [];
    const reviewer = new ClaudeAgentReviewer({
      configuration: configuration({ claudeAgentSdk: { path: "/opt/sdk" } }),
      directory: "/work/project",
      loadQuery: async (input) => {
        loads.push(input);
        if (loads.length === 1) throw new Error("not installed");
        return query;
      },
    });

    await expect(reviewer.review(request)).rejects.toThrow("not installed");
    await reviewer.review(request);
    await reviewer.review(request);
    expect(loads).toEqual([{ sdkPath: "/opt/sdk" }, { sdkPath: "/opt/sdk" }]);
  });

  it("refuses a configuration for another runtime", () => {
    expect(
      () =>
        new ClaudeAgentReviewer({
          configuration: parsePluginConfiguration({ options: {}, env: {} }),
          directory: "/work/project",
        }),
    ).toThrow("The Claude Agent SDK runtime is not configured.");
  });
});

describe("loadClaudeAgentQuery", () => {
  const installed = join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk");

  it("imports the SDK installed next to the plugin", async () => {
    await expect(loadClaudeAgentQuery({})).resolves.toBeTypeOf("function");
  });

  it("imports the SDK from a configured package directory", async () => {
    await expect(loadClaudeAgentQuery({ sdkPath: installed })).resolves.toBeTypeOf("function");
  });

  it("refuses a directory that holds another package", async () => {
    await expect(
      loadClaudeAgentQuery({ sdkPath: join(process.cwd(), "node_modules", "zod") }),
    ).rejects.toThrow("Could not load @anthropic-ai/claude-agent-sdk from reviewer.agent");
  });
});
