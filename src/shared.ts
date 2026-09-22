import type { PluginConfiguration } from "./config.js";
import type { Reviewer, ReviewRequest, ReviewSessionClient, ReviewVerdict } from "./reviewer.js";

export type PluginDependencies = {
  createReviewer(input: {
    client: ReviewSessionClient;
    configuration: PluginConfiguration;
    pluginDirectory?: string;
  }): Reviewer;
};

/**
 * `on-ask` semantics shared by both plugin generations: only an explicit
 * `allow` verdict is acted on; `deny`, `escalate` and any reviewer failure
 * leave the human permission prompt in place.
 */
export async function reviewForApproval(input: {
  reviewer: Pick<Reviewer, "review">;
  request: ReviewRequest;
}): Promise<ReviewVerdict | undefined> {
  try {
    const decision = await input.reviewer.review(input.request);
    return decision.verdict === "allow" ? decision : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `all-tools` semantics shared by both plugin generations: the tool runs only
 * on `allow`; a reviewer failure or any other verdict is thrown so opencode
 * blocks the call and shows the reason.
 */
export async function reviewToolCallOrThrow(input: {
  reviewer: Pick<Reviewer, "review">;
  request: ReviewRequest;
}): Promise<void> {
  let decision: ReviewVerdict;
  try {
    decision = await input.reviewer.review(input.request);
  } catch (error) {
    throw new Error(
      `Auto-approval reviewer failed; human review is required. ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (decision.verdict === "allow") return;
  const outcome = decision.verdict === "deny" ? "denied" : "requires human review";
  throw new Error(`Auto-approval reviewer ${outcome}: ${decision.reason}`);
}

export function textFromParts(parts: unknown[]): string {
  return parts
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

function errorMessage(input: unknown): string {
  return input instanceof Error ? input.message : String(input);
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
