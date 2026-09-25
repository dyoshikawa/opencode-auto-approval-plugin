import { describe, expect, it, vi } from "vitest";

import { parsePluginConfiguration } from "./config.js";
import { JevReviewer } from "./jev-reviewer.js";
import type { ReviewRequest } from "./reviewer.js";

const request: ReviewRequest = {
  source: "permission-request",
  sessionID: "main-session",
  action: "shell",
  resource: { command: "pnpm test" },
  userIntent: "Run the tests",
};

function configuration(input: { timeoutMs?: number; minAllowProbability?: number } = {}) {
  return parsePluginConfiguration({
    options: {
      reviewer: {
        backend: "jev",
        timeoutMs: input.timeoutMs ?? 30_000,
        jev: { minAllowProbability: input.minAllowProbability },
      },
    },
    env: { TYPESAFE_API_KEY: "test-key" },
  });
}

function answer(input: { choice: string; probabilities?: Record<string, number> }): Response {
  return Response.json({
    model: "jev-1.13.0",
    answers: {
      verdict: {
        type: "choice",
        choice: input.choice,
        confidence: 0.9,
        probabilities: input.probabilities ?? { [input.choice]: 0.95 },
      },
    },
    usage: { input_tokens: 465, output_tokens: 41 },
  });
}

function reviewerWith(input: {
  response: () => Promise<Response>;
  timeoutMs?: number;
  minAllowProbability?: number;
}) {
  const fetch = vi.fn<typeof globalThis.fetch>(input.response);
  const reviewer = new JevReviewer({ configuration: configuration(input), fetch });
  return { reviewer, fetch };
}

describe("JevReviewer", () => {
  it("asks one Choice question over the operation state", async () => {
    const { reviewer, fetch } = reviewerWith({
      response: async () => answer({ choice: "allow", probabilities: { allow: 0.97 } }),
    });

    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "allow",
      reason: "Jev chose allow (allow 0.97, deny 0.00, escalate 0.00).",
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    });
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({
      source: "permission-request",
      action: "shell",
      resource: { command: "pnpm test" },
      userIntent: "Run the tests",
    });
    expect(Object.keys(body.questions)).toEqual(["verdict"]);
    expect(body.questions.verdict).toMatchObject({ type: "choice" });
    expect(Object.keys(body.questions.verdict.criteria)).toEqual(["allow", "deny", "escalate"]);
  });

  it.each(["deny", "escalate"])("passes a %s choice through", async (choice) => {
    const { reviewer } = reviewerWith({ response: async () => answer({ choice }) });

    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: choice });
  });

  it("escalates an allow below the probability threshold", async () => {
    const { reviewer } = reviewerWith({
      response: async () =>
        answer({ choice: "allow", probabilities: { allow: 0.45, escalate: 0.4, deny: 0.15 } }),
    });

    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "escalate",
      reason:
        "Jev leaned allow at 0.45, below the 0.60 threshold (allow 0.45, deny 0.15, escalate 0.40).",
    });
  });

  it("honours a configured threshold", async () => {
    const { reviewer } = reviewerWith({
      minAllowProbability: 0.4,
      response: async () => answer({ choice: "allow", probabilities: { allow: 0.45 } }),
    });

    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "allow" });
  });

  it("sends a null intent when the user said nothing", async () => {
    const { reviewer, fetch } = reviewerWith({ response: async () => answer({ choice: "deny" }) });

    await reviewer.review({ ...request, userIntent: undefined });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).state.userIntent).toBeNull();
  });

  it("cuts an oversized resource to a preview and never allows it", async () => {
    const { reviewer, fetch } = reviewerWith({ response: async () => answer({ choice: "allow" }) });

    const verdict = await reviewer.review({
      ...request,
      action: "edit",
      resource: { filePath: "a.ts", content: "x".repeat(100_000) },
    });

    const state = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).state;
    expect(state.resource).toMatchObject({ truncated: true });
    expect(state.resource.preview).toHaveLength(32_000);
    expect(verdict.verdict).toBe("escalate");
  });

  it("reports the HTTP status without the response body", async () => {
    const { reviewer } = reviewerWith({
      response: async () => new Response("secret detail", { status: 402 }),
    });

    await expect(reviewer.review(request)).rejects.toThrow("Jev request failed with HTTP 402.");
  });

  it("keeps a network error generic", async () => {
    const { reviewer } = reviewerWith({
      response: async () => {
        throw new TypeError("fetch failed: redirect to https://elsewhere.example");
      },
    });

    await expect(reviewer.review(request)).rejects.toThrow(/^Jev request failed\.$/);
  });

  it("rejects an answer outside the verdict schema", async () => {
    const { reviewer } = reviewerWith({ response: async () => answer({ choice: "maybe" }) });

    await expect(reviewer.review(request)).rejects.toThrow("did not match the verdict schema");
  });

  it("rejects a body that is not JSON", async () => {
    const { reviewer } = reviewerWith({ response: async () => new Response("<html>") });

    await expect(reviewer.review(request)).rejects.toThrow("Jev response was not JSON.");
  });

  it("times out while waiting for the response", async () => {
    const { reviewer } = reviewerWith({
      timeoutMs: 10,
      response: () => new Promise<Response>(() => undefined),
    });

    await expect(reviewer.review(request)).rejects.toThrow("Reviewer timed out.");
  });

  it("times out while reading a stalled body", async () => {
    const { reviewer, fetch } = reviewerWith({
      timeoutMs: 10,
      response: async () => new Response(),
    });
    fetch.mockImplementation(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body);
    });

    await expect(reviewer.review(request)).rejects.toThrow("Reviewer timed out.");
  });

  it("owns no opencode sessions", () => {
    const { reviewer } = reviewerWith({ response: async () => answer({ choice: "allow" }) });

    expect(reviewer.isReviewerSession()).toBe(false);
  });
});
