import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CodexOptions, RunResult, ThreadOptions, TurnOptions } from "@openai/codex-sdk";

import { agentReviewPrompt } from "./agent-reviewer.js";
import type { PluginConfiguration } from "./config.js";
import {
  OversizeError,
  parseVerdict,
  type Reviewer,
  type ReviewRequest,
  type ReviewVerdict,
} from "./reviewer.js";
import { importSdk } from "./sdk-loader.js";
import type { UsageRecorder } from "./usage.js";

const sdkPackage = "@openai/codex-sdk";

/** The subset of the SDK's `Codex` class the reviewer uses. */
type CodexClient = {
  startThread(options: ThreadOptions): {
    run(input: string, options: TurnOptions): Promise<Pick<RunResult, "finalResponse" | "usage">>;
  };
};

export type CreateCodex = (options: CodexOptions) => CodexClient;

const codexReviewerInstructions =
  "You are a security reviewer. You may inspect the workspace only by reading files and searching them. Never modify files, access the network, use MCP tools, or delegate work.";

/**
 * The agent reviewer on Codex through the Codex SDK. Codex inspects the
 * workspace through shell commands, so the session runs in the read-only
 * sandbox without network access, ignores the project's AGENTS.md and
 * `.codex/config.toml`, and never asks for approval: nobody is there to answer, and an approved request could
 * run a command outside the read-only sandbox. A command the sandbox blocks
 * simply fails.
 */
export class CodexReviewer implements Reviewer {
  readonly #configuration: PluginConfiguration;
  readonly #directory: string;
  readonly #model: string | undefined;
  readonly #sdkPath: string | undefined;
  readonly #loadCodex: (input: { sdkPath?: string }) => Promise<CreateCodex>;
  readonly #recordUsage: UsageRecorder | undefined;
  readonly #project: string;
  #codex: Promise<CreateCodex> | undefined;

  constructor(input: {
    configuration: PluginConfiguration;
    directory: string;
    loadCodex?: (input: { sdkPath?: string }) => Promise<CreateCodex>;
    recordUsage?: UsageRecorder;
    project?: string;
  }) {
    const agent = input.configuration.reviewer.agent;
    if (agent.runtime !== "codex-sdk") {
      throw new Error("The Codex SDK runtime is not configured.");
    }
    this.#configuration = input.configuration;
    this.#directory = input.directory;
    this.#model = agent.model;
    this.#sdkPath = agent.sdkPath;
    this.#loadCodex = input.loadCodex ?? loadCodex;
    this.#recordUsage = input.recordUsage;
    this.#project = input.project ?? "";
  }

  isReviewerSession(): boolean {
    // Reviews run in Codex, never in an OpenCode session.
    return false;
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    const startedAt = Date.now();
    const usage: Usage = { inputTokens: null, outputTokens: null };
    try {
      const decision = await this.#review({ request: input, usage });
      this.#record({ startedAt, usage, verdict: decision.verdict });
      return decision;
    } catch (error) {
      this.#record({
        startedAt,
        usage,
        verdict: error instanceof OversizeError ? "oversize" : "error",
      });
      throw error;
    }
  }

  async #review(input: { request: ReviewRequest; usage: Usage }): Promise<ReviewVerdict> {
    const { text, check } = agentReviewPrompt({
      request: input.request,
      configuration: this.#configuration,
    });
    const createCodex = await this.#createCodex();
    const codex = createCodex({
      config: {
        developer_instructions: codexReviewerInstructions,
        // The project's AGENTS.md is repository content, not the user's policy.
        project_doc_max_bytes: 0,
      },
      // So is its `.codex/config.toml`, which could add MCP servers that run
      // outside the read-only sandbox. See `untrustedProjectsOverride`.
      configOverrides: [untrustedProjectsOverride(this.#directory)],
    });
    const thread = codex.startThread({
      ...(this.#model === undefined ? {} : { model: this.#model }),
      workingDirectory: this.#directory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      // "never": no request may lift the read-only sandbox, not even one an
      // automatic reviewer would approve.
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      this.#configuration.reviewer.timeoutMs,
    );
    try {
      const turn = await thread.run(text, { signal: abortController.signal });
      input.usage.inputTokens = turn.usage?.input_tokens ?? null;
      input.usage.outputTokens = turn.usage?.output_tokens ?? null;
      return parseVerdict(turn.finalResponse, check);
    } catch (error) {
      if (abortController.signal.aborted) throw new Error("Reviewer timed out.", { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
      abortController.abort();
    }
  }

  /** Loaded once; a failed load is retried on the next review. */
  #createCodex(): Promise<CreateCodex> {
    this.#codex ??= this.#loadCodex(
      this.#sdkPath === undefined ? {} : { sdkPath: this.#sdkPath },
    ).catch((error: unknown) => {
      this.#codex = undefined;
      throw error;
    });
    return this.#codex;
  }

  #record(input: {
    startedAt: number;
    usage: Usage;
    verdict: ReviewVerdict["verdict"] | "error" | "oversize";
  }): void {
    if (this.#recordUsage === undefined) return;
    try {
      this.#recordUsage({
        v: 1,
        time: new Date(input.startedAt).toISOString(),
        provider: "codex-sdk",
        model: this.#model ?? "default",
        project: this.#project,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        latencyMs: Math.max(0, Date.now() - input.startedAt),
        verdict: input.verdict,
        // Codex reports no price, and a ChatGPT sign-in has none per call.
        costUSD: null,
      });
    } catch {
      // The usage log must never decide a review.
    }
  }
}

/**
 * A raw `--config` override that marks the reviewed directory and every
 * directory above it as untrusted, so Codex loads no project config layer
 * (`.codex/config.toml`) for the review even when the user trusted the project
 * in Codex. Codex takes a directory's trust from its own `projects` entry
 * before the entry of its repository root (the main checkout for a worktree),
 * so every directory whose `.codex/config.toml` it may load gets an entry. The
 * symlink-resolved path is covered too in case Codex resolves the working
 * directory. The SDK's structured `config` would join a path into a dotted key
 * unquoted, which breaks on a `.` in the path, so the table is written inline
 * with every key quoted.
 */
function untrustedProjectsOverride(directory: string): string {
  const directories = new Set<string>();
  const add = (start: string) => {
    for (let current = start; ; current = dirname(current)) {
      directories.add(current);
      if (dirname(current) === current) break;
    }
  };
  const absolute = resolve(directory);
  add(absolute);
  try {
    add(realpathSync(absolute));
  } catch {
    // A directory that cannot be resolved has no other path to cover.
  }
  const entries = [...directories].map(
    (path) => `${JSON.stringify(path)} = { trust_level = "untrusted" }`,
  );
  return `projects={ ${entries.join(", ")} }`;
}

type Usage = { inputTokens: number | null; outputTokens: number | null };

/** Imports the SDK's `Codex` class; see `importSdk`. */
export async function loadCodex(input: { sdkPath?: string }): Promise<CreateCodex> {
  const module = await importSdk({
    packageName: sdkPackage,
    option: "reviewer.agent.codexSdk.path",
    ...input,
    importInstalled: () => import("@openai/codex-sdk"),
  });
  const Codex = module.Codex;
  if (typeof Codex !== "function") {
    throw new Error(`The loaded ${sdkPackage} has no Codex class.`);
  }
  return (options) => new (Codex as new (options: CodexOptions) => CodexClient)(options);
}
