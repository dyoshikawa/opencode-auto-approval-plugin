import type { PluginConfiguration } from "./config.js";
import {
  parseVerdict,
  type Reviewer,
  type ReviewRequest,
  type ReviewSessionClient,
  type ReviewVerdict,
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
    const { sessionID } = await this.#client.create({
      model: this.#configuration.reviewer.agent.model ?? input.model,
    });
    this.#reviewerSessionIDs.add(sessionID);

    try {
      const response = await withTimeout({
        operation: this.#client.prompt({
          sessionID,
          text: reviewerPrompt({
            request: input,
            instructions: this.#configuration.reviewer.instructions,
          }),
        }),
        timeoutMs: this.#configuration.reviewer.timeoutMs,
      });
      return parseVerdict(response);
    } catch (error) {
      void this.#client.abort({ sessionID }).catch(() => undefined);
      throw error;
    } finally {
      this.#reviewerSessionIDs.delete(sessionID);
    }
  }
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
