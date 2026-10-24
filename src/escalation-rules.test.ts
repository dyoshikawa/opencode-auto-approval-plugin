import { describe, expect, it, vi } from "vitest";

import {
  type EscalationRule,
  EscalationRulesReviewer,
  matchesWildcard,
} from "./escalation-rules.js";
import type { ReviewRequest } from "./reviewer.js";

/** A reviewer that allows everything, as an injected or misled model might. */
function permissiveReviewer() {
  return {
    review: vi.fn(async () => ({ verdict: "allow" as const, reason: "looks fine" })),
    isReviewerSession: vi.fn((input: { sessionID: string }) => input.sessionID === "review"),
  };
}

function toolCall(action: string, resource: unknown): ReviewRequest {
  return { source: "tool-call", sessionID: "s", action, resource };
}

function edit(resources: string[]): ReviewRequest {
  return {
    source: "permission-request",
    sessionID: "s",
    action: "edit",
    resource: { resources, metadata: { diff: "+ const url = process.env.URL;" } },
  };
}

const highRisk: EscalationRule[] = [
  { action: "bash", resource: "*git push*" },
  { action: "bash", resource: "*rm -rf*" },
  { action: "bash", resource: "npm publish *" },
  { action: "webfetch" },
  { action: "*", resource: "*.env*" },
];

