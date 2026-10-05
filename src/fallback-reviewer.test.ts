import { describe, expect, it, vi } from "vitest";

import { OversizeFallbackReviewer } from "./fallback-reviewer.js";
import { OversizeError, type Reviewer, type ReviewRequest } from "./reviewer.js";

const request: ReviewRequest = {
  source: "tool-call",
  sessionID: "s",
  action: "edit",
  resource: { filePath: "big.md" },
};

function reviewer(
  review: Reviewer["review"],
  session = "none",
): Reviewer & { review: typeof review } {
  return { review: vi.fn(review), isReviewerSession: ({ sessionID }) => sessionID === session };
}

const tooLarge = async (): Promise<never> => {
  throw new OversizeError("Operation too large for jev-latest (refused by the API).");
};

describe("OversizeFallbackReviewer", () => {
  it("returns the primary verdict when it fits", async () => {
    const fallback = reviewer(async () => ({ verdict: "deny", reason: "fallback" }));
    const wrapped = new OversizeFallbackReviewer({
      primary: reviewer(async () => ({ verdict: "allow", reason: "primary" })),
      fallback,
    });

    await expect(wrapped.review(request)).resolves.toEqual({ verdict: "allow", reason: "primary" });
    expect(fallback.review).not.toHaveBeenCalled();
  });

  it("hands an oversized operation to the fallback, whose allow stands", async () => {
    const wrapped = new OversizeFallbackReviewer({
      primary: reviewer(tooLarge),
      fallback: reviewer(async () => ({ verdict: "allow", reason: "read it whole" })),
    });

    await expect(wrapped.review(request)).resolves.toEqual({
      verdict: "allow",
      reason: "read it whole",
    });
  });

  it("escalates an oversized operation with the reason when there is no fallback", async () => {
    const wrapped = new OversizeFallbackReviewer({ primary: reviewer(tooLarge) });

    await expect(wrapped.review(request)).resolves.toEqual({
      verdict: "escalate",
      reason: "Operation too large for jev-latest (refused by the API). A human should review it.",
    });
  });

  it("escalates when the fallback finds it too large as well", async () => {
    const wrapped = new OversizeFallbackReviewer({
      primary: reviewer(tooLarge),
      fallback: reviewer(tooLarge),
    });

    await expect(wrapped.review(request)).resolves.toMatchObject({ verdict: "escalate" });
  });

  it("leaves other failures to the caller", async () => {
    const fallback = reviewer(async () => ({ verdict: "allow", reason: "never" }));
    const wrapped = new OversizeFallbackReviewer({
      primary: reviewer(async () => {
        throw new Error("Decision model request failed with HTTP 503.");
      }),
      fallback,
    });

    await expect(wrapped.review(request)).rejects.toThrow("HTTP 503");
    expect(fallback.review).not.toHaveBeenCalled();
  });

  it("recognizes the fallback agent's sessions", () => {
    const wrapped = new OversizeFallbackReviewer({
      primary: reviewer(tooLarge),
      fallback: reviewer(tooLarge, "review-session"),
    });

    expect(wrapped.isReviewerSession({ sessionID: "review-session" })).toBe(true);
    expect(wrapped.isReviewerSession({ sessionID: "main" })).toBe(false);
  });
});
