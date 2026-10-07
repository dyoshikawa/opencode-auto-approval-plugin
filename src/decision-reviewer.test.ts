import { describe, expect, it, vi } from "vitest";

import { parsePluginConfiguration } from "./config.js";
import { DecisionReviewer } from "./decision-reviewer.js";
import { OversizeError, type ReviewRequest, userInstructionsPreamble } from "./reviewer.js";
import type { UsageRecord } from "./usage.js";

const request: ReviewRequest = {
  source: "permission-request",
  sessionID: "main-session",
  action: "shell",
  resource: { command: "pnpm test" },
  userIntent: "Run the tests",
};

function configuration(
  input: { timeoutMs?: number; minAllowProbability?: number; instructions?: string[] } = {},
) {
  return parsePluginConfiguration({
    options: {
      reviewer: {
        backend: "decision",
        timeoutMs: input.timeoutMs ?? 30_000,
        instructions: input.instructions,
        decision: { provider: "typesafe", minAllowProbability: input.minAllowProbability },
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
  instructions?: string[];
}) {
  const fetch = vi.fn<typeof globalThis.fetch>(input.response);
  const reviewer = new DecisionReviewer({ configuration: configuration(input), fetch });
  return { reviewer, fetch };
}

describe("DecisionReviewer", () => {
  it("adds configured instructions to the question, not to the state", async () => {
    const { reviewer, fetch } = reviewerWith({
      response: async () => answer({ choice: "allow" }),
      instructions: ["`pnpm test` is always safe."],
    });

    await reviewer.review(request);

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const instructions: string = body.questions.verdict.instructions;
    expect(
      instructions.endsWith(`\n${userInstructionsPreamble}\n\`pnpm test\` is always safe.`),
    ).toBe(true);
    expect(JSON.stringify(body.state)).not.toContain("always safe");
  });

  it("sends only the built-in instructions when none are configured", async () => {
    const { reviewer, fetch } = reviewerWith({ response: async () => answer({ choice: "allow" }) });

    await reviewer.review(request);

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.questions.verdict.instructions).not.toContain(userInstructionsPreamble);
  });

  it("asks one Choice question over the operation state", async () => {
    const { reviewer, fetch } = reviewerWith({
      response: async () => answer({ choice: "allow", probabilities: { allow: 0.97 } }),
    });

    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "allow",
      reason: "jev-latest chose allow (allow 0.97, deny 0.00, escalate 0.00).",
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
        "jev-latest leaned allow at 0.45, below the 0.60 threshold (allow 0.45, deny 0.15, escalate 0.40).",
    });
  });

  it("honours a configured threshold", async () => {
    const { reviewer } = reviewerWith({
      minAllowProbability: 0.4,
      response: async () => answer({ choice: "allow", probabilities: { allow: 0.45 } }),
    });

    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "allow" });
  });

  it.each([undefined, "", "  \n"])(
    "sends a null intent when the user said nothing (%j)",
    async (userIntent) => {
      const { reviewer, fetch } = reviewerWith({
        response: async () => answer({ choice: "deny" }),
      });

      await reviewer.review({ ...request, userIntent });

      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).state.userIntent).toBeNull();
    },
  );

  it("does not mistake a resource's own truncated field for a cut", async () => {
    const { reviewer } = reviewerWith({ response: async () => answer({ choice: "allow" }) });

    await expect(
      reviewer.review({ ...request, resource: { truncated: false, command: "ls" } }),
    ).resolves.toMatchObject({ verdict: "allow" });
  });

  it("falls back to the confidence when no probabilities are given", async () => {
    const { reviewer } = reviewerWith({
      response: async () =>
        Response.json({ answers: { verdict: { choice: "allow", confidence: 0.5 } } }),
    });

    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "escalate",
      reason: "jev-latest leaned allow at 0.50, below the 0.60 threshold (confidence 0.50).",
    });
  });

  it("reads a missing probability as zero rather than the confidence", async () => {
    const { reviewer } = reviewerWith({
      response: async () =>
        Response.json({
          answers: { verdict: { choice: "allow", confidence: 0.9, probabilities: { deny: 0.1 } } },
        }),
    });

    await expect(reviewer.review(request)).resolves.toMatchObject({
      verdict: "escalate",
      reason: expect.stringContaining("leaned allow at 0.00"),
    });
  });

  it("reports the HTTP status without the response body", async () => {
    const { reviewer } = reviewerWith({
      response: async () => new Response("secret detail", { status: 402 }),
    });

    await expect(reviewer.review(request)).rejects.toThrow(
      "Decision model request failed with HTTP 402.",
    );
  });

  it("keeps a network error generic", async () => {
    const { reviewer } = reviewerWith({
      response: async () => {
        throw new TypeError("fetch failed: redirect to https://elsewhere.example");
      },
    });

    await expect(reviewer.review(request)).rejects.toThrow(/^Decision model request failed\.$/);
  });

  it("rejects an answer outside the verdict schema", async () => {
    const { reviewer } = reviewerWith({ response: async () => answer({ choice: "maybe" }) });

    await expect(reviewer.review(request)).rejects.toThrow("did not match the verdict schema");
  });

  it("rejects a body that is not JSON", async () => {
    const { reviewer } = reviewerWith({ response: async () => new Response("<html>") });

    await expect(reviewer.review(request)).rejects.toThrow("Decision model response was not JSON.");
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

// Recorded from Workers AI on 2026-10-04: the System One answer arrives
// inside the Cloudflare API envelope.
function envelope(input: { choice: string; probabilities: Record<string, number> }) {
  return Response.json({
    result: {
      model: "clef-flash",
      answers: {
        verdict: {
          type: "choice",
          choice: input.choice,
          probabilities: input.probabilities,
          confidence: 0.82,
        },
      },
      usage: { input_tokens: 219, output_tokens: 0 },
    },
    success: true,
    errors: [],
    messages: [],
  });
}

describe("DecisionReviewer with Cloudflare Workers AI", () => {
  const accountId = "0123456789abcdef0123456789abcdef";

  function cloudflareReviewer(input: { response: () => Promise<Response>; model?: string }) {
    const fetch = vi.fn<typeof globalThis.fetch>(input.response);
    const reviewer = new DecisionReviewer({
      configuration: parsePluginConfiguration({
        options: {
          reviewer: {
            backend: "decision",
            decision: { provider: "cloudflare", model: input.model },
          },
        },
        env: { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: accountId },
      }),
      fetch,
    });
    return { reviewer, fetch };
  }

  it("posts the same question to the account's Workers AI model and unwraps the envelope", async () => {
    const { reviewer, fetch } = cloudflareReviewer({
      model: "clef-flash",
      response: async () =>
        envelope({
          choice: "deny",
          probabilities: { allow: 0.0159, deny: 0.9377, escalate: 0.0464 },
        }),
    });

    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "deny",
      reason: "clef-flash chose deny (allow 0.02, deny 0.94, escalate 0.05).",
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-flash`,
    );
    expect(init).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer cf-token" },
    });
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("clef-flash");
    expect(Object.keys(body.questions)).toEqual(["verdict"]);
  });

  it("uses the configured Clef model in the URL, the body and the reason", async () => {
    const { reviewer, fetch } = cloudflareReviewer({
      model: "clef",
      response: async () =>
        envelope({ choice: "allow", probabilities: { allow: 0.97, deny: 0.01, escalate: 0.02 } }),
    });

    await expect(reviewer.review(request)).resolves.toMatchObject({
      verdict: "allow",
      reason: "clef chose allow (allow 0.97, deny 0.01, escalate 0.02).",
    });
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/ai\/run\/@cf\/cloudflare\/clef$/);
  });

  it("fails on an unsuccessful envelope", async () => {
    const { reviewer } = cloudflareReviewer({
      response: async () =>
        Response.json({ result: null, success: false, errors: [{ code: 5007 }], messages: [] }),
    });

    await expect(reviewer.review(request)).rejects.toThrow(
      "Decision model response did not match the verdict schema.",
    );
  });

  it("does not accept a bare System One answer from Workers AI", async () => {
    const { reviewer } = cloudflareReviewer({
      response: async () => answer({ choice: "allow" }),
    });

    await expect(reviewer.review(request)).rejects.toThrow(
      "Decision model response did not match the verdict schema.",
    );
  });
});

function recordingReviewer(input: { response: () => Promise<Response> }) {
  const records: UsageRecord[] = [];
  const reviewer = new DecisionReviewer({
    configuration: configuration(),
    fetch: vi.fn<typeof globalThis.fetch>(input.response),
    recordUsage: (record) => records.push(record),
    project: "project-id",
  });
  return { reviewer, records };
}

describe("DecisionReviewer usage records", () => {
  it("records the tokens, the cost and the final verdict of a review", async () => {
    const { reviewer, records } = recordingReviewer({
      response: async () => answer({ choice: "allow", probabilities: { allow: 0.45 } }),
    });

    await reviewer.review(request);

    expect(records).toEqual([
      {
        v: 1,
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        provider: "typesafe",
        model: "jev-latest",
        project: "project-id",
        inputTokens: 465,
        outputTokens: 41,
        latencyMs: expect.any(Number),
        // A hesitant allow is escalated, and the log says what was decided.
        verdict: "escalate",
        costUSD: (465 * 0.042) / 1_000_000,
      },
    ]);
  });

  it("records a failed review without tokens", async () => {
    const { reviewer, records } = recordingReviewer({
      response: async () => new Response("no", { status: 429 }),
    });

    await expect(reviewer.review(request)).rejects.toThrow("HTTP 429");
    expect(records).toMatchObject([{ verdict: "error", inputTokens: null, costUSD: null }]);
  });

  it("keeps the review when recording throws", async () => {
    const reviewer = new DecisionReviewer({
      configuration: configuration(),
      fetch: vi.fn<typeof globalThis.fetch>(async () => answer({ choice: "deny" })),
      recordUsage: () => {
        throw new Error("disk full");
      },
    });

    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "deny" });
  });

  it("reads the tokens from inside the Workers AI envelope", async () => {
    const records: UsageRecord[] = [];
    const reviewer = new DecisionReviewer({
      configuration: parsePluginConfiguration({
        options: {
          reviewer: { backend: "decision", decision: { provider: "cloudflare" } },
        },
        env: {
          CLOUDFLARE_API_TOKEN: "cf-token",
          CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        },
      }),
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        envelope({ choice: "deny", probabilities: { allow: 0.01, deny: 0.97, escalate: 0.02 } }),
      ),
      recordUsage: (record) => records.push(record),
    });

    await reviewer.review(request);

    expect(records).toMatchObject([
      { provider: "cloudflare", model: "clef", inputTokens: 219, outputTokens: 0, verdict: "deny" },
    ]);
    expect(records[0]?.costUSD).toBeCloseTo((219 * 0.24) / 1_000_000, 12);
  });
});

function oversizeReviewer(input: { response: () => Promise<Response>; maxStateTokens?: number }) {
  const records: UsageRecord[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(input.response);
  const reviewer = new DecisionReviewer({
    configuration: parsePluginConfiguration({
      options: {
        reviewer: {
          backend: "decision",
          decision: { provider: "typesafe", maxStateTokens: input.maxStateTokens },
        },
      },
      env: { TYPESAFE_API_KEY: "test-key" },
    }),
    fetch,
    recordUsage: (record) => records.push(record),
  });
  return { reviewer, fetch, records };
}

describe("DecisionReviewer with an operation too large for the model", () => {
  it("does not send an operation whose estimate exceeds the budget", async () => {
    const { reviewer, fetch, records } = oversizeReviewer({
      response: async () => answer({ choice: "allow" }),
    });

    // 30,000 Japanese characters measured as about 30,000 Jev tokens.
    const review = reviewer.review({
      ...request,
      action: "edit",
      resource: { filePath: "doc.md", content: "日".repeat(30_000) },
    });

    await expect(review).rejects.toBeInstanceOf(OversizeError);
    await expect(review).rejects.toThrow(
      /too large for jev-latest \(about 33,0\d\d tokens, budget 28,000\)/,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(records).toMatchObject([{ verdict: "oversize", inputTokens: 0, costUSD: 0 }]);
  });

  it("sends a large operation whole when it fits, never a preview", async () => {
    const { reviewer, fetch } = oversizeReviewer({
      response: async () =>
        Response.json({
          answers: { verdict: { choice: "allow", probabilities: { allow: 0.9 } } },
          // What Jev counted for 60,000 characters of code.
          usage: { input_tokens: 17_882 },
        }),
    });
    const content = "x".repeat(60_000);

    await expect(
      reviewer.review({ ...request, resource: { filePath: "a.ts", content } }),
    ).resolves.toMatchObject({ verdict: "allow" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).state.resource.content).toBe(content);
  });

  it("follows a configured budget", async () => {
    const { reviewer, fetch } = oversizeReviewer({
      maxStateTokens: 1_000,
      response: async () => answer({ choice: "allow" }),
    });

    await expect(
      reviewer.review({ ...request, resource: { content: "x".repeat(5_000) } }),
    ).rejects.toBeInstanceOf(OversizeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats Jev's max_tokens_exceeded as oversize", async () => {
    const { reviewer, records } = oversizeReviewer({
      response: async () =>
        Response.json({ detail: { error_type: "max_tokens_exceeded" } }, { status: 400 }),
    });

    await expect(reviewer.review(request)).rejects.toThrow(
      "Operation too large for jev-latest (refused by the API).",
    );
    expect(records).toMatchObject([{ verdict: "oversize", inputTokens: null }]);
  });

  it("keeps any other 400 a plain failure", async () => {
    const { reviewer } = oversizeReviewer({
      response: async () => Response.json({ detail: "bad question" }, { status: 400 }),
    });

    const review = reviewer.review(request);
    await expect(review).rejects.toThrow("Decision model request failed with HTTP 400.");
    await expect(review).rejects.not.toBeInstanceOf(OversizeError);
  });

  it("does not trust an answer from a server that counted far fewer tokens than it was sent", async () => {
    const { reviewer, records } = oversizeReviewer({
      response: async () =>
        Response.json({
          answers: { verdict: { choice: "allow", probabilities: { allow: 0.99 } } },
          usage: { input_tokens: 1_000 },
        }),
    });

    await expect(
      reviewer.review({ ...request, resource: { content: "日本語".repeat(6_000) } }),
    ).rejects.toThrow(
      /counted 1,000 tokens for a prompt of at least [\d,]+, so it likely cut the input/,
    );
    expect(records).toMatchObject([{ verdict: "oversize", inputTokens: 1_000 }]);
  });
});
