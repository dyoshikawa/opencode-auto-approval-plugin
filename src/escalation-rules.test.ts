import { describe, expect, it, vi } from "vitest";

import { type EscalationRule, EscalationRulesReviewer } from "./escalation-rules.js";
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

  it("asks the wrapped reviewer which sessions are its own", () => {
    const reviewer = new EscalationRulesReviewer({ reviewer: permissiveReviewer(), rules: [] });
    expect(reviewer.isReviewerSession({ sessionID: "review" })).toBe(true);
    expect(reviewer.isReviewerSession({ sessionID: "main" })).toBe(false);
  });
});
