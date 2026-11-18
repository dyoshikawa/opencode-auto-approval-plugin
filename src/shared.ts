import type { PluginConfiguration } from "./config.js";
import type { Reviewer, ReviewRequest, ReviewSessionClient, ReviewVerdict } from "./reviewer.js";

export type PluginDependencies = {
  createReviewer(input: {
    client: ReviewSessionClient;
    configuration: PluginConfiguration;
    /** The project directory OpenCode loaded the plugin for. */
    directory: string;
  }): Reviewer;
};

/**
 * What an on-ask review settled to, before the ask policy decides its effect.
 * A reviewer failure is one outcome, not an absence: a policy that settles
 * unapproved asks has to settle those too.
 */
export type AskOutcome =
  | { kind: "allow"; verdict: ReviewVerdict & { verdict: "allow" } }
  | { kind: "unapproved"; verdict: ReviewVerdict & { verdict: "deny" | "escalate" } }
  | { kind: "failed"; error: unknown };

/**
 * Runs one ask review and reports what it settled to. The caller applies the
 * configured ask policy; `reviewForApproval` is that policy when only an
 * `allow` is acted on.
 */
export async function reviewAsk(input: {
  reviewer: Pick<Reviewer, "review">;
  request: ReviewRequest;
}): Promise<AskOutcome> {
  try {
    const verdict = await input.reviewer.review(input.request);
    if (verdict.verdict === "allow") {
      return { kind: "allow", verdict: { ...verdict, verdict: "allow" } };
    }
    return { kind: "unapproved", verdict: { ...verdict, verdict: verdict.verdict } };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/**
 * `on-ask` semantics shared by both plugin generations: only an explicit
 * `allow` verdict is acted on; `deny`, `escalate` and any reviewer failure
 * leave the human permission prompt in place.
 */
export async function reviewForApproval(input: {
  reviewer: Pick<Reviewer, "review">;
  request: ReviewRequest;
}): Promise<ReviewVerdict | undefined> {
  const outcome = await reviewAsk(input);
  return outcome.kind === "allow" ? outcome.verdict : undefined;
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

/** Stop waiting for `promise` after `ms`; the underlying work is not cancelled. */
export async function withTimeout<T>(input: {
  promise: Promise<T>;
  ms: number;
  message: string;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(input.message)), input.ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function textFromParts(input: {
  parts: unknown[];
  skipSyntheticOrIgnored?: boolean;
}): string {
  return input.parts
    .flatMap((part) =>
      isRecord(part) &&
      typeof part.text === "string" &&
      (!input.skipSyntheticOrIgnored || (part.type === "text" && !part.synthetic && !part.ignored))
        ? [part.text]
        : [],
    )
    .join("\n");
}

function errorMessage(input: unknown): string {
  return input instanceof Error ? input.message : String(input);
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
