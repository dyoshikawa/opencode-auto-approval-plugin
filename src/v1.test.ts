import { describe, expect, it, vi } from "vitest";

import { createV1Plugin, createV1SessionClient, reviewerAgentConfig } from "./v1.js";

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
  const plugin = createV1Plugin({
    createReviewer: () => ({ review, isReviewerSession }) as never,
  });
  return { plugin, review, isReviewerSession };
}

describe("V1 plugin (opencode 1.x)", () => {
  it("registers a reviewer agent that only exposes read-only tools", async () => {
    const { context } = createContext();
    const { plugin } = createPlugin({ verdict: "allow" });
    const hooks = await plugin(context as never, {});
    const config: { agent?: Record<string, unknown> } = {};

    await hooks.config?.(config as never);

    expect(config.agent?.["auto-approval-reviewer"]).toEqual(reviewerAgentConfig());
    expect(reviewerAgentConfig()).toMatchObject({
      mode: "subagent",
      tools: { read: true, glob: true, grep: true, lsp: true },
      permission: { "*": "deny", read: "allow", edit: "deny", bash: "deny" },
    });
  });

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

function sdkClient(input: { create: unknown; prompt: unknown }) {
  return {
    session: {
      create: vi.fn(async () => input.create),
      prompt: vi.fn(async () => input.prompt),
      abort: vi.fn(async () => undefined),
    },
  };
}

describe("V1 session client", () => {
  it("prompts the reviewer agent with read-only tools and unwraps the SDK reply", async () => {
    const sdk = sdkClient({
      create: { data: { id: "review-session" } },
      prompt: { data: { parts: [{ type: "text", text: '{"verdict":"allow"}' }] } },
    });
    const client = createV1SessionClient({ client: sdk, directory: "/workspace" });

    const created = await client.create({});
    const text = await client.prompt({
      sessionID: created.sessionID,
      model: { providerID: "openai", modelID: "gpt-5.6" },
      text: "review this",
    });

    expect(created).toEqual({ sessionID: "review-session" });
    expect(sdk.session.prompt).toHaveBeenCalledWith({
      path: { id: "review-session" },
      query: { directory: "/workspace" },
      body: {
        agent: "auto-approval-reviewer",
        model: { providerID: "openai", modelID: "gpt-5.6" },
        parts: [{ type: "text", text: "review this" }],
        tools: { read: true, glob: true, grep: true, lsp: true },
      },
    });
    expect(text).toBe('{"verdict":"allow"}');
  });

  it("fails when the SDK does not return a session ID or message parts", async () => {
    const client = createV1SessionClient({
      client: sdkClient({ create: {}, prompt: { data: {} } }),
      directory: "/workspace",
    });

    await expect(client.create({})).rejects.toThrow("did not return a reviewer session ID");
    await expect(client.prompt({ sessionID: "x", text: "" })).rejects.toThrow(
      "did not return reviewer message parts",
    );
  });

  it("aborts through the SDK when available", async () => {
    const sdk = sdkClient({ create: { id: "review-session" }, prompt: {} });
    const client = createV1SessionClient({ client: sdk, directory: "/workspace" });

    await client.abort({ sessionID: "review-session" });

    expect(sdk.session.abort).toHaveBeenCalledWith({
      path: { id: "review-session" },
      query: { directory: "/workspace" },
    });
  });
});
