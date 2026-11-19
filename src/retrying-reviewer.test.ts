import { describe, expect, it } from "vite-plus/test";

import { RetryingReviewer } from "./retrying-reviewer.js";
import { OversizeError } from "./reviewer.js";
import type { ReviewVerdict } from "./reviewer.js";

function reviewerFailing(times: number) {
  const calls: string[] = [];
  return {
    calls,
    isReviewerSession: (input: { sessionID: string }) => input.sessionID === "reviewer",
    review: async (input: { sessionID: string }): Promise<ReviewVerdict> => {
      calls.push(input.sessionID);
      if (calls.length <= times) throw new Error(`failure ${calls.length}`);
      return { verdict: "allow", reason: "ok" };
    },
  };
}

const request = { source: "tool-call" as const, sessionID: "s", action: "read", resource: {} };

describe("RetryingReviewer", () => {
  it("settles on the first verdict and never retries a success", async () => {
    const inner = reviewerFailing(0);
    const reviewer = new RetryingReviewer({ reviewer: inner, maxAttempts: 3 });
    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "allow" });
    expect(inner.calls).toHaveLength(1);
  });

  it("retries a failed review until one produces a verdict", async () => {
    const inner = reviewerFailing(2);
    const reviewer = new RetryingReviewer({ reviewer: inner, maxAttempts: 3 });
    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "allow" });
    expect(inner.calls).toHaveLength(3);
  });

  it("rethrows the last failure once the attempts are spent", async () => {
    const inner = reviewerFailing(5);
    const reviewer = new RetryingReviewer({ reviewer: inner, maxAttempts: 2 });
    await expect(reviewer.review(request)).rejects.toThrow("failure 2");
    expect(inner.calls).toHaveLength(2);
  });

  it("does not retry an operation too large for the backend", async () => {
    let calls = 0;
    const reviewer = new RetryingReviewer({
      reviewer: {
        isReviewerSession: () => false,
        review: async () => {
          calls += 1;
          throw new OversizeError("too large");
        },
      },
      maxAttempts: 3,
    });
    await expect(reviewer.review(request)).rejects.toThrow("too large");
    expect(calls).toBe(1);
  });

  it("keeps the wrapped reviewer's own sessions out of the review flow", () => {
    const reviewer = new RetryingReviewer({ reviewer: reviewerFailing(0), maxAttempts: 2 });
    expect(reviewer.isReviewerSession({ sessionID: "reviewer" })).toBe(true);
    expect(reviewer.isReviewerSession({ sessionID: "other" })).toBe(false);
  });
});
