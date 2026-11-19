import type { Reviewer, ReviewRequest, ReviewVerdict } from "./reviewer.js";
import { OversizeError } from "./reviewer.js";

/**
 * Runs a failed review again, up to `maxAttempts` times in total. Every
 * backend starts a fresh session (or request) per review, so a retry is never
 * a nudge of a session that already failed: an aborted, timed-out or
 * unreadable reply is retried from scratch instead of settling the ask on a
 * transient failure.
 *
 * An `OversizeError` is not retried: the operation is too large for the
 * backend whatever the attempt, and the fallback (where one is configured) has
 * already run by then.
 */
export class RetryingReviewer implements Reviewer {
  readonly #reviewer: Reviewer;
  readonly #maxAttempts: number;

  constructor(input: { reviewer: Reviewer; maxAttempts: number }) {
    this.#reviewer = input.reviewer;
    this.#maxAttempts = input.maxAttempts;
  }

  isReviewerSession(input: { sessionID: string }): boolean {
    return this.#reviewer.isReviewerSession(input);
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    let failure: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.#reviewer.review(input);
      } catch (error) {
        if (error instanceof OversizeError) throw error;
        failure = error;
      }
    }
    // The last attempt's error, so the caller reports the failure reason it
    // would have seen without the retries.
    throw failure;
  }
}
