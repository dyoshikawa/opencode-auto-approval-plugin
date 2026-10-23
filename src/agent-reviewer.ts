import type { PluginConfiguration } from "./config.js";
import {
  OversizeError,
  parseVerdict,
  type Reviewer,
  type ReviewRequest,
  type ReviewSessionClient,
  type ReviewVerdict,
  reviewCheck,
  reviewerPrompt,
} from "./reviewer.js";

export const reviewerAgentName = "auto-approval-reviewer";

export const reviewerAgentDescription = "Read-only reviewer for auto-approval decisions.";

export const reviewerAgentPrompt =
  "You are a security reviewer. You may inspect the workspace only through read, glob, grep, and lsp. Never modify files, run shell commands, access the network, use MCP tools, or delegate work.";

/** The only tools the reviewer may call; everything else is denied. */
export const reviewerAllowedTools = ["read", "glob", "grep", "lsp"] as const;

export class AgentReviewer implements Reviewer {
  readonly #client: ReviewSessionClient;
  readonly #configuration: PluginConfiguration;
  readonly #reviewerSessionIDs = new Set<string>();

  constructor(input: { client: ReviewSessionClient; configuration: PluginConfiguration }) {
    this.#client = input.client;
    this.#configuration = input.configuration;
  }

  isReviewerSession(input: { sessionID: string }): boolean {
    return this.#reviewerSessionIDs.has(input.sessionID);
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    const { text, check } = agentReviewPrompt({
      request: input,
      configuration: this.#configuration,
    });
    const agent = this.#configuration.reviewer.agent;
    const { sessionID } = await this.#client.create({
      model: (agent.runtime === "opencode" ? agent.model : undefined) ?? input.model,
    });
    this.#reviewerSessionIDs.add(sessionID);

    try {
      const response = await withTimeout({
        operation: this.#client.prompt({ sessionID, text }),
        timeoutMs: this.#configuration.reviewer.timeoutMs,
      });
      return parseVerdict(response, check);
    } catch (error) {
      void this.#client.abort({ sessionID }).catch(() => undefined);
      throw error;
    } finally {
      this.#reviewerSessionIDs.delete(sessionID);
    }
  }
}

/**
 * The agent reviewer's prompt and its review check, whichever runtime runs it.
 * An over-long prompt would be compacted or cut by the session, and the
 * reviewer would judge a summary, so it is refused here instead.
 */
export function agentReviewPrompt(input: {
  request: ReviewRequest;
  configuration: PluginConfiguration;
}): { text: string; check: string } {
  const check = reviewCheck();
  const text = reviewerPrompt({
    request: input.request,
    instructions: input.configuration.reviewer.instructions,
    replaceDefaultPolicy: input.configuration.reviewer.replaceDefaultPolicy === true,
    check,
  });
  const { maxInputBytes } = input.configuration.reviewer.agent;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxInputBytes) {
    throw new OversizeError(
      `Operation too large for the agent reviewer (${bytes.toLocaleString("en-US")} bytes, limit ${maxInputBytes.toLocaleString("en-US")}).`,
    );
  }
  return { text, check };
}

async function withTimeout<T>(input: { operation: Promise<T>; timeoutMs: number }): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Reviewer timed out.")), input.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
