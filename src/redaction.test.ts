import { describe, expect, it, vi } from "vitest";

import { RedactingReviewer, redactSecrets } from "./redaction.js";
import type { ReviewRequest } from "./reviewer.js";

function recordingReviewer() {
  const requests: ReviewRequest[] = [];
  return {
    requests,
    review: vi.fn(async (request: ReviewRequest) => {
      requests.push(request);
      return { verdict: "allow" as const, reason: "ok" };
    }),
    isReviewerSession: vi.fn(() => true),
  };
}

describe("redactSecrets", () => {
  it.each([
    ["curl -H 'Authorization: Bearer abc.def' https://x", "Authorization: Bearer [REDACTED]"],
    ["GITHUB_TOKEN=ghp_123 gh pr list", "GITHUB_TOKEN=[REDACTED]"],
    ["mysql --password=hunter2", "--password=[REDACTED]"],
    [`git clone https://user:${"x"}@example.com/repo`, "https://[REDACTED]@example.com"],
    [`echo ${"sk-" + "a".repeat(24)}`, "[REDACTED_TOKEN]"],
  ])("redacts %s", (text, expected) => {
    const redacted = redactSecrets({ text });
    expect(redacted).toContain(expected);
  });

  it("replaces configured API keys and custom patterns", () => {
    expect(
      redactSecrets({
        text: "use key-123 for acct 4242-4242",
        apiKeys: ["key-123"],
        patterns: [/\d{4}-\d{4}/g],
      }),
    ).toBe("use [REDACTED_KEY] for acct [REDACTED]");
  });
});

describe("RedactingReviewer", () => {
  it("reviews a redacted copy and leaves the live tool input untouched", async () => {
    const inner = recordingReviewer();
    const reviewer = new RedactingReviewer({ reviewer: inner, apiKeys: [], patterns: [] });
    const input = { command: "API_KEY=supersecret ./deploy.sh", env: ["TOKEN=abc"], count: 2 };
    await reviewer.review({
      source: "tool-call",
      sessionID: "s",
      action: "bash",
      resource: input,
      userIntent: "deploy with PASSWORD=pw1",
      conversation: {
        turns: [{ role: "user", text: "use ghp_" + "x".repeat(36) }],
        incomplete: false,
      },
    });

    expect(input).toEqual({
      command: "API_KEY=supersecret ./deploy.sh",
      env: ["TOKEN=abc"],
      count: 2,
    });
    expect(inner.requests[0]).toMatchObject({
      resource: { command: "API_KEY=[REDACTED] ./deploy.sh", env: ["TOKEN=[REDACTED]"], count: 2 },
      userIntent: "deploy with PASSWORD=[REDACTED]",
      conversation: { turns: [{ role: "user", text: "use [REDACTED_TOKEN]" }] },
    });
    expect(reviewer.isReviewerSession({ sessionID: "s" })).toBe(true);
  });
});
