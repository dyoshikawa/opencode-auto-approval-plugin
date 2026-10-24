import type { Reviewer, ReviewRequest, ReviewVerdict } from "./reviewer.js";

/**
 * Caps how many reviews run at once, so a burst of parallel tool calls cannot
 * start an unbounded number of reviewer sessions or model requests. A review
 * waits for a free slot at most `waitMs`; past that it escalates to a human.
 */
export class ConcurrencyLimitedReviewer implements Reviewer {
  readonly #reviewer: Reviewer;
  readonly #maxConcurrent: number;
  readonly #waitMs: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(input: { reviewer: Reviewer; maxConcurrent: number; waitMs: number }) {
    this.#reviewer = input.reviewer;
    this.#maxConcurrent = input.maxConcurrent;
    this.#waitMs = input.waitMs;
  }

  isReviewerSession(input: { sessionID: string }): boolean {
    return this.#reviewer.isReviewerSession(input);
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    if (!(await this.#acquire())) {
      return {
        verdict: "escalate",
        reason: `All ${this.#maxConcurrent} review slots stayed busy; a human should review it.`,
      };
    }
    try {
      return await this.#reviewer.review(input);
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<boolean> {
    if (this.#running < this.#maxConcurrent) {
      this.#running++;
      return true;
    }
    return new Promise((resolve) => {
      const admit = () => {
        clearTimeout(timer);
        this.#running++;
        resolve(true);
      };
      const timer = setTimeout(() => {
        const index = this.#waiting.indexOf(admit);
        if (index !== -1) this.#waiting.splice(index, 1);
        resolve(false);
      }, this.#waitMs);
      this.#waiting.push(admit);
    });
  }

  #release(): void {
    this.#running--;
    this.#waiting.shift()?.();
  }
}
