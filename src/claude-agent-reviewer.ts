import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { agentReviewPrompt } from "./agent-reviewer.js";
import type { PluginConfiguration } from "./config.js";
import {
  parseVerdict,
  recordedReview,
  type Reviewer,
  type ReviewRequest,
  type ReviewVerdict,
} from "./reviewer.js";
import { importSdk } from "./sdk-loader.js";
import type { UsageRecorder } from "./usage.js";

const sdkPackage = "@anthropic-ai/claude-agent-sdk";

/** The subset of the SDK's `query` the reviewer calls. */
export type ClaudeAgentQuery = (input: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/** Claude Code's read-only tools; no other built-in tool is offered. */
const claudeReviewerTools = ["Read", "Glob", "Grep"] as const;

const claudeReviewerSystemPrompt =
  "You are a security reviewer. You may inspect the workspace only through Read, Glob, and Grep. Never modify files, run shell commands, access the network, use MCP tools, or delegate work.";

/**
 * The agent reviewer on Claude Code through the Claude Agent SDK. The session
 * is isolated from every setting on disk — no CLAUDE.md, hooks, MCP servers,
 * plugins or permission rules from the user or the project — offers only the
 * read-only tools, and runs in auto mode: nobody is there to answer a prompt.
 */
export class ClaudeAgentReviewer implements Reviewer {
  readonly #configuration: PluginConfiguration;
  readonly #directory: string;
  readonly #model: string | undefined;
  readonly #sdkPath: string | undefined;
  readonly #loadQuery: (input: { sdkPath?: string }) => Promise<ClaudeAgentQuery>;
  readonly #recordUsage: UsageRecorder | undefined;
  readonly #project: string;
  #query: Promise<ClaudeAgentQuery> | undefined;

  constructor(input: {
    configuration: PluginConfiguration;
    directory: string;
    loadQuery?: (input: { sdkPath?: string }) => Promise<ClaudeAgentQuery>;
    recordUsage?: UsageRecorder;
    project?: string;
  }) {
    const agent = input.configuration.reviewer.agent;
    if (agent.runtime !== "claude-agent-sdk") {
      throw new Error("The Claude Agent SDK runtime is not configured.");
    }
    this.#configuration = input.configuration;
    this.#directory = input.directory;
    this.#model = agent.model;
    this.#sdkPath = agent.sdkPath;
    this.#loadQuery = input.loadQuery ?? loadClaudeAgentQuery;
    this.#recordUsage = input.recordUsage;
    this.#project = input.project ?? "";
  }

  isReviewerSession(): boolean {
    // Reviews run in Claude Code, never in an OpenCode session.
    return false;
  }

  review(input: ReviewRequest): Promise<ReviewVerdict> {
    const usage: Usage = { inputTokens: null, outputTokens: null, costUSD: null };
    return recordedReview({
      recordUsage: this.#recordUsage,
      review: () => this.#review({ request: input, usage }),
      usage: () => ({
        provider: "claude-agent-sdk",
        model: this.#model ?? "default",
        project: this.#project,
        ...usage,
      }),
    });
  }

  async #review(input: { request: ReviewRequest; usage: Usage }): Promise<ReviewVerdict> {
    const { text, check } = agentReviewPrompt({
      request: input.request,
      configuration: this.#configuration,
    });
    const query = await this.#queryFunction();
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      this.#configuration.reviewer.timeoutMs,
    );
    try {
      const messages = query({
        prompt: text,
        options: {
          abortController,
          cwd: this.#directory,
          ...(this.#model === undefined ? {} : { model: this.#model }),
          systemPrompt: claudeReviewerSystemPrompt,
          tools: [...claudeReviewerTools],
          // Auto mode: Claude Code's classifier approves or denies each call
          // it would otherwise ask about, such as a read outside `cwd`, and
          // `canUseTool` denies whatever it cannot decide.
          permissionMode: "auto",
          canUseTool: async () => ({
            behavior: "deny",
            message: "The auto-approval reviewer may only read the workspace.",
          }),
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          plugins: [],
          persistSession: false,
          env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "opencode-auto-approval-plugin" },
        },
      });
      for await (const message of messages) {
        if (abortController.signal.aborted) break;
        if (message.type !== "result") continue;
        input.usage.inputTokens =
          message.usage.input_tokens +
          message.usage.cache_creation_input_tokens +
          message.usage.cache_read_input_tokens;
        input.usage.outputTokens = message.usage.output_tokens;
        input.usage.costUSD = message.total_cost_usd;
        if (message.subtype !== "success" || message.is_error) {
          throw new Error(`Claude Agent SDK review failed (${message.subtype}).`);
        }
        return parseVerdict(message.result, check);
      }
      if (abortController.signal.aborted) throw new Error("Reviewer timed out.");
      throw new Error("Claude Agent SDK review ended without a result.");
    } catch (error) {
      // The SDK rejects with its own abort error once the process is killed.
      if (abortController.signal.aborted) throw new Error("Reviewer timed out.", { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
      abortController.abort();
    }
  }

  /** Loaded once; a failed load is retried on the next review. */
  #queryFunction(): Promise<ClaudeAgentQuery> {
    this.#query ??= this.#loadQuery(
      this.#sdkPath === undefined ? {} : { sdkPath: this.#sdkPath },
    ).catch((error: unknown) => {
      this.#query = undefined;
      throw error;
    });
    return this.#query;
  }
}

type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Claude Code's own estimate for the whole review. */
  costUSD: number | null;
};

/** Imports the SDK's `query`; see `importSdk`. */
export async function loadClaudeAgentQuery(input: { sdkPath?: string }): Promise<ClaudeAgentQuery> {
  const module = await importSdk({
    packageName: sdkPackage,
    option: "reviewer.agent.claudeAgentSdk.path",
    ...input,
    importInstalled: () => import("@anthropic-ai/claude-agent-sdk"),
  });
  if (typeof module.query !== "function") {
    throw new Error(`The loaded ${sdkPackage} has no query function.`);
  }
  return module.query as ClaudeAgentQuery;
}
