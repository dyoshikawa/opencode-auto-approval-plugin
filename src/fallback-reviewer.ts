import {
  OversizeError,
  type Reviewer,
  type ReviewRequest,
  type ReviewVerdict,
  sanitizeReason,
} from "./reviewer.js";

/**
 * Hands an operation too large for the primary reviewer to a fallback that
 * can read it whole — the agent or the chat reviewer — or, without one,
 * escalates it to a human with the reason. Any other failure is left to the
 * caller, which treats it as the reviewer failing.
 */
export class OversizeFallbackReviewer implements Reviewer {
  readonly #primary: Reviewer;
  readonly #fallback: Reviewer | undefined;

  constructor(input: { primary: Reviewer; fallback?: Reviewer }) {
    this.#primary = input.primary;
    this.#fallback = input.fallback;
  }

  isReviewerSession(input: { sessionID: string }): boolean {
    return (
      this.#primary.isReviewerSession(input) || (this.#fallback?.isReviewerSession(input) ?? false)
    );
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    try {
      return await this.#primary.review(input);
    } catch (error) {
      if (!(error instanceof OversizeError)) throw error;
      if (this.#fallback === undefined) return escalation(error);
      try {
        return await this.#fallback.review(input);
      } catch (fallbackError) {
        if (fallbackError instanceof OversizeError) return escalation(fallbackError);
        throw fallbackError;
      }
    }
  }
}

function escalation(error: OversizeError): ReviewVerdict {
  return {
    verdict: "escalate",
    reason: sanitizeReason(`${error.message} A human should review it.`),
  };
}