describe("EscalationRulesReviewer", () => {
  it.each([
    toolCall("bash", { command: "git push --force origin main" }),
    toolCall("bash", { command: "cd repo && git push" }),
    toolCall("bash", { command: "git   push\torigin" }),
    toolCall("bash", { command: "ls; rm -rf /" }),
    toolCall("bash", { command: "npm publish" }),
    toolCall("webfetch", { url: "https://example.com" }),
    toolCall("read", { filePath: "/workspace/.env.local" }),
    toolCall("edit", { nested: { deeper: [{ path: "config/.env" }] } }),
    {
      source: "permission-request",
      sessionID: "s",
      action: "bash",
      resource: { resources: ["ls", "git push origin main"], metadata: {} },
    } satisfies ReviewRequest,
    {
      source: "permission-request",
      sessionID: "s",
      action: "bash",
      resource: { pattern: ["npm publish --tag next"], metadata: {} },
    } satisfies ReviewRequest,
  ])("escalates a high-risk operation the reviewer would allow (%#)", async (request) => {
    const inner = permissiveReviewer();
    const reviewer = new EscalationRulesReviewer({ reviewer: inner, rules: highRisk });
    const decision = await reviewer.review(request);
    expect(decision.verdict).toBe("escalate");
    expect(decision.reason).toContain("Matched the escalate rule");
    expect(inner.review).not.toHaveBeenCalled();
  });

  it.each([
    toolCall("bash", { command: "git status" }),
    toolCall("bash", { command: "npm publisher-check" }),
    toolCall("read", { filePath: "/workspace/README.md" }),
    toolCall("shell", { command: "rm-rf-is-not-a-flag" }),
  ])("passes other operations to the reviewer (%#)", async (request) => {
    const inner = permissiveReviewer();
    const reviewer = new EscalationRulesReviewer({ reviewer: inner, rules: highRisk });
    await expect(reviewer.review(request)).resolves.toEqual({
      verdict: "allow",
      reason: "looks fine",
    });
    expect(inner.review).toHaveBeenCalledWith(request);
  });

  it("matches actions with wildcards and treats a trailing ' *' as optional", async () => {
    const reviewer = new EscalationRulesReviewer({
      reviewer: permissiveReviewer(),
      rules: [
        { action: "mcp_*", resource: "delete?" },
        { action: "bash", resource: "git push *" },
      ],
    });
    const verdict = async (request: ReviewRequest) => (await reviewer.review(request)).verdict;
    expect(await verdict(toolCall("mcp_github", { op: "delete1" }))).toBe("escalate");
    expect(await verdict(toolCall("mcp_github", { op: "delete12" }))).toBe("allow");
    expect(await verdict(toolCall("bash", { command: "git push" }))).toBe("escalate");
    expect(await verdict(toolCall("bash", { command: "git pushy" }))).toBe("allow");
    expect(await verdict(toolCall("bash", { command: "a.b" }))).toBe("allow");
  });

  it("escalates an operation too deep to check", async () => {
    let resource: Record<string, unknown> = { command: "ls" };
    for (let depth = 0; depth < 20; depth++) resource = { nested: resource };
    const inner = permissiveReviewer();
    const reviewer = new EscalationRulesReviewer({
      reviewer: inner,
      rules: [{ action: "bash", resource: "*git push*" }],
    });
    const decision = await reviewer.review(toolCall("bash", resource));
    expect(decision).toEqual({
      verdict: "escalate",
      reason:
        "The operation is too large to check against the escalate rules; a human must review it.",
    });
    expect(inner.review).not.toHaveBeenCalled();
  });

  it("does not walk an operation whose action no rule names", async () => {
    let resource: Record<string, unknown> = { command: "ls" };
    for (let depth = 0; depth < 20; depth++) resource = { nested: resource };
    const reviewer = new EscalationRulesReviewer({
      reviewer: permissiveReviewer(),
      rules: [{ action: "bash", resource: "*git push*" }],
    });
    expect((await reviewer.review(toolCall("read", resource))).verdict).toBe("allow");
  });

  it("ignores case, line continuations and whitespace in values and patterns", async () => {
    const reviewer = new EscalationRulesReviewer({
      reviewer: permissiveReviewer(),
      rules: [
        { action: "Bash", resource: "*git  push*" },
        { action: "*", resource: "*evil.com*" },
      ],
    });
    const verdict = async (request: ReviewRequest) => (await reviewer.review(request)).verdict;
    expect(await verdict(toolCall("bash", { command: "GIT Push" }))).toBe("escalate");
    expect(await verdict(toolCall("bash", { command: "git \\\npush" }))).toBe("escalate");
    expect(await verdict(toolCall("webfetch", { url: "https://EVIL.com/x" }))).toBe("escalate");
  });

  it("matches a permission request's resources but not its metadata", async () => {
    const reviewer = new EscalationRulesReviewer({
      reviewer: permissiveReviewer(),
      rules: [{ action: "edit", resource: "*.env*" }],
    });
    expect((await reviewer.review(edit(["src/config.ts"]))).verdict).toBe("allow");
    expect((await reviewer.review(edit(["/workspace/.env"]))).verdict).toBe("escalate");
  });

  it("reports the first matching rule in configuration order", async () => {
    const reviewer = new EscalationRulesReviewer({
      reviewer: permissiveReviewer(),
      rules: [{ action: "bash", resource: "*push*" }, { action: "bash" }],
    });
    const decision = await reviewer.review(toolCall("bash", { command: "git push" }));
    expect(decision.reason).toContain('{"action":"bash","resource":"*push*"}');
  });

  it("escalates an operation with too many strings to check", async () => {
    const reviewer = new EscalationRulesReviewer({
      reviewer: permissiveReviewer(),
      rules: [{ action: "bash", resource: "*git push*" }],
    });
    const lines = Array.from({ length: 10_001 }, (_, index) => `echo ${index}`);
    expect((await reviewer.review(toolCall("bash", { lines }))).reason).toContain(
      "too large to check",
    );
  });

  it("matches long values in linear time", () => {
    const value = "git push ".repeat(200_000);
    const started = performance.now();
    expect(matchesWildcard({ value, pattern: "*git*push*force*" })).toBe(false);
    expect(matchesWildcard({ value: `${"a".repeat(1_000_000)}b`, pattern: "*a*a*a*c" })).toBe(
      false,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("asks the wrapped reviewer which sessions are its own", () => {
    const reviewer = new EscalationRulesReviewer({ reviewer: permissiveReviewer(), rules: [] });
    expect(reviewer.isReviewerSession({ sessionID: "review" })).toBe(true);
    expect(reviewer.isReviewerSession({ sessionID: "main" })).toBe(false);
  });
});
