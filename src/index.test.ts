import { describe, expect, it, vi } from "vitest";

import { createAutoApprovalPlugin } from "./index.js";
type ReviewerVerdict = "allow" | "deny" | "escalate";

function createContext() {
  const reply = vi.fn(async () => true);
  return {
    context: {
      client: {
        postSessionIdPermissionsPermissionId: reply,
      },
      directory: "/workspace",
    },
    reply,
  };
}

function createPlugin(input: { verdict: ReviewerVerdict }) {
  const review = vi.fn(async () => ({ verdict: input.verdict, reason: "reviewed" }));
  const isReviewerSession = vi.fn(() => false);
  const plugin = createAutoApprovalPlugin({
    dependencies: {
      createReviewer: () => ({ review, isReviewerSession }) as never,
    },
  });
  return { plugin, review, isReviewerSession };
}

describe("auto approval plugin", () => {
  it("auto-approves an ask request only when the reviewer allows it", async () => {
    const { context, reply } = createContext();
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});

    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "bash",
          title: "Run bash",
          metadata: {},
          time: { created: 0 },
        },
      },
    });

    expect(review).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      path: { id: "session-1", permissionID: "permission-1" },
      query: { directory: "/workspace" },
      body: { response: "once" },
    });
  });

  it("leaves an ask request for a human when the reviewer escalates", async () => {
    const { context, reply } = createContext();
    const { plugin } = createPlugin({ verdict: "escalate" });
    const hooks = await plugin(context as never, {});

    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "bash",
          title: "Run bash",
          metadata: {},
          time: { created: 0 },
        },
      },
    });

    expect(reply).not.toHaveBeenCalled();
  });

  it("auto-approves a permission.asked event (opencode >= 1.18 event name)", async () => {
    const { context, reply } = createContext();
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});

    await hooks.event?.({
      event: {
        // Not yet in the pinned @opencode-ai/plugin event union, but emitted
        // by opencode >= 1.18 at runtime.
        type: "permission.asked" as unknown as "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "bash",
          title: "Run bash",
          metadata: {},
          time: { created: 0 },
        },
      },
    });

    expect(review).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      path: { id: "session-1", permissionID: "permission-1" },
      query: { directory: "/workspace" },
      body: { response: "once" },
    });
  });

  it("ignores unrelated bus events", async () => {
    const { context, reply } = createContext();
    const { plugin, review } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});

    await hooks.event?.({
      event: {
        type: "permission.replied",
        properties: {
          sessionID: "session-1",
          permissionID: "permission-1",
          response: "once",
        },
      },
    });

    expect(review).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("blocks an allow-listed tool when all-tools review escalates", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "escalate" });
    const hooks = await plugin(context as never, { mode: "all-tools" });

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "session-1", callID: "call-1" },
        { args: { command: "git push" } },
      ),
    ).rejects.toThrow("requires human review");
  });

  it("permits an allow-listed tool when all-tools review allows it", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, { mode: "all-tools" });

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "read", sessionID: "session-1", callID: "call-1" },
        { args: { filePath: "README.md" } },
      ),
    ).resolves.toBeUndefined();
  });
});
