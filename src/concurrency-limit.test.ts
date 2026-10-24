import { describe, expect, it } from "vitest";

import { ConcurrencyLimitedReviewer } from "./concurrency-limit.js";
import type { ReviewVerdict } from "./reviewer.js";

/** A reviewer whose reviews finish only when the test releases them. */
function gatedReviewer() {
  const pending: (() => void)[] = [];
  const started: string[] = [];
  let running = 0;
  let peak = 0;
  return {
    pending,
    started,
    peak: () => peak,
    isReviewerSession: () => false,
    review: async (input: { sessionID: string }): Promise<ReviewVerdict> => {
      started.push(input.sessionID);
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => pending.push(resolve));
      running--;
      return { verdict: "allow", reason: "ok" };
    },
  };
}

const request = { source: "tool-call" as const, sessionID: "s", action: "read", resource: {} };

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("ConcurrencyLimitedReviewer", () => {
  it("runs at most maxConcurrent reviews and starts waiting ones in order", async () => {
    const inner = gatedReviewer();
    const reviewer = new ConcurrencyLimitedReviewer({
      reviewer: inner,
      maxConcurrent: 2,
      waitMs: 10_000,
    });
    const reviews = Array.from({ length: 5 }, (_, index) =>
      reviewer.review({ ...request, sessionID: `s${index}` }),
    );
    await settle();
    expect(inner.pending).toHaveLength(2);
    while (inner.pending.length > 0) {
      inner.pending.shift()?.();
      await settle();
    }
    await expect(Promise.all(reviews)).resolves.toHaveLength(5);
    expect(inner.peak()).toBe(2);
    expect(inner.started).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("escalates a review that waited longer than waitMs for a slot", async () => {
    const inner = gatedReviewer();
    const reviewer = new ConcurrencyLimitedReviewer({
      reviewer: inner,
      maxConcurrent: 1,
      waitMs: 5,
    });
    const first = reviewer.review(request);
    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "escalate",
      reason: "All 1 review slots stayed busy; a human should review it.",
    });
    inner.pending.shift()?.();
    await expect(first).resolves.toMatchObject({ verdict: "allow" });
    // The slot is free again for the next review.
    const next = reviewer.review(request);
    await settle();
    inner.pending.shift()?.();
    await expect(next).resolves.toMatchObject({ verdict: "allow" });
  });

  it("frees the slot when a review fails", async () => {
    let calls = 0;
    const reviewer = new ConcurrencyLimitedReviewer({
      reviewer: {
        isReviewerSession: () => false,
        review: async () => {
          calls++;
          if (calls === 1) throw new Error("boom");
          return { verdict: "allow", reason: "ok" };
        },
      },
      maxConcurrent: 1,
      waitMs: 5,
    });
    await expect(reviewer.review(request)).rejects.toThrow("boom");
    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "allow" });
  });
});
